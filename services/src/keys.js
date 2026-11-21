// Identifiers, single-table keys and object-store layout.

import { randomBytes } from "node:crypto";

export const STATUS = Object.freeze({
  UPLOADING: "UPLOADING",             // created through the API; waiting for the snapshot upload
  BASELINE: "BASELINE",               // baseline shard queued or running
  BASELINE_FAILED: "BASELINE_FAILED", // suite fails before any mutation
  PLANNING: "PLANNING",               // baseline done; mutants being planned
  RUNNING: "RUNNING",                 // mutant shards queued or running
  AGGREGATING: "AGGREGATING",         // claimed by exactly one aggregator
  DONE: "DONE",
});

/** Time-sortable job ID, e.g. j_mgx2k1a9f3c2e1. */
export const newJobId = () => `j_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
export const BASELINE_SHARD = "s_baseline";
export const shardId = (n) => `s_${String(n).padStart(4, "0")}`;

export const jobKey = (jobId) => ({ PK: `JOB#${jobId}`, SK: "META" });
export const shardKey = (jobId, shard) => ({ PK: `JOB#${jobId}`, SK: `SHARD#${shard}` });
export const mutantKey = (jobId, mutantId) => ({ PK: `JOB#${jobId}`, SK: `MUT#${mutantId}` });
export const cacheItemKey = (cacheKey) => ({ PK: `CACHE#${cacheKey}`, SK: "RESULT" });

export const objectKeys = {
  snapshot: (jobId) => `snapshots/${jobId}/source.tar.gz`,
  changed: (jobId) => `snapshots/${jobId}/changed.json`,
  analysis: (jobId) => `snapshots/${jobId}/analysis.json`,
  baseline: (jobId) => `coverage/${jobId}.json`,
  log: (jobId, shard) => `logs/${jobId}/${shard}.log`,
  report: (jobId) => `reports/${jobId}.json`,
};

/** Epoch seconds `days` from now, for DynamoDB TTL. */
export const expiresIn = (days) => Math.floor(Date.now() / 1000) + days * 86_400;
export const JOB_TTL_DAYS = 30;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
export const UPLOAD_URL_TTL_S = 5 * 60;
export const CACHE_TTL_DAYS = 30;

/** Changed-line maps travel as JSON objects of sorted arrays. */
export const changedToJson = (changed) =>
  Object.fromEntries([...changed].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]));
export const changedFromJson = (json) =>
  new Map(Object.entries(json).map(([file, lines]) => [file, new Set(lines)]));
