// Content-addressed cache keys for mutant results.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export class FileHasher {
  constructor(workdir) {
    this.workdir = workdir;
    this.hashes = new Map();
  }

  hash(file) {
    if (!this.hashes.has(file)) {
      const full = path.join(this.workdir, file);
      this.hashes.set(file, existsSync(full) ? sha256(readFileSync(full)) : "missing");
    }
    return this.hashes.get(file);
  }

  /**
   * Hash of every input that can affect the selected tests' outcome: the source
   * files they executed in the baseline (from per-test-file coverage), the test
   * files themselves, and `alwaysInclude` (test helpers and tooling config).
   */
  fingerprint(files, tests, alwaysInclude) {
    const all = [...new Set([...files, ...tests, ...alwaysInclude])].sort();
    return sha256(all.map((f) => `${f}\0${this.hash(f)}\n`).join(""));
  }
}

/** `envHash` should capture the dependency lockfile and Node version. */
export function mutantCacheKey(mutant, fingerprint, tests, envHash) {
  return sha256([mutant.id, fingerprint, [...tests].sort().join(","), envHash].join("\0"));
}
