# Proof-Point Loop

**Tier:** Flagship
**Status:** Shipped
**Code:** `src/taskEnrichmentService.ts`, `src/pmTaskIntelligenceService.ts`, `src/quality/acceptanceCriteriaValidator.ts`, `src/sidebar/validateReviewController.ts`

---

## What it does

Commits to what "done" means **before the code exists**, then holds the
finished diff to those criteria.

1. A task is loaded into a thread → Tyne enriches it from the PM tool (Jira /
   Linear), walking the Epic/Story parent hierarchy
2. Enrichment produces **proof-point templates** — concrete, checkable claims
   derived from the ticket
3. The developer (or their agent) writes the code
4. Validate & Review checks the diff against those pre-registered proof points
   and strikes off the ones now satisfied

## Why this is flagship

CodeRabbit also validates PRs against Jira tickets, so *"we check code against
Jira"* is not a differentiator on its own. The difference is **when the
criteria are fixed**:

| | CodeRabbit | Tyne |
|---|---|---|
| When criteria are established | After the PR exists | **Before the code is written** |
| What the verdict is | A retrospective opinion on finished work | A check against criteria fixed in advance |
| Falsifiable | Hard — the model re-reads the ticket each time | Yes — the criteria were recorded earlier |

Fixing the criteria in advance is what makes the verdict falsifiable rather
than a fresh opinion generated after the fact. It is also structurally
impossible for a PR-time bot, which has no presence before the code exists.

## Acceptance-criteria verdicts

`acceptanceCriteriaValidator.ts` returns a status **per criterion**, plus an
overall verdict:

| Per criterion | Overall |
|---|---|
| `implemented` | `all_ac_met` |
| `partial` | `partial_ac_met` |
| `missing` | `ac_not_validated` |

Scoring weights `implemented` as 1.0 and `partial` as 0.5.

## Trigger points

| # | Trigger | Path |
|---|---|---|
| 1 | **Task loaded into a thread** | `runEnrichment()` in `taskEnrichmentService.ts` → `intelligence.proofPointTemplates` |
| 2 | **PM context pulled** | `pmTaskIntelligenceService.ts`; `jiraProvider.ts` resolves the Epic/Story parent |
| 3 | **Review runs** | Proof points enter the prompt as the **Golden Contract** — marked immutable, `<untrusted_pm_task>`-wrapped |
| 4 | **Post-review** | `applyProofStrikeOff()` from `validateReviewController.ts` marks satisfied proof points |

## The Golden Contract

The PM task is injected into the review prompt as an explicitly immutable
block, instructing the model to score the diff against it and **not invent
criteria**. Untrusted-input wrapping is deliberate: ticket text is
attacker-influenceable in a shared tracker.

## Honest limitation

Value is **proportional to the customer's ticket hygiene**. With well-written
epics and real acceptance criteria this is materially better than a PR bot.
With one-line tickets and no epic, enrichment has little to work with and the
loop degrades toward a slower conventional review.

This is the highest-setup, least-provable feature in the product — it belongs
in the enterprise tier and in sales conversations, not as the first-run
experience. See `docs/features/README.md` for tier positioning.

## Degradation

No PM task linked → the loop is skipped entirely and review runs as a normal
code review. Enrichment failures are caught and never block a review.
