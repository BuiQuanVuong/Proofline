#!/usr/bin/env node
// Where did results come from? Totals cache sources across the jobs listed in
// a load-test CSV, from each report and from each runner shard. Read-only.
//
//   node services/bin/cache-report.js <load-test.csv>

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";

import { ddb } from "../src/aws.js";
import { loadConfig } from "../src/config.js";
import { getJob, getJsonObject } from "../src/store.js";

const csv = process.argv[2];
if (!csv) {
  console.error("usage: cache-report.js <load-test.csv>");
  process.exit(1);
}
const jobIds = readFileSync(csv, "utf8").trim().split("\n").slice(1).map((line) => line.split(",")[0]).filter(Boolean);
const cfg = await loadConfig();

const fromReports = { planner: 0, hot: 0, durable: 0, coalesced: 0, executed: 0 };
const fromShards = { hot: 0, durable: 0, coalesced: 0, executed: 0 };
let jobsWithShards = 0;
let shards = 0;
for (const jobId of jobIds) {
  const job = await getJob(cfg, jobId);
  if (job?.reportKey) {
    const report = await getJsonObject(cfg, job.reportKey);
    for (const [k, v] of Object.entries(report.cacheSources ?? {})) fromReports[k] += v;
  }
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: cfg.table,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :s)",
    ExpressionAttributeValues: { ":pk": `JOB#${jobId}`, ":s": "SHARD#" },
  }));
  if (Items.length) jobsWithShards++;
  for (const item of Items) {
    shards++;
    for (const [k, v] of Object.entries(item.cacheSources ?? {})) fromShards[k] += v;
  }
}

const total = Object.values(fromReports).reduce((a, b) => a + b, 0);
console.log(`${jobIds.length} jobs; ${jobsWithShards} needed mutant shards (${shards} shards in total)\n`);
console.log("Where each executable mutant's result came from (all jobs):");
for (const [source, n] of Object.entries(fromReports)) {
  console.log(`  ${source.padEnd(10)} ${String(n).padStart(5)}  ${total ? ((100 * n) / total).toFixed(1).padStart(5) : "  0.0"}%`);
}
console.log(`  ${"total".padEnd(10)} ${String(total).padStart(5)}`);
console.log(`\nRunner shards only: hot ${fromShards.hot}, durable ${fromShards.durable}, coalesced ${fromShards.coalesced}, executed ${fromShards.executed}`);
console.log(`Mutants actually executed: ${fromReports.executed} for ${jobIds.length} jobs (${(fromReports.executed / jobIds.length).toFixed(2)} per job)`);
