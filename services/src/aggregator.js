// Aggregator: turns a completed
// job's mutant results into a report, including its PVF assessment. Exactly
// one aggregator wins the RUNNING -> AGGREGATING claim, so duplicate
// JobCompleted events are harmless.

import { KILLED, NO_COVERAGE, SURVIVED, TIMEOUT, assess, mutationScore, riskTier } from "proofline-engine";

import { EVENT, emit } from "./events.js";
import { STATUS, objectKeys } from "./keys.js";
import { getJob, getJsonObject, putObject, queryMutantResults, updateJob } from "./store.js";

const COUNT_KEY = { [KILLED]: "killed", [SURVIVED]: "survived", [TIMEOUT]: "timeout", [NO_COVERAGE]: "noCoverage" };
export const INCONCLUSIVE_ERROR_RATE = 0.2;

/** Pure: job record + mutant result items (+ the planner's PVF analysis) -> report object. */
export function summarise(job, items, analysis = null) {
  const counts = { total: 0, killed: 0, survived: 0, timeout: 0, noCoverage: 0, error: 0, cacheHits: 0 };
  // Where each result came from: planner (DynamoDB at planning), hot (Valkey),
  // durable (DynamoDB at run time), coalesced (another job's run), executed.
  const cacheSources = { planner: 0, hot: 0, durable: 0, coalesced: 0, executed: 0 };
  for (const item of items) {
    counts.total++;
    if (item.cacheHit) counts.cacheHits++;
    counts[COUNT_KEY[item.outcome] ?? "error"]++;
    if (item.outcome !== NO_COVERAGE) cacheSources[item.cacheSource ?? (item.cacheHit ? "planner" : "executed")]++;
  }
  const evidence = items
    .filter((i) => i.outcome === SURVIVED || i.outcome === NO_COVERAGE)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map(({ mutantId, file, line, operator, outcome, diff }) => ({ mutantId, file, line, operator, outcome, diff }));
  const coverage = job.changedStatements
    ? Math.round((job.coveredStatements / job.changedStatements) * 1e4) / 1e4
    : null;
  const score = mutationScore(items);
  // Mutants in shards that exhausted their retries have no result at all.
  counts.missing = Math.max(0, (job.mutantsTotal ?? counts.total) - counts.total);
  const planned = counts.total + counts.missing;
  // Errors and missing results are infrastructure failures, not evidence about
  // the tests. If too many, the score describes too few mutants to triage on.
  const inconclusive = planned > 0 && (counts.error + counts.missing) / planned > INCONCLUSIVE_ERROR_RATE;
  const partial = (job.failedShards?.size ?? 0) > 0;
  const conformance = analysis ? assess({ analysis, mutants: items, baseline: { passed: true } }) : null;
  if (conformance && partial) {
    // Fail closed: lost shards never reach assess(), so a file could look complete.
    conformance.verdict = "FAIL";
    conformance.note = "partial job: some shards never produced results";
  }
  return {
    jobId: job.jobId, repo: job.repo, baseSha: job.baseSha, headSha: job.headSha,
    status: STATUS.DONE,
    partial,
    failedShards: [...(job.failedShards ?? [])].sort(),
    changedStatements: job.changedStatements ?? 0,
    changedLineCoverage: coverage,
    mutants: counts,
    cacheSources,
    mutationScore: score,
    riskTier: inconclusive ? "INCONCLUSIVE" : riskTier(score, coverage, [...new Set(items.map((i) => i.file))]),
    conformance,
    errors: items.filter((i) => i.outcome === "ERROR").slice(0, 5)
      .map(({ mutantId, file, line, detail }) => ({ mutantId, file, line, detail })),
    flakyTests: job.flakyTests ?? [],
    timings: { createdAt: job.createdAt, plannedAt: job.plannedAt, completedAt: new Date().toISOString(),
      baselineMs: job.baselineDurationMs },
    evidence,
  };
}

/** Returns the report, or null if another aggregator already claimed the job. */
export async function aggregate(cfg, jobId) {
  const claimed = await updateJob(cfg, jobId, { status: STATUS.AGGREGATING }, { expectStatus: STATUS.RUNNING });
  if (!claimed) return null;
  const job = await getJob(cfg, jobId);
  const analysis = job.analysisKey ? await getJsonObject(cfg, job.analysisKey) : null;
  const report = summarise(job, await queryMutantResults(cfg, jobId), analysis);
  const reportKey = objectKeys.report(jobId);
  await putObject(cfg, reportKey, JSON.stringify(report, null, 2));
  await updateJob(cfg, jobId, {
    status: STATUS.DONE, reportKey, mutationScore: report.mutationScore, riskTier: report.riskTier,
    pvfVerdict: report.conformance?.verdict ?? null, pvfLevel: report.conformance?.achievedLevel ?? null,
    completedAt: report.timings.completedAt,
  });
  await emit(cfg, "aggregator", EVENT.REPORT_READY, {
    jobId, reportKey, riskTier: report.riskTier, pvfVerdict: report.conformance?.verdict ?? null,
  });
  return report;
}
