// Probe what the configured *roles* may do, by running short-lived code as them.
// Run with: node infra/role-probe.js
//
// Creates, then deletes:
//   - Lambda function <prefix>-probe (the Lambda role), invoked outside
//     and then inside the VPC's private subnets
//   - task definition <prefix>-probe, run once on Fargate in a private
//     subnet (the task role), using the public aws-cli image
// Keeps the ECS cluster <prefix> (created if missing), which the runners need anyway.
//
// Every permission check targets a resource that does not exist ("...-probe-none"):
// AccessDenied means the role lacks the permission, a not-found error means the
// call was authorised. The only real write is one CloudWatch metric data point.

import { CreateClusterCommand, DeleteTaskDefinitionsCommand, DeregisterTaskDefinitionCommand, DescribeClustersCommand, DescribeTasksCommand, ECSClient, RegisterTaskDefinitionCommand, RunTaskCommand, waitUntilTasksStopped } from "@aws-sdk/client-ecs";
import { CreateFunctionCommand, DeleteFunctionCommand, GetFunctionCommand, InvokeCommand, LambdaClient, UpdateFunctionConfigurationCommand, waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2 } from "@aws-sdk/client-lambda";
import { strToU8, zipSync } from "fflate";

import { config, name, roleArn, tagList, tagMap } from "./config.js";
import { discoverNetwork } from "./network.js";

const region = config.region;
const PROBE = name("probe");
const NONE = name("probe-none");
const CLUSTER = name("cluster");
const acct = config.accountId;

// ---------------------------------------------------------------- Lambda probe

const LAMBDA_CODE = `
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ECSClient, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const NONE = ${JSON.stringify(NONE)};
const ACCT = ${JSON.stringify(acct)};
const region = process.env.AWS_REGION;
const DENIED = /AccessDenied|not authorized|UnauthorizedOperation/i;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(Object.assign(new Error("timed out after " + ms + "ms"), { name: "Timeout" })), ms))]);

async function check(fn) {
  const t = Date.now();
  try {
    await withTimeout(fn(), 8000);
    return { result: "ALLOWED", ms: Date.now() - t };
  } catch (e) {
    const s = (e.name || "") + " " + (e.message || "");
    if (DENIED.test(s)) return { result: "DENIED", detail: e.name, ms: Date.now() - t };
    if (e.name === "Timeout") return { result: "UNREACHABLE", detail: e.message, ms: Date.now() - t };
    return { result: "ALLOWED", detail: e.name, ms: Date.now() - t };
  }
}

export const handler = async () => {
  const checks = {
    "sqs:SendMessage": () => new SQSClient({ region }).send(new SendMessageCommand({
      QueueUrl: "https://sqs." + region + ".amazonaws.com/" + ACCT + "/" + NONE, MessageBody: "probe" })),
    "dynamodb:PutItem": () => new DynamoDBClient({ region }).send(new PutItemCommand({
      TableName: NONE, Item: { pk: { S: "probe" } } })),
    "dynamodb:UpdateItem": () => new DynamoDBClient({ region }).send(new UpdateItemCommand({
      TableName: NONE, Key: { pk: { S: "probe" } }, UpdateExpression: "ADD s :v",
      ExpressionAttributeValues: { ":v": { SS: ["x"] } } })),
    "events:PutEvents": async () => {
      const r = await new EventBridgeClient({ region }).send(new PutEventsCommand({ Entries: [{
        EventBusName: NONE, Source: "proofline.probe", DetailType: "Probe", Detail: "{}" }] }));
      const code = r.Entries?.[0]?.ErrorCode;
      if (code) throw Object.assign(new Error(r.Entries[0].ErrorMessage || code), { name: code });
    },
    "cloudwatch:PutMetricData": () => new CloudWatchClient({ region }).send(new PutMetricDataCommand({
      Namespace: "Proofline/Probe", MetricData: [{ MetricName: "LambdaProbe", Value: 1, Unit: "Count" }] })),
    "s3:PutObject": () => new S3Client({ region }).send(new PutObjectCommand({
      Bucket: NONE, Key: "probe.txt", Body: "probe" })),
    "ecs:DescribeServices": () => new ECSClient({ region }).send(new DescribeServicesCommand({
      cluster: ${JSON.stringify(CLUSTER)}, services: ["none"] })),
    "secretsmanager:GetSecretValue": () => new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: NONE })),
    "ssm:GetParameter": () => new SSMClient({ region }).send(new GetParameterCommand({ Name: "/" + NONE })),
    "internet egress": async () => {
      const r = await fetch("https://checkip.amazonaws.com");
      if (!r.ok) throw new Error("HTTP " + r.status);
    },
  };
  const results = {};
  for (const [k, fn] of Object.entries(checks)) results[k] = await check(fn);
  return results;
};
`;

