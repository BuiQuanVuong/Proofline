// Unit tests for the pure parts of the services (no AWS).

import assert from "node:assert/strict";
import { test } from "node:test";

import { summarise } from "../src/aggregator.js";
import { changedFromJson, changedToJson, newJobId, shardId } from "../src/keys.js";
import { buildShards } from "../src/planner.js";

test("shards never mix files and respect the size cap", () => {
  const mutants = [
    ...Array.from({ length: 23 }, (_, i) => ({ id: `a${i}`, file: "src/a.js" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, file: "src/b.js" })),
  ];
  const shards = buildShards(mutants, 10);
  assert.deepEqual(shards.map((s) => s.mutants.length), [10, 10, 3, 4]);
  assert.ok(shards.every((s) => new Set(s.mutants.map((m) => m.file)).size === 1));
  assert.deepEqual(shards.map((s) => s.shardId), ["s_0001", "s_0002", "s_0003", "s_0004"]);
  assert.deepEqual(buildShards([]), []);
});

test("changed-line maps round-trip through JSON", () => {
  const changed = new Map([["src/a.js", new Set([9, 2, 5])]]);
  const json = changedToJson(changed);
  assert.deepEqual(json, { "src/a.js": [2, 5, 9] });
  assert.deepEqual(changedFromJson(JSON.parse(JSON.stringify(json))), new Map([["src/a.js", new Set([2, 5, 9])]]));
});

test("ids are well-formed and job ids sort by creation time", async () => {
  const a = newJobId();
  await new Promise((r) => setTimeout(r, 5));
  const b = newJobId();
  assert.match(a, /^j_[0-9a-z]+[0-9a-f]{6}$/);
  assert.ok(a.slice(0, -6) <= b.slice(0, -6));
  assert.equal(shardId(7), "s_0007");
});

test("summarise counts outcomes, scores, and lists survivors as evidence", () => {
  const job = { jobId: "j_x", repo: "local/demo", changedStatements: 6, coveredStatements: 5, createdAt: "t" };
  const item = (mutantId, line, outcome, cacheHit = false) =>
    ({ mutantId, file: "src/calc.js", line, operator: "OP", outcome, cacheHit, diff: "- a\n+ b" });
  const report = summarise(job, [
    item("m1", 6, "SURVIVED"), item("m2", 7, "KILLED", true), item("m3", 9, "SURVIVED"),
    item("m4", 10, "NO_COVERAGE"), item("m5", 12, "KILLED"), item("m6", 16, "TIMEOUT"),
  ]);
  assert.deepEqual(report.mutants, { total: 6, killed: 2, survived: 2, timeout: 1, noCoverage: 1, error: 0, cacheHits: 1, missing: 0 });
  assert.equal(report.partial, false);
  assert.equal(report.mutationScore, 0.5); // (2 killed + 1 timeout) / 6
  assert.equal(report.changedLineCoverage, 0.8333);
  assert.equal(report.riskTier, "HIGH");
  assert.deepEqual(report.evidence.map((e) => e.line), [6, 9, 10]);
  assert.deepEqual(report.errors, []);
});

test("a partial job counts the results its failed shards never produced", () => {
  const job = { jobId: "j_x", changedStatements: 4, coveredStatements: 4, mutantsTotal: 10, failedShards: new Set(["s_0002"]) };
  const items = Array.from({ length: 6 }, (_, i) =>
    ({ mutantId: `k${i}`, file: "src/a.js", line: i, outcome: "KILLED", diff: "" }));
  const report = summarise(job, items);
  assert.equal(report.mutants.missing, 4);
  assert.equal(report.partial, true);
  assert.deepEqual(report.failedShards, ["s_0002"]);
  assert.equal(report.riskTier, "INCONCLUSIVE"); // 4 of 10 planned mutants have no result
});

test("PVF assessment in the report; a partial job never passes", () => {
  const analysis = {
    profile: { requiredLevel: 2, paths: [], deviations: [], declared: false }, profileErrors: [],
    files: { "src/a.js": { changedStatements: 2, coveredStatements: 2, uncovered: [], tests: {} } }, findings: [],
  };
  const items = [1, 2].map((n) => ({ mutantId: `m${n}`, file: "src/a.js", line: n, operator: "OP", outcome: "KILLED", diff: "" }));
  const ok = summarise({ jobId: "j", changedStatements: 2, coveredStatements: 2, mutantsTotal: 2 }, items, analysis);
  assert.equal(ok.conformance.verdict, "PASS");
  assert.equal(ok.conformance.achievedLevel, "PV-4");

  const partial = summarise({ jobId: "j", changedStatements: 2, coveredStatements: 2, mutantsTotal: 4,
    failedShards: new Set(["s_0002"]) }, items, analysis);
  assert.equal(partial.conformance.verdict, "FAIL");
  assert.match(partial.conformance.note, /partial/);
  assert.equal(summarise({ jobId: "j" }, items).conformance, null);
});

test("mostly-errored jobs are INCONCLUSIVE, not HIGH risk with score 0", () => {
  const job = { jobId: "j_x", changedStatements: 6, coveredStatements: 5 };
  const items = [
    ...Array.from({ length: 7 }, (_, i) => ({ mutantId: `e${i}`, file: "src/calc.js", line: i, outcome: "ERROR", detail: "no test report" })),
    { mutantId: "n", file: "src/calc.js", line: 10, outcome: "NO_COVERAGE", diff: "" },
  ];
  const report = summarise(job, items);
  assert.equal(report.riskTier, "INCONCLUSIVE");
  assert.equal(report.errors.length, 5);
  assert.equal(report.errors[0].detail, "no test report");
});
