import assert from "node:assert/strict";
import { test } from "node:test";

import { assess } from "../src/framework/assess.js";
import { complexity, staticFindings } from "../src/framework/checks.js";
import { globToRegExp, parseProfile, requiredLevelFor } from "../src/framework/profile.js";
import { toSarif } from "../src/framework/sarif.js";
import { parseSource } from "../src/mutate.js";

const all = (source) => new Set(source.split("\n").map((_, i) => i + 1));
const rules = (file, source, lines = all(source)) => staticFindings(file, source, lines).map((f) => `${f.ruleId}@${f.line}`);

// ------------------------------------------------------------------ checks

test("PV-SEC-01: dynamic evaluation, but not of constants", () => {
  const src = [
    "export const a = (x) => eval(x);",
    "export const b = () => eval('1 + 2');",
    "export const c = (body) => new Function('a', body);",
    "export const d = () => new Function('a', 'return a');",
    "export const e = (n) => setTimeout(`tick(${n})`, 10);",
    "export const f = (fn) => setTimeout(fn, 10);",
  ].join("\n");
  assert.deepEqual(rules("a.js", src).filter((r) => r.startsWith("PV-SEC-01")), ["PV-SEC-01@1", "PV-SEC-01@3", "PV-SEC-01@5"]);
});

test("PV-SEC-02: shell commands only in child_process modules (RegExp.exec is not a shell)", () => {
  const shell = [
    'import { execSync } from "node:child_process";',
    "export const log = (branch) => execSync(`git log ${branch}`);",
    'export const fixed = () => execSync("git status");',
  ].join("\n");
  assert.deepEqual(rules("a.js", shell).filter((r) => r.startsWith("PV-SEC-02")), ["PV-SEC-02@2"]);
  const regex = "export const m = (s) => /a(b)/.exec(s);\nexport const n = (re, s) => re.exec(s);";
  assert.deepEqual(rules("b.js", regex), []);
  const required = 'const cp = require("child_process");\nexports.run = (cmd) => cp.exec("ls " + cmd);';
  assert.deepEqual(rules("c.js", required).filter((r) => r.startsWith("PV-SEC-02")), ["PV-SEC-02@2"]);
});

test("PV-SEC-03: credentials by name and by token format, always redacted", () => {
  const src = [
    'const dbPassword = "hunter2-production";',
    'const apiKey = "changeme";',
    'const passwordHint = "first pet";',
    'const tokenCount = 12345678;',
    'const config = { clientSecret: "s3cr3t-value-9" };',
    "const header = `-----BEGIN RSA PRIVATE KEY-----`;",
  ].join("\n");
  const found = staticFindings("a.js", src, all(src)).filter((f) => f.ruleId === "PV-SEC-03");
  assert.deepEqual(found.map((f) => f.line), [1, 5, 6]);
  for (const f of found) {
    assert.equal(f.witness.kind, "secret");
    assert.ok(!JSON.stringify(f).includes("hunter2-production") && !JSON.stringify(f).includes("s3cr3t-value-9"));
  }
});

test("PV-SEC-04: HTML sinks with non-constant input", () => {
  const src = [
    "export function show(el, html) { el.innerHTML = html; }",
    "export function clear(el) { el.innerHTML = ''; }",
    "export function put(el, s) { el.insertAdjacentHTML('beforeend', s); }",
    "export function w(s) { document.write(s); }",
  ].join("\n");
  assert.deepEqual(rules("a.js", src).filter((r) => r.startsWith("PV-SEC-04")), ["PV-SEC-04@1", "PV-SEC-04@3", "PV-SEC-04@4"]);
});

test("advisory rules: empty catch, debugging leftovers, TODO markers", () => {
  const src = [
    "export function f(x) {",
    "  try { return JSON.parse(x); } catch {}",
    "  try { return JSON.parse(x); } catch { /* fall back to null */ }",
    "  debugger;",
    "  console.log(x);",
    "  console.error(x); // TODO remove",
    "  return null;",
    "}",
  ].join("\n");
  assert.deepEqual(rules("a.js", src).sort(), ["PV-MAINT-03@4", "PV-MAINT-03@5", "PV-MAINT-04@6", "PV-REL-02@2"].sort());
});

test("only changed lines are assessed", () => {
  const src = "export const a = (x) => eval(x);\nexport const b = (x) => eval(x);";
  assert.deepEqual(rules("a.js", src, new Set([2])), ["PV-SEC-01@2"]);
});

