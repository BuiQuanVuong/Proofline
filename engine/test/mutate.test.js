import assert from "node:assert/strict";
import { test } from "node:test";

import { MutantMismatch, applyMutant, generateMutants, mutantDiff, parseSource, statementLines } from "../src/mutate.js";

const SOURCE = `"use strict";
import { log } from "./log.js";

export function clamp(x, lo = 0, hi = 10) {
  if (x < lo) {
    return lo;
  }
  if (x > hi && !strict) {
    return hi;
  }
  let total = x + 1;
  total += 2;
  log(\`clamped \${total * 2}\`);
  return total;
}
`;

const ops = (mutants) => new Set(mutants.map((m) => `${m.line}:${m.operator}`));

test("generates the expected operators", () => {
  const found = ops(generateMutants("calc.js", SOURCE));
  for (const expected of [
    "5:ROR_LT_TO_LTE", "6:RVR_TO_UNDEFINED", "8:ROR_GT_TO_GTE", "8:LCR_AND_TO_OR", "8:NOT_DROP",
    "11:AOR_ADD_TO_SUB", "11:CRP_NUM_INCREMENT", "12:SDL_UPDATE", "13:SDL_CALL", "14:RVR_TO_UNDEFINED",
    "4:CRP_NUM_INCREMENT",
  ]) {
    assert.ok(found.has(expected), `missing ${expected}`);
  }
});

test("skips directives, imports, strings and template literals", () => {
  const mutants = generateMutants("calc.js", SOURCE);
  assert.ok(mutants.every((m) => m.line !== 1 && m.line !== 2));
  // `total * 2` inside the template literal is not mutated.
  assert.ok(!mutants.some((m) => m.line === 13 && m.operator.startsWith("AOR")));
});

test("only changed lines", () => {
  const mutants = generateMutants("calc.js", SOURCE, new Set([5]));
  assert.ok(mutants.length > 0 && mutants.every((m) => m.line === 5));
});

test("every mutant applies and parses", () => {
  for (const m of generateMutants("calc.js", SOURCE)) {
    const mutated = applyMutant(SOURCE, m);
    assert.notEqual(mutated, SOURCE);
    parseSource("calc.js", mutated);
  }
});

test("splice preserves the rest of the file", () => {
  const m = generateMutants("calc.js", SOURCE).find((x) => x.operator === "ROR_LT_TO_LTE");
  const mutated = applyMutant(SOURCE, m);
  assert.ok(mutated.includes("  if (((x) <= (lo))) {\n"));
  assert.equal(mutated.replace("((x) <= (lo))", "x < lo"), SOURCE);
  assert.equal(mutantDiff(SOURCE, m), "- if (x < lo) {\n+ if (((x) <= (lo))) {");
});

test("guards against ASI hazards at the start of a listed statement", () => {
  const source = "const a = f\nx < y && g();\n";
  const m = generateMutants("a.js", source, new Set([2])).find((x) => x.operator === "ROR_LT_TO_LTE");
  const mutated = applyMutant(source, m);
  assert.equal(mutated, "const a = f\n;((x) <= (y)) && g();\n");
  // Without the leading ";" this would parse as `f((x) <= (y))`.
  const body = parseSource("a.js", mutated).program.body;
  assert.equal(body[0].declarations[0].init.type, "Identifier");
});

test("TypeScript: type-only code is skipped, runtime code inside TS nodes is mutated", () => {
  const source = [
    "type Limit = 1 | 2;",
    "interface Box { size: 3 }",
    "export function f(n: number = 4): boolean {",
    "  return (n as number) > 5;",
    "}",
  ].join("\n");
  const mutants = generateMutants("f.ts", source);
  assert.ok(mutants.every((m) => m.line >= 3));
  assert.ok(ops(mutants).has("3:CRP_NUM_INCREMENT"));
  assert.ok(ops(mutants).has("4:ROR_GT_TO_GTE"));
});

test("non-ASCII text before the mutation", () => {
  const source = 'const label = "café 🙂"; const ok = n < 3;\n';
  const m = generateMutants("u.js", source).find((x) => x.operator === "ROR_LT_TO_LTE");
  assert.equal(applyMutant(source, m), 'const label = "café 🙂"; const ok = ((n) <= (3));\n');
});

test("ids are stable and unique", () => {
  const a = generateMutants("calc.js", SOURCE).map((m) => m.id);
  const b = generateMutants("calc.js", SOURCE).map((m) => m.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
});

test("stale descriptors are rejected", () => {
  const [m] = generateMutants("calc.js", SOURCE, new Set([5]));
  assert.throws(() => applyMutant(SOURCE.replace("x < lo", "x == lo"), m), MutantMismatch);
});

test("statement lines exclude declarations and imports", () => {
  const lines = statementLines("calc.js", SOURCE);
  assert.ok(lines.has(5) && lines.has(6) && lines.has(11) && lines.has(14));
  assert.ok(!lines.has(2) && !lines.has(4));
});
