// Read-only check that every Proofline resource carries the configured tags.
// Run with: node infra/audit-tags.js

import { DescribeTableCommand, DynamoDBClient, ListTagsOfResourceCommand } from "@aws-sdk/client-dynamodb";
import {
  ApplicationAutoScalingClient, DescribeScalableTargetsCommand, ListTagsForResourceCommand as ListScalingTags,
} from "@aws-sdk/client-application-auto-scaling";
import { CloudWatchClient, ListTagsForResourceCommand as ListAlarmTags } from "@aws-sdk/client-cloudwatch";
import { DescribeClustersCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient } from "@aws-sdk/client-ecs";
import { DescribeEventBusCommand, EventBridgeClient, ListTagsForResourceCommand as ListBusTags } from "@aws-sdk/client-eventbridge";
import { ListTagsForResourceCommand as ListBucketTags, S3ControlClient } from "@aws-sdk/client-s3-control";
import { ListQueueTagsCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ListTagsForResourceCommand as ListParamTags, SSMClient } from "@aws-sdk/client-ssm";

import { CloudWatchLogsClient, ListTagsForResourceCommand as ListLogTags } from "@aws-sdk/client-cloudwatch-logs";
import { ECRClient, ListTagsForResourceCommand as ListRepoTags } from "@aws-sdk/client-ecr";
import { LambdaClient, ListEventSourceMappingsCommand, ListTagsCommand as ListLambdaTags } from "@aws-sdk/client-lambda";

import { config, name } from "./config.js";
import { DATA, queueUrl } from "./phases/data.js";
import { REGISTRY } from "./phases/registry.js";
import { RUNNER } from "./phases/runner.js";
import { FUNCTIONS, RULES, SCHEDULES } from "./phases/control.js";
import { CACHE, describeCache } from "./phases/cache.js";
import { ElastiCacheClient, ListTagsForResourceCommand as ListCacheTags } from "@aws-sdk/client-elasticache";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const { region, accountId } = config;
const toMap = (list, k = "Key", v = "Value") => Object.fromEntries((list ?? []).map((t) => [t[k], t[v]]));