async function lambdaProbe(net) {
  const lambda = new LambdaClient({ region });
  const invoke = async () => {
    const r = await lambda.send(new InvokeCommand({ FunctionName: PROBE }));
    const body = JSON.parse(Buffer.from(r.Payload).toString());
    if (r.FunctionError) throw new Error(`function error: ${JSON.stringify(body)}`);
    return body;
  };

  // No existence check first: the account's deny policy refuses GetFunction on a
  // function that doesn't exist yet (it has no tags to match), so create first.
  console.log(`  creating ${PROBE} with ${config.roles.lambda} (tags on create)`);
  try {
    await lambda.send(new CreateFunctionCommand({
      FunctionName: PROBE,
      Runtime: "nodejs22.x",
      Role: roleArn("lambda"),
      Handler: "index.handler",
      Code: { ZipFile: zipSync({ "index.mjs": strToU8(LAMBDA_CODE) }) },
      Timeout: 120,
      MemorySize: 256,
      Tags: tagMap(),
    }));
  } catch (err) {
    if (err.name !== "ResourceConflictException") throw err;
    console.log("  (function left over from a previous run; reusing it)");
  }
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: PROBE });

  const results = { outside: await invoke() };

  console.log(`  attaching to the private subnets with ${config.network.securityGroupName}`);
  try {
    await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: PROBE,
      VpcConfig: { SubnetIds: net.privateSubnetIds, SecurityGroupIds: [net.securityGroupId] },
    }));
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 300 }, { FunctionName: PROBE });
    const fn = await lambda.send(new GetFunctionCommand({ FunctionName: PROBE }));
    if (fn.Configuration.LastUpdateStatus !== "Successful") {
      throw new Error(`${fn.Configuration.LastUpdateStatus}: ${fn.Configuration.LastUpdateStatusReason}`);
    }
    results.vpcAttach = "ALLOWED";
    results.inside = await invoke();
  } catch (err) {
    results.vpcAttach = `FAILED: ${err.name}: ${err.message.split("\n")[0]}`;
  }
  return results;
}

