// Phase 4: control plane. All Lambdas run
// outside the VPC (the Lambda role can't create network interfaces).
//
//   api         HTTP API routes under the API prefix (default /v1), Cognito JWT auth
//   planner     EventBridge: BaselineCompleted with passed=true
//   aggregator  EventBridge: JobCompleted
//   dlq-handler SQS event source on the work DLQ (closes out jobs whose shards died)
//
// Log groups are created first, with tags and 14-day retention; otherwise
// Lambda creates them untagged and keeps logs forever.

import {
  ApiGatewayV2Client, CreateDeploymentCommand, CreateIntegrationCommand, CreateRouteCommand, DeleteIntegrationCommand,
  DeleteRouteCommand, GetAuthorizersCommand, GetIntegrationsCommand, GetRoutesCommand, GetStagesCommand,
  UpdateIntegrationCommand, UpdateRouteCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  DeleteRuleCommand, EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  AddPermissionCommand, CreateEventSourceMappingCommand, CreateFunctionCommand, DeleteEventSourceMappingCommand,
  DeleteFunctionCommand, LambdaClient, ListEventSourceMappingsCommand, UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand, waitUntilFunctionActiveV2, waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, name, roleArn, tagList, tagMap } from "../config.js";
import { bundleHandler } from "../lib/bundle.js";
import { isError, log } from "../lib/log.js";
import { DATA, queueUrl } from "./data.js";

const { region, accountId } = config;
const HANDLERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../services/src/handlers");
const LOG_RETENTION_DAYS = 14;

export const FUNCTIONS = {
  api: { name: name("api"), entry: "api.js", memory: 512, timeout: 15,
    description: "Proofline HTTP API: create, start and read verification jobs" },
  planner: { name: name("planner"), entry: "planner.js", memory: 1024, timeout: 120,
    description: "Proofline planner: mutants, cache lookups and shards after a passing baseline" },
  aggregator: { name: name("aggregator"), entry: "aggregator.js", memory: 256, timeout: 60,
    description: "Proofline aggregator: builds the report when every shard has finished" },
  dlq: { name: name("dlq-handler"), entry: "dlq.js", memory: 256, timeout: 30,
    description: "Proofline: closes out jobs whose shards exhausted their retries" },
  backlog: { name: name("backlog-publisher"), entry: "backlog.js", memory: 128, timeout: 15,
    description: "Proofline: publishes live work-queue depth every minute for the scaling alarms" },
};

// Scheduled rules live on the default bus. A rule (unlike an EventBridge
// Scheduler schedule) can carry the required tags.
export const SCHEDULES = [
  { name: name("every-minute-backlog"), fn: "backlog", expression: "rate(1 minute)" },
];

export const RULES = [
  { name: name("on-baseline-passed"), fn: "planner",
    pattern: { source: ["proofline.runner"], "detail-type": ["BaselineCompleted"], detail: { passed: [true] } } },
  { name: name("on-job-completed"), fn: "aggregator", pattern: { "detail-type": ["JobCompleted"] } },
];

const P = config.apiPrefix;
export const ROUTES = [`POST ${P}/jobs`, `POST ${P}/jobs/{jobId}/start`, `GET ${P}/jobs/{jobId}`];

const fnArn = (fnName) => `arn:aws:lambda:${region}:${accountId}:function:${fnName}`;
const logGroup = (fnName) => `/aws/lambda/${fnName}`;
const lambda = () => new LambdaClient({ region });

const ENV = {
  PROOFLINE_TABLE: DATA.table,
  PROOFLINE_BUCKET: DATA.bucket,
  PROOFLINE_WORK_QUEUE_URL: queueUrl(DATA.queue),
  PROOFLINE_EVENT_BUS: DATA.bus,
  PROOFLINE_API_PREFIX: config.apiPrefix,
  // Cognito group whose members may read any job (phase 6 creates it).
  PROOFLINE_ADMIN_GROUP: name("admins"),
};

