# Team Learnings

**Tier:** Flagship
**Status:** Shipped
**Code:** `src/quality/learningsStore.ts`, `src/services/findingsMerger.ts`, `src/sidebar/validateReviewController.ts`, `media/tyne.js`

---

## What it does

A team-maintained suppression list stored at **`.tyne/learnings.md`** in the
repository. When a review produces a finding the team has already decided is
acceptable, the learning hides it — for everyone, permanently, without anyone
having to re-teach it.

Tyne already had per-user suppression (clicking **Ignore** writes the finding
title to `workspaceState`). That is invisible outside one machine. Learnings
are the team-level version.

## Why this is the flagship feature

The differentiator is **where the file lives**, not the matching algorithm.
Because `.tyne/learnings.md` is a normal file in the repo:

| Property | Team Learnings | Cloud-stored learnings (CodeRabbit et al.) |
|---|---|---|
| Reviewed before taking effect | Yes — it lands in a PR | No |
| Attributable | `git blame` names who added it and when | No |
| Inherited by a new clone | Yes | Requires account/org setup |
| Auditable by a security reviewer | Yes — it is a text file | No |
| Removable without a vendor | `git revert` | No |

A competitor storing learnings server-side cannot retrofit these; they follow
from the storage decision.

## File format

The file has two halves — one subtractive, one additive.

```markdown
## Suppress
- <exact finding title>
- <exact finding title> — reason
- <exact finding title> — reason (path/glob/**)
- <RULE_ID> — suppress by rule instead of title

## Require
- Use Result<T,E> instead of throwing (src/core/**)
- Every exported function needs a JSDoc block
```

Anything that is not a `-`/`*` bullet is prose and ignored, so the file can
carry a header and comments. **Bullets before any heading are suppressions**,
so files written before house rules existed keep working unchanged. Parsing is
in `parseLearningsDocument`.

Recognised rule headings: `Require`, `Rules`, `House rules`, `Enforce`,
`Conventions` (case-insensitive). Any other heading leaves the section alone.

## House rules — the additive half

A `## Require` bullet is a convention the team wants **enforced**. It produces
findings instead of hiding them, turning the file from a mute button into a
team style engine — and making it worth maintaining even with zero
suppressions.

### Why these are judgment, not evidence

A house rule is natural language, so unlike every other detector in the
quality engine it can only be checked by the model. Everything about how they
are handled follows from that:

| Guard | Value | Why |
|---|---|---|
| Confidence cap | `medium` | The model is interpreting a convention, not proving a defect |
| Severity cap | below `critical` | A team preference is never a merge-blocker |
| Findings per review | 8 | One vague rule ("write clean code") must not flood a review |
| Rules sent | 20 | A long list dilutes model attention |
| Minimum rule length | 12 chars | "Be good" cannot be checked without guessing |
| Scope filter | glob | Only rules covering a changed file are sent |
| Fabricated ids | dropped | A finding citing `HR9` when only `HR1`–`HR2` were sent is a hallucinated attribution |

Rules are numbered per parse (`HR1`, `HR2`, …). The prompt asks the model to
echo that id in `ruleId`; `_attachHouseRuleOrigins()` maps it back to the rule
text and file line, applies the caps above, and drops any citation that was
never issued. Engine `ruleId`s (`VIBE_CONSOLE`, `DS002`) pass through
untouched.

### UI

House-rule findings render a **`team rule`** chip in the accent colour, next
to the existing `suggestion` label. The tooltip names the rule and its line
(`.tyne/learnings.md:9`), so a noisy rule is one click from being edited or
deleted. The chip exists specifically so a judgment finding is never mistaken
for a deterministic one.

### Limitation

House rules require the LLM stage. The local-only fallback path cannot check
them — natural-language conventions have no deterministic equivalent — so a
review that degrades to local-only silently produces no house-rule findings.

## Matching — four tiers

Evaluated strongest first; the first hit wins. `matchLearning()` in
`src/quality/learningsStore.ts`.

| Tier | Matches when | Risk |
|---|---|---|
| `exact` | Normalized title is identical | None — same rule as clicking Ignore |
| `scoped` | Exact title **and** file inside the glob | None |
| `rule` | `finding.ruleId` equals the learning text | None — exact identifier |
| `fuzzy` | Concept containment ≥ 0.85 | **Real** — see safety envelope |

Suppression matching is unaffected by the rules section, and vice versa.

Normalization is lowercase + whitespace-collapse, identical to
`normalizeTitle` in `findingsMerger.ts`, so a hand-written learning behaves
exactly like an Ignore click rather than a second rule to learn.

### Path scoping

```markdown
- Console.log left in code — workers stream to stdout (src/workers/**)
```

Suppresses that finding **only** under `src/workers/`. The identical finding
in `src/api/route.ts` is still reported. `matchesScope()` supports `*` (within
one path segment) and `**` (across segments), is case-insensitive, and
normalizes Windows separators.

