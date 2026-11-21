# proofline-engine

Change-scoped mutation testing engine and PVF assessment for Proofline, for JavaScript/TypeScript repositories tested with Vitest. Plain JavaScript (ESM), Node.js ≥ 20.

## Run locally

```sh
npm install
npm run fixture:install          # once: installs vitest into test/fixture-project
npm test                         # unit tests + an end-to-end run on the fixture
node src/cli.js <repo> <base-rev> <head-rev> [--out report.json]
```

The target repo must have `vitest` and `@vitest/coverage-v8` installed. If the repo has a `node_modules` folder, the working copy links to it; otherwise the engine runs `npm ci` in the working copy.

## Modules and where they run in the cloud

| Module | Responsibility | Cloud component |
|---|---|---|
| `diff.js` | Changed lines from a unified diff; source/test/config path rules | CLI (diff), planner (path rules) |
| `mutate.js` | Generate mutants (Babel AST) and apply them (string splice) | Planner generates; runner applies |
| `cachekey.js` | Content-addressed result keys | Planner |
| `execute.js` | Baseline (flaky detection + per-test-file V8 coverage); run one mutant | Runner (Fargate) only, since it executes repo code |
| `report.js` | Mutation score, risk tier, evidence | Aggregator (Lambda) |
| `framework/` | **PVF 1.0**: rule catalogue, `.proofline.json` profiles, AST checks, change analysis, assessment, SARIF | Planner (static analysis), aggregator (assessment), CLI (SARIF) |
| `pipeline.js` | All of the above in one process, for local use (`src/cli.js`) | n/a |

`npm test` runs 32 tests, including 16 for the framework and an end-to-end run on the fixture.

## Outcomes

`KILLED` (a test or suite failed), `SURVIVED` (all selected test files passed), `TIMEOUT` (counted as killed), `NO_COVERAGE` (no test file executes the line; counted as survived), `ERROR` (excluded from the score).
