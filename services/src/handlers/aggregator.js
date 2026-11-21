// EventBridge target: JobCompleted -> build the report. Only the first
// delivery wins the RUNNING -> AGGREGATING claim; duplicates return null.

import { aggregate } from "../aggregator.js";
import { loadConfig } from "../config.js";

export const handler = async (event) => {
  const { jobId } = event.detail ?? {};
  if (!jobId) return { skipped: true };
  const report = await aggregate(await loadConfig(), jobId);
  console.log(JSON.stringify(report
    ? { msg: "aggregated", jobId, riskTier: report.riskTier, mutationScore: report.mutationScore, mutants: report.mutants, partial: report.partial }
    : { msg: "already aggregated", jobId }));
  return { aggregated: Boolean(report) };
};
