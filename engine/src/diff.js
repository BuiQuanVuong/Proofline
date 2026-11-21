// Changed-line extraction from unified diffs.

import { execFileSync } from "node:child_process";
import path from "node:path";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SOURCE_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "e2e"]);

/**
 * Map each file in a unified diff to the line numbers added on the new side.
 * Hunk line counts are tracked so that removed lines whose content starts with
 * "-- " or "++ " are never mistaken for file headers.
 */
export function parseUnifiedDiff(text) {
  const changed = new Map();
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newNo = 0;

  for (const line of text.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const tag = line[0];
      if (tag === "+") {
        if (current !== null) changed.get(current).add(newNo);
        newNo++;
        newLeft--;
      } else if (tag === "-") {
        oldLeft--;
      } else if (tag !== "\\") { // "\ No newline at end of file"
        newNo++;
        newLeft--;
        oldLeft--;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = line.slice(4).split("\t")[0].trim();
      current = file === "/dev/null" ? null : file.replace(/^b\//, "");
      if (current !== null && !changed.has(current)) changed.set(current, new Set());
    } else {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[2] === undefined ? 1 : Number(m[2]);
        newLeft = m[4] === undefined ? 1 : Number(m[4]);
        newNo = Number(m[3]);
      }
    }
  }

  for (const [file, lines] of changed) if (lines.size === 0) changed.delete(file);
  return changed;
}

/** Changed lines between two commits of a local repository. */
export function gitChangedLines(repo, base, head) {
  const out = execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U0", base, head],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseUnifiedDiff(out);
}

/** Source files Proofline mutates: JS/TS, not declaration files. */
export function isSourcePath(file) {
  return SOURCE_EXT.test(file) && !file.endsWith(".d.ts");
}

/** Test files, test helpers and mocks, which are never mutated. */
export function isTestPath(file) {
  const parts = file.split("/");
  const name = parts.at(-1);
  return TEST_FILE.test(name) || parts.slice(0, -1).some((p) => TEST_DIRS.has(p));
}

/** Tooling config that can change test outcomes, so it is part of every cache key. */
export function isConfigPath(file) {
  const name = path.posix.basename(file);
  return /^(?:vite|vitest)\.(?:config|workspace)\.[cm]?[jt]s$/.test(name) ||
    ["package.json", "tsconfig.json", "babel.config.js", ".babelrc"].includes(name);
}
