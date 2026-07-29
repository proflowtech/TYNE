import * as vscode from 'vscode';
import type { BranchRecord } from '../branchMetadataService';
import type { ByokKeyService } from '../byokKeyService';
import type { CodeValidationService } from '../codeValidationService';
import type { TyneCommitSession } from '../commitTypes';
import type { DriftEvent } from '../driftDetector';
import type { JiraIntegrationSnapshot } from '../jiraProvider';
import type { AutomationContext } from '../taskAutomationService';
import type { TyneRankedTask } from '../taskQueueRanking';
import type {
  TynePmTool,
  TynePmTaskIntelligence,
  TyneTask,
} from '../taskTypes';
import type { TynePmIntegrationSnapshot } from '../taskViewModel';
import type { TyneState } from '../stateManager';
import type { QualityGateResult, ReviewScope } from '../validateReviewTypes';
import type { TyneValidationResult } from '../validationTypes';
import type { ValidationDisplayService } from '../validationDisplayService';
import type { ValidationHistoryService } from '../validationHistoryService';
import type { ValidationTraceService } from '../validationTraceService';
import type { ValidationUsageService } from '../validationUsageService';

/** Profile blob currently stored on the sidebar provider. */
export interface SidebarUserProfile {
  tier: string;
  credits: number;
  githubUsername?: string;
  githubId?: string;
  email?: string;
  avatarUrl?: string;
  isBanned?: boolean;
}

/** Commit rollup used by status bar / commit context refresh. */
export interface SidebarCommitSummary {
  totalCommits: number;
  totalSessions: number;
  totalMinutes: number;
  latestCommit: { hash: string; message: string } | null;
  lastActivityAt: string;
}

/** Resolved PM issue identity for intelligence / enrichment calls. */
export interface SidebarPmTaskRequest {
  source: 'jira' | 'linear';
  issueId: string;
  issueIdentifier: string;
  cloudId?: string;
  linearWorkspaceId?: string;
}

/**
 * Shared host surface for all sidebar controllers.
 * TyneSidebarProvider implements this; controllers must not import the provider class.
 *
 * NOT on this interface (controller-private; move with owner):
 *  - storyDecomposeSessions          → storyDecompositionController
 *  - appliedFindingFixes, applyAudit → findingFixController
 *  - deviceAuthFlow / focusDisposable → authSessionController
 *  - enrichmentDebounceTimer         → pmIntelligenceController
 *  - jiraBackgroundRefresh*          → pmToolsController
 */
export interface SidebarHost {
  // ── A) Lifetime-shared session / infra ─────────────────────────────
  readonly context: vscode.ExtensionContext;

  /** Same mutable object the provider holds today; mutate in place + saveState as now. */
  readonly state: TyneState;

  isAuthenticated: boolean;
  githubSessionInvalid: boolean;
  userProfile: SidebarUserProfile;
  profileFetchedAt: number;
  billingRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  effectiveConnectedTools: TynePmTool[];
  analyticsTaskId: string | undefined;
  lastCommitSessions: TyneCommitSession[];

  readonly statusBar: vscode.StatusBarItem;
  readonly jiraLog: vscode.OutputChannel;
  readonly actionLog: vscode.OutputChannel;

  /** Webview post — no-op if view not resolved. */
  postMessage(message: Record<string, unknown>): void;

  // ── B) Injected services ───────────────────────────────────────────
  readonly validationService: CodeValidationService;
  readonly byokKeyService: ByokKeyService;
  readonly usageService: ValidationUsageService;
  readonly historyService: ValidationHistoryService;
  readonly displayService: ValidationDisplayService;
  readonly traceService: ValidationTraceService;

  // ── C) Shared helpers ──────────────────────────────────────────────
  getRepositoryPath(): string;
  getRepositoryId(): string | undefined;
  getSupabaseUrl(): string;

  postState(): void;
  postAuthState(): void;
  postSettings(): Promise<void>;
  postIntegrationState(): Promise<void>;
  debouncedSave(): void;
  setBusy(kind: 'think' | 'generate' | 'push', on: boolean): void;
  setRunner(on: boolean): void;
  updateStatusBar(
    activeRecord?: BranchRecord,
    currentBranchName?: string,
    commitSummary?: SidebarCommitSummary,
  ): void;

  logJira(message: string): void;
  logLinear(message: string): void;
  agentDebugLog(payload: Record<string, unknown>): void;

  getParkedIdeas(): string[];
  setParkedIdeas(ideas: string[]): Promise<void>;
  getAiAccessMode(): 'byok' | 'max';
  isProjectLeadMode(): boolean;
  startProjectLeadWatcher(): void;