async function ensureLogGroup(fnName) {
  const logs = new CloudWatchLogsClient({ region });
  try {
    await logs.send(new CreateLogGroupCommand({ logGroupName: logGroup(fnName), tags: tagMap() }));
  } catch (err) {
    if (!isError(err, "ResourceAlreadyExistsException")) throw err;
  }
  try {
    await logs.send(new PutRetentionPolicyCommand({ logGroupName: logGroup(fnName), retentionInDays: LOG_RETENTION_DAYS }));
  } catch (err) {
    // Denied in this account (Do-Not-Delete-LT1-DenyPolicy-3). Pre-creating the
    // group still matters: it's how the group gets its tags.
    if (!isError(err, "AccessDeniedException")) throw err;
    if (!retentionWarned) log("WARNING", `  log retention not settable (denied); ${logGroup(fnName)} keeps logs indefinitely`);
    retentionWarned = true;
  }
}
let retentionWarned = false;

async function deployFunction(def) {
  const client = lambda();
  await ensureLogGroup(def.name);
  const { zip, bytes } = await bundleHandler(path.join(HANDLERS, def.entry));
  const settings = {
    FunctionName: def.name, Runtime: "nodejs22.x", Role: roleArn("lambda"), Handler: "index.handler",
    MemorySize: def.memory, Timeout: def.timeout, Description: def.description, Environment: { Variables: ENV },
  };
  try {
    // Create first, with tags: the account denies lookups on untagged functions.
    await client.send(new CreateFunctionCommand({ ...settings, Code: { ZipFile: zip }, Architectures: ["x86_64"], Tags: tagMap() }));
    await waitUntilFunctionActiveV2({ client, maxWaitTime: 120 }, { FunctionName: def.name });
    log("created", `Lambda ${def.name}`, `${(bytes / 1024).toFixed(0)} KiB bundle, ${def.memory} MB, ${def.timeout}s`);
  } catch (err) {
    if (!isError(err, "ResourceConflictException")) throw err;
    await client.send(new UpdateFunctionCodeCommand({ FunctionName: def.name, ZipFile: zip }));
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: def.name });
    await client.send(new UpdateFunctionConfigurationCommand(settings));
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: def.name });
    log("updated", `Lambda ${def.name}`, `${(bytes / 1024).toFixed(0)} KiB bundle`);
  }
  return fnArn(def.name);
}

async function allowInvoke(fnName, statementId, principal, sourceArn) {
  try {
    await lambda().send(new AddPermissionCommand({
      FunctionName: fnName, StatementId: statementId, Action: "lambda:InvokeFunction", Principal: principal, SourceArn: sourceArn,
    }));
  } catch (err) {
    if (!isError(err, "ResourceConflictException")) throw err; // already granted
  }
}

async function rules() {
  const eb = new EventBridgeClient({ region });
  for (const rule of RULES) {
    const params = {
      Name: rule.name, EventBusName: DATA.bus, EventPattern: JSON.stringify(rule.pattern), State: "ENABLED",
      Description: `Proofline: route to ${FUNCTIONS[rule.fn].name}`,
    };
    let RuleArn;
    try {
      ({ RuleArn } = await eb.send(new PutRuleCommand({ ...params, Tags: tagList() })));
    } catch (err) {
      // Updating an existing rule: tags were set when it was created.
      if (!isError(err, "ValidationException", "AccessDeniedException")) throw err;
      ({ RuleArn } = await eb.send(new PutRuleCommand(params)));
    }
    const { FailedEntryCount, FailedEntries } = await eb.send(new PutTargetsCommand({
      Rule: rule.name, EventBusName: DATA.bus,
      Targets: [{ Id: "lambda", Arn: fnArn(FUNCTIONS[rule.fn].name),
        RetryPolicy: { MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 3600 } }],
    }));
    if (FailedEntryCount) throw new Error(`PutTargets ${rule.name}: ${JSON.stringify(FailedEntries)}`);
    await allowInvoke(FUNCTIONS[rule.fn].name, `events-${rule.name}`, "events.amazonaws.com", RuleArn);
    log("ok", `rule ${rule.name}`, `-> ${FUNCTIONS[rule.fn].name}`);
  }
}

