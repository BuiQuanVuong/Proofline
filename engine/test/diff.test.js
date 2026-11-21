import assert from "node:assert/strict";
import { test } from "node:test";

import { isConfigPath, isSourcePath, isTestPath, parseUnifiedDiff } from "../src/diff.js";

const DIFF = `diff --git a/src/calc.js b/src/calc.js
--- a/src/calc.js
+++ b/src/calc.js
@@ -3,0 +4,2 @@ export function add(a, b) {
+export function sub(a, b) {
+  return a - b;
@@ -10 +12 @@ export function clamp(x, lo, hi) {
-  if (x < lo) {
+  if (x <= lo) {
diff --git a/src/old.js b/src/old.js
deleted file mode 100644
--- a/src/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
--- this removed line looks like a header
-const x = 1;
diff --git a/src/new.js b/src/new.js
new file mode 100644
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,2 @@
+++ looks like a header too
+const y = 2;
\\ No newline at end of file
`;

const asObject = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));

test("tracks new-side line numbers and ignores header look-alikes", () => {
  assert.deepEqual(asObject(parseUnifiedDiff(DIFF)), {
    "src/calc.js": [4, 5, 12],
    "src/new.js": [1, 2],
  });
});

test("context lines advance line numbers", () => {
  const diff = "+++ b/a.js\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n keep\n";
  assert.deepEqual(asObject(parseUnifiedDiff(diff)), { "a.js": [2] });
});

test("path classification", () => {
  assert.ok(isSourcePath("src/a.ts") && isSourcePath("src/a.mjs") && isSourcePath("src/a.tsx"));
  assert.ok(!isSourcePath("src/types.d.ts") && !isSourcePath("README.md"));
  assert.ok(isTestPath("src/calc.test.js") && isTestPath("src/calc.spec.ts"));
  assert.ok(isTestPath("test/helpers.js") && isTestPath("src/__tests__/a.js"));
  assert.ok(!isTestPath("src/calc.js") && !isTestPath("src/contest.js"));
  assert.ok(isConfigPath("vitest.config.ts") && isConfigPath("pkg/package.json"));
  assert.ok(!isConfigPath("src/config.js"));
});