  isGithubConnected(): Promise<boolean>;
  buildPmIntegrationSnapshot(
    jiraIntegration?: JiraIntegrationSnapshot,
  ): Promise<TynePmIntegrationSnapshot>;

  findCachedTask(taskId: string): TyneTask | undefined;
  getVisibleCachedTasks(): TyneTask[];
  taskShellForId(taskId: string): TyneTask | null;
  briefReadyTaskIds(tasks: TyneTask[]): string[];
  rankTasksForView(filtered: TyneTask[], sortKey?: string): TyneRankedTask[];

  jiraKeyFromTaskId(taskId: string): string;
  jiraKeyFromUrl(url: string): string;
  pmTaskLabel(taskId: string): string;
  classifyJiraConnectError(message: string): string;
  classifyLinearConnectError(message: string): string;

  postThreadCreateTasksVisibility(taskId?: string): void;

  /** Public extension entry; also used by billing/auth paths. */
  updateAuthenticationState(isAuthenticated: boolean): Promise<void>;

  // ── D) Cross-controller façade (provider → owning controller) ──────
  // pmTools
  refreshTasksContext(postMessage: boolean): Promise<void>;
  pullTasks(tool?: TynePmTool): Promise<void>;
  openTaskDetail(taskId: string, tool: TynePmTool): Promise<void>;

  // pmIntelligence
  ensurePmIntelligencePosted(
    taskId: string,
    fromDetails?: TynePmTaskIntelligence | null,
  ): Promise<void>;
  fetchAndPostPmTaskIntelligence(taskId: string, forceRefresh: boolean): Promise<void>;
  resolvePmTaskRequest(
    taskId: string,
    source: 'jira' | 'linear',
  ): Promise<SidebarPmTaskRequest | null>;
  storePmIntelligence(taskId: string, intelligence: TynePmTaskIntelligence): Promise<void>;
  getStoredPmIntelligence(taskId: string): TynePmTaskIntelligence | null;
  extractIntelligenceForStartThread(
    taskId: string,
    tool: TynePmTool,
    title?: string,
    issueType?: string,
  ): Promise<{ intelligence: TynePmTaskIntelligence | null; error?: string }>;
  scheduleEnrichmentFromThreadEdit(): void;
  runEnrichmentForActiveThreadTask(reason: string): Promise<void>;
  postEnrichmentToWebview(taskId: string): void;
  postPmEnrichmentLoading(taskId: string, title?: string): void;
  postPmEnrichmentDone(): void;

  // storyDecomposition
  postStoredDecompositionIfAny(taskId: string): void;

  // gitContext
  refreshBranchContext(postMessage: boolean): Promise<void>;
  refreshCommitContext(postMessage: boolean, maxCommits?: number): Promise<void>;
  refreshGitStatus(): Promise<void>;
  switchToBranch(branchName: string): Promise<void>;
  evaluateQualityGate(gateType: 'pre_commit' | 'pre_push'): Promise<QualityGateResult | null>;
  handleDriftDetected(event: DriftEvent): void;

  // timeAnalytics
  refreshTimeContext(postMessage: boolean): Promise<void>;

  // automation
  refreshAutomationContext(postMessage: boolean): Promise<void>;
  buildAutomationCtx(): AutomationContext | null;
  runTieKnotAutomation(
    branchName: string,
    taskId: string,
    validationResult: TyneValidationResult | null,
    pushed: boolean,
  ): Promise<void>;

  // validateReview
  runValidateReview(scope?: string, selectedCommitSha?: string): Promise<void>;
  prepareWorkspaceForReview(scope?: ReviewScope): Promise<void>;
  markProofPointsMet(result: TyneValidationResult): void;

  // threadWorkflow
  startThread(): Promise<void>;
  startThreadFromTask(
    taskId: string,
    title: string,
    tool: TynePmTool,
    url?: string,
  ): Promise<void>;
  selectTaskIntoThread(taskId: string, tool: TynePmTool): Promise<void>;
  loadTaskIntoThread(
    taskId: string,
    title: string,
    tool: TynePmTool,
    url?: string,
  ): Promise<void>;
  clearValidationForNewTask(): void;

  // authSession
  handleInvalidGitHubToken(source: string): Promise<void>;
  continueWithGitHub(): Promise<void>;
  continueWithDeviceAuth(): Promise<void>;
  cancelDeviceAuth(reason: string): void;
  reconnectGitHub(): Promise<void>;

  // billing
  updateProfile(force?: boolean): Promise<void>;
  fetchUserProfile(): Promise<SidebarUserProfile>;
  startBillingProfileRefresh(previousTier: string): void;
}
