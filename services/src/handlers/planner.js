// EventBridge target: BaselineCompleted (passed) -> plan mutant shards.
// planMutants is idempotent (conditional on PLANNING), so EventBridge's
// at-least-once delivery and Lambda retries are safe.

import { loadConfig } from "../config.js";
import { planMutants } from "../planner.js";

export const handler = async (event) => {
  const { jobId, passed } = event.detail ?? {};
  if (!jobId || !passed) return { skipped: true };
  const result = await planMutants(await loadConfig(), jobId);
  console.log(JSON.stringify({ msg: "planned", jobId, ...result }));
  return result;
};
