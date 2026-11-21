// Phase 3: the runner service and its auto scaling.
//
// - task definition: no logConfiguration (the execution role can't create
//   CloudWatch log streams, so tasks with one fail at startup); tags inline
// - ECS service: private subnets, no public IP, desired 0; scaling owns the count
// - step scaling on queue depth = visible + in-flight messages:
//     scale-out alarm (backlog >= 1)    -> ExactCapacity by band, re-evaluated
//                                           while in ALARM
//     scale-to-zero alarm (backlog 0, 5 min) -> ExactCapacity 0
//   Runners hold ECS task scale-in protection while working, so a lower band
//   never stops a task mid-shard.

import {
  DeleteScalingPolicyCommand, DeregisterScalableTargetCommand, PutScalingPolicyCommand,
  ApplicationAutoScalingClient, RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";
import { CloudWatchClient, DeleteAlarmsCommand, PutMetricAlarmCommand } from "@aws-sdk/client-cloudwatch";
import {
  CreateServiceCommand, DeleteServiceCommand, DeregisterTaskDefinitionCommand, DescribeServicesCommand, ECSClient,
  ListTaskDefinitionsCommand, RegisterTaskDefinitionCommand, UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { config, name, roleArn, tagList } from "../config.js";
import { isError, log } from "../lib/log.js";
import { discoverNetwork } from "../network.js";
import { DATA, queueUrl } from "./data.js";
import { CACHE, describeCache } from "./cache.js";
import { REGISTRY, listImages } from "./registry.js";
import { METRIC, NAMESPACE, queueDimension } from "../../services/src/metrics.js";

const { region } = config;

export const RUNNER = {
  cluster: name("cluster"),
  family: name("runner"),
  service: name("runner-service"),
  cpu: "1024",    // 1 vCPU: one shard at a time
  memory: "2048",
  minTasks: 0,
  maxTasks: 20,
  scaleOutAlarm: name("runner-backlog-high"),
  scaleInAlarm: name("runner-backlog-zero"),
  scaleOutPolicy: name("runner-scale-out"),
  scaleInPolicy: name("runner-scale-to-zero"),
};
const resourceId = () => `service/${RUNNER.cluster}/${RUNNER.service}`;

// Backlog bands -> exact worker count. Bounds are relative to
// the alarm threshold of 1, so [0, 9) means a backlog of 1-9.
export const BANDS = [
  [1, 9, 1],
  [10, 39, 3],
  [40, 149, 6],
  [150, 399, 12],
  [400, null, 20],
];

async function taskDefinition(image) {
  const ecs = new ECSClient({ region });
  // The hot cache (phase 5), once it's available; runners work without it.
  const cache = await describeCache();
  const cacheEnv = cache?.status === "available"
    ? { PROOFLINE_CACHE_HOST: cache.host, PROOFLINE_CACHE_PORT: String(cache.port), PROOFLINE_CACHE_SECRET: CACHE.secret }
    : {};
  log(cache?.status === "available" ? "ok" : "skipped", "hot cache for runners",
    cache?.status === "available" ? `${cache.host}:${cache.port}` : `Valkey ${cache?.status ?? "not created"}; runners use DynamoDB only`);
  const env = {
    AWS_REGION: region,
    PROOFLINE_TABLE: DATA.table,
    PROOFLINE_BUCKET: DATA.bucket,
    PROOFLINE_WORK_QUEUE_URL: queueUrl(DATA.queue),
    PROOFLINE_EVENT_BUS: DATA.bus,
    ...cacheEnv,
  };
  const { taskDefinition: td } = await ecs.send(new RegisterTaskDefinitionCommand({
    family: RUNNER.family,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    cpu: RUNNER.cpu,
    memory: RUNNER.memory,
    taskRoleArn: roleArn("task"),
    executionRoleArn: roleArn("execution"),
    containerDefinitions: [{
      name: "runner",
      image,
      essential: true,
      environment: Object.entries(env).map(([name, value]) => ({ name, value })),
      // Fargate's maximum: time to release an in-flight message on SIGTERM.
      stopTimeout: 120,
      // No logConfiguration: see header. Shard logs go to S3 instead.
    }],
    tags: tagList("key", "value"),
  }));
  log("ok", `task definition ${td.family}:${td.revision}`, `${RUNNER.cpu} CPU / ${RUNNER.memory} MiB, ${image.split("/").pop()}`);
  return td.taskDefinitionArn;
}

async function service(taskDefinitionArn) {
  const ecs = new ECSClient({ region });
  const net = await discoverNetwork();
  const networkConfiguration = { awsvpcConfiguration: {
    subnets: net.privateSubnetIds, securityGroups: [net.securityGroupId], assignPublicIp: "DISABLED",
  } };
  const { services } = await ecs.send(new DescribeServicesCommand({ cluster: RUNNER.cluster, services: [RUNNER.service] }));
  if (services?.[0]?.status === "ACTIVE") {
    // Never touch desiredCount here: auto scaling owns it.
    await ecs.send(new UpdateServiceCommand({
      cluster: RUNNER.cluster, service: RUNNER.service, taskDefinition: taskDefinitionArn, networkConfiguration,
    }));
    log("updated", `ECS service ${RUNNER.service}`, `now ${taskDefinitionArn.split("/").pop()}`);
    return services[0].serviceArn;
  }
  const { service: created } = await ecs.send(new CreateServiceCommand({
    cluster: RUNNER.cluster,
    serviceName: RUNNER.service,
    taskDefinition: taskDefinitionArn,
    desiredCount: 0,
    launchType: "FARGATE",
    platformVersion: "LATEST",
    networkConfiguration,
    deploymentConfiguration: {
      minimumHealthyPercent: 0, maximumPercent: 200,
      deploymentCircuitBreaker: { enable: true, rollback: true },
    },
    enableECSManagedTags: true,
    propagateTags: "SERVICE",
    tags: tagList("key", "value"),
  }));
  log("created", `ECS service ${RUNNER.service}`, "desired 0, private subnets, no public IP");
  return created.serviceArn;
}

// Live backlog (waiting + in flight), published every minute by the
// backlog-publisher Lambda. Not AWS/SQS metrics: the first load test showed
// those arrive 3-4 minutes late, which scaled the service to zero with 159
// shards waiting (evidence/load-160.csv).
const backlogMetric = {
  Namespace: NAMESPACE, MetricName: METRIC.BACKLOG, Dimensions: queueDimension(DATA.queue),
  Statistic: "Maximum", Period: 60,
};

async function scaling() {
  const aas = new ApplicationAutoScalingClient({ region });
  const cw = new CloudWatchClient({ region });
  const target = {
    ServiceNamespace: "ecs", ResourceId: resourceId(), ScalableDimension: "ecs:service:DesiredCount",
  };
  const capacity = { ...target, MinCapacity: RUNNER.minTasks, MaxCapacity: RUNNER.maxTasks };
  let ScalableTargetARN;
  try {
    ({ ScalableTargetARN } = await aas.send(new RegisterScalableTargetCommand({ ...capacity, Tags: { ...config.tags } })));
  } catch (err) {
    // Tags are accepted only when the target is created; it was tagged then.
    if (!(isError(err, "ValidationException") && /already exists/.test(err.message))) throw err;
    ({ ScalableTargetARN } = await aas.send(new RegisterScalableTargetCommand(capacity)));
  }
  log("ok", `scalable target ${resourceId()}`, `${RUNNER.minTasks}-${RUNNER.maxTasks} tasks`);

  const { PolicyARN: outArn } = await aas.send(new PutScalingPolicyCommand({
    ...target,
    PolicyName: RUNNER.scaleOutPolicy,
    PolicyType: "StepScaling",
    StepScalingPolicyConfiguration: {
      AdjustmentType: "ExactCapacity",
      MetricAggregationType: "Maximum",
      Cooldown: 60,
      StepAdjustments: BANDS.map(([lo, hi, tasks]) => ({
        MetricIntervalLowerBound: lo - 1,
        ...(hi === null ? {} : { MetricIntervalUpperBound: hi }),
        ScalingAdjustment: tasks,
      })),
    },
  }));
  const { PolicyARN: inArn } = await aas.send(new PutScalingPolicyCommand({
    ...target,
    PolicyName: RUNNER.scaleInPolicy,
    PolicyType: "StepScaling",
    StepScalingPolicyConfiguration: {
      AdjustmentType: "ExactCapacity",
      MetricAggregationType: "Maximum",
      Cooldown: 60,
      StepAdjustments: [{ MetricIntervalUpperBound: 0, ScalingAdjustment: 0 }],
    },
  }));
  log("ok", `step policies`, `out: ${BANDS.map(([lo, hi, n]) => `${lo}${hi ? `-${hi}` : "+"}->${n}`).join(" ")}; idle 5 min -> 0`);

  await cw.send(new PutMetricAlarmCommand({
    AlarmName: RUNNER.scaleOutAlarm,
    AlarmDescription: "Proofline: shards waiting or in flight; drives runner step scaling",
    ...backlogMetric,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    Threshold: 1,
    EvaluationPeriods: 1,
    DatapointsToAlarm: 1,
    // No data means the publisher has stopped, not that there's no work: do nothing.
    TreatMissingData: "missing",
    AlarmActions: [outArn],
    Tags: tagList(),
  }));
  await cw.send(new PutMetricAlarmCommand({
    AlarmName: RUNNER.scaleInAlarm,
    AlarmDescription: "Proofline: no shards for 5 minutes; scales runners to zero",
    ...backlogMetric,
    ComparisonOperator: "LessThanThreshold",
    Threshold: 1,
    EvaluationPeriods: 5,
    DatapointsToAlarm: 5,
    // Only five real zero readings scale to zero. Treating missing data as
    // "no work" is exactly how the SQS-metric version scaled in under load.
    TreatMissingData: "missing",
    AlarmActions: [inArn],
    Tags: tagList(),
  }));
  log("ok", `alarms ${RUNNER.scaleOutAlarm}, ${RUNNER.scaleInAlarm}`);
  return ScalableTargetARN;
}

/** The image to deploy: PROOFLINE_IMAGE if set, else the newest push in ECR. */
async function imageToDeploy() {
  if (process.env.PROOFLINE_IMAGE) return process.env.PROOFLINE_IMAGE;
  const [newest] = await listImages();
  if (!newest) throw new Error(`no images in ${REGISTRY.repository}; run infra/push-runner.js first`);
  return newest.uri;
}

export async function deployRunner() {
  const image = await imageToDeploy();
  const taskDefinitionArn = await taskDefinition(image);
  const serviceArn = await service(taskDefinitionArn);
  const scalableTargetArn = await scaling();
  return { image, taskDefinitionArn, serviceArn, scalableTargetArn };
}

export async function teardownRunner({ apply }) {
  const step = async (label, fn) => {
    if (!apply) return log("would", `delete ${label}`);
    try {
      await fn();
      log("deleted", label);
    } catch (err) {
      if (isError(err, "ObjectNotFoundException", "ServiceNotFoundException", "ClusterNotFoundException",
        "ResourceNotFoundException", "ServiceNotActiveException")) log("absent", label);
      else log("FAILED", label, `${err.name}: ${err.message}`);
    }
  };
  const aas = new ApplicationAutoScalingClient({ region });
  const target = { ServiceNamespace: "ecs", ResourceId: resourceId(), ScalableDimension: "ecs:service:DesiredCount" };
  await step(`alarms ${RUNNER.scaleOutAlarm}, ${RUNNER.scaleInAlarm}`, () => new CloudWatchClient({ region })
    .send(new DeleteAlarmsCommand({ AlarmNames: [RUNNER.scaleOutAlarm, RUNNER.scaleInAlarm] })));
  for (const PolicyName of [RUNNER.scaleOutPolicy, RUNNER.scaleInPolicy]) {
    await step(`scaling policy ${PolicyName}`, () => aas.send(new DeleteScalingPolicyCommand({ ...target, PolicyName })));
  }
  await step(`scalable target ${resourceId()}`, () => aas.send(new DeregisterScalableTargetCommand(target)));

  const ecs = new ECSClient({ region });
  await step(`ECS service ${RUNNER.service}`, () => ecs.send(new DeleteServiceCommand({
    cluster: RUNNER.cluster, service: RUNNER.service, force: true,
  })));
  await step(`task definitions ${RUNNER.family}:*`, async () => {
    const { taskDefinitionArns } = await ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: RUNNER.family, status: "ACTIVE" }));
    for (const arn of taskDefinitionArns) await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
  });
}
