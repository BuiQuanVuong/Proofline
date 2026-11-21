// Working copies of job snapshots. A runner keeps the last few extracted so
// consecutive shards of the same job don't download and unpack again.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

import { s3 } from "./aws.js";

// Per process: two processes on one machine (e.g. planner and runner in a local
// run) must never share, or one's cleanup deletes the other's working copy.
const ROOT = path.join(process.env.PROOFLINE_WORK_ROOT ?? path.join(os.tmpdir(), "proofline-work"), String(process.pid));
const KEEP = 3;
const open = new Map(); // jobId -> workdir, in least-recently-used order

function remove(jobId) {
  const dir = path.join(ROOT, jobId);
  // Remove the dependency link first so a recursive delete can never follow it.
  try { unlinkSync(path.join(dir, "repo", "node_modules")); } catch { /* not linked */ }
  rmSync(dir, { recursive: true, force: true });
  open.delete(jobId);
}

/**
 * Download and extract a job's snapshot. With `depsDir`, link its
 * node_modules into the working copy (the registered repo's prebuilt
 * dependencies).
 */
export async function prepareWorkspace(cfg, jobId, snapshotKey, { depsDir = null } = {}) {
  if (open.has(jobId)) {
    const dir = open.get(jobId);
    open.delete(jobId);
    open.set(jobId, dir);
    return dir;
  }
  remove(jobId);
  const workdir = path.join(ROOT, jobId, "repo");
  mkdirSync(workdir, { recursive: true });
  const archive = path.join(ROOT, jobId, "source.tar.gz");
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: snapshotKey }));
  await pipeline(Body, createWriteStream(archive));
  await tar.x({ file: archive, cwd: workdir });
  if (depsDir) symlinkSync(path.resolve(depsDir, "node_modules"), path.join(workdir, "node_modules"), "junction");

  open.set(jobId, workdir);
  while (open.size > KEEP) remove(open.keys().next().value);
  return workdir;
}

export function closeAllWorkspaces() {
  for (const jobId of [...open.keys()]) remove(jobId);
  rmSync(ROOT, { recursive: true, force: true });
}
