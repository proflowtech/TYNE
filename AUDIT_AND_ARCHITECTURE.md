# Tyne — AI Coding Review Harnessing System: Audit Report & Architecture

## 1. Executive Summary

**Tyne** is a VS Code extension (v0.1.0) that provides a **goal-enforcement layer for AI-assisted coding**. It anchors each coding session to a stated goal (from PM tickets or manual thread), isolates work on dedicated git branches, validates code changes against acceptance criteria, runs multi-dimensional code review (correctness, security, compliance, quality), and automates PM-ticket lifecycle tasks.

The system follows a **hybrid local+cloud architecture** — deterministic analysis runs on-device, LLM inference routes through a managed backend (AICredits API) or directly to provider APIs via BYOK.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              TyneSidebarProvider (WebView)           │ │
│  │   Tasks (Thread | Tasks tabs) | Validate & Review   │ │
│  │   Branches | Commits | Time | Automation | Settings │ │
│  └──────────┬──────────────────────────────────────────┘ │
│             │                                            │
│  ┌──────────▼──────────────────────────────────────────┐ │
│  │               Core Services Layer                    │ │
│  │                                                      │ │
│  │  CodeValidationService    │  CodeReviewService       │ │
│  │  ValidateReviewService    │  QualityGateService      │ │
│  │  PmTaskIntelligenceService│  TaskAutomationService   │ │
│  │  DriftDetector            │  CodeChangeWatcher       │ │
│  │  GitCommitWatcher         │  ReviewDiagnosticsService│ │
│  └──────────┬──────────────────────────────────────────┘ │
│             │                                            │
│  ┌──────────▼──────────────────────────────────────────┐ │
│  │           Local Deterministic Engines                │ │
│  │  ┌──────────────────┐  ┌──────────────────────────┐ │ │
│  │  │ Quality Engine    │  │ Privacy/Local Review     │ │ │
│  │  │ • AST Facts       │  │ • SensitiveDataScanner   │ │ │
│  │  │ • Complexity      │  │ • LocalRedactionEngine   │ │ │
│  │  │ • Clone Detector  │  │ • LocalReviewEngine      │ │ │
│  │  │ • Vibe Scanner    │  │ • LocalSecurityEngine    │ │ │
│  │  │ • Consistency     │  │ • DataClassification     │ │ │
│  │  │ • Architecture    │  │ • EvidenceEngine         │ │ │
│  │  │ • Performance     │  │ • ComplianceEngine       │ │ │
│  │  │ • Semgrep Adapter │  │ • DataFlowEngine         │ │ │
│  │  └──────────────────┘  └──────────────────────────┘ │ │
│  └──────────┬──────────────────────────────────────────┘ │
│             │                                            │
│  ┌──────────▼──────────────────────────────────────────┐ │
│  │           AI Provider Layer                          │ │
│  │  ┌──────────────┐  ┌──────────────┐                 │ │
│  │  │ Anthropic    │  │ OpenAI       │                 │ │
│  │  │ Provider     │  │ Provider     │                 │ │
│  │  └──────┬───────┘  └──────┬───────┘                 │ │
│  │         │ (BYOK)          │ (BYOK)                   │ │
│  │         └────────┬────────┘                          │ │
│  │                  ▼                                   │ │
│  │         Direct BYOK (no backend relay)               │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS (fetch)
┌──────────────────────▼──────────────────────────────────┐
│              Supabase Backend (Edge Functions)            │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐│
│  │           Review & Validation Functions               ││
│  │  tyne-validate-review (3758 lines) — Main review     ││
│  │  tyne-code-review  — Legacy code review              ││
│  │  generate-commit   — Deep review + commit synthesis ││
│  │  pm-task-intelligence — Ticket enrichment (LLM)      ││
│  │  pm-task-validation  — PM validation (LLM)           ││
│  │  usage             — Quota/usage tracking            ││
│  └──────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────┐│
│  │           OAuth & Integration Functions               ││
│  │  jira-oauth-* | linear-oauth-* | *-api-request      ││
│  │  atlassian-* | linear-* | dodo-webhook              ││
│  └──────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────┐│
│  │           Compliance Subsystem                        ││
│  │  complianceEngine | complianceBlocking               ││
│  │  dataClassification | dataFlowEngine                 ││
│  │  evidenceEngine | evidenceRedaction                  ││
│  │  policyRegistry | policyLoader                       ││
│  │  frameworks/*  — HIPAA, SOC2, PCI, GDPR, etc.       ││
│  └──────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Extension Entry Point (`extension.ts`)

- Single activation entry — registers the `TyneSidebarProvider` webview, URI handlers (Jira + Linear OAuth sharing one handler), and all VS Code commands.
- Commands: Set BYOK key, Connect GitHub/Jira/Linear, Validate & Review, Code Review, Diagnostics, Logout.

### 3.2 Sidebar Provider (`TyneSidebarProvider.ts`) — ~5,368 lines

The largest file — acts as the **communication bridge** between the VS Code webview (HTML/JS) and the extension's backend services. Handles:
- Thread lifecycle (create, start, merge, undo)
- Validation & Review triggers
- Task pull/search/sync from Jira/Linear
- Commit clustering and synthesis
- Time tracking
- Automation (Project Lead Mode)
- Drift detection subscription
- Quality gate evaluation

### 3.3 Validation & Review Pipeline

**Three generations of review exist:**

| Feature | File | Approach | Status |
|---------|------|----------|--------|
| Code Validation (v1) | `codeValidationService.ts` | Direct LLM call (managed/BYOK) — validates code diff against task goal | Legacy |
| Code Review (v2) | `codeReviewService.ts` | Full code review — correctness, security, maintainability | Legacy |
| Validate & Review (v3) | `validateReviewService.ts` | Combined PM alignment + code review + security + compliance + quality | **Current** |

**Validate & Review pipeline stages** (in `validateReviewService.ts`):
1. **Scope resolution** — staged > unstaged > last commit
2. **Last edited code collection** — git diff + changed files
3. **Safe codebase context** — limited context (never full repo)
4. **Static analysis** — on-device error/warning collection
5. **Local quality engine** — vibe code, complexity, clones, consistency, architecture, performance, Semgrep
6. **Guardrail loading** — custom rules (Max tier only)
7. **Direct BYOK** — client→provider (no backend relay for BYOK)
8. **Privacy gate** — sanitize/redact before egress
9. **Edge function call** — payload sent to Supabase Edge Function
10. **Result merging** — quality scores + LLM findings + compute breakdown

### 3.4 Local Code Quality Engine (`src/quality/`)

| Module | Role |
|--------|------|
| `astFacts.ts` | Extract AST facts (functions, classes, imports) via tree-sitter |
| `complexityMetrics.ts` | Cyclomatic complexity, nesting depth |
| `vibeCodeScanner.ts` | Detect "vibe coding" smells: placeholders, empty catches, hallucinated imports, console leftovers |
| `cloneDetector.ts` | Similar code detection across changed/nearby files |
| `consistencyMiner.ts` | Naming and error-handling consistency |
| `architectureRules.ts` | Layer violation detection (e.g., UI imports DB directly) |
| `performancePatterns.ts` | Hot loops, sync I/O patterns |
| `semgrepAdapter.ts` | Optional Semgrep rule integration |
| `treeSitterRuntime.ts` | Tree-sitter runtime for language parsing |
| `tsCompilerAst.ts` | TypeScript compiler API integration |
| `qualityScoring.ts` | Score aggregation (correctness, maintainability, vibe, architecture) |

### 3.5 Privacy & Local Compliance (`src/privacy/`)

Three privacy modes:
- **Cloud** — full payload to backend
- **Privacy Enhanced** — client-side redaction of sensitive data before egress
- **Local Compliance** — all processing stays on-device; backend receives aggregates only

| Module | Role |
|--------|------|
| `sensitiveDataScanner.ts` | Regex-based scanner for secrets, JWTs, emails, phones, PHI, PCI, PII |
| `localRedactionEngine.ts` | Replace sensitive matches with `[REDACTED_*]` placeholders |
| `payloadSanitizer.ts` | Sanitize full request object before network call |
| `directByokReview.ts` | Direct client→provider LLM call for BYOK |
| `residencyRouter.ts` | Route to US/EU/Enterprise endpoints |
| `localIntelligence/` | Full on-device compliance engine (parallel to backend compliance) |

### 3.6 AI Providers (`src/aiProviders/`)

| Provider | Endpoint | Default Model | Notes |
|----------|----------|--------------|-------|
| Anthropic | `api.anthropic.com/v1/messages` | `claude-sonnet-5` | BYOK only |
| OpenAI | `api.openai.com/v1/chat/completions` | `gpt-4o` | BYOK only |
| Managed | Supabase Edge (`generate-commit`) | Tier-based routing | AICredits-proxied |

### 3.7 Backend Supabase Edge Functions (26 total)

**Review functions:**
- `tyne-validate-review` (~3,758 lines) — Main review orchestrator: PEV sub-agents (Sentinel, Staff Engineer, PM Ghost Cop), compliance engine, data-flow analysis, model routing via AICredits
- `tyne-code-review` — Legacy review function
- `generate-commit` — Commit synthesis + deep review
- `pm-task-intelligence` — LLM-based ticket enrichment (goal extraction, subtasks, AC)
- `pm-task-validation` — Code diff vs. acceptance criteria scoring

**OAuth/Integration:**
- Jira: `jira-oauth-state`, `jira-oauth-callback`, `complete-jira-oauth-exchange`, `get-jira-tokens`, `jira-api-request`, `list-jira-projects`, `save-jira-project-mapping`
- Linear: `linear-oauth-state`, `linear-oauth-callback`, `complete-linear-oauth-exchange`, `linear-api-request`, `list-linear-teams`, `save-linear-team-mapping`
- Atlassian: `atlassian-personal-data-report`, `atlassian-report-oauth-callback`, `atlassian-report-oauth-start`

**Other:** `usage`, `ping`, `dodo-webhook`, `validate-code` (empty)

### 3.8 PEV Multi-Agent Architecture

The `tyne-validate-review` edge function runs **three sub-agents** sequentially:

1. **Sentinel** — Security-focused: detects secrets, injection, data exposure, auth issues
2. **Staff Engineer** — Code correctness & architecture: race conditions, memory safety, algorithmic issues
3. **PM Ghost Cop** — Scope drift detection: maps developer additions against ticket acceptance criteria, then **A2A (Agent-to-Agent)** debate with the Staff Engineer to distinguish genuine drift from required dependencies

### 3.9 Compliance Subsystem

Both backend (`supabase/functions/tyne-validate-review/compliance/`) and local (`src/privacy/localIntelligence/`) contain parallel implementations covering:
- **Frameworks:** HIPAA, SOC2, PCI_DSS, GDPR, ISO27001, NIST_CSF, NIST_800_53, FEDRAMP, CCPA_CPRA, SOX
- **Pipeline:** data classification → data-flow analysis → rule evaluation → evidence collection → scoring → regression detection
- **Policies:** Hybrid — bundled rules + DB-stored custom policies (Max tier)

### 3.10 Project Management Integrations

| Tool | Auth | Capabilities |
|------|------|-------------|
| GitHub | Device flow OAuth | Auth, identity, draft PRs |
| Jira | OAuth 2.0 (3-legged) | Pull tasks, enrich with LLM, update status, post comments |
| Linear | OAuth 2.0 | Pull tasks, enrich with LLM, update status |

### 3.11 Task & Automation

- **`taskPullService.ts`** / **`taskProviderRegistry.ts`** / **`taskProviderRuntime.ts`** — Adapter pattern for PM tool abstraction
- **`taskAutomationService.ts`** — Project Lead Mode: auto workspace prep, drift detection, AI commit synthesis, auto ticket close
- **`taskSyncService.ts`** — Bidirectional status sync, conflict detection
- **`multiProviderTaskPullService.ts`** — Unified pull across all connected providers

### 3.12 Time Tracking

- **`timeTrackingService.ts`** / **`timeSummaryService.ts`** / **`manualTimeEntryService.ts`** — Per-thread time tracking with manual entries, session generation, daily/weekly/monthly summaries

### 3.13 Action Engine (`actionEngine.ts`)

Classifies review findings into three action classes:
- **`applyable`** — Verified code patch, one-click apply
- **`agent`** — Cursor/VS Code agent handoff prompt
- **`guidance`** — Instructional advice only

### 3.14 Quality Gate (`qualityGateService.ts`)

Pre-commit / pre-push gates evaluated against review results:
- Critical findings → block
- High severity → warn
- Missing tests → warn
- Secrets detected → block

### 3.15 Eval Harness (`eval/runEval.ts`)

Offline deterministic evaluation against golden fixtures (seed.json):
- Tests: `hipaa_leak`, `scope_drift`, `clean`
- Deterministic judges simulate PEV agents
- Threshold-based pass/fail (default 0.66 for seed, 0.99 for full)
- Optional LLM-as-judge mode (`EVAL_LLM=1`)

---

## 4. Data Flow: End-to-End Validate & Review

```
User triggers V&R (Cmd+Shift+T)
        │
        ▼
resolveReviewScope() → git diff (staged/unstaged/last commit)
        │
        ▼
collectLastEditedCode() → diff + changedFiles
        │
        ▼
collectSafeCodebaseContext() → nearby files, imports, blast radius
        │
        ▼
collectStaticAnalysis() → TypeScript compiler diagnostics
        │
        ▼
runLocalQualityEngine() → AST facts, complexity, clones, vibe, architecture, performance, Semgrep
        │
        ▼
loadCustomGuardrails() → .tyne/review-rules.md (Max tier)
        │
        ▼
resolvePrivacySettings() → cloud | privacy_enhanced | local_compliance
        │
        ├── BYOK mode? → runDirectByokReview() → AI provider directly
        │                    (key never leaves client)
        │
        ├── Privacy Enhanced? → redactSensitiveText() on diff + context
        │
        ├── Local Compliance? → buildLocalComplianceSummary() (all on-device)
        │                    → strip source code from payload
        │
        ▼
_sanitizeValidateReviewPayload() → strip BYOK keys, redact/aggregate
        │
        ▼
_callEdgeFunction() → POST to tyne-validate-review (Supabase)
        │
        ▼
  [Backend Pipeline]
        │
        ├── Parse request, validate auth (GitHub token)
        ├── Load tier policy
        ├── Pack diff by files (chunks of ~3 files / ~28KB)
        ├── Check file-review cache → reuse cached findings for unchanged chunks
        │
        ├── PEV Stage 1: Sentinel (security scan via LLM)
        ├── PEV Stage 2: Staff Engineer (correctness/architecture via LLM)
        ├── PEV Stage 3: PM Ghost Cop (scope drift matrix)
        │      └── A2A debate: Staff Engineer adjudicates drift items
        │
        ├── Compliance pipeline:
        │      classifyData → analyzeDataFlows → evaluateComplianceRules
        │      → collectEvidence → detectRegressions → score
        │
        ├── Merge agent findings, apply scorecard
        ├── Compute language/contribution breakdown
        └── Return result
        │
        ▼
Merge quality scores + AI findings + compliance
    → compactReviewLimits() → return to webview
```

---

## 5. Security Audit

### 5.1 BYOK (Bring Your Own Key)
- **API keys never stored in backend** — Phase 3 architecture ensures direct client→provider calls
- Keys stored in VS Code's secure `context.secrets` (OS keychain-backed)
- Backend payload explicitly strips `byokKey`/`byokProvider` fields before egress

### 5.2 Source Code Privacy
- **Cloud mode** — full diff sent to backend
- **Privacy Enhanced** — regex-based redaction of secrets, PII, PHI, PCI before egress
- **Local Compliance** — zero source code leaves the machine; only aggregate scores and hash-only evidence references are sent

### 5.3 Authentication
- GitHub OAuth device flow — no password stored
- Jira/Linear OAuth 2.0 — tokens stored in VS Code secrets
- All edge function calls carry GitHub Bearer token + machine ID header

### 5.4 Prompt Injection Hardening
- User content wrapped in `<untrusted_*>` tags
- System prompt instructs model to treat `<untrusted_*>` as data, not instructions
- JSON parsing with schema validation (e.g., `verifySentinelOutput`, `verifyStaffEngineerOutput`)

### 5.5 Key Findings (from `PM_INTELLIGENCE_LLM_AUDIT_REPORT.md`)
- All managed LLM calls route through AICredits API — no remaining direct OpenAI/Anthropic keys
- Three functions use managed LLMs: `generate-commit`, `pm-task-intelligence`, `pm-task-validation`
- AICredits base URL: `https://api.aicredits.in/v1`

---

## 6. Code Quality Observations

### Strengths
- **Strong type system** — Extensive TypeScript types across all domains
- **Deterministic fallback** — Local quality engine runs before LLM; results survive LLM failures
- **Caching** — Per-file content hash caching to avoid re-reviewing unchanged files
- **Privacy-first design** — Multiple modes, redaction, residency routing built in
- **Extensive test suite** — 23 test files covering most subsystems
- **PEV multi-agent** — Novel agent-to-agent debate for scope drift resolution
- **Dual implementation** — Client and backend share identical pure functions (e.g., `validateReviewPipeline.ts`, `scopeDriftHarness.ts`, `pevAgents.ts`)

### Areas of Concern

| Area | Observation |
|------|-------------|
| **`TyneSidebarProvider.ts` (~5,368 lines)** | Single giant file responsible for all webview ↔ backend messaging. High cyclomatic complexity; difficult to test and maintain. |
| **Duplicate code** | `scopeDriftHarness.ts`, `pevAgents.ts`, `validateReviewPipeline.ts` duplicated verbatim in `src/` and `supabase/functions/_shared/`. Maintenance risk if they diverge. |
| **Validation Types overlap** | `validationTypes.ts` vs `validateReviewTypes.ts` vs `codeReviewTypes.ts` — overlapping type systems with similar concepts (e.g., status types). Risk of confusion. |
| **Legacy review pathways** | Three generations of review (CodeValidationService → CodeReviewService → ValidateReviewService) coexist. The older two could be deprecated. |
| **Hardcoded URLs** | Supabase URLs hardcoded in many places (`mvzcfqjtleasuawvvmtg.supabase.co`) as defaults. Centralized config approach would be cleaner. |
| **Error handling** | Some `catch {}` blocks silently swallow errors. `pmTaskIntelligenceService.ts` line 79 intentionally swallows Jira failures with a comment. |
| **`ManagedProviderAdapter` coupling** | `codeValidationService.ts` has `ManagedProviderAdapter` calling `generate-commit` — tight coupling to a specific edge function URL. |
| **Test without LLMs** | Eval harness uses deterministic simulators for PEV agents; good for CI but misses LLM accuracy regressions. |

---

## 7. Recommendations

1. **Refactor `TyneSidebarProvider.ts`** — Split into domain-specific message handlers (ThreadHandler, ReviewHandler, TaskHandler, TimeHandler, AutomationHandler)
2. **Eliminate code duplication** — Use symlinks or a shared npm package for `_shared/` pure functions between `src/` and `supabase/functions/_shared/`
3. **Unify validation type system** — Consolidate overlapping types across `validationTypes.ts`, `validateReviewTypes.ts`, `codeReviewTypes.ts`
4. **Deprecate legacy review services** — Mark `codeValidationService.ts` and `codeReviewService.ts` for removal once all consumers migrate to `ValidateReviewService`
5. **Centralize configuration** — Create a single config provider for Supabase URLs, model mappings, and feature flags
6. **Improve CI test coverage for LLM accuracy** — Add periodic LLM-as-judge evaluation runs against golden fixtures
7. **Add error monitoring** — Replace silent `catch {}` blocks with structured logging/monitoring
8. **Simplify compliance dual-implementation** — Consider using the local intelligence module as the single source of truth and only egressing the `egressSummary` to the backend

---

*Audit generated on 2026-07-19 from source analysis of `/Users/dipanjanroy/Desktop/TYNE`.*
*Total source files audited: ~117 (94 in `src/`, 26 edge functions, web components, eval harness)*