const RESOURCES = [
  [`DynamoDB table ${DATA.table}`, async () => {
    const db = new DynamoDBClient({ region });
    const { Table } = await db.send(new DescribeTableCommand({ TableName: DATA.table }));
    return toMap((await db.send(new ListTagsOfResourceCommand({ ResourceArn: Table.TableArn }))).Tags);
  }],
  [`S3 bucket ${DATA.bucket}`, async () => toMap((await new S3ControlClient({ region }).send(new ListBucketTags({
    AccountId: accountId, ResourceArn: `arn:aws:s3:::${DATA.bucket}`,
  }))).Tags)],
  ...[DATA.queue, DATA.dlq].map((q) => [`SQS queue ${q}`, async () =>
    (await new SQSClient({ region }).send(new ListQueueTagsCommand({ QueueUrl: queueUrl(q) }))).Tags ?? {}]),
  [`EventBridge bus ${DATA.bus}`, async () => {
    const eb = new EventBridgeClient({ region });
    const { Arn } = await eb.send(new DescribeEventBusCommand({ Name: DATA.bus }));
    return toMap((await eb.send(new ListBusTags({ ResourceARN: Arn }))).Tags);
  }],
  ...["table", "bucket", "work-queue-url", "dlq-url", "event-bus"].map((k) => [`parameter ${DATA.paramPrefix}/${k}`,
    async () => toMap((await new SSMClient({ region }).send(new ListParamTags({
      ResourceType: "Parameter", ResourceId: `${DATA.paramPrefix}/${k}`,
    }))).TagList)]),
  [`ECR repository ${REGISTRY.repository}`, async () => toMap((await new ECRClient({ region }).send(new ListRepoTags({
    resourceArn: `arn:aws:ecr:${region}:${accountId}:repository/${REGISTRY.repository}`,
  }))).tags)],
  [`parameter ${REGISTRY.legacyImageParam} (unused)`, async () => toMap((await new SSMClient({ region }).send(new ListParamTags({
    ResourceType: "Parameter", ResourceId: REGISTRY.legacyImageParam,
  }))).TagList)],
  [`ECS service ${RUNNER.service}`, async () => {
    const { services } = await new ECSClient({ region }).send(new DescribeServicesCommand({
      cluster: RUNNER.cluster, services: [RUNNER.service], include: ["TAGS"],
    }));
    if (services?.[0]?.status !== "ACTIVE") throw Object.assign(new Error("not found"), { name: "NotFound" });
    return toMap(services[0].tags, "key", "value");
  }],
  [`task definition ${RUNNER.family} (latest)`, async () =>
    toMap((await new ECSClient({ region }).send(new DescribeTaskDefinitionCommand({
      taskDefinition: RUNNER.family, include: ["TAGS"],
    }))).tags, "key", "value")],
  [`scalable target ${RUNNER.service}`, async () => {
    const aas = new ApplicationAutoScalingClient({ region });
    const { ScalableTargets } = await aas.send(new DescribeScalableTargetsCommand({
      ServiceNamespace: "ecs", ResourceIds: [`service/${RUNNER.cluster}/${RUNNER.service}`],
    }));
    if (!ScalableTargets?.length) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return (await aas.send(new ListScalingTags({ ResourceARN: ScalableTargets[0].ScalableTargetARN }))).Tags ?? {};
  }],
  ...[RUNNER.scaleOutAlarm, RUNNER.scaleInAlarm].map((alarm) => [`CloudWatch alarm ${alarm}`, async () =>
    toMap((await new CloudWatchClient({ region }).send(new ListAlarmTags({
      ResourceARN: `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarm}`,
    }))).Tags)]),
  ...Object.values(FUNCTIONS).flatMap((fn) => [
    [`Lambda ${fn.name}`, async () => (await new LambdaClient({ region }).send(new ListLambdaTags({
      Resource: `arn:aws:lambda:${region}:${accountId}:function:${fn.name}`,
    }))).Tags ?? {}],
    [`log group /aws/lambda/${fn.name}`, async () => (await new CloudWatchLogsClient({ region }).send(new ListLogTags({
      resourceArn: `arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${fn.name}`,
    }))).tags ?? {}],
  ]),
  ...RULES.map((rule) => [`EventBridge rule ${rule.name}`, async () =>
    toMap((await new EventBridgeClient({ region }).send(new ListBusTags({
      ResourceARN: `arn:aws:events:${region}:${accountId}:rule/${DATA.bus}/${rule.name}`,
    }))).Tags)]),
  ...SCHEDULES.map((s) => [`EventBridge schedule rule ${s.name}`, async () =>
    toMap((await new EventBridgeClient({ region }).send(new ListBusTags({
      ResourceARN: `arn:aws:events:${region}:${accountId}:rule/${s.name}`,
    }))).Tags)]),
  [`event source mapping ${DATA.dlq} -> ${FUNCTIONS.dlq.name}`, async () => {
    const client = new LambdaClient({ region });
    const { EventSourceMappings = [] } = await client.send(new ListEventSourceMappingsCommand({ FunctionName: FUNCTIONS.dlq.name }));
    if (!EventSourceMappings.length) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return (await client.send(new ListLambdaTags({ Resource: EventSourceMappings[0].EventSourceMappingArn }))).Tags ?? {};
  }],
  [`Valkey replication group ${CACHE.id}`, async () => {
    const c = await describeCache();
    if (!c) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return toMap((await new ElastiCacheClient({ region }).send(new ListCacheTags({ ResourceName: c.arn }))).TagList);
  }],
  [`secret ${CACHE.secret}`, async () =>
    toMap((await new SecretsManagerClient({ region }).send(new DescribeSecretCommand({ SecretId: CACHE.secret }))).Tags)],
  [`ECS cluster ${name("cluster")}`, async () => {
    const { clusters } = await new ECSClient({ region }).send(new DescribeClustersCommand({
      clusters: [name("cluster")], include: ["TAGS"],
    }));
    if (!clusters?.length) throw Object.assign(new Error("not found"), { name: "NotFound" });
    return toMap(clusters[0].tags, "key", "value");
  }],
];

let problems = 0;
console.log(`Tag audit: every resource needs ${Object.entries(config.tags).map(([k, v]) => `${k}=${v}`).join(" and ")}\n`);
for (const [label, read] of RESOURCES) {
  try {
    const tags = await read();
    const missing = Object.entries(config.tags).filter(([k, v]) => tags[k] !== v)
      .map(([k, v]) => `${k} (want "${v}", have ${tags[k] === undefined ? "none" : `"${tags[k]}"`})`);
    if (missing.length) problems++;
    console.log(`  ${missing.length ? "MISSING" : "OK     "}  ${label}${missing.length ? `  ${missing.join("; ")}` : ""}`);
  } catch (err) {
    console.log(`  ABSENT   ${label}  ${err.name}`);
  }
}
console.log(problems ? `\n${problems} resource(s) with missing or wrong tags` : "\nall present resources correctly tagged");
