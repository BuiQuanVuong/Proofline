// PVF 1.0 rule catalogue and levels. Fixed per
// framework version: changing anything here means a new version identifier.

export const FRAMEWORK = "pvf/1.0";
export const DEFAULT_REQUIRED_LEVEL = 2;

export const CATEGORY = Object.freeze({ MANDATORY: "mandatory", REQUIRED: "required", ADVISORY: "advisory" });

const rule = (id, name, category, characteristic, extra = {}) => ({ id, name, category, characteristic, ...extra });

export const RULES = Object.freeze(Object.fromEntries([
  rule("PV-TEST-01", "Test suite passes at the head commit", CATEGORY.MANDATORY, "Functional suitability"),
  rule("PV-TEST-02", "Changed executable lines are executed by a test", CATEGORY.REQUIRED, "Functional suitability"),
  rule("PV-TEST-03", "Injected faults on changed lines are detected", CATEGORY.REQUIRED, "Functional suitability"),
  rule("PV-REL-01", "The test suite has no flaky tests", CATEGORY.REQUIRED, "Reliability: maturity", { scope: "job" }),
  rule("PV-REL-02", "No empty catch block", CATEGORY.ADVISORY, "Reliability: fault tolerance", { cwe: "CWE-1069" }),
  rule("PV-SEC-01", "No dynamic code evaluation of non-constant input", CATEGORY.REQUIRED, "Security: integrity", { cwe: "CWE-95" }),
  rule("PV-SEC-02", "No shell command built from non-constant input", CATEGORY.REQUIRED, "Security: integrity", { cwe: "CWE-78" }),
  rule("PV-SEC-03", "No hard-coded credentials", CATEGORY.MANDATORY, "Security: confidentiality", { cwe: "CWE-798" }),
  rule("PV-SEC-04", "No HTML sink fed non-constant input", CATEGORY.REQUIRED, "Security: integrity", { cwe: "CWE-79" }),
  rule("PV-MAINT-01", "Cyclomatic complexity of a changed function is at most 10", CATEGORY.REQUIRED, "Maintainability: analysability"),
  rule("PV-MAINT-02", "A changed function is at most 60 lines", CATEGORY.ADVISORY, "Maintainability: modifiability"),
  rule("PV-MAINT-03", "No debugging leftovers", CATEGORY.ADVISORY, "Maintainability"),
  rule("PV-MAINT-04", "No new TODO/FIXME/XXX/HACK comments", CATEGORY.ADVISORY, "Maintainability"),
].map((r) => [r.id, Object.freeze(r)])));

export const LIMITS = Object.freeze({
  complexity: 10,
  functionLines: 60,
  coverage: { 1: 0.8, 4: 1 },      // changed-line coverage needed at PV-1..3, and at PV-4
  mutationScore: { 2: 0.8, 4: 1 }, // mutation score needed at PV-2..3, and at PV-4
});

/** Rules whose active findings block each level (cumulative). Thresholds are checked separately. */
export const LEVEL_RULES = Object.freeze({
  1: ["PV-TEST-01", "PV-REL-01"],
  2: [],
  3: ["PV-SEC-01", "PV-SEC-02", "PV-SEC-04", "PV-MAINT-01"],
  4: [],
});

export const levelName = (n) => (n > 0 ? `PV-${n}` : "PV-0");

export function parseLevel(text) {
  const m = /^PV-([1-4])$/.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}
