// Custom CloudWatch metrics. Constants only, so the
// infra scripts can import them without pulling in AWS clients.

export const NAMESPACE = "Proofline";
export const METRIC = Object.freeze({
  BACKLOG: "Backlog",   // waiting + in flight: what the scaling alarms use
  WAITING: "Waiting",
  IN_FLIGHT: "InFlight",
});
export const queueDimension = (queueName) => [{ Name: "QueueName", Value: queueName }];