async function cleanupLambda() {
  try {
    await new LambdaClient({ region }).send(new DeleteFunctionCommand({ FunctionName: PROBE }));
    console.log(`  deleted ${PROBE}`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") console.log(`  could not delete ${PROBE}: ${err.message}`);
  }
}

// ------------------------------------------------------------- Fargate probe

// Each check that is DENIED sets one bit of the exit code (the task cannot log).
const TASK_CHECKS = [
  ["sqs:SendMessage", `aws sqs send-message --queue-url https://sqs.${region}.amazonaws.com/${acct}/${NONE} --message-body probe`],
  ["dynamodb:PutItem", `aws dynamodb put-item --table-name ${NONE} --item '{"pk":{"S":"probe"}}'`],
  ["events:PutEvents", `aws events put-events --entries '[{"EventBusName":"${NONE}","Source":"proofline.probe","DetailType":"Probe","Detail":"{}"}]'`],
  ["cloudwatch:PutMetricData", "aws cloudwatch put-metric-data --namespace Proofline/Probe --metric-name TaskProbe --value 1"],
  ["s3:PutObject", `aws s3api put-object --bucket ${NONE} --key probe.txt`],
  ["secretsmanager:GetSecretValue", `aws secretsmanager get-secret-value --secret-id ${NONE}`],
  ["ecs:DescribeServices", `aws ecs describe-services --cluster ${CLUSTER} --services none`],
];
const TASK_SCRIPT = [
  "r=0",
  ...TASK_CHECKS.map(([, cmd], i) =>
    `out=$(${cmd} 2>&1); echo "$out" | grep -qiE 'AccessDenied|not authorized|UnauthorizedOperation' && r=$((r | ${1 << i}))`),
  // Bit 7: no internet egress through the NAT.
  `curl -s -m 8 -o /dev/null https://checkip.amazonaws.com || r=$((r | ${1 << 7}))`,
  "exit $r",
].join("\n");

async function ensureCluster(ecs) {
  const { clusters } = await ecs.send(new DescribeClustersCommand({ clusters: [CLUSTER] }));
  if (clusters?.[0]?.status === "ACTIVE") return;
  console.log(`  creating cluster ${CLUSTER}`);
  await ecs.send(new CreateClusterCommand({ clusterName: CLUSTER, tags: tagList("key", "value") }));
}

async function fargateProbe(net) {
  const ecs = new ECSClient({ region });
  await ensureCluster(ecs);

  console.log(`  registering task definition ${PROBE} (tags inline)`);
  const { taskDefinition } = await ecs.send(new RegisterTaskDefinitionCommand({
    family: PROBE,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "256",
    memory: "512",
    taskRoleArn: roleArn("task"),
    executionRoleArn: roleArn("execution"),
    containerDefinitions: [{
      name: "probe",
      image: "public.ecr.aws/aws-cli/aws-cli:latest",
      essential: true,
      entryPoint: ["sh", "-c"],
      command: [TASK_SCRIPT],
      environment: [{ name: "AWS_DEFAULT_REGION", value: region }],
      // No logConfiguration: tasks that try to log die at startup in this account.
    }],
    tags: tagList("key", "value"),
  }));

  try {
    console.log("  running one task in a private subnet (no public IP); this takes 1-3 minutes");
    const run = await ecs.send(new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: taskDefinition.taskDefinitionArn,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: { awsvpcConfiguration: {
        subnets: net.privateSubnetIds, securityGroups: [net.securityGroupId], assignPublicIp: "DISABLED",
      } },
      propagateTags: "TASK_DEFINITION",
      tags: tagList("key", "value"),
    }));
    if (run.failures?.length) throw new Error(`RunTask failures: ${JSON.stringify(run.failures)}`);
    const taskArn = run.tasks[0].taskArn;
    await waitUntilTasksStopped({ client: ecs, maxWaitTime: 600 }, { cluster: CLUSTER, tasks: [taskArn] });
    const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }));
    const task = tasks[0];
    const exitCode = task.containers[0].exitCode;
    if (exitCode === undefined || exitCode === null) {
      return { error: `task did not run: ${task.stoppedReason} / ${task.containers[0].reason ?? ""}` };
    }
    const results = Object.fromEntries(TASK_CHECKS.map(([label], i) =>
      [label, exitCode & (1 << i) ? "DENIED" : "ALLOWED"]));
    results["internet egress"] = exitCode & (1 << 7) ? "UNREACHABLE" : "ALLOWED";
    results.exitCode = exitCode;
    return results;
  } finally {
    await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinition.taskDefinitionArn }));
    try {
      await ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: [taskDefinition.taskDefinitionArn] }));
    } catch { /* deregistered is enough */ }
    console.log(`  deregistered task definition ${PROBE}`);
  }
}

// ------------------------------------------------------------------- report

function print(title, results) {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(results)) {
    const text = typeof v === "string" || typeof v === "number" ? v : `${v.result}${v.detail ? ` (${v.detail})` : ""} ${v.ms}ms`;
    console.log(`  ${k.padEnd(32)} ${text}`);
  }
}

// --only=lambda or --only=fargate runs one half.
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const net = await discoverNetwork();
console.log(`Role probe: ${config.prefix}; private subnets ${net.privateSubnetIds.join(", ")}; ${net.securityGroupId}\n`);

if (only !== "fargate") {
  console.log("Lambda probe");
  let lambdaResults;
  try {
    lambdaResults = await lambdaProbe(net);
  } catch (err) {
    lambdaResults = { error: `${err.name}: ${err.message}` };
  } finally {
    await cleanupLambda();
  }
  if (lambdaResults.outside) print(`${config.roles.lambda}, outside VPC`, lambdaResults.outside);
  if (lambdaResults.vpcAttach) console.log(`\nLambda VPC attachment: ${lambdaResults.vpcAttach}`);
  if (lambdaResults.inside) print(`${config.roles.lambda}, inside private subnets`, lambdaResults.inside);
  if (lambdaResults.error) console.log(`\nLambda probe error: ${lambdaResults.error}`);
}

if (only !== "lambda") {
  console.log("\nFargate probe");
  let taskResults;
  try {
    taskResults = await fargateProbe(net);
  } catch (err) {
    taskResults = { error: `${err.name}: ${err.message}` };
  }
  print(`${config.roles.task} on Fargate, private subnet`, taskResults);
}
