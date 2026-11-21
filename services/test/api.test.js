// Unit tests for the API's validation and views (no AWS).

import assert from "node:assert/strict";
import { test } from "node:test";

import { callerOf, groupsOf, handler, jobView, parseCreateRequest } from "../src/handlers/api.js";

const valid = { repo: "local/demo", baseSha: "1eeb2fd", headSha: "8194ee5aa", changed: { "src/calc.js": [4, 5] } };

test("accepts a well-formed request and converts changed lines to sets", () => {
  const r = parseCreateRequest(valid);
  assert.equal(r.repo, "local/demo");
  assert.deepEqual(r.changed.get("src/calc.js"), new Set([4, 5]));
});

test("rejects malformed and hostile requests", () => {
  const bad = [
    null,
    { ...valid, repo: "../etc" },
    { ...valid, repo: "a b" },
    { ...valid, baseSha: "HEAD~1" },
    { ...valid, headSha: "zzzzzzz" },
    { ...valid, changed: {} },
    { ...valid, changed: { "../secret.js": [1] } },
    { ...valid, changed: { "/abs.js": [1] } },
    { ...valid, changed: { "src\\win.js": [1] } },
    { ...valid, changed: { "src/a.js": [0] } },
    { ...valid, changed: { "src/a.js": ["1"] } },
    { ...valid, changed: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.js`, [1]])) },
    { ...valid, changed: { "src/a.js": Array.from({ length: 20_001 }, (_, i) => i + 1) } },
  ];
  for (const body of bad) assert.throws(() => parseCreateRequest(body), undefined, JSON.stringify(body)?.slice(0, 80));
});

test("job view exposes progress but no internal keys", () => {
  const view = jobView({
    jobId: "j_1", status: "RUNNING", repo: "local/demo", baseSha: "a", headSha: "b", createdAt: "t",
    owner: "user-sub", snapshotKey: "snapshots/j_1/source.tar.gz", shardsTotal: 3,
    completedShards: new Set(["s_0001"]), failedShards: new Set(["s_0002"]),
  });
  assert.deepEqual(view.progress, { shardsTotal: 3, completed: 1, failed: 1, mutantsTotal: null, cacheHitsAtPlanning: null });
  assert.equal(view.owner, undefined);
  assert.equal(view.snapshotKey, undefined);
});

test("reads Cognito groups in the shapes the HTTP API passes them", () => {
  assert.deepEqual(groupsOf({ "cognito:groups": "[proofline-admins readers]" }), ["proofline-admins", "readers"]);
  assert.deepEqual(groupsOf({ "cognito:groups": ["proofline-admins"] }), ["proofline-admins"]);
  assert.deepEqual(groupsOf({ "cognito:groups": "proofline-admins" }), ["proofline-admins"]);
  assert.deepEqual(groupsOf({}), []);
});

test("only members of the configured admin group are admins", () => {
  const group = "proofline-admins";
  assert.equal(callerOf({ sub: "u1", "cognito:groups": `[${group}]` }, group).admin, true);
  assert.equal(callerOf({ sub: "u1", "cognito:groups": "[readers]" }, group).admin, false);
  assert.equal(callerOf({ sub: "u1" }, group).admin, false);
  // No group configured: nobody is an admin, whatever their token claims.
  assert.equal(callerOf({ sub: "u1", "cognito:groups": "[]" }, undefined).admin, false);
  assert.equal(callerOf({ "cognito:groups": `[${group}]` }, group), null);
});

test("requests without a verified identity are refused before any work", async () => {
  const res = await handler({ routeKey: "GET /v1/jobs/{jobId}", requestContext: {} });
  assert.equal(res.statusCode, 401);
});