test("PV-MAINT-01: cyclomatic complexity counts decisions, not nested functions", () => {
  const fn = parseSource("a.js", [
    "function f(a, b) {",
    "  if (a && b) { return 1; }",
    "  for (const x of a) { if (x ?? b) continue; }",
    "  const g = () => { if (a) return 2; };",
    "  switch (b) { case 1: return 3; case 2: return 4; default: return 5; }",
    "}",
  ].join("\n")).program.body[0];
  // if, &&, for-of, if, ??, case 1, case 2  -> 1 + 7 (the arrow function's if is excluded)
  assert.equal(complexity(fn).value, 8);

  const big = `export function big(x) {\n${Array.from({ length: 11 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n")}\n  return -1;\n}`;
  const found = staticFindings("b.js", big, new Set([3])).filter((f) => f.ruleId === "PV-MAINT-01");
  assert.equal(found.length, 1);
  assert.equal(found[0].witness.value, 12);
  assert.equal(found[0].witness.decisionLines.length, 11);
});

test("TypeScript sources are checked; annotations are ignored", () => {
  const src = "export function run(code: string): unknown {\n  return eval(code);\n}";
  assert.deepEqual(rules("a.ts", src), ["PV-SEC-01@2"]);
});

// ----------------------------------------------------------------- profile

test("globs: * stays in a segment, ** crosses segments", () => {
  assert.ok(globToRegExp("src/auth/**").test("src/auth/a/b.js"));
  assert.ok(globToRegExp("src/**/*.js").test("src/x.js"));
  assert.ok(globToRegExp("src/*.js").test("src/x.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/a/x.js"));
  assert.ok(!globToRegExp("src/auth/**").test("src/authz/a.js"));
});

test("profile: strictest matching level wins; defaults to PV-2", () => {
  const { profile, errors } = parseProfile({ pvf: "1.0", requiredLevel: "PV-1",
    paths: [{ glob: "src/**", requiredLevel: "PV-2" }, { glob: "src/auth/**", requiredLevel: "PV-3" }] });
  assert.deepEqual(errors, []);
  assert.equal(requiredLevelFor(profile, "lib/a.js"), 1);
  assert.equal(requiredLevelFor(profile, "src/a.js"), 2);
  assert.equal(requiredLevelFor(profile, "src/auth/session.js"), 3);
  assert.equal(requiredLevelFor(parseProfile(null).profile, "x.js"), 2);
});

test("profile: invalid deviations are rejected and reported, never silently applied", () => {
  const { profile, errors } = parseProfile({ deviations: [
    { rule: "PV-SEC-03", paths: ["**"], justification: "test fixtures" },
    { rule: "PV-MAINT-01", paths: ["src/**"] },
    { rule: "PV-NOPE", paths: ["**"], justification: "x" },
    { rule: "PV-TEST-03", paths: ["a.js"], file: "a.js", line: 2, justification: "both scopes" },
    { rule: "PV-MAINT-01", paths: ["src/gen/**"], justification: "generated parser" },
  ] });
  assert.equal(profile.deviations.length, 1);
  assert.equal(errors.length, 4);
  assert.match(errors[0], /mandatory/);
  assert.match(errors[1], /justification/);
});

// ------------------------------------------------------------------ assess

const analysisOf = (files, findings = [], raw = null) => ({ profile: parseProfile(raw).profile, profileErrors: [], files, findings });
const mutant = (id, line, outcome, file = "src/a.js") => ({ mutantId: id, file, line, operator: "ROR_LT_TO_LTE", outcome, diff: "- a\n+ b" });

test("levels climb with evidence: PV-1 coverage, PV-2 mutation score, PV-3 security, PV-4 exhaustive", () => {
  const files = { "src/a.js": { changedStatements: 5, coveredStatements: 5, uncovered: [], tests: {} } };
  const killedAll = [1, 2, 3, 4, 5].map((n) => mutant(`m${n}`, n, "KILLED"));
  assert.equal(assess({ analysis: analysisOf(files), mutants: killedAll }).files[0].achievedLevel, "PV-4");

  const oneSurvivor = [...killedAll.slice(0, 4), mutant("m5", 5, "SURVIVED")]; // 0.8
  const r2 = assess({ analysis: analysisOf(files), mutants: oneSurvivor });
  assert.equal(r2.files[0].achievedLevel, "PV-3");
  assert.match(r2.files[0].blocking[0], /mutation score 0.8 < 1/);

  const weak = [...killedAll.slice(0, 3), mutant("m4", 4, "SURVIVED"), mutant("m5", 5, "SURVIVED")]; // 0.6
  assert.equal(assess({ analysis: analysisOf(files), mutants: weak }).files[0].achievedLevel, "PV-1");

  const evalFinding = { ruleId: "PV-SEC-01", file: "src/a.js", line: 2, column: 1, message: "eval", witness: {} };
  assert.equal(assess({ analysis: analysisOf(files, [evalFinding]), mutants: killedAll }).files[0].achievedLevel, "PV-2");

  const thin = { "src/a.js": { changedStatements: 5, coveredStatements: 3, uncovered: [{ line: 4, text: "" }, { line: 5, text: "" }], tests: {} } };
  assert.equal(assess({ analysis: analysisOf(thin), mutants: killedAll }).files[0].achievedLevel, "PV-0");
});

