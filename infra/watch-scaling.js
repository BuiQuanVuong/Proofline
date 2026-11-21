// Read-only live view of the scaling loop: queue backlog, ECS task counts and
// alarm states, one line per sample. Useful for watching a load test.
//
//   node infra/watch-scaling.js [--every=15] [--minutes=30]

import { CloudWatchClient, DescribeAlarmsCommand, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { parseArgs } from "node:util";

import { config } from "./config.js";
import { DATA, queueUrl } from "./phases/data.js";
import { RUNNER } from "./phases/runner.js";
import { METRIC, NAMESPACE, queueDimension } from "../services/src/metrics.js";

const { values } = parseArgs({ options: { every: { type: "string", default: "15" }, minutes: { type: "string", default: "30" } } });
const region = config.region;
const sqs = new SQSClient({ region });
const ecs = new ECSClient({ region });
const cw = new CloudWatchClient({ region });
const deadline = Date.now() + Number(values.minutes) * 60_000;

// The newest Proofline/Backlog datapoint: what the scaling alarms actually see.
async function publishedBacklog() {
  const { Datapoints = [] } = await cw.send(new GetMetricStatisticsCommand({
    Namespace: NAMESPACE, MetricName: METRIC.BACKLOG, Dimensions: queueDimension(DATA.queue),
    StartTime: new Date(Date.now() - 5 * 60_000), EndTime: new Date(), Period: 60, Statistics: ["Maximum"],
  }));
  const latest = Datapoints.sort((a, b) => b.Timestamp - a.Timestamp)[0];
  return latest ? `${latest.Maximum}@${latest.Timestamp.toTimeString().slice(0, 5)}` : "-";
}

console.log("time      waiting  in-flight  dlq  | published   | desired running pending | scale-out alarm  scale-to-zero alarm");
let last = "";
while (Date.now() < deadline) {
  const [work, dlq, svc, alarms, published] = await Promise.all([
    sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl(DATA.queue),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] })),
    sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl(DATA.dlq), AttributeNames: ["ApproximateNumberOfMessages"] })),
    ecs.send(new DescribeServicesCommand({ cluster: RUNNER.cluster, services: [RUNNER.service] })),
    cw.send(new DescribeAlarmsCommand({ AlarmNames: [RUNNER.scaleOutAlarm, RUNNER.scaleInAlarm] })),
    publishedBacklog(),
  ]);
  const s = svc.services?.[0] ?? {};
  const state = (n) => alarms.MetricAlarms.find((a) => a.AlarmName === n)?.StateValue ?? "-";
  const row = [
    String(work.Attributes.ApproximateNumberOfMessages).padStart(7),
    String(work.Attributes.ApproximateNumberOfMessagesNotVisible).padStart(10),
    String(dlq.Attributes.ApproximateNumberOfMessages).padStart(4),
    " |", published.padEnd(11),
    "|", String(s.desiredCount ?? "-").padStart(7), String(s.runningCount ?? "-").padStart(7), String(s.pendingCount ?? "-").padStart(7),
    " |", state(RUNNER.scaleOutAlarm).padEnd(16), state(RUNNER.scaleInAlarm),
  ].join(" ");
  if (row !== last) console.log(`${new Date().toTimeString().slice(0, 8)}  ${row}`);
  last = row;
  await new Promise((r) => setTimeout(r, Number(values.every) * 1000));
}
