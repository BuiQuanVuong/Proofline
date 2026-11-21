# Proofline Verification Framework (PVF) — version 1.0

**Status:** draft specification, implemented by Proofline's engine (`engine/src/framework/`).
**Identifier:** `pvf/1.0`

PVF defines **what evidence a code change must carry before it can be trusted**, at graded levels, with every finding backed by a reproducible witness. It is a versioned framework that *maps onto* established standards (ISO/IEC 25010, CWE, CERT, SARIF). It does not claim to be a standard itself: a standard needs consensus and adoption, which a framework earns rather than declares.

---

## 1. Why a framework, not a score

Mutation testing answers one question: *would the tests notice if this code were wrong?* A change can score 1.0 and still run `eval` on user input, commit a password, or add a 200-line function. A single score also invites two problems:
- **False precision:** "96.2% confident" implies a calibration that nobody has done.
- **Incomparability:** a tunable threshold means "passed" says nothing outside one repository.

PVF instead borrows five proven ideas:

| Idea | From | In PVF |
|---|---|---|
| A rule catalogue with stable IDs and categories (mandatory / required / advisory) | MISRA C, CERT | §4 |
| Recorded, justified **deviations** instead of silent suppression | MISRA C compliance process | §7 |
| **Witnesses**: claims anyone can re-check | Proof assistants such as Lean | §3 |
| Required evidence scales with **criticality** | DO-178C, IEC 61508 | §6 |
| Graded **assurance levels** that are easy to state and verify | SLSA | §5 |

Quality characteristics follow **ISO/IEC 25010**. Security rules carry **CWE** identifiers. Results are exported as **SARIF 2.1.0** (OASIS), with deviations as SARIF suppressions (§9).

## 2. Scope

