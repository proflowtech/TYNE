# Code Review Engine — Architecture Audit

A focused audit of today's review-engine changes: what shipped, how it's wired, what's been verified, and what needs attention before it ships further.

- **Repo:** TYNE (`tyne/jira-task-refresh-and-click-fix`)
- **Commit:** `787ae19` — "feat(review): add quality scanners, PEV scope drift, and parallel file review."
- **Date:** 2026-07-19

## At a glance

| Metric | Value |
|---|---|
| Files touched | 126 |
| Lines added | +18,122 |
| Lines removed | −1,218 |
| New `src/` modules | ~32 |
| `tsc --noEmit` | clean (exit 0) |
| Unit tests | 555 / 556 passing |

---

## 1. What actually shipped

Today's commit is not incremental polish — it wires an entirely new local quality/security scanning layer into the review pipeline, adds an explainable scope-drift subsystem, and stands up a second, parallel review pathway with its own edge function.

- **Quality engine** — 14 new modules under `src/quality/`: secrets, injection, dependency-vuln, and acceptance-criteria detectors, plus AST/complexity/clone/consistency/architecture/performance scanners, orchestrated by the new `qualityEngine.ts`. Backed by a new `web-tree-sitter` runtime for AST parsing across languages.
- **Scope drift** — `scopeDriftHarness.ts` + `pevAgents.ts` + `services/scopeDriftExplainer.ts` turn the PEV "PM Ghost Cop" verdict into human-readable drift explanations, mirrored into `supabase/functions/_shared/` for the edge function.
- **Parallel review** — `services/reviewFileParallel.ts` batches changed files for concurrent per-file LLM review instead of one sequential pass.
- **Action engine** — `actionEngine.ts` (new) classifies every finding as `applyable` / `agent` / `guidance` and gates one-click apply behind a real content-match check against the finding's cited evidence.
- **New pipeline** — `codeReviewService.ts` → `supabase/functions/tyne-code-review/` (1,016 lines, new edge function): a second, simpler "Run Technical Review" path, independent of Validate & Review. See §2.
- **Diagnostics/trend** — `reviewDiagnosticsService.ts`, `reviewTrendService.ts`, `qualityGateService.ts`: VS Code Problems-panel integration, recurring-issue tracking, and pre-commit/pre-push gating.
- **CI** — new `.github/workflows/eval-harness.yml` runs the deterministic PEV eval harness (golden fixtures, 0.66 threshold) on every push/PR.

---

## 2. Two review pipelines, running in parallel

The most consequential architectural fact in this batch: the codebase now maintains **two independently-built review pipelines** that both analyze the same diff for correctness/security issues. The prior architecture note filed `codeReviewService.ts` as "legacy" — it's the opposite: it's brand-new today, actively wired to a real UI button, and backed by a brand-new edge function.

### Validate & Review
*trigger: Cmd+Shift+T · `validateReviewService.ts`*

1. Scope + local quality engine — AST facts, secrets, injection, deps, vibe-code, clones
2. Privacy gate — BYOK direct / redact / local-compliance-only
3. PEV multi-agent — Sentinel → Staff Engineer → PM Ghost Cop, A2A debate
4. Compliance pipeline — classify → data-flow → rules → evidence → score

→ **`tyne-validate-review`**

### Run Technical Review
*trigger: "Run Technical Review" button · `codeReviewService.ts`*

1. `collectReviewContext()` — diff + changed files, no local quality engine
2. Single POST to edge function — BYOK key passed through, no PEV
3. Single-pass LLM review — correctness / security / maintainability
4. No compliance, no scope-drift

→ **`tyne-code-review`** (new today, 1,016 lines)

> `tyne-code-review` imports only `_shared/aicreditsModelPolicy.ts` — it does not touch `pevAgents.ts` or `scopeDriftHarness.ts`. The two pipelines share no review logic, only model-routing config.

---

## 3. Verified before writing this up

- ✅ **TypeScript compiles clean** — `npx tsc -p ./ --noEmit`, exit 0, no errors across the full 126-file change set.
- ✅ **555 / 556 unit tests pass** — 27 suites, 0 skipped.
- ❌ **1 pre-existing failure, unrelated to the review engine** — `out/tests/startThread.test.js:71`, "each integration row uses a single state button as the connect/connected indicator" (Slack row renders a separate status badge). Cosmetic, not part of today's review-engine work.
- ✅ **No orphaned modules** — every new service (`qualityGateService`, `reviewDiagnosticsService`, `reviewTrendService`, `actionEngine`, `codeReviewContextCollector`, `validationContextResolver`, `codebaseContextService`) has a confirmed caller; nothing sits unwired.

---

## 4. Findings

Ranked by how much attention each deserves before this gets relied on further.

