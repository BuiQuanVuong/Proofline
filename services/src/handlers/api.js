// HTTP API Lambda (payload format 2.0) for the job routes. Every route sits
// behind the Cognito JWT authorizer; a job belongs to the caller's `sub` and
// is invisible to anyone else (a foreign job ID returns 404, not 403).
// Members of the admin Cognito group (PROOFLINE_ADMIN_GROUP) may also read any
// job, but only its owner can start it.
//
//   POST <prefix>/jobs                  create a job; returns a presigned upload URL
//   POST <prefix>/jobs/{jobId}/start    verify the upload, queue the baseline
//   GET  <prefix>/jobs/{jobId}          status, progress and (when done) the report
//
// <prefix> is PROOFLINE_API_PREFIX (default /v1), set by the deploy script.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { s3 } from "../aws.js";
import { loadConfig } from "../config.js";
import { STATUS, UPLOAD_URL_TTL_S, changedFromJson } from "../keys.js";
import { createPendingJob, startUploadedJob } from "../planner.js";
import { getJob, getJsonObject } from "../store.js";

class BadRequest extends Error {}

const respond = (statusCode, body) => ({
  statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const PREFIX = process.env.PROOFLINE_API_PREFIX ?? "/v1";
const LIMITS = { files: 500, lines: 20_000 };
const SHA = /^[0-9a-f]{7,40}$/;
const REPO = /^[\w.-]+(\/[\w.-]+)*$/;

/** Validates a create-job request body; returns the normalised request. */
export function parseCreateRequest(body) {
  if (!body || typeof body !== "object") throw new BadRequest("body must be a JSON object");
  const { repo, baseSha, headSha, changed } = body;
  if (typeof repo !== "string" || repo.length > 200 || !REPO.test(repo) ||
    repo.split("/").some((part) => part === "." || part === "..")) {
    throw new BadRequest("repo must be a name like owner/project");
  }
  for (const [k, v] of [["baseSha", baseSha], ["headSha", headSha]]) {
    if (typeof v !== "string" || !SHA.test(v)) throw new BadRequest(`${k} must be a hex commit SHA`);
  }
  if (!changed || typeof changed !== "object" || Array.isArray(changed)) throw new BadRequest("changed must map file paths to line numbers");
  const files = Object.entries(changed);
  if (files.length === 0) throw new BadRequest("changed is empty: nothing to verify");
  if (files.length > LIMITS.files) throw new BadRequest(`at most ${LIMITS.files} changed files`);
  let lines = 0;
  for (const [file, nums] of files) {
    if (file.startsWith("/") || file.split("/").includes("..") || file.includes("\\")) throw new BadRequest(`bad path ${file}`);
    if (!Array.isArray(nums) || !nums.every((n) => Number.isInteger(n) && n > 0)) throw new BadRequest(`bad line numbers for ${file}`);
    lines += nums.length;
  }
  if (lines > LIMITS.lines) throw new BadRequest(`at most ${LIMITS.lines} changed lines`);
  return { repo, baseSha, headSha, changed: changedFromJson(changed) };
}

function body(event) {
  if (!event.body) return null;
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

/**
 * The caller's Cognito groups. HTTP APIs pass array claims as a string such
 * as "[admins readers]"; tests and other callers may pass a real array.
 */
export function groupsOf(claims) {
  const raw = claims?.["cognito:groups"];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  return raw.replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean);
}

/** Who is calling: their `sub`, and whether they may read every job. */
export function callerOf(claims, adminGroup = process.env.PROOFLINE_ADMIN_GROUP) {
  const sub = claims?.sub;
  if (!sub) return null;
  return { sub, admin: Boolean(adminGroup) && groupsOf(claims).includes(adminGroup) };
}

async function ownedJob(cfg, jobId, caller, { adminMayRead = false } = {}) {
  const job = await getJob(cfg, jobId);
  if (!job) return null;
  return job.owner === caller.sub || (adminMayRead && caller.admin) ? job : null;
}

/** The view of a job a client sees. */
export function jobView(job) {
  return {
    jobId: job.jobId, status: job.status, repo: job.repo, baseSha: job.baseSha, headSha: job.headSha,
    createdAt: job.createdAt, completedAt: job.completedAt ?? null,
    progress: {
      shardsTotal: job.shardsTotal ?? null,
      completed: job.completedShards?.size ?? 0,
      failed: job.failedShards?.size ?? 0,
      mutantsTotal: job.mutantsTotal ?? null,
      cacheHitsAtPlanning: job.cacheHitsAtPlanning ?? null,
    },
    mutationScore: job.mutationScore ?? null,
    riskTier: job.riskTier ?? null,
    pvf: job.status === STATUS.BASELINE_FAILED
      ? { verdict: "NOT_EVALUATED", achievedLevel: "PV-0" }
      : job.pvfVerdict ? { verdict: job.pvfVerdict, achievedLevel: job.pvfLevel } : null,
    failures: job.failures ?? null,
  };
}

async function route(cfg, event, caller) {
  const jobId = event.pathParameters?.jobId;
  // Route keys look like "POST /v1/jobs"; match on the part after the prefix.
  const [method, routePath = ""] = (event.routeKey ?? "").split(" ");
  const key = routePath.startsWith(`${PREFIX}/`) ? `${method} ${routePath.slice(PREFIX.length)}` : event.routeKey;
  switch (key) {
    case "POST /jobs": {
      const request = parseCreateRequest(body(event));
      const id = await createPendingJob(cfg, { ...request, owner: caller.sub });
      const job = await getJob(cfg, id);
      const url = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: cfg.bucket, Key: job.snapshotKey, ContentType: "application/gzip",
      }), { expiresIn: UPLOAD_URL_TTL_S });
      return respond(201, {
        jobId: id,
        upload: { method: "PUT", url, headers: { "content-type": "application/gzip" }, expiresInSeconds: UPLOAD_URL_TTL_S },
        next: { start: `${PREFIX}/jobs/${id}/start`, status: `${PREFIX}/jobs/${id}` },
      });
    }
    case "POST /jobs/{jobId}/start": {
      const job = await ownedJob(cfg, jobId, caller);
      if (!job) return respond(404, { error: "no such job" });
      if (job.status !== STATUS.UPLOADING) return respond(202, jobView(job)); // already started
      const problem = await startUploadedJob(cfg, jobId);
      if (problem) return respond(409, { error: problem });
      return respond(202, jobView(await getJob(cfg, jobId)));
    }
    case "GET /jobs/{jobId}": {
      const job = await ownedJob(cfg, jobId, caller, { adminMayRead: true });
      if (!job) return respond(404, { error: "no such job" });
      const view = jobView(job);
      if (job.owner !== caller.sub) view.readAs = "admin";
      if (job.status === STATUS.DONE && job.reportKey) view.report = await getJsonObject(cfg, job.reportKey);
      return respond(200, view);
    }
    default:
      return respond(404, { error: `no route ${event.routeKey}` });
  }
}

export const handler = async (event, context) => {
  const caller = callerOf(event.requestContext?.authorizer?.jwt?.claims);
  if (!caller) return respond(401, { error: "unauthenticated" });
  try {
    return await route(await loadConfig(), event, caller);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    console.error(JSON.stringify({ msg: "api error", routeKey: event.routeKey, error: `${err.name}: ${err.message}`, stack: err.stack }));
    return respond(500, { error: "internal error", requestId: context?.awsRequestId });
  }
};
