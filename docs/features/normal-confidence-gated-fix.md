# Confidence-Gated Fix

**Tier:** Normal
**Status:** Shipped
**Code:** `src/actionEngine.ts`, `src/sidebar/findingFixController.ts`

---

## What it does

Classifies every finding into exactly one remediation class, so the word
"Fix" never overstates what the product can actually do.

| Class | Button | Meaning |
|---|---|---|
| `applyable` | **Fix** | A real patch exists and can be applied in one click |
| `agent` | **Fix in IDE** | Hand a ready-made prompt to the user's coding agent |
| `guidance` | *(no action button)* | Advice only — nothing to apply |

## Why normal, not premium

Every review tool offers fixes. What is slightly unusual is the **discipline**:
Tyne refuses to label prose as a fix, where competitors often surface a "fix"
button that opens an explanation.

## Gating rules

A finding reaches `applyable` only if **all** hold (`actionEngine.ts`):

1. The fix text is **code-like**, not prose
2. The finding has a verified line range (`hasRange`, `lineOk`)
3. Confidence is not `low`
4. The category is not sensitive (security/compliance never one-click apply
   unless already explicitly `applyable` with a code patch)

Anything failing these falls to `agent` or `guidance`. The rule is stated in
the module's own header: *"Fix only means applyable patch."*

## Fix actions

| Action | Behaviour |
|---|---|
| **Fix** | Apply the patch to the working tree |
| **Compare** | Open native `vscode.diff` — read-only, so deliberately does *not* require `applyable` |
| **Fix in IDE** | Hand off a prompt to Cursor/Claude Code/Copilot |
| **Undo** | Reverse an applied patch via the pre-fix snapshot |
| **Batch** | Apply all safe (`applyable`) fixes, or hand the rest to an agent |

## Trigger points

| # | Trigger | Path |
|---|---|---|
| 1 | **Findings emitted** | `withClassifiedAction()` assigns `actionClass` |
| 2 | **UI renders** | Button choice follows `actionClass` |
| 3 | **Fix clicked** | `applyFix()` snapshots first (`capturePreFixSnapshot`) |
| 4 | **After apply** | `remapFindingsAfterAgentDiff()` re-anchors line numbers |
| 5 | **Undo clicked** | `undoFix()` restores from the snapshot |

## Planned extension

Only Verified-tier findings should be eligible for one-click fix, starting
with the provably safe class: `identical` and `renamed` clones, where
structural-hash equality plus free-variable resolution, signature
compatibility and an import-cycle check make the refactor sound. Not yet
implemented.

## Tests

`src/tests/actionEngine.test.ts`, `src/tests/findingFixController` coverage in
`src/tests/codeReview.test.ts`.
