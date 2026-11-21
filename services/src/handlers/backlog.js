// Scheduled every minute: publish the work queue's *live* depth as a custom
// metric for the scaling alarms.
//
// Why: the 160-job load test showed SQS's own CloudWatch metrics arrive 3-4
// minutes late. Alarms on them scaled the service to zero with 159 shards
// waiting, then took minutes to notice the backlog. GetQueueAttributes is
// current to within seconds, so alarms on this metric react about a minute
// after work arrives.

import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";

import { REGION, loadConfig } from "../config.js";
import { sqs } from "../aws.js";
import { METRIC, NAMESPACE, queueDimension } from "../metrics.js";

const cloudwatch = new CloudWatchClient({ region: REGION });

export const handler = async () => {
  const cfg = await loadConfig();
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: cfg.workQueueUrl,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
  }));
  const waiting = Number(Attributes.ApproximateNumberOfMessages);
  const inFlight = Number(Attributes.ApproximateNumberOfMessagesNotVisible);
  const Dimensions = queueDimension(cfg.workQueueUrl.split("/").pop());
  const Timestamp = new Date();
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: [
      { MetricName: METRIC.BACKLOG, Dimensions, Timestamp, Value: waiting + inFlight, Unit: "Count" },
      { MetricName: METRIC.WAITING, Dimensions, Timestamp, Value: waiting, Unit: "Count" },
      { MetricName: METRIC.IN_FLIGHT, Dimensions, Timestamp, Value: inFlight, Unit: "Count" },
    ],
  }));
  return { waiting, inFlight };
};