### The fuzzy tier and its safety envelope

LLM findings get reworded between runs, which breaks exact matching. The fuzzy
tier survives that — but a loose suppression **silently hides a real bug**,
which is strictly worse than showing a false positive. Three gates, all
load-bearing:

**1. Containment, not Jaccard.** Measured on the motivating case:

| Learning | Finding | Jaccard | Containment |
|---|---|---|---|
| `console.log left in code` | `debug console.log statement remains` | **0.40** | **1.00** |

Jaccard penalizes the finding for words the model *added* when rephrasing —
exactly the thing this tier exists to survive. The question is
one-directional: does the finding still say everything the learning said?

**2. `FUZZY_MIN_CONCEPTS = 3` on the learning side.** A learning must be
specific enough to generalize safely.

```
Learning "Missing test"  →  concepts: [test]           →  1, below floor
Finding  "Missing test for authentication bypass"      →  NOT suppressed ✓
```

Without this gate, that generic learning would bury a security finding. Short
generic learnings are exact-match-only, by design.

**3. `NEVER_FUZZY_CATEGORIES`.** `security`, `compliance`, `breaking_change`
and `pm_alignment` are never fuzzy-suppressed at any score. An **exact** title
still works — that is a deliberate human decision — but a text-similarity
guess never hides a security finding.

## Suppressions are always visible

Nothing is silently dropped. Every suppression produces a `SuppressionRecord`
(`findingsMerger.ts`) carrying the finding, which learning matched, which
tier, the score, and `.tyne/learnings.md:<line>`. `_buildSuppressedView()`
attaches **git-blame provenance** by reusing `getLineHistory()`, then the
webview renders:

```
Checked but not shown (3)          2 hidden by team learnings, 1 by your dismissals

  Console.log left in code  src/workers/job.ts:8
  Team learning: "console.log left in code" (scoped to path) — workers stream
  to stdout · .tyne/learnings.md:3 · added by Priya on 2026-03-14

  Async handler has an unhandled promise rejection  src/api/route.ts
  Team learning: "unhandled promise rejection in async handler" (similar wording)
  · .tyne/learnings.md:4

  Prefer const over let  src/a.ts
  You dismissed this finding previously.
```

Collapsed by default. The design rule: **a suppression the reviewer cannot
inspect is indistinguishable from a bug.**

## Trigger points

| # | Trigger | Path |
|---|---|---|
| 1 | **Review runs** | `runReview()` → `_readSharedLearnings(folder)` reads and parses the file. Missing file → empty list, never an error. |
| 2 | **Findings post-processed** | `postProcessReviewFindings()` receives an injected `matchLearning` closure; `dropSuppressedFindings()` applies per-user dismissals first, then learnings. |
| 3 | **Result assembled** | `_buildSuppressedView()` adds git-blame provenance → `result.suppressedFindings`. |
| 4 | **UI renders** | `renderSuppressedPanel(r)` renders the collapsed panel after Action Needed. |
| 5 | **User clicks "Suppress for team…"** | Webview posts `addTeamLearning` → `messageRouter` → `ValidateReviewController.addTeamLearning()` → `rememberSharedLearning()` appends the bullet, then **opens the file in the editor** so the author can add a reason before committing. |

## UI changes — what was added

Two additions to `media/tyne.js`; nothing was removed or restyled.

**1. New action in the existing Ignore menu.** The menu already had
Dismiss / Not relevant / Wrong:

```
Ignore ▾
  ├─ Dismiss              (per-user, workspaceState)
  ├─ Not relevant         (per-user)
  ├─ Wrong                (per-user)
  └─ Suppress for team…   ← NEW: writes .tyne/learnings.md
```

**2. New "Checked but not shown" panel**, rendered between Action Needed and
Scores & details. Styled to the existing design system — no bordered cards, no
per-row hairlines, hover-fill separation only.

## Degradation

| Failure | Behaviour |
|---|---|
| `.tyne/learnings.md` absent | Empty learnings list; reviews run normally |
| File malformed | Non-bullet lines ignored; valid bullets still parse |
| No workspace open | `rememberSharedLearning` returns `false` |
| `git blame` fails | Provenance omitted; suppression still listed |
| Write fails | `teamLearningError` posted; button re-enabled |

## Tests

`src/tests/learningsStore.test.ts` (63), `src/tests/houseRuleOrigins.test.ts`
(9), and the suppression-record block in `src/tests/findingsMerger.test.ts`
(6). Safety cases are named `SAFETY:` — **do not relax `FUZZY_MIN_CONCEPTS`,
`NEVER_FUZZY_CATEGORIES`, or the house-rule caps without reading them
first.**

## Known limitation

The fuzzy tier is the only part not yet validated against real-world usage.
The gates are deliberately conservative, but "does it ever hide something it
shouldn't" is a question only a real repo with real learnings can answer.
Exact/scoped/rule tiers carry no such uncertainty.
