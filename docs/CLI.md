# Proofline CLI manual

`proofline` is the command-line client for Proofline. It submits a git commit range for verification, waits while the cloud runs mutation testing on the changed lines, and prints a risk report.

It never holds AWS credentials. It signs in through Cognito, calls the Proofline API over HTTPS, and uploads code through a short-lived presigned S3 URL that the API issues.

---

## Contents

1. [Install](#1-install)
2. [Quick start](#2-quick-start)
3. [Commands](#3-commands)
4. [Sample repositories](#4-sample-repositories)
5. [Reading a report](#5-reading-a-report)
6. [What happens when you submit](#6-what-happens-when-you-submit)
7. [Environment variables and files](#7-environment-variables-and-files)
8. [Exit codes](#8-exit-codes)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Install

Requirements: Node.js ≥ 22 and git.

```powershell
cd proofline/services
npm install
npm link            # once: makes `proofline` available in every terminal
$env:PROOFLINE_API = "https://<api-id>.execute-api.<region>.amazonaws.com"
```

Without `npm link`, run `node services/bin/proofline.js` in place of `proofline`. Every example below works either way. `PROOFLINE_API` is the endpoint printed by `node infra/deploy.js --phase=4`; ask your operator for it.

## 2. Quick start

```powershell
$env:PROOFLINE_PASSWORD = "<your password>"
proofline login --email dev@example.com

proofline samples                                   # what's available
proofline sample boundary-weak C:\temp\demo         # create a sample repo
proofline submit C:\temp\demo                       # verify its last commit
```

Output:

```
local/demo 997b681..be91fbd: 2 changed files, snapshot 9.5 KiB
job j_mvq1x2k4a1b2c3 started

    0s  BASELINE
  128s  PLANNING
  133s  RUNNING  shards 0/1
  139s  DONE  shards 1/1

Risk tier:             MEDIUM
Mutation score:        0.6667
Changed-line coverage: 1
Mutants:               6 total, 4 killed, 2 survived, 0 uncovered, 0 timeout, 0 error, 0 from cache

PVF 1.0 verdict:       FAIL  (lowest level achieved: PV-1)
  BELOW  src/pricing.js  achieved PV-1, required PV-2  (coverage 1, mutation score 0.6667)
         next level needs: PV-TEST-03: mutation score 0.6667 < 0.8

Surviving mutants (PV-TEST-03):

  SURVIVED  src/pricing.js:6  ROR_GTE_TO_GT
    - if (total >= 100) {
    + if (((total) > (100))) {

  SURVIVED  src/pricing.js:6  CRP_NUM_INCREMENT
    - if (total >= 100) {
    + if (total >= 101) {
```

The **PVF verdict** (§5.1) says whether the change meets the level its repository requires: here PV-2 by default, and it reaches only PV-1. Each `SURVIVED` line is a concrete fault that Proofline injected into your change and that **no test noticed**. Here: nothing tests an order of exactly $100.

## 3. Commands

### `proofline login`

```
proofline login --email <email> [--password <password>]
```

Signs in to the Proofline user pool (Amazon Cognito) and caches an ID token for about an hour. The password comes from `--password` or, preferably, the `PROOFLINE_PASSWORD` environment variable, which keeps it out of your shell history.

```
> proofline login --email dev@example.com
logged in as dev@example.com; session valid until 1:49:19 AM
```

### `proofline submit`

```
proofline submit <repo-path> [--base <rev>] [--head <rev>] [--name <owner/project>] [--no-wait]
```

Verifies the changes between two commits of a local git repository.

| Option | Default | Meaning |
|---|---|---|
| `<repo-path>` | (required) | A local git repository. Only **committed** code is sent |
| `--base` | `HEAD~1` | The commit the change starts from |
| `--head` | `HEAD` | The commit to verify |
| `--name` | `local/<folder name>` | The repository name shown in reports |
| `--no-wait` | off | Print the job ID and exit; check later with `proofline status` |
| `--sarif <file>` | off | Also write the PVF assessment as SARIF 2.1.0, for GitHub code scanning and other SARIF tools (also on `status`) |

Only files changed between `--base` and `--head` are mutated, and only on the changed lines. The snapshot sent is `git archive` of `--head`: tracked files only, so nothing in `.gitignore` (such as `node_modules`) is uploaded.

```powershell
proofline submit C:\work\shop                         # last commit
proofline submit C:\work\shop --base main --head feature/discounts
proofline submit C:\work\shop --no-wait               # fire and forget
```

**What it can verify:** JavaScript or TypeScript projects tested with **Vitest**. The test suite must pass on `--head` and must not need network access or external services.

### `proofline status`

```
proofline status <jobId>
```

Shows a job's state, and the full report once it's done. You can only see your own jobs: anyone else's job ID answers "no such job".

```
> proofline status j_mvpd7atf058747
DONE  shards 1/1
...report...
```

### `proofline samples`

Lists the built-in sample repositories with their expected outcomes. See [§4](#4-sample-repositories).

### `proofline sample`

```
proofline sample <name> <dir> [--fresh]
```

Creates sample `<name>` as a two-commit git repository in `<dir>`: a base commit, then a head commit containing the change to verify. Submit it with `proofline submit <dir>`.

`--fresh` adds a unique comment to the changed files. Normally, submitting the same sample twice is answered from the **result cache**: the planner finds every mutant's result already computed and no worker runs. Use `--fresh` when you want the work to really run, e.g. to watch the workers scale.

## 4. Sample repositories

Each sample is a small, realistic change with a known answer. `npm run test:samples` (in `services/`) checks every expected outcome against the real engine.

| Sample | The change | Risk tier, score | PVF 1.0 | What it shows |
|---|---|---|---|---|
| `weak-tests` | Adds `clamp()` and `isAdult()`; tests never touch a boundary | **HIGH**, 0.375 (coverage 83%) | FAIL, PV-1 | High line coverage can still hide untested behaviour |
| `boundary-weak` | Adds `discount()` (10% off from $100); no test at exactly $100 | **MEDIUM**, 0.667 | FAIL, PV-1 | The survivors pinpoint the missing boundary test |
| `boundary-strong` | The same `discount()`, plus a test at $99 and $100 | **LOW**, 1.0 | PASS, PV-4 | One targeted test turns MEDIUM into LOW |
| `untested-code` | Adds `parseQuantity()` with no test | **HIGH**, 0 (coverage 0%) | FAIL, PV-0 | Code no test runs is reported as `NO_COVERAGE` |
| `broken-baseline` | Changes the shipping rate but not the test that checks it | **BASELINE_FAILED** | NOT_EVALUATED | Proofline won't score a change whose own suite fails |
| `typescript` | Adds `gst()` to a `.ts` module, with tests | **LOW**, 1.0 | PASS, PV-4 | TypeScript works unchanged; annotations aren't mutated |
| `eval-calculator` | Adds `evaluate()`, which calls `eval()`; fully tested; profile requires PV-3 for `src/**` | **LOW**, 1.0 | **FAIL, PV-2** | A perfect mutation score can still be unsafe: `PV-SEC-01` (CWE-95) blocks PV-3 |
| `hardcoded-secret` | Adds a connection string with a password in the source | **LOW**, 1.0 | **FAIL, PV-0** | `PV-SEC-03` (CWE-798) is mandatory; the value is shown redacted |
| `equivalent-mutant` | Adds `atLeast()` with complete tests; one survivor is an equivalent mutant, recorded as a deviation; profile requires PV-4 | **MEDIUM**, 0.667 | **PASS, PV-4** | How a profile handles mutation testing's blind spot: the survivor stays visible with its justification |

The last three show why the PVF verdict (§5) matters more than the risk tier: the risk tier only reflects mutation testing.

**A demo in three commands:** submit `boundary-weak`, then `boundary-strong`, and compare. Same code, one extra test, and the two survivors are gone.

```powershell
proofline sample boundary-weak   C:\temp\bw ; proofline submit C:\temp\bw
proofline sample boundary-strong C:\temp\bs ; proofline submit C:\temp\bs
```

**A cache demo:** submit the same sample twice, in two fresh directories. The second report says `6 from cache`, and its job finishes without any mutant running.

## 5. Reading a report

Every report has two parts: the **PVF 1.0 assessment**, which is the verdict that matters, and the **mutation-testing detail** behind one of its rules.

### 5.1 The PVF verdict

```
PVF 1.0 verdict:       FAIL  (lowest level achieved: PV-2)
  BELOW  src/calc.js  achieved PV-2, required PV-3  (coverage 1, mutation score 1)
         next level needs: PV-SEC-01: eval() of a non-constant value (line 6)

Findings:
  PV-SEC-01   required  src/calc.js:6  eval() of a non-constant value
              return eval(expression);
```

Each changed file gets an **achieved level** and a **required level**. The verdict is `PASS` only if every file meets its required level.

| Level | Means the changed lines are… |
|---|---|
| PV-1 Covered | ≥ 80% executed by tests; the suite passes and has no flaky tests |
| PV-2 Tested | …and the tests catch ≥ 80% of injected faults |
| PV-3 Hardened | …and have no dangerous patterns (`eval`, shell injection, HTML injection) and no over-complex function |
| PV-4 Exhaustive | …and are 100% covered with every fault caught (after justified deviations) |

A committed credential (`PV-SEC-03`) is **mandatory**: it makes a file PV-0 whatever else it achieves. The required level defaults to **PV-2**. A repository raises it per path, and records justified deviations, in a `.proofline.json` file at its root. The full specification, the rule catalogue, the profile format and SARIF mapping are in [`framework.md`](framework.md).

### 5.2 Mutation testing detail

```
Risk tier:             MEDIUM
Mutation score:        0.6667
Changed-line coverage: 1
Mutants:               6 total, 4 killed, 2 survived, 0 uncovered, 0 timeout, 0 error, 0 from cache
```

| Field | Meaning |
|---|---|
| **Mutation score** | (killed + timeout) ÷ (killed + timeout + survived + uncovered). The share of injected faults your tests caught |
| **Changed-line coverage** | Share of changed executable lines that at least one test runs |
| **Risk tier** | **HIGH** if score < 0.6 or coverage < 0.5 (or score < 0.8 in sensitive paths such as `auth/`, `payments/`); **LOW** if score ≥ 0.85 and coverage ≥ 0.8; otherwise **MEDIUM**. **INCONCLUSIVE** if more than 20% of mutants errored or have no result |
| `from cache` | Results reused from an earlier identical run (same code, tests and dependencies) |

**Mutant outcomes**

| Outcome | Meaning | Counts as |
|---|---|---|
| `KILLED` | A test failed: the fault was caught | good |
| `SURVIVED` | Every selected test still passed: **a gap in your tests** | bad |
| `NO_COVERAGE` | No test even runs this line | bad |
| `TIMEOUT` | The fault made the tests hang (e.g. an infinite loop) | good |
| `ERROR` | Infrastructure problem, not evidence; excluded from the score | — |

**Fault types** (the operator names on each evidence line)

| Operator | Injected fault |
|---|---|
| `ROR_*` | Comparison changed: `<`↔`<=`, `>`↔`>=`, `===`↔`!==` |
| `AOR_*` | Arithmetic changed: `+`↔`-`, `*`↔`/` |
| `LCR_*` | Logic changed: `&&`↔`\|\|` |
| `NOT_DROP` | A `!` removed |
| `CRP_*` | Constant changed: `true`↔`false`, `n` → `n+1` |
| `RVR_TO_UNDEFINED` | `return x` → `return undefined` |
| `SDL_*` | A call or `+=`-style update deleted |

An extra pair of parentheses in a diff (`((total) > (100))`) is deliberate: it guarantees the injected fault can't change operator precedence.

**Equivalent mutants.** Occasionally a survivor can't be killed by any test, because the fault doesn't change behaviour (e.g. `x < lo ? lo : x` versus `x <= lo ? lo : x`, which return the same value when `x === lo`). That is a known limit of mutation testing; judge such survivors on their merits.

## 6. What happens when you submit

```
proofline submit
  │ 1  POST /v1/jobs  (commit range + changed lines)     ──► API Gateway ─► api Lambda ─► DynamoDB job record
  │ 2  PUT snapshot.tar.gz to the presigned S3 URL       ──► S3 (the API never handles the code itself)
  │ 3  POST /v1/jobs/{id}/start                           ──► api Lambda ─► SQS: baseline shard
  │                                                                 │
  │                                   backlog metric ─► alarm ─► ECS scales 0 → N Fargate runners
  │                                                                 │
  │                    runner: full test suite + coverage ─► EventBridge: BaselineCompleted
  │                    planner Lambda: mutants, test selection, cache lookups ─► SQS: mutant shards
  │                    runners: execute mutants in parallel ─► DynamoDB results ─► EventBridge: JobCompleted
  │                    aggregator Lambda: score + risk tier ─► S3 report
  │ 4  GET /v1/jobs/{id}  every 5 s until DONE            ──► api Lambda ─► job status, then the report
```

**Why the first result can take ~2 minutes:** when Proofline is idle it runs **zero** workers, so it costs nothing. The first job wakes it up: the backlog metric is published once a minute, the alarm reacts, and Fargate starts workers (~30 s). Once workers are running, a job like the samples completes in about 10 seconds. Workers stop again after 5 minutes without work.

## 7. Environment variables and files

| Name | Purpose |
|---|---|
| `PROOFLINE_PASSWORD` | Password for `login` (instead of `--password`) |
| `PROOFLINE_API` | **Required.** API base URL, e.g. `https://<api-id>.execute-api.<region>.amazonaws.com` |
| `PROOFLINE_API_PREFIX` | Path prefix of the job routes. Default: `/v1` |
| `PROOFLINE_LOGIN_PATH` | Login route that returns a Cognito ID token. Default: `/v1/auth/login` |
| `~/.proofline/credentials.json` | The cached ID token, readable only by you. Delete it to sign out |

## 8. Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (`submit`: the report was produced; read its risk tier) |
| `1` | Usage error, not signed in, API error, or unknown sample |
| `2` | `submit`: the baseline failed (the change breaks its own tests) |

The risk tier doesn't change the exit code. In a CI pipeline, run with `--no-wait` and read the result with `status`, or parse the report.

## 9. Troubleshooting

| Message | Cause and fix |
|---|---|
| `not logged in` / `session expired` | Run `proofline login` again (sessions last about an hour) |
| `login failed (401): Invalid username or password` | Wrong email or password; check `PROOFLINE_PASSWORD` holds the real value, not a placeholder |
| `POST /v1/jobs -> 400: changed is empty` | `--base` and `--head` have no differences; check the range with `git diff <base> <head>` |
| `-> 400: bad path …` / `repo must be …` | The request failed validation (path traversal, absolute paths, odd repo names are refused) |
| `-> 409: snapshot not uploaded` | The upload didn't finish within its 5-minute URL lifetime; submit again |
| `baseline failed: test/… > …` | Your own tests fail on `--head`; fix them first (see the `broken-baseline` sample) |
| Stuck at `BASELINE` for several minutes | Workers are starting from zero; normal up to ~2–3 minutes. Beyond 10 minutes, ask the operator to check `infra/watch-scaling.js` |
| Report says `INCONCLUSIVE` | Too many mutants errored or never ran; the report's `errors` list shows why |
