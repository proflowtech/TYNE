# Tyne — Core Architecture (by user flow)

This document describes Tyne the way a developer actually meets it: flow by flow, from
installing the extension to shipping a branch. Each flow starts with what the developer
sees, then traces the call path through every layer that participates.

Source of truth: `src/` (extension host), `media/` (webview), `supabase/functions/` (backend).

---

## 0. The layer cake

```
┌─────────────────────────────────────────────────────────────────┐
│  Webview UI            media/tyne.js · tyne.css                  │
│  4 pages on an icon rail: Thread · Tasks · Time · Settings       │
└───────────────▲─────────────────────────────┬───────────────────┘
                │  postMessage (results)      │  postMessage (intents)
┌───────────────┴─────────────────────────────▼───────────────────┐
│  TyneSidebarProvider.ts  — single message router (~120 cases)    │
│  owns TyneState, tier, all orchestration                         │
└───────────────▲─────────────────────────────┬───────────────────┘
                │                             │
┌───────────────┴─────────────────────────────▼───────────────────┐
│  Domain services (src/*)                                         │
│  git · tasks/PM · validate&review · quality · privacy ·          │
│  automation · time · analytics                                   │
└───────────────▲─────────────────────────────┬───────────────────┘
                │ HTTPS (bearer)              │
┌───────────────┴─────────────────────────────▼───────────────────┐
│  Supabase Edge Functions (Deno)                                  │
│  tyne-validate-review · pm-task-intelligence · tyne-story-       │
│  decompose · jira/linear OAuth + API proxy · dodo billing        │
└───────────────▲─────────────────────────────┬───────────────────┘
                │                             │
┌───────────────┴─────────────────────────────▼───────────────────┐
│  Postgres (RLS)  user_profiles · validate_review_reports ·       │
│  finding_feedback · compliance_* · ai_usage · licenses           │
└─────────────────────────────────────────────────────────────────┘
```

**Two hard architectural rules the code follows:**

1. The webview never touches git, the filesystem, or the network. It posts an intent
   (`{ type: 'buttonClick', action: 'startThread' }`); the host does the work and posts a
   result back. Every capability is reachable through that one protocol.
2. Everything that *can* be decided locally *is* decided locally. Secrets, injection,
   complexity, clones, AI-slop, acceptance-criteria matching all run on the developer's
   machine before any payload is built. The LLM explains and ranks; it never gets a veto
   over deterministic findings (`applySecurityGuardrails` / `applyComplianceGuardrails`
   re-assert them after every model pass).

**State locations**

| What | Where | Module |
| --- | --- | --- |
| Thread state (task, goal, subtasks, branch, last result) | `workspaceState` under `tyne.*` | `stateManager.ts` |
| GitHub token, BYOK keys, Jira/Linear tokens | `context.secrets` | `deviceAuth.ts`, `byokKeyService.ts` |
| Cached tasks + sync status | `workspaceState` | `taskCacheService.ts` |
| Branch↔task links | `workspaceState` | `branchMetadataService.ts` |
| File-review cache (hash → findings) | `workspaceState` `tyne.fileReviewCache` | `validateReviewPipeline.ts` |
| Reports, feedback, compliance history, usage | Postgres | edge functions |

---

## Flow 1 — Install and activate

**Developer:** installs Tyne, opens a git workspace, clicks the Tyne icon.

`package.json` activates on `onStartupFinished` and `onUri`. `activate()` in
[extension.ts:58](src/extension.ts:58) wires everything in one pass:

- `initializeTaskProviderRuntime(context)` — makes the PM adapters context-aware.
- `getEffectiveAuthToken(context)` — determines signed-in state *before* the provider is
  constructed, so the UI renders the right screen on first paint.
- **One** URI handler that delegates to both the Jira and Linear handlers
  ([extension.ts:64](src/extension.ts:64)) — VS Code permits only one per extension, and a
  second registration throws and kills activation.
- Webview provider with `retainContextWhenHidden: true` (the review runner survives tab
  switches).
- Three background watchers: `gitCommitWatcher` → `taskAutomationService`,
  `codeChangeWatcher` → validation reminders, `registerReviewDiagnostics` → the Problems
  panel + Quick Fix provider.
