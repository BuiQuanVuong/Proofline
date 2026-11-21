// Read-only: measured resource use for one load test, per job, to check the
// cost model's assumptions (report §5.1). Reads CloudWatch metrics, the
// runner service's scaling history and the Lambda REPORT log lines for the
// window of the load test whose CSV is given.
//
//   node infra/utilisation.js --csv=evidence/load-160-live-metric-fresh.csv [--out=evidence/utilisation-load-160.json]
//
// Window: first submit − 1 min to last result + 1 min. Task-minutes also follow
// the service until it has scaled back to zero (up to 15 minutes later).

import { ApplicationAutoScalingClient, DescribeScalingActivitiesCommand } from "@aws-sdk/client-application-auto-scaling";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { config } from "./config.js";
import { FUNCTIONS } from "./phases/control.js";
import { DATA } from "./phases/data.js";
import { RUNNER } from "./phases/runner.js";

const { values } = parseArgs({ options: { csv: { type: "string" }, out: { type: "string" } } });
if (!values.csv) {
  console.error("usage: node infra/utilisation.js --csv=<load-test.csv> [--out=<file.json>]");
  process.exit(1);
}
const { region } = config;
const cw = new CloudWatchClient({ region });

// --- the load test's window and job count
const [header, ...lines] = readFileSync(values.csv, "utf8").trim().split(/\r?\n/);
const cols = header.split(",");
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
const jobs = rows.length;
const times = (k) => rows.map((r) => Date.parse(r[k])).filter(Number.isFinite);
const start = new Date(Math.min(...times("submittedAt")) - 60_000);
const end = new Date(Math.max(...times("doneAt")) + 60_000);
const tail = new Date(end.getTime() + 15 * 60_000);
const minutes = (end - start) / 60_000;

async function stat(Namespace, MetricName, dims, Statistics, { from = start, to = end, Period = 60 } = {}) {
  const { Datapoints = [] } = await cw.send(new GetMetricStatisticsCommand({
    Namespace, MetricName, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
    StartTime: from, EndTime: to, Period, Statistics,
  }));
  return Datapoints.sort((a, b) => a.Timestamp - b.Timestamp);
}
const sum = (dps, k = "Sum") => dps.reduce((a, d) => a + (d[k] ?? 0), 0);
const max = (dps, k = "Maximum") => dps.reduce((a, d) => Math.max(a, d[k] ?? 0), 0);
const mean = (dps, k = "Average") => (dps.length ? dps.reduce((a, d) => a + d[k], 0) / dps.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;
const result = { csv: values.csv, jobs, window: { start, end, minutes: r1(minutes) } };

// --- runner service: CPU and memory of the tasks (1 vCPU / 2 GB each)
const svc = { ClusterName: RUNNER.cluster, ServiceName: RUNNER.service };
const cpu = await stat("AWS/ECS", "CPUUtilization", svc, ["Average", "Maximum"]);
const mem = await stat("AWS/ECS", "MemoryUtilization", svc, ["Average", "Maximum"]);
result.runnerCpuPercent = { average: r1(mean(cpu)), maximum: r1(max(cpu)), minutesWithData: cpu.length };
result.runnerMemoryPercent = { average: r1(mean(mem)), maximum: r1(max(mem)) };

// --- runner task-minutes, from the scaling history (desired count over time)
try {
  const { ScalingActivities = [] } = await new ApplicationAutoScalingClient({ region }).send(new DescribeScalingActivitiesCommand({
    ServiceNamespace: "ecs", ResourceId: `service/${RUNNER.cluster}/${RUNNER.service}`, ScalableDimension: "ecs:service:DesiredCount",
  }));
  const changes = ScalingActivities
    .map((a) => ({ t: a.StartTime.getTime(), n: Number(/desired count to (\d+)/i.exec(a.Description ?? "")?.[1]) }))
    .filter((c) => Number.isFinite(c.n)).sort((a, b) => a.t - b.t);
  let count = changes.filter((c) => c.t <= start.getTime()).at(-1)?.n ?? 0;
  let t = start.getTime(), taskMs = 0, peak = count, backToZero = null;
  for (const c of changes.filter((c) => c.t > start.getTime() && c.t <= tail.getTime())) {
    taskMs += count * (c.t - t);
    t = c.t; count = c.n; peak = Math.max(peak, count);
    if (count === 0) backToZero = new Date(c.t); // the last return to zero
  }
  taskMs += count * ((backToZero ?? tail).getTime() - t) * (count > 0 ? 1 : 0);
  const taskMinutes = taskMs / 60_000;
  result.runnerTasks = {
    peakDesired: peak, backToZeroAt: backToZero, taskMinutes: r1(taskMinutes),
    taskSecondsPerJob: r1((taskMinutes * 60) / jobs),
    note: "desired count over time, from the first submit until the service returned to zero; tasks spend ~30 s of it starting",
    changes: changes.filter((c) => c.t >= start.getTime() - 60_000 && c.t <= tail.getTime()).map((c) => `${new Date(c.t).toISOString()} -> ${c.n}`),
  };
} catch (err) {
  result.runnerTasks = { error: `${err.name}: ${err.message}` };
}

// --- Lambda: invocations and duration per function
result.lambda = {};
for (const [key, fn] of Object.entries(FUNCTIONS)) {
  const dims = { FunctionName: fn.name };
  const inv = await stat("AWS/Lambda", "Invocations", dims, ["Sum"]);
  const dur = await stat("AWS/Lambda", "Duration", dims, ["Average", "Maximum"]);
  result.lambda[key] = { invocations: sum(inv), perJob: r1(sum(inv) / jobs), avgMs: Math.round(mean(dur)), maxMs: Math.round(max(dur)) };
}

// --- Lambda memory actually used, from the REPORT log lines (optional: needs Logs Insights)
try {
  const logs = new CloudWatchLogsClient({ region });
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupNames: Object.values(FUNCTIONS).map((f) => `/aws/lambda/${f.name}`),
    startTime: Math.floor(start / 1000), endTime: Math.ceil(end / 1000),
    queryString: 'filter @type = "REPORT" | stats count() as n, avg(@billedDuration) as avgBilledMs, max(@maxMemoryUsed / 1000 / 1000) as maxMemMB, max(@memorySize / 1000 / 1000) as sizeMB by @log',
  }));
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const q = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (q.status === "Complete") {
      result.lambdaMemory = q.results.map((row) => Object.fromEntries(row.map((f) => [f.field, f.value])));
      break;
    }
  }
} catch (err) {
  result.lambdaMemory = { error: `${err.name}: ${err.message}` };
}

