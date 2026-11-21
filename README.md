# Proofline

**Cloud verification of code changes.** Proofline tells you whether the tests on a change would actually catch a bug in it, not just whether they pass.

A developer submits a commit range. Proofline injects small faults (*mutants*) into the **changed lines only**, re-runs just the tests that cover each one on auto-scaled containers, checks the change against static rules, and returns a verdict against the **Proofline Verification Framework (PVF 1.0)**. Every finding carries a reproducible witness (a surviving mutant's exact diff, or the line that calls `eval`), so the result is evidence rather than opinion.

```
$ proofline submit ./my-repo
local/my-repo ce0788b..fccda54: 2 changed files, snapshot 9.4 KiB

Risk tier:             MEDIUM
Mutation score:        0.6667
PVF 1.0 verdict:       FAIL  (lowest level achieved: PV-1)
  BELOW  src/pricing.js  achieved PV-1, required PV-2
         next level needs: PV-TEST-03: mutation score 0.6667 < 0.8

  SURVIVED  src/pricing.js:6  CRP_NUM_INCREMENT
    - if (total >= 100) {
    + if (total >= 101) {
```

## How it works

| Stage | What happens | Runs on |
|---|---|---|
| Submit | The CLI uploads a `git archive` snapshot through a short-lived presigned URL; the API never handles code | API Gateway + Lambda, S3 |
| Baseline | The suite runs twice (flaky-test check), then each test file alone with V8 coverage | ECS Fargate runners |
| Plan | Mutants on changed lines, test selection per mutant, content-addressed cache lookups, static checks | Lambda (never executes repository code) |
| Run | Shards of mutants run in parallel; results are cached in Valkey and DynamoDB, with single-flight locks | Fargate, scaled 0 → 20 on live queue depth |
| Aggregate | Score, risk tier, PVF verdict, report (JSON, or SARIF for code scanning) | Lambda, S3 |

Measured on the reference deployment: 160 concurrent jobs scaled the runners from 0 to 12 and back to 0 with 160/160 correct reports, and 30 identical concurrent jobs needed 7 mutant executions instead of 210. See [`evidence/README.md`](evidence/README.md).

## Repository layout

| Path | Contents |
|---|---|
| [`engine/`](engine/) | Change-scoped mutation engine and the PVF 1.0 implementation (pure library, no AWS) |
| [`services/`](services/) | Runner, Lambda handlers (API, planner, aggregator, DLQ, backlog publisher), and the `proofline` CLI |
| [`infra/`](infra/) | Phased, idempotent deploy and teardown scripts, account probes, tag audit, scaling watcher |
| [`samples/`](samples/) | Nine sample repositories with declared, tested outcomes |
| [`evidence/`](evidence/) | Load-test results and scaling recordings |
| [`docs/`](docs/) | CLI manual, the PVF specification, related work |
| [`report/`](report/) | Technical report and architecture figures |

## Getting started

Requirements: Node.js ≥ 22, git, and (for deployment) Docker and AWS credentials.

**Run the tests locally**

```sh
cd engine   && npm ci && npm run fixture:install && npm test
cd services && npm ci && npm test
```

**Deploy to AWS**

1. Copy `infra/config.example.json` to `infra/config.local.json` and fill in the account ID, region, resource prefix, tags, and the existing IAM roles, VPC, HTTP API and Cognito user pool to build on. Every value can also be set through the environment (`AWS_ACCOUNT_ID`, `PROOFLINE_PREFIX`, `PROOFLINE_API_ID`, `PROOFLINE_USER_POOL_ID`, …).
2. Check what the account allows: `node infra/probe.js` and `node infra/role-probe.js`.
3. Deploy: `node infra/deploy.js` (or one phase at a time with `--phase=N`), and push the runner image with `node infra/push-runner.js`.
4. Tear down with `node infra/teardown.js` (dry run) and `node infra/teardown.js --yes`.

**Use the CLI**

```sh
cd services && npm link
export PROOFLINE_API=https://<api-id>.execute-api.<region>.amazonaws.com
proofline login --email you@example.com
proofline sample boundary-weak /tmp/demo && proofline submit /tmp/demo
```

The full manual is in [`docs/CLI.md`](docs/CLI.md).

## Documentation

| Document | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The system as built: components, job flow, data, scaling, failure handling, security |
| [`design-doc.md`](design-doc.md) | Requirements, vendor-agnostic design, AWS mapping, decision records |
| [`docs/framework.md`](docs/framework.md) | The Proofline Verification Framework (PVF 1.0) |
| [`docs/related-work.md`](docs/related-work.md) | How Proofline compares with existing tools and research |
| [`future-development.md`](future-development.md) | Deferred ideas and the roadmap |
| [`report/report.md`](report/report.md) | Technical report: design rationale, evaluation, cost |

## Known limitations

- Test code currently runs with the runner's own identity and can reach the internet through the NAT; a separate unprivileged user without credentials, and network isolation, are planned.
- JavaScript/TypeScript projects tested with Vitest only.
- See [`ARCHITECTURE.md` §8](ARCHITECTURE.md#8-security) for the full list.