- ~20 commands, each of which focuses the sidebar first, then calls a public provider
  method (`triggerValidation`, `connectJira`, …). Commands are a thin façade over the same
  handlers the webview calls.

---

## Flow 2 — Sign in

**Developer:** clicks **Continue with GitHub**, gets a code, approves in the browser.

```
webview 'continueWithGitHub'
  → provider._continueWithGitHub()
     → githubOAuth.startGitHubDeviceFlow(clientId)   ── device+user code
     → openGitHubDeviceUri()                         ── browser
     → pollGitHubDeviceToken() under withProgress    ── cancellable
     → context.secrets['tyne_github_token']
     → provider.updateAuthenticationState(true) → user_profiles lookup → tier
```

There is a second, opt-in transport: `tyne.deviceAuthDogfood` switches to Tyne's own
device-auth (`deviceAuth.ts`, live or mock, with funnel telemetry). `getEffectiveAuthToken()`
is the single accessor that resolves whichever token exists — every backend call goes
through it, so the two auth paths never fork downstream logic.

The tier (`CORE` / `PRO` / `MAX`) loaded here is the gate for nearly everything later:
PM tool count, PM alignment, missing-test review, context budgets, compliance, guardrails.

---

## Flow 3 — Connect a PM tool

**Developer:** Settings → Integrations → Connect Jira.

```
'connectPmTool' → taskProviderRegistry.connectTool(context, tool, tier)
   ├─ free-tier check: 1 connected tool max (getAvailableProvidersForTier)
   ├─ ADAPTER_MAP[tool].connect()          jira | linear | asana | notion | monday
   └─ persist to workspaceState 'tyne.pmConnectedTools'
```

The Jira OAuth round trip crosses every layer, and is the template Linear follows:

```
jiraOAuth.ts ──POST──▶ edge jira-oauth-state      (signed state, CSRF)
   browser  ──────────▶ Atlassian consent
   callback ──────────▶ edge jira-oauth-callback  → vscode://tyne.tyne/... deep link
   URI handler ───────▶ edge complete-jira-oauth-exchange (code → tokens, server-side)
   tokens ────────────▶ context.secrets
   projects ──────────▶ edge list-jira-projects → user picks → save-jira-project-mapping
   all later reads ───▶ edge jira-api-request  (proxy; the client never holds the app secret)
```

`taskProviderAdapters.ts` normalizes all five providers behind
`TyneTaskProviderAdapter`, so everything above this line (cache, search, filters, thread
start, validation, automation) is provider-agnostic.

---

## Flow 4 — Pull tasks and pick one

**Developer:** Tasks page → tasks appear → filters/search → click one.

```
'pullTasks' → taskPullService.pullTasks(context, tool, input)
   syncState = 'syncing'  → adapter.pullTasks({assignedOnly, includeCompleted, updatedSinceDays:30})
   → taskCacheService.replaceTasksForProvider()
   → syncState = 'online' + lastSyncedAt + cachedTaskCount
   on failure → markTasksCachedOnlyForProvider() (offline read-only, never an empty list)
```

The cache is what makes the Tasks page instant and offline-tolerant; the network is only
ever a refresh. On top of the cache sit `taskSearchService`,
`advancedTaskFilterService`, `taskFilterPresetService` (saved/default presets),
`taskQueueRanking`, and `realTimeSyncService` for the active task.

**Opening a task** (`openTaskDetail`) does more than fetch: `taskEnrichmentService` +
`pmTaskIntelligenceService` call the `pm-task-intelligence` edge function, which returns a
structured `pmContext` — acceptance criteria, decisions, constraints, blockers, open
questions, attachment summaries, and a `developerTaskPlan`. That object is the contract
that Validate & Review later scores the diff against, so enrichment is not cosmetic: a task
with no AC and no goal is *refused* at validation time.

**Story → subtasks** (Pro/Max): `storyDecompositionService` runs an analyze → clarifying
questions → generate → create cycle against `tyne-story-decompose`, and can write the
subtasks back to Jira/Linear through `writableTaskService`.

