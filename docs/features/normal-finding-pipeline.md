# Finding Grounding & Merge Pipeline

**Tier:** Normal
**Status:** Shipped
**Code:** `src/services/findingGrounding.ts`, `src/services/findingsMerger.ts`

---

## What it does

Everything between "the model returned findings" and "the reviewer sees a
list". Five stages, in order:

| # | Stage | Function |
|---|---|---|
| 1 | **Grounding** | `groundReviewFindings()` — drop findings that reference files not in the diff |
| 2 | **Fix normalization** | `normalizeStructuredFix()` — structured `fix.diff` → applyable `suggestedFix` |
| 3 | **Dedup** | `mergeAndDeduplicateFindings()` — collapse line-overlapping duplicates per file+category |
| 4 | **Throttle** | `throttleLowPriorityFindings()` — cap minor/nit at 3/file |
| 5 | **Suppress** | `dropSuppressedFindings()` — per-user dismissals and team learnings |

## Why normal, not premium

Table stakes. Any review tool that ships LLM output without this produces
unusable noise. Absence would be a gap; presence is not a selling point.

That said, one part is genuinely ahead: grounding computes a measurable
**`hallucinationRate`**, which most competitors describe only qualitatively.

## Grounding — the hallucination filter

Models invent file paths. `findingGrounding.ts` drops findings pointing at
paths not in the reviewed diff, with narrow allowances for synthetic paths
(`(scope)`, `(none)`).

It also demotes specific over-claims:

- **Mass-deletion claims** with no actually-deleted paths in the diff
- **Infrastructure-file claims** (`.gitignore`, lockfiles, configs) that the
  diff does not support

Deterministic sources (`ast_rule`, `dataflow`, `metric`, `secret_scanner`,
`dependency_scanner`, `architecture`, `ac_validator`) bypass grounding — they
cannot hallucinate a path because they derived it from the AST.

Telemetry recorded per review:

```
rawFindingCount, droppedUngroundedCount, syntheticPathCount, hallucinationRate
```

## Throttling — and its one hard rule

Minor/nit findings are capped at 3 per file, with a synthetic
`throttled-<file>` overflow row.

**Throttling must only ever touch cosmetic categories** (`style`, `vibe_code`,
`maintainability`, `performance`). The Scope / Security / Compliance / Tests
panels read `result.findings` by category — culling `pm_alignment`,
`security`, `compliance`, `test_coverage` or `breaking_change` would silently
empty those sections rather than shortening a list.

## Cross-file rule grouping

Three or more hits of the same `ruleId` across files collapse into one finding
with `relatedLocations`, rather than N separate rows.

## Carry-forward

`carryForwardUnresolvedMinors()` re-attaches prior minor findings that still
touch the current diff. LLM re-runs often drop soft findings once majors are
fixed; without this they vanish without being addressed. Dismissed titles are
excluded.

## Trigger points

| # | Trigger |
|---|---|
| 1 | Edge review returns → `postProcessReviewFindings()` |
| 2 | Local-only fallback → same function, same options |
| 3 | After post-processing → `_carryForwardFromPrior()` |
| 4 | Then → `verdictFromFindings()` sets `overallVerdict` |

## Tests

`src/tests/findingsMerger.test.ts` (30), `src/tests/findingGrounding.test.ts`.
