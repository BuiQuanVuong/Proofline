// Baseline and mutant execution against a working copy of the target repo.
//
// This module is the only part of the engine that runs repository code, so in
// the cloud it runs only inside test-runner containers.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyMutant } from "./mutate.js";

export const KILLED = "KILLED";
export const SURVIVED = "SURVIVED";
export const TIMEOUT = "TIMEOUT";
export const NO_COVERAGE = "NO_COVERAGE";
export const ERROR = "ERROR";

const OUTPUT_LIMIT = 64 * 1024;

/** Run a command, killing its whole process tree on timeout. Resolves { code, output }. */
export function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: process.platform !== "win32", windowsHide: true });
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, output });
    });
  });
}

function vitestBin(workdir) {
  return path.join(workdir, "node_modules", "vitest", "vitest.mjs");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const rel = (workdir, file) => path.relative(workdir, path.resolve(file)).split(path.sep).join("/");

async function vitest(workdir, args, timeoutMs) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "proofline-"));
  const outputFile = path.join(tmp, "report.json");
  try {
    const { code, output } = await run(process.execPath, [
      vitestBin(workdir), "run", ...args, "--reporter=json", `--outputFile=${outputFile}`,
    ], { cwd: workdir, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, timeoutMs });
    return { code, output, report: readJson(outputFile) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Per-test outcomes keyed by "file > full test name". */
function outcomes(workdir, report) {
  const result = new Map();
  for (const suite of report?.testResults ?? []) {
    const file = rel(workdir, suite.name);
    for (const t of suite.assertionResults) result.set(`${file} > ${t.fullName}`, t.status);
    if (suite.status === "failed" && suite.assertionResults.length === 0) {
      result.set(`${file} > (suite)`, "failed");
    }
  }
  return result;
}

/**
 * Lines covered per source file, from an Istanbul coverage map. Each line takes
 * the count of the innermost statement containing it, so a multi-line `if`
 * doesn't mark its unexecuted branch as covered.
 */
function coveredLines(workdir, coverageMap) {
  const result = new Map();
  for (const [file, data] of Object.entries(coverageMap ?? {})) {
    const statements = Object.entries(data.statementMap)
      .map(([id, s]) => ({ start: s.start.line, end: s.end.line ?? s.start.line, hit: data.s[id] > 0 }))
      .sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const lines = new Map();
    for (const s of statements) for (let l = s.start; l <= s.end; l++) lines.set(l, s.hit);
    result.set(rel(workdir, file), new Set([...lines].filter(([, hit]) => hit).map(([l]) => l)));
  }
  return result;
}

async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run the full suite twice (flaky detection), then each test file on its own
 * with V8 coverage to build a line -> test files map.
 */
export async function runBaseline(workdir, { timeoutMs = 15 * 60_000, concurrency = Math.max(1, os.availableParallelism() - 1) } = {}) {
  const started = Date.now();
  const first = await vitest(workdir, [], timeoutMs);
  const second = await vitest(workdir, [], timeoutMs);
  const a = outcomes(workdir, first.report);
  const b = outcomes(workdir, second.report);

  const flaky = new Set([...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)));
  const failures = [...a].filter(([k, s]) => s === "failed" && !flaky.has(k)).map(([k]) => k).sort();
  const flakyFiles = new Set([...flaky].map((k) => k.split(" > ")[0]));

  const testFiles = (first.report?.testResults ?? []).map((s) => ({
    file: rel(workdir, s.name),
    durationMs: Math.max(1, (s.endTime ?? 0) - (s.startTime ?? 0)),
  }));

  // file -> line -> [test files]
  const testsByLine = {};
  if (first.report && failures.length === 0) {
    const covTmp = mkdtempSync(path.join(os.tmpdir(), "proofline-cov-"));
    try {
      await pool(testFiles.filter((t) => !flakyFiles.has(t.file)), concurrency, async ({ file }, i) => {
        const { report } = await vitest(workdir, [
          file, "--coverage.enabled=true", "--coverage.provider=v8", "--coverage.reporter=json",
          `--coverage.reportsDirectory=${path.join(covTmp, String(i))}`,
        ], timeoutMs);
        for (const [source, lines] of coveredLines(workdir, report?.coverageMap)) {
          testsByLine[source] ??= {};
          for (const line of lines) (testsByLine[source][line] ??= []).push(file);
        }
      });
    } finally {
      rmSync(covTmp, { recursive: true, force: true });
    }
    for (const lines of Object.values(testsByLine)) for (const l in lines) lines[l].sort();
  }

  return {
    passed: Boolean(first.report) && first.code !== null && failures.length === 0 && testFiles.length > 0,
    failures,
    flaky: [...flaky].sort(),
    testFiles,
    testsByLine,
    durationMs: Date.now() - started,
    output: first.report ? "" : first.output,
  };
}

/** Test files that execute `line` of `file`, fastest first. */
export function testsFor(baseline, file, line) {
  const tests = baseline.testsByLine[file]?.[line] ?? [];
  const duration = new Map(baseline.testFiles.map((t) => [t.file, t.durationMs]));
  return [...tests].sort((x, y) => (duration.get(x) ?? 0) - (duration.get(y) ?? 0));
}

/** Source files executed by any of `tests` in the baseline. */
export function filesFor(baseline, tests) {
  const wanted = new Set(tests);
  return Object.entries(baseline.testsByLine)
    .filter(([, lines]) => Object.values(lines).some((ts) => ts.some((t) => wanted.has(t))))
    .map(([file]) => file);
}

/** Timeout scaled from the baseline durations of the selected test files. */
export function mutantTimeoutMs(baseline, tests, { factor = 3, overheadMs = 15_000 } = {}) {
  const duration = new Map(baseline.testFiles.map((t) => [t.file, t.durationMs]));
  return factor * tests.reduce((sum, t) => sum + (duration.get(t) ?? 1000), 0) + overheadMs;
}

/** Apply one mutant in place, run the selected test files, then restore the file. */
export async function runMutant(workdir, mutant, tests, timeoutMs) {
  if (tests.length === 0) return { mutantId: mutant.id, outcome: NO_COVERAGE };

  const file = path.join(workdir, mutant.file);
  const original = readFileSync(file, "utf8");
  const started = Date.now();
  let result;
  try {
    writeFileSync(file, applyMutant(original, mutant));
    result = await vitest(workdir, [...tests, "--bail=1", "--coverage.enabled=false"], timeoutMs);
  } finally {
    writeFileSync(file, original);
  }

  const base = { mutantId: mutant.id, durationMs: Date.now() - started, testsRun: tests.length };
  const { code, report, output } = result;
  // An ERROR is an infrastructure problem, not evidence, so keep the output tail for diagnosis.
  const error = (reason) => ({ ...base, outcome: ERROR, detail: `${reason}: ${output.trim().slice(-600)}` });
  if (code === null) return { ...base, outcome: TIMEOUT };
  if (!report) return error(`no test report (exit ${code})`);
  // A failed suite (e.g. the mutant broke module loading) also counts as a kill.
  if (report.numFailedTests > 0 || report.numFailedTestSuites > 0 || report.success === false) {
    const killer = [...outcomes(workdir, report)].find(([, s]) => s === "failed")?.[0] ?? null;
    return { ...base, outcome: KILLED, killingTest: killer };
  }
  return code === 0 ? { ...base, outcome: SURVIVED } : error(`exit ${code} with a passing report`);
}
