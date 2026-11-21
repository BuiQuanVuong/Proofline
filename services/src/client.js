// Client for the deployed Proofline API, shared by the CLI and the load test.
// Authenticates with the Cognito ID token cached by `proofline login`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitChangedLines } from "proofline-engine";

import { changedToJson } from "./keys.js";

/** Base URL of the deployed API (printed by `node infra/deploy.js --phase=4`). */
export const API = () => process.env.PROOFLINE_API?.replace(/\/$/, "") ??
  (() => { throw new ApiError("set PROOFLINE_API to the API's base URL, e.g. https://<id>.execute-api.<region>.amazonaws.com"); })();
export const API_PREFIX = process.env.PROOFLINE_API_PREFIX ?? "/v1";
export const LOGIN_PATH = process.env.PROOFLINE_LOGIN_PATH ?? "/v1/auth/login";
export const CREDENTIALS = path.join(os.homedir(), ".proofline", "credentials.json");
export const TERMINAL = new Set(["DONE", "BASELINE_FAILED"]);

export class ApiError extends Error {}

export function readToken() {
  if (!existsSync(CREDENTIALS)) throw new ApiError("not logged in; run `proofline login --email <email>`");
  const { idToken } = JSON.parse(readFileSync(CREDENTIALS, "utf8"));
  const { exp } = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
  if (exp * 1000 < Date.now() + 60_000) throw new ApiError("session expired; run `proofline login` again");
  return { idToken, expiresAt: exp * 1000 };
}

export async function api(method, route, payload) {
  const res = await fetch(`${API()}${route}`, {
    method,
    headers: { authorization: `Bearer ${readToken().idToken}`, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(`${method} ${route} -> ${res.status}: ${data.error ?? data.message ?? text}`);
  return data;
}

/** Everything the API needs about one commit range of a local repo. */
export function describeRange(repo, base, head, name) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
  const baseSha = git("rev-parse", base);
  const headSha = git("rev-parse", head);
  return {
    repo: name ?? `local/${path.basename(repo)}`,
    baseSha, headSha,
    changed: gitChangedLines(repo, baseSha, headSha),
    snapshot: execFileSync("git", ["archive", "--format=tar.gz", headSha], { cwd: repo, maxBuffer: 512 * 1024 * 1024 }),
  };
}

/** Create the job, upload the snapshot through the presigned URL, start it. Returns the job ID. */
export async function submitRange({ repo, baseSha, headSha, changed, snapshot }) {
  const created = await api("POST", `${API_PREFIX}/jobs`, { repo, baseSha, headSha, changed: changedToJson(changed) });
  const put = await fetch(created.upload.url, { method: "PUT", headers: created.upload.headers, body: snapshot });
  if (!put.ok) throw new ApiError(`snapshot upload failed: ${put.status} ${await put.text()}`);
  await api("POST", created.next.start);
  return created.jobId;
}

export const getJobView = (jobId) => api("GET", `${API_PREFIX}/jobs/${jobId}`);