// --- DynamoDB, API Gateway, SQS, S3
const rcu = await stat("AWS/DynamoDB", "ConsumedReadCapacityUnits", { TableName: DATA.table }, ["Sum"]);
const wcu = await stat("AWS/DynamoDB", "ConsumedWriteCapacityUnits", { TableName: DATA.table }, ["Sum"]);
result.dynamodb = { readUnits: r1(sum(rcu)), writeUnits: r1(sum(wcu)), readPerJob: r1(sum(rcu) / jobs), writePerJob: r1(sum(wcu) / jobs) };
const api = await stat("AWS/ApiGateway", "Count", { ApiId: config.apiId }, ["Sum"]);
result.apiRequests = { total: sum(api), perJob: r1(sum(api) / jobs) };
const sent = await stat("AWS/SQS", "NumberOfMessagesSent", { QueueName: DATA.queue }, ["Sum"]);
result.sqsMessagesSent = { total: sum(sent), perJob: r1(sum(sent) / jobs) };
const day = 86_400_000;
const size = await stat("AWS/S3", "BucketSizeBytes", { BucketName: DATA.bucket, StorageType: "StandardStorage" }, ["Average"],
  { from: new Date(Date.now() - 3 * day), to: new Date(), Period: 86_400 });
result.s3BucketMB = size.length ? r1(size.at(-1).Average / 1e6) : null;

// --- print
const L = result.lambda;
console.log(`Load test ${values.csv}: ${jobs} jobs, window ${start.toISOString()} – ${end.toISOString()} (${r1(minutes)} min)\n`);
console.log(`Runner CPU      avg ${result.runnerCpuPercent.average}%  max ${result.runnerCpuPercent.maximum}%   (of 1 vCPU per task)`);
console.log(`Runner memory   avg ${result.runnerMemoryPercent.average}%  max ${result.runnerMemoryPercent.maximum}%   (of 2 GB per task)`);
if (result.runnerTasks.error) console.log(`Runner tasks    ${result.runnerTasks.error}`);
else console.log(`Runner tasks    peak ${result.runnerTasks.peakDesired}, ${result.runnerTasks.taskMinutes} task-minutes, ${result.runnerTasks.taskSecondsPerJob} task-seconds per job, back to 0 at ${result.runnerTasks.backToZeroAt?.toISOString() ?? "(not within 15 min)"}`);
for (const [k, v] of Object.entries(L)) console.log(`Lambda ${k.padEnd(10)} ${String(v.invocations).padStart(5)} invocations (${v.perJob}/job), avg ${v.avgMs} ms, max ${v.maxMs} ms`);
if (Array.isArray(result.lambdaMemory)) for (const m of result.lambdaMemory) console.log(`  memory ${m["@log"]?.split("/").at(-1)}: max ${Math.round(m.maxMemMB)} of ${Math.round(m.sizeMB)} MB, avg billed ${Math.round(m.avgBilledMs)} ms`);
else console.log(`Lambda memory   ${result.lambdaMemory?.error ?? "query did not finish"}`);
console.log(`DynamoDB        ${result.dynamodb.readUnits} RCU (${result.dynamodb.readPerJob}/job), ${result.dynamodb.writeUnits} WCU (${result.dynamodb.writePerJob}/job)`);
console.log(`API Gateway     ${result.apiRequests.total} requests (${result.apiRequests.perJob}/job)`);
console.log(`SQS             ${result.sqsMessagesSent.total} messages sent (${result.sqsMessagesSent.perJob}/job)`);
console.log(`S3 bucket       ${result.s3BucketMB ?? "-"} MB (latest daily figure)`);
if (values.out) {
  writeFileSync(values.out, JSON.stringify(result, null, 2));
  console.log(`\nwritten to ${values.out}`);
}
