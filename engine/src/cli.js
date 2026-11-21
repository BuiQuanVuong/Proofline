#!/usr/bin/env node
// proofline-local: verify a commit range of a local git repository.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { verifyLocal } from "./pipeline.js";

const USAGE = `usage: proofline-local <repo> <base-rev> <head-rev> [--out report.json] [--cache file | --no-cache] [-q]

The repo must use Vitest, with vitest and @vitest/coverage-v8 installed.`;

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      cache: { type: "string", default: ".proofline-cache/results.json" },
      "no-cache": { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 3) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const [repo, base, head] = positionals;
  const progress = values.quiet ? () => {} : (msg) => console.error(`  ${msg}`);
  const report = await verifyLocal(path.resolve(repo), base, head, {
    cachePath: values["no-cache"] ? null : path.resolve(values.cache),
    progress,
  });

  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));

  if (report.status !== "DONE") {
    console.log(`${report.status}: ${report.failures?.join(", ") || "see output"}`);
    console.log(report.output ?? "");
    return 2;
  }

  const m = report.mutants;
  console.log(`
Risk tier:             ${report.riskTier}
Mutation score:        ${report.mutationScore}
Changed-line coverage: ${report.changedLineCoverage ?? "n/a"}
Mutants:               ${m.total} total, ${m.killed} killed, ${m.survived} survived, ${m.noCoverage} uncovered, ${m.timeout} timeout, ${m.error} error, ${m.cacheHits} from cache
Duration:              ${(report.durationMs / 1000).toFixed(1)}s`);
  const c = report.conformance;
  if (c) {
    console.log(`PVF 1.0 verdict:       ${c.verdict}${c.achievedLevel ? `  (lowest level achieved: ${c.achievedLevel})` : ""}`);
    for (const f of c.files) {
      console.log(`  ${f.meets ? "meets" : "BELOW"}  ${f.file}  achieved ${f.achievedLevel}, required ${f.requiredLevel}` +
        `${f.blocking.length ? `; next level needs: ${f.blocking[0]}` : ""}`);
    }
  }
  for (const e of report.evidence) {
    console.log(`\n  ${e.outcome}  ${e.file}:${e.line}  ${e.operator}`);
    console.log("    " + e.diff.replace("\n", "\n    "));
  }
  return 0;
}

process.exitCode = await main();
