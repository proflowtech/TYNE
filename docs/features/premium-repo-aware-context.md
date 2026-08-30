# Repo-Aware Review Context

**Tier:** Premium
**Status:** Shipped
**Code:** `src/safeCodebaseContextCollector.ts`, `src/quality/importGraph.ts`, `src/quality/blastRadius.ts`, `src/quality/architectureGraph.ts`, `src/quality/priorContext.ts`, `src/gitManager.ts`

---

## What it does

Builds context around a change rather than sending the raw diff to a model.
Four sources, all computed locally:

1. **Import graph** — who calls the changed code, and what it calls
2. **Blast radius** — outside-diff files affected by the change
3. **Prior-commit history** — what earlier commits touched these same lines
4. **Ranked nearby files** — selected by graph distance, not filename keywords

## Why premium, not flagship

Real depth and genuinely useful, but a well-funded competitor could build the
same thing. It is the substance *behind* the positioning rather than the
positioning itself.

## Import graph and 1-hop neighbourhood

`queryHop1()` in `importGraph.ts` returns:

- `importers` — files importing the changed modules (breaking-change surface)
- `importees` — what the changed files depend on
- `changedExports` — exported symbols in the diff

Packed into a compact `codegraph_neighborhood` block for the prompt, capped at
8KB. Structure is **never guessed by the model** — it is derived from real AST
imports; the LLM only writes narrative over it.

## Context ranking

Nearby-file selection scores each candidate:

| Signal | Score | Rationale |
|---|---|---|
| File is in the diff | 20 | The code under review |
| Graph neighbour (importer/importee) | 14 | Actually wired to the change |
| Each keyword match | 4 | Filename echoes the ticket |

A direct import edge outranks any single loose keyword match, but the file
under review still wins outright. The reported reason names the relationship
("Imports a changed file") rather than a generic "Nearby file".

**This was a real bug fix.** The import graph was already computed for every
review but nearby-file ranking ignored it entirely, so a file one import away
lost to any file sharing a word with the ticket title.

## Prior-commit context

`priorContext.ts` + `gitManager.getLineHistory()` answer *"why was this
written this way"* — but only for commits touching the **exact lines** the
diff touches. "This file changed recently" is nearly always true and tells a
reviewer nothing.

Implementation notes:

- `git blame HEAD -L <start>,<end> --porcelain`, blaming `HEAD` not the
  working tree, so a range covered by the diff resolves to genuinely prior
  history rather than the uncommitted change
- Porcelain repeats full metadata only on a commit's first appearance;
  `parseBlamePorcelain()` walks the stream once and dedupes
- Capped: 6 files, 3 ranges each, 2 commits per file, 8 total
- Fed to the prompt as **advisory only** — explicitly labelled *"context only…
  never cite one of these as a finding on its own"*

## Trigger points

| # | Trigger | Path |
|---|---|---|
| 1 | **Review starts** | `getSemanticWorkspaceIndex().ensureFresh()` → `queryHop1()` |
| 2 | **LSP enrichment** | `collectLspImporters()` merges editor-resolved importers |
| 3 | **Context collection** | `collectSafeCodebaseContext()` ranks nearby files with the graph, collects prior context |
| 4 | **Truncation** | `truncateContext()` applies per-tier budgets |
| 5 | **Prompt assembly** | Rendered as `<untrusted_*>` blocks in the edge function |

## Privacy

All four sources are computed **locally**. Sensitive paths are filtered
(`isSensitivePath`), binaries excluded, and content truncated per file before
anything leaves the machine.

## Degradation

Every stage is `.catch()`-wrapped. No git repo → no prior context. No index →
falls back to a documented regex scan. A partial index still produces a
smaller corpus rather than an error.

## Tests

`src/tests/contextGraphRanking.test.ts` (16), `src/tests/priorContext.test.ts` (15),
`src/tests/importGraph.test.ts`, `src/tests/blastRadius.test.ts`.
