#!/usr/bin/env node
// Runs one verification job end to end against the deployed phase-1 resources,
// before any Lambda exists. This script plays the control plane (planner and
// aggregator, the same code the phase-3 Lambdas will run) and starts the real
// runner as a child process, exactly as the container would run it.
//
//   node services/bin/local-e2e.js                      fresh demo repo, HEAD~1..HEAD
//   node services/bin/local-e2e.js --repo=<path> [--base=<rev>] [--head=<rev>] [--deps=<dir>]
//   node services/bin/local-e2e.js --no-runner          use a runner started separately (e.g. the ECS service)
//   node services/bin/local-e2e.js --fresh              unique demo content, so nothing comes from the cache

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gitChangedLines } from "proofline-engine";

import { aggregate } from "../src/aggregator.js";
import { loadConfig } from "../src/config.js";
import { formatReport } from "../src/format.js";
import { STATUS } from "../src/keys.js";
import { planMutants, startJob } from "../src/planner.js";
import { getJob } from "../src/store.js";
import { FIXTURE, makeDemoRepo } from "./make-demo-repo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    base: { type: "string", default: "HEAD~1" },
    head: { type: "string", default: "HEAD" },
    deps: { type: "string", default: FIXTURE },
    "no-runner": { type: "boolean", default: false },
    // Unique demo content, so every mutant misses the cache and really runs.
    fresh: { type: "boolean", default: false },
  },
});

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
const say = (msg) => console.log(`${elapsed()}  ${msg}`);

function startRunner() {
  const child = spawn(process.execPath, [path.join(here, "runner.js"), `--deps=${values.deps}`, "--exit-when-idle=300"],
    { stdio: ["ignore", "pipe", "pipe"] });
  const relay = (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      try {
        const { t, level, component, jobId, shardId, msg, ...rest } = JSON.parse(line);
        const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
        console.log(`${elapsed()}  [runner${shardId ? ` ${shardId}` : ""}] ${level === "error" ? "ERROR " : ""}${msg}${extra ? `  ${extra}` : ""}`);
      } catch {
        console.log(`${elapsed()}  [runner] ${line}`);
      }
    }
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  return child;
}

async function waitForJob(cfg, jobId, label, done, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(cfg, jobId);
    if (done(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const cfg = await loadConfig();
say(`config: table=${cfg.table} bucket=${cfg.bucket} queue=${cfg.workQueueUrl.split("/").pop()} bus=${cfg.bus}`);

let repo = values.repo && path.resolve(values.repo);
if (!repo) {
  repo = path.join(mkdtempSync(path.join(os.tmpdir(), "proofline-demo-")), "demo");
  makeDemoRepo(repo, { salt: values.fresh ? Date.now().toString(36) : null });
  say(`created demo repo ${repo}${values.fresh ? " (fresh content: no cache hits expected)" : ""}`);
}
const rev = (r) => execFileSync("git", ["rev-parse", r], { cwd: repo, encoding: "utf8" }).trim();
const baseSha = rev(values.base);
const headSha = rev(values.head);
const changed = gitChangedLines(repo, baseSha, headSha);
const snapshot = execFileSync("git", ["archive", "--format=tar.gz", headSha], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
say(`${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}: ${changed.size} changed files, snapshot ${(snapshot.length / 1024).toFixed(1)} KiB`);

const runner = values["no-runner"] ? null : startRunner();
try {
  const jobId = await startJob(cfg, { repo: `local/${path.basename(repo)}`, baseSha, headSha, snapshot, changed });
  say(`job ${jobId} created; BASELINE shard queued; JobCreated emitted`);

  let job = await waitForJob(cfg, jobId, "baseline", (j) => j.status !== STATUS.BASELINE);
  if (job.status === STATUS.BASELINE_FAILED) {
    say(`BASELINE_FAILED: ${job.failures?.join(", ")}`);
    process.exitCode = 2;
  } else {
    say(`baseline done in ${job.baselineDurationMs} ms; planning (planner logic, run locally)`);
    const plan = await planMutants(cfg, jobId);
    say(`planned: ${JSON.stringify(plan)}`);

    job = await waitForJob(cfg, jobId, "mutant shards", (j) =>
      j.status !== STATUS.RUNNING || (j.completedShards?.size ?? 0) >= j.shardsTotal);
    say(`all ${job.shardsTotal} shards complete; aggregating (aggregator logic, run locally)`);
    const report = await aggregate(cfg, jobId);
    if (!report) {
      say("aggregation already claimed elsewhere");
    } else {
      console.log(formatReport(report, { location: `s3://${cfg.bucket}/reports/${jobId}.json` }));
      say("done");
    }
  }
} finally {
  runner?.kill("SIGINT");
}
