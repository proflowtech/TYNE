# Tyne Code Review — Architecture, Harness & LLM Report

**Date:** 2026-07-19  
**Scope:** Merged Validate & Review pipeline (post codeReview → validateReview consolidation)  
**Source:** Live codebase under `src/` and `supabase/functions/`

---

## 1. Executive verdict

Tyne now has **one PR review pipeline**:

```
UI / commands
  → ValidateReviewService.runReview(mode)
    → local deterministic engines + scanners
      → privacy sanitizer
        → tyne-validate-review (managed / BYOK meta / local aggregates)
          → optional PEV specialists + scope drift
            → merged TyneValidateReviewResult (+ ETA / warnings / timings)
```

| Generation | Status |
|------------|--------|
| `codeValidationService` (goal/BYOK task validation) | **Kept** — different product surface |
| `codeReviewService` + `tyne-code-review` | **Deleted** — routed to Validate & Review |
| `validateReviewService` + `tyne-validate-review` | **Canonical PR review** |

---

## 2. Architecture diagram (stages)

| # | Stage | Module / function | Notes |
|---|--------|-------------------|-------|
| 1 | Entry | `TyneSidebarProvider._handleRunValidateReview` / `_handleRunCodeReview` | Technical Review → `quick`/`full` |
| 2 | Scope | `resolveReviewScope`, `collectLastEditedCode` | staged / unstaged / commit |
| 3 | Size & mode | `classifyPrSize`, `autoSelectMode`, `rankFilesByRisk` | huge→triage, large→quick |
| 4 | Context | `collectSafeCodebaseContext` | capped by mode |
| 5 | Static | `collectStaticAnalysis` | skip full `tsc` if >20 files / large |
| 6 | Parallel local | `reviewFilesInParallel` (`BATCH_SIZE=5`) | content-hash cache |
| 7 | Quality | `runLocalQualityEngine` | vibe/clone/arch/complexity/… |
| 8 | Security | secrets, injection, deps, AI slop, AC | can BLOCK |
| 9 | Privacy | `sanitizeValidateReviewPayload` | strips BYOK keys |
| 10 | Edge | `tyne-validate-review` | mode-aware packs + budget |
| 11 | PEV | Sentinel / Staff / PM Ghost Cop | Pro/Max |
| 12 | Explain | `explainScopeDrift` | client, budget-gated |
| 13 | UI | progress + ETA + warnings | `review_progress` events |

---

## 3. Review modes

From `src/reviewPerformance.ts` → `MODE_CONFIGS`:

| Mode | Deep LLM files | Quick file cap | Local quality | Client PEV explain | Compliance |
|------|----------------|----------------|---------------|--------------------|------------|
| `full` | 40 | 200 | Yes | Yes | Yes (Max) |
| `quick` | 15 | 100 | Yes | No | No |
| `triage` | 0 | 300 | Yes | No | No |

**Auto-downgrade (never upgrades):**

- `huge` (>100 files or >5000 lines) + requested full/quick → **triage**
- `large` (>40 files or >1500 lines) + requested full → **quick**

Surfaced on result as `actualModeUsed`, `prSizeClass`, `reviewWarnings[]`.

---

## 4. Budgets & concurrency

| Control | Value | Constant |
|---------|-------|----------|
| Client global budget | 90s | `GLOBAL_REVIEW_BUDGET_MS` |
| Client HTTP timeout | 300s | `REVIEW_TIMEOUT_MS` |
| Edge function budget | 60s | `EDGE_FUNCTION_BUDGET_MS` |
| Chunk LLM timeout | 60s | `CHUNK_LLM_TIMEOUT_MS` |
| Local / edge batch size | 5 | `BATCH_SIZE` / `REVIEW_FILE_BATCH_SIZE` |
| File-review cache | 80 entries | workspaceState `tyne.fileReviewCache` |

**Principle:** partial findings + warnings > hard timeout with nothing.

---

## 5. Local quality & security modules (`src/quality/`)

| Module | Role |
|--------|------|
| `qualityEngine.ts` | Orchestrator |
| `astFacts.ts` / `tsCompilerAst.ts` / `treeSitterRuntime.ts` | Parsing |
| `vibeCodeScanner.ts` | AI slop / vibe findings |
| `cloneDetector.ts` | Hash-bucketed clone detection |
| `complexityMetrics.ts` | Complexity / nesting |
| `consistencyMiner.ts` | Naming / patterns |
| `architectureRules.ts` | Layer imports |
| `performancePatterns.ts` | Hot-path smells |
| `secretsDetector.ts` | Hardcoded secrets |
| `injectionDetector.ts` | SQL / NoSQL / command |
| `dependencyVulnerabilityChecker.ts` | `npm audit` on manifest churn |
| `acceptanceCriteriaValidator.ts` | AC coverage |
| `semgrepAdapter.ts` | Optional Semgrep |
| `qualityScoring.ts` | Scorecard / debt |

Supporting services:

- `src/services/reviewFileParallel.ts` — batched per-file local review + cache  
- `src/services/scopeDriftExplainer.ts` — Staff vs PM adjudication narrative  