---

## Flow 5 — Start Thread

**Developer:** picks a task, confirms the goal, clicks **Start Thread**.

`_startThread()` ([TyneSidebarProvider.ts:1763](src/TyneSidebarProvider.ts:1763)) is a
guard chain before it is a git operation:

1. Require `taskId`, `appName`, `goal`, and an actual git repo.
2. `sanitizeBranchName(taskId, taskTitle)` → `tyne/<task>-<slug>`.
3. Task already linked to a branch? → offer **Switch to Branch** instead of a duplicate.
4. Dirty working tree? → explicit warning that those changes ride along to the new branch.
5. Branch name already exists? → offer switch.
6. **Project Lead Mode** only: `workspacePrep.prepareWorkspace()` stashes and pulls the
   default branch first, streaming `prepStarted`/`prepComplete` to the UI.
7. `createBranch()` → `createBranchRecord()` (task↔branch↔repo link, commit count, head).
8. `state.status = 'weaving'`, persist, notify webview, start the drift watcher, refresh
   branch/commit/git-status panels.

After this point the thread is the unit of work: a goal, a ticket, a branch, and a set of
checkpoints, all recoverable from `workspaceState` after a reload.

---

## Flow 6 — Code (the background layer)

While the developer works with their AI assistant, three watchers run:

| Watcher | Trigger | Effect |
| --- | --- | --- |
| `driftDetector` | any file create/change | keyword-matches the path against the goal; `tyne.driftSensitivity` tunes strictness; debounced per file; posts a drift card with Keep / Park / Revert actions |
| `codeChangeWatcher` | net new lines, new diagnostics, session length | advisory Validate & Review reminder — threshold `50` lines, `20` min cooldown, `45` min session, all configurable, all rate-limited |
| `gitCommitWatcher` | new commit (git hook + polling) | `taskAutomationService.handleCommitDetected` → commit linking, metadata, clustering, PM automation triggers |

`timeTrackingService` accrues time against the active thread; `manualTimeEntryService`
covers the gaps.

---

## Flow 7 — Save Stitch (checkpoint)

**Developer:** clicks **Save Stitch**.

```
_saveStitch()
  → _evaluateQualityGate('pre_commit')          ── QualityGateService.evaluateGate();
                                                   blocks on critical findings, overridable
  → gitManager.saveStitch(taskId)               ── stage + commit, returns hash
  → state.stitchCount++, lastStitchTime
  → branchMetadataService.updateBranchRecord()  ── commitCount, head hash/message
  → webview: 'stitchSaved'
```

`_undoStitch()` is the symmetric rollback, behind a destructive-action confirmation.

---

## Flow 8 — Validate & Review (the core loop)

**Developer:** `Cmd/Ctrl+Shift+T`, or **Run Review** in the sidebar.

### 8a. Preconditions (host)

`_handleRunValidateReview` ([TyneSidebarProvider.ts:3253](src/TyneSidebarProvider.ts:3253))
refuses early and loudly rather than producing a weak review:

- signed in and holding an effective auth token;
- quota available (`validationUsageService.canRunValidation(tier, hasByok)`) — a failure
  posts `upgradeRequired: true` so the UI shows the upgrade CTA, not a generic error;
- **a Jira or Linear task must be selected** — Tyne scores a diff against a ticket, not a
  repo;
- that task must carry acceptance criteria *or* a goal/description.

It then builds `ReviewPmTaskContext` (ticket + AC + subtasks + decisions/constraints/
blockers/open questions + developer plan) and hands off to `ValidateReviewService`.

### 8b. Client pipeline (`validateReviewService.runReview`)

Every stage is wrapped in `timeStage`, and the whole run is bounded by
`GLOBAL_REVIEW_BUDGET_MS` with a hard `REVIEW_TIMEOUT_MS` of 300 s.

