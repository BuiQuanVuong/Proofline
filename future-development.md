# Proofline — Future Development

Ideas that were designed and then deliberately **dropped or deferred**, together with the reason and what bringing each one back would take. These come from design-doc v0.1 → v0.2 (see `design-doc.md` §11.1) and from earlier scoping discussions.

---

## A. Dropped because of account restrictions

The reference deployment targets a locked-down, shared AWS account (design-doc §11). These would be the default choice in an account with full IAM and network permissions.

### A1. Infrastructure as code with AWS CDK
- **Original idea:** define the whole stack in AWS CDK (TypeScript/Python), with `cdk deploy` / `cdk destroy`.
- **Why dropped:** `cdk bootstrap` and most CDK constructs create IAM roles, and **IAM role creation isn't permitted** in the target account (confirmed).
- **Replacement:** an idempotent Node.js (AWS SDK v3) deploy + teardown script that uses pre-existing roles.
- **To bring back:** an account with IAM permissions, or a pre-bootstrapped CDK environment supplied by the account owner. The deploy script's resource model maps almost directly onto CDK constructs.

### A2. Per-component least-privilege IAM roles
- **Original idea:** separate roles for the API, planner, runners, aggregator and notifier, each limited to the exact queue, table and S3 prefixes it needs (e.g. runners: receive/delete on one queue, read `snapshots/*`, write results only).
- **Why dropped:** can't create roles.
- **Replacement:** pre-existing roles; the intended policies are documented as design.
- **To bring back:** role creation permission. Write the policies as JSON now so they're ready to apply.

### A3. Network-isolated test runners (VPC endpoints, no internet route)
- **Original idea:** runners in private subnets with **no internet route**, reaching S3/DynamoDB via gateway endpoints and SQS/CloudWatch Logs/ECR via interface endpoints, so untrusted code can't make any outbound connection.
- **Why dropped:** creating subnets and VPC endpoints is likely blocked in the shared account; interface endpoints also cost money around the clock (per endpoint, per AZ).
- **Replacement:** existing private subnets + a restrictive security group + a preloaded Node module that blocks `net`/`http`/`fetch` inside test processes (a much weaker, application-level control).
- **To bring back:** network admin permissions. Compare endpoint-hours against a NAT gateway in the cost model.

### A4. Fargate Spot capacity
- **Original idea:** run test runners on Fargate Spot (interruptible, much cheaper, and uses spare capacity, which also helps the sustainability argument).
- **Why dropped:** requires capacity-provider configuration on the shared ECS cluster.
- **To bring back:** add the `FARGATE_SPOT` capacity provider to a dedicated cluster. Runners are already safe to interrupt (unfinished shards are redelivered by the queue), so no code changes are needed.

### A5. AWS X-Ray distributed tracing
- **Original idea:** end-to-end traces from API Gateway through Lambda, SQS and the runners to the aggregator.
- **Why dropped:** X-Ray isn't available in the target account; it would also add setup across every service.
- **Replacement:** `jobId`/`shardId` correlation IDs in structured JSON logs, queried with CloudWatch Logs Insights.
- **To bring back:** enable active tracing on Lambda/API Gateway and add the OpenTelemetry/X-Ray SDK to the runners. Trace IDs are already carried in shard messages (`traceId`).

### A7. EventBridge archive and replay
- **Original idea:** archive every lifecycle event on the bus for 7 days, so aggregation or notification could be replayed while debugging fan-in (design-doc DR-1).
- **Why dropped:** EventBridge archives can't be tagged, and the account's policies require tags on every resource.
- **To bring back:** an account without the tagging rule. The bus and event shapes need no changes.

### A6. Amazon Bedrock adversarial test generation (resolved, Tier 3)
- **Status:** no longer at risk. Bedrock is available in the target account, and `nvidia.nemotron-super-3-120b` (text and tool calling) is available in-region, so Tier 3 stays on Bedrock.
- **Constraint:** the account offers only a few models, so model choice is part of the design discussion rather than a free parameter.

---

## B. Dropped to keep the first release small

