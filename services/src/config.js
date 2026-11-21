// Runtime configuration. Resource names come from environment variables (set
// by the deploy script on the task definition / Lambda) or, failing that, from
// Parameter Store, which phase 1 of the deploy writes.

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-southeast-2";
const PARAM_PREFIX = process.env.PROOFLINE_PARAM_PREFIX ?? "/proofline";

// The runner image's runtime. Part of every cache key, because the same test
// can behave differently on another Node major.
export const RUNNER_RUNTIME = "node22";

const SETTINGS = {
  table: ["PROOFLINE_TABLE", "table"],
  bucket: ["PROOFLINE_BUCKET", "bucket"],
  workQueueUrl: ["PROOFLINE_WORK_QUEUE_URL", "work-queue-url"],
  bus: ["PROOFLINE_EVENT_BUS", "event-bus"],
};

let cached;

export async function loadConfig() {
  if (cached) return cached;
  const ssm = new SSMClient({ region: REGION });
  const entries = await Promise.all(Object.entries(SETTINGS).map(async ([key, [envName, param]]) => {
    if (process.env[envName]) return [key, process.env[envName]];
    // GetParameter, not GetParametersByPath, so the roles need only the
    // narrower permission.
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: `${PARAM_PREFIX}/${param}` }));
    return [key, Parameter.Value];
  }));
  cached = Object.freeze(Object.fromEntries(entries));
  return cached;
}
