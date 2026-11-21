// PVF assessment: findings + mutant results ->
// per-file achieved and required levels -> verdict. Pure.

import { deviationFor, requiredLevelFor } from "./profile.js";
import { CATEGORY, FRAMEWORK, LEVEL_RULES, LIMITS, RULES, levelName } from "./rules.js";

const KILLED = new Set(["KILLED", "TIMEOUT"]);
const UNDETECTED = new Set(["SURVIVED", "NO_COVERAGE"]);
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** TEST-02 and TEST-03 findings derived from coverage and mutant results. */
function derivedFindings(analysis, mutants) {
  const findings = [];
  for (const [file, entry] of Object.entries(analysis.files)) {
    for (const { line, text } of entry.uncovered) {
      findings.push({
        ruleId: "PV-TEST-02", file, line, column: 1, message: "changed line not executed by any test",
        witness: { kind: "coverage", snippet: text, note: "no test file executed this line in the baseline coverage run" },
      });
    }
  }
  for (const m of mutants) {
    if (!UNDETECTED.has(m.outcome)) continue;
    findings.push({
      ruleId: "PV-TEST-03", file: m.file, line: m.line, column: 1,
      message: m.outcome === "SURVIVED" ? `injected fault ${m.operator} survived every test` : `injected fault ${m.operator} on a line no test runs`,
      witness: { kind: "mutant", mutantId: m.mutantId, operator: m.operator, outcome: m.outcome, diff: m.diff,
        tests: analysis.files[m.file]?.tests?.[m.line] ?? [] },
    });
  }
  return findings;
}

/**
 * `analysis`: from analyzeChange. `mutants`: [{ mutantId, file, line, operator, outcome, diff }].
 * `baseline`: { passed, failures }.
 */
export function assess({ analysis, mutants = [], baseline = { passed: true, failures: [] } }) {
  const { profile } = analysis;
  if (!baseline.passed) {
    const failures = baseline.failures ?? [];
    return {
      framework: FRAMEWORK, verdict: "NOT_EVALUATED", achievedLevel: levelName(0), files: [],
      findings: [{ ruleId: "PV-TEST-01", file: null, line: null, column: null, category: CATEGORY.MANDATORY,
        status: "active", message: "test suite fails at the head commit", witness: { kind: "test-failure", tests: failures } }],
      deviations: [], profileErrors: analysis.profileErrors ?? [],
    };
  }

  const findings = [...analysis.findings, ...derivedFindings(analysis, mutants)].map((f) => {
    const deviation = RULES[f.ruleId].category === CATEGORY.MANDATORY ? null : deviationFor(profile, f);
    return { ...f, category: RULES[f.ruleId].category, status: deviation ? "deviated" : "active",
      ...(deviation ? { deviation: { justification: deviation.justification, approvedBy: deviation.approvedBy } } : {}) };
  });
  const active = findings.filter((f) => f.status === "active");
  const jobWide = active.filter((f) => RULES[f.ruleId].scope === "job");
  const pathDeviated = (ruleId, file) => profile.deviations.some((d) => d.rule === ruleId && d.paths &&
    deviationFor({ deviations: [d] }, { ruleId, file }));

  const files = Object.entries(analysis.files).map(([file, entry]) => {
    const own = active.filter((f) => f.file === file);
    const ownDeviated = findings.filter((f) => f.file === file && f.status === "deviated");

    // Coverage over changed statements, with individually deviated lines removed.
    const deviatedLines = ownDeviated.filter((f) => f.ruleId === "PV-TEST-02").length;
    const denominator = entry.changedStatements - deviatedLines;
    const coverage = pathDeviated("PV-TEST-02", file) || denominator <= 0 ? 1 : round4(entry.coveredStatements / denominator);

    // Mutation score over this file's mutants, deviated survivors removed, errors excluded.
    const fileMutants = mutants.filter((m) => m.file === file);
    const killed = fileMutants.filter((m) => KILLED.has(m.outcome)).length;
    const undetected = own.filter((f) => f.ruleId === "PV-TEST-03").length;
    const score = pathDeviated("PV-TEST-03", file) || killed + undetected === 0 ? 1 : round4(killed / (killed + undetected));

    const mandatory = own.filter((f) => f.category === CATEGORY.MANDATORY);
    const blockingRules = (level) => [...own, ...jobWide].filter((f) => LEVEL_RULES[level].includes(f.ruleId));
    const checks = {
      1: [
        ...(coverage < LIMITS.coverage[1] ? [`PV-TEST-02: changed-line coverage ${coverage} < ${LIMITS.coverage[1]}`] : []),
        ...blockingRules(1).map((f) => `${f.ruleId}: ${f.message}`),
      ],
      2: score < LIMITS.mutationScore[2] ? [`PV-TEST-03: mutation score ${score} < ${LIMITS.mutationScore[2]}`] : [],
      3: blockingRules(3).map((f) => `${f.ruleId}: ${f.message} (line ${f.line})`),
      4: [
        ...(coverage < LIMITS.coverage[4] ? [`PV-TEST-02: changed-line coverage ${coverage} < ${LIMITS.coverage[4]}`] : []),
        ...(score < LIMITS.mutationScore[4] ? [`PV-TEST-03: mutation score ${score} < ${LIMITS.mutationScore[4]}`] : []),
      ],
    };
    let achieved = 0;
    if (mandatory.length === 0) {
      while (achieved < 4 && checks[achieved + 1].length === 0) achieved++;
    }
    const required = requiredLevelFor(profile, file);
    return {
      file, requiredLevel: levelName(required), achievedLevel: levelName(achieved), meets: achieved >= required,
      coverage, mutationScore: score, mutants: fileMutants.length,
      blocking: mandatory.length
        ? mandatory.map((f) => `${f.ruleId} (mandatory): ${f.message} (line ${f.line})`)
        : achieved < 4 ? checks[achieved + 1] : [],
    };
  }).sort((a, b) => a.file.localeCompare(b.file));

  const lowest = files.length ? Math.min(...files.map((f) => Number(f.achievedLevel.slice(3)))) : null;
  return {
    framework: FRAMEWORK,
    verdict: files.every((f) => f.meets) ? "PASS" : "FAIL",
    achievedLevel: lowest === null ? null : levelName(lowest),
    files,
    findings,
    summary: Object.fromEntries(Object.values(CATEGORY).map((c) => [c, active.filter((f) => f.category === c).length])),
    deviations: findings.filter((f) => f.status === "deviated").map((f) => ({ ruleId: f.ruleId, file: f.file, line: f.line, ...f.deviation })),
    profileErrors: analysis.profileErrors ?? [],
    profileDeclared: Boolean(profile.declared),
  };
}
