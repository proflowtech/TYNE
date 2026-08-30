# Semantic Duplication Detection

**Tier:** Flagship
**Status:** Shipped
**Code:** `src/quality/semantic/` (`astNormalize.ts`, `fingerprint.ts`, `similarity.ts`, `fingerprintIndex.ts`, `semanticCloneDetector.ts`, `behavioralGap.ts`), `src/services/semanticIndexService.ts`

---

## What it does

Finds code an AI agent **reimplemented instead of reused** — a function that
does the same job as one already in the repo, written from scratch because the
agent never read the existing helper.

This is Type-4 (semantic) clone detection. Lexical clone detectors find
copy-paste; this finds *independent reimplementation*, where there is no
textual overlap at all.

## Why this is flagship

Every competitor's clone detection is lexical or near-lexical. Measured on
Tyne's own repo, the canonical case has **0% lexical overlap** yet is clearly
the same function. Detecting that requires structural + behavioural analysis
that a diff-only reviewer cannot perform.

It is also the wedge that needs **zero setup** — no Jira, no account, no
network. It works sixty seconds after install on any repo.

## The four views

Each function is reduced to four independent representations
(`astNormalize.ts`). The engine works because these **fail independently**:

| View | Captures | Survives | Breaks on |
|---|---|---|---|
| `shape` | Alpha-renamed AST token stream | Variable/param renaming, formatting | Restructuring (loop → map) |
| `api` | Callees, properties, literals, types | Restructuring | Swapping the underlying library |
| `control` | Loops/branches/awaits/depth counts | Minor edits | Nothing decisive alone |
| `naming` | Identifier subwords through a verb lexicon | Synonym renames (`fetch`→`get`→`load`) | Total vocabulary change |

The verb lexicon collapses `fetchUser` / `retrieveUser` / `loadUser` onto one
concept. That same lexicon is reused by Team Learnings for concept matching.

## Clone kinds

The *pattern* across views names the kind — not the fused score
(`similarity.ts`):

| structure | lexical | api | Kind | Meaning |
|---|---|---|---|---|
| high | high | — | `identical` | Copy-paste |
| high | low | — | `renamed` | Copy-paste, variables renamed |
| mid | low | high | `restructured` | Same logic, rearranged |
| **low** | **~0** | **high** | **`reimplemented`** | **Written from scratch. The AI case.** |

Scoring is **kind-specific**, not one global formula — a reimplementation is
*expected* to have near-zero structural and lexical similarity, so penalizing
that would blind the engine to the exact case it exists for.

### Containment, not Jaccard

For the reimplemented tier, similarity is asymmetric containment. A rewrite is
usually more verbose than the helper it duplicates; Jaccard charges it for
every extra mechanism token. Measured: the slugify case scores **0.386** under
Jaccard, **0.81** under containment.

## Retrieval

All-pairs comparison on a 2k-function repo is 2M comparisons per review.
`fingerprintIndex.ts` reduces that to ~37 comparisons per changed function
using three probes selected by **rarity**, not frequency:

1. `shapeHash` bucket — exact structural twins, O(1)
2. Rarest API tokens — probing `call:createHmac` returns 3 functions; probing `prop:length` would return the repo
3. Rarest name concepts

## Workspace index

`semanticIndexService.ts` maintains a persistent, incremental index:

- Cached to `globalStorageUri`, keyed per workspace folder
- Re-fingerprints only files whose `mtime`/`size` changed — a warm review does **zero** re-reads
- Budgeted by wall clock and file count; a partial index is always usable
- Excludes files under review from their own corpus
- Measured on Tyne: **548ms cold build, 3.9MB cache, 1182 functions**

Grams are hashed and bottom-k sketched at 256 — exact for 92% of functions.

## Behavioural gap report

When a reimplementation is found, `behavioralGap.ts` reports what the
*existing* function does that the new one does not, with clickable line
evidence:

```
`convertHeadingToUrlSafeString()` duplicates `slugifyTitle()` — 2 behaviours to verify

Steps in `slugifyTitle()` with no equivalent in yours — verify each is covered
(it may be handled a different way):
• it calls `trim()` (src/util/text.ts:8)
• it applies the pattern `/-{2,}/g` (src/util/text.ts:10)
```

**Important honesty constraint.** A gap is a *token-level* difference, not
proof of lost behaviour — the rewrite may achieve the same effect another way.
The engine's own test fixture proves it: the rewrite splits on
`/[^a-z0-9]+/g` and drops empty chunks, which trims and collapses dashes
implicitly, so both "gaps" are real token differences and neither is a bug.

Therefore findings say **"verify each is covered"**, stay in
`maintainability`, and never reach `critical`. Tests pin this wording.

## Interface-contract suppression

`JiraProvider.isConnected` resembling `LinearProvider.isConnected` is
polymorphism, not duplication. `extractContractNames()` collects interface and
abstract-method names, and same-name matches against them are suppressed. On
Tyne's repo this removed **143 false pairs**.

## Trigger points

| # | Trigger | Path |
|---|---|---|
| 1 | **Review runs** | `runReview()` → `getSemanticWorkspaceIndex().ensureFresh()` |
| 2 | **Quality engine** | `runLocalQualityEngine()` → `detectSemanticClones()` with the prebuilt index |
| 3 | **Scoping** | Only functions the diff touched are queried (`changedLineRanges`) |
| 4 | **Precedence** | `pruneCoarseClones()` drops file-level lexical clone findings where a function-level finding already exists |

## Real findings on Tyne's own codebase

Measured at 1182 functions, 14.0% flagged:

- `jaccard()` duplicated in `cloneDetector.ts` and `vibeCodeScanner.ts`
- `chunkArray()` in `reviewFileParallel.ts` and `validateReviewPipeline.ts`
- `getRepositoryIdentity()` — **four copies**
- Four different content-hash helpers
- Two status mappers disagreeing on `'canceled'` vs `'cancelled'` — a latent bug
- Two diff parsers where one misses the `@@` hunk header

## Degradation

Wrapped in try/catch in `qualityEngine.ts` — duplication analysis never fails
a review. Non-TS/JS languages use a regex fallback at reduced confidence
rather than being skipped.

## Tests

`src/tests/semanticClone.test.ts` (41), `src/tests/semanticIndexService.test.ts` (12).
