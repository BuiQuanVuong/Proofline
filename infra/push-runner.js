// Build the runner image and push it to ECR.
//
//   node infra/push-runner.js
//
// Tags are the git commit (plus a timestamp if the working tree has
// uncommitted changes), because the repository's tags are immutable. ECR is
// the source of truth for the current image: phase 3 deploys the newest push
// (Parameter Store values may be write-once under some account policies).
// Pushing uses the ECR credential helper rather than `docker login`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REGISTRY, listImages, repositoryUri } from "./phases/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

try {
  const dockerConfig = JSON.parse(readFileSync(path.join(os.homedir(), ".docker", "config.json"), "utf8"));
  if (dockerConfig.credHelpers?.[REGISTRY.host] !== "ecr-login") {
    console.warn(`warning: ~/.docker/config.json has no credHelpers entry for ${REGISTRY.host}; the push may fail`);
  }
} catch {
  console.warn("warning: couldn't read ~/.docker/config.json");
}

const dirty = git("status", "--porcelain").length > 0;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const tag = `${git("rev-parse", "--short=12", "HEAD")}${dirty ? `-dirty-${stamp}` : ""}`;
const image = `${repositoryUri()}:${tag}`;

if ((await listImages()).some((i) => i.tags.includes(tag))) {
  console.log(`${image} is already in ECR (tags are immutable); nothing to push`);
  process.exit(0);
}

console.log(`building ${image}${dirty ? "  (uncommitted changes included)" : ""}\n`);
// --provenance=false: push a plain image manifest rather than an index with an
// attestation entry, so ECR scan-on-push scans the image itself.
run("docker", ["build", "--platform", "linux/amd64", "--provenance=false", "-f", "services/Dockerfile", "-t", image, "."]);
console.log(`\npushing ${image}\n`);
run("docker", ["push", image]);
console.log(`\npushed ${image}\nnext: node infra/deploy.js --phase=3 deploys the newest image`);