```
scope_resolution      resolveReviewScope() → staged | unstaged | last_commit | selected_commit
collect_last_edited   collectLastEditedCode() → diff + changed files (+ headSha)
sizing                classifyPrSize() → autoSelectMode(full|quick|triage)
                      auto-downgrade emits a visible warning, never a silent one
file planning         rankFilesByRisk() → selectFilesForMode() → deep vs summarized vs skipped
collect_context       collectSafeCodebaseContext() — capped to planned files
static_analysis       collectStaticAnalysis() — tsc skipped above 20 files / large PRs
budgeting             truncateDiff/truncateContext by tier policy (~30k/120k/200k chars)
parallel_file_review  reviewFilesInParallel() over per-file packs, keyed by content hash
local_quality_engine  complexity · clones · vibe-code · architecture · consistency
local scanners        secrets · injection · AI-slop · dependency CVEs (manifest changed)
AC validation         validateAcceptanceCriteria(ticket AC vs diff)
budget check          <8 s left → return a local-only result with an explicit warning
privacy               resolvePrivacySettings → cloud | privacy_enhanced | local_compliance
                      residencyRouter picks US/EU/enterprise endpoint
                      privacy_enhanced → redactSensitiveText before anything leaves
direct BYOK           non-free + key + not triage → runDirectByokReview() calls Anthropic/
                      OpenAI straight from the machine; the key never reaches Tyne's backend
sanitize              sanitizeValidateReviewPayload()
edge_function_call    POST tyne-validate-review
```

The file-review cache is the reason a re-run after a small edit is cheap:
`packDiffByFiles` → `hashContent` per file → `partitionPacksByCache` returns cached
findings for untouched files and only sends fresh packs.

Failure handling is deliberate: quota/auth errors **re-throw** (so the developer sees
"limit reached" and the upgrade path), while transport errors degrade to
`_finalizeLocalOnlyResult` — a real, if shallower, review rather than nothing.

### 8c. Edge pipeline (`supabase/functions/tyne-validate-review/index.ts`)

```
auth + hardware_blocklist + user_profiles → tier policy
record_usage_atomic()            ── atomic quota; 402 with a tier-specific message
fetchSuppressedFindings()        ── learning loop: previously-rejected findings, per repo
scanDeterministicSecurity()      ── pattern/data-flow scan, not the LLM's opinion
compliance (Max + opt-in)        ── policy DB + custom policies + regression vs history
review pass
   ├─ BYOK path: client review sanitized; still runs PM scope drift so pm_alignment
   │             and pendingGoals are never skipped
   └─ managed path (Core/Pro/Max alike):
        runChunkedManagedReview()  per-file packs · model rotation · prior cache
        runPevSpecialistAgents()   Sentinel (security) ‖ Staff Engineer, in parallel
        runScopeDriftA2A()         PM Ghost Cop: ticket requirements vs developer additions
        Max only: final judge pass (walkthrough, topConcerns, overallVerdict)
guardrails                       ── security + compliance findings re-asserted, status
                                    reconciled after every model pass
persist                          ── validate_review_reports (+ compliance_reviews/history)
```

Core, Pro and Max run the *same* pipeline shape; the differences are model routing
(via the aicredits policy), context budgets, PM alignment, missing-test review, custom
guardrails, compliance, and the Max-only final judge.

### 8d. Back on the client

```
postProcessReviewFindings()  merge local + LLM + PEV findings
   ├─ line-overlap clustering per file+category
   ├─ cross-file ruleId grouping → relatedLocations at 3+ hits
   └─ throttle cosmetic categories only (style, vibe_code, maintainability, performance)
publishReviewDiagnostics()   → Problems panel + Quick Fix
saveValidationResult()       → local history; buildValidationTraceComplete() → trace
postMessage                  → 'validateReviewResult' + 'validationComplete'
```

The review renders in **one** place — the Action Needed panel: walkthrough and verdict
first, critical/major expanded, everything else behind "Show N more suggestions".

---

## Flow 9 — Fix a finding

**Developer:** reads a finding and picks an action.

