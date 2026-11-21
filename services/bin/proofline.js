#!/usr/bin/env node
// Proofline CLI: the client-facing interface to the deployed API.
//
//   proofline login --email <email>            password from PROOFLINE_PASSWORD or --password
//   proofline submit <repo-path> [--base HEAD~1] [--head HEAD] [--name owner/project] [--no-wait] [--sarif <file>]
//   proofline status <jobId> [--sarif <file>]
//   proofline samples                          list the sample repos and their expected outcomes
//   proofline sample <name> <dir> [--fresh]    create a sample repo to submit
//
// Authenticates against the Cognito user pool through the login route
// (PROOFLINE_LOGIN_PATH, default /v1/auth/login); the ID token it returns is
// what the job routes' JWT authorizer accepts. The token is cached in ~/.proofline/credentials.json.
// The CLI never holds AWS credentials: it uploads through a short-lived
// presigned URL issued by the API.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { API, ApiError, LOGIN_PATH, CREDENTIALS, TERMINAL, describeRange, getJobView, submitRange } from "../src/client.js";
import { formatReport } from "../src/format.js";
import { listSamples, makeSample } from "../src/samples.js";
import { toSarif } from "proofline-engine";

function fail(message, code = 1) {
  console.error(`proofline: ${message}`);
  process.exit(code);
}

async function login(values) {
  const email = values.email ?? fail("--email is required");
  const password = values.password ?? process.env.PROOFLINE_PASSWORD ?? fail("set PROOFLINE_PASSWORD or pass --password");
  const res = await fetch(`${API()}${LOGIN_PATH}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) fail(`login failed (${res.status}): ${data.message ?? data.error ?? "no token returned"}`);
  mkdirSync(path.dirname(CREDENTIALS), { recursive: true });
  writeFileSync(CREDENTIALS, JSON.stringify({ email, idToken: data.token }), { mode: 0o600 });
  const { exp } = JSON.parse(Buffer.from(data.token.split(".")[1], "base64url").toString());
  console.log(`logged in as ${email}; session valid until ${new Date(exp * 1000).toLocaleTimeString()}`);
}

function describe(view) {
  const p = view.progress;
  const shards = p.shardsTotal === null ? "" : `  shards ${p.completed}/${p.shardsTotal}${p.failed ? ` (${p.failed} failed)` : ""}`;
  const cache = p.cacheHitsAtPlanning ? `  ${p.cacheHitsAtPlanning} cached at planning` : "";
  return `${view.status}${shards}${cache}`;
}

async function waitFor(jobId) {
  const started = Date.now();
  let last = "";
  for (;;) {
    const view = await getJobView(jobId);
    const line = describe(view);
    if (line !== last) console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s  ${line}`);
    last = line;
    if (TERMINAL.has(view.status)) return view;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function submit(repoPath, values) {
  if (!repoPath) fail("usage: proofline submit <repo-path> [--base HEAD~1] [--head HEAD]");
  const range = describeRange(path.resolve(repoPath), values.base, values.head, values.name);
  console.log(`${range.repo} ${range.baseSha.slice(0, 7)}..${range.headSha.slice(0, 7)}: ` +
    `${range.changed.size} changed files, snapshot ${(range.snapshot.length / 1024).toFixed(1)} KiB`);
  const jobId = await submitRange(range);
  console.log(`job ${jobId} started\n`);
  if (values["no-wait"]) return;
  const view = await waitFor(jobId);
  if (view.status === "BASELINE_FAILED") fail(`baseline failed: ${(view.failures ?? []).join(", ")}`, 2);
  printReport(view.report);
}

/** Print a report; with --sarif, also write its PVF assessment as SARIF 2.1.0. */
function printReport(report) {
  console.log(formatReport(report));
  if (values.sarif) {
    if (!report.conformance) fail("this report has no PVF assessment (it predates the framework)");
    writeFileSync(values.sarif, JSON.stringify(toSarif(report.conformance), null, 2));
    console.log(`SARIF written to ${path.resolve(values.sarif)}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    email: { type: "string" }, password: { type: "string" },
    base: { type: "string", default: "HEAD~1" }, head: { type: "string", default: "HEAD" },
    name: { type: "string" }, "no-wait": { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    sarif: { type: "string" },
  },
});

const USAGE = `usage:
  proofline login --email <email> [--password <pw>]     (or set PROOFLINE_PASSWORD)
  proofline submit <repo-path> [--base HEAD~1] [--head HEAD] [--name owner/project] [--no-wait] [--sarif <file>]
  proofline status <jobId> [--sarif <file>]
  proofline samples
  proofline sample <name> <dir> [--fresh]`;

function showSamples() {
  for (const s of listSamples()) {
    const e = s.expect;
    const outcome = e.status === "DONE" ? `${e.riskTier}, score ${e.mutationScore}` : e.status;
    console.log(`${s.name.padEnd(16)} ${outcome.padEnd(20)} ${s.description}`);
  }
  console.log("\ncreate one:  proofline sample <name> <dir>     then:  proofline submit <dir>");
}

function createSample(name, dir) {
  if (!name || !dir) fail("usage: proofline sample <name> <dir> [--fresh]");
  const target = path.resolve(dir);
  const { base, head } = makeSample(name, target, { salt: values.fresh ? Date.now().toString(36) : null });
  const sample = listSamples().find((s) => s.name === name);
  console.log(`created ${name} at ${target}  (base ${base.slice(0, 7)}, head ${head.slice(0, 7)})`);
  console.log(`${sample.lesson}\n\nnext:  proofline submit ${target}`);
}

try {
  switch (command) {
    case "login": await login(values); break;
    case "submit": await submit(positionals[0], values); break;
    case "status": {
      const view = await getJobView(positionals[0] ?? fail("usage: proofline status <jobId>"));
      console.log(describe(view));
      if (view.status === "DONE") printReport(view.report);
      break;
    }
    case "samples": showSamples(); break;
    case "sample": createSample(positionals[0], positionals[1]); break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  if (err instanceof ApiError || /^no sample|already a git repository/.test(err.message)) fail(err.message);
  throw err;
}