### 🔴 High — Two parallel review pipelines duplicate correctness/security analysis
"Run Technical Review" (`codeReviewService.ts` → `tyne-code-review`) and "Validate & Review" (`validateReviewService.ts` → `tyne-validate-review`) both review the same diff for the same class of issues, with separate prompts, separate edge functions, and no shared review logic beyond model routing.

- **Location:** `src/codeReviewService.ts` · `src/TyneSidebarProvider.ts:2709–2741` · `supabase/functions/tyne-code-review/index.ts`
- **Impact:** every future fix to review quality (prompt tuning, false-positive suppression, new finding types) now has to land in two places, or the two paths silently diverge in what they catch.

### 🟠 Medium — Client/backend "keep in sync" pipeline copy has already diverged
`src/validateReviewPipeline.ts` and `supabase/functions/_shared/validateReviewPipeline.ts` carry a header comment claiming they're kept in sync. They no longer are: the backend copy dropped `rotateConfigsForPack` (moved into `aicreditsModelPolicy.ts`) and gained a backend-only `mapPool()` concurrency helper that doesn't exist on the client. The backend file's own comment was updated to describe the split; the client file's comment was not.

- **Location:** `src/validateReviewPipeline.ts:3` · `supabase/functions/_shared/validateReviewPipeline.ts` · `supabase/functions/tyne-validate-review/index.ts:1407`
- **Impact:** no observable bug today (behavior is preserved via the relocated function), but the sync contract is already broken — the next person who trusts that comment will edit only one side.

### 🟠 Medium — Typed fields read through `as any` instead of the real interface
`qualityGateService.ts` reads `securityFindings`, `complianceFindings`, and `complianceStatus` off `(reviewResult as any)`, even though `TyneValidateReviewResult` already declares all three properly-typed (`SecurityFinding`, `ComplianceFinding` with `severity`/`confidence`/`blocking`). Looks like code written before those types landed, never revisited.

- **Location:** `src/qualityGateService.ts:166–197` · `src/validateReviewTypes.ts:59–77, 158–177, 605–609`
- **Impact:** a future field rename on `TyneValidateReviewResult` would fail silently in the quality gate instead of at compile time — exactly the class of bug a type system exists to catch.

### 🟡 Low — Three live production modules have zero test coverage
`codeReviewContextCollector.ts`, `validationContextResolver.ts`, and `validationContextTypes.ts` are wired into `codeValidationService.ts` and the Technical Review flow, but no test file in `src/tests/` references any of them.

- **Location:** `src/codeReviewContextCollector.ts` · `src/validationContextResolver.ts` · `src/validationContextTypes.ts`
- **Impact:** the 5-level context-resolution fallback and the review-context collector can regress without any test failing.

### 🟡 Low — Messy migration history for the same schema change
Four `enrich_pm_task_context` migrations landed within 24 hours: two are completely empty (0 bytes), and the other two contain functionally identical `ADD COLUMN IF NOT EXISTS` statements — the second is a re-run of the first, applied directly via the Supabase MCP tool per its own comment.

- **Location:** `supabase/migrations/20260714194528_*.sql` (empty) · `20260714194730_*.sql` (empty) · `20260715011827_*.sql` · `20260715194145_*.sql` (duplicate)
- **Impact:** harmless today (`IF NOT EXISTS` makes all four idempotent), but the migration history no longer tells an accurate story of what changed when.

### 🟡 Low — Tree-sitter AST engine ships its runtime but not its grammars
`treeSitterRuntime.ts` looks for `tree-sitter-typescript.wasm`, `tree-sitter-python.wasm`, and `tree-sitter-go.wasm` under `media/tree-sitter/`. Only the 201KB runtime itself (`web-tree-sitter.wasm`) is bundled — none of the three language grammars are present. This is a documented, graceful fallback by design (own comment: "grammars optional"), not a crash risk.

- **Location:** `src/quality/treeSitterRuntime.ts:24–29` · `media/tree-sitter/` (1 file)
- **Impact:** cross-language AST parsing (Python/Go especially) silently never activates in the field today; every install pays for the runtime dependency without the benefit until grammar files are actually added.

### 🟢 Info — Existing architecture doc is now out of date in two places
The repo's own `AUDIT_AND_ARCHITECTURE.md` table for `src/quality/` lists 11 modules; 17 now exist (missing: `acceptanceCriteriaValidator.ts`, `dependencyVulnerabilityChecker.ts`, `injectionDetector.ts`, `qualityEngine.ts`, `qualityTypes.ts`, `secretsDetector.ts`). It also never mentions `src/services/` (`reviewFileParallel.ts`, `scopeDriftExplainer.ts`) at all, and its "Legacy" label on `codeReviewService.ts` reads as dead-code when it's actually a live, separate, actively-used pipeline (see §2).

