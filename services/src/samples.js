// Sample repositories with known outcomes (samples/<name>/{base,head,sample.json}).
// Each becomes a two-commit git repo: base, then head overlaid on it. All use
// the registered repo's dependencies (engine/test/fixture-project), which is
// what the runner image has installed.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(here, "../../samples");
export const DEPS_PROJECT = path.resolve(here, "../../engine/test/fixture-project");

export function listSamples() {
  return readdirSync(SAMPLES_DIR)
    .filter((name) => existsSync(path.join(SAMPLES_DIR, name, "sample.json")))
    .sort()
    .map((name) => ({ name, ...JSON.parse(readFileSync(path.join(SAMPLES_DIR, name, "sample.json"), "utf8")) }));
}

const files = (dir, rel = "") => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry);
  const relPath = rel ? `${rel}/${entry}` : entry;
  return statSync(full).isDirectory() ? files(full, relPath) : [relPath];
});

/**
 * Copy by content, not with cpSync: on Windows a copy keeps the source's
 * modification time, and a same-size edit with an unchanged mtime looks
 * unmodified to git (e.g. `* 2` -> `* 3`), so the head commit came out empty.
 */
function overlay(from, to) {
  for (const rel of files(from)) {
    mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    writeFileSync(path.join(to, rel), readFileSync(path.join(from, rel)));
  }
}

/**
 * Create sample `name` as a git repo in `dir`. With `salt`, a unique comment
 * is appended to the head's source files, so no cached result applies.
 */
export function makeSample(name, dir, { salt = null } = {}) {
  const sampleDir = path.join(SAMPLES_DIR, name);
  if (!existsSync(path.join(sampleDir, "sample.json"))) {
    throw new Error(`no sample "${name}"; available: ${listSamples().map((s) => s.name).join(", ")}`);
  }
  if (existsSync(path.join(dir, ".git"))) throw new Error(`${dir} is already a git repository`);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "samples@proofline.local");
  git("config", "user.name", "proofline samples");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  for (const f of ["package.json", "package-lock.json"]) writeFileSync(path.join(dir, f), readFileSync(path.join(DEPS_PROJECT, f)));
  overlay(path.join(sampleDir, "base"), dir);
  git("add", "-A");
  git("commit", "-q", "-m", `${name}: base`);
  overlay(path.join(sampleDir, "head"), dir);
  if (salt) {
    for (const f of files(path.join(sampleDir, "head")).filter((f) => f.startsWith("src/"))) {
      appendFileSync(path.join(dir, f), `// run ${salt}\n`);
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", `${name}: head`);
  return { base: git("rev-parse", "HEAD~1"), head: git("rev-parse", "HEAD") };
}
