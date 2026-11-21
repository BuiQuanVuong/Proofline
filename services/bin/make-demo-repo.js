#!/usr/bin/env node
// Builds a throwaway two-commit git repository from the engine's fixture
// project: the base commit has only add(), the head commit adds clamp() and
// isAdult() with deliberately weak tests.
//
//   node services/bin/make-demo-repo.js <dir>

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../engine/test/fixture-project");

/**
 * With `salt`, a unique comment is appended to the head version of calc.js.
 * That changes every content hash, so no cached result applies: the job
 * really executes every mutant (useful for testing workers and scaling).
 */
export function makeDemoRepo(dir, { salt = null } = {}) {
  if (existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is already a git repository`);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "test"), { recursive: true });
  git("init", "-q");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "proofline demo");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  copyFileSync(path.join(FIXTURE, "package.json"), path.join(dir, "package.json"));
  copyFileSync(path.join(FIXTURE, "package-lock.json"), path.join(dir, "package-lock.json"));
  writeFileSync(path.join(dir, "src", "calc.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(path.join(dir, "test", "calc.test.js"),
    'import { expect, it } from "vitest";\nimport { add } from "../src/calc.js";\n\nit("adds", () => {\n  expect(add(2, 3)).toBe(5);\n});\n');
  git("add", "-A");
  git("commit", "-q", "-m", "base: add()");
  for (const f of ["src/calc.js", "test/calc.test.js"]) copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  if (salt) appendFileSync(path.join(dir, "src", "calc.js"), `// run ${salt}\n`);
  git("commit", "-q", "-am", "head: clamp() and isAdult() with weak tests");
  return { base: git("rev-parse", "HEAD~1"), head: git("rev-parse", "HEAD") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: make-demo-repo.js <dir> [--fresh]");
    process.exit(1);
  }
  const salt = process.argv.includes("--fresh") ? Date.now().toString(36) : null;
  const { base, head } = makeDemoRepo(path.resolve(dir), { salt });
  console.log(`demo repo at ${path.resolve(dir)}\n  base ${base}\n  head ${head}`);
}