### B1. On-demand environment builder for arbitrary repositories
- **Original idea:** a separate Fargate task that builds a dependency environment for `hash(lockfile, Node version)`, caches it in S3, and is the only data-plane component with (restricted) internet egress. Lets users verify **any** public repo.
- **Why dropped:** a second untrusted-code execution path (install scripts), internet egress, and a large amount of build logic.
- **Replacement:** a prebuilt runner image per **registered** repo (design-doc D5).
- **To bring back:** env builder task + S3 `envs/` prefix + a `BUILDING_ENV` job state. The cache-key design already includes `env_hash`.

### B2. Durable second-tier result cache (reinstated in v0.4)
- **Original idea:** cache-aside with two tiers: in-memory (ElastiCache) → DynamoDB (`CACHE#<key>`, 30-day TTL) → compute.
- **Why it was dropped:** extra code paths with little MVP benefit.
- **Why it came back:** the role probe showed Lambdas can't join the VPC, so the planner can't reach ElastiCache. DynamoDB is the only cache the planner *can* reach, so it became the primary result store. See design-doc DR-4.

### B3. Redis-specific features
- **Original idea:** Redis pub/sub for live progress, sorted sets for leaderboards/statistics.
- **Why deferred:** not needed yet. Valkey (Redis-compatible) is deployed and used for results and single-flight locks (`SET NX PX`); pub/sub and sorted sets would come with C2.
- **To bring back:** a Redis/Valkey cluster; pairs naturally with C2 (WebSocket progress).

### B4. Fan-in via DynamoDB transaction or DynamoDB Streams
- **Original idea:** a transaction (put shard result + decrement `shardsRemaining`), or DynamoDB Streams → Lambda to detect completion.
- **Why dropped:** transactions don't return updated values, so a worker can't tell it finished the job; Streams adds another moving part.
- **Replacement:** an atomic set-add returning the new set, plus an idempotent aggregator (design-doc D4). Keep this one as is. It's simpler *and* correct.

---

## C. Product features deferred (Tier 2 / Tier 3 and beyond)

| ID | Feature | Value | Notes |
|---|---|---|---|
| C1 | **GitHub App + Check Runs** (Tier 2) | Results show up in the PR automatically; the "request callback" pattern | Webhook HMAC verification, short-lived installation tokens, Secrets Manager |
| C2 | **WebSocket live progress** (Tier 2) | Better UX than polling; WebSocket interface pattern | API Gateway WebSocket API; connection IDs in DynamoDB |
| C3 | **LLM adversarial property-based tests** (Tier 3) | Finds edge cases the existing tests miss | **Superseded by D3 (verified test suggestions)**, whose output is proven against a specific mutant. Differential validation (D7) remains useful for behaviour-change detection |
| C4 | **Static analysis stage** | Cheap extra evidence (ESLint, `tsc --noEmit`, Semgrep) | Runs in the baseline shard |
| C5 | **PR decomposition** | Splits large AI-generated PRs into ordered, independently reviewable pieces | A research problem; each piece must build and pass tests |
| C6 | **More runners and languages** | Jest for JS/TS; Python (mutmut / Cosmic Ray), Java (PIT) | The descriptor format is language-neutral; parsers, operators and test selection aren't |
| C7 | **Faster mutant execution** | Remove ~1–2 s Vitest start-up per mutant | Mutant switching as in StrykerJS (instrument once with every mutant, activate by ID), or keep a warm Vitest process per shard |
| C8 | **Equivalent-mutant detection** | Fewer false "survivors", making the low-noise pitch stronger | Static rules, compiler-level checks, or an LLM judge |
| C9 | **Stronger per-run sandbox** | Isolation between the worker agent and untrusted code | Micro-VM per test run (Firecracker) or a user-space kernel (gVisor) |
| C10 | **Learned risk model** | Better triage than hand-tuned rules | Needs a large labelled dataset from backtests; must stay explainable |
| C11 | **Private repositories and multi-tenancy** | Real product use | Per-tenant isolation, encryption, retention policy, access control on reports |
| C12 | **Track non-source test inputs in the cache key** | Correct caching when tests read data files or env vars | Today the dependency fingerprint covers source files the tests executed, test helpers and tooling config |
| C13 | **Per-test (not per-file) test selection** | Fewer tests run per mutant | Needs per-test coverage, e.g. a Vitest reporter that snapshots V8 coverage between tests |
| C14 | **Migrate the codebase to TypeScript** | Typed message schemas and DynamoDB items; maintainability as the codebase grows | Plain JS (ESM) for now by choice; add a build step for Lambdas and container images |


