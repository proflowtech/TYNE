# Acceptance-Criteria Validation

**Tier:** Premium
**Status:** Shipped
**Code:** `src/quality/acceptanceCriteriaValidator.ts`

---

## What it does

Checks each acceptance criterion on the linked PM task against the diff and
returns a per-criterion status plus an overall verdict.

| Per criterion | Meaning |
|---|---|
| `implemented` | Evidence found in the diff |
| `partial` | Some evidence, incomplete |
| `missing` | No evidence |

| Overall | When |
|---|---|
| `all_ac_met` | Every criterion `implemented` |
| `partial_ac_met` | Mixed |
| `ac_not_validated` | No criteria available to check |

## Why premium, not flagship

This is functionally equivalent to what CodeRabbit already ships (their
✅/❌/❓ requirement validation). It is a strong paid-tier capability, but
positioning Tyne on it invites a direct comparison Tyne does not win on its
own. The differentiated version is the [Proof-Point Loop](./flagship-proof-point-loop.md),
which fixes criteria *before* the code exists.

## How evidence is gathered

`searchEvidence()` extracts keywords per criterion and searches the changed
files and diff, scoring matches. Scoring weights `implemented` as 1.0 and
`partial` as 0.5 for the aggregate.

Deterministic keyword/evidence search rather than pure model judgment, so the
result is inspectable — findings carry `detectedBy: 'ac_validator'`, which
`findingGrounding.ts` treats as a deterministic source.

## Trigger points

| # | Trigger | Condition |
|---|---|---|
| 1 | **Review runs with a linked PM task** | `pmTask.acceptanceCriteria` non-empty |
| 2 | **Findings emitted** | Unmet criteria become `pm_alignment` findings |
| 3 | **Never fuzzy-suppressed** | `pm_alignment` is in `NEVER_FUZZY_CATEGORIES` — a scope gap requires an exact-title learning to hide |

## Degradation

No linked task, or a task with no acceptance criteria → verdict is
`ac_not_validated` and no `pm_alignment` findings are produced. Never blocks a
code review.

## Tests

`src/tests/acceptanceCriteriaValidator.test.ts`.