- **Location:** `AUDIT_AND_ARCHITECTURE.md:131–145, 361`

---

## 5. Recommendations

1. **Pick one review pipeline.** Either fold "Run Technical Review" into Validate & Review as a lighter mode, or explicitly document why both exist and what each is for — right now they're unexplained duplicates.
2. **Fix the sync comment or the sync itself.** Either restore `rotateConfigsForPack` parity between `src/` and `_shared/`, or update `src/validateReviewPipeline.ts:3` to stop claiming the files are identical.
3. **Replace the `as any` casts in `qualityGateService.ts:166–197`** with the typed `securityFindings`/`complianceFindings`/`complianceStatus` fields that already exist on `TyneValidateReviewResult`.
4. **Add tests for the three untested context modules** before they pick up more callers — `codeReviewContextCollector.ts`, `validationContextResolver.ts`, `validationContextTypes.ts`.
5. **Squash the migration history** — delete the two empty `enrich_pm_task_context` files and collapse the duplicate pair into one.
6. **Update `AUDIT_AND_ARCHITECTURE.md`** — refresh the quality-module table, add a `src/services/` section, and correct the `codeReviewService` status.

---

## 6. Full file inventory

### New source files (32)

| File | Lines |
|---|---|
| `src/actionEngine.ts` | 168 |
| `src/codeReviewContextCollector.ts` | 152 |
| `src/codeReviewService.ts` | 73 |
| `src/codeReviewTypes.ts` | 267 |
| `src/codebaseContextService.ts` | 231 |
| `src/pevAgents.ts` | 211 |
| `src/qualityGateService.ts` | 231 |
| `src/reviewDiagnosticsService.ts` | 148 |
| `src/reviewTrendService.ts` | 218 |
| `src/scopeDriftHarness.ts` | 221 |
| `src/safeCodebaseContextCollector.ts` | 71 |
| `src/taskViewModel.ts` | 51 |
| `src/validateReviewPipeline.ts` | 186 |
| `src/validationContextResolver.ts` | 290 |
| `src/validationContextTypes.ts` | 142 |
| `src/gitHookService.ts` | 200 |
| `src/quality/acceptanceCriteriaValidator.ts` | 475 |
| `src/quality/architectureRules.ts` | 74 |
| `src/quality/astFacts.ts` | 277 |
| `src/quality/cloneDetector.ts` | 78 |
| `src/quality/complexityMetrics.ts` | 117 |
| `src/quality/consistencyMiner.ts` | 121 |
| `src/quality/dependencyVulnerabilityChecker.ts` | 274 |
| `src/quality/injectionDetector.ts` | 209 |
| `src/quality/performancePatterns.ts` | 55 |
| `src/quality/qualityEngine.ts` | 149 |
| `src/quality/qualityScoring.ts` | 153 |
| `src/quality/qualityTypes.ts` | 120 |
| `src/quality/secretsDetector.ts` | 265 |
| `src/quality/semgrepAdapter.ts` | 57 |
| `src/quality/treeSitterRuntime.ts` | 130 |
| `src/quality/tsCompilerAst.ts` | 122 |
| `src/quality/vibeCodeScanner.ts` | 577 |
| `src/services/reviewFileParallel.ts` | 133 |
| `src/services/scopeDriftExplainer.ts` | 517 |

### New backend / infra

- `supabase/functions/tyne-code-review/index.ts` — 1,016 lines
- `supabase/functions/_shared/pevAgents.ts` — identical to `src/`
- `supabase/functions/_shared/scopeDriftHarness.ts` — identical to `src/`
- `supabase/functions/_shared/validateReviewPipeline.ts` — diverged, see §4
- `.github/workflows/eval-harness.yml` — new CI job
- `eval/runEval.ts` + `eval/golden/seed.json`
- 5× `supabase/migrations/*.sql` — see §4
- `media/tree-sitter/web-tree-sitter.wasm` — 201 KB

### New tests (14 files)

`acceptanceCriteriaValidator.test.ts`, `actionEngine.test.ts`, `aiHardening.test.ts`, `astFacts.test.ts`, `codeQualityEngine.test.ts`, `codeReview.test.ts`, `dependencyVulnerabilityChecker.test.ts`, `injectionDetector.test.ts`, `reviewFileParallel.test.ts`, `scopeDriftExplainer.test.ts`, `scopeDriftHarness.test.ts`, `secretsDetector.test.ts`, `validateReviewPipeline.test.ts`, `vibeCodeScanner.test.ts`

---

*Generated from source + git + test-run analysis of `/Users/dipanjanroy/Desktop/TYNE` at commit `787ae19` · 2026-07-19*
