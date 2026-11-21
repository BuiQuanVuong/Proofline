// Planner. Never executes repository code.
//   startJob:    snapshot + changed lines -> job record -> BASELINE shard
//   planMutants: after BaselineCompleted -> mutants, cache lookups, mutant shards

import { SendMessageBatchCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FileHasher, NO_COVERAGE, analyzeChange, filesFor, generateMutants, isConfigPath, isSourcePath, isTestPath,
  mutantCacheKey, mutantDiff, mutantTimeoutMs, sha256, testsFor,
} from "proofline-engine";

import { sqs } from "./aws.js";
import { RUNNER_RUNTIME } from "./config.js";
import { EVENT, emit } from "./events.js";
import {
  BASELINE_SHARD, JOB_TTL_DAYS, MAX_SNAPSHOT_BYTES, STATUS, changedFromJson, changedToJson, expiresIn, mutantKey,
  newJobId, objectKeys, shardId,
} from "./keys.js";
import {
  batchPut, createJob, getCachedResults, getJob, getJsonObject, objectSize, putObject, updateJob,
} from "./store.js";
import { prepareWorkspace } from "./workspace.js";

export const SHARD_SIZE = 10; // mutants per shard

async function queueBaseline(cfg, job) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: cfg.workQueueUrl,
    MessageBody: JSON.stringify({
      schemaVersion: 1, type: "BASELINE", jobId: job.jobId, shardId: BASELINE_SHARD, snapshotKey: job.snapshotKey,
    }),
  }));
  await emit(cfg, "planner", EVENT.JOB_CREATED, {
    jobId: job.jobId, repo: job.repo, baseSha: job.baseSha, headSha: job.headSha,
  });
}

const jobRecord = (jobId, { repo, baseSha, headSha, owner = null }, status) => ({
  jobId, repo, baseSha, headSha, owner, status, createdAt: new Date().toISOString(),
  snapshotKey: objectKeys.snapshot(jobId), changedKey: objectKeys.changed(jobId),
});

/** Local path (local-e2e): snapshot in hand, so create and queue in one step. */
export async function startJob(cfg, { repo, baseSha, headSha, snapshot, changed }) {
  const jobId = newJobId();
  await putObject(cfg, objectKeys.snapshot(jobId), snapshot, "application/gzip");
  await putObject(cfg, objectKeys.changed(jobId), JSON.stringify(changedToJson(changed)));
  const job = jobRecord(jobId, { repo, baseSha, headSha }, STATUS.BASELINE);
  await createJob(cfg, job);
  await queueBaseline(cfg, job);
  return jobId;
}

/** API path, step 1: record the job; the client then uploads the snapshot itself (presigned URL). */
export async function createPendingJob(cfg, { repo, baseSha, headSha, changed, owner }) {
  const jobId = newJobId();
  await putObject(cfg, objectKeys.changed(jobId), JSON.stringify(changedToJson(changed)));
  await createJob(cfg, jobRecord(jobId, { repo, baseSha, headSha, owner }, STATUS.UPLOADING));
  return jobId;
}

/**
 * API path, step 2: verify the upload and queue the baseline. Returns null on
 * success, or a reason the job can't start. Conditional on UPLOADING, so a
 * repeated start request never queues a second baseline.
 */
export async function startUploadedJob(cfg, jobId) {
  const job = await getJob(cfg, jobId);
  const size = await objectSize(cfg, job.snapshotKey);
  if (size === null) return "snapshot not uploaded";
  if (size > MAX_SNAPSHOT_BYTES) return `snapshot is ${size} bytes; the limit is ${MAX_SNAPSHOT_BYTES}`;
  const claimed = await updateJob(cfg, jobId, { status: STATUS.BASELINE, snapshotBytes: size },
    { expectStatus: STATUS.UPLOADING });
  if (!claimed) return null; // already started
  await queueBaseline(cfg, job);
  return null;
}

/** Group mutants into shards of at most `size`, never mixing files (one file per working-copy edit). */
export function buildShards(mutants, size = SHARD_SIZE) {
  const byFile = new Map();
  for (const m of mutants) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const shards = [];
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i += size) shards.push(group.slice(i, i + size));
  }
  return shards.map((mutants, i) => ({ shardId: shardId(i + 1), mutants }));
}

/** Files that always belong in a cache key: tooling config and test helpers. */
function sharedInputs(workdir) {
  const found = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (isConfigPath(relPath) || (isTestPath(relPath) && isSourcePath(relPath))) found.push(relPath);
    }
  };
  walk(workdir, "");
  return found;
}

function envHash(workdir) {
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].map((f) => path.join(workdir, f)).find(existsSync);
  return sha256(`${RUNNER_RUNTIME}\0${lock ? readFileSync(lock) : "no-lockfile"}`);
}

