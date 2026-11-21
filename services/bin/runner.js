#!/usr/bin/env node
// Runner entry point: the container's command, also runnable locally.
//
//   node services/bin/runner.js --deps=<dir with node_modules> [--exit-when-idle=60]
//
// --deps falls back to PROOFLINE_DEPS_DIR (set in the container image).

import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { connectHotCache } from "../src/hotcache.js";
import { createLogger, runLoop } from "../src/runner.js";
import { closeAllWorkspaces } from "../src/workspace.js";

const { values } = parseArgs({
  options: {
    deps: { type: "string", default: process.env.PROOFLINE_DEPS_DIR },
    "exit-when-idle": { type: "string", default: process.env.PROOFLINE_EXIT_WHEN_IDLE ?? "0" },
  },
});
if (!values.deps) {
  console.error("runner: --deps (or PROOFLINE_DEPS_DIR) must point at the registered repo's dependencies");
  process.exit(1);
}

const cfg = await loadConfig();
const log = createLogger({ component: "runner" });
const cache = await connectHotCache(log); // disabled unless PROOFLINE_CACHE_HOST is set
try {
  await runLoop(cfg, { depsDir: values.deps, cache, log, exitWhenIdleS: Number(values["exit-when-idle"]) });
} finally {
  closeAllWorkspaces();
}