async function schedules() {
  const eb = new EventBridgeClient({ region });
  for (const s of SCHEDULES) {
    const params = { Name: s.name, ScheduleExpression: s.expression, State: "ENABLED",
      Description: `Proofline: invoke ${FUNCTIONS[s.fn].name} ${s.expression}` };
    let RuleArn;
    try {
      ({ RuleArn } = await eb.send(new PutRuleCommand({ ...params, Tags: tagList() })));
    } catch (err) {
      if (!isError(err, "ValidationException", "AccessDeniedException")) throw err;
      ({ RuleArn } = await eb.send(new PutRuleCommand(params)));
    }
    const { FailedEntryCount, FailedEntries } = await eb.send(new PutTargetsCommand({
      Rule: s.name, Targets: [{ Id: "lambda", Arn: fnArn(FUNCTIONS[s.fn].name) }],
    }));
    if (FailedEntryCount) throw new Error(`PutTargets ${s.name}: ${JSON.stringify(FailedEntries)}`);
    await allowInvoke(FUNCTIONS[s.fn].name, `events-${s.name}`, "events.amazonaws.com", RuleArn);
    log("ok", `schedule ${s.name}`, `${s.expression} -> ${FUNCTIONS[s.fn].name}`);
  }
}

async function dlqSource() {
  const client = lambda();
  const dlqArn = `arn:aws:sqs:${region}:${accountId}:${DATA.dlq}`;
  const { EventSourceMappings } = await client.send(new ListEventSourceMappingsCommand({
    EventSourceArn: dlqArn, FunctionName: FUNCTIONS.dlq.name,
  }));
  if (EventSourceMappings?.length) {
    log("exists", `event source ${DATA.dlq} -> ${FUNCTIONS.dlq.name}`);
    return;
  }
  await client.send(new CreateEventSourceMappingCommand({
    EventSourceArn: dlqArn, FunctionName: FUNCTIONS.dlq.name, BatchSize: 1, Enabled: true, Tags: tagMap(),
  }));
  log("created", `event source ${DATA.dlq} -> ${FUNCTIONS.dlq.name}`, "batch size 1");
}

async function routes() {
  const api = new ApiGatewayV2Client({ region });
  const ApiId = config.apiId;
  const { Items: authorizers } = await api.send(new GetAuthorizersCommand({ ApiId }));
  const jwt = authorizers.find((a) => a.AuthorizerType === "JWT");
  if (!jwt) throw new Error(`no JWT authorizer on API ${ApiId}`);

  const uri = fnArn(FUNCTIONS.api.name);
  const { Items: integrations } = await api.send(new GetIntegrationsCommand({ ApiId, MaxResults: "500" }));
  let integrationId = integrations.find((i) => i.IntegrationUri === uri)?.IntegrationId;
  const integration = { IntegrationType: "AWS_PROXY", IntegrationUri: uri, PayloadFormatVersion: "2.0", TimeoutInMillis: 15000 };
  if (integrationId) {
    await api.send(new UpdateIntegrationCommand({ ApiId, IntegrationId: integrationId, ...integration }));
  } else {
    ({ IntegrationId: integrationId } = await api.send(new CreateIntegrationCommand({
      ApiId, ...integration, Description: "Proofline API Lambda",
    })));
  }

  const { Items: existing } = await api.send(new GetRoutesCommand({ ApiId, MaxResults: "500" }));
  for (const RouteKey of ROUTES) {
    const route = { Target: `integrations/${integrationId}`, AuthorizationType: "JWT", AuthorizerId: jwt.AuthorizerId };
    const found = existing.find((r) => r.RouteKey === RouteKey);
    if (found) await api.send(new UpdateRouteCommand({ ApiId, RouteId: found.RouteId, ...route }));
    else await api.send(new CreateRouteCommand({ ApiId, RouteKey, ...route }));
  }
  await allowInvoke(FUNCTIONS.api.name, "apigateway-proofline", "apigateway.amazonaws.com",
    `arn:aws:execute-api:${region}:${accountId}:${ApiId}/*/*${config.apiPrefix}/*`);

  const { Items: stages } = await api.send(new GetStagesCommand({ ApiId }));
  const stage = stages.find((s) => s.StageName === "$default") ?? stages[0];
  if (!stage?.AutoDeploy) {
    await api.send(new CreateDeploymentCommand({ ApiId, StageName: stage.StageName, Description: `Proofline ${config.apiPrefix} routes` }));
  }
  log("ok", `routes ${ROUTES.join(", ")}`, `JWT authorizer ${jwt.Name}, stage ${stage.StageName}${stage.AutoDeploy ? " (auto-deploy)" : " (deployed)"}`);
  return `https://${ApiId}.execute-api.${region}.amazonaws.com`;
}

