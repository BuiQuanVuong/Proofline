#!/usr/bin/env node
// Load test through the public API, exactly as the CLI submits jobs.
//
//   node services/bin/load-test.js [--jobs=160] [--concurrency=16] [--poll=10] [--out=<file.csv>]
//
// One throwaway repo with one base commit and N head commits, each with unique
// content, so no job can hit the result cache: every job really runs a
// baseline shard and a mutant shard. Prints a status timeline, then latency
// percentiles, throughput and a correctness check, and writes a CSV per job.
// Run infra/watch-scaling.js alongside it to record the scaling side.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { TERMINAL, describeRange, getJobView, readToken, submitRange } from "../src/client.js";
import { makeDemoRepo } from "./make-demo-repo.js";

const { values } = parseArgs({
  options: {
    jobs: { type: "string", default: "160" },
    concurrency: { type: "string", default: "16" },
    poll: { type: "string", default: "10" },
    out: { type: "string" },
    "timeout-min": { type: "string", default: "30" },
    // Every job verifies the same commit (same cache keys): exercises the hot
    // tier and single-flight coalescing instead of raw scaling.
    identical: { type: "boolean", default: false },
  },
});
const JOBS = Number(values.jobs);
const CONCURRENCY = Number(values.concurrency);
const EXPECTED = { riskTier: "HIGH", mutationScore: 0.375 }; // the demo's known answer

const t0 = Date.now();
const secs = (ms) => ((ms - t0) / 1000).toFixed(0).padStart(5);
const say = (msg) => console.log(`${secs(Date.now())}s  ${msg}`);

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

// ------------------------------------------------------------- preflight
let expiresAt;
try {
  ({ expiresAt } = readToken());
} catch (err) {
  console.error(`load-test: ${err.message}`);
  process.exit(1);
}
const minutesLeft = (expiresAt - Date.now()) / 60_000;
if (minutesLeft < Number(values["timeout-min"]) + 5) {
  console.error(`session ends in ${minutesLeft.toFixed(0)} min; run \`proofline login\` first so the test can't outlive it`);
  process.exit(1);
}

// -------------------------------------------------------------- the repo
const repo = path.join(mkdtempSync(path.join(os.tmpdir(), "proofline-load-")), "demo");
// A unique id per run: content (and so every cache key) differs from all earlier
// runs, so no result can come from a previous test's cache.
const RUN_ID = Date.now().toString(36);
const { base } = makeDemoRepo(repo, { salt: `load-${RUN_ID}-0` });
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const calc = path.join(repo, "src", "calc.js");
const heads = [git("rev-parse", "HEAD")];
for (let i = 1; i < JOBS && !values.identical; i++) {
  writeFileSync(calc, readFileSync(calc, "utf8").replace(/\/\/ run .*\n$/, `// run load-${RUN_ID}-${i}\n`));
  git("commit", "-q", "-am", `head ${i}`);
  heads.push(git("rev-parse", "HEAD"));
}
const ranges = values.identical
  ? Array.from({ length: JOBS }, () => describeRange(repo, base, heads[0], "local/load-test"))
  : heads.map((head) => describeRange(repo, base, head, "local/load-test"));
say(values.identical
  ? `built 1 commit range (${JOBS} identical jobs: same cache keys) in ${repo}`
  : `built ${JOBS} unique commit ranges in ${repo}`);

// --------------------------------------------------------------- submit
const jobs = [];
const submitErrors = [];
await pool(ranges, CONCURRENCY, async (range, i) => {
  const submittedAt = Date.now();
  try {
    const jobId = await submitRange(range);
    jobs[i] = { jobId, submittedAt, status: "BASELINE", seen: { BASELINE: submittedAt } };
  } catch (err) {
    submitErrors.push(err.message);
  }
});
const live = jobs.filter(Boolean);
say(`submitted ${live.length}/${JOBS} jobs (${CONCURRENCY} at a time)${submitErrors.length ? `; ${submitErrors.length} failed: ${submitErrors[0]}` : ""}`);

// ----------------------------------------------------------------- poll
const deadline = Date.now() + Number(values["timeout-min"]) * 60_000;
let lastLine = "";
console.log("\n time   BASELINE PLANNING RUNNING  DONE  FAILED");
while (live.some((j) => !TERMINAL.has(j.status)) && Date.now() < deadline) {
  await pool(live.filter((j) => !TERMINAL.has(j.status)), CONCURRENCY, async (job) => {
    try {
      const view = await getJobView(job.jobId);
      if (view.status !== job.status) {
        job.status = view.status;
        job.seen[view.status] ??= Date.now();
      }
      if (view.status === "DONE") Object.assign(job, { riskTier: view.riskTier, mutationScore: view.mutationScore });
    } catch (err) {
      job.lastError = err.message;
    }
  });
  const count = (s) => live.filter((j) => j.status === s).length;
  const line = [count("BASELINE"), count("PLANNING"), count("RUNNING"), count("DONE"), count("BASELINE_FAILED")]
    .map((n, i) => String(n).padStart([8, 9, 8, 6, 8][i])).join("");
  if (line !== lastLine) console.log(`${secs(Date.now())}s${line}`);
  lastLine = line;
  await new Promise((r) => setTimeout(r, Number(values.poll) * 1000));
}

// -------------------------------------------------------------- summary
const done = live.filter((j) => j.status === "DONE");
const latencies = done.map((j) => (j.seen.DONE - j.submittedAt) / 1000).sort((a, b) => a - b);
const correct = done.filter((j) => j.riskTier === EXPECTED.riskTier && j.mutationScore === EXPECTED.mutationScore).length;
const firstDone = Math.min(...done.map((j) => j.seen.DONE));
const lastDone = Math.max(...done.map((j) => j.seen.DONE));
const firstSubmit = Math.min(...live.map((j) => j.submittedAt));

console.log(`
Jobs:        ${done.length}/${JOBS} done, ${live.filter((j) => j.status === "BASELINE_FAILED").length} baseline failed, ` +
  `${live.filter((j) => !TERMINAL.has(j.status)).length} unfinished, ${submitErrors.length} not submitted
Correct:     ${correct}/${done.length} reports match the expected ${EXPECTED.riskTier} / ${EXPECTED.mutationScore}`);
if (done.length) {
  console.log(`Latency:     submit -> DONE  min ${latencies[0].toFixed(0)}s  p50 ${quantile(latencies, 0.5).toFixed(0)}s  ` +
    `p95 ${quantile(latencies, 0.95).toFixed(0)}s  max ${latencies.at(-1).toFixed(0)}s
Makespan:    first submit -> last DONE ${((lastDone - firstSubmit) / 1000).toFixed(0)}s; ` +
    `first DONE after ${((firstDone - firstSubmit) / 1000).toFixed(0)}s
Throughput:  ${(done.length / ((lastDone - firstDone) / 60_000 || 1)).toFixed(1)} jobs/min once results started arriving`);
}

const out = values.out ?? `load-test-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.csv`;
const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
writeFileSync(out, ["jobId,submittedAt,planningAt,runningAt,doneAt,latencyS,status,riskTier,mutationScore",
  ...live.map((j) => [j.jobId, iso(j.submittedAt), iso(j.seen.PLANNING), iso(j.seen.RUNNING), iso(j.seen.DONE),
    j.seen.DONE ? ((j.seen.DONE - j.submittedAt) / 1000).toFixed(1) : "", j.status, j.riskTier ?? "", j.mutationScore ?? ""].join(","))]
  .join("\n") + "\n");
console.log(`CSV:         ${path.resolve(out)}`);