---

## 6. LLM report

### 6.1 Managed catalogs (AICredits)

| Catalog | Use |
|---------|-----|
| `validate_review_primary` | Free single-pass |
| `validate_review_chunk` | Pro/Max file packs |
| `validate_review_secondary` | PEV Sentinel / Staff / A2A |
| `validate_review_final` | Max judge (optional) |

### 6.2 Direct BYOK (on-device)

| Provider | Model |
|----------|-------|
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-sonnet-4-20250514` |

Keys live in VS Code SecretStorage. Edge **rejects** `byokKey` / `byokProvider` on the wire.

### 6.3 Privacy modes

| Mode | Behavior |
|------|----------|
| `cloud` | Full payload to managed edge |
| `privacy_enhanced` | Client redaction before egress |
| `local_compliance` | Aggregates / titles / hashes only; forced by `local_only` residency |

### 6.4 Edge chunking

- `packDiffByFiles({ maxFilesPerPack: 1, maxCharsPerPack: 28_000 })`
- Concurrent batches of **5**
- **Cache check first** (`model_info.fileCache`)
- `triage`: no fresh LLM packs  
- `quick`: ≤15 fresh packs  
- Stop near budget−10s with skip warnings  
- `rotateConfigsForPack` + 2 fallbacks  

### 6.5 PEV agent roles

| Agent | Responsibility |
|-------|----------------|
| **Sentinel** | Security / compliance adjudication |
| **Staff Engineer** | Logic / perf + A2A “required dependency?” |
| **PM Ghost Cop** | Ticket AC vs diff matrix |
| **Scope explainer** | Human-readable winner + `merge_as_is` / `request_split` / `request_clarification` |

---

## 7. Harness & eval

### 7.1 Shared pure modules (duplicated src ↔ `_shared`)

- `scopeDriftHarness.ts` — Golden Contract, matrix, A2A resolve  
- `pevAgents.ts` — prompts + verify schemas  
- `validateReviewPipeline.ts` — pack / hash / cache / (edge) `mapPool`  
- `reviewPerformance.ts` — modes, ranking, budgets, progress  

### 7.2 Offline eval (`eval/`)

```bash
npm run test:eval
```

Latest `eval/last-report.json`:

| Metric | Value |
|--------|-------|
| Gate | **PASS** |
| Accuracy | 1.0 |
| Threshold | 0.66 |
| Fixtures | HIPAA PHI log, scope-drift email, clean OAuth |

Judges are **deterministic** today. `EVAL_LLM=1` is reserved for future live LLM-as-judge.

### 7.3 Perf synthetic suite

`src/tests/largeRepoPerformance.test.ts` + `reviewPerformance.test.ts`:

| Scenario | Gate |
|----------|------|
| 50-file local pipeline | &lt;20s |
| 100-file clone detect | &lt;3s |
| 150-file auto-downgrade | → triage |
| 300-file classify | no throw |

---

## 8. Result shape (architecture-relevant)

On `TyneValidateReviewResult`:

- **Execution:** `actualModeUsed`, `requestedMode`, `prSizeClass`, `reviewWarnings`, `stageTimings`
- **Quality:** `qualityScore`, `qualityScorecard`, `debtMinutes`, `aiSlop`, `vibeCodeRisk`
- **Security:** `securityFindings` (+ runtime `secretDetection` / `injectionScan` / `dependencyScan`)
- **PM:** `driftMatrix`, `scopeDriftExplanation`, `acValidation`, `pendingGoals`
- **Privacy:** `privacyInfo.llmExecutionPath`, residency fields
- **UX:** progressive findings via `review_progress` / `review_partial_result`; ETA status line

---

## 9. Known gaps

1. **Edge PEV vs client mode** — `quick`/`triage` skip client explainer, but Pro/Max edge may still run specialists. Align with `payload.mode`.  
2. **Eval is deterministic-only** — no live LLM regression yet.  
3. **`codeValidationService` still separate** — goal validation ≠ PR review; optional future adapter.  
4. **ETA is heuristic** — calibrate from `stageTimings` once enough runs exist.  

---

## 10. Principles in force

1. Local deterministic first.  
2. Never hard-fail empty — return partial + warnings.  
3. Downgrade modes only.  
4. Cache by content hash before expensive work.  
5. Rank files by risk — LLM attention is scarce.  

---

## 11. Key paths

| Path | Role |
|------|------|
| `src/validateReviewService.ts` | Client pipeline coordinator |
| `src/reviewPerformance.ts` | Modes / budgets / ranking |
| `src/quality/qualityEngine.ts` | Deterministic orchestrator |
| `src/services/reviewFileParallel.ts` | Batched local file review |
| `src/services/scopeDriftExplainer.ts` | Explainable drift |
| `supabase/functions/tyne-validate-review/index.ts` | Managed review + PEV |
| `eval/runEval.ts` | Offline harness gate |
| `media/tyne.js` | Report UI + ETA |

---

*Interactive twin: Cursor canvas `code-review-architecture-report.canvas.tsx`.*