export async function deployControl() {
  for (const def of Object.values(FUNCTIONS)) await deployFunction(def);
  await rules();
  await schedules();
  await dlqSource();
  const endpoint = await routes();
  return { endpoint, routes: ROUTES.join(", ") };
}

export async function teardownControl({ apply }) {
  const step = async (label, fn) => {
    if (!apply) return log("would", `delete ${label}`);
    try {
      await fn();
      log("deleted", label);
    } catch (err) {
      if (isError(err, "ResourceNotFoundException", "NotFoundException")) log("absent", label);
      else log("FAILED", label, `${err.name}: ${err.message}`);
    }
  };
  const api = new ApiGatewayV2Client({ region });
  const ApiId = config.apiId;
  await step(`routes ${ROUTES.join(", ")} and their integration`, async () => {
    const { Items: existing } = await api.send(new GetRoutesCommand({ ApiId, MaxResults: "500" }));
    for (const r of existing.filter((x) => ROUTES.includes(x.RouteKey))) {
      await api.send(new DeleteRouteCommand({ ApiId, RouteId: r.RouteId }));
    }
    const { Items: integrations } = await api.send(new GetIntegrationsCommand({ ApiId, MaxResults: "500" }));
    for (const i of integrations.filter((x) => x.IntegrationUri === fnArn(FUNCTIONS.api.name))) {
      await api.send(new DeleteIntegrationCommand({ ApiId, IntegrationId: i.IntegrationId }));
    }
  });
  const eb = new EventBridgeClient({ region });
  for (const rule of RULES) {
    await step(`rule ${rule.name}`, async () => {
      await eb.send(new RemoveTargetsCommand({ Rule: rule.name, EventBusName: DATA.bus, Ids: ["lambda"] }));
      await eb.send(new DeleteRuleCommand({ Name: rule.name, EventBusName: DATA.bus }));
    });
  }
  for (const s of SCHEDULES) {
    await step(`schedule ${s.name}`, async () => {
      await eb.send(new RemoveTargetsCommand({ Rule: s.name, Ids: ["lambda"] }));
      await eb.send(new DeleteRuleCommand({ Name: s.name }));
    });
  }
  await step(`event source ${DATA.dlq} -> ${FUNCTIONS.dlq.name}`, async () => {
    const { EventSourceMappings = [] } = await lambda().send(new ListEventSourceMappingsCommand({ FunctionName: FUNCTIONS.dlq.name }));
    for (const m of EventSourceMappings) await lambda().send(new DeleteEventSourceMappingCommand({ UUID: m.UUID }));
  });
  for (const def of Object.values(FUNCTIONS)) {
    await step(`Lambda ${def.name}`, () => lambda().send(new DeleteFunctionCommand({ FunctionName: def.name })));
    await step(`log group ${logGroup(def.name)}`, () => new CloudWatchLogsClient({ region })
      .send(new DeleteLogGroupCommand({ logGroupName: logGroup(def.name) })));
  }
}