- **Languages:** JavaScript and TypeScript tested with Vitest (the engine's scope).
- **Unit of assessment:** a *change*: the lines added or modified between a base and a head commit. Every rule is evaluated **on changed lines** (or on functions that contain them), never on the whole repository. Untouched legacy code doesn't block a change, and touched code must meet the bar.
- **Source files only:** test files, test helpers and mocks are not assessed (they're the evidence, not the subject).

## 3. Terms

| Term | Meaning |
|---|---|
| **Rule** | A checkable requirement with an ID (e.g. `PV-SEC-01`), a category, an ISO/IEC 25010 characteristic and, where applicable, a CWE mapping |
| **Finding** | One violation of a rule at a location in a changed file |
| **Witness** | The evidence attached to a finding, sufficient for anyone to reproduce or verify it (§8). **A finding without a witness is not a PVF finding** |
| **Level** | PV-1 to PV-4: a cumulative set of rules a file must satisfy (§5). PV-0 means no level is met |
| **Profile** | The repository's `.proofline.json`: required levels per path and accepted deviations (§6, §7) |
| **Deviation** | A recorded, justified exception to a *required* rule, for a path or a single finding |
| **Verdict** | `PASS` if every changed file achieves its required level, `FAIL` otherwise, `NOT_EVALUATED` if the baseline test suite fails |

## 4. Rule catalogue (pvf/1.0)

Categories:
- **Mandatory:** can never be deviated. A violation means the file achieves **PV-0**.
- **Required:** must be satisfied at the levels that include it, unless a valid deviation applies.
- **Advisory:** reported, never affects a level.

| ID | Rule | Category | ISO/IEC 25010 | Mapping | Witness |
|---|---|---|---|---|---|
| `PV-TEST-01` | The project's test suite passes at the head commit | Mandatory | Functional suitability | — | Failing test IDs |
| `PV-TEST-02` | Changed executable lines are executed by at least one test | Required | Functional suitability | — | Coverage: the line and the absence of any covering test file |
| `PV-TEST-03` | Injected faults on changed lines are detected by the tests (mutation score) | Required | Functional suitability | — | Mutant: the exact diff and the tests that still passed |
| `PV-REL-01` | The test suite has no flaky tests (job-wide: applies to every changed file) | Required | Reliability (maturity) | — | The test and its two differing outcomes |
| `PV-REL-02` | No empty `catch` block | Advisory | Reliability (fault tolerance) | CWE-1069 | AST location |
| `PV-SEC-01` | No dynamic code evaluation (`eval`, `new Function`, string `setTimeout`/`setInterval`) of non-constant input | Required | Security (integrity) | CWE-95 | AST location and snippet |
| `PV-SEC-02` | No shell command built from non-constant input (`child_process` `exec` / `execSync`) | Required | Security (integrity) | CWE-78 | AST location and snippet |
| `PV-SEC-03` | No hard-coded credentials | **Mandatory** | Security (confidentiality) | CWE-798 | Location and a **redacted** value |
| `PV-SEC-04` | No HTML sink fed non-constant input (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`) | Required | Security (integrity) | CWE-79 | AST location and snippet |
| `PV-MAINT-01` | Cyclomatic complexity of a changed function ≤ 10 | Required | Maintainability (analysability) | — | Function, value, decision points |
| `PV-MAINT-02` | A changed function is at most 60 lines | Advisory | Maintainability (modifiability) | — | Function and length |
| `PV-MAINT-03` | No debugging leftovers (`debugger`, `console.log`, `console.debug`) | Advisory | Maintainability | — | AST location |
| `PV-MAINT-04` | No new `TODO` / `FIXME` / `XXX` / `HACK` comments | Advisory | Maintainability | — | The comment |

Detection notes:
- `PV-SEC-02` applies only in modules that import `child_process`, so `RegExp.prototype.exec` is never mistaken for a shell call.
- `PV-SEC-03` matches credential-shaped names assigned a string of eight or more characters (`password`, `secret`, `token`, `apiKey`, `privateKey`, `accessKey`, …) and well-known token formats (private-key headers, AWS access-key IDs, GitHub and Slack tokens). Values are **never** written to a report unredacted.
- `PV-MAINT-01` counts `if`, `?:`, `for`/`for…in`/`for…of`, `while`, `do…while`, each `case`, `catch`, `&&`, `||` and `??`, excluding nested functions.
- `PV-REL-01` is job-wide because the baseline excludes a flaky test's file from coverage, so a flaky test can't be traced to particular lines. Any flaky test undermines every result that test selection depends on.
- `PV-REL-02` treats a `catch` block containing only a comment as intentional, and doesn't flag it.

## 5. Levels

Levels are cumulative: each includes everything below it. Thresholds are **fixed by the framework version**, not by the repository, so a level means the same thing everywhere.

| Level | Name | Required evidence (on the file's changed lines) |
|---|---|---|
| **PV-1** | Covered | `PV-TEST-01`; `PV-TEST-02` with changed-line coverage **≥ 80%**; `PV-REL-01` |
| **PV-2** | Tested | PV-1, and `PV-TEST-03` with mutation score **≥ 0.80** |
| **PV-3** | Hardened | PV-2, and `PV-SEC-01`, `PV-SEC-02`, `PV-SEC-04`, `PV-MAINT-01` with no active findings |
| **PV-4** | Exhaustive | PV-3, and changed-line coverage **100%** and mutation score **1.0**, after deviations |

Rules and conventions:
- **Mandatory rules cap every level.** A failing `PV-TEST-01` makes the verdict `NOT_EVALUATED`. A `PV-SEC-03` finding makes the file **PV-0** whatever else it achieves.
- **Mutation score** = (killed + timed out) ÷ (killed + timed out + survived + uncovered). Mutants with a valid deviation are removed from both sides, and infrastructure errors are excluded.
- **Not applicable passes:** a file with no changed executable statement passes `PV-TEST-02`; a file with no mutants passes `PV-TEST-03`.
- PV-4 is attainable in practice because equivalent mutants (faults that can't change behaviour) are handled by deviation (§7). That's exactly what deviations are for.

## 6. Criticality and required levels

A repository declares what each path must achieve in `.proofline.json` at its root:

```json
{
  "pvf": "1.0",
  "requiredLevel": "PV-2",
  "paths": [
    { "glob": "src/auth/**", "requiredLevel": "PV-3" },
    { "glob": "src/payments/**", "requiredLevel": "PV-4" }
  ]
}
```

- Without a profile, the required level is **PV-2**.
- If several globs match a file, the **strictest** level wins. Accidental overlap can only make a path stricter, never weaker.
- Globs: `*` matches within a path segment, `**` matches across segments.

## 7. Deviations

A deviation is a documented decision that a required rule doesn't apply, with a justification a reviewer can challenge.

```json
{
  "deviations": [
    {
      "rule": "PV-MAINT-01",
      "paths": ["src/parser/grammar.js"],
      "justification": "Generated state machine; complexity is inherent and the generator is tested.",
      "approvedBy": "tech-lead@example.com"
    },
    {
      "rule": "PV-TEST-03",
      "file": "src/range.js",
      "line": 2,
      "operator": "ROR_LT_TO_LTE",
      "justification": "Equivalent mutant: x <= lo returns lo when x === lo, which is the same value as returning x.",
      "approvedBy": "reviewer@example.com"
    }
  ]
}
```

| Rule | |
|---|---|
| **Scope** | Either `paths` (globs: the rule doesn't apply there) or `file` + `line` (+ `operator` for mutants): one specific finding |
| **Justification** | Mandatory, non-empty. A deviation without one is rejected |
| **Mandatory rules** | Can't be deviated; such entries are rejected and reported as profile errors |
| **Visibility** | Deviated findings are never hidden. They appear in the report as *deviated*, with their justification, and in SARIF as suppressions |
| **Approval** | `approvedBy` is recorded, not verified. Approval happens in code review of `.proofline.json` itself |

## 8. Witnesses

| Kind | Content | How to re-check it |
|---|---|---|
| `test-failure` | Failing test IDs | Run the suite at the head commit |
| `coverage` | File, line, statement text; no covering test file in the baseline | Run the tests with coverage and look at the line |
| `mutant` | File, line, operator, exact diff, the tests run against it | Apply the diff, run those tests: all pass |
| `flaky` | Test ID and its two outcomes | Run the suite twice |
| `ast` | File, line, column, source snippet, the reason it matched | Read the line |
| `metric` | Function, value, limit, the lines of each decision point | Count them |
| `secret` | File, line, the name, a redacted value (first four characters) | Read the line |

## 9. Report and SARIF

A PVF assessment reports:
- the framework version
- for each changed file: the required level, the achieved level, coverage, mutation score, and the rules blocking the next level
- every finding, with its status (`active` or `deviated`)
- applied deviations and profile errors
- the verdict

In SARIF 2.1.0:
- `tool.driver.rules` is the catalogue (§4), with category, characteristic and CWE in `properties`.
- Each finding is a `result`. Required and mandatory rules map to `level: "error"`, advisory rules to `"note"`.
- Deviated findings carry `suppressions: [{ kind: "external", justification }]`.
- Witnesses go in `result.properties.witness`.

GitHub code scanning, and other SARIF consumers, can display PVF findings without any Proofline-specific integration.

## 10. Conformance statements

A change **conforms to PVF 1.0** when its verdict is `PASS`. The statement to publish is:

> *Conforms to PVF 1.0: every changed file meets its required level (strictest: PV-3 for `src/auth/**`); 2 deviations recorded.*

"Achieves PV-*n*" may be claimed for a file only if all rules of level *n* hold for it, after deviations.

## 11. Limits

- **Evidence, not proof.** PVF shows that tests detect injected faults and that known-dangerous patterns are absent. It doesn't prove the code meets its requirements: if the tests encode the wrong behaviour, a file can reach PV-4 and still be wrong.
- **Static rules are pattern-based.** They find common dangerous constructs, not every vulnerability. Data-flow and taint analysis are future work.
- **The levels' thresholds are judgement calls** (0.80 mutation score, 80% coverage, complexity 10, from widespread practice). The backtest (design-doc §14) should calibrate them. If it does, the framework's version changes (`pvf/1.1`), the meaning of `pvf/1.0` never does.
- **Equivalent mutants** must be identified by humans and recorded as deviations; automatic detection is future work.

## 12. Versioning

The rule set, the categories and the level thresholds are fixed per version. Any change to them produces a new version identifier. Reports always state the version they were assessed against, so results from different versions are never silently compared.
