// End-to-end test on a throwaway git repository with known weak tests.
// Uses test/fixture-project (head state, with vitest installed) as its source.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyLocal } from "../src/pipeline.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-project");
const BASE_CALC = "export function add(a, b) {\n  return a + b;\n}\n";
const BASE_TEST = `import { expect, it } from "vitest";
import { add } from "../src/calc.js";

it("adds", () => {
  expect(add(2, 3)).toBe(5);
});
`;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ready = existsSync(path.join(FIXTURE, "node_modules", "vitest"));
let tmp;
let repo;

before(() => {
  if (!ready) return;
  tmp = mkdtempSync(path.join(os.tmpdir(), "proofline-test-"));
  repo = path.join(tmp, "fixture");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, "test"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  copyFileSync(path.join(FIXTURE, "package.json"), path.join(repo, "package.json"));
  symlinkSync(path.join(FIXTURE, "node_modules"), path.join(repo, "node_modules"), "junction");
  writeFileSync(path.join(repo, "src", "calc.js"), BASE_CALC);
  writeFileSync(path.join(repo, "test", "calc.test.js"), BASE_TEST);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  for (const f of ["src/calc.js", "test/calc.test.js"]) copyFileSync(path.join(FIXTURE, f), path.join(repo, f));
  git(repo, "commit", "-q", "-am", "head");
});

after(() => {
  if (!tmp) return;
  unlinkSync(path.join(repo, "node_modules"));
  rmSync(tmp, { recursive: true, force: true });
});

const outcomes = (report) => Object.fromEntries(report.evidence.map((e) => [`${e.line}:${e.operator}`, e.outcome]));

test("end to end: finds the known weaknesses, then reuses cached results", { skip: !ready && "run `npm run fixture:install` first" }, async () => {
  const cachePath = path.join(tmp, "cache.json");
  const report = await verifyLocal(repo, "HEAD~1", "HEAD", { cachePath });

  assert.equal(report.status, "DONE", JSON.stringify(report));
  const found = outcomes(report);
  // No test uses x === lo or x === hi, so both boundaries survive.
  assert.equal(found["6:ROR_LT_TO_LTE"], "SURVIVED");
  assert.equal(found["9:ROR_GT_TO_GTE"], "SURVIVED");
  // The `return hi` branch is never executed by any test.
  assert.equal(found["10:RVR_TO_UNDEFINED"], "NO_COVERAGE");
  // 18 itself is never tested.
  assert.equal(found["16:ROR_GTE_TO_GT"], "SURVIVED");
  assert.equal(found["16:CRP_NUM_INCREMENT"], "SURVIVED");
  // Unchanged line 2 (`add`) is out of scope.
  assert.ok(report.evidence.every((e) => e.line !== 2));
  assert.equal(report.mutants.killed, 3);
  assert.equal(report.mutants.cacheHits, 0);
  assert.equal(report.riskTier, "HIGH");

  const rerun = await verifyLocal(repo, "HEAD~1", "HEAD", { cachePath });
  assert.equal(rerun.mutants.cacheHits, rerun.mutants.total - rerun.mutants.noCoverage);
  assert.equal(rerun.mutationScore, report.mutationScore);
});

test("a failing baseline stops before any mutants run", { skip: !ready }, async () => {
  const testFile = path.join(repo, "test", "calc.test.js");
  const original = readFileSync(testFile, "utf8");
  writeFileSync(testFile, original + '\nit("is broken", () => {\n  expect(1).toBe(2);\n});\n');
  git(repo, "commit", "-q", "-am", "break");
  try {
    const report = await verifyLocal(repo, "HEAD~2", "HEAD");
    assert.equal(report.status, "BASELINE_FAILED");
    assert.deepEqual(report.failures, ["test/calc.test.js > is broken"]);
  } finally {
    git(repo, "reset", "-q", "--hard", "HEAD~1");
  }
});
