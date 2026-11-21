// Every sample produces the outcome its sample.json declares, using the real
// engine and Vitest locally (no AWS). Slow (~1 minute): `npm run test:samples`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyLocal } from "proofline-engine";

import { DEPS_PROJECT, listSamples, makeSample } from "../src/samples.js";

const ready = existsSync(path.join(DEPS_PROJECT, "node_modules", "vitest"));

for (const sample of listSamples()) {
  test(`sample ${sample.name}: ${sample.expect.status} ${sample.expect.riskTier ?? ""}`, { skip: !ready && "run `npm run fixture:install` in engine/ first" }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), `proofline-sample-${sample.name}-`));
    const repo = path.join(root, sample.name);
    makeSample(sample.name, repo);
    symlinkSync(path.join(DEPS_PROJECT, "node_modules"), path.join(repo, "node_modules"), "junction");
    try {
      const report = await verifyLocal(repo, "HEAD~1", "HEAD");
      assert.equal(report.status, sample.expect.status, JSON.stringify(report).slice(0, 500));
      if (sample.expect.riskTier) assert.equal(report.riskTier, sample.expect.riskTier);
      if (sample.expect.mutationScore !== undefined) assert.equal(report.mutationScore, sample.expect.mutationScore);
      if (sample.expect.failures) assert.deepEqual(report.failures, sample.expect.failures);
      const c = report.conformance;
      if (sample.expect.conformance) {
        assert.equal(c.verdict, sample.expect.conformance.verdict, JSON.stringify(c.files));
        assert.equal(c.achievedLevel, sample.expect.conformance.achievedLevel, JSON.stringify(c.files));
      }
      console.log(`  ${sample.name}: ${report.status} ${report.riskTier ?? ""} score=${report.mutationScore ?? "-"} ` +
        `coverage=${report.changedLineCoverage ?? "-"} mutants=${JSON.stringify(report.mutants ?? {})}`);
      console.log(`    pvf: ${c.verdict} ${c.achievedLevel ?? ""} | ${c.files.map((f) => `${f.file} ${f.achievedLevel}/${f.requiredLevel}` +
        `${f.blocking.length ? ` blocked by ${f.blocking.join("; ")}` : ""}`).join(" | ")}` +
        `${c.findings.length ? ` | findings ${c.findings.map((f) => `${f.ruleId}${f.status === "deviated" ? "(deviated)" : ""}`).join(",")}` : ""}`);
    } finally {
      unlinkSync(path.join(repo, "node_modules"));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
