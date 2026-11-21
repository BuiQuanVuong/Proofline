# proofline-services

The runner, planner, aggregator, API and CLI. One package, shared by the runner container (deploy phase 3) and the Lambdas (deploy phase 4). Plain JavaScript (ESM), Node.js ≥ 22.

| Module | Role | Runs on |
|---|---|---|
| `src/runner.js` | Long-polls the work queue; runs `BASELINE` and `MUTANTS` shards; resolves each mutant hot cache → durable cache → single-flight lock → execute; fan-in; emits events; scale-in protection; logs to S3 | Fargate (the only place repo code executes) |
| `src/hotcache.js` | Valkey client: read-through results, single-flight locks, timeouts and circuit breaker | runner |
| `src/protection.js` | ECS task scale-in protection through the ECS agent endpoint | runner |
| `src/planner.js` | `startJob` / `createPendingJob` / `startUploadedJob`; `planMutants` (PVF static analysis, mutants, durable-cache lookups, mutant shards) | Lambda, outside the VPC |
| `src/aggregator.js` | Claims a completed job (`RUNNING → AGGREGATING`); builds the report with its PVF assessment and cache-source counts | Lambda |
| `src/handlers/` | Lambda entry points: `api` (job routes), `planner`, `aggregator`, `dlq`, `backlog` | Lambda |
| `src/store.js` | DynamoDB single table + S3; conditional updates, set-add fan-in, durable result cache | shared |
| `src/events.js` | `JobCreated`, `BaselineCompleted`, `JobCompleted`, `ReportReady` on the EventBridge bus | shared |
| `src/workspace.js` | Downloads and extracts snapshots into a per-process folder; links the registered repo's prebuilt `node_modules` | runner, planner |
| `src/config.js`, `src/keys.js`, `src/metrics.js` | Configuration (env vars, then Parameter Store), keys and object layout, metric names | shared |
| `src/client.js`, `src/format.js`, `src/samples.js` | API client, report formatting, sample repositories | CLI, load test |

The user-facing CLI is `bin/proofline.js` (its usage text lists every command); its sample repositories are in `../samples/`.

## Run

```sh
npm install
npm test                                   # unit tests, no AWS (19)
npm run test:samples                       # every sample repo vs its expected outcome and PVF verdict (real engine, ~1 min)
npm link                                   # optional: `proofline` command on your PATH
node bin/load-test.js --jobs=160           # load test through the public API (unique content per run)
node bin/load-test.js --jobs=30 --identical  # cache test: same commit for every job
node bin/cache-report.js <load-test.csv>   # where each job's results came from
node bin/show-logs.js <jobId>              # a job's runner shard logs (from S3)
node bin/local-e2e.js                      # one job driven locally against the deployed data plane
node bin/runner.js --deps=<dir> [--exit-when-idle=60]   # the runner on its own
```

`local-e2e.js` plays the control plane locally (planner and aggregator code run in-process) and starts a runner as a child process. It predates the deployed Lambdas and is kept for debugging.
