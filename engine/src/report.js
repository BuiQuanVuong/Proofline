// Scoring, risk tiering and report assembly.

import { KILLED, NO_COVERAGE, SURVIVED, TIMEOUT } from "./execute.js";
import { mutantDiff } from "./mutate.js";

// Paths where weak tests are treated as higher risk. Placeholder list, to be
// calibrated by the backtest.
const SENSITIVE = new Set(["auth", "security", "crypto", "payment", "payments", "billing", "session"]);

export function mutationScore(results) {
  const killed = results.filter((r) => r.outcome === KILLED || r.outcome === TIMEOUT).length;
  const scored = results.filter((r) => [KILLED, TIMEOUT, SURVIVED, NO_COVERAGE].includes(r.outcome)).length;
  return scored ? Math.round((killed / scored) * 1e4) / 1e4 : null;
}

/** Transparent rule-based tier. Thresholds are initial values, not calibrated. */
export function riskTier(score, coverage, files) {
  if (score === null) return "UNKNOWN";
  const sensitive = files.some((f) =>
    f.split("/").some((part) => SENSITIVE.has(part.replace(/\.[^.]+$/, "").toLowerCase())));
  const cov = coverage ?? 0;
  if (score < 0.6 || cov < 0.5 || (sensitive && score < 0.8)) return "HIGH";
  if (score >= 0.85 && cov >= 0.8) return "LOW";
  return "MEDIUM";
}

const COUNT_KEY = { KILLED: "killed", SURVIVED: "survived", TIMEOUT: "timeout", NO_COVERAGE: "noCoverage" };

export function buildReport(meta, mutants, results, sources, changedStatements, coveredStatements) {
  const byId = new Map(results.map((r) => [r.mutantId, r]));
  const counts = { total: 0, killed: 0, survived: 0, timeout: 0, noCoverage: 0, error: 0, cacheHits: 0 };
  const evidence = [];

  for (const m of mutants) {
    const r = byId.get(m.id);
    counts.total++;
    if (r.cacheHit) counts.cacheHits++;
    counts[COUNT_KEY[r.outcome] ?? "error"]++;
    if (r.outcome === SURVIVED || r.outcome === NO_COVERAGE) {
      evidence.push({
        mutantId: m.id, file: m.file, line: m.line, operator: m.operator, outcome: r.outcome,
        diff: mutantDiff(sources.get(m.file), m),
      });
    }
  }

  const coverage = changedStatements ? Math.round((coveredStatements / changedStatements) * 1e4) / 1e4 : null;
  const score = mutationScore(results);
  return {
    ...meta,
    status: "DONE",
    changedStatements,
    changedLineCoverage: coverage,
    mutants: counts,
    mutationScore: score,
    riskTier: riskTier(score, coverage, [...new Set(mutants.map((m) => m.file))]),
    evidence,
    results,
  };
}