---

## D. Roadmap: Proofline as the trust layer for autonomous software engineering

_Sections D0–D5 here are roadmap sections, not the design doc's decisions D1–D9._

### D0. The thesis

Coding agents (Codex, Claude Code, Devin and others) have made *producing* code cheap. The open problem is deciding **how much to trust what they produce**. Today's agent loop ends in "the tests pass, so a human reviews it", but passing tests only show that tests didn't fail, not that they would fail if the code were wrong (design-doc §2).

The long-term position for Proofline is **the verification and trust layer** that sits between coding agents and the main branch. Agents generate changes; Proofline determines whether there is enough **objective evidence** to trust each one, and routes it accordingly: merge, targeted review, or rejection. Mutation testing, the part that's built, is the core of that evidence because it's **checkable**. A surviving mutant is a reproducible fact, not an opinion.

That shifts the question the project answers from *"can AI write code?"* to *"how do we build enough trust to let AI change software with less human review, and know when not to?"*

### D1. Principles that every stage must satisfy

These come from the design so far, and they decide which stages below are adopted, deferred or rejected.

| Principle | Meaning | Why |
|---|---|---|
| **Evidence over opinion** | A finding counts only if it's reproducible: a test that fails, a mutant that survives, a tool that reports a rule violation | LLM review comments are mostly dismissed as noise (§2); opinions are what Proofline exists to replace |
| **Independence** | The verifier never modifies the code it's verifying | A verifier that can edit the code can also make its own score pass |
| **Integrate, don't replace** | Coding agents and humans write code; Proofline judges it, through existing interfaces (PR checks, CI) | Building another coding agent enters the most crowded part of the market and dilutes the differentiator |
| **Calibrate before you automate** | A number that gates merges must be measured against real outcomes first | An uncalibrated "96.2% confidence" is false precision, and dangerous if it can merge code |
| **Fail closed** | Missing, erroring or partial evidence lowers trust, never raises it | Already implemented: `INCONCLUSIVE` reports, alarms that do nothing on missing data |

### D2. The stages, assessed

| # | Stage | Value | Risk / objection | Verdict |
|---|---|---|---|---|
| 1 | **Requirement agent:** issue → goals, constraints, acceptance criteria | Acceptance criteria could seed tests (stage 5) | Coding agents already do this; not verification | **Out of scope.** Consume acceptance criteria if an agent provides them |
| 2 | **Planning agent:** files, interfaces, migrations, tests needed | Earlier human checkpoint | Same as stage 1 | **Out of scope** |
| 3 | **Coding agent** | n/a | Crowded market; violates *integrate, don't replace* | **Rejected.** Proofline verifies agents' PRs instead |
| 4 | **Static verification:** types, lint, secrets, dependency and security scanning, complexity | Cheap, objective evidence before any test runs | Tool noise must be filtered to findings on changed lines | **Next after the MVP** (C4). Runs in the baseline shard |
| 5 | **Test generation:** unit, property, regression, edge-case tests | Finds behaviours the existing tests never check | Generated tests can be wrong or encode wrong behaviour | **Adopted, as D3 below**, and only with verification |
| 6 | **Mutation testing** | The core evidence | Equivalent mutants (C8); cost (C7) | **Built** |
| 7 | **AI interpretation of survivors:** why it survived, likely missing test, impact | Turns a raw diff into an actionable sentence | An explanation is an opinion | **Adopted as presentation only** (D3). It never changes the score |
| 8 | **Automatic test repair:** generate → run → keep if the mutant dies → retry | Survivors become concrete, proven test cases | Cost of LLM calls and re-runs; needs caps | **Adopted, scoped down (D3)**: the headline Tier 3 feature |
| 9 | **Code repair:** rewrite the implementation when the score stays low | Closes the loop fully | Breaks *independence*: the verifier would be grading its own edits, and an agent can game the score (delete code that has survivors, assert on implementation details) | **Rejected inside Proofline.** Report back to the coding agent, which owns the code |
| 10 | **Multi-agent review:** security, performance, architecture agents | Broader coverage of concerns | Agents produce opinions; the noise problem returns | **Only via tools** with reproducible output (Semgrep rules, complexity metrics, benchmarks), i.e. stage 4. Free-form agent debate is rejected |
| 11 | **Single confidence score** combining mutation score, coverage, static findings, flakiness, churn, complexity, history | One number to triage on | Without labelled outcomes the weights are invented; a precise-looking number would be false precision | **After calibration only.** The backtest (§14) supplies labels; until then, the transparent rule-based risk tier (design-doc D6) |
| 12 | **Decision engine:** auto-merge above a threshold | Removes humans from low-risk changes | Mutation testing measures how well the tests check the code, **not** whether the code meets the requirement. If the tests encode the wrong behaviour, a perfect score still merges a bug | **Policy-limited future work:** only after calibration, only for narrow low-risk paths, always overridable |
| 13 | **Human review of evidence, not diffs:** summary, survivors, generated tests, reasons | The real productivity gain: reviewers read 5 findings, not 400 lines | None significant | **Partly built** (report evidence list); completed by C1 (PR check runs) |
| 14 | **Learning from production:** bug fixes, reverts, incidents → recalibration | Keeps confidence honest over time | Needs time and real users | **Started:** the backtest (§14) is the offline version of this loop |