test("a mandatory finding caps the file at PV-0; a failed baseline is NOT_EVALUATED", () => {
  const files = { "src/a.js": { changedStatements: 1, coveredStatements: 1, uncovered: [], tests: {} } };
  const secret = { ruleId: "PV-SEC-03", file: "src/a.js", line: 1, column: 1, message: "secret", witness: {} };
  const r = assess({ analysis: analysisOf(files, [secret]), mutants: [mutant("m1", 1, "KILLED")] });
  assert.equal(r.files[0].achievedLevel, "PV-0");
  assert.equal(r.verdict, "FAIL");
  assert.match(r.files[0].blocking[0], /mandatory/);

  const failed = assess({ analysis: analysisOf(files), baseline: { passed: false, failures: ["t > x"] } });
  assert.equal(failed.verdict, "NOT_EVALUATED");
});

test("deviations: an equivalent mutant is excluded from the score but stays visible", () => {
  const files = { "src/range.js": { changedStatements: 2, coveredStatements: 2, uncovered: [], tests: { 2: ["test/r.test.js"] } } };
  const mutants = [mutant("m1", 2, "SURVIVED", "src/range.js"), mutant("m2", 3, "KILLED", "src/range.js")];
  const raw = { requiredLevel: "PV-4", deviations: [{ rule: "PV-TEST-03", file: "src/range.js", line: 2,
    operator: "ROR_LT_TO_LTE", justification: "equivalent mutant", approvedBy: "reviewer" }] };
  const r = assess({ analysis: analysisOf(files, [], raw), mutants });
  assert.equal(r.files[0].mutationScore, 1);
  assert.equal(r.files[0].achievedLevel, "PV-4");
  assert.equal(r.verdict, "PASS");
  assert.equal(r.deviations.length, 1);
  const f = r.findings.find((x) => x.ruleId === "PV-TEST-03");
  assert.equal(f.status, "deviated");
  assert.deepEqual(f.witness.tests, ["test/r.test.js"]);
});

test("the verdict compares each file with its own required level", () => {
  const files = {
    "src/auth/s.js": { changedStatements: 1, coveredStatements: 1, uncovered: [], tests: {} },
    "src/ui.js": { changedStatements: 1, coveredStatements: 1, uncovered: [], tests: {} },
  };
  const evalAuth = { ruleId: "PV-SEC-01", file: "src/auth/s.js", line: 1, column: 1, message: "eval", witness: {} };
  const raw = { paths: [{ glob: "src/auth/**", requiredLevel: "PV-3" }] };
  const r = assess({ analysis: analysisOf(files, [evalAuth], raw),
    mutants: [mutant("a", 1, "KILLED", "src/auth/s.js"), mutant("b", 1, "KILLED", "src/ui.js")] });
  const byFile = Object.fromEntries(r.files.map((f) => [f.file, f]));
  assert.equal(byFile["src/auth/s.js"].achievedLevel, "PV-2");
  assert.equal(byFile["src/auth/s.js"].meets, false);
  assert.equal(byFile["src/ui.js"].meets, true);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.achievedLevel, "PV-2");
});

test("SARIF: catalogue as rules, findings as results, deviations as suppressions", () => {
  const files = { "src/a.js": { changedStatements: 1, coveredStatements: 1, uncovered: [], tests: {} } };
  const raw = { deviations: [{ rule: "PV-SEC-01", paths: ["src/**"], justification: "sandboxed interpreter" }] };
  const evalFinding = { ruleId: "PV-SEC-01", file: "src/a.js", line: 3, column: 5, message: "eval", witness: { kind: "ast" } };
  const sarif = toSarif(assess({ analysis: analysisOf(files, [evalFinding], raw), mutants: [mutant("m", 1, "SURVIVED")] }));
  const run = sarif.runs[0];
  assert.equal(sarif.version, "2.1.0");
  assert.equal(run.tool.driver.rules.length, 13);
  const sec = run.results.find((r) => r.ruleId === "PV-SEC-01");
  assert.equal(sec.level, "error");
  assert.equal(sec.suppressions[0].justification, "sandboxed interpreter");
  assert.equal(sec.locations[0].physicalLocation.region.startLine, 3);
  assert.equal(run.tool.driver.rules[sec.ruleIndex].id, "PV-SEC-01");
  assert.equal(run.tool.driver.rules[sec.ruleIndex].properties.cwe, "CWE-95");
});
