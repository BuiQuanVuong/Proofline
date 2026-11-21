// Deletes Proofline resources in reverse phase order.
//
//   node infra/teardown.js          dry run: lists what would be deleted
//   node infra/teardown.js --yes    actually deletes
//
// The ECS cluster (created by role-probe.js) is kept; delete it in the console
// if you also want it gone.

import { config } from "./config.js";
import { teardownData } from "./phases/data.js";
import { teardownRegistry } from "./phases/registry.js";
import { teardownRunner } from "./phases/runner.js";
import { teardownControl } from "./phases/control.js";
import { teardownCache } from "./phases/cache.js";
import { teardownGovernance } from "./phases/governance.js";

const apply = process.argv.includes("--yes");
const PHASES = [
  ["access control", teardownGovernance],
  ["in-memory cache", teardownCache],
  ["control plane", teardownControl],
  ["runner service", teardownRunner],
  ["container registry", teardownRegistry],
  ["data plane", teardownData],
];

console.log(`Proofline teardown: ${config.prefix}${apply ? "" : "  (dry run; pass --yes to delete)"}\n`);
for (const [label, run] of PHASES) {
  console.log(label);
  await run({ apply });
}
