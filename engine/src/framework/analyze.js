// Everything PVF needs about a change that doesn't require running mutants:
// the profile, per-file changed-line coverage (with the tests covering each
// line), static findings and flaky tests. Static and read-only, so the
// planner can compute it; the aggregator combines it with mutant results.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isSourcePath, isTestPath } from "../diff.js";
import { testsFor } from "../execute.js";
import { statementLines } from "../mutate.js";
import { staticFindings } from "./checks.js";
import { PROFILE_FILE, parseProfile } from "./profile.js";
import { FRAMEWORK } from "./rules.js";

function readProfile(workdir) {
  const file = path.join(workdir, PROFILE_FILE);
  if (!existsSync(file)) return parseProfile(null);
  try {
    return parseProfile(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    const { profile } = parseProfile(null);
    return { profile, errors: [`${PROFILE_FILE} is not valid JSON (${err.message}); defaults apply`] };
  }
}

/** `changed`: Map<file, Set<line>>. `baseline`: the runner's baseline result. */
export function analyzeChange({ workdir, changed, baseline }) {
  const { profile, errors } = readProfile(workdir);
  const files = {};
  const findings = [];

  for (const [file, lines] of changed) {
    if (!isSourcePath(file) || isTestPath(file) || !existsSync(path.join(workdir, file))) continue;
    const source = readFileSync(path.join(workdir, file), "utf8");
    const sourceLines = source.split(/\r?\n/);
    const statements = statementLines(file, source);
    const entry = { changedStatements: 0, coveredStatements: 0, uncovered: [], tests: {} };
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (!statements.has(line)) continue;
      entry.changedStatements++;
      const tests = testsFor(baseline, file, line);
      if (tests.length) {
        entry.coveredStatements++;
        entry.tests[line] = tests;
      } else {
        entry.uncovered.push({ line, text: (sourceLines[line - 1] ?? "").trim().slice(0, 160) });
      }
    }
    files[file] = entry;
    findings.push(...staticFindings(file, source, lines));
  }

  // Job-wide: a flaky test undermines every result that test selection relies on.
  for (const key of baseline.flaky ?? []) {
    const [testFile, ...name] = key.split(" > ");
    findings.push({
      ruleId: "PV-REL-01", file: testFile, line: 1, column: 1, message: `flaky test: ${name.join(" > ")}`,
      witness: { kind: "flaky", test: key, note: "different outcomes in two identical runs of the baseline" },
    });
  }
  return { framework: FRAMEWORK, profile, profileErrors: errors, files, findings };
}