| Action | Path | Notes |
| --- | --- | --- |
| **Preview** | `previewFix` → `_handlePreviewFix` → native `vscode.diff` | read-only, so no `applyable` requirement |
| **Fix** | `applyFix` → workspace edit | only for `applyable` findings; governed by `tyne.actionEngine.autoApplyPolicy` (`applyable_only` \| `never`) |
| **Undo** | `undoFix` | reverses an applied patch |
| **Fix in IDE** | `agentFix` → `buildAgentPrompt` | hands the finding to the developer's AI agent as a ready-made prompt |
| **Quick Fix** | `reviewDiagnosticsService` code action | the lightbulb path, same patch |
| **👍/👎** | `findingFeedback` → `finding_feedback` table | feeds `fetchSuppressedFindings` — the repo-wide learning loop that quiets false positives on later runs |
| **Create task** | `createTaskFromFinding` | Pro/Max; writes a real ticket to Jira/Linear |

---

## Flow 10 — Tie the Knot (ship)

**Developer:** clicks **Tie the Knot**.

```
_tieTheKnot()
  require validationResult OR explicit override
  _evaluateQualityGate('pre_push')            ── blocking issues listed by name, overridable
  confirm ("Yes, ship it")
  _resolveCommitMessage()                     ── Project Lead Mode: commitSynthesizer →
                                                 Use this / Edit / Use original goal
  gitManager.tieTheKnot()                     ── commit + push
  updateBranchRecord(currentStatus:'inactive')
  stopDriftDetection() → clearState()         ── thread closes
  _maybeCreateDraftPR()                       ── githubIntegration
  _runTieKnotAutomation()                     ── mark PM task Done + post the feedback
                                                 comment, honoring autoCloseTrigger
```

Note the ordering: the validation result is captured *before* `clearState()` wipes it,
because the PM feedback comment is generated from it.

---

## Flow 11 — Look back

- **Time** — `timeTrackingService` / `timeSummaryService` per thread and task.
- **Commits** — history, velocity, clustering, AI commit synthesis.
- **Validation history & trends** — `validationHistoryService`, `validationTrendService`,
  `reviewTrendService` (the recurring-vibe-title list feeds back into the next review as
  a "you keep doing this" signal).
- **Exports** — `validationExportService` (CSV/JSON), `complianceEvidenceExport` (Max).
- **Analytics** — `developerAnalytics`.

---

## Flow 12 — Upgrade

`startBillingCheckout` → `dodo-checkout` edge function → hosted checkout →
`dodo-webhook` (signature-verified in `verify.ts`) updates `user_profiles.tier`. The
extension re-reads the profile and the gates open. Upgrade CTAs are surfaced exactly where
a gate bit: the free-tier validation limit, gated result sections, and Settings → Plan.

---

## Trust boundaries, in one place

| Boundary | Rule enforced in code |
| --- | --- |
| Webview → host | webview does no I/O; nonce + `localResourceRoots` restrict what it can load |
| Host → provider APIs | Jira/Linear app secrets live only in edge functions; the client uses `*-api-request` proxies |
| Host → LLM | Direct BYOK sends code to Anthropic/OpenAI and the key never reaches Tyne's backend; managed sends a sanitized payload to the region-routed endpoint |
| Privacy modes | `cloud` → full payload; `privacy_enhanced` → client-side redaction + sanitizer + "redacted only" evidence storage; `local_compliance` → no LLM egress, local result |
| Deterministic vs LLM | security/compliance findings are re-asserted after every model pass; the model cannot delete them |
| Quota | `record_usage_atomic` in Postgres, not client-side counting; client quota checks are UX only |

---

## Where to start reading

| To understand… | Read |
| --- | --- |
| Activation and command surface | `src/extension.ts` |
| Every user intent and its handler | `src/TyneSidebarProvider.ts` (the `switch` at ~line 393, `_handleButtonClick` at ~1734) |
| The review pipeline | `src/validateReviewService.ts` → `supabase/functions/tyne-validate-review/index.ts` |
| Result shape, severities, tier limits | `src/validateReviewTypes.ts` |
| Chunking and caching | `src/validateReviewPipeline.ts` (mirrored in `supabase/functions/_shared/`) |
| PM provider abstraction | `src/taskTypes.ts`, `src/taskProviderAdapters.ts`, `src/taskProviderRegistry.ts` |
| Local scanners | `src/quality/*` |
| Privacy and residency | `src/privacy/*` |
