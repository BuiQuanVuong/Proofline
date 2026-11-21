// Local end-to-end pipeline: the same steps the cloud services perform, in one process.
//
// Cloud mapping: checkout + planMutants belong to the planner (Lambda);
// runBaseline + runMutant belong to the test runners (Fargate).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileHasher, mutantCacheKey, sha256 } from "./cachekey.js";
import { gitChangedLines, isConfigPath, isSourcePath, isTestPath } from "./diff.js";
import { NO_COVERAGE, filesFor, mutantTimeoutMs, runBaseline, runMutant, testsFor } from "./execute.js";
import { analyzeChange } from "./framework/analyze.js";
import { assess } from "./framework/assess.js";
import { generateMutants, mutantDiff, statementLines } from "./mutate.js";
import { buildReport } from "./report.js";

/** JSON-file stand-in for the in-memory cache (ElastiCache in the cloud). */
export class LocalCache {
  constructor(file) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  get(key) {
    return this.data[key];
  }

  put(key, value) {
    this.data[key] = value;
  }

  save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data));
  }
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * Check out `rev` into `dest` and provide dependencies: link the source repo's
 * node_modules when present (fast, local use), otherwise run `npm ci`.
 */
export function checkout(repo, rev, dest) {
  execFileSync("git", ["clone", "-q", "--no-checkout", repo, dest]);
  git(dest, "-c", "advice.detachedHead=false", "checkout", "-q", rev);
  const modules = path.join(repo, "node_modules");
  if (existsSync(modules)) {
    symlinkSync(modules, path.join(dest, "node_modules"), "junction");
  } else {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dest, shell: process.platform === "win32" });
  }
}

function cleanup(workdir) {
  // Remove the node_modules link first so a recursive delete can never follow it.
  try { unlinkSync(path.join(workdir, "node_modules")); } catch { /* not a link */ }
  rmSync(path.dirname(workdir), { recursive: true, force: true });
}

export function planMutants(workdir, changed) {
  const mutants = [];
  const sources = new Map();
  for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isSourcePath(file) || isTestPath(file)) continue;
    const source = readFileSync(path.join(workdir, file), "utf8");
    sources.set(file, source);
    mutants.push(...generateMutants(file, source, lines));
  }
  return { mutants, sources };
}

function changedLineCoverage(baseline, changed, sources) {
  let total = 0;
  let covered = 0;
  for (const [file, source] of sources) {
    const statements = statementLines(file, source);
    for (const line of changed.get(file)) {
      if (!statements.has(line)) continue;
      total++;
      if (testsFor(baseline, file, line).length) covered++;
    }
  }
  return { total, covered };
}

/** Test helpers, setup files and tooling config: always part of the cache key. */
function sharedInputs(workdir) {
  const files = git(workdir, "ls-files").split("\n").filter(Boolean);
  return files.filter((f) => isConfigPath(f) || (isTestPath(f) && isSourcePath(f)));
}

function envHash(workdir) {
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
    .map((f) => path.join(workdir, f)).find(existsSync);
  return sha256(`${process.version}\0${lock ? readFileSync(lock) : "no-lockfile"}`);
}

export async function verifyLocal(repo, base, head, { cachePath = null, progress = () => {} } = {}) {
  const started = Date.now();
  const meta = { repo, baseSha: base, headSha: head };
  const changed = gitChangedLines(repo, base, head);
  const cache = new LocalCache(cachePath);
  const workdir = path.join(mkdtempSync(path.join(os.tmpdir(), "proofline-wc-")), "repo");

  try {
    checkout(repo, head, workdir);

    progress("baseline: full suite twice, then per-test-file coverage");
    const baseline = await runBaseline(workdir);
    if (!baseline.passed) {
      return {
        ...meta, status: "BASELINE_FAILED", failures: baseline.failures, output: baseline.output.slice(-4000),
        conformance: assess({ analysis: analyzeChange({ workdir, changed, baseline }), baseline }),
      };
    }

    const { mutants, sources } = planMutants(workdir, changed);
    progress(`planned ${mutants.length} mutants across ${sources.size} changed files` +
      (baseline.flaky.length ? `; ${baseline.flaky.length} flaky tests quarantined` : ""));

    const hasher = new FileHasher(workdir);
    const shared = sharedInputs(workdir);
    const env = envHash(workdir);
    const results = [];
    for (const [i, m] of mutants.entries()) {
      const tests = testsFor(baseline, m.file, m.line);
      if (tests.length === 0) {
        // Free to evaluate, so it never touches the cache or the queue.
        results.push({ mutantId: m.id, outcome: NO_COVERAGE });
        continue;
      }
      const fingerprint = hasher.fingerprint([m.file, ...filesFor(baseline, tests)], tests, shared);
      const key = mutantCacheKey(m, fingerprint, tests, env);
      const hit = cache.get(key);
      if (hit) {
        results.push({ mutantId: m.id, ...hit, cacheHit: true });
        continue;
      }
      const r = await runMutant(workdir, m, tests, mutantTimeoutMs(baseline, tests));
      results.push(r);
      cache.put(key, { outcome: r.outcome, killingTest: r.killingTest ?? null });
      progress(`[${i + 1}/${mutants.length}] ${m.file}:${m.line} ${m.operator} -> ${r.outcome}`);
    }
    cache.save();

    const { total, covered } = changedLineCoverage(baseline, changed, sources);
    const report = buildReport(meta, mutants, results, sources, total, covered);
    const outcomes = new Map(results.map((r) => [r.mutantId, r]));
    report.conformance = assess({
      analysis: analyzeChange({ workdir, changed, baseline }),
      mutants: mutants.map((m) => ({ mutantId: m.id, file: m.file, line: m.line, operator: m.operator,
        outcome: outcomes.get(m.id).outcome, diff: mutantDiff(sources.get(m.file), m) })),
      baseline,
    });
    report.baseline = {
      durationMs: baseline.durationMs, testFiles: baseline.testFiles.length, flaky: baseline.flaky,
    };
    report.durationMs = Date.now() - started;
    return report;
  } finally {
    cleanup(workdir);
  }
}