const resultItem = (jobId, m, result) => ({
  ...mutantKey(jobId, m.id),
  mutantId: m.id, file: m.file, line: m.line, operator: m.operator, diff: m.diff,
  outcome: result.outcome, killingTest: result.killingTest ?? null, cacheHit: Boolean(result.cacheHit),
  ...(result.cacheHit ? { cacheSource: "planner" } : {}),
  durationMs: result.durationMs ?? 0, ttl: expiresIn(JOB_TTL_DAYS),
});

/**
 * Phase 2: plan mutant shards from the baseline. Idempotent: only the first
 * call for a job (status PLANNING) enqueues anything.
 */
export async function planMutants(cfg, jobId) {
  const job = await getJob(cfg, jobId);
  if (job?.status !== STATUS.PLANNING) return { skipped: true, status: job?.status };

  const workdir = await prepareWorkspace(cfg, jobId, job.snapshotKey);
  const baseline = await getJsonObject(cfg, job.baselineKey);
  const changed = changedFromJson(await getJsonObject(cfg, job.changedKey));

  // PVF analysis: profile, per-file coverage, static
  // findings. Static only, so it's safe here; the aggregator adds mutant results.
  const analysis = analyzeChange({ workdir, changed, baseline });
  const analysisKey = objectKeys.analysis(jobId);
  await putObject(cfg, analysisKey, JSON.stringify(analysis));
  const changedStatements = Object.values(analysis.files).reduce((n, f) => n + f.changedStatements, 0);
  const coveredStatements = Object.values(analysis.files).reduce((n, f) => n + f.coveredStatements, 0);

  // Mutants on changed source lines.
  const mutants = [];
  for (const [file, lines] of changed) {
    if (!isSourcePath(file) || isTestPath(file) || !existsSync(path.join(workdir, file))) continue;
    const source = readFileSync(path.join(workdir, file), "utf8");
    for (const m of generateMutants(file, source, lines)) mutants.push({ ...m, diff: mutantDiff(source, m) });
  }

  // Test selection and content-addressed keys (D2, D3).
  const hasher = new FileHasher(workdir);
  const shared = sharedInputs(workdir);
  const env = envHash(workdir);
  const immediate = [];
  const toRun = [];
  for (const m of mutants) {
    const tests = testsFor(baseline, m.file, m.line);
    if (tests.length === 0) {
      immediate.push(resultItem(jobId, m, { outcome: NO_COVERAGE }));
      continue;
    }
    const fingerprint = hasher.fingerprint([m.file, ...filesFor(baseline, tests)], tests, shared);
    toRun.push({ ...m, tests, cacheKey: mutantCacheKey(m, fingerprint, tests, env), timeoutMs: mutantTimeoutMs(baseline, tests) });
  }

  // Planner-side cache hits never reach the queue (DR-4).
  const hits = await getCachedResults(cfg, toRun.map((m) => m.cacheKey));
  const misses = [];
  for (const m of toRun) {
    const hit = hits.get(m.cacheKey);
    if (hit) immediate.push(resultItem(jobId, m, { ...hit, cacheHit: true }));
    else misses.push(m);
  }
  await batchPut(cfg, immediate);

  const shards = buildShards(misses);
  const claimed = await updateJob(cfg, jobId, {
    status: STATUS.RUNNING, shardsTotal: shards.length, mutantsTotal: mutants.length,
    cacheHitsAtPlanning: immediate.filter((i) => i.cacheHit).length,
    changedStatements, coveredStatements, analysisKey, staticFindings: analysis.findings.length,
    plannedAt: new Date().toISOString(),
  }, { expectStatus: STATUS.PLANNING });
  if (!claimed) return { skipped: true, status: "claimed by another planner" };

  if (shards.length === 0) {
    await emit(cfg, "planner", EVENT.JOB_COMPLETED, { jobId, partial: false });
  }
  for (let i = 0; i < shards.length; i += 10) {
    const { Failed } = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: cfg.workQueueUrl,
      Entries: shards.slice(i, i + 10).map((s) => ({
        Id: s.shardId,
        MessageBody: JSON.stringify({
          schemaVersion: 1, type: "MUTANTS", jobId, shardId: s.shardId, snapshotKey: job.snapshotKey,
          mutants: s.mutants,
        }),
      })),
    }));
    if (Failed?.length) throw new Error(`SendMessageBatch failed for ${Failed.map((f) => `${f.Id}: ${f.Message}`).join(", ")}`);
  }
  return {
    mutants: mutants.length, shards: shards.length,
    cacheHits: immediate.filter((i) => i.cacheHit).length,
    noCoverage: immediate.filter((i) => !i.cacheHit).length,
  };
}
