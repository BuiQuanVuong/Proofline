// Idempotent deploy for Proofline. Safe to re-run: it creates what's missing
// and reconciles settings on what exists.
//
//   node infra/deploy.js              all implemented phases
//   node infra/deploy.js --phase=1    one phase
//   node infra/deploy.js --phase=6 --admin=<email>   also adds that user to the admin group

import { config } from "./config.js";
import { deployData } from "./phases/data.js";
import { deployRegistry } from "./phases/registry.js";
import { deployRunner } from "./phases/runner.js";
import { deployControl } from "./phases/control.js";
import { deployCache } from "./phases/cache.js";
import { deployGovernance } from "./phases/governance.js";

const PHASES = {
  1: ["data plane (DynamoDB, S3, SQS, EventBridge, Parameter Store)", deployData],
  2: ["container registry (ECR)", deployRegistry],
  3: ["runner service (ECS Fargate, step scaling on queue depth)", deployRunner],
  4: ["control plane (Lambda: API, planner, aggregator, DLQ handler; EventBridge rules; API routes)", deployControl],
  5: ["in-memory cache (ElastiCache for Valkey, runners only)", deployCache],
  6: ["access control (Cognito admin group)", deployGovernance],
};

const arg = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1];
const selected = arg ? [arg] : Object.keys(PHASES);
for (const n of selected) {
  if (!PHASES[n]) {
    console.error(`unknown phase ${n}; implemented: ${Object.keys(PHASES).join(", ")}`);
    process.exit(1);
  }
}

console.log(`Proofline deploy: ${config.prefix} @ ${config.accountId} / ${config.region}`);
console.log(`tags: ${Object.entries(config.tags).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);
for (const n of selected) {
  const [label, run] = PHASES[n];
  console.log(`Phase ${n}: ${label}`);
  try {
    const outputs = await run();
    console.log("");
    for (const [k, v] of Object.entries(outputs ?? {})) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("");
  } catch (err) {
    console.error(`\n  FAILED in phase ${n}: ${err.name}: ${err.message}`);
    process.exit(1);
  }
}
console.log("done");
