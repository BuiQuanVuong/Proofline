#!/usr/bin/env node
// Print a job's status and its runner shard logs from S3 (ECS tasks can't send
// logs to CloudWatch in this account, so runners upload them). Read-only.
//
//   node services/bin/show-logs.js <jobId> [--raw]

import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { parseArgs } from "node:util";

import { s3 } from "../src/aws.js";
import { loadConfig } from "../src/config.js";
import { getJob } from "../src/store.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { raw: { type: "boolean", default: false } } });
const jobId = positionals[0];
if (!jobId) {
  console.error("usage: show-logs.js <jobId> [--raw]");
  process.exit(1);
}

const cfg = await loadConfig();
const job = await getJob(cfg, jobId);
if (!job) {
  console.error(`no job ${jobId}`);
  process.exit(1);
}
const { completedShards, ...rest } = job;
console.log(`job ${jobId}: ${job.status}  shards ${completedShards?.size ?? 0}/${job.shardsTotal ?? "?"}  ` +
  `score ${job.mutationScore ?? "-"}  tier ${job.riskTier ?? "-"}`);
if (rest.failures) console.log(`failures: ${rest.failures.join(", ")}`);

const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `logs/${jobId}/` }));
for (const { Key, LastModified } of Contents.sort((a, b) => a.LastModified - b.LastModified)) {
  console.log(`\n--- ${Key.split("/").pop()}  (${LastModified.toISOString()})`);
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key }));
  for (const line of (await Body.transformToString()).split("\n").filter(Boolean)) {
    if (values.raw) {
      console.log(line);
      continue;
    }
    try {
      const { t, level, component, jobId: _j, shardId: _s, msg, ...extra } = JSON.parse(line);
      const fields = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
      console.log(`${t.slice(11, 23)} ${level === "error" ? "ERROR " : ""}${msg}${fields ? `  ${fields}` : ""}`);
    } catch {
      console.log(line);
    }
  }
}
if (!Contents.length) console.log("\n(no shard logs yet)");