### D3. The next concrete slice: verified test suggestions (stages 5, 7 and 8)

For each surviving mutant, Proofline proposes a test that kills it, and **proves** it before showing it. This replaces C3 as the Tier 3 feature, because its output is checkable evidence rather than a suggestion to trust.

```text
ReportReady (survivors > 0)
   │
   ▼  EventBridge rule
suggester Lambda ── Bedrock (Nemotron 3 Super): survivor diff + source + existing tests ──► candidate test
   │
   ▼  SQS: SUGGEST shard (one per survivor, capped per job)
runner (Fargate, same sandbox as every shard)
   1. candidate passes on the unmutated head?        no  → discard (the test is wrong)
   2. candidate fails with the mutant applied?       no  → retry with feedback (max 2), then give up
   3. both true → VERIFIED: the test provably closes this gap
   │
   ▼
report: "SURVIVED src/pricing.js:6  >= → >   Verified fix: it('discounts at exactly $100', …)"
```

| Design point | Choice | Reason |
|---|---|---|
| What the LLM may change | Nothing. It proposes a test file only; the runner decides | *Independence* |
| What reaches the report | Only tests that pass on head **and** kill their mutant | *Evidence over opinion*; a wrong suggestion can never appear |
| Explanation text (stage 7) | Generated alongside, labelled as explanation | Useful context, but kept out of the score |
| Score | Unchanged by suggestions; the report shows "score if accepted" separately | The score describes the code as submitted |
| Cost control | At most N survivors per job (e.g. 10), 2 retries each, cached by survivor content hash | Bounds Bedrock and runner cost; repeat survivors reuse their verified test |
| Failure | Bedrock errors or timeouts → circuit breaker; report published without suggestions | *Fail closed*: suggestions are additive |
| Cloud patterns added | AI/ML service, another event-driven stage, a second shard type on the same autoscaled workers | Reuses the architecture instead of adding a new one |
| Prior art | Meta's published work on mutation-guided LLM test generation | Proofline adapts the idea to a serverless pipeline and a public-repo backtest |

### D4. Integration points with coding agents

Proofline stays agent-agnostic. Every agent already produces commits and PRs, so the integration surface is the PR:

1. **GitHub App + check run (C1):** an agent's PR triggers verification, and the result appears as a check with the risk tier and the evidence.
2. **A machine-readable report:** the existing JSON report, so an agent can read the survivors and verified tests and **fix its own code**. That keeps code repair (stage 9) with the agent, outside the verifier.
3. **Policy gate (stage 12, later):** branch protection requires the Proofline check to pass, with tier thresholds per path set by the repository owner, not by Proofline.

### D5. Order of work

1. Edge caching (design-doc §9) and a CloudWatch dashboard.
2. Static checks in the baseline shard (stage 4, C4).
3. Verified test suggestions (D3).
4. GitHub App + check runs (C1), which make Proofline usable by any coding agent.
5. Backtest (§14) → calibrated confidence (stage 11) → policy-limited auto-merge (stage 12).
