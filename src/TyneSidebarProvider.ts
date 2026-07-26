import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TyneState, getState, saveState, clearState } from './stateManager';
import {
  sanitizeBranchName,
  createBranch,
  saveStitch,
  hasStitch,
  undoStitch,
  tieTheKnot,
  getGit,
  branchExists,
  checkoutBranch,
  deleteLocalBranch,
  getCommitCount,
  getCurrentBranch,
  getLatestCommit,
  getWorkingTreeStatus,
  getDetailedGitStatus,
  isBranchMerged,
  isGitRepo,
} from './gitManager';
import { resolveReviewScope } from './reviewScopeResolver';
import { createDraftPR } from './githubIntegration';
import { startGitHubDeviceFlow, pollGitHubDeviceToken, openGitHubDeviceUri } from './githubOAuth';
import {
  clearDeviceAuthTokens,
  DEVICE_AUTH_ACCESS_TOKEN_KEY,
  getDeviceAuthFunnelSnapshot,
  getEffectiveAuthToken,
  isDeviceAuthDogfoodEnabled,
  logDeviceAuth,
  runDeviceAuthFlow,
  trackDeviceAuthEvent,
  type DeviceAuthFlowHandle,
} from './deviceAuth';
import { getJiraOutputChannel } from './jiraLog';
import { isInvalidGitHubTokenResponse, logGitHub } from './githubAuth';
import { prepareWorkspace } from './workspacePrep';
import { DriftEvent, startDriftDetection, stopDriftDetection } from './driftDetector';
import { synthesizeCommitMessage } from './commitSynthesizer';
import { fetchPMTasksForStandup } from './pmIntegration';
import {
  BranchRecord,
  createBranchRecord,
  deleteBranchRecord,
  getBranchByTaskId,
  listTyneBranches,
  replaceBranchRecords,
  updateBranchRecord,
} from './branchMetadataService';
import { clusterCommits } from './commitClusteringService';
import { extractTaskIdFromBranch, linkCommitToTask } from './commitLinkingService';
import {
  listCommitRecords,
  listCommitSessions,
  replaceCommitRecords,
  replaceCommitSessions,
} from './commitMetadataService';
import { getCommitsForBranch } from './gitCommitService';
import { TyneCommitRecord, TyneCommitSession } from './commitTypes';
import { repairTimeStorage, listTimeLogs, listManualEntries } from './timeMetadataService';
import { generateTimeLogsFromSessions, getTimeLogsForTask, getTimeLogsForBranch } from './timeTrackingService';
import { buildDeveloperAnalytics, listAnalyticsTasks } from './developerAnalytics';
import { createManualTimeEntry, updateManualTimeEntry, deleteManualTimeEntry, listManualTimeEntriesForTask } from './manualTimeEntryService';
import { getTaskTimeSummary, getBranchTimeSummary, getProjectTimeSummary, getDailyTimeSummary, getWeeklyTimeSummary, getMonthlyTimeSummary, formatDuration } from './timeSummaryService';
import { ManualTimeEntryInput } from './timeTypes';
import {
  getAutomationSettings,
  saveAutomationSettings,
  listAutomationEventsForTask,
  repairAutomationStorage,
} from './automationMetadataService';
import {
  refreshTaskStatus,
  updateLocalTaskStatus,
  syncTyneStatusToPm,
  detectStatusConflict,
} from './taskSyncService';
import {
  markTaskDone,
  postFeedback,
  completeTaskAndPostFeedback,
  handleValidationPass,
  hasResolvableTransitions,
  resolveTaskTransition,
  buildAutomationContextFromBranch,
  AutomationContext,
} from './taskAutomationService';
import { previewFeedback } from './workFeedbackService';
import { TyneTaskAutomationSettings, TynePlanTier, TyneMaxFeedbackSection, ALL_MAX_FEEDBACK_SECTIONS } from './automationTypes';
import { reinstallPostCommitHook, getDetectorState, installQualityGateHooks, writeGateBlockFile, writeGateWarnFile, clearGateFiles } from './gitHookService';
import {
  TynePmTool,
  TyneTaskFilters,
  TyneTaskSort,
  DEFAULT_TASK_SORT,
  TyneAdvancedTaskFilters,
  TyneAdvancedTaskSort,
  DEFAULT_ADVANCED_SORT,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
  TynePmTaskIntelligence,
  TynePmTaskValidationResult,
  TyneTask,
} from './taskTypes';
import { getPmTaskIntelligenceService } from './pmTaskIntelligenceService';
import { getStoryDecompositionService, StoryDecompositionLimitError } from './storyDecompositionService';
import {
  buildClarifyingQuestionsFromEnrichment,
  DecomposableStory,
  DecomposedTask,
  detectStoryCharacteristics,
  isDecomposableIssueType,
  normalizeTaskDueDate,
  parseDecomposedTasks,
  recommendTaskOrder,
  StoryCharacteristics,
  subtaskLimitForTier,
  TaskDecompositionResult,
} from './storyDecompositionHarness';
import {
  hasActionableEnrichment,
  hasEnrichmentContent,
  isEnrichmentTriggerField,
  runEnrichment,
} from './taskEnrichmentService';

interface StoredDecomposition {
  parentTaskId: string;
  tool: TynePmTool;
  createdAt: string;
  tasks: Array<DecomposedTask & { pmKey?: string; pmUrl?: string }>;
}
import { normalizeError } from './validationContextTypes';
import { queryTasksAdvanced, parseCustomQuery } from './advancedTaskFilterService';
import { rankTaskQueue, applyRankMetadata, TyneRankedTask } from './taskQueueRanking';
import {
  listPresetsSync,
  savePreset,
  renamePreset,
  deletePreset,
  setDefaultPreset,
  getDefaultPreset,
  repairPresetStorage,
} from './taskFilterPresetService';
import { getByokKeyService } from './byokKeyService';
import { getValidationUsageService } from './validationUsageService';
import { getValidationHistoryService } from './validationHistoryService';
import { getCodeValidationService, CodeValidationService, normalizeTier } from './codeValidationService';
import { getValidationDisplayService } from './validationDisplayService';
import { TyneValidationResult } from './validationTypes';
import { getValidationTraceService } from './validationTraceService';
import { collectCodebaseContext } from './codebaseContextService';
import { getValidateReviewService, ValidateReviewError } from './validateReviewService';
import { TyneValidateReviewResult, ReviewPmTaskContext, FindingFeedbackRequest, FindingVerdict, ReviewScope, ComplianceFramework } from './validateReviewTypes';
import { submitBetaBugReport, BetaBugError, type BetaBugKind } from './betaBugService';
import type { ReviewMode } from './reviewPerformance';
type TyneReviewMode = 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr';
type TyneCodeReviewResult = Record<string, unknown>;
import {
  buildAgentPrompt,
  classifyFindingAction,
  mayAutoApply,
  simpleContentHash,
  type AutoApplyPolicy,
} from './actionEngine';
import { publishReviewDiagnostics, openFindingInEditor, clearReviewDiagnostics } from './reviewDiagnosticsService';
import { getQualityGateService } from './qualityGateService';
import {
  createTask as pmCreateTask,
  updateTask as pmUpdateTask,
  addSubtask as pmAddSubtask,
  addComment as pmAddComment,
  canUsePmWrite,
} from './writableTaskService';
import {
  pullTasksFromProvider,
  pullTasksFromAllConnectedProviders,
  getUnifiedTaskListSync,
} from './multiProviderTaskPullService';
import { getJiraIntegrationSnapshot } from './jiraProvider';
import { getLinearIntegrationSnapshot } from './linearProvider';
import { JiraOAuthStateError } from './jiraOAuth';
import { LinearOAuthStateError } from './linearOAuth';
import { getAdapter } from './taskProviderRegistry';
import {
  initRealTimeSync,
  startActiveTaskSync,
  stopActiveTaskSync,
  detectTaskEditConflict,
} from './realTimeSyncService';
import {
  listCachedTasksSync,
  repairTaskCache,
  getCachedTaskDetailsSync,
  saveTaskDetails,
  saveTaskSyncState,
  markCachedTaskDone,
  saveTasks,
} from './taskCacheService';
import {
  getConnectedToolsSync,
  connectTool,
  markToolConnected,
  disconnectTool,
  canConnectProvider,
  isFreeTier,
} from './taskProviderRegistry';
import { pullTasks, pullTaskDetails, pullAllConnectedProviderTasks, DEFAULT_PULL_INPUT } from './taskPullService';
import { queryTasks } from './taskSearchService';
import { buildOfflineSyncSummary, isOnline, syncWhenOnline } from './offlineSyncService';
import {
  filterTasksForConnectedTools,
  TynePmIntegrationSnapshot,
} from './taskViewModel';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';

interface BranchViewModel extends BranchRecord {
  isCurrent: boolean;
}

interface CommitSummary {
  totalCommits: number;
  totalSessions: number;
  totalMinutes: number;
  latestCommit: TyneCommitRecord | null;
  lastActivityAt: string;
}

interface AppliedFindingFix {
  file: string;
  range: vscode.Range;
  originalText: string;
  expectedText: string;
}

interface FindingFixPlan {
  range: vscode.Range;
  originalText: string;
  proposedText: string;
  language: string;
  mode: 'replace' | 'insert';
}

export class TyneSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _saveTimer?: ReturnType<typeof setTimeout>;
  private _state: TyneState;
  private _isAuthenticated: boolean;
  private _branchRefreshTimer?: ReturnType<typeof setInterval>;
  private _taskRefreshTimer?: ReturnType<typeof setInterval>;
  private _commitRefreshTimer?: ReturnType<typeof setInterval>;
  private readonly _statusBar: vscode.StatusBarItem;
  private readonly _jiraLog: vscode.OutputChannel;
  private readonly _actionLog: vscode.OutputChannel;
  private readonly _driftEvents = new Map<string, DriftEvent>();
  private readonly _appliedFindingFixes = new Map<string, AppliedFindingFix>();
  private readonly _applyAudit: Array<Record<string, unknown>> = [];
  private _userProfile: { tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string; isBanned?: boolean } = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '', isBanned: false };
  private _lastCommitSessions: TyneCommitSession[] = [];
  private _analyticsTaskId: string | undefined;
  // Story decomposition sessions keyed by task id (analysis → questions → tasks).
  private _storyDecomposeSessions = new Map<string, {
    story: DecomposableStory;
    tool: TynePmTool;
    characteristics: StoryCharacteristics;
    codebaseContext?: import('./taskTypes').TyneCodebaseContextPack;
    result?: TaskDecompositionResult;
  }>();
  private _profileFetchedAt = 0;
  private _billingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private _deviceAuthFlow: DeviceAuthFlowHandle | undefined;
  private _deviceAuthFocusDisposable: vscode.Disposable | undefined;
  private _enrichmentDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _jiraBackgroundRefreshInFlight = false;
  private _jiraLastBackgroundRefreshAt = 0;
  private _githubSessionInvalid = false;
  private _effectiveConnectedTools: TynePmTool[] = [];
  private readonly _validationService: CodeValidationService;
  private readonly _byokKeyService: ReturnType<typeof getByokKeyService>;
  private readonly _usageService: ReturnType<typeof getValidationUsageService>;
  private readonly _historyService: ReturnType<typeof getValidationHistoryService>;
  private readonly _displayService: ReturnType<typeof getValidationDisplayService>;
  private readonly _traceService: ReturnType<typeof getValidationTraceService>;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    isAuthenticated = false,
  ) {
    this._validationService = getCodeValidationService(_context);
    this._byokKeyService = getByokKeyService(_context);
    this._usageService = getValidationUsageService(_context);
    this._usageService.setAuthErrorHandler(() => { void this._handleInvalidGitHubToken('usage'); });
    this._historyService = getValidationHistoryService(_context);
    this._displayService = getValidationDisplayService();
    this._traceService = getValidationTraceService();
    this._state = getState(_context);
    this._isAuthenticated = isAuthenticated;
    this._jiraLog = getJiraOutputChannel();
    this._actionLog = vscode.window.createOutputChannel('Tyne Action Engine');
    this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBar.command = 'tyne.focusSidebar';
    this._statusBar.show();
    this._updateStatusBar();
    if (this._isAuthenticated) {
      setTimeout(() => { void this._updateProfile(); }, 0);
    }
  }

  public async updateAuthenticationState(isAuthenticated: boolean): Promise<void> {
    this._isAuthenticated = isAuthenticated;
    if (isAuthenticated) {
      await this._updateProfile(true);
    } else {
      this._userProfile = { tier: 'UNKNOWN', credits: 0 };
      this._profileFetchedAt = 0;
      if (this._billingRefreshTimer) {
        clearTimeout(this._billingRefreshTimer);
        this._billingRefreshTimer = undefined;
      }
    }
    this._postAuthState();
    this._postState();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    // #region agent log
    this._agentDebugLog({
      runId: 'audit1',
      hypothesisId: 'BOOT',
      location: 'TyneSidebarProvider.ts:resolveWebviewView',
      message: 'webview resolving with instrumented host',
      data: { extensionPath: this._context.extensionPath },
    });
    // #endregion
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };

    // Render the shell. If state load or HTML generation throws, surface the
    // error inside the panel instead of leaving a silently blank webview.
    try {
      this._state = getState(this._context);
      webviewView.webview.html = this._getHtml(webviewView.webview);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack || err.message) : String(err);
      console.error('Tyne: failed to render sidebar webview', err);
      const safe = String(detail).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
      webviewView.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family,sans-serif);padding:12px;color:var(--vscode-foreground,#ddd)"><h3>Tyne failed to load</h3><p>Please report this stack trace:</p><pre style="white-space:pre-wrap;font-size:11px;color:#f88">${safe}</pre></body></html>`;
      return;
    }

    // initRealTimeSync is best-effort; never let it block message handling, which
    // drives the entire UI render via 'stateLoaded'.
    try {
      initRealTimeSync(this._context, (msg) => this._view?.webview.postMessage(msg));
    } catch (err) {
      console.error('Tyne: initRealTimeSync failed', err);
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'WEBVIEW_READY') {
        console.log('HOST: Received WEBVIEW_READY, fetching profile...');
        // #region agent log
        this._agentDebugLog({
          runId: 'audit1',
          hypothesisId: 'BOOT',
          location: 'TyneSidebarProvider.ts:WEBVIEW_READY',
          message: 'host received WEBVIEW_READY',
          data: {
            extensionPath: this._context.extensionPath,
            isAuthenticated: this._isAuthenticated,
          },
        });
        // #endregion
        if (this._isAuthenticated) {
          void this._updateProfile();
        }
        return;
      }
      switch (msg.type) {
        case 'ready':
          this._postState();
          if (this._isAuthenticated) {
            void this._updateProfile();
          }
          break;
        case 'debugLog':
          this._agentDebugLog(msg.payload as Record<string, unknown>);
          break;
        case 'fieldChange': this._handleFieldChange(msg.field as string, msg.value as string); break;
        case 'subtaskAdd': this._handleSubtaskAdd(msg.text as string); break;
        case 'subtaskToggle': this._handleSubtaskToggle(msg.id as string); break;
        case 'subtaskDelete': this._handleSubtaskDelete(msg.id as string); break;
        case 'buttonClick': await this._handleButtonClick(msg.action as string); break;
        case 'openExternal':
          if (typeof msg.url === 'string') {
            const jiraKey = this._jiraKeyFromUrl(msg.url);
            if (jiraKey) { this._logJira(`Opening Jira task externally: ${jiraKey}`); }
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
        case 'startBillingCheckout':
          await this._handleBillingCheckout(String(msg.plan || ''));
          break;
        case 'continueWithGitHub': await this._continueWithGitHub(); break;
        case 'reconnectGitHub': await this._reconnectGitHub(); break;
        case 'logout': await this._logout(); break;
        case 'deviceAuthRetry': await this._continueWithDeviceAuth(); break;
        case 'deviceAuthCancel': this._cancelDeviceAuth('user_cancel'); break;
        case 'settingChange': await this._handleSettingChange(msg.key as string, msg.value); break;
        case 'saveJiraSettings': await this._handleSaveJiraSettings(msg); break;
        case 'connectJira':
          await this._handleSaveJiraSettings(msg);
          await this._handleConnectPmTool('jira');
          break;
        case 'changeJiraProject':
          this.changeJiraProject();
          break;
        case 'saveByokKey': await this._handleSaveByokKey(msg.apiKey as string, msg.provider as string); break;
        case 'deleteByokKey': await this._handleDeleteByokKey(); break;
        case 'testByokKey': await this._handleTestByokKey(msg.provider as string); break;
        case 'getValidationHistory': await this._handleValidationHistoryRequest(msg.filters); break;
        case 'getValidationTrends': await this._handleValidationTrendsRequest(); break;
        case 'getReviewTrends': await this._handleReviewTrendsRequest(); break;
        case 'exportValidationHistory': await this._handleExportValidationHistory(msg.format as 'csv' | 'json', msg.filters); break;
        case 'exportComplianceEvidence': await this._handleExportComplianceEvidence(msg.format as string, msg.report as Record<string, unknown>); break;
        case 'complianceFindingWorkflow': await this._handleComplianceFindingWorkflow(msg as Record<string, unknown>); break;
        case 'listCustomCompliancePolicies': await this._handleListCustomCompliancePolicies(); break;
        case 'createCustomCompliancePolicy': await this._handleCreateCustomCompliancePolicy(msg.policy as Record<string, unknown>); break;
        case 'deleteCustomCompliancePolicy': await this._handleDeleteCustomCompliancePolicy(msg.id as string); break;
        case 'driftAction': await this._handleDriftAction(msg.file as string, msg.action as string); break;
        case 'parkedIdeasClear': await this._setParkedIdeas([]); this._postSettings(); break;
        case 'standupSelect': await this._handleStandupSelect(msg.task); break;
        case 'connectIntegration': await this._handleConnectIntegration(msg.provider as string); break;
        case 'switchBranch': await this._switchToBranch(msg.branchName as string); break;
        case 'deleteBranch': await this._deleteBranch(msg.branchName as string); break;
        case 'refreshBranches':
          await this._refreshBranchContext(true);
          await this._refreshCommitContext(true, 200);
          break;
        case 'refreshCommits': await this._refreshCommitContext(true, 200); break;
        case 'refreshTime': await this._refreshTimeContext(true); break;
        case 'selectAnalyticsTask':
          this._analyticsTaskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
          await this._refreshTimeContext(true);
          break;
        case 'refreshAutomation': await this._refreshAutomationContext(true); break;
        case 'refreshTasks': await this._refreshTasksContext(true); break;
        case 'pullTasks': await this._handlePullTasks(msg.tool as TynePmTool | undefined); break;
        case 'connectPmTool': await this._handleConnectPmTool(msg.tool as TynePmTool); break;
        case 'disconnectPmTool': await this._handleDisconnectPmTool(msg.tool as TynePmTool); break;
        case 'openTaskDetail': await this._handleOpenTaskDetail(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'selectTaskIntoThread': await this._handleSelectTaskIntoThread(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'retryPmEnrichment': await this._handleRetryPmEnrichment(); break;
        case 'switchTaskInThread': await this._handleSwitchTaskInThread(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'refreshTaskDetail': await this._handleOpenTaskDetail(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'refreshPmTaskIntelligence': await this._fetchAndPostPmTaskIntelligence(msg.taskId as string, true); break;
        case 'queryTasks': this._handleQueryTasks(msg.query as string, msg.filters as TyneTaskFilters, msg.sort as TyneTaskSort); break;
        case 'queryTasksAdvanced': this._handleQueryTasksAdvanced(msg.query as string, msg.filters as TyneAdvancedTaskFilters, msg.sort as TyneAdvancedTaskSort); break;
        case 'listPresets': this._handleListPresets(); break;
        case 'savePreset': await this._handleSavePreset(msg); break;
        case 'renamePreset': await this._handleRenamePreset(msg.id as string, msg.name as string); break;
        case 'deletePreset': await this._handleDeletePreset(msg.id as string); break;
        case 'setDefaultPreset': await this._handleSetDefaultPreset(msg.id as string); break;
        case 'applyPreset': this._handleApplyPreset(msg.id as string); break;
        case 'createTask': await this._handleCreateTask(msg.input as TyneCreateTaskInput); break;
        case 'updateTask': await this._handleUpdateTask(msg.taskId as string, msg.sourceTool as TynePmTool, msg.input as TyneUpdateTaskInput); break;
        case 'addSubtask': await this._handleAddSubtask(msg.taskId as string, msg.sourceTool as TynePmTool, msg.input as { title: string; assigneeId?: string; dueDate?: string }); break;
        case 'addComment': await this._handleAddComment(msg.taskId as string, msg.sourceTool as TynePmTool, msg.body as string); break;
        case 'checkCapabilities': await this._handleCheckCapabilities(msg.tool as TynePmTool); break;
        case 'detectConflict': await this._handleDetectConflict(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'startRealTimeSync': await startActiveTaskSync(); break;
        case 'stopRealTimeSync': await stopActiveTaskSync(); break;
        case 'startThreadFromTask': await this._handleStartThreadFromTask(msg.taskId as string, msg.title as string, msg.tool as TynePmTool, msg.url as string | undefined); break;
        case 'storyDecomposeAnalyze': await this._handleStoryDecomposeAnalyze(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'storyDecomposeGenerate': await this._handleStoryDecomposeGenerate(msg.taskId as string, msg.answers as Record<string, string>); break;
        case 'storyDecomposeCreate': await this._handleStoryDecomposeCreate(msg.taskId as string, msg.tasks as unknown, msg.createInJira === true, msg.dueDate); break;
        case 'storyDecomposeCancel': this._storyDecomposeSessions.delete(msg.taskId as string); break;
        case 'storyDecomposeStartTask': await this._handleStoryDecomposeStartTask(msg.parentTaskId as string, msg.pmKey as string | undefined, msg.title as string); break;
        case 'storyDecomposeRegenerate': await this._handleStoryDecomposeRegenerate(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'getGitStatus': await this._refreshGitStatus(); break;
        case 'runCodeReview': await this._handleRunCodeReview(msg.mode as TyneReviewMode); break;
        case 'runValidateReview': await this._handleRunValidateReview(msg.scope as string | undefined, msg.selectedCommitSha as string | undefined); break;
        case 'loadValidateReviewReports': await this._postValidateReviewReports(); break;
        case 'submitBetaBug': await this._handleSubmitBetaBug(msg); break;
        case 'findingFeedback': await this._handleFindingFeedback(msg.feedback as Record<string, unknown>); break;
        case 'createTaskFromFinding': await this._handleCreateTaskFromFinding(msg.finding as Record<string, unknown>); break;
        case 'fixPendingGoal': await this._handleFixPendingGoal(msg.goal as Record<string, unknown>); break;
        case 'pendingGoalFeedback': await this._handlePendingGoalFeedback(msg.goal as Record<string, unknown>); break;
        case 'previewFix': await this._handlePreviewFix(msg.finding as Record<string, unknown>); break;
        case 'applyFix': await this._handleApplyFix(msg.finding as Record<string, unknown>); break;
        case 'undoFix': await this._handleUndoFix(msg.finding as Record<string, unknown>); break;
        case 'agentFix': await this._handleAgentFix(msg.finding as Record<string, unknown>); break;
        case 'openFinding': await openFindingInEditor(msg.finding as { file?: string; line?: number; endLine?: number }); break;
        case 'clearReviewDiagnostics': clearReviewDiagnostics(); break;
        case 'copyTaskId':
          if (typeof msg.taskId === 'string') {
            await vscode.env.clipboard.writeText(msg.taskId);
            vscode.window.showInformationMessage(`Copied ${msg.taskId}`);
          }
          break;
        case 'copyTaskLink':
          if (typeof msg.url === 'string') {
            await vscode.env.clipboard.writeText(msg.url);
            vscode.window.showInformationMessage('Task link copied.');
          }
          break;
        case 'automationMarkDone': await this._handleMarkTaskDone(); break;
        case 'automationPostFeedback': await this._handlePostFeedback(msg.bodyOverride as string | undefined); break;
        case 'automationCompleteAndFeedback': await this._handleCompleteAndFeedback(msg.bodyOverride as string | undefined); break;
        case 'automationPreviewFeedback': await this._handlePreviewFeedback(); break;
        case 'automationSaveSettings': await this._handleSaveAutomationSettings(msg.settings as TyneTaskAutomationSettings); break;
        case 'automationSaveMaxReportSettings': await this._handleSaveMaxReportSettings(msg.sections as TyneMaxFeedbackSection[]); break;
        case 'reinstallCommitHook': await this._handleReinstallCommitHook(); break;
        case 'automationSyncStatus': await this._refreshAutomationContext(true); break;
        case 'addManualTime': await this._handleAddManualTime(msg.entry as ManualTimeEntryInput); break;
        case 'editManualTime': await this._handleEditManualTime(msg.id as string, msg.entry as Partial<ManualTimeEntryInput>); break;
        case 'deleteManualTime': await this._handleDeleteManualTime(msg.id as string); break;
        case 'copyBranchName':
          if (typeof msg.branchName === 'string') {
            await vscode.env.clipboard.writeText(msg.branchName);
            vscode.window.showInformationMessage(`Copied ${msg.branchName}`);
          }
          break;
        case 'copyCommitHash':
          if (typeof msg.commitHash === 'string') {
            await vscode.env.clipboard.writeText(msg.commitHash);
            vscode.window.showInformationMessage(`Copied ${msg.commitHash.slice(0, 8)}`);
          }
          break;
        case 'copyCommitMessage':
          if (typeof msg.message === 'string') {
            await vscode.env.clipboard.writeText(msg.message);
            vscode.window.showInformationMessage('Commit message copied');
          }
          break;
        case 'openChangedFile':
          if (typeof msg.filePath === 'string') {
            const repo = this._getRepositoryPath();
            const uri = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(repo), msg.filePath).fsPath);
            await vscode.window.showTextDocument(uri, { preview: false });
          }
          break;
        case 'openCommitGraph':
          if (typeof msg.commitHash === 'string') {
            try {
              await vscode.commands.executeCommand('gitlens.showCommitInView', { commit: msg.commitHash });
            } catch {
              vscode.window.showInformationMessage('No Git graph integration was available for this commit.');
            }
          }
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._state = getState(this._context);
        this._postState();
        if (this._isAuthenticated) {
          void this._updateProfile();
        }
      }
    });

    this._ensureRefreshLoop();

    const saveWatcher = vscode.workspace.onDidSaveTextDocument(() => {
      void this._refreshGitStatus();
    });
    this._context.subscriptions.push(saveWatcher);
  }

  private _postState(): void {
    this._view?.webview.postMessage({ type: 'stateLoaded', state: this._state });
    // CTA visibility from cached issueType — not enrichment (reload-safe).
    this._postThreadCreateTasksVisibility();
    this._postAuthState();
    this._postSettings();
    this._updateStatusBar();
    setTimeout(() => { void this._refreshBranchContext(true); }, 400);
    setTimeout(() => { void this._refreshGitStatus(); }, 600);
    setTimeout(() => { void this._refreshTasksContext(false); }, 700);
    setTimeout(() => { void this._refreshTimeContext(false); }, 1000);
    setTimeout(() => { void this._refreshAutomationContext(false); }, 1300);
    setTimeout(() => { void this._refreshCommitContext(true); }, 1800);
    setTimeout(() => { void this._postValidationHistory(); }, 2200);
    setTimeout(() => { void this._handleValidationTrendsRequest(); }, 2600);
  }

  /** Thread "Create tasks" CTA: same gate as Task detail (cached issueType only). */
  private _postThreadCreateTasksVisibility(taskId?: string): void {
    const id = (taskId || this._state.taskId || '').trim();
    if (!id) {
      this._view?.webview.postMessage({ type: 'taskCreationEligibility', taskId: '', eligible: false, issueType: '' });
      return;
    }
    const cached = this._findCachedTask(id);
    const issueType = cached?.issueType || getCachedTaskDetailsSync(this._context, cached?.id || id)?.issueType || '';
    this._view?.webview.postMessage({
      type: 'taskCreationEligibility',
      taskId: cached?.id || id,
      eligible: isDecomposableIssueType(issueType),
      issueType,
    });
  }

  /** Resolve cache by unified id, external key, or bare key (jira:TYNE-1 / TYNE-1). */
  private _findCachedTask(taskId: string): ReturnType<typeof listCachedTasksSync>[number] | undefined {
    const id = (taskId || '').trim();
    if (!id) { return undefined; }
    const all = listCachedTasksSync(this._context);
    const bare = id.replace(/^(jira|linear|asana|notion|monday):/i, '');
    return all.find(t =>
      t.id === id
      || t.externalId === id
      || t.externalId === bare
      || t.id === `jira:${bare}`
      || t.id === `linear:${bare}`
    );
  }

  private _getStoredPmIntelligence(taskId: string): TynePmTaskIntelligence | null {
    const id = this._findCachedTask(taskId)?.id || taskId;
    return (getCachedTaskDetailsSync(this._context, id)
      || getCachedTaskDetailsSync(this._context, taskId))?.pmIntelligence || null;
  }

  /**
   * Ids whose PM brief is already stored, so ranking can tell a task that is
   * ready to start from one that still needs an AI setup pass.
   */
  private _briefReadyTaskIds(tasks: TyneTask[]): string[] {
    return tasks
      .filter(t => hasEnrichmentContent(this._getStoredPmIntelligence(t.id)))
      .map(t => t.id);
  }

  /**
   * Attach queue metadata to a filtered task list. In recommended mode the
   * ranking supplies the order; under an explicit user sort the caller's order
   * wins and the metadata rides along so the priority chip and "start here"
   * marker still render.
   */
  private _rankTasksForView(filtered: TyneTask[], sortKey?: string): TyneRankedTask[] {
    const ranked = rankTaskQueue(filtered, {
      activeTaskId: this._state.taskId || undefined,
      briefReadyTaskIds: this._briefReadyTaskIds(filtered),
    });
    return sortKey === 'recommended' ? ranked : applyRankMetadata(filtered, ranked);
  }

  /**
   * A details record only exists once the task drawer has been opened. Selecting
   * a task straight into a thread never opens it, so this used to drop the
   * enrichment — goal, acceptance criteria and proof points — on the floor, and
   * the next open paid for the same AI extraction again. Fall back to a shell
   * built from the cached task (or the live thread) so the result is kept.
   */
  private async _storePmIntelligence(taskId: string, intelligence: TynePmTaskIntelligence): Promise<void> {
    const cached = this._findCachedTask(taskId);
    const id = cached?.id || taskId;
    const details = getCachedTaskDetailsSync(this._context, id)
      || getCachedTaskDetailsSync(this._context, taskId);
    if (details) {
      await saveTaskDetails(this._context, { ...details, pmIntelligence: intelligence });
      return;
    }
    const base = cached ?? this._taskShellForId(taskId);
    if (!base) { return; }
    await saveTaskDetails(this._context, {
      ...base,
      subtasks: [],
      comments: [],
      notes: [],
      historyLast30Days: [],
      pmIntelligence: intelligence,
    });
  }

  /**
   * Minimal TyneTask for a task that is in the active thread but not in the
   * cache yet (freshly created, or pulled under a different id). Enough to hang
   * stored intelligence off; a real pull overwrites it.
   */
  private _taskShellForId(taskId: string): TyneTask | null {
    if (!taskId || this._state.taskId !== taskId) { return null; }
    const tool = this._state.taskSource;
    if (tool !== 'jira' && tool !== 'linear') { return null; }
    const nowIso = new Date().toISOString();
    return {
      id: taskId,
      externalId: this._jiraKeyFromTaskId(taskId) || taskId,
      title: this._state.taskTitle || taskId,
      status: 'To Do',
      normalizedStatus: 'todo',
      normalizedPriority: 'none',
      sourceTool: tool,
      sourceUrl: this._state.taskUrl || undefined,
      lastSyncedAt: nowIso,
      cachedAt: nowIso,
      isCachedOnly: true,
    };
  }

  private _postAuthState(): void {
    this._view?.webview.postMessage({ type: 'AUTH_STATE_CHANGE', isAuthenticated: this._isAuthenticated });
  }

  private _setBusy(kind: 'think' | 'generate' | 'push', on: boolean): void {
    this._view?.webview.postMessage({ type: 'busy', kind, on });
  }

  private _setRunner(on: boolean): void {
    this._view?.webview.postMessage({ type: 'runner', on });
  }

  private async _continueWithGitHub(): Promise<void> {
    // Dogfood flag only — existing GitHub Device Flow body below is untouched.
    if (isDeviceAuthDogfoodEnabled()) {
      await this._continueWithDeviceAuth();
      return;
    }
    const clientId = vscode.workspace.getConfiguration('tyne').get<string>('githubClientId', '');
    if (!clientId) {
      vscode.window.showErrorMessage('No GitHub Client ID configured. Set tyne.githubClientId in settings.');
      return;
    }
    this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'starting' });
    try {
      const flow = await startGitHubDeviceFlow(clientId);
      openGitHubDeviceUri(flow.verificationUri);
      this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'pending', userCode: flow.userCode, verificationUri: flow.verificationUri });
      const progressOptions = { location: vscode.ProgressLocation.Notification, title: `GitHub: enter code ${flow.userCode}`, cancellable: true };
      const token = await vscode.window.withProgress(progressOptions, async (progress, tokenSource) => {
        progress.report({ message: 'Waiting for authorization...' });
        const controller = new AbortController();
        tokenSource.onCancellationRequested(() => controller.abort());
        const result = await pollGitHubDeviceToken(clientId, flow.deviceCode, flow.interval, this._context, controller.signal);
        return result.accessToken;
      });
      if (token) { vscode.window.showInformationMessage('GitHub connected ✓'); await this.updateAuthenticationState(true); }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('GitHub connection failed: ' + message);
      this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'error', error: message });
    }
  }

  /** Dogfood device-auth path (live by default). Does not use githubOAuth / tyne_github_token. */
  private async _continueWithDeviceAuth(): Promise<void> {
    logDeviceAuth(`Starting device-auth (mode=${vscode.workspace.getConfiguration('tyne').get('deviceAuthMode', 'live')})`);
    this._cancelDeviceAuth('restart');
    this._deviceAuthFocusDisposable?.dispose();
    this._deviceAuthFocusDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!this._deviceAuthFlow) { return; }
      if (state.focused) {
        trackDeviceAuthEvent(this._context, 'device_auth_focus_regained');
        logDeviceAuth('Window focus regained — poll continues (no restart)');
      } else {
        trackDeviceAuthEvent(this._context, 'device_auth_focus_lost');
        logDeviceAuth('Window focus lost mid-poll — poll continues (no restart)');
      }
    });

    this._deviceAuthFlow = runDeviceAuthFlow(this._context, {
      onStatus: (msg) => {
        this._view?.webview.postMessage({ type: 'deviceAuthStatus', ...msg });
      },
      openBrowser: async (uri) => {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(uri));
        if (!opened) {
          logDeviceAuth(`openExternal returned false for ${uri}`);
          const pick = await vscode.window.showWarningMessage(
            `Couldn't open the browser automatically. Open this URL and approve the code: ${uri}`,
            'Copy URL',
          );
          if (pick === 'Copy URL') {
            await vscode.env.clipboard.writeText(uri);
          }
        } else {
          logDeviceAuth(`Opened browser: ${uri}`);
        }
      },
    });

    const result = await this._deviceAuthFlow.done;
    this._deviceAuthFlow = undefined;
    this._deviceAuthFocusDisposable?.dispose();
    this._deviceAuthFocusDisposable = undefined;

    if (result.ok) {
      vscode.window.showInformationMessage(
        `Tyne connected (${result.user.tier}) ✓`,
      );
      logDeviceAuth(`Success for user ${result.user.id} tier=${result.user.tier}; funnel=${JSON.stringify(getDeviceAuthFunnelSnapshot(this._context))}`);
      await this.updateAuthenticationState(true);
    }
  }

  private _cancelDeviceAuth(reason: string): void {
    if (!this._deviceAuthFlow) { return; }
    logDeviceAuth(`Device auth cancelled (${reason})`);
    this._deviceAuthFlow.cancel();
    this._deviceAuthFlow = undefined;
    void clearDeviceAuthTokens(this._context);
  }

  private async _handleConnectIntegration(provider: string): Promise<void> {
    const names: Record<string, string> = { slack: 'Slack', salesforce: 'Salesforce', jira: 'Jira', linear: 'Linear', monday: 'Monday', asana: 'Asana', notion: 'Notion' };
    const name = names[provider] || provider;
    // Only Jira and Linear are live integrations; the rest are not built yet.
    if (provider === 'jira' || provider === 'linear') {
      await this._handleConnectPmTool(provider as TynePmTool);
      return;
    }
    vscode.window.showInformationMessage(`${name} integration is coming soon.`);
  }

  private async _logout(): Promise<void> {
    await this._context.secrets.delete('tyne_github_token');
    await clearDeviceAuthTokens(this._context);
    stopDriftDetection();
    await this.updateAuthenticationState(false);
  }

  // Called when a Tyne backend call rejects the saved GitHub token. Clears the
  // stale session, marks GitHub disconnected, and surfaces a clear reconnect path
  // instead of silently failing profile/usage/validation loads.
  private async _handleInvalidGitHubToken(source: string): Promise<void> {
    const expiredMessage = 'Your GitHub session expired. Reconnect GitHub to continue.';
    if (this._githubSessionInvalid) {
      // Already handled — keep the webview banner visible but avoid repeat popups/logs.
      this._view?.webview.postMessage({ type: 'githubSessionExpired', message: expiredMessage });
      return;
    }
    this._githubSessionInvalid = true;
    await this._context.secrets.delete('tyne_github_token');
    this._isAuthenticated = false;
    this._userProfile = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
    this._profileFetchedAt = 0;
    stopDriftDetection();
    // Safe logs only — never the token, headers, or any secret. `source` is a fixed label.
    logGitHub('GitHub token invalid; cleared local session');
    logGitHub('Reconnect GitHub required');
    logGitHub(`Trigger: ${source}`);
    this._postAuthState();
    this._postState();
    this._view?.webview.postMessage({ type: 'githubSessionExpired', message: expiredMessage });
    void vscode.window.showWarningMessage(expiredMessage, 'Reconnect GitHub').then(choice => {
      if (choice === 'Reconnect GitHub') { void this._reconnectGitHub(); }
    });
  }

  public reconnectGitHub(): void {
    void this._reconnectGitHub();
  }

  private async _reconnectGitHub(): Promise<void> {
    // Start from a clean slate so the device flow never reuses the rejected token.
    await this._context.secrets.delete('tyne_github_token');
    logGitHub('Reconnect GitHub requested');
    await this._continueWithGitHub();
    if (await this._isGithubConnected()) {
      this._githubSessionInvalid = false;
      logGitHub('GitHub reconnected; session restored');
      this._view?.webview.postMessage({ type: 'githubSessionRestored' });
      // Retry the profile + usage loads that failed under the stale token.
      await this._updateProfile(true);
      await this._postSettings();
      await this._refreshTasksContext(true);
    }
  }

  private _isProjectLeadMode(): boolean {
    return vscode.workspace.getConfiguration('tyne').get<boolean>('projectLeadMode', false);
  }

  private async _updateProfile(force = false): Promise<void> {
    if (!force && Date.now() - this._profileFetchedAt < 60_000) { return; }
    this._profileFetchedAt = Date.now();
    this._userProfile = await this._fetchUserProfile();
    if (this._userProfile.isBanned) {
      vscode.window.showErrorMessage('Your Tyne account is banned. Contact support if you believe this is a mistake.');
      await clearDeviceAuthTokens(this._context);
      await this._context.secrets.delete('tyne_github_token');
      await this.updateAuthenticationState(false);
      return;
    }
    this._view?.webview.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this._userProfile.tier,
        credits: this._userProfile.credits,
        githubUsername: this._userProfile.githubUsername || '',
        githubId: this._userProfile.githubId || '',
        email: this._userProfile.email || '',
        avatarUrl: this._userProfile.avatarUrl || '',
        isBanned: !!this._userProfile.isBanned,
      }
    });
    // Settings/usage often race ahead of profile load and briefly fall back to Core 5/5.
    // Re-post after the real tier is known so Max shows unlimited from the usage API.
    if (this._isAuthenticated && this._userProfile.tier !== 'UNKNOWN') {
      await this._postSettings();
    }
  }

  private async _handleBillingCheckout(plan: string): Promise<void> {
    if (plan !== 'pro' && plan !== 'max') {
      this._view?.webview.postMessage({ type: 'billingCheckoutError', message: 'Choose Pro or Max.' });
      return;
    }

    const token = await getEffectiveAuthToken(this._context);
    if (!token) {
      this._view?.webview.postMessage({ type: 'billingCheckoutError', message: 'Sign in before upgrading.' });
      return;
    }

    try {
      const response = await fetch(`${this._getSupabaseUrl()}/functions/v1/dodo-checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Machine-ID': vscode.env.machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan }),
      });
      const result = await response.json().catch(() => ({})) as { checkout_url?: string; error?: string };
      if (!response.ok || !result.checkout_url) {
        throw new Error(result.error || 'Could not start checkout.');
      }

      const opened = await vscode.env.openExternal(vscode.Uri.parse(result.checkout_url));
      if (!opened) throw new Error('Could not open checkout in your browser.')

      this._view?.webview.postMessage({ type: 'billingCheckoutOpened' });
      this._startBillingProfileRefresh(this._userProfile.tier);
    } catch (error) {
      this._view?.webview.postMessage({
        type: 'billingCheckoutError',
        message: error instanceof Error ? error.message : 'Could not start checkout.',
      });
    }
  }

  private _startBillingProfileRefresh(previousTier: string): void {
    if (this._billingRefreshTimer) clearTimeout(this._billingRefreshTimer);
    let attempts = 0;

    const check = async (): Promise<void> => {
      attempts += 1;
      await this._updateProfile(true);
      if (this._userProfile.tier !== previousTier && this._userProfile.tier !== 'UNKNOWN') {
        this._billingRefreshTimer = undefined;
        this._view?.webview.postMessage({ type: 'billingPlanUpdated', tier: this._userProfile.tier });
        vscode.window.showInformationMessage(`Tyne plan updated to ${this._userProfile.tier}.`);
        return;
      }
      if (attempts >= 36 || !this._isAuthenticated) {
        this._billingRefreshTimer = undefined;
        this._view?.webview.postMessage({ type: 'billingRefreshStopped' });
        return;
      }
      this._billingRefreshTimer = setTimeout(() => { void check(); }, 5_000);
    };

    this._billingRefreshTimer = setTimeout(() => { void check(); }, 5_000);
  }

  private async _fetchUserProfile(): Promise<{ tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string; isBanned?: boolean }> {
    const empty = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '', isBanned: false };
    const token = await getEffectiveAuthToken(this._context);
    if (!token) {
      return empty;
    }

    const sessionToken = await this._context.secrets.get(DEVICE_AUTH_ACCESS_TOKEN_KEY);
    const machineId = vscode.env.machineId;

    // Device-auth session: live tier/credits/ban from usage (DB), not login-time cache.
    if (sessionToken) {
      try {
        const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/usage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Machine-ID': machineId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'check' }),
        });
        if (res.ok) {
          const data = await res.json() as {
            tier: string;
            credits: number;
            is_banned?: boolean;
            isBanned?: boolean;
          };
          return {
            tier: data.tier || 'UNKNOWN',
            credits: typeof data.credits === 'number' ? data.credits : 0,
            isBanned: !!(data.is_banned ?? data.isBanned),
          };
        }
        const text = await res.text().catch(() => '');
        this._view?.webview.postMessage({ type: 'profileLoadFailed', error: text || `Profile request failed (${res.status})` });
      } catch (e) {
        console.error('Error fetching device-auth user profile:', e);
        this._view?.webview.postMessage({ type: 'profileLoadFailed', error: e instanceof Error ? e.message : String(e) });
      }
      return empty;
    }

    // Legacy GitHub-token path (untouched coexistence).
    try {
      const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Machine-ID': machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feature: 'profile' }),
      });
      if (res.ok) {
        this._githubSessionInvalid = false;
        const data = await res.json() as {
          tier: string;
          credits: number;
          githubUsername?: string;
          githubId?: string;
          email?: string;
          avatarUrl?: string;
          is_banned?: boolean;
          isBanned?: boolean;
        };
        return {
          ...data,
          isBanned: !!(data.is_banned ?? data.isBanned),
        };
      }
      const text = await res.text().catch(() => '');
      if (isInvalidGitHubTokenResponse(res.status, text)) {
        await this._handleInvalidGitHubToken('profile');
        return empty;
      }
      this._view?.webview.postMessage({ type: 'profileLoadFailed', error: text || `Profile request failed (${res.status})` });
    } catch (e) {
      console.error('Error fetching user profile:', e);
      this._view?.webview.postMessage({ type: 'profileLoadFailed', error: e instanceof Error ? e.message : String(e) });
    }
    return empty;
  }

  private _getParkedIdeas(): string[] {
    return this._context.workspaceState.get<string[]>('tyne.parkedIdeas', []);
  }

  private async _setParkedIdeas(ideas: string[]): Promise<void> {
    await this._context.workspaceState.update('tyne.parkedIdeas', ideas);
  }

  private _getAiAccessMode(): 'byok' | 'max' {
    return this._context.workspaceState.get<'byok' | 'max'>('tyne.aiAccessMode', 'byok');
  }

  private _agentDebugLog(payload: Record<string, unknown>): void {
    // #region agent log
    const entry = {
      sessionId: '9dcbf2',
      timestamp: Date.now(),
      ...payload,
    };
    const line = JSON.stringify(entry) + '\n';
    const paths = [
      '/Users/dipanjanroy/Desktop/TYNE/.cursor/debug-9dcbf2.log',
      '/Users/dipanjanroy/Desktop/TYNE/debug-9dcbf2.log',
      '/tmp/tyne-debug-9dcbf2.log',
    ];
    for (const logPath of paths) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, line, 'utf8');
      } catch (err) {
        console.error('Tyne debug log write failed', logPath, err);
      }
    }
    try {
      this._jiraLog.appendLine(`[agent-debug] ${String(payload.message || '')} ${JSON.stringify(payload.data || {})}`);
    } catch { /* ignore */ }
    // #endregion
  }

  private async _postIntegrationState(): Promise<void> {
    const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
    const pmIntegration = await this._buildPmIntegrationSnapshot(jiraIntegration);
    this._view?.webview.postMessage({
      type: 'integrationStateUpdated',
      jiraIntegration,
      pmIntegration,
      connectedTools: pmIntegration.connectedTools,
    });
  }

  private async _postSettings(): Promise<void> {
    const projectLeadMode = this._isProjectLeadMode();
    const aiAccessMode = this._getAiAccessMode();
    const aiProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    const byokConfig = await this._byokKeyService.getConfig();
    const hasBYOKKey = await this._byokKeyService.hasApiKey();
    const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
    const pmIntegration = await this._buildPmIntegrationSnapshot(jiraIntegration);
    const connectedTools = pmIntegration.connectedTools;
    const tier = normalizeTier(this._userProfile.tier);
    const usageSummary = await this._usageService.getUsageSummary(tier).catch(() => undefined);
    const aiUsageUsed = usageSummary?.used ?? 0;
    const aiUsageLimit = usageSummary?.limit === 'unlimited' ? -1 : usageSummary?.limit ?? 50;
    // #region agent log
    this._agentDebugLog({
      runId: 'audit1',
      hypothesisId: 'A',
      location: 'TyneSidebarProvider.ts:_postSettings',
      message: 'host settingsLoaded payload',
      data: {
        jiraConnected: Boolean(jiraIntegration?.connected),
        linearConnected: Boolean(pmIntegration?.linear?.connected),
        connectedTools: connectedTools || [],
        pmJiraConnected: Boolean(pmIntegration?.jira?.connected),
        githubConnected: Boolean(pmIntegration?.githubConnected),
      },
    });
    // #endregion
    this._view?.webview.postMessage({
      type: 'settingsLoaded',
      projectLeadMode,
      parkedIdeas: this._getParkedIdeas(),
      aiAccessMode,
      aiProvider,
      hasBYOKKey,
      byokConfig,
      jiraIntegration,
      pmIntegration,
      connectedTools,
      aiUsageUsed,
      aiUsageLimit,
      userTier: this._userProfile.tier,
      userCredits: this._userProfile.credits,
      githubUsername: this._userProfile.githubUsername || '',
      validationUsage: usageSummary,
      validationUsageText: usageSummary ? this._displayService.formatUsageSummary(usageSummary) : 'Validations: loading...',
      validationResult: this._state.validationResult,
    });
    this._view?.webview.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this._userProfile.tier,
        credits: this._userProfile.credits,
        githubUsername: this._userProfile.githubUsername || '',
        githubId: this._userProfile.githubId || '',
      }
    });
    fetchPMTasksForStandup().then(tasks => {
      this._view?.webview.postMessage({ type: 'standupReady', tasks });
    }).catch(() => {
      this._view?.webview.postMessage({ type: 'standupReady', tasks: [] });
    });
  }

  private async _buildPmIntegrationSnapshot(
    jiraIntegration?: Awaited<ReturnType<typeof getJiraIntegrationSnapshot>>,
  ): Promise<TynePmIntegrationSnapshot> {
    const jira = jiraIntegration ?? await getJiraIntegrationSnapshot(this._context);
    const linearIntegration = await getLinearIntegrationSnapshot(this._context);
    const connectedTools = [...getConnectedToolsSync(this._context)];

    for (const tool of ['jira', 'linear'] as const) {
      let toolConnected = tool === 'jira' ? jira.connected : linearIntegration.connected;
      if (!toolConnected) {
        try {
          toolConnected = await getAdapter(tool).isConnected();
        } catch {
          toolConnected = false;
        }
      }
      if (toolConnected) {
        await markToolConnected(this._context, tool);
        if (!connectedTools.includes(tool)) {
          connectedTools.push(tool);
        }
      }
    }

    this._effectiveConnectedTools = connectedTools;
    return {
      githubConnected: this._isAuthenticated,
      connectedTools,
      jira: {
        connected: connectedTools.includes('jira') || jira.connected,
        projectKey: jira.selectedProject?.projectKey,
        projectName: jira.selectedProject?.projectName,
        siteName: jira.siteName,
      },
      linear: {
        connected: connectedTools.includes('linear') || linearIntegration.connected,
        workspaceName: linearIntegration.workspaceName,
        teamKey: linearIntegration.selectedTeam?.teamKey,
        teamName: linearIntegration.selectedTeam?.teamName,
      },
    };
  }

  private _getVisibleCachedTasks(): TyneTask[] {
    const connectedTools = this._effectiveConnectedTools.length ? this._effectiveConnectedTools : getConnectedToolsSync(this._context);
    return filterTasksForConnectedTools(listCachedTasksSync(this._context), connectedTools);
  }

  private _getRepositoryPath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  private _getRepositoryId(): string | undefined {
    const path = this._getRepositoryPath();
    if (!path) { return undefined; }
    return crypto.createHash('sha256').update(path).digest('hex');
  }

  private _ensureRefreshLoop(): void {
    if (this._branchRefreshTimer) { return; }
    this._branchRefreshTimer = setInterval(() => {
      void this._refreshBranchContext(false);
      void this._refreshTimeContext(false);
      void this._refreshAutomationContext(false);
    }, 20000);
    this._taskRefreshTimer = setInterval(() => {
      void this._refreshTasksContext(false);
    }, 30000);
    this._commitRefreshTimer = setInterval(() => {
      void this._refreshCommitContext(false, 20);
    }, 60000);
  }

  private _updateStatusBar(
    activeRecord?: BranchRecord,
    currentBranchName?: string,
    commitSummary?: CommitSummary,
  ): void {
    const taskId = activeRecord?.taskId || this._state.taskId;
    const parts = ['Tyne:'];
    if (!taskId) {
      this._statusBar.text = 'Tyne: No active task';
      this._statusBar.tooltip = 'Open Tyne sidebar';
      return;
    }
    parts.push(taskId);
    const timeSummary = taskId
      ? getTaskTimeSummary(this._context, this._getRepositoryPath(), taskId)
      : null;
    const totalMin = timeSummary
      ? timeSummary.totalMinutes
      : (commitSummary ? commitSummary.totalMinutes : 0);
    if (totalMin > 0) {
      parts.push(formatDuration(totalMin));
    } else if (commitSummary) {
      parts.push(`${commitSummary.totalCommits} commits`);
    }
    this._statusBar.text = parts.join(' · ');
    this._statusBar.tooltip = activeRecord?.taskTitle || this._state.goal || 'Open Tyne sidebar';
  }

  private async _refreshBranchContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this._view?.webview.postMessage({
          type: 'branchDataLoaded',
          currentBranchName: '',
          currentBranchRecord: null,
          selectedTaskBranch: null,
          branches: [],
        });
      }
      this._updateStatusBar(undefined, '');
      return;
    }

    const currentBranchName = await getCurrentBranch();
    const records = listTyneBranches(this._context, repositoryPath);
    const updatedRecords: BranchRecord[] = [];
    for (const record of records) {
      const exists = await branchExists(record.branchName).catch(() => false);
      if (!exists) { continue; }
      const [commitCount, latestCommit] = await Promise.all([
        getCommitCount(record.branchName).catch(() => record.commitCount),
        getLatestCommit(record.branchName).catch(() => ({
          hash: record.latestCommitHash,
          message: record.latestCommitMessage,
        })),
      ]);
      updatedRecords.push({
        ...record,
        commitCount,
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
        currentStatus: record.branchName === currentBranchName ? 'active' : 'inactive',
      });
    }
    await replaceBranchRecords(this._context, repositoryPath, updatedRecords);

    let currentBranchRecord = updatedRecords.find(record => record.branchName === currentBranchName) || null;
    if (!currentBranchRecord && currentBranchName.startsWith('tyne/')) {
      const extractedTaskId = extractTaskIdFromBranch(currentBranchName);
      const latestCommit = await getLatestCommit(currentBranchName).catch(() => ({ hash: '', message: '' }));
      currentBranchRecord = {
        taskId: extractedTaskId || this._state.taskId || 'Unknown',
        taskTitle: this._state.taskTitle || this._state.goal || extractedTaskId || 'Unknown task',
        taskSource: this._state.taskSource || 'Recovered',
        taskUrl: this._state.taskUrl || undefined,
        branchName: currentBranchName,
        repositoryPath,
        createdAt: new Date().toISOString(),
        lastCheckedOutAt: new Date().toISOString(),
        currentStatus: 'active',
        commitCount: await getCommitCount(currentBranchName).catch(() => 0),
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
      };
    }
    if (currentBranchRecord && this._state.status !== 'weaving') {
      this._state.taskId = currentBranchRecord.taskId;
      this._state.taskTitle = currentBranchRecord.taskTitle;
      this._state.taskSource = currentBranchRecord.taskSource;
      this._state.taskUrl = currentBranchRecord.taskUrl || '';
      this._state.goal = this._state.goal || currentBranchRecord.taskTitle;
      this._state.branchName = currentBranchRecord.branchName;
      // Being on a tyne/ branch means the thread is active.
      if (currentBranchName.startsWith('tyne/')) {
        this._state.status = 'weaving';
        this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName: currentBranchName });
      }
      this._debouncedSave();
    }

    const selectedTaskBranch = this._state.taskId
      ? updatedRecords.find(record => record.taskId === this._state.taskId) || null
      : null;

    const branches: BranchViewModel[] = updatedRecords
      .map(record => ({ ...record, isCurrent: record.branchName === currentBranchName }))
      .sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) { return -1; }
        if (!a.isCurrent && b.isCurrent) { return 1; }
        return b.lastCheckedOutAt.localeCompare(a.lastCheckedOutAt);
      });

    if (postMessage || this._view) {
      this._view?.webview.postMessage({
        type: 'branchDataLoaded',
        currentBranchName,
        currentBranchRecord,
        selectedTaskBranch,
        branches,
      });
    }
    const storedCommits = listCommitRecords(this._context, repositoryPath)
      .filter(commit => commit.branchName === currentBranchName);
    const storedSessions = listCommitSessions(this._context, repositoryPath)
      .filter(session => session.branchName === currentBranchName);
    this._updateStatusBar(
      currentBranchRecord || undefined,
      currentBranchName,
      this._buildCommitSummary(storedCommits, storedSessions),
    );
  }

  private async _refreshGitStatus(): Promise<void> {
    if (!(await isGitRepo().catch(() => false))) { return; }
    try {
      const gitStatus = await getDetailedGitStatus();
      const hasActiveTask = Boolean(this._state.taskId?.trim());
      const isWeaving = this._state.status === 'weaving';

      let ctaReason: string;
      if (!hasActiveTask) {
        ctaReason = 'no_active_task';
      } else if (!isWeaving) {
        ctaReason = 'thread_not_started';
      } else if (gitStatus.isClean) {
        ctaReason = 'no_changes';
      } else if (gitStatus.stagedFiles > 0) {
        ctaReason = 'has_staged';
      } else {
        ctaReason = 'has_unstaged';
      }

      this._logJira(`Git status refreshed: staged=${gitStatus.stagedFiles} unstaged=${gitStatus.unstagedFiles}`);
      this._logJira(`Validation CTA state: ${ctaReason}`);

      this._view?.webview.postMessage({
        type: 'gitStatusLoaded',
        currentBranch: gitStatus.currentBranch,
        stagedFiles: gitStatus.stagedFiles,
        unstagedFiles: gitStatus.unstagedFiles,
        isClean: gitStatus.isClean,
        hasActiveTask,
        isWeaving,
        ctaReason,
      });
    } catch (err) {
      console.error('Tyne: git status refresh failed', err);
    }
  }

  private _buildCommitSummary(commits: TyneCommitRecord[], sessions: TyneCommitSession[]): CommitSummary {
    const latestCommit = commits[0] || null;
    return {
      totalCommits: commits.length,
      totalSessions: sessions.length,
      totalMinutes: sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
      latestCommit,
      lastActivityAt: latestCommit?.committedAt || '',
    };
  }

  private async _refreshCommitContext(postMessage: boolean, maxCommits = 20): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this._view?.webview.postMessage({
          type: 'commitDataLoaded',
          currentBranchName: '',
          currentBranchCommits: [],
          currentBranchSessions: [],
          taskCommits: [],
          taskSessions: [],
          summaries: {},
        });
      }
      return;
    }

    const currentBranchName = await getCurrentBranch();
    const branchRecords = listTyneBranches(this._context, repositoryPath);
    const branchNames = new Set(branchRecords.map(record => record.branchName));
    if (currentBranchName.startsWith('tyne/')) {
      branchNames.add(currentBranchName);
    }

    const allCommits: TyneCommitRecord[] = [];
    const allSessions: TyneCommitSession[] = [];
    for (const branchName of branchNames) {
      const branchRecord = branchRecords.find(record => record.branchName === branchName);
      const commits = await getCommitsForBranch(branchName, maxCommits).catch(() => []);
      const linkedCommits = commits.map(commit => linkCommitToTask(commit, branchRecord));
      const existingSessions = listCommitSessions(this._context, repositoryPath).filter(session => session.branchName === branchName);
      const sessions = clusterCommits([...linkedCommits].reverse()).map(session => ({
        ...session,
        taskId: session.taskId || branchRecord?.taskId,
        taskTitle: session.taskTitle || branchRecord?.taskTitle,
        taskSource: session.taskSource || branchRecord?.taskSource,
        synced: existingSessions.find(existing => existing.id === session.id)?.synced,
        syncedAt: existingSessions.find(existing => existing.id === session.id)?.syncedAt,
        syncedWorklogIds: existingSessions.find(existing => existing.id === session.id)?.syncedWorklogIds,
      }));
      for (const session of sessions) {
        for (const hash of session.commitHashes) {
          const commit = linkedCommits.find(item => item.commitHash === hash);
          if (commit) { commit.sessionId = session.id; }
        }
      }
      allCommits.push(...linkedCommits.sort((a, b) => new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime()));
      allSessions.push(...sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()));
    }

    await replaceCommitRecords(this._context, repositoryPath, allCommits);
    await replaceCommitSessions(this._context, repositoryPath, allSessions);
    this._lastCommitSessions = allSessions;

    const currentBranchCommits = allCommits.filter(commit => commit.branchName === currentBranchName);
    const currentBranchSessions = allSessions.filter(session => session.branchName === currentBranchName);
    const taskBranchName = branchRecords.find(record => record.taskId === this._state.taskId)?.branchName;
    const taskCommits = taskBranchName
      ? allCommits.filter(commit => commit.branchName === taskBranchName)
      : currentBranchCommits.filter(commit => commit.taskId === this._state.taskId);
    const taskSessions = taskBranchName
      ? allSessions.filter(session => session.branchName === taskBranchName)
      : currentBranchSessions.filter(session => session.taskId === this._state.taskId);

    const summaries: Record<string, CommitSummary> = {};
    for (const branchName of branchNames) {
      summaries[branchName] = this._buildCommitSummary(
        allCommits.filter(commit => commit.branchName === branchName),
        allSessions.filter(session => session.branchName === branchName),
      );
    }

    if (postMessage || this._view) {
      this._view?.webview.postMessage({
        type: 'commitDataLoaded',
        currentBranchName,
        currentBranchCommits,
        currentBranchSessions,
        taskCommits,
        taskSessions,
        summaries,
      });
    }
    const currentBranchRecord = branchRecords.find(record => record.branchName === currentBranchName);
    this._updateStatusBar(
      currentBranchRecord,
      currentBranchName,
      summaries[currentBranchName] || this._buildCommitSummary(currentBranchCommits, currentBranchSessions),
    );
    void this._refreshTimeContext(false);
    void this._refreshAutomationContext(false);
    void this._refreshTasksContext(false);
  }

  private async _handleSettingChange(key: string, value: unknown): Promise<void> {
    if (key === 'aiAccessMode') {
      await this._context.workspaceState.update('tyne.aiAccessMode', value === 'max' ? 'max' : 'byok');
      this._postSettings();
      return;
    }
    if (key === 'byokProvider') {
      const provider = value === 'openai' ? 'openai' : 'claude';
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('tyne').update('byokProvider', provider, target);
      this._postSettings();
      return;
    }
    if (key !== 'projectLeadMode') { return; }
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('tyne').update('projectLeadMode', Boolean(value), target);
    if (!value) { stopDriftDetection(); } else if (this._state.status === 'weaving') { this._startProjectLeadWatcher(); }
    this._postSettings();
  }

  private async _handleSaveJiraSettings(msg: { assignedToMe?: boolean }): Promise<void> {
    const config = vscode.workspace.getConfiguration('tyne');
    const assignedToMe = typeof msg.assignedToMe === 'boolean' ? msg.assignedToMe : true;

    // Jira site/project selection is managed by Tyne after hosted OAuth.
    // Do not write hidden cloud/project metadata to user-visible VS Code settings.
    await config.update('jira.assignedToMe', assignedToMe, vscode.ConfigurationTarget.Workspace);
    await this._postSettings();
  }

  private async _handleSaveByokKey(apiKey: string, provider: string): Promise<void> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      vscode.window.showErrorMessage('Enter an API key before saving.');
      return;
    }
    const normalizedProvider = provider === 'openai' ? 'openai' : 'anthropic';
    await this._byokKeyService.saveApiKey(normalizedProvider, trimmed);
    await this._handleSettingChange('byokProvider', provider);
    await this._context.workspaceState.update('tyne.aiAccessMode', 'byok');
    this._view?.webview.postMessage({ type: 'aiSettingsSaved', provider: normalizedProvider, maskedKey: await this._byokKeyService.getMaskedKey(normalizedProvider) });
    this._postSettings();
    vscode.window.showInformationMessage('Tyne API key saved securely.');
  }

  private async _handleDeleteByokKey(): Promise<void> {
    const provider = await this._byokKeyService.getSelectedProvider();
    if (provider) {
      await this._byokKeyService.deleteApiKey(provider);
    }
    this._view?.webview.postMessage({ type: 'byokKeyDeleted' });
    this._postSettings();
    vscode.window.showInformationMessage('BYOK key removed.');
  }

  private async _handleTestByokKey(provider: string): Promise<void> {
    const normalized = provider === 'openai' ? 'openai' : 'anthropic';
    const result = await this._byokKeyService.testApiKey(normalized);
    this._view?.webview.postMessage({ type: 'byokKeyTested', provider: normalized, ok: result.ok, error: result.error });
  }

  private async _handleStandupSelect(task: unknown): Promise<void> {
    if (!task || typeof task !== 'object') { return; }
    const selected = task as { id?: string; title?: string; source?: string; url?: string };
    // Solo Mode = custom task created from the thread page. Reset weaving state
    // so the pre-weave form (briefSection) shows instead of the old thread hero.
    if (selected.source === 'Solo Mode') {
      this._state.status = 'waiting';
      this._state.branchName = '';
      this._state.stitchCount = 0;
      this._state.subtasks = [];
      this._state.acceptanceCriteria = [];
      this._state.proofPointTemplates = [];
      this._state.validationSteps = [];
      this._state.pmTaskContext = null;
      this._state.pmEnrichmentStatus = 'skipped';
      this._state.pmEnrichmentError = '';
    }
    this._state.taskId = selected.id || this._state.taskId;
    this._state.taskTitle = selected.title || this._state.taskTitle;
    this._state.taskSource = selected.source || this._state.taskSource || 'Solo Mode';
    this._state.taskUrl = selected.url || this._state.taskUrl;
    this._state.goal = selected.title || this._state.goal;
    this._state.appName = this._state.appName || vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    this._clearValidationForNewTask();
    await saveState(this._context, this._state);
    this._postState();
  }

  // Reset validation so opening/selecting a different task never re-shows the
  // previous task's scorecard (which looked like an automatic re-validation).
  private _clearValidationForNewTask(): void {
    this._state.validationResult = null;
    this._state.validationOverride = false;
    this._state.pmTaskValidationResult = null;
    this._view?.webview.postMessage({ type: 'validationReset' });
  }

  // On a passing validation, mark the matched proof points / acceptance criteria
  // as satisfied so the thread checklist "closes" — without touching the PM tool.
  private _markProofPointsMet(result: TyneValidationResult): void {
    if (!Array.isArray(this._state.subtasks) || this._state.subtasks.length === 0) { return; }
    const met = new Set((result.criteriaMet || []).map(c => c.toLowerCase().trim()).filter(Boolean));
    const passAll = result.status === 'pass';
    let changed = false;
    for (const sub of this._state.subtasks) {
      if (sub.done) { continue; }
      if (passAll || met.has((sub.text || '').toLowerCase().trim())) {
        sub.done = true;
        changed = true;
      }
    }
    if (changed) {
      void saveState(this._context, this._state);
      this._postState();
    }
  }

  private _handleFieldChange(field: string, value: string): void {
    (this._state as unknown as Record<string, unknown>)[field] = value;
    this._debouncedSave();
    // Thread brief edits must re-run enrichment via the shared service (same
    // path as Start Thread) — not webview-bound.
    if (isEnrichmentTriggerField(field)) {
      this._scheduleEnrichmentFromThreadEdit();
    }
  }

  /** Debounced re-enrichment after Thread goal/taskId edits. */
  private _scheduleEnrichmentFromThreadEdit(): void {
    if (this._enrichmentDebounceTimer) { clearTimeout(this._enrichmentDebounceTimer); }
    this._enrichmentDebounceTimer = setTimeout(() => {
      void this._runEnrichmentForActiveThreadTask('thread_field_edit');
    }, 600);
  }

  /**
   * Shared entry: enrich the active thread task by taskId and push state +
   * create-task eligibility to the webview (Task detail and Thread page).
   */
  private async _runEnrichmentForActiveThreadTask(reason: string): Promise<void> {
    const taskId = this._state.taskId?.trim();
    const tool = this._state.taskSource as TynePmTool;
    if (!taskId || (tool !== 'jira' && tool !== 'linear')) { return; }
    const cached = listCachedTasksSync(this._context).find(t => t.id === taskId);
    const issueType = cached?.issueType;
    this._logJira(`Enrichment (${reason}) for ${taskId}`);
    const enrichment = await this._extractIntelligenceForStartThread(taskId, tool, this._state.taskTitle || this._state.goal, issueType);
    if (enrichment.intelligence) {
      const intelligence = enrichment.intelligence;
      this._state.pmTaskContext = intelligence;
      this._state.pmEnrichmentStatus = hasEnrichmentContent(intelligence) ? 'success' : 'partial';
      this._state.pmEnrichmentError = '';
      if (intelligence.goal) { this._state.goal = intelligence.goal; }
      this._state.acceptanceCriteria = intelligence.acceptanceCriteria || [];
      this._state.proofPointTemplates = intelligence.proofPointTemplates || [];
      this._state.validationSteps = intelligence.validationSteps || [];
      this._state.subtasks = (intelligence.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    } else {
      this._state.pmEnrichmentStatus = enrichment.error ? 'failed' : 'skipped';
      this._state.pmEnrichmentError = enrichment.error || '';
    }
    await saveState(this._context, this._state);
    this._postEnrichmentToWebview(taskId);
  }

  private _postEnrichmentToWebview(taskId: string): void {
    this._view?.webview.postMessage({
      type: 'pmEnrichmentUpdated',
      taskId,
      pmEnrichmentStatus: this._state.pmEnrichmentStatus,
      pmEnrichmentError: this._state.pmEnrichmentError,
      acceptanceCriteria: this._state.acceptanceCriteria,
      proofPointTemplates: this._state.proofPointTemplates,
      validationSteps: this._state.validationSteps,
      goal: this._state.goal,
      subtasks: this._state.subtasks,
      pmTaskContext: this._state.pmTaskContext,
    });
    this._postThreadCreateTasksVisibility(taskId);
  }

  private _handleSubtaskAdd(text: string): void {
    if (!text.trim()) { return; }
    this._state.subtasks.push({ id: Date.now().toString(), text: text.trim(), done: false });
    this._debouncedSave();
    this._postState();
  }

  private _handleSubtaskToggle(id: string): void {
    const task = this._state.subtasks.find(t => t.id === id);
    if (task) { task.done = !task.done; this._debouncedSave(); this._postState(); }
  }

  private _handleSubtaskDelete(id: string): void {
    this._state.subtasks = this._state.subtasks.filter(t => t.id !== id);
    this._debouncedSave();
    this._postState();
  }

  private async _handleButtonClick(action: string): Promise<void> {
    switch (action) {
      case 'startThread': await this._startThread(); break;
      case 'switchSelectedBranch': {
        const linked = getBranchByTaskId(this._context, this._getRepositoryPath(), this._state.taskId);
        if (linked) { await this._switchToBranch(linked.branchName); }
        break;
      }
      case 'saveStitch': await this._saveStitch(); break;
      case 'stageAll':
        try {
          await vscode.commands.executeCommand('git.stageAll');
        } catch {
          await vscode.commands.executeCommand('workbench.view.scm');
        }
        await this._refreshGitStatus();
        break;
      case 'undoStitch': await this._undoStitch(); break;
      case 'validateGoal':
      case 'validateReview':
        await this._handleRunValidateReview();
        break;
      case 'generateCommitPreview': await this._generateCommitPreview(); break;
      case 'overrideProceed': await this._overrideProceed(); break;
      case 'tieKnot': await this._tieTheKnot(); break;
      default: vscode.window.showInformationMessage(`Tyne: ${action} coming soon`);
    }
  }

  private async _startThread(): Promise<void> {
    if (!this._state.taskId.trim()) { vscode.window.showErrorMessage('Select a task before starting a thread.'); return; }
    if (!this._state.appName || !this._state.goal) { vscode.window.showErrorMessage('App name and goal are required'); return; }
    if (!(await isGitRepo())) { vscode.window.showErrorMessage('Tyne could not find a Git repository in this workspace.'); return; }
    const repositoryPath = this._getRepositoryPath();
    this._setRunner(true);
    try {
      this._logJira(`Start Thread clicked: ${this._state.taskId}`);
      const taskTitle = this._state.taskTitle || this._state.goal;
      const branchName = sanitizeBranchName(this._state.taskId, taskTitle);
      const linked = getBranchByTaskId(this._context, repositoryPath, this._state.taskId);
      if (linked) {
        const choice = await vscode.window.showInformationMessage(
          `Task ${this._state.taskId} is already linked to ${linked.branchName}.`,
          'Switch to Branch',
          'Cancel',
        );
        if (choice === 'Switch to Branch') {
          await this._switchToBranch(linked.branchName);
          // Branch already existed — ensure weaving state is set now.
          this._state.status = 'weaving';
          await saveState(this._context, this._state);
          this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName: linked.branchName });
        }
        return;
      }

      const workingTree = await getWorkingTreeStatus();
      if (!workingTree.isClean) {
        const choice = await vscode.window.showWarningMessage(
          `This workspace has ${workingTree.changedFiles} uncommitted change(s). Creating a thread now will keep those changes on the new branch.`,
          'Create Branch Anyway',
          'Cancel',
        );
        if (choice !== 'Create Branch Anyway') { return; }
      }

      if (await branchExists(branchName)) {
        const choice = await vscode.window.showInformationMessage(
          `Branch ${branchName} already exists.`,
          'Switch to Existing Branch',
          'Cancel',
        );
        if (choice === 'Switch to Existing Branch') {
          await this._switchToBranch(branchName);
          // Branch already existed — ensure weaving state is set now.
          this._state.status = 'weaving';
          await saveState(this._context, this._state);
          this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
        }
        return;
      }

      if (this._isProjectLeadMode()) {
        this._view?.webview.postMessage({ type: 'prepStarted' });
        try {
          const prep = await prepareWorkspace();
          this._view?.webview.postMessage({ type: 'prepComplete', stashed: prep.stashed, pullSummary: prep.pullSummary || 'No remote to pull from', clean: prep.clean });
          await new Promise(resolve => setTimeout(resolve, 700));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'User cancelled workspace prep') { return; }
          vscode.window.showErrorMessage('Workspace prep failed: ' + message);
          this._view?.webview.postMessage({ type: 'prepComplete', error: message });
          return;
        }
      }

      await createBranch(branchName);
      this._logJira(`Branch created/switched: ${branchName}`);
      if (this._state.taskSource.toLowerCase() === 'linear') { this._logLinear(`Linear thread started: ${branchName}`); }
      const [commitCount, latestCommit] = await Promise.all([
        getCommitCount(branchName),
        getLatestCommit(branchName),
      ]);
      const record: BranchRecord = {
        taskId: this._state.taskId,
        taskTitle,
        taskSource: this._state.taskSource || 'Solo Mode',
        taskUrl: this._state.taskUrl || undefined,
        branchName,
        repositoryPath,
        createdAt: new Date().toISOString(),
        lastCheckedOutAt: new Date().toISOString(),
        currentStatus: 'active',
        commitCount,
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
      };
      await createBranchRecord(this._context, record);
      this._state.branchName = branchName;
      this._state.status = 'weaving';
      await saveState(this._context, this._state);
      this._logJira(`Active Jira task saved: ${this._state.taskId}`);
      this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
      this._startProjectLeadWatcher();
      await this._refreshBranchContext(true);
      await this._refreshCommitContext(true);
      await this._refreshGitStatus();
      vscode.window.showInformationMessage('Thread started on branch: ' + branchName);
    } catch (err: unknown) {
      vscode.window.showErrorMessage('Could not create branch: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this._setRunner(false);
    }
  }

  private async _switchToBranch(branchName: string): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath) { return; }
    if (!(await branchExists(branchName))) {
      vscode.window.showErrorMessage(`Branch ${branchName} does not exist locally.`);
      return;
    }

    const status = await getWorkingTreeStatus();
    if (!status.isClean) {
      const choice = await vscode.window.showWarningMessage(
        `You have ${status.changedFiles} uncommitted change(s). Stash them before switching?`,
        'Stash & Switch',
        'Cancel',
      );
      if (choice !== 'Stash & Switch') { return; }
      const git = getGit();
      if (!git) { throw new Error('No git repo'); }
      await git.stash(['push', '-m', `Tyne auto-stash before switching to ${branchName}`]);
    }

    await checkoutBranch(branchName);
    const [commitCount, latestCommit] = await Promise.all([
      getCommitCount(branchName),
      getLatestCommit(branchName),
    ]);
    const updated = await updateBranchRecord(this._context, repositoryPath, branchName, {
      lastCheckedOutAt: new Date().toISOString(),
      currentStatus: 'active',
      commitCount,
      latestCommitHash: latestCommit.hash,
      latestCommitMessage: latestCommit.message,
    });
    if (updated) {
      this._state.taskId = updated.taskId;
      this._state.taskTitle = updated.taskTitle;
      this._state.taskSource = updated.taskSource;
      this._state.taskUrl = updated.taskUrl || '';
      this._state.goal = updated.taskTitle;
      this._state.branchName = updated.branchName;
    }
    // Switching to a tyne/ branch means the thread is active — always set weaving.
    if (branchName.startsWith('tyne/')) {
      this._state.status = 'weaving';
    }
    await saveState(this._context, this._state);
    this._logJira(`Branch created/switched: ${branchName}`);
    if (this._state.status === 'weaving') {
      this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
    }
    await this._refreshBranchContext(true);
    await this._refreshCommitContext(true);
    await this._refreshGitStatus();
    vscode.window.showInformationMessage(`Switched to ${branchName}`);
  }

  private async _deleteBranch(branchName: string): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath) { return; }
    const currentBranch = await getCurrentBranch();
    if (currentBranch === branchName) {
      vscode.window.showWarningMessage('Tyne will not delete the current branch.');
      return;
    }
    const status = await getWorkingTreeStatus();
    if (!status.isClean) {
      vscode.window.showWarningMessage('Commit or stash your current changes before deleting another branch.');
      return;
    }

    const merged = await isBranchMerged(branchName).catch(() => false);
    const choice = await vscode.window.showWarningMessage(
      merged
        ? `Delete local branch ${branchName}?`
        : `${branchName} does not look merged yet. Delete the local branch anyway?`,
      'Delete Branch',
      'Cancel',
    );
    if (choice !== 'Delete Branch') { return; }

    await deleteLocalBranch(branchName, !merged);
    await deleteBranchRecord(this._context, repositoryPath, branchName);
    await this._refreshBranchContext(true);
    await this._refreshCommitContext(true);
    vscode.window.showInformationMessage(`Deleted local branch ${branchName}`);
  }

  private _startProjectLeadWatcher(): void {
    if (!this._isProjectLeadMode() || this._state.status !== 'weaving') { return; }
    startDriftDetection(this._state.goal, this._state.taskId, event => { this._handleDriftDetected(event); });
  }

  private _handleDriftDetected(event: DriftEvent): void {
    this._driftEvents.set(event.file, event);
    this._view?.webview.postMessage({ type: 'driftDetected', event });
    const goalPreview = this._state.goal.length > 44 ? `${this._state.goal.slice(0, 44)}...` : this._state.goal;
    vscode.window.showWarningMessage(`Tyne: "${event.file}" looks off-scope for "${goalPreview}"`, 'Park changes', 'New ticket', 'Dismiss').then(choice => {
      if (choice === 'Park changes') { this._handleDriftAction(event.file, 'park'); }
      else if (choice === 'New ticket') { this._handleDriftAction(event.file, 'new_ticket'); }
      else if (choice === 'Dismiss') { this._handleDriftAction(event.file, 'dismiss'); }
    });
  }

  private async _handleDriftAction(file: string, action: string): Promise<void> {
    const event = this._driftEvents.get(file);
    if (!event) { return; }
    if (action === 'dismiss') { this._driftEvents.delete(file); this._view?.webview.postMessage({ type: 'driftDismissed', file }); return; }
    if (action === 'park') {
      try {
        const git = getGit();
        if (!git) { throw new Error('No git repo'); }
        await git.stash(['push', '-m', `Tyne drift-park: ${file}`]);
        this._driftEvents.delete(file);
        this._view?.webview.postMessage({ type: 'driftParked', file });
        vscode.window.showInformationMessage(`Changes parked in stash for ${file} ✓`);
      } catch (err: unknown) {
        vscode.window.showWarningMessage('Could not park changes: ' + (err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (action === 'new_ticket') {
      const note = await vscode.window.showInputBox({ prompt: 'Describe this unrelated change', placeHolder: 'Fix payment form validation' });
      if (!note) { return; }
      const idea = `${file}: ${note}`;
      const parkedIdeas = [...this._getParkedIdeas(), idea];
      await this._setParkedIdeas(parkedIdeas);
      this._driftEvents.delete(file);
      this._view?.webview.postMessage({ type: 'parkedIdeaSaved', idea, parkedIdeas });
      vscode.window.showInformationMessage(`Parked idea saved: "${note}" ✓`);
    }
  }

  private async _evaluateQualityGate(gateType: 'pre_commit' | 'pre_push') {
    try {
      const service = getQualityGateService(this._context);
      const reviewResult = this._state.validateReviewResult || this._state.validationResult as unknown as TyneValidateReviewResult || null;
      const result = await service.evaluateGate(
        gateType,
        this._userProfile.tier,
        this._state.branchName,
        reviewResult,
      );
      this._view?.webview.postMessage({ type: 'qualityGateResult', result });
      // Write gate files so installed git hooks can enforce on terminal too
      if (result.blocks.length > 0) {
        await writeGateBlockFile(result.blocks.map(b => b.reason));
      } else if (result.warnings.length > 0) {
        await writeGateWarnFile(result.warnings.map(w => w.reason));
      } else {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) { clearGateFiles(folder.uri.fsPath); }
      }
      return result;
    } catch {
      return null;
    }
  }

  private async _saveStitch(): Promise<void> {
    try {
      // Quality gate: evaluate before committing
      const gateResult = await this._evaluateQualityGate('pre_commit');
      if (gateResult && !gateResult.passed && !gateResult.overridden) {
        this._view?.webview.postMessage({ type: 'qualityGateResult', result: gateResult });
        if (gateResult.blocks.length > 0) {
          vscode.window.showWarningMessage('Quality gate blocked this commit. Resolve critical issues or override.');
          return;
        }
      }

      const hash = await saveStitch(this._state.taskId || 'task');
      this._state.stitchCount += 1;
      this._state.lastStitchTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      await saveState(this._context, this._state);
      const repositoryPath = this._getRepositoryPath();
      const updated = await updateBranchRecord(this._context, repositoryPath, this._state.branchName, {
        commitCount: await getCommitCount(this._state.branchName).catch(() => this._state.stitchCount),
        latestCommitHash: hash,
        latestCommitMessage: (await getLatestCommit(this._state.branchName).catch(() => ({ hash, message: '' }))).message,
      });
      void updated;
      this._view?.webview.postMessage({ type: 'stitchSaved', hash, stitchCount: this._state.stitchCount, lastStitchTime: this._state.lastStitchTime });
      this._view?.webview.postMessage({ type: 'hasStitch', value: true });
      await this._refreshBranchContext(true);
      await this._refreshCommitContext(true);
      vscode.window.showInformationMessage(`Stitch saved ✓ (${hash.slice(0, 7)})`);
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  private async _undoStitch(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Undo last stitch? All changes since the last stitch will be lost.', 'Yes, undo', 'Cancel');
    if (pick !== 'Yes, undo') { return; }
    try {
      await undoStitch();
      this._state.stitchCount = Math.max(0, this._state.stitchCount - 1);
      await saveState(this._context, this._state);
      const stillHas = await hasStitch();
      this._view?.webview.postMessage({ type: 'stitchUndone', stitchCount: this._state.stitchCount });
      this._view?.webview.postMessage({ type: 'hasStitch', value: stillHas });
      vscode.window.showInformationMessage('Stitch undone. Rolled back to previous state.');
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  public triggerValidation(): Promise<void> {
    return this._handleRunValidateReview();
  }

  public triggerCodeReview(): void {
    this._view?.webview.postMessage({ type: 'showValidateReviewPage' });
  }

  /** Navigation-only: open Validate & Review page without starting a run. */
  public triggerValidateReview(): void {
    this._view?.webview.postMessage({ type: 'showValidateReviewPage' });
  }

  public connectJira(): void {
    void this._handleConnectPmTool('jira');
  }

  public connectLinear(): void {
    void this._handleConnectPmTool('linear');
  }

  public disconnectJira(): void {
    void this._handleDisconnectPmTool('jira');
  }

  public disconnectLinear(): void {
    void this._handleDisconnectPmTool('linear');
  }

  public refreshJiraTasks(): void {
    void this._handlePullTasks('jira');
  }

  public refreshLinearTasks(): void {
    void this._handlePullTasks('linear');
  }

  public changeJiraProject(): void {
    const adapter = getAdapter('jira') as unknown as { chooseAndSaveProject?: () => Promise<unknown> };
    void adapter.chooseAndSaveProject?.().then(() => {
      void this._postSettings();
      void this._refreshTasksContext(true);
    });
  }

  public changeLinearTeam(): void {
    const adapter = getAdapter('linear') as unknown as { chooseAndSaveTeam?: () => Promise<unknown> };
    void adapter.chooseAndSaveTeam?.().then(() => {
      void this._postSettings();
      void this._refreshTasksContext(true);
    });
  }

  private _getSupabaseUrl(): string {
    return vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  }

  private _postValidationRunning(tier: string): void {
    const normalTier = normalizeTier(tier);
    const stages = normalTier === 'max'
      ? [
          { stage: 1, name: 'Code Analysis' },
          { stage: 2, name: 'Goal Matching' },
          { stage: 3, name: 'Risk Assessment' },
          { stage: 4, name: 'Performance Check' },
          { stage: 5, name: 'Security Check' },
        ]
      : [
          { stage: 1, name: 'Code Analysis' },
          { stage: 2, name: 'Goal Matching' },
          { stage: 3, name: 'Risk Assessment' },
        ];
    const trace = this._traceService.buildValidationTraceRunning(normalTier, {
      taskId: this._state.taskId || undefined,
      taskTitle: this._state.taskTitle || undefined,
      goal: this._state.goal || undefined,
      branchName: this._state.branchName || undefined,
    });
    this._view?.webview.postMessage({ type: 'validationRunning', tier: normalTier, stages, trace });
  }

  private _mapResultToStages(result: TyneValidationResult, tier: string): Array<{ stage: number; name: string; status: 'completed' | 'failed'; details?: string }> {
    const normalTier = normalizeTier(tier);
    const isMax = normalTier === 'max';
    const isPass = result.status === 'pass';
    const base = [
      { stage: 1, name: 'Code Analysis', status: 'completed' as const, details: isMax ? `Reviewed ${result.filesReviewed?.length ?? 0} file(s)` : undefined },
      { stage: 2, name: 'Goal Matching', status: (isPass ? 'completed' : result.status === 'fail' ? 'failed' : 'completed') as 'completed' | 'failed', details: isMax ? (typeof result.matchPercent === 'number' ? `Matched ${result.matchPercent}% of requirements` : 'Requirements checked') : undefined },
      { stage: 3, name: 'Risk Assessment', status: 'completed' as const, details: isMax ? (result.riskLevel ? `Risk level: ${result.riskLevel}` : 'Risk assessed') : undefined },
    ];
    if (isMax) {
      base.push(
        { stage: 4, name: 'Performance Check', status: 'completed' as const, details: result.codeQualityNotes?.length ? `${result.codeQualityNotes.length} note(s) found` : 'No issues found' },
        { stage: 5, name: 'Security Check', status: 'completed' as const, details: result.missingRequirements?.length ? `${result.missingRequirements.length} gap(s) noted` : 'No vulnerabilities found' },
      );
    }
    return base;
  }

  private async _validateGoal(): Promise<void> {
    this._setBusy('think', true);
    this._postValidationRunning(this._userProfile.tier);
    try {
      const normalizedTier = normalizeTier(this._userProfile.tier);
      const pmSource = this._state.taskSource.toLowerCase();
      const isPmTask = (pmSource === 'jira' || pmSource === 'linear') && this._state.taskId;
      let result: TyneValidationResult;
      let pmValidationResult: TynePmTaskValidationResult | null = null;

      if (isPmTask) {
        if (pmSource === 'linear') { this._logLinear('Linear validation started'); }
        pmValidationResult = await this._validationService.validatePmTask(this._userProfile.tier);
        this._state.pmTaskValidationResult = pmValidationResult;
        result = this._mapPmValidationToTyneValidation(pmValidationResult);
        if (pmSource === 'linear') { this._logLinear('Linear validation completed'); }
      } else {
        // Run the validation without an OS-level progress notification — the
        // sidebar's live stages panel (validationRunning → validationComplete) is
        // the single surface for validation state. No window notifications.
        result = await this._validationService.validateGoal(this._userProfile.tier);
      }
      const trace = this._traceService.buildValidationTraceComplete(normalizedTier, result, {
        taskId: this._state.taskId || result.taskId || undefined,
        taskTitle: this._state.taskTitle || result.taskTitle || undefined,
        goal: this._state.goal || undefined,
        branchName: this._state.branchName || result.branchName || undefined,
      });
      result.trace = trace;

      this._state.validationResult = result;
      await saveState(this._context, this._state);

      const completedStages = this._mapResultToStages(result, this._userProfile.tier);
      const tier = normalizeTier(this._userProfile.tier);
      const usageSummary = await this._usageService.getUsageSummary(tier).catch(() => null);

      this._view?.webview.postMessage({
        type: 'validationComplete',
        result,
        pmValidationResult: pmValidationResult ?? undefined,
        stages: completedStages,
        trace,
        validationCountRemaining: usageSummary?.remaining ?? null,
        validationCountTotal: usageSummary?.limit ?? null,
      });
      this._postSettings();
      await this._postValidationHistory();
      // Result (pass/partial/fail) is shown in the sidebar scorecard — no popups.
      if (result.status === 'pass') {
        const automCtx = this._buildAutomationCtx();
        if (automCtx) { void handleValidationPass({ ...automCtx, validationResult: result }); }
      }
      // The PM task is closed on tie-the-knot (ship), NOT here. On a passing
      // validation we only mark the matched proof points / acceptance criteria as
      // satisfied so the thread checklist reflects progress without touching Jira.
      this._markProofPointsMet(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const trace = this._traceService.buildValidationTraceError(normalizeTier(this._userProfile.tier), message, {
        taskId: this._state.taskId || undefined,
        taskTitle: this._state.taskTitle || undefined,
        goal: this._state.goal || undefined,
        branchName: this._state.branchName || undefined,
      });
      // Error surfaces inline in the sidebar stages panel (validationError state).
      this._view?.webview.postMessage({ type: 'validationError', message, trace });
    } finally {
      this._setBusy('think', false);
    }
  }

  private _mapPmValidationToTyneValidation(pm: TynePmTaskValidationResult): TyneValidationResult {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: this._state.taskId,
      taskTitle: this._state.taskTitle,
      branchName: this._state.branchName,
      commitHash: undefined,
      provider: pm.modelProvider as any,
      tier: normalizeTier(this._userProfile.tier),
      status: pm.status,
      matchPercent: pm.matchPercent,
      riskLevel: 'not_assessed',
      summary: pm.summary,
      detailedExplanation: pm.recommendedNextActions.length ? pm.recommendedNextActions.join('\n') : undefined,
      missingRequirements: pm.missingWork.length ? pm.missingWork : undefined,
      criteriaMet: pm.passedCriteria.length ? pm.passedCriteria : undefined,
      criteriaNotMet: pm.failedCriteria.length ? pm.failedCriteria : undefined,
      suggestions: pm.recommendedNextActions.length ? pm.recommendedNextActions : undefined,
      codeQualityNotes: pm.generatedProofPoints.length ? pm.generatedProofPoints : undefined,
      filesReviewed: pm.codeEvidence?.length ? pm.codeEvidence.map(e => e.file) : pm.changedFiles?.length ? pm.changedFiles : undefined,
      completedGoals: pm.completedGoals,
      pendingGoals: pm.pendingGoals,
      developerActions: pm.developerActions,
      codeEvidence: pm.codeEvidence,
      fullReport: pm.fullReport,
      enrichmentStatus: pm.enrichmentStatus,
      enrichmentError: pm.enrichmentError,
      contextSource: pm.contextSource,
      confidence: pm.confidence,
      validationStatus: pm.validationStatus,
      warnings: pm.warnings,
      resolvedContext: pm.resolvedContext,
      developerTaskPlan: pm.developerTaskPlan,
      createdAt: new Date().toISOString(),
    };
  }

  private async _postValidationHistory(): Promise<void> {
    const tier = normalizeTier(this._userProfile.tier);
    const history = await this._historyService.listValidationHistory(tier);
    const summary = await this._usageService.getUsageSummary(tier);
    this._view?.webview.postMessage({
      type: 'validationHistory',
      tier,
      history: history.map(h => tier === 'free' ? this._displayService.toFreeValidationView(h) : this._displayService.toEnhancedValidationView(h)),
      summary,
      usageText: this._displayService.formatUsageSummary(summary),
    });
  }

  private async _handleValidationHistoryRequest(filters?: unknown): Promise<void> {
    const tier = normalizeTier(this._userProfile.tier);
    const history = await this._historyService.listValidationHistory(tier);
    const typedFilters = (filters || {}) as Record<string, unknown>;
    const filtered = typedFilters && Object.keys(typedFilters).length > 0
      ? await this._historyService.filterValidationHistory(typedFilters as import('./validationTypes').TyneValidationHistoryFilters)
      : history;
    this._view?.webview.postMessage({
      type: 'validationHistory',
      tier,
      history: filtered.map(h => tier === 'free' ? this._displayService.toFreeValidationView(h) : this._displayService.toEnhancedValidationView(h)),
    });
  }

  private async _handleValidationTrendsRequest(): Promise<void> {
    const tier = normalizeTier(this._userProfile.tier);
    if (tier === 'free') {
      this._view?.webview.postMessage({ type: 'validationTrends', trends: null, reason: 'Trends are available in Pro and Max.' });
      return;
    }
    const { getValidationTrendService } = await import('./validationTrendService');
    const trends = await getValidationTrendService(this._historyService).getTrendSummary();
    this._view?.webview.postMessage({ type: 'validationTrends', trends });
  }

  private async _handleReviewTrendsRequest(): Promise<void> {
    const tier = normalizeTier(this._userProfile.tier);
    if (tier === 'free') {
      this._view?.webview.postMessage({ type: 'reviewTrends', trends: null, reason: 'Review trends are available in Pro and Max.' });
      return;
    }
    try {
      const { getReviewTrendService } = await import('./reviewTrendService');
      const trends = await getReviewTrendService(this._context).getReviewTrends();
      this._view?.webview.postMessage({ type: 'reviewTrends', trends });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'reviewTrends', trends: null, reason: msg });
    }
  }

  private async _handleExportValidationHistory(format: 'csv' | 'json', filters?: unknown): Promise<void> {
    const tier = normalizeTier(this._userProfile.tier);
    if (tier === 'free') {
      vscode.window.showErrorMessage('Export is available in Pro and Max.');
      return;
    }
    const { getValidationExportService } = await import('./validationExportService');
    const typedFilters = (filters || {}) as import('./validationTypes').TyneValidationHistoryFilters;
    const exportService = getValidationExportService(this._historyService);
    const content = await exportService.exportValidationHistory(typedFilters, format);
    const filePath = await exportService.saveExportToDownloads(content, format);
    vscode.window.showInformationMessage(`Validation history exported to ${filePath}`);
    this._view?.webview.postMessage({ type: 'validationExported', format, filePath });
  }

  private async _handleExportComplianceEvidence(format: string, report?: Record<string, unknown>): Promise<void> {
    try {
      const { buildComplianceExport, buildComplianceExportFileName } = await import('./complianceEvidenceExport');
      const fmt = format === 'json' || format === 'pdf' ? format : 'markdown';
      const input = {
        reportId: String(report?.id || ''),
        commitHash: String(report?.commitSha || report?.headSha || ''),
        timestamp: String(report?.createdAt || new Date().toISOString()),
        repositoryName: String(report?.repositoryName || ''),
        branchName: String(report?.branchName || ''),
        complianceStatus: String(report?.complianceStatus || ''),
        assessments: Array.isArray(report?.complianceAssessments) ? report?.complianceAssessments as any[] : [],
        findings: Array.isArray(report?.findings) ? report?.findings as any[] : [],
        complianceFindings: Array.isArray(report?.complianceFindings) ? report?.complianceFindings as any[] : [],
        regressions: Array.isArray(report?.complianceRegressions) ? report?.complianceRegressions as any[] : [],
        disclaimer: typeof report?.complianceDisclaimer === 'string' ? report.complianceDisclaimer : undefined,
      };
      const built = buildComplianceExport(input, fmt);
      const fs = await import('fs/promises');
      const path = await import('path');
      const os = await import('os');
      const downloads = path.join(os.homedir(), 'Downloads');
      await fs.mkdir(downloads, { recursive: true });
      const filePath = path.join(downloads, buildComplianceExportFileName(fmt));
      await fs.writeFile(filePath, built.content, 'utf8');
      vscode.window.showInformationMessage(
        fmt === 'pdf'
          ? `Compliance evidence HTML saved to ${filePath} — open and Print → Save as PDF.`
          : `Compliance evidence exported to ${filePath}`,
      );
      this._view?.webview.postMessage({ type: 'complianceEvidenceExported', format: fmt, filePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Compliance export failed: ${msg}`);
    }
  }

  private async _handleComplianceFindingWorkflow(msg: Record<string, unknown>): Promise<void> {
    try {
      const service = getValidateReviewService(this._context);
      await service.saveFindingWorkflow({
        reportId: String(msg.reportId || ''),
        findingId: String(msg.findingId || ''),
        findingTitle: String(msg.findingTitle || ''),
        framework: typeof msg.framework === 'string' ? msg.framework : undefined,
        status: String(msg.status || 'open'),
        owner: typeof msg.owner === 'string' ? msg.owner : undefined,
        comments: typeof msg.comments === 'string' ? msg.comments : undefined,
        resolution: typeof msg.resolution === 'string' ? msg.resolution : undefined,
      });
      this._view?.webview.postMessage({ type: 'complianceFindingWorkflowSaved', findingId: msg.findingId, status: msg.status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'complianceFindingWorkflowError', message });
    }
  }

  private async _handleListCustomCompliancePolicies(): Promise<void> {
    try {
      const service = getValidateReviewService(this._context);
      const policies = await service.listCustomPolicies();
      this._view?.webview.postMessage({ type: 'customCompliancePoliciesLoaded', policies });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }

  private async _handleCreateCustomCompliancePolicy(policy: Record<string, unknown>): Promise<void> {
    try {
      const service = getValidateReviewService(this._context);
      const created = await service.createCustomPolicy(policy || {});
      this._view?.webview.postMessage({ type: 'customCompliancePolicyCreated', policy: created });
      await this._handleListCustomCompliancePolicies();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
      this._view?.webview.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }

  private async _handleDeleteCustomCompliancePolicy(id: string): Promise<void> {
    try {
      const service = getValidateReviewService(this._context);
      await service.deleteCustomPolicy(String(id || ''));
      this._view?.webview.postMessage({ type: 'customCompliancePolicyDeleted', id });
      await this._handleListCustomCompliancePolicies();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'customCompliancePoliciesError', message });
    }
  }

  private async _overrideProceed(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Override validation? Tie the Knot will proceed even though validation did not fully pass.', 'Yes, override', 'Cancel');
    if (pick !== 'Yes, override') { return; }
    this._state.validationOverride = true;
    await saveState(this._context, this._state);
    this._view?.webview.postMessage({ type: 'tieKnotUnlocked' });
  }

  private async _tieTheKnot(): Promise<void> {
    if (!this._state.validationResult && !this._state.validationOverride) { vscode.window.showErrorMessage('Validate your goal first, or use Override.'); return; }

    // Quality gate: evaluate before push
    const gateResult = await this._evaluateQualityGate('pre_push');
    if (gateResult && !gateResult.passed && !gateResult.overridden) {
      this._view?.webview.postMessage({ type: 'qualityGateResult', result: gateResult });
      if (gateResult.blocks.length > 0) {
        const override = await vscode.window.showWarningMessage(
          `Quality gate blocked this push:\n${gateResult.blocks.map(b => '  ✗ ' + b.reason).join('\n')}\n\nOverride and push anyway?`,
          'Override and push',
          'Cancel',
        );
        if (override !== 'Override and push') { return; }
      }
    }

    const pick = await vscode.window.showWarningMessage(`Tie the knot on "${this._state.goal}"? This will commit and push.`, 'Yes, ship it', 'Cancel');
    if (pick !== 'Yes, ship it') { return; }
    try {
      const threadState = { goal: this._state.goal, taskId: this._state.taskId, subtasks: [...this._state.subtasks], branchName: this._state.branchName };
      // Capture the validation result before clearState() wipes it — tie-the-knot
      // automation (Jira → Done + feedback comment) needs the validation context.
      const validationAtShip = this._state.validationResult;
      const { subject, body } = await this._resolveCommitMessage();
      this._setBusy('push', true);
      const { branch, pushed } = await tieTheKnot(this._state.taskId, subject, body);
      const repositoryPath = this._getRepositoryPath();
      const completedRecord = await updateBranchRecord(this._context, repositoryPath, branch, {
        currentStatus: 'inactive',
        commitCount: await getCommitCount(branch).catch(() => 0),
        latestCommitHash: (await getLatestCommit(branch).catch(() => ({ hash: '', message: '' }))).hash,
        latestCommitMessage: (await getLatestCommit(branch).catch(() => ({ hash: '', message: '' }))).message,
      });
      void completedRecord;
      stopDriftDetection();
      await clearState(this._context);
      this._state = getState(this._context);
      this._view?.webview.postMessage({ type: 'stateCleared', branch, pushed, taskId: threadState.taskId });
      await this._refreshBranchContext(true);
      await this._refreshCommitContext(true);
      if (pushed) {
        vscode.window.showInformationMessage(`Thread complete! Branch ${branch} pushed. ✓`);
        this._maybeCreateDraftPR({ ...threadState, branchName: branch });
      } else {
        vscode.window.showInformationMessage('Thread committed locally. Add a remote to push: git remote add origin <url>');
      }
      // Close the linked PM task + post the feedback comment on tie-the-knot,
      // respecting the autoCloseTrigger setting.
      void this._runTieKnotAutomation(branch, threadState.taskId, validationAtShip, pushed);
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
    finally { this._setBusy('push', false); }
  }

  private async _resolveCommitMessage(): Promise<{ subject: string; body: string }> {
    if (!this._isProjectLeadMode()) { return { subject: this._state.goal, body: '' }; }
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) { vscode.window.showWarningMessage('Commit synthesis skipped: GitHub is not connected.'); return { subject: this._state.goal, body: '' }; }

    const hasByok = await this._byokKeyService.hasApiKey();
    if (this._userProfile.tier === 'CORE' && !hasByok) {
      vscode.window.showErrorMessage('Free Tier requires your own API Key (BYOK) to synthesize commits. Configure it in Tyne settings.');
      return { subject: this._state.goal, body: '' };
    }

    try {
      this._view?.webview.postMessage({ type: 'synthStarted' });
      const synth = await synthesizeCommitMessage(this._context, this._state.goal, this._state.taskId, this._state.subtasks);
      this._setBusy('generate', false);
      const choice = await vscode.window.showInformationMessage(`Commit: "${synth.subject}"`, 'Use this', 'Edit', 'Use original goal');
      if (choice === 'Use this') { return { subject: synth.subject, body: synth.body }; }
      if (choice === 'Edit') {
        const edited = await vscode.window.showInputBox({ value: synth.subject, prompt: 'Edit commit message', placeHolder: 'feat(PRO-102): ...' });
        return { subject: edited || synth.subject, body: synth.body };
      }
    } catch (err: unknown) {
      this._setBusy('generate', false);
      vscode.window.showWarningMessage('Commit synthesis failed, using goal as message: ' + (err instanceof Error ? err.message : String(err)));
    }
    return { subject: this._state.goal, body: '' };
  }

  private async _generateCommitPreview(): Promise<void> {
    if (!this._state.taskId || this._state.status !== 'weaving') {
      vscode.window.showErrorMessage('Start a thread for this task before generating a commit.');
      return;
    }
    try {
      const { subject, body } = await this._resolveCommitMessage();
      const preview = [subject, body].filter(Boolean).join('\n\n');
      await vscode.env.clipboard.writeText(preview);
      vscode.window.showInformationMessage(`Commit preview copied: ${subject}`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async _runTieKnotAutomation(
    branchName: string,
    taskId: string,
    validationResult: TyneValidationResult | null,
    pushed: boolean,
  ): Promise<void> {
    if (!taskId || !branchName) { return; }
    const repositoryPath = this._getRepositoryPath();
    const automationCtx = buildAutomationContextFromBranch(
      this._context, repositoryPath, branchName, validationResult,
    );
    if (!automationCtx) {
      vscode.window.showWarningMessage(`Tie-the-knot: branch ${branchName} has no linked PM task, so the PM tool was not updated.`);
      return;
    }

    const settings = getAutomationSettings(this._context);
    const trigger = settings.autoCloseTrigger;

    const shouldClose = trigger === 'on_push' || trigger === 'manual_and_on_push';
    const shouldPostFeedback = settings.autoPostFeedbackAfterClose;
    if (trigger === 'disabled' && !shouldPostFeedback) { return; }
    if (!shouldClose && !shouldPostFeedback) { return; }

    const planTier: TynePlanTier = normalizeTier(this._userProfile.tier);

    if (shouldClose) {
      vscode.window.showInformationMessage('Tie-the-knot: updating the linked PM task…');
      const closeEvent = await markTaskDone(automationCtx, 'task_done');
      if (closeEvent.status === 'success') {
        await this._markCachedTaskDone(taskId);
        vscode.window.showInformationMessage(`Task status updated successfully. ${this._pmTaskLabel(taskId)} marked Done.`);
      } else if (closeEvent.status === 'skipped') {
        if (/already marked done/i.test(closeEvent.errorMessage ?? '')) {
          await this._markCachedTaskDone(taskId);
        } else {
          vscode.window.showInformationMessage(closeEvent.errorMessage ?? 'Task close skipped.');
        }
      } else if (closeEvent.status === 'failed') {
        vscode.window.showWarningMessage(closeEvent.errorMessage ?? 'Could not mark the PM task Done.');
      }
    }

    // Post work-summary comment on tie-the-knot even when auto-close is manual/disabled.
    if (shouldPostFeedback) {
      const feedbackEvent = await postFeedback(automationCtx, 'task_done', undefined, planTier, settings.maxFeedbackSections);
      if (feedbackEvent.status === 'success') {
        vscode.window.showInformationMessage('Feedback comment posted to the PM task.');
      } else if (feedbackEvent.status === 'failed') {
        vscode.window.showWarningMessage(feedbackEvent.errorMessage ?? 'Could not post the feedback comment.');
      } else if (feedbackEvent.status === 'skipped' && feedbackEvent.errorMessage) {
        vscode.window.showInformationMessage(feedbackEvent.errorMessage);
      }
    }
    await this._refreshAutomationContext(true);
    await this._refreshTasksContext(true);
  }

  // Reflect a completed task on the Tasks page immediately by marking its cached
  // entry Done, without waiting for the next Jira pull.
  private async _markCachedTaskDone(taskId: string): Promise<void> {
    try {
      await markCachedTaskDone(this._context, taskId);
    } catch (err) {
      console.error('Tyne: failed to mark cached task done', err);
    }
  }

  private async _refreshAutomationContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath) { return; }
    const taskId = this._state.taskId;
    const branchName = this._state.branchName;
    try {
      await repairAutomationStorage(this._context);
      const settings = getAutomationSettings(this._context);
      let syncState = null;
      let conflict = null;
      if (taskId) {
        syncState = await refreshTaskStatus(
          this._context, repositoryPath, taskId,
          this._state.taskTitle, this._state.taskSource,
          this._state.taskUrl || undefined, branchName || undefined,
        ).catch(() => null);
        conflict = detectStatusConflict(this._context, taskId);
      }
      const events = taskId ? listAutomationEventsForTask(this._context, taskId) : [];
      const detectorState = await getDetectorState(this._context);
      if (postMessage || this._view) {
        this._view?.webview.postMessage({
          type: 'automationDataLoaded',
          settings,
          syncState,
          conflict,
          events: events.slice(-20),
          detectorState,
          userTier: normalizeTier(this._userProfile.tier),
        });
      }
    } catch (err) {
      console.error('Tyne: automation refresh failed', err);
    }
  }

  private async _handleMarkTaskDone(): Promise<void> {
    const taskId = this._state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task to mark Done.'); return; }
    const pick = await vscode.window.showWarningMessage(
      `Mark task ${taskId} as Done in your PM tool?`, 'Yes, mark Done', 'Cancel',
    );
    if (pick !== 'Yes, mark Done') { return; }
    const ctx = this._buildAutomationCtx();
    if (!ctx) { return; }
    const ev = await markTaskDone(ctx, 'manual');
    await this._handleCompletionEvent(ev);
  }

  private async _handlePostFeedback(bodyOverride?: string): Promise<void> {
    const taskId = this._state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task to post feedback for.'); return; }
    const ctx = this._buildAutomationCtx();
    if (!ctx) { return; }
    const settings = getAutomationSettings(this._context);
    const planTier: TynePlanTier = normalizeTier(this._userProfile.tier);
    const ev = await postFeedback(ctx, 'manual', bodyOverride, planTier, settings.maxFeedbackSections);
    if (ev.status === 'success') {
      vscode.window.showInformationMessage('Feedback posted to PM task.');
    } else if (ev.status === 'skipped') {
      vscode.window.showInformationMessage(ev.errorMessage ?? 'Feedback skipped.');
    } else {
      vscode.window.showWarningMessage(ev.errorMessage ?? 'Could not post feedback. Please check PM tool permissions.');
    }
    await this._refreshAutomationContext(true);
  }

  private async _handleCompleteAndFeedback(bodyOverride?: string): Promise<void> {
    const taskId = this._state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task.'); return; }
    const pick = await vscode.window.showWarningMessage(
      `Post feedback and mark task ${taskId} Done?`, 'Yes, complete task', 'Cancel',
    );
    if (pick !== 'Yes, complete task') { return; }
    const ctx = this._buildAutomationCtx();
    if (!ctx) { return; }
    const settings = getAutomationSettings(this._context);
    const planTier: TynePlanTier = normalizeTier(this._userProfile.tier);
    const [feedbackEv, closeEv] = await completeTaskAndPostFeedback(ctx, bodyOverride, planTier, settings.maxFeedbackSections);
    const bothOk = feedbackEv.status === 'success' && closeEv.status === 'success';
    const feedbackOkCloseNot = feedbackEv.status === 'success' && closeEv.status !== 'success';
    const closeOkFeedbackNot = closeEv.status === 'success' && feedbackEv.status !== 'success';
    if (closeEv.status === 'success') { await this._markCachedTaskDone(taskId); }
    if (bothOk) {
      vscode.window.showInformationMessage('Task marked Done and feedback posted.');
    } else if (feedbackOkCloseNot) {
      vscode.window.showWarningMessage('Feedback posted, but task status could not be updated.');
    } else if (closeOkFeedbackNot) {
      vscode.window.showWarningMessage('Task marked Done, but feedback could not be posted.');
    } else {
      vscode.window.showWarningMessage(
        [feedbackEv.errorMessage, closeEv.errorMessage].filter(Boolean).join(' | ') || 'Automation step failed.',
      );
    }
    await this._refreshAutomationContext(true);
    await this._refreshTasksContext(true);
  }

  private async _handleCompletionEvent(ev: import('./automationTypes').TyneAutomationEvent, autoTriggered = false): Promise<void> {
    if (ev.status === 'success') {
      if (ev.taskId) { await this._markCachedTaskDone(ev.taskId); await this._refreshTasksContext(true); }
      vscode.window.showInformationMessage(ev.resultMessage || 'Task status updated successfully.');
    } else if (ev.status === 'partial_success') {
      if (ev.resultMessage) {
        vscode.window.showInformationMessage(ev.resultMessage);
      }
      if (hasResolvableTransitions(ev)) {
        await this._promptForJiraTransition(ev.availableTransitions, autoTriggered);
      } else {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'Jira worklog was saved, but the issue was not closed.');
      }
    } else if (ev.status === 'skipped') {
      vscode.window.showInformationMessage(ev.errorMessage ?? 'Task close skipped.');
    } else {
      if (hasResolvableTransitions(ev)) {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'No matching Jira close transition was found.');
        await this._promptForJiraTransition(ev.availableTransitions, autoTriggered);
      } else {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'Could not update task status.');
      }
    }
    await this._refreshAutomationContext(true);
  }

  private async _promptForJiraTransition(
    transitions: Array<{ id: string; name: string; toStatus?: string }>,
    autoTriggered: boolean,
  ): Promise<void> {
    const ctx = this._buildAutomationCtx();
    if (!ctx) { return; }
    const picks = transitions.map(transition => ({
      label: transition.name,
      description: transition.toStatus ? `to ${transition.toStatus}` : undefined,
      transitionId: transition.id,
    }));
    const choice = await vscode.window.showQuickPick(picks, {
      title: autoTriggered ? 'Validation logged time to Jira. Pick a transition to close the issue.' : 'No Done/Closed Jira transition found. Pick one to finish the issue.',
      placeHolder: picks.map(item => item.label).join(', '),
    });
    if (!choice) {
      vscode.window.showWarningMessage(`Jira transition still needs action. Available: ${picks.map(item => item.label).join(', ')}`);
      return;
    }
    const resolved = await resolveTaskTransition(ctx, choice.transitionId, autoTriggered ? 'validation_pass' : 'manual');
    if (resolved.status === 'success') {
      vscode.window.showInformationMessage(resolved.resultMessage || 'Jira task transitioned successfully.');
    } else {
      vscode.window.showWarningMessage(resolved.errorMessage ?? 'Could not apply the selected Jira transition.');
    }
  }

  private async _handlePreviewFeedback(): Promise<void> {
    const taskId = this._state.taskId;
    if (!taskId) { return; }
    const repositoryPath = this._getRepositoryPath();
    const settings = getAutomationSettings(this._context);
    const planTier: TynePlanTier = normalizeTier(this._userProfile.tier);
    try {
      const preview = await previewFeedback(
        this._context, repositoryPath, taskId,
        this._state.taskTitle, this._state.branchName || undefined,
        this._state.validationResult, settings.requireValidationBeforeFeedback,
        planTier, settings.maxFeedbackSections,
      );
      this._view?.webview.postMessage({ type: 'automationFeedbackPreview', preview });
    } catch (err) {
      vscode.window.showErrorMessage('Could not generate feedback preview.');
      console.error(err);
    }
  }

  private async _handleSaveAutomationSettings(settings: TyneTaskAutomationSettings): Promise<void> {
    if (!settings) { return; }
    const existing = getAutomationSettings(this._context);
    const isMax = normalizeTier(this._userProfile.tier) === 'max';
    const allowedFrameworks: ComplianceFramework[] = ['HIPAA', 'SOC2', 'PCI_DSS', 'GDPR', 'ISO27001', 'NIST_CSF', 'NIST_800_53', 'FEDRAMP', 'CCPA_CPRA', 'SOX', 'CUSTOM'];
    const complianceFrameworks = Array.isArray(settings.complianceFrameworks)
      ? settings.complianceFrameworks.filter((framework): framework is ComplianceFramework => allowedFrameworks.includes(framework))
      : [];
    const merged = {
      ...existing,
      ...settings,
      complianceChecksEnabled: isMax && settings.complianceChecksEnabled === true,
      // Honor the user's explicit selection — including an empty list — instead of
      // silently forcing HIPAA. Non-MAX users carry no frameworks.
      complianceFrameworks: isMax ? complianceFrameworks : [],
      privacyMode: ['cloud', 'privacy_enhanced', 'local_compliance'].includes(String(settings.privacyMode))
        ? settings.privacyMode
        : existing.privacyMode || 'cloud',
      dataResidency: ['us', 'eu', 'local_only', 'enterprise_managed'].includes(String(settings.dataResidency))
        ? settings.dataResidency
        : existing.dataResidency || 'us',
      evidencePersistenceDisabled: settings.evidencePersistenceDisabled === true
        || settings.privacyMode === 'local_compliance',
    };
    await saveAutomationSettings(this._context, merged);
    vscode.window.showInformationMessage('Automation settings saved.');
    await this._refreshAutomationContext(true);
  }

  private async _handleSaveMaxReportSettings(sections: TyneMaxFeedbackSection[]): Promise<void> {
    if (!Array.isArray(sections)) { return; }
    const settings = getAutomationSettings(this._context);
    const validSections = sections.filter((s): s is TyneMaxFeedbackSection => ALL_MAX_FEEDBACK_SECTIONS.includes(s));
    settings.maxFeedbackSections = validSections.length ? validSections : [...ALL_MAX_FEEDBACK_SECTIONS];
    await saveAutomationSettings(this._context, settings);
    vscode.window.showInformationMessage('MAX report settings saved.');
    await this._refreshAutomationContext(true);
  }

  private async _handleReinstallCommitHook(): Promise<void> {
    const state = await reinstallPostCommitHook(this._context);
    this._view?.webview.postMessage({ type: 'commitDetectorState', state });
    // Also install quality gate hooks (pre-commit + pre-push)
    const gateResult = await installQualityGateHooks(this._context);
    vscode.window.showInformationMessage(
      state.hookInstalled
        ? `Git hooks installed.${gateResult.preCommitInstalled ? ' Pre-commit quality gate active.' : ''}${gateResult.prePushInstalled ? ' Pre-push quality gate active.' : ''}`
        : `Git hook could not be installed: ${state.error || 'unknown error'}. Watcher fallback active.`,
    );
  }

  private _buildAutomationCtx(): AutomationContext | null {
    const taskId = this._state.taskId;
    if (!taskId) { return null; }
    return {
      context: this._context,
      repositoryPath: this._getRepositoryPath(),
      taskId,
      taskTitle: this._state.taskTitle || undefined,
      taskSource: this._state.taskSource,
      taskUrl: this._state.taskUrl || undefined,
      branchName: this._state.branchName || undefined,
      validationResult: this._state.validationResult,
    };
  }

  // ── Task Management Methods ────────────────────────────────────────────────

  private async _refreshTasksContext(postMessage: boolean): Promise<void> {
    try {
      const repairResult = await repairTaskCache(this._context);
      if (repairResult.repaired) {
        vscode.window.showWarningMessage(repairResult.message ?? 'Task cache repaired.');
      }
      await repairPresetStorage(this._context);
      const syncSummary = buildOfflineSyncSummary(this._context);
      const rawTier = (this._userProfile?.tier ?? 'CORE').toLowerCase();
      const normTier = (rawTier === 'core' ? 'free' : rawTier) as 'free' | 'pro' | 'max';
      const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
      const pmIntegration = await this._buildPmIntegrationSnapshot(jiraIntegration);
      const connectedTools = pmIntegration.connectedTools;
      const allTasks = this._getVisibleCachedTasks();
      if (postMessage || this._view) {
        this._view?.webview.postMessage({
          type: 'tasksDataLoaded',
          // Ranked so the Thread picker and the Tasks list agree on what to
          // start first, without the webview re-deriving anything.
          tasks: this._rankTasksForView(allTasks, 'recommended'),
          connectedTools,
          syncSummary,
          jiraIntegration,
          pmIntegration,
          tier: normTier,
          isFreeTier: isFreeTier(this._userProfile?.tier ?? 'CORE'),
          canWrite: canUsePmWrite(this._userProfile?.tier ?? 'CORE'),
          presets: listPresetsSync(this._context),
          defaultPreset: getDefaultPreset(this._context),
        });
      }
      if (!postMessage) {
        void this._maybeRefreshStaleJiraTasks(syncSummary, jiraIntegration.connected);
      }
    } catch (err) {
      console.error('Tyne: task refresh failed', err);
    }
  }

  private async _maybeRefreshStaleJiraTasks(
    syncSummary: { syncStates?: Array<{ sourceTool: string; syncStatus: string; lastSyncedAt?: string }> },
    jiraConnected: boolean,
  ): Promise<void> {
    if (this._jiraBackgroundRefreshInFlight || !jiraConnected) { return; }
    const jiraState = (syncSummary.syncStates || []).find(state => state.sourceTool === 'jira');
    if (!jiraState || jiraState.syncStatus === 'syncing') { return; }
    const lastSyncedAt = jiraState.lastSyncedAt ? new Date(jiraState.lastSyncedAt).getTime() : 0;
    const stale = !lastSyncedAt || Date.now() - lastSyncedAt >= 5 * 60 * 1000;
    if (!stale) { return; }
    if (Date.now() - this._jiraLastBackgroundRefreshAt < 60_000) { return; }

    const online = await isOnline().catch(() => false);
    if (!online) { return; }

    this._jiraBackgroundRefreshInFlight = true;
    this._jiraLastBackgroundRefreshAt = Date.now();
    try {
      await pullTasks(this._context, 'jira');
    } catch {
      // Keep cached data visible and let sync state drive the UI.
    } finally {
      this._jiraBackgroundRefreshInFlight = false;
      await this._refreshTasksContext(true);
    }
  }

  private async _handlePullTasks(tool?: TynePmTool): Promise<void> {
    const connectedTools = getConnectedToolsSync(this._context);
    if (!connectedTools.length) {
      vscode.window.showInformationMessage('Connect a PM tool to pull your tasks.');
      return;
    }
    this._view?.webview.postMessage({ type: 'tasksSyncing', tool: tool ?? 'all' });
    const touchesJira = tool === 'jira' || !tool;
    const touchesLinear = tool === 'linear' || !tool;
    if (touchesJira) { this._logJira('Refreshing Jira tasks...'); }
    if (touchesLinear) { this._logLinear('Refreshing Linear issues...'); }
    try {
      const online = await isOnline();
      if (!online) {
        vscode.window.showWarningMessage('You are offline. Showing cached tasks.');
        await this._refreshTasksContext(true);
        return;
      }
      // Explicit refresh: always bypass the provider-side issue cache so the list
      // reflects current Jira assignment, then replace (not merge) the cached list.
      const input = { ...DEFAULT_PULL_INPUT, forceRefresh: true };
      if (tool) {
        const tasks = await pullTasks(this._context, tool, input);
        if (tool === 'jira') { this._logJira(`Jira tasks refreshed: count=${tasks.length}`); }
        if (tool === 'linear') { this._logLinear(`Linear issues refreshed: count=${tasks.length}`); }
      } else {
        const tasks = await pullAllConnectedProviderTasks(this._context, input);
        this._logJira(`Jira tasks refreshed: count=${tasks.filter(t => t.sourceTool === 'jira').length}`);
        this._logLinear(`Linear issues refreshed: count=${tasks.filter(t => t.sourceTool === 'linear').length}`);
      }
      await this._refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (touchesJira) { this._logJira(`Jira task refresh failed: ${msg}`); }
      if (touchesLinear) { this._logLinear(`Linear issue refresh failed: ${msg}`); }
      vscode.window.showWarningMessage(`Task pull failed: ${msg}`);
      // Keep the previously cached list visible; the sync state surfaces the error.
      await this._refreshTasksContext(true);
    }
  }

  private async _isGithubConnected(): Promise<boolean> {
    return Boolean(await this._context.secrets.get('tyne_github_token'));
  }

  private _logJira(message: string): void {
    this._jiraLog.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private _logLinear(message: string): void {
    this._jiraLog.appendLine(`[${new Date().toISOString()}] [Linear] ${message}`);
  }

  // Derive a Jira issue key from a unified task id (e.g. "jira:TYNE-12" → "TYNE-12").
  private _jiraKeyFromTaskId(taskId: string): string {
    return taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
  }

  private _pmTaskLabel(taskId: string): string {
    return taskId.replace(/^(linear|jira|asana|notion|monday):/i, '');
  }

  // Extract a Jira issue key from a browse URL (".../browse/TYNE-12"); returns
  // empty string for non-Jira URLs so we never log unrelated external opens.
  private _jiraKeyFromUrl(url: string): string {
    const match = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(url);
    return match ? match[1] : '';
  }

  // Map a raw thrown error from the hosted Jira OAuth path to a clear, actionable user message.
  private _classifyJiraConnectError(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('connect github')) { return 'Connect GitHub first to use Jira.'; }
    if (m.includes('invalid github token') || (m.includes('401') && m.includes('github'))) {
      return 'Your GitHub session expired. Reconnect GitHub, then connect Jira.';
    }
    if (m.includes('user profile not found') || (m.includes('404') && m.includes('profile'))) {
      return 'Your Tyne profile is not initialized yet. Reconnect GitHub or restart Tyne, then try Jira again.';
    }
    if (m.includes('missing supabase function environment')) {
      return 'Jira backend is not configured. Admin must set JIRA_CLIENT_ID and JIRA_REDIRECT_URI in Supabase.';
    }
    if (m.includes('state creation failed')) {
      return 'Jira backend could not create the OAuth state. Open Tyne: Jira logs for details.';
    }
    if (m.includes('timed out')) {
      return 'Jira login timed out before returning to VS Code. Try again and allow VS Code to open from the browser.';
    }
    if (m.includes('401') || m.includes('unauthorized') || m.includes('expired')) {
      return 'Jira connection expired. Reconnect Jira.';
    }
    // State creation, exchange, or any other backend start failure.
    return 'Could not start Jira connection. Open Tyne logs.';
  }

  private _classifyLinearConnectError(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('connect github')) { return 'Connect GitHub first to use Linear.'; }
    if (m.includes('invalid github token') || (m.includes('401') && m.includes('github'))) {
      return 'Your GitHub session expired. Reconnect GitHub, then connect Linear.';
    }
    if (m.includes('user profile not found') || (m.includes('404') && m.includes('profile'))) {
      return 'Your Tyne profile is not initialized yet. Reconnect GitHub or restart Tyne, then try Linear again.';
    }
    if (m.includes('missing supabase function environment')) {
      return 'Linear backend is not configured. Admin must set LINEAR_CLIENT_ID and LINEAR_REDIRECT_URI in Supabase.';
    }
    if (m.includes('state creation failed')) {
      return 'Linear backend could not create the OAuth state. Open Tyne logs for details.';
    }
    if (m.includes('timed out')) {
      return 'Linear login timed out before returning to VS Code. Try again and allow VS Code to open from the browser.';
    }
    return 'Could not start Linear connection. Open Tyne logs.';
  }

  private async _handleConnectPmTool(tool: TynePmTool): Promise<void> {
    if (!tool) { return; }

    if ((tool === 'jira' || tool === 'linear') && !(await this._isGithubConnected())) {
      if (tool === 'jira') { this._logJira('Connect blocked: GitHub is not connected.'); }
      if (tool === 'linear') { this._logLinear('Connect blocked: GitHub is not connected.'); }
      const message = `Connect GitHub first to use ${tool === 'jira' ? 'Jira' : 'Linear'}.`;
      vscode.window.showErrorMessage(message);
      this._view?.webview.postMessage({ type: 'pmConnectFailed', tool, message, needsGithub: true });
      return;
    }

    const tier = this._userProfile?.tier ?? 'CORE';
    const canConnect = await canConnectProvider(this._context, tier, tool);
    if (!canConnect) {
      vscode.window.showWarningMessage('Free plan supports one PM tool. Upgrade to Pro or Max to connect all PM tools.');
      this._view?.webview.postMessage({ type: 'pmConnectBlocked', tool, reason: 'tier_limit' });
      return;
    }

    try {
      if (tool === 'jira') { this._logJira('Starting Jira connection (hosted OAuth)…'); }
      if (tool === 'linear') { this._logLinear('Starting Linear connection...'); }
      this._view?.webview.postMessage({ type: 'pmConnecting', tool });
      const result = await connectTool(this._context, tool, tier);
      if (result.ok) {
        if (tool === 'jira') { this._logJira('Jira connected successfully.'); }
        if (tool === 'linear') { this._logLinear('Linear connected successfully'); }
        const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
        const pmIntegration = await this._buildPmIntegrationSnapshot(jiraIntegration);
        // #region agent log
        this._agentDebugLog({
          runId: 'audit1',
          hypothesisId: 'A',
          location: 'TyneSidebarProvider.ts:pmConnectSuccess',
          message: 'host connect success snapshot',
          data: {
            tool,
            jiraConnected: Boolean(jiraIntegration?.connected),
            linearConnected: Boolean(pmIntegration?.linear?.connected),
            connectedTools: pmIntegration?.connectedTools || [],
            pmJiraConnected: Boolean(pmIntegration?.jira?.connected),
            githubConnected: Boolean(pmIntegration?.githubConnected),
          },
        });
        // #endregion
        this._view?.webview.postMessage({
          type: 'pmConnectSuccess',
          tool,
          jiraIntegration,
          pmIntegration,
          connectedTools: pmIntegration.connectedTools,
        });
        await this._postIntegrationState();
        if (result.warning) {
          vscode.window.showWarningMessage(result.warning);
        } else {
          vscode.window.showInformationMessage(`Connected to ${tool}. Pulling tasks…`);
        }
        await this._handlePullTasks(tool);
      } else {
        if (tool === 'jira') { this._logJira(`Jira connection not completed: ${result.message}`); }
        if (tool === 'linear') { this._logLinear(`Linear connection not completed: ${result.message}`); }
        vscode.window.showWarningMessage(result.message);
        this._view?.webview.postMessage({ type: 'pmConnectFailed', tool, message: result.message });
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      if (tool === 'jira') {
        if (err instanceof JiraOAuthStateError) {
          this._logJira(`Jira OAuth state failed: status=${err.status} error=${err.backendError}`);
        } else {
          this._logJira(`Jira connection failed: ${raw}`);
        }
        const friendly = this._classifyJiraConnectError(raw);
        void vscode.window.showErrorMessage(friendly, 'Open Tyne logs').then(choice => {
          if (choice === 'Open Tyne logs') { this._jiraLog.show(true); }
        });
        this._view?.webview.postMessage({ type: 'pmConnectFailed', tool, message: friendly });
      } else if (tool === 'linear') {
        if (err instanceof LinearOAuthStateError) {
          this._logLinear(`Linear OAuth state failed: status=${err.status} error=${err.backendError}`);
        } else {
          this._logLinear(`Linear connection failed: ${raw}`);
        }
        const friendly = this._classifyLinearConnectError(raw);
        void vscode.window.showErrorMessage(friendly, 'Open Tyne logs').then(choice => {
          if (choice === 'Open Tyne logs') { this._jiraLog.show(true); }
        });
        this._view?.webview.postMessage({ type: 'pmConnectFailed', tool, message: friendly });
      } else {
        vscode.window.showErrorMessage(`Could not connect ${tool}: ${raw}`);
        this._view?.webview.postMessage({ type: 'pmConnectFailed', tool, message: raw });
      }
    }

    try { await this._postSettings(); } catch (e) { console.error('Tyne: _postSettings after connect failed', e); }
    try { await this._refreshTasksContext(true); } catch (e) { console.error('Tyne: _refreshTasksContext after connect failed', e); }
  }

  private async _handleDisconnectPmTool(tool: TynePmTool): Promise<void> {
    if (!tool) { return; }
    const pick = await vscode.window.showWarningMessage(
      `Disconnect ${tool}? Cached tasks will be kept locally.`, 'Yes, disconnect', 'Cancel',
    );
    if (pick !== 'Yes, disconnect') { return; }
    await disconnectTool(this._context, tool);
    vscode.window.showInformationMessage(`Disconnected from ${tool}.`);
    await this._postIntegrationState();
    await this._postSettings();
    await this._refreshTasksContext(true);
  }

  private async _handleRunCodeReview(mode: TyneReviewMode): Promise<void> {
    if (!this._isAuthenticated) {
      this._view?.webview.postMessage({ type: 'codeReviewError', message: 'Sign in to run Technical Review.' });
      return;
    }
    const authToken = await getEffectiveAuthToken(this._context);
    if (!authToken) {
      this._view?.webview.postMessage({ type: 'codeReviewError', message: 'Sign in to run a review.' });
      return;
    }

    const normalizedMode = (['staged_changes', 'current_branch', 'pm_task', 'before_commit', 'before_pr'].includes(mode as string)
      ? mode
      : 'staged_changes') as TyneReviewMode;
    // Merged into Validate & Review — 'quick' mode for technical review entry points.
    this._view?.webview.postMessage({ type: 'validateReviewRunning' });
    try {
      const service = getValidateReviewService(this._context);
      const reviewMode: ReviewMode = normalizedMode === 'before_pr' || normalizedMode === 'pm_task' ? 'full' : 'quick';
      const scopeMap: Record<string, ReviewScope | undefined> = {
        staged_changes: 'staged_changes',
        current_branch: 'unstaged_changes',
        before_commit: 'staged_changes',
        before_pr: 'last_commit',
        pm_task: undefined,
      };
      const result = await service.runReview(
        this._userProfile.tier,
        undefined,
        scopeMap[normalizedMode],
        undefined,
        reviewMode,
        (ev) => this._view?.webview.postMessage(ev),
      );
      this._state.validateReviewResult = result;
      this._view?.webview.postMessage({
        type: 'codeReviewResult',
        result: {
          id: result.id || `review_${Date.now()}`,
          status: result.status,
          score: result.score,
          summary: result.summary,
          findings: result.findings,
          reviewMode: normalizedMode,
          actualModeUsed: result.actualModeUsed,
          reviewWarnings: result.reviewWarnings,
          createdAt: result.createdAt || new Date().toISOString(),
        },
      });
      this._view?.webview.postMessage({ type: 'validateReviewResult', result });
    } catch (err: unknown) {
      const message = err instanceof ValidateReviewError ? err.message : 'Code review failed. Try again.';
      this._view?.webview.postMessage({ type: 'codeReviewError', message });
    }
  }

  private async _handleRunValidateReview(scope?: string, selectedCommitSha?: string): Promise<void> {
    if (!this._isAuthenticated) {
      this._view?.webview.postMessage({ type: 'validateReviewError', message: 'Sign in to run a review.' });
      this._view?.webview.postMessage({ type: 'validationError', message: 'Sign in to run Validate & Review.' });
      return;
    }
    const authToken = await getEffectiveAuthToken(this._context);
    if (!authToken) {
      this._view?.webview.postMessage({ type: 'validateReviewError', message: 'Sign in to run a review.' });
      this._view?.webview.postMessage({ type: 'validationError', message: 'Sign in to run Validate & Review.' });
      return;
    }

    // Single in-flight UI: Validate & Review page runner (no full-screen pixel / Thread stages).
    this._view?.webview.postMessage({ type: 'validateReviewRunning' });

    try {
      const state = this._state;
      let pmTask: ReviewPmTaskContext | undefined;
      if (state.taskId) {
        const source = state.taskId.startsWith('linear:') ? 'linear' : 'jira';
        pmTask = {
          source,
          issueIdentifier: state.pmTaskContext?.issueIdentifier || state.taskId,
          title: state.taskTitle || state.goal || 'Untitled task',
          description: state.goal,
          goal: state.goal,
          acceptanceCriteria: state.acceptanceCriteria,
          subtasks: state.subtasks.map(s => ({ title: s.text, status: s.done ? 'completed' : 'not_started' })),
          validationSteps: state.validationSteps,
          decisions: state.pmTaskContext?.pmContext?.decisions,
          constraints: state.pmTaskContext?.pmContext?.constraints,
          blockers: state.pmTaskContext?.pmContext?.blockers,
          openQuestions: state.pmTaskContext?.pmContext?.openQuestions,
          attachments: state.pmTaskContext?.pmContext?.attachments.map(a => ({ name: a.name, summary: a.summary })),
          comments: state.pmTaskContext?.pmContext?.comments,
          linkedIssues: state.pmTaskContext?.pmContext?.linkedIssues,
          developerTaskPlan: state.pmTaskContext?.developerTaskPlan,
        };
      }

      const service = getValidateReviewService(this._context);
      const validScopes = ['staged_changes', 'unstaged_changes', 'last_commit', 'selected_commit'];
      const resolvedScope = scope && validScopes.includes(scope) ? scope as ReviewScope : undefined;
      await this._prepareWorkspaceForReview(resolvedScope);
      const result = await service.runReview(
        this._userProfile.tier,
        pmTask,
        resolvedScope,
        selectedCommitSha,
        'full',
        (ev) => this._view?.webview.postMessage(ev),
      );
      this._state.validateReviewResult = result;
      this._state.latestValidateReviewReportId = result.id || '';
      publishReviewDiagnostics(result);
      this._state.validationResult = this._mapValidateReviewToTyneValidation(result);
      await saveState(this._context, this._state);
      const trace = this._traceService.buildValidationTraceComplete(normalizeTier(this._userProfile.tier), this._state.validationResult, {
        taskId: this._state.taskId || undefined,
        taskTitle: this._state.taskTitle || undefined,
        goal: this._state.goal || undefined,
        branchName: this._state.branchName || result.branchName || undefined,
      });
      this._state.validationResult.trace = trace;
      await saveState(this._context, this._state);
      await this._historyService.saveValidationResult(this._state.validationResult);
      const completedStages = this._mapResultToStages(this._state.validationResult, this._userProfile.tier);
      this._view?.webview.postMessage({ type: 'validateReviewResult', result });
      this._view?.webview.postMessage({
        type: 'validationComplete',
        result: this._state.validationResult,
        stages: completedStages,
        trace,
      });
      this._markProofPointsMet(this._state.validationResult);
      await this._postValidateReviewReports();
    } catch (err: unknown) {
      const message = err instanceof ValidateReviewError ? err.message : 'Review failed. Try again.';
      this._view?.webview.postMessage({ type: 'validateReviewError', message });
      this._view?.webview.postMessage({ type: 'validationError', message });
    }
  }

  private async _handleFindingFeedback(feedback: Record<string, unknown>): Promise<void> {
    try {
      const request: FindingFeedbackRequest = {
        reportId: String(feedback.reportId || ''),
        findingId: String(feedback.findingId || ''),
        verdict: feedback.verdict as FindingVerdict,
        findingTitle: String(feedback.findingTitle || ''),
        findingFile: feedback.findingFile as string | undefined,
        findingCategory: feedback.findingCategory as string | undefined,
        findingSeverity: feedback.findingSeverity as string | undefined,
        repositoryId: this._getRepositoryId(),
      };
      const service = getValidateReviewService(this._context);
      await service.submitFindingFeedback(request);
      this._view?.webview.postMessage({ type: 'findingFeedbackConfirmed', findingId: request.findingId, verdict: request.verdict });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'findingFeedbackError', message: msg });
    }
  }

  private async _handleCreateTaskFromFinding(finding: Record<string, unknown>): Promise<void> {
    const tier = this._userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this._view?.webview.postMessage({ type: 'taskWriteBlocked', reason: 'Creating tasks from findings is available in Pro and Max.' });
      return;
    }
    try {
      const state = this._state;
      const sourceTool: TynePmTool = state.taskSource.toLowerCase() === 'linear' ? 'linear' : 'jira';
      const title = String(finding.title || 'Review finding');
      const category = String(finding.category || 'correctness');
      const isScopeGap = category === 'pm_alignment';
      const fileLoc = finding.file ? `${finding.file}${finding.line ? ':' + finding.line : ''}` : '';
      const description = [
        String(finding.explanation || ''),
        fileLoc ? `\n**File:** ${fileLoc}` : '',
        finding.suggestedFix ? `\n**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`` : '',
        `\n**Severity:** ${finding.severity || 'medium'} · **Category:** ${category}`,
      ].join('');
      const input: TyneCreateTaskInput = {
        title: `${isScopeGap ? '[Scope]' : '[Review]'} ${title.slice(0, 100)}`,
        description,
        status: 'todo',
        priority: finding.severity === 'critical' ? 'urgent' : finding.severity === 'high' ? 'high' : 'medium',
        sourceTool,
      };
      const details = await pmCreateTask(this._context, tier, input);
      this._view?.webview.postMessage({ type: 'taskCreated', details });
      vscode.window.showInformationMessage(`Task created from ${isScopeGap ? 'scope gap' : 'finding'}: ${details.title}`);
      await this._refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Create task from finding failed: ${msg}`);
    }
  }

  private async _handleFixPendingGoal(goal: Record<string, unknown>): Promise<void> {
    const relatedFile = String(goal.relatedFile || '');
    const relatedFiles = Array.isArray(goal.relatedFiles)
      ? goal.relatedFiles.map(f => String(f || '')).filter(Boolean)
      : [];
    const file = relatedFile || relatedFiles[0] || '';
    const suggestedAction = String(goal.suggestedAction || '').trim();
    const title = String(goal.title || 'Pending scope item');

    if (suggestedAction) {
      await vscode.env.clipboard.writeText(suggestedAction);
    }

    if (file) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, { preview: true });
          vscode.window.showInformationMessage(
            suggestedAction
              ? `Opened ${file}. Suggested action copied to clipboard.`
              : `Opened ${file} for: ${title}`
          );
          return;
        } catch {
          // Fall through to clipboard / message if file cannot be opened.
        }
      }
    }

    if (suggestedAction) {
      vscode.window.showInformationMessage(`Suggested action copied: ${suggestedAction}`);
      return;
    }
    vscode.window.showInformationMessage(`No file or suggested action for: ${title}`);
  }

  private async _handlePendingGoalFeedback(goal: Record<string, unknown>): Promise<void> {
    const title = String(goal.title || 'Pending scope item');
    const verdict = String(goal.verdict || '');
    if (verdict === 'out_of_scope') {
      vscode.window.showInformationMessage(`Marked out of scope: ${title}`);
      this._view?.webview.postMessage({
        type: 'pendingGoalFeedbackConfirmed',
        title,
        verdict: 'out_of_scope',
      });
      return;
    }
    vscode.window.showInformationMessage(`Recorded feedback for: ${title}`);
  }

  private _autoApplyPolicy(): AutoApplyPolicy {
    const raw = vscode.workspace.getConfiguration('tyne').get<string>('actionEngine.autoApplyPolicy', 'applyable_only');
    return raw === 'never' ? 'never' : 'applyable_only';
  }

  private _logApplyAudit(entry: Record<string, unknown>): void {
    this._applyAudit.push(entry);
    if (this._applyAudit.length > 100) { this._applyAudit.shift(); }
    this._actionLog.appendLine(JSON.stringify(entry));
    void this._context.globalState.update('tyne.applyAudit', this._applyAudit.slice(-50));
  }

  /**
   * When the last review ran on staged changes, a fix written to the working
   * tree is invisible to the next `git diff --cached` — re-stage it so the
   * re-validation actually sees the fix.
   */
  private async _restageAfterFix(file: string): Promise<boolean> {
    if (this._state.validateReviewResult?.scope !== 'staged_changes') { return false; }
    const git = getGit();
    if (!git) { return false; }
    try {
      await git.add([file]);
      return true;
    } catch {
      vscode.window.showWarningMessage(
        `Fix saved, but ${file} could not be re-staged. Run "git add ${file}" before re-validating, or the review will see the old staged version.`,
      );
      return false;
    }
  }

  /**
   * Make sure applied/agent fixes reach the reviewed diff before validation:
   * save dirty buffers (git reads from disk) and, for staged scope, surface
   * staged files whose working-tree copy has newer edits.
   */
  private async _prepareWorkspaceForReview(scope?: ReviewScope): Promise<void> {
    const hasDirty = vscode.workspace.textDocuments.some(d => d.isDirty && !d.isUntitled);
    if (hasDirty) {
      try { await vscode.workspace.saveAll(false); } catch { /* validation proceeds on disk state */ }
    }

    const effectiveScope = scope || await resolveReviewScope().catch(() => undefined);
    if (effectiveScope !== 'staged_changes') { return; }
    const git = getGit();
    if (!git) { return; }
    const status = await git.status().catch(() => null);
    if (!status) { return; }
    const drifted = status.files
      .filter(f => f.index !== ' ' && f.index !== '?' && f.index !== '' && f.working_dir !== ' ' && f.working_dir !== '?' && f.working_dir !== '')
      .map(f => f.path);
    if (!drifted.length) { return; }

    const choice = await vscode.window.showWarningMessage(
      `${drifted.length} staged file(s) also have newer unstaged edits (e.g. applied fixes). The review validates the staged version only.`,
      'Stage Latest & Validate',
      'Validate Staged Only',
    );
    if (choice === 'Stage Latest & Validate') {
      try {
        await git.add(drifted);
      } catch {
        vscode.window.showWarningMessage('Could not stage the edited files — the review will use the currently staged versions.');
      }
    }
  }

  private async _handleAgentFix(finding: Record<string, unknown>): Promise<void> {
    const classified = classifyFindingAction(finding);
    const prompt = classified.agentPrompt || buildAgentPrompt(finding);
    await vscode.env.clipboard.writeText(prompt);
    const file = String(finding.file || '');
    if (file) {
      await openFindingInEditor({
        file,
        line: typeof finding.line === 'number' ? finding.line : Number(finding.line) || undefined,
        endLine: typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || undefined,
      });
    }

    const handedOff = await this._handoffPromptToIdeAgent(prompt);
    this._logApplyAudit({
      event: 'agent_fix',
      findingId: String(finding.id || ''),
      reportId: String(finding.reportId || 'current'),
      file,
      actionClass: classified.actionClass,
      handedOff,
      at: new Date().toISOString(),
    });
    this._view?.webview.postMessage({
      type: 'agentFixDone',
      findingId: String(finding.id || ''),
      reportId: String(finding.reportId || 'current'),
      handedOff,
    });
    vscode.window.showInformationMessage(
      handedOff
        ? 'Fix in IDE: prompt opened in your agent chat. Review and send.'
        : 'Fix in IDE: prompt copied. Paste into Cursor / Claude / Codex / Copilot / Kimi chat.',
    );
  }

  /** Best-effort open of the host IDE agent chat with the prompt ready. */
  private async _handoffPromptToIdeAgent(prompt: string): Promise<boolean> {
    const tryOpen = async (command: string, args?: unknown): Promise<boolean> => {
      try {
        await vscode.commands.executeCommand(command, ...(args === undefined ? [] : [args]));
        return true;
      } catch {
        return false;
      }
    };

    // VS Code Copilot Chat accepts a prompt argument.
    if (await tryOpen('workbench.action.chat.open', { query: prompt })) { return true; }
    if (await tryOpen('workbench.action.chat.open', prompt)) { return true; }

    // Cursor Composer / Agent: open chat then paste (no official prompt arg).
    const openedComposer =
      (await tryOpen('composer.newAgentChat')) ||
      (await tryOpen('composer.startComposerPrompt')) ||
      (await tryOpen('aichat.newchataction'));
    if (openedComposer) {
      await new Promise(resolve => setTimeout(resolve, 120));
      try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async _handlePreviewFix(finding: Record<string, unknown>): Promise<void> {
    const file = String(finding.file || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const endLine = typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || 0;
    const classified = classifyFindingAction(finding);
    // Preview is read-only, so unlike apply it does not require the fix to be
    // auto-applyable — a low-confidence or security fix is still worth showing
    // side by side. Fall back to the added lines of a structured unified diff.
    const structured = finding.fix as { diff?: string } | undefined;
    const diffProposal = typeof structured?.diff === 'string'
      ? structured.diff
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1))
        .join('\n')
      : '';
    const suggestedFix = String(classified.suggestedFix || finding.suggestedFix || diffProposal || '');
    if (!file) {
      vscode.window.showWarningMessage('No file path associated with this finding.');
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      if (!suggestedFix.trim()) {
        const range = line > 0
          ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
          : new vscode.Range(0, 0, 0, 0);
        await vscode.window.showTextDocument(doc, { selection: range, preview: true });
        return;
      }

      const plan = this._resolveFindingFixPlan(doc, line, endLine, suggestedFix);
      const leftContent = plan.originalText.length ? plan.originalText : '// (empty — insert at this location)\n';
      const left = await vscode.workspace.openTextDocument({ content: leftContent, language: plan.language });
      const right = await vscode.workspace.openTextDocument({ content: plan.proposedText, language: plan.language });
      const label = `${path.basename(file)}${line > 0 ? ':' + line : ''} (proposed fix)`;
      await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, label);
      this._view?.webview.postMessage({
        type: 'fixPreviewOpened',
        findingId: String(finding.id || ''),
        reportId: String(finding.reportId || 'current'),
      });
    } catch {
      vscode.window.showErrorMessage(`Could not preview fix for ${file}.`);
    }
  }

  private _findingFixKey(finding: Record<string, unknown>): string {
    return `${String(finding.reportId || 'current')}:${String(finding.id || '')}`;
  }

  private _rangeEndFromText(start: vscode.Position, text: string): vscode.Position {
    const lines = text.split(/\r?\n/);
    if (lines.length === 1) {
      return new vscode.Position(start.line, start.character + lines[0].length);
    }
    return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
  }

  private _resolveFindingFixPlan(
    doc: vscode.TextDocument,
    line: number,
    endLine: number,
    suggestedFix: string,
  ): FindingFixPlan {
    const proposedText = suggestedFix.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const language = doc.languageId || 'plaintext';

    if (line <= 0 || doc.lineCount === 0) {
      const lastLine = Math.max(doc.lineCount - 1, 0);
      const insertPos = doc.lineCount === 0
        ? new vscode.Position(0, 0)
        : new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
      return {
        range: new vscode.Range(insertPos, insertPos),
        originalText: '',
        proposedText,
        language,
        mode: 'insert',
      };
    }

    const startLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
    let lastLine = startLine;
    if (endLine > line) {
      lastLine = Math.min(Math.max(endLine - 1, startLine), doc.lineCount - 1);
    }
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      doc.lineAt(lastLine).range.end,
    );
    return {
      range,
      originalText: doc.getText(range),
      proposedText,
      language,
      mode: 'replace',
    };
  }

  private async _handleApplyFix(finding: Record<string, unknown>): Promise<void> {
    const file = String(finding.file || '');
    const classified = classifyFindingAction(finding);
    const suggestedFix = String(classified.suggestedFix || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const endLine = typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || 0;
    const findingId = String(finding.id || '');
    const reportId = String(finding.reportId || 'current');
    if (!mayAutoApply({ ...finding, ...classified }, this._autoApplyPolicy())) {
      vscode.window.showWarningMessage('This finding is not a safe one-click patch. Use Agent Fix instead.');
      this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Not applyable' });
      return;
    }
    if (!file || !suggestedFix.trim()) {
      vscode.window.showWarningMessage('No file or suggested fix available for this finding.');
      this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No file or fix' });
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No workspace' });
      return;
    }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const plan = this._resolveFindingFixPlan(doc, line, endLine, suggestedFix);
      // Content-match gate: the code must still look like it did when the finding
      // was generated (codeSnippet is verbatim from the reviewed diff; evidence is
      // the legacy field) — otherwise applying would silently corrupt newer code.
      const snippet = String(finding.codeSnippet || '').trim();
      const evidence = String(finding.evidence || '').trim();
      const anchor = (snippet || evidence).split('\n')[0]?.trim() || '';
      if (anchor && plan.mode === 'replace' && !plan.originalText.includes(anchor.slice(0, Math.min(anchor.length, 120)))) {
        vscode.window.showWarningMessage('Current code no longer matches the reviewed code, so the patch was not applied. Re-run the review.');
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'code_changed_since_review' });
        return;
      }
      if (plan.originalText === plan.proposedText) {
        vscode.window.showInformationMessage('Suggested fix already matches the current code.');
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No change' });
        return;
      }

      const choice = await vscode.window.showInformationMessage(
        `Apply suggested fix to ${file}${line > 0 ? ':' + line : ''}?`,
        { modal: true },
        'Apply',
        'Show Diff',
      );
      if (choice === 'Show Diff') {
        await this._handlePreviewFix({ ...finding, suggestedFix, actionClass: 'applyable' });
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Previewed' });
        return;
      }
      if (choice !== 'Apply') {
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Cancelled' });
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      const insertText = plan.mode === 'insert' && plan.range.start.character > 0
        ? '\n' + plan.proposedText
        : plan.proposedText;
      if (plan.mode === 'insert') {
        edit.insert(fileUri, plan.range.start, insertText);
      } else {
        edit.replace(fileUri, plan.range, plan.proposedText);
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        const undoStart = plan.mode === 'insert' && insertText.startsWith('\n')
          ? new vscode.Position(plan.range.start.line, plan.range.start.character)
          : plan.range.start;
        const undoText = plan.mode === 'insert' ? insertText : plan.proposedText;
        const undoRange = new vscode.Range(undoStart, this._rangeEndFromText(undoStart, undoText));
        this._appliedFindingFixes.set(this._findingFixKey(finding), {
          file,
          range: undoRange,
          originalText: plan.mode === 'insert' ? '' : plan.originalText,
          expectedText: undoText,
        });
        // The edit only changes the in-memory buffer; git diff reads from disk,
        // so an unsaved fix would be invisible to the next validation run.
        let saved = false;
        try { saved = await doc.save(); } catch { saved = false; }
        const restaged = saved ? await this._restageAfterFix(file) : false;
        this._logApplyAudit({
          event: 'apply_fix',
          findingId,
          reportId,
          file,
          actionClass: 'applyable',
          beforeHash: simpleContentHash(plan.originalText),
          afterHash: simpleContentHash(undoText),
          saved,
          restaged,
          at: new Date().toISOString(),
        });
        await vscode.window.showTextDocument(doc, { selection: undoRange, preview: true });
        vscode.window.showInformationMessage(
          saved
            ? `Fix applied and saved to ${file}${restaged ? ' (re-staged)' : ''}. Review the change before committing.`
            : `Fix applied to ${file} but the file could not be saved — save it before re-validating.`,
        );
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: true });
      } else {
        vscode.window.showErrorMessage('Could not apply the fix.');
        this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Edit rejected' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Apply fix failed: ${msg}`);
      this._view?.webview.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: msg });
    }
  }

  private async _handleUndoFix(finding: Record<string, unknown>): Promise<void> {
    const findingId = String(finding.id || '');
    const reportId = String(finding.reportId || 'current');
    const key = this._findingFixKey(finding);
    const applied = this._appliedFindingFixes.get(key);
    if (!applied) {
      vscode.window.showWarningMessage('No applied fix was found to undo.');
      this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: false, canUndo: false, error: 'No applied fix' });
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: 'No workspace' });
      return;
    }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, applied.file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      if (doc.getText(applied.range) !== applied.expectedText) {
        this._appliedFindingFixes.delete(key);
        vscode.window.showWarningMessage('The file changed after this fix was applied, so undo was not performed.');
        this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: false, canUndo: false, error: 'Applied text changed' });
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, applied.range, applied.originalText);
      const undone = await vscode.workspace.applyEdit(edit);
      if (undone) {
        this._appliedFindingFixes.delete(key);
        // Mirror apply: persist the undo to disk and re-stage so the next
        // validation does not review the discarded fix.
        let saved = false;
        try { saved = await doc.save(); } catch { saved = false; }
        const restaged = saved ? await this._restageAfterFix(applied.file) : false;
        this._logApplyAudit({
          event: 'undo_fix',
          findingId,
          reportId,
          file: applied.file,
          saved,
          restaged,
          at: new Date().toISOString(),
        });
        vscode.window.showInformationMessage(`Fix undone in ${applied.file}.`);
        this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: true });
      } else {
        this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: 'Edit rejected' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Undo fix failed: ${msg}`);
      this._view?.webview.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: msg });
    }
  }

  private _mapValidateReviewToTyneValidation(result: TyneValidateReviewResult): TyneValidationResult {
    const status = result.status === 'passed' ? 'pass' : result.status === 'blocked' ? 'fail' : 'partial';
    const completedGoals = (result.completedGoals || []).map(goal => typeof goal === 'string'
      ? { title: goal }
      : goal);
    return {
      id: result.id || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: this._state.taskId || result.threadId,
      taskTitle: this._state.taskTitle || result.issueTitle,
      branchName: result.branchName || this._state.branchName,
      commitHash: result.commitSha,
      provider: 'managed',
      tier: normalizeTier(this._userProfile.tier),
      status,
      matchPercent: result.score,
      riskLevel: result.riskLevel,
      summary: result.summary,
      missingRequirements: result.pendingGoals?.map(g => g.title),
      criteriaMet: completedGoals.map(g => g.title),
      criteriaNotMet: result.pendingGoals?.map(g => ({ criterion: g.title, reason: g.reason })),
      suggestions: result.nextActions?.map(a => a.title),
      codeQualityNotes: result.findings?.map(f => `${f.severity}: ${f.title}`),
      filesReviewed: result.visualDiff?.map(f => f.file),
      completedGoals,
      pendingGoals: result.pendingGoals?.map(g => ({
        title: g.title,
        reason: g.reason,
        suggestedAction: g.suggestedAction,
        relatedFiles: g.relatedFiles,
        priority: g.priority || 'medium',
      })),
      developerActions: result.nextActions,
      codeEvidence: result.visualDiff?.map(f => ({
        file: f.file,
        reason: `${f.status} · +${f.additions || 0} -${f.deletions || 0}`,
      })),
      fullReport: result.fullReport,
      confidence: result.confidence,
      validationStatus: result.status,
      createdAt: result.createdAt || new Date().toISOString(),
    };
  }

  private async _postValidateReviewReports(): Promise<void> {
    try {
      const service = getValidateReviewService(this._context);
      const reports = await service.listReports();
      this._view?.webview.postMessage({ type: 'validateReviewReportsLoaded', reports });
    } catch (err) {
      console.warn('Validate & Review history load failed:', err);
    }
  }

  private async _handleSubmitBetaBug(msg: Record<string, unknown>): Promise<void> {
    try {
      const kindRaw = String(msg.kind || 'bug');
      const kind = (['bug', 'confusing', 'idea'].includes(kindRaw) ? kindRaw : 'bug') as BetaBugKind;
      const result = await submitBetaBugReport(this._context, {
        kind,
        message: String(msg.message || ''),
        email: typeof msg.email === 'string' ? msg.email : (this._userProfile.email || undefined),
        githubUsername: typeof msg.githubUsername === 'string'
          ? msg.githubUsername
          : (this._userProfile.githubUsername || undefined),
        githubId: typeof msg.githubId === 'string'
          ? msg.githubId
          : (this._userProfile.githubId || undefined),
        page: typeof msg.page === 'string' ? msg.page : undefined,
        taskId: typeof msg.taskId === 'string' ? msg.taskId : (this._state.taskId || undefined),
        taskTitle: typeof msg.taskTitle === 'string'
          ? msg.taskTitle
          : (this._state.taskTitle || this._state.goal || undefined),
      });
      this._view?.webview.postMessage({ type: 'betaBugSubmitted', id: result.id });
    } catch (err: unknown) {
      const message = err instanceof BetaBugError
        ? err.message
        : (err instanceof Error ? err.message : 'Could not send bug report.');
      this._view?.webview.postMessage({ type: 'betaBugError', message });
    }
  }

  private async _handleOpenTaskDetail(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId || !tool) { return; }
    if (tool === 'jira') { this._logJira(`Selected Jira task: ${this._jiraKeyFromTaskId(taskId)}`); }
    if (tool === 'linear') { this._logLinear(`Selected Linear issue: ${taskId.replace(/^linear:/, '')}`); }
    const cached = getCachedTaskDetailsSync(this._context, taskId);
    if (cached) {
      this._view?.webview.postMessage({ type: 'taskDetailLoaded', details: cached });
    }
    // An epic that was already decomposed reopens on its generated tasks.
    this._postStoredDecompositionIfAny(taskId);
    try {
      const online = await isOnline();
      if (!online) {
        if (!cached) {
          this._view?.webview.postMessage({ type: 'taskDetailLoaded', details: null, taskId, offline: true });
        } else {
          await this._ensurePmIntelligencePosted(taskId, cached.pmIntelligence);
        }
        return;
      }
      const details = await pullTaskDetails(this._context, taskId, tool);
      this._view?.webview.postMessage({ type: 'taskDetailLoaded', details });
      // Selecting a task should surface proof points — reuse cache or extract once.
      await this._ensurePmIntelligencePosted(taskId, details?.pmIntelligence);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!cached) {
        this._view?.webview.postMessage({ type: 'taskDetailError', taskId, message: msg });
      }
    }
  }

  /** Post cached PM intelligence, or extract when proof points / subtasks are missing. */
  private async _ensurePmIntelligencePosted(
    taskId: string,
    fromDetails?: TynePmTaskIntelligence | null,
  ): Promise<void> {
    const stored = fromDetails || this._getStoredPmIntelligence(taskId);
    if (hasActionableEnrichment(stored)) {
      this._view?.webview.postMessage({
        type: 'pmTaskIntelligenceLoaded',
        taskId,
        intelligence: stored,
        forceRefresh: false,
      });
      return;
    }
    await this._fetchAndPostPmTaskIntelligence(taskId, false);
  }

  private async _fetchAndPostPmTaskIntelligence(taskId: string, forceRefresh: boolean): Promise<void> {
    if (!taskId) { return; }
    const source = taskId.startsWith('linear:') ? 'linear' : 'jira';
    const request = await this._resolvePmTaskRequest(taskId, source);
    if (!request) { return; }
    try {
      this._view?.webview.postMessage({ type: 'pmTaskIntelligenceLoading', taskId });
      this._postPmEnrichmentLoading(taskId);
      // Gather codebase context so likelyFiles are populated in the task detail view.
      const codebaseContext = await collectCodebaseContext({
        issueTitle: undefined,
        issueDescription: undefined,
        changedFiles: [],
        diffText: undefined,
      });
      const pmService = getPmTaskIntelligenceService(this._context);
      const intelligence = await pmService.extractIntelligence({
        context: this._context,
        source: request.source,
        issueId: request.issueId,
        issueIdentifier: request.issueIdentifier,
        cloudId: request.cloudId,
        linearWorkspaceId: request.linearWorkspaceId,
        tier: this._userProfile.tier,
        codebaseContext,
      });
      await this._storePmIntelligence(taskId, intelligence);
      this._view?.webview.postMessage({
        type: 'pmTaskIntelligenceLoaded',
        taskId,
        intelligence,
        forceRefresh,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'pmTaskIntelligenceError', taskId, message: msg });
    } finally {
      this._postPmEnrichmentDone();
    }
  }

  private async _resolvePmTaskRequest(
    taskId: string,
    tool: 'jira' | 'linear',
  ): Promise<{ source: 'jira' | 'linear'; issueId: string; issueIdentifier: string; cloudId?: string; linearWorkspaceId?: string } | null> {
    if (tool === 'jira') {
      const jiraAdapter = getAdapter('jira') as { getCloudId?: () => Promise<string> } | null;
      const cloudId = jiraAdapter?.getCloudId ? await jiraAdapter.getCloudId() : '';
      if (!cloudId) { return null; }
      const issueKey = taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
      return {
        source: 'jira',
        issueId: issueKey,
        issueIdentifier: issueKey,
        cloudId,
      };
    }

    const linearAdapter = getAdapter('linear') as { getWorkspaceId?: () => Promise<string> } | null;
    const linearWorkspaceId = linearAdapter?.getWorkspaceId ? await linearAdapter.getWorkspaceId() : '';
    const issueId = taskId.replace(/^linear:/, '');
    const details = await pullTaskDetails(this._context, taskId, 'linear').catch(() => null);
    const issueIdentifier = details?.externalId || issueId;
    return {
      source: 'linear',
      issueId,
      issueIdentifier,
      linearWorkspaceId,
    };
  }

  private _handleQueryTasks(query: string, filters: TyneTaskFilters, sort: TyneTaskSort): void {
    const all = this._getVisibleCachedTasks();
    const effective = sort ?? DEFAULT_TASK_SORT;
    const result = queryTasks(all, query ?? '', filters ?? {}, effective);
    this._view?.webview.postMessage({
      type: 'tasksQueryResult',
      tasks: this._rankTasksForView(result, effective.key),
      rankMode: effective.key === 'recommended',
    });
  }

  private _postPmEnrichmentLoading(taskId: string, title?: string): void {
    this._view?.webview.postMessage({
      type: 'pmEnrichmentLoading',
      taskId,
      title: title || this._state.taskTitle || taskId,
    });
  }

  private _postPmEnrichmentDone(): void {
    this._view?.webview.postMessage({ type: 'pmEnrichmentDone' });
  }

  private async _extractIntelligenceForStartThread(
    taskId: string,
    tool: TynePmTool,
    title?: string,
    issueType?: string,
  ): Promise<{ intelligence: TynePmTaskIntelligence | null; error?: string }> {
    if (tool !== 'jira' && tool !== 'linear') { return { intelligence: null }; }
    const cached = listCachedTasksSync(this._context).find(t => t.id === taskId);
    const resolvedType = issueType || cached?.issueType;
    const state = await runEnrichment(taskId, {
      issueType: resolvedType,
      extract: async () => {
        const request = await this._resolvePmTaskRequest(taskId, tool);
        if (!request) { return { intelligence: null, error: `Could not resolve ${tool} task request.` }; }
        this._postPmEnrichmentLoading(taskId, title);
        try {
          const pmService = getPmTaskIntelligenceService(this._context);
          const codebaseContext = await collectCodebaseContext({
            issueTitle: title || this._state.taskTitle || this._state.goal,
            issueDescription: this._state.goal,
            acceptanceCriteria: this._state.acceptanceCriteria,
            subtasks: this._state.subtasks.map(s => ({ title: s.text })),
            validationSteps: this._state.validationSteps,
          });
          const intelligence = await pmService.extractIntelligence({
            context: this._context,
            source: request.source,
            issueId: request.issueId,
            issueIdentifier: request.issueIdentifier,
            cloudId: request.cloudId,
            linearWorkspaceId: request.linearWorkspaceId,
            tier: this._userProfile.tier,
            codebaseContext,
          });
          return { intelligence };
        } catch (err) {
          console.warn('PM task intelligence extraction failed during enrichment:', err);
          return { intelligence: null, error: normalizeError(err) };
        } finally {
          this._postPmEnrichmentDone();
        }
      },
    });
    if (state.intelligence) { await this._storePmIntelligence(taskId, state.intelligence); }
    this._postThreadCreateTasksVisibility(taskId);
    return { intelligence: state.intelligence, error: state.error };
  }

  // Load a PM task into the thread brief (goal, acceptance criteria, proof points)
  // and navigate to the thread page — WITHOUT creating a branch. Validation state
  // is reset so the new task starts clean.
  private async _loadTaskIntoThread(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    // Show Create-tasks CTA from cached type before enrichment runs.
    this._postThreadCreateTasksVisibility(taskId);
    const stored = this._getStoredPmIntelligence(taskId);
    // Goal-only stubs are not enough — re-extract until proof points or subtasks exist.
    const enrichment = hasActionableEnrichment(stored)
      ? { intelligence: stored }
      : await this._extractIntelligenceForStartThread(taskId, tool, title);
    const intelligence = enrichment.intelligence;

    this._state.taskId = taskId;
    this._state.taskTitle = title;
    this._state.taskSource = tool;
    this._state.taskUrl = url ?? '';
    this._state.goal = title;
    if (intelligence?.goal) { this._state.goal = intelligence.goal; }
    this._state.acceptanceCriteria = intelligence?.acceptanceCriteria || [];
    this._state.proofPointTemplates = intelligence?.proofPointTemplates || [];
    this._state.validationSteps = intelligence?.validationSteps || [];
    this._state.pmTaskContext = intelligence;
    this._state.pmEnrichmentStatus = intelligence
      ? (hasEnrichmentContent(intelligence) ? 'success' : 'partial')
      : (enrichment.error ? 'failed' : 'skipped');
    this._state.pmEnrichmentError = enrichment.error || '';
    this._state.subtasks = (intelligence?.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    this._state.appName = this._state.appName || vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    this._clearValidationForNewTask();
    await saveState(this._context, this._state);

    // Prefill the webview form fields immediately so the thread page reflects the task.
    const cachedType = this._findCachedTask(taskId)?.issueType
      || getCachedTaskDetailsSync(this._context, taskId)?.issueType
      || '';
    this._view?.webview.postMessage({
      type: 'prefillThread',
      taskId,
      taskTitle: title,
      taskSource: tool,
      taskUrl: url ?? '',
      issueType: cachedType,
      goal: this._state.goal,
      subtasks: this._state.subtasks,
      acceptanceCriteria: this._state.acceptanceCriteria,
      proofPointTemplates: this._state.proofPointTemplates,
      validationSteps: this._state.validationSteps,
      pmTaskContext: intelligence,
      pmEnrichmentStatus: this._state.pmEnrichmentStatus,
      pmEnrichmentError: this._state.pmEnrichmentError,
    });
    this._postEnrichmentToWebview(taskId);
    this._view?.webview.postMessage({ type: 'navigateTo', page: 'tasks', tab: 'thread' });
  }

  private async _handleRetryPmEnrichment(): Promise<void> {
    const taskId = this._state.taskId;
    const tool = this._state.taskSource as TynePmTool;
    if (!taskId || (tool !== 'jira' && tool !== 'linear')) {
      this._view?.webview.postMessage({ type: 'error', message: 'Select a Jira or Linear task before retrying PM enrichment.' });
      return;
    }
    const enrichment = await this._extractIntelligenceForStartThread(taskId, tool, this._state.taskTitle);
    if (!enrichment.intelligence) {
      this._state.pmEnrichmentStatus = 'failed';
      this._state.pmEnrichmentError = enrichment.error || 'PM enrichment failed.';
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({
        type: 'pmEnrichmentUpdated',
        pmEnrichmentStatus: this._state.pmEnrichmentStatus,
        pmEnrichmentError: this._state.pmEnrichmentError,
      });
      return;
    }
    const intelligence = enrichment.intelligence;
    this._state.pmTaskContext = intelligence;
    this._state.pmEnrichmentStatus = hasEnrichmentContent(intelligence) ? 'success' : 'partial';
    this._state.pmEnrichmentError = '';
    if (intelligence.goal) { this._state.goal = intelligence.goal; }
    this._state.acceptanceCriteria = intelligence.acceptanceCriteria || [];
    this._state.proofPointTemplates = intelligence.proofPointTemplates || [];
    this._state.validationSteps = intelligence.validationSteps || [];
    this._state.subtasks = (intelligence.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    await saveState(this._context, this._state);
    this._view?.webview.postMessage({
      type: 'prefillThread',
      taskId,
      taskTitle: this._state.taskTitle,
      taskSource: tool,
      taskUrl: this._state.taskUrl,
      goal: this._state.goal,
      subtasks: this._state.subtasks,
      acceptanceCriteria: this._state.acceptanceCriteria,
      proofPointTemplates: this._state.proofPointTemplates,
      validationSteps: this._state.validationSteps,
      pmTaskContext: intelligence,
      pmEnrichmentStatus: this._state.pmEnrichmentStatus,
      pmEnrichmentError: this._state.pmEnrichmentError,
    });
  }

  // Clicking a task in the list: load it into the thread page (no branch yet).
  // Title/url are resolved from the cached task so the card only needs id + tool.
  private async _handleSelectTaskIntoThread(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    const cached = listCachedTasksSync(this._context).find(task => task.id === taskId);
    const title = cached?.title || taskId;
    const resolvedTool = (cached?.sourceTool as TynePmTool) || tool;
    if (resolvedTool === 'linear') {
      this._logLinear(`Task selected into thread: ${cached?.externalId || taskId.replace(/^linear:/, '')}`);
    } else {
      this._logJira(`Task selected into thread: ${taskId}`);
    }
    this._setRunner(true);
    try {
      await this._loadTaskIntoThread(taskId, title, resolvedTool, cached?.sourceUrl);
    } finally {
      this._setRunner(false);
    }
  }

  // Switching tasks while weaving: ask the user whether to switch to the new
  // task's existing branch, start a new thread for it, or keep the current branch.
  private async _handleSwitchTaskInThread(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    if (taskId === this._state.taskId) { return; }
    const cached = listCachedTasksSync(this._context).find(task => task.id === taskId);
    if (!cached) { return; }
    const resolvedTool = (cached.sourceTool as TynePmTool) || tool;

    // If we are not actually weaving yet, treat this like a normal task selection.
    if (this._state.status !== 'weaving') {
      await this._handleSelectTaskIntoThread(taskId, resolvedTool);
      return;
    }

    const repositoryPath = this._getRepositoryPath();
    const linked = repositoryPath ? getBranchByTaskId(this._context, repositoryPath, taskId) : null;
    const taskLabel = cached.externalId || taskId;
    this._setRunner(true);
    try {
      if (linked) {
        const choice = await vscode.window.showInformationMessage(
          `Task ${taskLabel} is already linked to ${linked.branchName}.`,
          'Switch to branch',
          'Keep current branch',
          'Cancel',
        );
        if (choice === 'Switch to branch') {
          await this._switchToBranch(linked.branchName);
          await this._loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          vscode.window.showInformationMessage(`Switched to task ${taskLabel} on ${linked.branchName}.`);
        } else if (choice === 'Keep current branch') {
          await this._loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          vscode.window.showWarningMessage(
            `Task changed to ${taskLabel}. The current branch ${this._state.branchName} remains linked to the previous task.`,
          );
        }
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Task ${taskLabel} has no Tyne branch yet.`,
          'Start new thread',
          'Keep current branch',
          'Cancel',
        );
        if (choice === 'Start new thread') {
          await this._loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          await this._startThread();
        } else if (choice === 'Keep current branch') {
          await this._loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          vscode.window.showWarningMessage(
            `Task changed to ${taskLabel}. The current branch ${this._state.branchName} remains linked to the previous task.`,
          );
        }
      }
    } finally {
      this._setRunner(false);
    }
  }

  private async _handleStartThreadFromTask(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    if (!taskId || !title) { return; }
    if (tool === 'linear') {
      this._logLinear(`Start Thread clicked: ${taskId.replace(/^linear:/, '')}`);
    } else {
      this._logJira(`Start Thread clicked: ${taskId}`);
    }
    this._setRunner(true);
    try {
      await this._loadTaskIntoThread(taskId, title, tool, url);
      // Now start the thread (create branch, set weaving state, refresh).
      await this._startThread();
    } finally {
      this._setRunner(false);
    }
  }

  // ── Story decomposition (Epic/Story → technical tasks) ────────────────────

  private _postStoryDecompose(message: Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  private _resolveDecomposableStory(taskId: string): { story: DecomposableStory; tool: TynePmTool; sourceUrl?: string } | null {
    const cached = this._findCachedTask(taskId);
    if (!cached) { return null; }
    const details = getCachedTaskDetailsSync(this._context, cached.id) || getCachedTaskDetailsSync(this._context, taskId);
    return {
      story: {
        title: cached.title,
        description: details?.description || cached.description || '',
        acceptanceCriteria: [],
        issueType: cached.issueType || details?.issueType || 'story',
      },
      tool: (cached.sourceTool as TynePmTool) || 'jira',
      sourceUrl: cached.sourceUrl,
    };
  }

  private static readonly DECOMPOSED_TASKS_KEY = 'tyne.storyDecomposedTasks';

  private _getStoredDecomposition(taskId: string): StoredDecomposition | null {
    const all = this._context.workspaceState.get<Record<string, StoredDecomposition>>(
      TyneSidebarProvider.DECOMPOSED_TASKS_KEY, {});
    const entry = all?.[taskId];
    return entry && Array.isArray(entry.tasks) && entry.tasks.length ? entry : null;
  }

  /**
   * A previously decomposed epic reopens on its generated tasks rather than
   * offering decomposition again — re-running is a deliberate secondary action.
   */
  private _postStoredDecompositionIfAny(taskId: string): void {
    const stored = this._getStoredDecomposition(taskId);
    if (!stored) { return; }
    this._postStoryDecompose({
      type: 'storyDecomposeExisting',
      taskId,
      tool: stored.tool,
      createdAt: stored.createdAt,
      tasks: recommendTaskOrder(stored.tasks),
    });
  }

  /** Step 1: analyze the story locally + collect codebase context, then send clarifying questions. */
  private async _handleStoryDecomposeAnalyze(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    const tier = normalizeTier(this._userProfile.tier);
    if (subtaskLimitForTier(tier) <= 0) {
      this._postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: 'Creating tasks from a Story or Epic is available in Pro and Max.',
        upgradeRequired: true,
      });
      return;
    }
    const resolved = this._resolveDecomposableStory(taskId);
    if (!resolved) {
      this._postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'Task details unavailable. Refresh tasks and try again.' });
      return;
    }
    this._logJira(`Story decomposition started: ${taskId}`);

    const step = (id: string, status: 'active' | 'done') =>
      this._postStoryDecompose({ type: 'storyDecomposeProgress', taskId, phase: 'analyze', step: id, status });

    try {
      step('read_story', 'active');
      const { story } = resolved;
      step('read_story', 'done');

      step('scan_codebase', 'active');
      const codebaseContext = await collectCodebaseContext({
        issueTitle: story.title,
        issueDescription: story.description,
      }).catch(() => undefined);
      step('scan_codebase', 'done');

      // PM enrichment first: read the epic/story so questions are about this
      // issue's goal, open questions, and proposed split — not generic templates.
      step('parse_criteria', 'active');
      const enrichment = await this._enrichStoryForDecomposition(taskId, codebaseContext);
      if (enrichment) {
        if (enrichment.goal) { story.description = `${story.description}\n\n${enrichment.goal}`.trim(); }
        story.acceptanceCriteria = enrichment.acceptanceCriteria || [];
      }
      step('parse_criteria', 'done');

      step('find_modules', 'active');
      const characteristics = detectStoryCharacteristics(story);
      const questions = buildClarifyingQuestionsFromEnrichment(characteristics, enrichment, story.issueType);
      step('find_modules', 'done');

      this._storyDecomposeSessions.set(taskId, { story, tool: resolved.tool, characteristics, codebaseContext });
      this._postStoryDecompose({
        type: 'storyDecomposeQuestions',
        taskId,
        questions,
        characteristics,
        goal: enrichment?.goal || (story.acceptanceCriteria.length ? undefined : 'No acceptance criteria found on this epic.'),
      });
    } catch (err: unknown) {
      this._postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: err instanceof Error ? err.message : 'Story analysis failed.',
      });
    }
  }

  /**
   * Run PM enrichment for a story/epic purely to feed decomposition. Failure is
   * non-fatal — decomposition falls back to the raw issue text — but the reason
   * is logged so a persistent enrichment outage stays visible.
   */
  private async _enrichStoryForDecomposition(
    taskId: string,
    codebaseContext: ReturnType<typeof collectCodebaseContext> extends Promise<infer T> ? T : never,
  ): Promise<TynePmTaskIntelligence | null> {
    const source = taskId.startsWith('linear:') ? 'linear' : 'jira';
    const cached = listCachedTasksSync(this._context).find(t => t.id === taskId);
    const state = await runEnrichment(taskId, {
      issueType: cached?.issueType,
      extract: async () => {
        const request = await this._resolvePmTaskRequest(taskId, source).catch(() => null);
        if (!request) { return { intelligence: null }; }
        try {
          const pmService = getPmTaskIntelligenceService(this._context);
          const intelligence = await pmService.extractIntelligence({
            context: this._context,
            source: request.source,
            issueId: request.issueId,
            issueIdentifier: request.issueIdentifier,
            cloudId: request.cloudId,
            linearWorkspaceId: request.linearWorkspaceId,
            tier: this._userProfile.tier,
            codebaseContext,
          });
          return { intelligence };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this._logJira(`Story decomposition enrichment failed for ${taskId}: ${message}`);
          this._postStoryDecompose({ type: 'storyDecomposeEnrichmentWarning', taskId, message });
          return { intelligence: null, error: message };
        }
      },
    });
    if (state.intelligence) { await this._storePmIntelligence(taskId, state.intelligence); }
    this._postThreadCreateTasksVisibility(taskId);
    return state.intelligence;
  }

  /** Step 3: generate the technical task breakdown from the user's answers. */
  private async _handleStoryDecomposeGenerate(taskId: string, answers: Record<string, string>): Promise<void> {
    const session = this._storyDecomposeSessions.get(taskId);
    if (!session) {
      this._postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'Decomposition session expired. Re-run the analysis.' });
      return;
    }
    const tier = normalizeTier(this._userProfile.tier);
    const safeAnswers: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers || {})) {
      if (typeof value === 'string') { safeAnswers[key] = value; }
    }
    try {
      const service = getStoryDecompositionService(this._context);
      const result = await service.decompose({
        source: session.tool,
        issueIdentifier: taskId,
        story: session.story,
        answers: safeAnswers,
        tier,
        codebaseContext: session.codebaseContext,
      });
      session.result = result;
      this._postStoryDecompose({ type: 'storyDecomposeResult', taskId, result });
    } catch (err: unknown) {
      this._postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: err instanceof Error ? err.message : 'Task generation failed.',
        upgradeRequired: err instanceof StoryDecompositionLimitError,
      });
    }
  }

  /** Step 4: create the generated tasks in Jira (as sub-tasks) and locally in Tyne. */
  private async _handleStoryDecomposeCreate(
    taskId: string, rawTasks: unknown, createInJira: boolean, rawDueDate?: unknown,
  ): Promise<void> {
    const session = this._storyDecomposeSessions.get(taskId);
    const tier = normalizeTier(this._userProfile.tier);
    const limit = subtaskLimitForTier(tier);
    const tasks = parseDecomposedTasks(rawTasks, limit);
    if (!tasks.length) {
      this._postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'No tasks selected to create.' });
      return;
    }
    const tool = session?.tool || 'jira';
    const dueDate = normalizeTaskDueDate(rawDueDate);
    // When the PM tool is connected, always push — "Create in Tyne" alone is local-only offline.
    const connected = getConnectedToolsSync(this._context).includes(tool);
    const pushToPm = createInJira || connected;
    const createdInPm: Array<{ key: string; url?: string; title: string }> = [];
    let pmError: string | undefined;

    if (pushToPm) {
      try {
        const adapter = getAdapter(tool);
        if (!adapter.createSubtaskIssues) {
          throw new Error(`${tool} does not support creating sub-tasks from Tyne yet.`);
        }
        const created = await adapter.createSubtaskIssues(
          taskId,
          tasks.map(task => ({ title: task.title, description: buildPmSubtaskDescription(task), dueDate })),
        );
        created.forEach((issue, index) => {
          createdInPm.push({ key: issue.key, url: issue.url, title: tasks[index]?.title || issue.key });
        });
      } catch (err: unknown) {
        pmError = err instanceof Error ? err.message : String(err);
      }
    }

    // Always store locally so a thread can be started per generated task even
    // when PM creation was skipped or failed.
    const storedKey = TyneSidebarProvider.DECOMPOSED_TASKS_KEY;
    const existing = this._context.workspaceState.get<Record<string, StoredDecomposition>>(storedKey, {});
    existing[taskId] = {
      parentTaskId: taskId,
      tool,
      createdAt: new Date().toISOString(),
      tasks: tasks.map((task, index) => ({
        ...task,
        pmKey: createdInPm[index]?.key,
        pmUrl: createdInPm[index]?.url,
      })),
    };
    await this._context.workspaceState.update(storedKey, existing);

    // Merge created Jira issues into the task cache so the Task page shows them
    // immediately (pull can miss unassigned issues until assignee settles).
    const mergeCreatedStubs = async () => {
      if (!createdInPm.length || tool !== 'jira') { return; }
      const parent = this._findCachedTask(taskId);
      const childType = /epic/i.test(session?.story?.issueType || parent?.issueType || '') ? 'Story' : 'Sub-task';
      const nowIso = new Date().toISOString();
      await saveTasks(this._context, createdInPm.map(issue => ({
        id: `jira:${issue.key}`,
        externalId: issue.key,
        title: issue.title,
        status: 'To Do',
        normalizedStatus: 'todo' as const,
        normalizedPriority: 'none' as const,
        sourceTool: 'jira' as const,
        sourceUrl: issue.url,
        sourceProject: parent?.sourceProject,
        parentKey: parent?.externalId || this._jiraKeyFromTaskId(taskId),
        issueType: childType,
        dueDate,
        lastSyncedAt: nowIso,
        cachedAt: nowIso,
        isCachedOnly: false,
      }))).catch(() => undefined);
    };
    await mergeCreatedStubs();
    // Saving to the cache is not enough — the Tasks tab renders from the last
    // payload posted to the webview, so without this the new children only
    // appear after the next sync.
    await this._refreshTasksContext(true);

    this._logJira(`Story decomposition created ${tasks.length} tasks for ${taskId}${createdInPm.length ? ` (${createdInPm.length} in ${tool})` : ''}`);
    this._postStoryDecompose({
      type: 'storyDecomposeCreated',
      taskId,
      createdInPm,
      pmError,
      tyneCount: tasks.length,
      tool,
      // The picker opens on the recommended order so the user starts with the
      // task that unblocks the rest. Reordering means the PM key must be looked
      // up by title, never by index.
      tasks: recommendTaskOrder(tasks).map(task => {
        const pm = createdInPm.find(issue => issue.title === task.title);
        return { ...task, pmKey: pm?.key, pmUrl: pm?.url };
      }),
    });
    this._storyDecomposeSessions.delete(taskId);
    if (createdInPm.length) {
      // Force pull so Jira children show up, then re-merge stubs if pull filters them out.
      await pullTasks(this._context, tool, { ...DEFAULT_PULL_INPUT, forceRefresh: true }).catch(() => undefined);
      await mergeCreatedStubs();
      await this._refreshTasksContext(true).catch(() => undefined);
    } else if (pmError && pushToPm) {
      // Surface failure — do not pretend the Task list updated.
      this._view?.webview.postMessage({ type: 'error', message: `Could not create tasks in ${tool}: ${pmError}` });
    }
  }

  /**
   * Start a thread on one of the generated tasks. The remaining tasks stay
   * parked under the epic — nothing is discarded by picking one.
   */
  private async _handleStoryDecomposeStartTask(
    parentTaskId: string, pmKey: string | undefined, title: string,
  ): Promise<void> {
    const stored = this._getStoredDecomposition(parentTaskId);
    const tool = stored?.tool || 'jira';
    if (!pmKey) {
      vscode.window.showWarningMessage(
        `"${title}" was not created in ${tool} yet, so it has no issue to start a thread on. Re-run creation with "Create in ${tool}".`,
      );
      return;
    }
    const childTaskId = tool === 'jira' ? pmKey : `linear:${pmKey}`;
    // The sub-task may not be in the cache yet — pull it so the thread has
    // real PM context rather than just a title.
    await pullTaskDetails(this._context, childTaskId, tool).catch(() => null);
    await this._handleStartThreadFromTask(childTaskId, title, tool, undefined);
  }

  /** Explicit re-run of decomposition for an already-decomposed epic. */
  private async _handleStoryDecomposeRegenerate(taskId: string, tool: TynePmTool): Promise<void> {
    const all = this._context.workspaceState.get<Record<string, StoredDecomposition>>(
      TyneSidebarProvider.DECOMPOSED_TASKS_KEY, {});
    delete all[taskId];
    await this._context.workspaceState.update(TyneSidebarProvider.DECOMPOSED_TASKS_KEY, all);
    await this._handleStoryDecomposeAnalyze(taskId, tool);
  }

  // ── Pro/Max: Advanced query ────────────────────────────────────────────────

  private _handleQueryTasksAdvanced(
    query: string,
    filters: TyneAdvancedTaskFilters,
    sort: TyneAdvancedTaskSort,
  ): void {
    const connectedTools = this._effectiveConnectedTools.length ? this._effectiveConnectedTools : getConnectedToolsSync(this._context);
    const all = filterTasksForConnectedTools(getUnifiedTaskListSync(this._context), connectedTools);
    const effective = sort ?? DEFAULT_ADVANCED_SORT;
    const sortKey = effective.rules?.[0]?.key;
    const { tasks, parseErrors } = queryTasksAdvanced(
      all,
      query ?? '',
      filters ?? {},
      effective,
    );
    this._view?.webview.postMessage({
      type: 'tasksQueryResult',
      tasks: this._rankTasksForView(tasks, sortKey),
      parseErrors,
      rankMode: sortKey === 'recommended',
    });
  }

  // ── Pro/Max: Filter presets ────────────────────────────────────────────────

  private _handleListPresets(): void {
    const presets = listPresetsSync(this._context);
    this._view?.webview.postMessage({ type: 'presetsLoaded', presets });
  }

  private async _handleSavePreset(msg: unknown): Promise<void> {
    const m = msg as { name?: string; query?: string; filters?: TyneAdvancedTaskFilters; sort?: TyneAdvancedTaskSort; isDefault?: boolean };
    try {
      const preset = await savePreset(this._context, {
        name: m.name ?? 'Untitled Preset',
        query: m.query,
        filters: m.filters ?? {},
        sort: m.sort ?? DEFAULT_ADVANCED_SORT,
        isDefault: m.isDefault,
      });
      this._handleListPresets();
      this._view?.webview.postMessage({ type: 'presetSaved', preset });
      vscode.window.showInformationMessage(`Filter preset "${preset.name}" saved.`);
    } catch (err: unknown) {
      this._view?.webview.postMessage({ type: 'presetError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleRenamePreset(id: string, name: string): Promise<void> {
    try {
      await renamePreset(this._context, id, name);
      this._handleListPresets();
    } catch (err: unknown) {
      this._view?.webview.postMessage({ type: 'presetError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleDeletePreset(id: string): Promise<void> {
    await deletePreset(this._context, id);
    this._handleListPresets();
    vscode.window.showInformationMessage('Filter preset deleted.');
  }

  private async _handleSetDefaultPreset(id: string): Promise<void> {
    await setDefaultPreset(this._context, id);
    this._handleListPresets();
  }

  private _handleApplyPreset(id: string): void {
    const presets = listPresetsSync(this._context);
    const preset = presets.find(p => p.id === id);
    if (!preset) { this._view?.webview.postMessage({ type: 'presetError', message: `Preset not found.` }); return; }
    this._view?.webview.postMessage({ type: 'presetApplied', preset });
    this._handleQueryTasksAdvanced(preset.query ?? '', preset.filters, preset.sort);
  }

  // ── Pro/Max: Writable task actions ─────────────────────────────────────────

  private async _handleCreateTask(input: TyneCreateTaskInput): Promise<void> {
    const tier = this._userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this._view?.webview.postMessage({ type: 'taskWriteBlocked', reason: 'Creating tasks is available in Pro and Max.' });
      return;
    }
    try {
      const details = await pmCreateTask(this._context, tier, input);
      this._view?.webview.postMessage({ type: 'taskCreated', details });
      vscode.window.showInformationMessage(`Task created: ${details.title}`);
      await this._refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Create task failed: ${msg}`);
    }
  }

  private async _handleUpdateTask(taskId: string, sourceTool: TynePmTool, input: TyneUpdateTaskInput): Promise<void> {
    const tier = this._userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this._view?.webview.postMessage({ type: 'taskWriteBlocked', reason: 'Editing tasks is available in Pro and Max.' });
      return;
    }
    try {
      const details = await pmUpdateTask(this._context, tier, taskId, sourceTool, input);
      this._view?.webview.postMessage({ type: 'taskUpdated', details });
      vscode.window.showInformationMessage(`Task updated.`);
      await this._handleOpenTaskDetail(taskId, sourceTool);
      // Same enrichment path as Start Thread / Thread field edits when this is
      // the active thread task (or after edit, sync thread brief if loaded).
      if (this._state.taskId === taskId) {
        if (input.title) { this._state.taskTitle = input.title; this._state.goal = input.title; }
        if (input.description) { this._state.goal = input.description; }
        await this._runEnrichmentForActiveThreadTask('task_update');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Update task failed: ${msg}`);
    }
  }

  private async _handleAddSubtask(
    taskId: string, sourceTool: TynePmTool,
    input: { title: string; assigneeId?: string; dueDate?: string },
  ): Promise<void> {
    const tier = this._userProfile?.tier ?? 'CORE';
    try {
      const subtask = await pmAddSubtask(this._context, tier, taskId, sourceTool, input);
      this._view?.webview.postMessage({ type: 'subtaskAdded', taskId, subtask });
    } catch (err: unknown) {
      this._view?.webview.postMessage({ type: 'taskWriteError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleAddComment(taskId: string, sourceTool: TynePmTool, body: string): Promise<void> {
    const tier = this._userProfile?.tier ?? 'CORE';
    try {
      const comment = await pmAddComment(this._context, tier, taskId, sourceTool, body);
      this._view?.webview.postMessage({ type: 'commentAdded', taskId, comment });
    } catch (err: unknown) {
      this._view?.webview.postMessage({ type: 'taskWriteError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleCheckCapabilities(tool: TynePmTool): Promise<void> {
    try {
      const capabilities = await getAdapter(tool).getCapabilities();
      this._view?.webview.postMessage({ type: 'capabilitiesLoaded', tool, capabilities });
    } catch (err: unknown) {
      this._view?.webview.postMessage({ type: 'capabilitiesLoaded', tool, capabilities: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async _handleDetectConflict(taskId: string, tool: TynePmTool): Promise<void> {
    const conflict = await detectTaskEditConflict(taskId, tool);
    this._view?.webview.postMessage({ type: 'conflictCheckResult', taskId, conflict });
  }

  private async _maybeCreateDraftPR(thread: { goal: string; taskId: string; subtasks: TyneState['subtasks']; branchName: string }): Promise<void> {
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) { return; }
    createDraftPR(githubToken, thread.goal, thread.taskId, thread.subtasks, thread.branchName).then(pr => {
      if (!pr) { return; }
      this._view?.webview.postMessage({ type: 'prCreated', url: pr.url, number: pr.number, title: pr.title });
      vscode.window.showInformationMessage(`Draft PR created: ${pr.title}`, 'View PR').then(choice => {
        if (choice === 'View PR') { vscode.env.openExternal(vscode.Uri.parse(pr.url)); }
      });
    }).catch((err: unknown) => { vscode.window.showWarningMessage(`PR creation failed (thread still closed): ${err instanceof Error ? err.message : String(err)}`); });
  }

  private async _refreshTimeContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this._postEmptyTimeData();
      }
      return;
    }
    try {
      await repairTimeStorage(this._context);
      const repositoryName = vscode.workspace.workspaceFolders?.[0]?.name;
      const sessions = this._lastCommitSessions;
      if (sessions.length > 0) {
        await generateTimeLogsFromSessions(this._context, sessions, repositoryPath, repositoryName);
      }
      const today = new Date().toISOString();
      const allLogs = listTimeLogs(this._context).filter(l => l.repositoryPath === repositoryPath);
      const allManuals = listManualEntries(this._context).filter(e => e.repositoryPath === repositoryPath);
      const analyticsTasks = listAnalyticsTasks(allLogs, allManuals, sessions);
      const selectedTaskId =
        this._analyticsTaskId ||
        (this._state.taskId && analyticsTasks.some(t => t.taskId === this._state.taskId) ? this._state.taskId : undefined) ||
        analyticsTasks[0]?.taskId ||
        this._state.taskId ||
        undefined;
      this._analyticsTaskId = selectedTaskId;
      const selectedTaskMeta = analyticsTasks.find(t => t.taskId === selectedTaskId);
      const currentBranch = this._state.branchName;
      const taskSummary = selectedTaskId
        ? getTaskTimeSummary(this._context, repositoryPath, selectedTaskId)
        : null;
      const branchSummary = currentBranch
        ? getBranchTimeSummary(this._context, repositoryPath, currentBranch)
        : null;
      const projectSummary = getProjectTimeSummary(this._context, repositoryPath);
      const dailySummary = getDailyTimeSummary(this._context, repositoryPath, today);
      const weeklySummary = getWeeklyTimeSummary(this._context, repositoryPath, today);
      const monthlySummary = getMonthlyTimeSummary(this._context, repositoryPath, today);
      const taskLogs = selectedTaskId ? getTimeLogsForTask(this._context, selectedTaskId) : [];
      const branchLogs = currentBranch ? getTimeLogsForBranch(this._context, currentBranch) : [];
      const manualEntries = selectedTaskId
        ? listManualTimeEntriesForTask(this._context, selectedTaskId)
        : [];
      const scopeLogs = selectedTaskId ? taskLogs : branchLogs;
      const scopeSessions = sessions.filter(s =>
        selectedTaskId ? s.taskId === selectedTaskId : (currentBranch ? s.branchName === currentBranch : true),
      );
      const scopeManuals = selectedTaskId
        ? manualEntries
        : allManuals.filter(e => !currentBranch || e.branchName === currentBranch);
      const analytics = await this._buildAnalyticsPayload({
        taskId: selectedTaskId,
        taskTitle: selectedTaskMeta?.taskTitle || this._state.taskTitle,
        repositoryName,
        branchName: selectedTaskMeta?.branchName || currentBranch,
        taskSummary,
        branchSummary,
        dailySummary,
        weeklySummary,
        logs: scopeLogs,
        manuals: scopeManuals,
        sessions: scopeSessions,
      });
      if (postMessage || this._view) {
        this._view?.webview.postMessage({
          type: 'timeDataLoaded',
          taskSummary,
          branchSummary,
          projectSummary,
          dailySummary,
          weeklySummary,
          monthlySummary,
          taskLogs,
          branchLogs,
          manualEntries: scopeManuals,
          allLogs,
          allManuals,
          analytics,
          analyticsTasks,
          selectedTaskId: selectedTaskId || null,
        });
      }
      this._updateStatusBar();
    } catch (err) {
      console.error('Tyne: time refresh failed', err);
    }
  }

  private _postEmptyTimeData(): void {
    this._view?.webview.postMessage({
      type: 'timeDataLoaded',
      taskSummary: null, branchSummary: null, projectSummary: null,
      dailySummary: null, weeklySummary: null, monthlySummary: null,
      taskLogs: [], branchLogs: [], manualEntries: [], allLogs: [], allManuals: [],
      analyticsTasks: [],
      selectedTaskId: this._analyticsTaskId || this._state.taskId || null,
      analytics: buildDeveloperAnalytics({
        logs: [], manuals: [], sessions: [],
        taskId: this._analyticsTaskId || this._state.taskId,
        taskTitle: this._state.taskTitle,
        branchName: this._state.branchName,
      }),
    });
  }

  private async _buildAnalyticsPayload(input: Parameters<typeof buildDeveloperAnalytics>[0]) {
    let validationRuns = 0;
    const recentModels: string[] = [];
    let qualityScore: number | undefined;
    try {
      const usage = await this._usageService.getUsageSummary().catch(() => null);
      validationRuns = usage?.used ?? 0;
    } catch { /* offline */ }
    // ponytail: use in-memory latest review only — full history fetch is too heavy for tab refresh
    const latest = this._state.validateReviewResult;
    if (latest) {
      const mi = latest.modelInfo;
      if (mi?.primaryModel) { recentModels.push(mi.primaryModel); }
      if (mi?.secondaryModel) { recentModels.push(mi.secondaryModel); }
      if (mi?.judgeModel) { recentModels.push(mi.judgeModel); }
      if (typeof latest.qualityScore === 'number') { qualityScore = latest.qualityScore; }
    }
    return buildDeveloperAnalytics({
      ...input,
      validationRuns,
      recentModels,
      qualityScore,
    });
  }

  private async _handleAddManualTime(entry: ManualTimeEntryInput): Promise<void> {
    if (!entry) { return; }
    const repositoryPath = this._getRepositoryPath();
    const repositoryName = vscode.workspace.workspaceFolders?.[0]?.name;
    const filled: ManualTimeEntryInput = {
      ...entry,
      repositoryPath: entry.repositoryPath || repositoryPath,
      repositoryName: entry.repositoryName || repositoryName,
      taskId: entry.taskId || this._state.taskId || undefined,
      taskTitle: entry.taskTitle || this._state.taskTitle || undefined,
      branchName: entry.branchName || this._state.branchName || undefined,
    };
    const result = await createManualTimeEntry(this._context, filled);
    if (result.errors?.length) {
      this._view?.webview.postMessage({ type: 'manualTimeError', errors: result.errors });
      return;
    }
    this._view?.webview.postMessage({ type: 'manualTimeSaved', entry: result.entry });
    vscode.window.showInformationMessage('Manual time entry saved.');
    await this._refreshTimeContext(true);
  }

  private async _handleEditManualTime(id: string, input: Partial<ManualTimeEntryInput>): Promise<void> {
    const result = await updateManualTimeEntry(this._context, id, input);
    if (result.errors?.length) {
      this._view?.webview.postMessage({ type: 'manualTimeError', errors: result.errors });
      return;
    }
    this._view?.webview.postMessage({ type: 'manualTimeSaved', entry: result.entry });
    vscode.window.showInformationMessage('Manual time entry updated.');
    await this._refreshTimeContext(true);
  }

  private async _handleDeleteManualTime(id: string): Promise<void> {
    await deleteManualTimeEntry(this._context, id);
    this._view?.webview.postMessage({ type: 'manualTimeDeleted', id });
    vscode.window.showInformationMessage('Manual time entry deleted.');
    await this._refreshTimeContext(true);
  }


  private _debouncedSave(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); }
    this._saveTimer = setTimeout(() => {
      saveState(this._context, this._state);
      this._updateStatusBar();
    }, 500);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', file)).toString();
    const logoUri = asset('tyne.svg');
    const cssUri = asset('tyne.css');
    const jsUri = asset('tyne.js');
    const taskInteractionsUri = asset('taskInteractions.js');
    const tier = { mark: asset('tyne-mark.svg'), core: asset('tier-core.svg'), pro: asset('tier-pro.png'), max: asset('tier-max.png') };
    const logos = {
      slack: asset('logo-slack.png'),
      salesforce: asset('logo-salesforce.svg'),
      jira: asset('logo-jira.png'),
      // SVG mark extracted from the official wordmark — the PNG was an
      // app-icon tile with a baked drop shadow, inconsistent with the flat
      // marks used by every other row.
      linear: asset('logo-linear.svg'),
      monday: asset('logo-monday.png'),
      asana: asset('logo-asana.png'),
    };
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} https://*.vscode-cdn.net data:;`;
    return renderSidebarHtml(csp, nonce, logoUri, cssUri, jsUri, taskInteractionsUri, tier, logos);
  }
}

function renderSidebarHtml(csp: string, nonce: string, logoUri: string, cssUri: string, jsUri: string, taskInteractionsUri: string, tier: { mark: string; core: string; pro: string; max: string }, logos: { slack: string; salesforce: string; jira: string; linear: string; monday: string; asana: string }): string {
  const ICON = {
    thread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
    tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M9 18a9 9 0 0 0 9-9"/></svg>',
    time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    commit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
    automation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    logo: '<svg viewBox="0 -672 258 680" fill="#fff"><path d="M 113.4375 0 L 231.847656 0 C 238.8125 0 244.78125 -5.96875 244.78125 -12.9375 L 244.78125 -81.59375 C 244.78125 -88.558594 238.8125 -94.53125 231.847656 -94.53125 L 142.292969 -94.53125 C 135.328125 -94.53125 129.355469 -100.5 129.355469 -107.464844 L 129.355469 -318.417969 C 129.355469 -325.382812 123.386719 -331.351562 116.421875 -331.351562 L 113.4375 -331.351562 C 106.46875 -331.351562 100.5 -337.324219 100.5 -344.289062 L 100.5 -366.179688 C 100.5 -373.144531 106.46875 -379.113281 113.4375 -379.113281 L 231.847656 -379.113281 C 238.8125 -379.113281 244.78125 -385.085938 244.78125 -392.050781 L 244.78125 -460.707031 C 244.78125 -467.675781 238.8125 -473.644531 231.847656 -473.644531 L 171.148438 -473.644531 C 164.183594 -473.644531 158.214844 -467.675781 158.214844 -460.707031 L 158.214844 -439.8125 C 158.214844 -432.847656 152.242188 -426.878906 145.277344 -426.878906 L 142.292969 -426.878906 C 135.328125 -426.878906 129.355469 -432.847656 129.355469 -439.8125 L 129.355469 -650.765625 C 129.355469 -657.730469 123.386719 -663.699219 116.421875 -663.699219 L 26.867188 -663.699219 C 19.902344 -663.699219 13.929688 -657.730469 13.929688 -650.765625 L 13.929688 -107.464844 C 13.929688 -100.5 19.902344 -94.53125 26.867188 -94.53125 L 29.851562 -94.53125 C 36.816406 -94.53125 42.789062 -88.558594 42.789062 -81.59375 L 42.789062 -60.699219 C 42.789062 -53.734375 48.757812 -47.761719 55.722656 -47.761719 L 87.566406 -47.761719 C 94.53125 -47.761719 100.5 -41.792969 100.5 -34.828125 L 100.5 -12.9375 C 100.5 -5.96875 106.46875 0 113.4375 0 Z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.63-1.28-1.63-1.05-.71.08-.69.08-.69 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.74.4-1.26.73-1.55-2.42-.28-4.96-1.21-4.96-5.38 0-1.19.42-2.16 1.12-2.92-.11-.28-.49-1.39.11-2.89 0 0 .91-.29 2.99 1.12a10.4 10.4 0 0 1 5.45 0c2.08-1.41 2.99-1.12 2.99-1.12.6 1.5.22 2.61.11 2.89.7.76 1.12 1.73 1.12 2.92 0 4.18-2.55 5.1-4.98 5.37.41.36.78 1.06.78 2.14v3.17c0 .27.18.65.74.54A11 11 0 0 0 12 1.27z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    stitch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>',
    knot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 10v2a7 7 0 0 1-7 7"/><path d="M5 10v2a7 7 0 0 0 7 7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="9" y1="4" x2="15" y2="4"/><line x1="4" y1="13" x2="8" y2="13"/><line x1="16" y1="13" x2="20" y2="13"/></svg>',
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tyne</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="app">

  <section id="welcomeView" class="welcome">
    <img class="welcome-logo" src="${logoUri}" alt="Tyne" />
    <div class="welcome-title">Goal-enforcement for<br/>AI-assisted coding</div>
    <div class="welcome-sub">Stay on scope. Snapshot fearlessly. Ship validated code &mdash; every session.</div>
    <div class="welcome-actions">
      <button class="btn primary" id="continueWithGithubBtn">${ICON.github}<span>Continue with GitHub</span></button>
      <button class="btn" id="skipAuthBtn" type="button">Skip for now</button>
    </div>
    <div class="welcome-pending hidden" id="welcomePending">
      <div class="lbl">Enter code at GitHub</div>
      <div class="code" id="pendingCode">----</div>
      <button class="btn" id="pendingLink" type="button">github.com/login/device</button>
    </div>
    <div class="welcome-pending hidden" id="deviceAuthPending">
      <div class="lbl" id="deviceAuthLabel">Confirm in browser</div>
      <div class="code" id="deviceAuthCode">----</div>
      <div class="welcome-device-hint" id="deviceAuthHint">Waiting for confirmation in browser…</div>
      <div class="welcome-device-actions">
        <button class="btn" id="deviceAuthOpenLink" type="button">Open browser</button>
        <button class="btn primary hidden" id="deviceAuthRetryBtn" type="button">Try again</button>
        <button class="btn ghost" id="deviceAuthCancelBtn" type="button">Cancel</button>
      </div>
    </div>
    <div class="welcome-foot">By continuing you agree to the Terms &amp; Privacy Policy.</div>
  </section>

  <main id="shellView" class="shell active">
    <nav class="rail">
      <div class="rail-logo"><img src="${tier.mark}" alt="Tyne" /></div>
      <button class="rail-btn active" data-nav="tasks" title="Tasks" aria-label="Tasks">${ICON.tasks}</button>
      <button class="rail-btn" data-nav="validateReview" title="Validate &amp; Review" aria-label="Validate &amp; Review">${ICON.review}</button>
      <button class="rail-btn" data-nav="branches" title="Branches" aria-label="Branches">${ICON.branch}</button>
      <button class="rail-btn" data-nav="commits" title="Commits" aria-label="Commits">${ICON.commit}</button>
      <button class="rail-btn" data-nav="analytics" title="Analytics" aria-label="Analytics">${ICON.clock}</button>
      <button class="rail-btn" data-nav="automation" title="Automation" aria-label="Automation">${ICON.automation}</button>
      <div class="rail-spacer"></div>
      <button class="rail-btn" data-nav="settings" title="Settings" aria-label="Settings">${ICON.settings}</button>
    </nav>

    <div class="content">
      <div class="pixel-overlay" id="pixelOverlay">
        <div class="pixel-stage" id="pixelStage"></div>
        <div class="pixel-label" id="pixelLabel">Working</div>
      </div>
      <div class="runner global" id="globalRunner"><div class="fill" id="globalRunnerFill"></div></div>
      <!-- Page-agnostic decompose wizard — visible from Thread or Tasks. -->
      <div class="story-decompose-panel story-decompose-overlay hidden" id="storyDecomposePanel"></div>
      <!-- GitHub session-expired banner (shown when the saved token is rejected) -->
      <div class="gh-expired-banner hidden" id="githubExpiredBanner" role="alert">
        <div class="gh-expired-copy" id="githubExpiredText">Your GitHub session expired. Reconnect GitHub to continue.</div>
        <button class="btn primary compact" id="githubReconnectBtn" type="button">Reconnect GitHub</button>
      </div>
      <div class="pages">


        <!-- ===== TECHNICAL REVIEW ===== -->
        <section class="page" id="reviewPage">

          <div class="page-head">
            <span class="page-title">Technical Review</span>
            <span class="pill standby" id="reviewStatusPill"><span id="reviewStatusText">Ready</span></span>
          </div>

          <div class="vr-review-controls">
            <button class="btn primary full" id="runCodeReviewBtn" type="button">Run Technical Review</button>
            <div class="runner" id="reviewRunner"><div class="fill" id="reviewRunnerFill"></div></div>
            <div id="reviewError" class="notice bad hidden"></div>
          </div>

          <div class="vr-review-list-view" id="reviewListView">
            <div class="vr-task-report-list" id="reviewReportList"></div>
            <div class="val-empty" id="reviewHistoryEmpty">No technical reviews yet. Run a review to get started.</div>
          </div>

          <div class="vr-review-doc-view hidden" id="reviewDocView">
            <button class="btn ghost compact vr-back-btn" id="reviewBackBtn" type="button">&#8592; Back to list</button>
            <div class="vr-doc-container" id="reviewDocContainer"></div>
          </div>

        </section>

        <!-- ===== VALIDATE & REVIEW ===== -->
        <section class="page" id="validateReviewPage">

          <div class="page-head">
            <span class="page-title">Validate &amp; Review</span>
          </div>

          <div class="vr-review-controls">
            <select class="vr-scope-select" id="validateReviewScopeSelect" title="Review scope">
              <option value="auto">Auto (staged &gt; unstaged &gt; last commit)</option>
              <option value="staged_changes">Staged changes</option>
              <option value="unstaged_changes">Unstaged changes</option>
              <option value="last_commit">Last commit</option>
              <option value="selected_commit">Selected commit</option>
            </select>
            <button class="btn primary full" id="runValidateReviewBtn" type="button">Run Review</button>
            <div class="runner" id="validateReviewRunner"><div class="fill" id="validateReviewRunnerFill"></div></div>
            <div id="validateReviewStatus" class="notice info hidden" role="status" aria-live="polite"></div>
            <div id="validateReviewError" class="notice bad hidden"></div>
          </div>

          <div class="vr-review-list-view" id="validateReviewListView">
            <div class="vr-task-report-list" id="validateReviewReportList"></div>
            <div class="val-empty" id="validateReviewHistoryEmpty">No Validate &amp; Review results yet. Run a review when you need validation.</div>
          </div>

          <div class="vr-review-doc-view hidden" id="validateReviewDocView">
            <button class="btn ghost compact vr-back-btn" id="validateReviewBackBtn" type="button">&#8592; Back to list</button>
            <div class="vr-doc-container" id="validateReviewDocContainer"></div>
          </div>

          <div class="vr-review-trends-view" id="validateReviewTrendsContainer"></div>

        </section>

        <!-- ===== TASKS ===== -->
        <section class="page active" id="tasksPage">

          <!-- Header: one title (matches active tab) + sync when on Tasks list -->
          <div class="page-head">
            <span class="page-title" id="tasksPageTitle">Thread</span>
            <div class="task-head-right">
              <span class="sync-dot hidden" id="taskSyncDot" title=""></span>
              <button class="btn ghost compact task-sync-icon-btn hidden" id="pullTasksBtn" type="button" title="Sync tasks">↺</button>
              <span class="pill standby" id="statusPill"><span class="status-ascii" id="statusAscii" data-status="standby"></span><span id="statusText">Standby</span></span>
            </div>
          </div>

          <div class="tab-bar tasks-inner-tabs" id="tasksInnerTabs" role="tablist">
            <button class="tab-btn active" type="button" data-tasks-tab="thread" role="tab" aria-selected="true">Thread</button>
            <button class="tab-btn" type="button" data-tasks-tab="list" role="tab" aria-selected="false">Tasks</button>
          </div>

          <div class="tab-panel" id="tasksListPanel">

          <!-- STATE 1: No tool connected — one-tap pill connect -->
          <div class="hidden" id="taskConnectCard">
            <div class="task-connect-prompt">Connect Jira or Linear to pull your tasks.</div>
            <div class="pm-connect-pills">
              <button class="pm-pill" data-connect-tool="linear">Linear</button>
              <button class="pm-pill" data-connect-tool="jira">Jira</button>
            </div>
          </div>

          <!-- Connected tools badges (shown when ≥1 tool connected) -->
          <div class="hidden" id="taskToolsRow">
            <div class="task-tools-badges" id="taskToolsBadges"></div>
          </div>

          <!-- Tier upgrade notice -->
          <div class="notice bad hidden" id="taskTierNotice">
            <div class="notice-copy">Free plan: one PM tool only. <strong>Upgrade to Pro or Max</strong> for all tools.</div>
          </div>

          <!-- STATE 2: Search bar + single ⚙ gear (all controls inside) -->
          <div class="task-controls hidden" id="taskControls">
            <div class="task-toolbar">
              <div class="task-search-wrap">
                <input type="text" id="taskSearchInput" placeholder="Search tasks…" autocomplete="off" />
                <!-- inline chips appear here when active -->
                <div class="task-chips-inline hidden" id="taskChipsRow">
                  <div class="task-chips" id="taskChips"></div>
                  <button class="chip-clear-all" id="clearAllChipsBtn" type="button" title="Clear filters">✕</button>
                </div>
              </div>
              <!-- Single gear: opens the unified control panel -->
              <div class="task-more-wrap task-gear-wrap">
                <button class="btn ghost task-gear-btn" id="taskGearBtn" type="button" title="Filters, sort &amp; more">⚙</button>
                <div class="task-gear-panel hidden" id="taskGearPanel">

                  <!-- Source filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Source</label>
                    <select id="taskSourceFilter" class="tfp-select">
                      <option value="">All sources</option>
                      <option value="linear">Linear</option>
                      <option value="jira">Jira</option>
                      <option value="asana">Asana</option>
                      <option value="notion">Notion</option>
                      <option value="monday">Monday</option>
                    </select>
                  </div>

                  <!-- Status filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Status</label>
                    <div class="tfp-checks" id="tfpStatuses">
                      <label><input type="checkbox" value="todo"> Todo</label>
                      <label><input type="checkbox" value="in_progress"> In Progress</label>
                      <label><input type="checkbox" value="in_review"> In Review</label>
                      <label><input type="checkbox" value="blocked"> Blocked</label>
                      <label><input type="checkbox" value="done"> Done</label>
                    </div>
                  </div>

                  <!-- Priority filter -->
                  <div class="tfp-row">
                    <label class="tfp-label">Priority</label>
                    <div class="tfp-checks" id="tfpPriorities">
                      <label><input type="checkbox" value="urgent"> Urgent</label>
                      <label><input type="checkbox" value="high"> High</label>
                      <label><input type="checkbox" value="medium"> Medium</label>
                      <label><input type="checkbox" value="low"> Low</label>
                    </div>
                  </div>

                  <!-- Due date -->
                  <div class="tfp-row">
                    <label class="tfp-label">Due date</label>
                    <select id="tfpDueDate" class="tfp-select">
                      <option value="">Any</option>
                      <option value="today">Today</option>
                      <option value="this_week">This week</option>
                      <option value="overdue">Overdue</option>
                    </select>
                  </div>

                  <!-- Updated -->
                  <div class="tfp-row">
                    <label class="tfp-label">Updated</label>
                    <select id="tfpUpdated" class="tfp-select">
                      <option value="">Any</option>
                      <option value="last_7_days">Last 7 days</option>
                      <option value="last_30_days">Last 30 days</option>
                    </select>
                  </div>

                  <!-- Has -->
                  <div class="tfp-row">
                    <label class="tfp-label">Has</label>
                    <div class="tfp-checks">
                      <label><input type="checkbox" id="tfpHasBranch"> Branch</label>
                      <label><input type="checkbox" id="tfpHasCommits"> Commits</label>
                      <label><input type="checkbox" id="tfpHasTime"> Time tracked</label>
                    </div>
                  </div>

                  <!-- Sort -->
                  <div class="tfp-row">
                    <label class="tfp-label">Sort by</label>
                    <select id="taskSortSelect" class="tfp-select">
                      <option value="recommended:desc">Recommended</option>
                      <option value="updatedAt:desc">Updated ↓</option>
                      <option value="updatedAt:asc">Updated ↑</option>
                      <option value="createdAt:desc">Created ↓</option>
                      <option value="dueDate:asc">Due ↑</option>
                      <option value="priority:asc">Priority</option>
                      <option value="title:asc">Title A–Z</option>
                      <option value="status:asc">Status</option>
                      <option value="sourceTool:asc">Source</option>
                    </select>
                  </div>

                  <!-- Filter apply/clear -->
                  <div class="tfp-actions">
                    <button class="btn ghost compact" id="tfpClearBtn" type="button">Clear</button>
                    <button class="btn primary compact" id="tfpApplyBtn" type="button">Apply</button>
                  </div>

                  <!-- Divider -->
                  <div class="gear-panel-sep"></div>

                  <!-- Presets (Pro/Max) -->
                  <div class="tfp-row">
                    <label class="tfp-label">Presets</label>
                    <div class="tfp-upgrade hidden" id="tfpUpgradeNotice">Requires Pro or Max.</div>
                    <div id="presetMenuItems"></div>
                    <button class="gear-text-btn hidden" id="savePresetBtn" type="button">+ Save current as preset</button>
                  </div>

                  <!-- Connect / add tool -->
                  <div class="gear-panel-sep"></div>
                  <div class="tfp-row">
                    <label class="tfp-label">PM Tools</label>
                    <div class="pm-connect-pills pm-connect-pills-sm" id="gearPmPills">
                      <button class="pm-pill-sm" data-connect-tool="linear">Linear</button>
                      <button class="pm-pill-sm" data-connect-tool="jira">Jira</button>
                      <button class="pm-pill-sm" data-connect-tool="asana">Asana</button>
                      <button class="pm-pill-sm" data-connect-tool="notion">Notion</button>
                      <button class="pm-pill-sm" data-connect-tool="monday">Monday</button>
                    </div>
                  </div>

                  <!-- New Task (Pro/Max) -->
                  <div class="gear-panel-sep hidden" id="newTaskSep"></div>
                  <button class="gear-text-btn hidden" id="newTaskBtn" type="button">+ New Task</button>

                </div>
              </div>
            </div>

            <!-- Query parse error bar -->
            <div class="notice bad hidden" id="queryErrorBar">
              <span id="queryErrorText"></span>
            </div>
          </div>

          <!-- Task list -->
          <div id="taskListContainer">
            <div class="task-workspace-row hidden" id="taskWorkspaceRow">
              <select id="taskWorkspaceSelect" class="task-workspace-select" title="Task workspace">
                <option value="">All connected workspaces</option>
              </select>
            </div>
            <div class="task-scope-label hidden" id="taskScopeLabel" title="Tasks currently assigned to you in the connected PM tool">Assigned to me</div>
            <div class="empty" id="taskListEmpty" style="display:none">No tasks match your filters.</div>
            <div id="taskList"></div>
          </div>

          <!-- ── Task detail drawer ── -->
          <div class="task-detail-drawer hidden" id="taskDetailDrawer">

            <!-- Conflict banner (only appears on detected conflict) -->
            <div class="notice warn hidden" id="taskConflictBanner">
              <div class="notice-copy" id="taskConflictMsg">This task changed externally. Reload before saving?</div>
              <div class="btn-row">
                <button class="btn primary compact" id="conflictReloadBtn" type="button">Reload</button>
                <button class="btn ghost compact" id="conflictKeepBtn" type="button">Keep editing</button>
                <button class="btn ghost compact" id="conflictCancelBtn" type="button">Cancel</button>
              </div>
            </div>

            <!-- Header row -->
            <div class="task-detail-head">
              <span class="task-detail-title" id="taskDetailTitle">—</span>
              <button class="btn ghost compact" id="taskDetailCloseBtn" type="button">✕</button>
            </div>

            <!-- Single meta line: status · priority · source -->
            <div class="task-detail-meta" id="taskDetailMeta"></div>

            <!-- PRIMARY ACTION — full width. Label switches to
                 "✨ Create Tasks from Story" for Story/Epic issue types. -->
            <button class="btn primary task-detail-primary-btn" id="taskDetailStartThreadBtn" type="button">Start thread</button>

            <div class="task-detail-secondary-row">
              <button class="btn ghost compact" id="taskDetailValidateBtn" type="button">Validate &amp; Review</button>
              <button class="btn ghost compact" id="taskDetailGenerateCommitBtn" type="button">Generate Commit</button>
            </div>

            <!-- Secondary actions row — always visible, no menu -->
            <div class="task-detail-secondary-row">
              <button class="btn ghost compact" id="tdEditBtn" type="button">Edit</button>
              <button class="btn ghost compact" id="tdRefreshBtn" type="button">↺</button>
              <button class="btn ghost compact" id="tdCopyIdBtn" type="button">Copy ID</button>
              <button class="btn ghost compact" id="tdCopyLinkBtn" type="button">Copy Link</button>
              <button class="btn ghost compact" id="tdOpenPmBtn" type="button">Open ↗</button>
            </div>

            <!-- Inline edit form (Pro/Max, hidden by default) -->
            <div class="task-edit-drawer hidden" id="taskEditDrawer">
              <div class="label">Edit Task</div>
              <div class="field"><label>Title</label><input type="text" id="editTaskTitle" autocomplete="off" /></div>
              <div class="field"><label>Status</label>
                <select id="editTaskStatus">
                  <option value="todo">Todo</option>
                  <option value="in_progress">In Progress</option>
                  <option value="in_review">In Review</option>
                  <option value="done">Done</option>
                  <option value="blocked">Blocked</option>
                  <option value="canceled">Canceled</option>
                </select>
              </div>
              <div class="field"><label>Priority</label>
                <select id="editTaskPriority">
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div class="field"><label>Due date</label><input type="date" id="editTaskDueDate" /></div>
              <div class="field"><label>Description</label><textarea id="editTaskDescription" rows="3" placeholder="Description…"></textarea></div>
              <div class="notice bad hidden" id="editTaskError"></div>
              <div class="btn-row">
                <button class="btn primary" id="editTaskSaveBtn" type="button">Save</button>
                <button class="btn ghost compact" id="editTaskCancelBtn" type="button">Cancel</button>
              </div>
              <div class="notice bad hidden" id="editUpgradeNotice">Editing tasks requires Pro or Max.</div>
            </div>

            <!-- PM Intelligence section -->
            <div class="task-detail-section" id="pmIntelligenceSection">
              <div class="pm-intelligence-header">
                <div class="label">PM Intelligence</div>
                <button class="btn ghost compact" id="refreshPmIntelligenceBtn" type="button">Refresh Intelligence</button>
              </div>
              <div id="pmIntelligenceLoading" class="pm-intelligence-loading hidden" aria-live="polite">
                <div class="pm-think-row">
                  <div class="pm-think-dots" aria-hidden="true"><span></span><span></span><span></span></div>
                  <div class="pm-think-copy">
                    <strong class="pm-think-title">Tyne is reading this task</strong>
                    <span class="pm-think-step">Pulling issue context</span>
                  </div>
                </div>
              </div>
              <div id="pmIntelligenceError" class="notice bad hidden"></div>

              <div class="pm-intelligence-block" id="pmGoalSection">
                <div class="pm-intelligence-label">Goal</div>
                <div id="pmGoalText" class="pm-intelligence-content"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmSubtasksSection">
                <div class="pm-intelligence-label">Subtasks</div>
                <div id="pmSubtasksList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmAcceptanceCriteriaSection">
                <div class="pm-intelligence-label">Acceptance Criteria</div>
                <div id="pmAcceptanceCriteriaList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmProofPointsSection">
                <div class="pm-intelligence-label">Proof Points</div>
                <div id="pmProofPointsList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmValidationStepsSection">
                <div class="pm-intelligence-label">Validation Steps</div>
                <div id="pmValidationStepsList" class="pm-intelligence-list"></div>
              </div>

              <div class="pm-intelligence-block hidden" id="pmValidationResultSection">
                <div class="pm-intelligence-label">Validation Result</div>
                <div id="pmValidationResultText" class="pm-intelligence-content"></div>
              </div>
            </div>

            <!-- ▸ Details collapse toggle -->
            <button class="task-details-toggle" id="taskDetailsToggle" type="button">▸ Details</button>
            <div class="task-details-body hidden" id="taskDetailsBody">

              <div class="task-detail-desc-wrap">
                <div class="task-detail-desc" id="taskDetailDesc"></div>
                <button class="btn ghost compact hidden" id="taskDetailDescToggle" type="button">Show more</button>
              </div>

              <div class="task-detail-section hidden" id="taskDetailSubtasksSection">
                <div class="label" style="margin-top:10px">Jira Subtasks</div>
                <div id="taskDetailSubtasks"></div>
                <div class="add-row hidden" id="addSubtaskRow">
                  <input type="text" id="newSubtaskInput" placeholder="Add subtask…" autocomplete="off" />
                  <button class="icon-btn" id="addSubtaskSubmitBtn" type="button" title="Add subtask">${ICON.plus}</button>
                </div>
              </div>

              <div class="task-detail-section hidden" id="taskDetailCommentsSection">
                <div class="label" style="margin-top:10px">Comments</div>
                <div id="taskDetailComments"></div>
                <button class="btn ghost compact hidden" id="taskDetailMoreCommentsBtn" type="button">Show more</button>
                <div class="add-row hidden" id="addCommentRow">
                  <input type="text" id="newCommentInput" placeholder="Add comment…" autocomplete="off" />
                  <button class="icon-btn" id="addCommentSubmitBtn" type="button" title="Post">${ICON.plus}</button>
                </div>
              </div>

              <div class="task-detail-section hidden" id="taskDetailHistorySection">
                <div class="label" style="margin-top:10px">History (last 30 days)</div>
                <div id="taskDetailHistory"></div>
              </div>

            </div>
          </div>

          <!-- Inline create task drawer (Pro/Max) -->
          <div class="task-create-drawer hidden" id="taskCreateDrawer">
            <div class="task-detail-head">
              <span class="task-detail-title">New Task</span>
              <button class="btn ghost compact" id="createDrawerCloseBtn" type="button">✕</button>
            </div>
            <div class="field"><label>PM Tool</label>
              <select id="createTaskTool">
                <option value="linear">Linear</option>
                <option value="jira">Jira</option>
                <option value="asana">Asana</option>
                <option value="notion">Notion</option>
                <option value="monday">Monday</option>
              </select>
            </div>
            <div class="field"><label>Title <span class="req">*</span></label><input type="text" id="createTaskTitle" placeholder="Task title…" autocomplete="off" /></div>
            <div class="field"><label>Description</label><textarea id="createTaskDesc" rows="3" placeholder="Description (optional)…"></textarea></div>
            <div class="field"><label>Status</label>
              <select id="createTaskStatus">
                <option value="todo">Todo</option>
                <option value="in_progress">In Progress</option>
              </select>
            </div>
            <div class="field"><label>Priority</label>
              <select id="createTaskPriority">
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
                <option value="low">Low</option>
                <option value="none">None</option>
              </select>
            </div>
            <div class="field"><label>Due date</label><input type="date" id="createTaskDueDate" /></div>
            <div class="notice bad hidden" id="createTaskError"></div>
            <div class="btn-row">
              <button class="btn primary" id="createTaskSubmitBtn" type="button">Create Task</button>
              <button class="btn ghost compact" id="createTaskCancelBtn" type="button">Cancel</button>
            </div>
            <div class="notice bad hidden" id="createUpgradeNotice">Creating tasks requires Pro or Max.</div>
          </div>

          <!-- Save preset drawer -->
          <div class="task-create-drawer hidden" id="savePresetDrawer">
            <div class="task-detail-head">
              <span class="task-detail-title">Save Filter Preset</span>
              <button class="btn ghost compact" id="savePresetDrawerCloseBtn" type="button">✕</button>
            </div>
            <div class="field"><label>Name <span class="req">*</span></label><input type="text" id="presetNameInput" placeholder="e.g. My Active Tasks" autocomplete="off" /></div>
            <div class="field"><label><input type="checkbox" id="presetIsDefault" /> Set as default</label></div>
            <div class="btn-row">
              <button class="btn primary" id="presetSaveSubmitBtn" type="button">Save</button>
              <button class="btn ghost compact" id="presetSaveCancelBtn" type="button">Cancel</button>
            </div>
          </div>

          </div>

          <!-- ===== THREAD (tab inside Tasks) ===== -->
          <div class="tab-panel active" id="threadPage">

          <!-- Phase dots kept for JS; status pill lives in the shared page head. -->
          <div class="stepper thread-phase-dots hidden" id="stepper" aria-hidden="true" title="Thread phase">
            <div class="step" data-step="0"><div class="bar"></div><div class="name">Task</div></div>
            <div class="step" data-step="1"><div class="bar"></div><div class="name">Weave</div></div>
            <div class="step" data-step="2"><div class="bar"></div><div class="name">Verify</div></div>
            <div class="step" data-step="3"><div class="bar"></div><div class="name">Ship</div></div>
          </div>

          <!-- Inline alert banners (drift, prep) -->
          <div id="thread-alerts">
            <div class="thread-alert-banner hidden" id="prepPanel">
              <div class="tab-alert-icon">&#9432;</div>
              <div class="tab-alert-body">
                <div class="tab-alert-title">Workspace prep</div>
                <div id="prepLines" class="tab-alert-sub">Preparing workspace&hellip;</div>
              </div>
            </div>
            <div class="thread-alert-banner warn hidden" id="driftPanel">
              <div class="tab-alert-icon">&#9888;</div>
              <div class="tab-alert-body">
                <div class="tab-alert-title">Drift detected — <span id="driftFile"></span></div>
                <div id="driftNote" class="tab-alert-sub"></div>
                <div class="tab-alert-actions">
                  <button class="thr-link-btn" data-drift-action="park">Park idea</button>
                  <button class="thr-link-btn" data-drift-action="new_ticket">New ticket</button>
                  <button class="thr-link-btn muted" data-drift-action="dismiss">Ignore</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Thread brief form (pre-weave) -->
          <div id="briefSection">
            <div class="label-row">
              <div class="label">Start a thread</div>
              <button class="link-action" id="addTaskBtn" type="button" data-flow-action="addTask" title="Create a task from this brief">${ICON.plus}<span>Add task</span></button>
            </div>
            <div class="thread-form-hint">Anchor this session to one task and its goal. Tyne branches, tracks, and validates against it.</div>
            <div class="field">
              <label for="appName">Project / app</label>
              <input type="text" id="appName" placeholder="My App" autocomplete="off" />
            </div>
            <!-- Ranked suggestion: same order as the Tasks list "Start here" band -->
            <div class="thread-suggest hidden" id="threadSuggest">
              <div class="thread-suggest-head">
                <span class="thread-suggest-title">Start here</span>
                <button class="thr-link-btn muted" id="threadSuggestAllBtn" type="button">See all tasks</button>
              </div>
              <div id="threadSuggestBody"></div>
            </div>
            <div class="field" id="threadTaskPickerField">
              <label for="threadTaskPicker">Pick a task</label>
              <select id="threadTaskPicker">
                <option value="">— Select an assigned task —</option>
              </select>
            </div>
            <div class="field">
              <label for="taskId">Task ID</label>
              <input type="text" id="taskId" placeholder="PRO-102" autocomplete="off" />
            </div>
            <div class="field">
              <label for="goal">Goal</label>
              <input type="text" id="goal" placeholder="What must be true when this is done?" autocomplete="off" />
            </div>
          </div>

          <!-- Custom task creation (visible in both pre-weave and weaving states) -->
          <div class="field hidden" id="customTaskField">
            <label for="customTaskTitle">Custom task title</label>
            <div class="add-row">
              <input type="text" id="customTaskTitle" placeholder="Enter a task title…" autocomplete="off" />
              <button class="btn primary compact" id="customTaskCreateBtn" type="button">Create</button>
            </div>
          </div>

          <!-- Active thread hero -->
          <div id="briefSummary" class="thread-hero hidden">
            <div class="thread-hero-eyebrow" id="bsEyebrow"></div>
            <div class="thread-hero-head">
              <div class="thread-hero-title" id="bsGoal"></div>
              <div class="thread-hero-switch hidden" id="weavingTaskPickerField">
                <select id="weavingTaskPicker" aria-label="Switch task">
                  <option value="">Switch task…</option>
                </select>
              </div>
            </div>
            <div class="thread-hero-goal hidden" id="bsGoalSub"></div>
            <div class="thread-hero-facts">
              <div class="thread-fact">
                <span class="thread-fact-k">branch</span>
                <span class="thread-fact-v" id="bsBranch" title=""></span>
              </div>
              <div class="thread-fact">
                <span class="thread-fact-k">time</span>
                <span class="thread-fact-v" id="mTime">0m</span>
              </div>
              <div class="thread-fact hidden" id="mStitchWrap">
                <span class="thread-fact-k">stitches</span>
                <span class="thread-fact-v"><span id="mStitch">0</span></span>
              </div>
            </div>
            <span id="bsTask" class="visually-hidden" aria-hidden="true"></span>
            <span id="mTask" class="visually-hidden" aria-hidden="true">—</span>
          </div>

          <!-- Staging action bar -->
          <div id="gitStatusHint" class="thread-stage-bar hidden">
            <span class="thread-stage-msg" id="gitStatusMsg"></span>
            <button type="button" class="thread-stage-action hidden" id="gitStageBtn">Stage</button>
          </div>

          <!-- Deep review lock notice -->
          <div class="notice bad hidden" id="deepReviewLock">
            <div class="notice-title">Deep goal tracking locked</div>
            <div class="notice-copy">Your hosted validation quota is used up for this month. Connect your own AXIOM key to keep validating, or upgrade your plan.</div>
            <div class="btn-row"><button class="btn primary" id="upgradeToMaxBtn" type="button">Upgrade to MAX</button></div>
          </div>

          <!-- Proof points -->
          <div id="proofSection">
            <div class="notice bad hidden" id="threadEnrichmentNotice"></div>
            <button class="section-toggle proof-toggle" data-target="proofBody" type="button">
              <span class="toggle-arrow">&#9658;</span> Proof points
              <span class="toggle-count" id="proofToggleCount"></span>
            </button>
            <div class="section-body hidden" id="proofBody">
              <div id="proofTemplateList"></div>
              <div id="subtaskList"></div>
              <div class="add-row">
                <input type="text" id="newSubtask" placeholder="Add a proof point&hellip;" autocomplete="off" />
                <button class="icon-btn" id="addSubtaskBtn" title="Add" aria-label="Add proof point">${ICON.plus}</button>
              </div>
            </div>
          </div>

          <!-- Primary action -->
          <button class="btn primary full thread-primary-btn" id="flowPrimaryBtn" type="button" data-flow-action="selectTask">Select task</button>
          <div class="thread-secondary-wrap">
            <button class="thr-link-btn" id="flowSecondaryBtn" type="button" data-flow-action="openAi">AI setup</button>
          </div>

          <!-- Thin progress runner -->
          <div class="runner" id="flowRunner"><div class="fill" id="flowRunnerFill"></div></div>

          <!-- PR panel (shown after ship) -->
          <div class="notice good hidden" id="prPanel">
            <div class="notice-title">Thread complete</div>
            <div class="notice-copy" id="prSummary">Draft PR created</div>
            <div class="btn-row"><button class="btn" id="prLink" type="button">View on GitHub</button></div>
          </div>

          <!-- Collapsible sections -->
          <div class="thread-collapses">

            <!-- Latest review -->
            <div class="hidden" id="validationWrap">
              <button class="section-toggle" data-target="validationBody">
                <span class="toggle-arrow">&#9658;</span> Latest review
                <span class="toggle-count" data-target="validationBody"></span>
              </button>
              <div class="section-body hidden" id="validationBody">
                <div class="val-counter-bar thread-val-quota" id="valCounterBar" aria-label="Validation usage">
                  <div class="val-counter-row">
                    <span class="val-counter" id="valCounter">Validations: loading…</span>
                    <span class="val-provider" id="valProviderBadge"></span>
                  </div>
                </div>
                <div class="thread-metric-list" id="threadReviewMetrics"></div>

                <div class="val-stages-panel hidden" id="valStagesPanel" aria-live="polite" aria-label="Validation progress">
                  <div class="val-stages-title visually-hidden">Validation</div>
                  <div class="val-stages-list" id="valStagesList"></div>
                </div>

                <div class="val-meta-row hidden" id="valMetaRow">
                  <span class="val-counter-legacy" id="valCounterLegacy"></span>
                  <span class="val-provider" id="valProviderBadgeLegacy"></span>
                </div>

                <div class="card thread-val-legacy hidden" id="validationPanel">
                  <div class="val-empty" id="valEmpty">No reports yet. Run Validate &amp; Review after coding.</div>
                  <div class="val-result hidden" id="valResult">
                    <div class="val-header">
                      <span class="val-badge" id="valBadge"></span>
                      <span class="val-match" id="valMatch"></span>
                      <span class="val-risk" id="valRisk"></span>
                    </div>
                    <div class="val-summary" id="valSummary"></div>
                    <div class="val-enhanced hidden" id="valEnhanced">
                      <div class="val-section hidden" id="valDetailedSection"><div class="val-label">Detailed explanation</div><div class="val-text" id="valDetailed"></div></div>
                      <div class="val-section hidden" id="valMissingSection"><div class="val-label">Missing requirements</div><ul id="valMissing"></ul></div>
                      <div class="val-section hidden" id="valSuggestionsSection"><div class="val-label">Suggestions</div><ul id="valSuggestions"></ul></div>
                      <div class="val-section hidden" id="valQualitySection"><div class="val-label">Code quality notes</div><ul id="valQuality"></ul></div>
                      <div class="val-section hidden" id="valFilesSection"><div class="val-label">Files reviewed</div><ul id="valFiles"></ul></div>
                    </div>
                    <div class="val-meta" id="valMeta"></div>
                    <div class="btn-row" id="valActions">
                      <button class="btn primary" id="btnRevalidate" type="button">Re-run Validate &amp; Review</button>
                      <button class="btn" id="btnOverride" type="button">Override</button>
                      <button class="btn ghost compact" id="btnCopyValSummary" type="button">Copy</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Past reviews (sibling section) -->
            <div class="hidden" id="pastReviewsWrap">
              <button class="section-toggle" data-target="pastReviewsBody" type="button">
                <span class="toggle-arrow">&#9658;</span> Past reviews
                <span class="toggle-count" id="pastReviewsCount"></span>
              </button>
              <div class="section-body hidden" id="pastReviewsBody">
                <div class="val-history-controls hidden" id="valHistoryControls">
                  <input type="text" class="val-search" id="valHistorySearch" placeholder="Search…" />
                  <select class="val-filter" id="valHistoryFilter" title="Filter">
                    <option value="">All</option>
                    <option value="today">Today</option>
                    <option value="this_week">This week</option>
                    <option value="this_month">This month</option>
                    <option value="pass">PASS</option>
                    <option value="partial">PARTIAL</option>
                    <option value="fail">FAIL</option>
                  </select>
                  <select class="val-sort" id="valHistorySort" title="Sort">
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                  <div class="val-more-menu-wrap">
                    <button class="btn ghost compact" id="valHistoryMoreBtn" type="button">Export</button>
                    <div class="val-more-menu hidden" id="valHistoryMoreMenu">
                      <button class="val-more-item" data-export="csv" type="button">Export CSV</button>
                      <button class="val-more-item" data-export="json" type="button">Export JSON</button>
                    </div>
                  </div>
                </div>
                <div class="val-trends hidden" id="valTrends"></div>
                <div class="val-history" id="valHistory"><div class="empty" id="valHistoryEmpty">No past reviews yet.</div></div>
                <button type="button" class="thread-view-all hidden" id="valHistoryViewAll">View all reviews</button>
              </div>
            </div>

            <!-- AI Usage -->
            <div class="hidden" id="usageWrap">
              <button class="section-toggle" data-target="usageBody">
                <span class="toggle-arrow">&#9658;</span> Usage
                <span class="toggle-count" data-target="usageBody"></span>
              </button>
              <div class="section-body hidden" id="usageBody">
                <div class="thread-kv" id="usageKv">
                  <div class="thread-kv-row"><span id="usageLabel">AI usage</span><span id="usageText">0 / 50</span></div>
                </div>
                <div class="usage-track"><div class="usage-fill" id="usageFill"></div></div>
              </div>
            </div>

            <!-- Parked ideas -->
            <div class="hidden" id="parkedPanel">
              <button class="section-toggle" data-target="parkedBody" id="parkedTitle">
                <span class="toggle-arrow">&#9658;</span> Parked ideas
                <span class="toggle-count" data-target="parkedBody"></span>
              </button>
              <div class="section-body hidden" id="parkedBody">
                <div id="parkedList"></div>
                <div class="btn-row" style="margin-top:6px"><button class="btn compact" id="clearParkedBtn" type="button">Clear all</button></div>
              </div>
            </div>

            <!-- Commits -->
            <div id="commitActivitySection">
              <button class="section-toggle" data-target="commitActivityBody">
                <span class="toggle-arrow">&#9658;</span> Commits
                <span class="toggle-count" data-target="commitActivityBody" id="commitActivityCount"></span>
              </button>
              <div class="section-body hidden" id="commitActivityBody">
                <div id="taskCommitSummaryCard" class="card thread-commit-summary-card">
                  <div class="empty">No linked commit history yet.</div>
                </div>
                <div id="taskCommitList" class="thread-commit-list"></div>
              </div>
            </div>

          </div>

          </div>

        </section>

        <!-- ===== BRANCHES ===== -->
        <section class="page" id="branchesPage">
          <div class="page-head">
            <span class="page-title">Branches</span>
            <button class="icon-btn" id="refreshBranchesBtn" type="button" title="Refresh branches">↺</button>
          </div>
          <div id="currentBranchCard" class="card branch-current-card">
            <div class="empty">No linked Tyne branch is active.</div>
          </div>

          <button class="section-toggle" data-target="branchHistoryBody" type="button">
            <span class="toggle-arrow">▸</span> Branch History
            (<span class="toggle-count" data-target="branchHistoryBody">0</span>)
          </button>
          <div class="section-body hidden" id="branchHistoryBody">
            <div id="branchHistoryList"></div>
          </div>
        </section>

        <!-- ===== COMMITS ===== -->
        <section class="page" id="commitsPage">
          <div class="page-head">
            <span class="page-title">Commits</span>
            <button class="icon-btn" id="refreshCommitsBtn" type="button" title="Refresh commits">↺</button>
          </div>
          <div class="time-hero">
            <div class="big" id="commitOverviewValue">0</div>
            <div class="cap" id="commitOverviewLabel">Commits on this branch</div>
          </div>
          <div class="metrics">
            <div class="metric"><div class="k">Sessions</div><div class="v" id="commitSessionCount">0</div></div>
            <div class="metric"><div class="k">Duration</div><div class="v" id="commitDurationTotal">0m</div></div>
            <div class="metric"><div class="k">Last Active</div><div class="v" id="commitLastActivity">—</div></div>
          </div>

          <div class="chart-card">
            <div class="chart-head">
              <div>
                <div class="chart-title">Commit velocity</div>
                <div class="chart-sub" id="velocitySub">Last 14 days</div>
              </div>
              <div class="seg seg-sm" id="velocityToggle">
                <button data-vmetric="commits" class="active" type="button">Commits</button>
                <button data-vmetric="lines" type="button">Lines</button>
              </div>
            </div>
            <div class="chart-body" id="velocityChart">
              <div class="chart-empty">No commits yet — your velocity will appear here as you stitch.</div>
            </div>
          </div>

          <button class="section-toggle" data-target="sessionBody" type="button">
            <span class="toggle-arrow">▸</span> Sessions
            (<span class="toggle-count" data-target="sessionBody">0</span>)
          </button>
          <div class="section-body hidden" id="sessionBody">
            <div id="sessionList"><div class="empty">No commit sessions found for this Tyne branch yet.</div></div>
          </div>

          <button class="section-toggle" data-target="commitBody" type="button">
            <span class="toggle-arrow">▸</span> All Commits
            (<span class="toggle-count" data-target="commitBody">0</span>)
          </button>
          <div class="section-body hidden" id="commitBody">
            <div id="commitList"><div class="empty">No commits found.</div></div>
          </div>
        </section>

        <!-- ===== ANALYTICS ===== -->
        <section class="page" id="analyticsPage">
          <div class="page-head">
            <span class="page-title">Analytics</span>
            <div class="time-header-actions">
              <button class="icon-btn" id="addManualTimeHeaderBtn" type="button" title="Add manual time">+</button>
              <button class="icon-btn" id="refreshTimeBtn" type="button" title="Refresh analytics">↺</button>
            </div>
          </div>

          <div class="analytics-task-pick">
            <label class="analytics-pick-label" for="analyticsTaskSelect">Task</label>
            <select id="analyticsTaskSelect" aria-label="Select task for analytics">
              <option value="">No tasks with time yet</option>
            </select>
          </div>

          <div class="analytics-hero" id="analyticsHero">
            <div class="analytics-greet" id="analyticsGreet">Developer Time Breakdown</div>
            <div class="analytics-sub" id="analyticsSub">Select a task to see detailed work time.</div>
          </div>

          <div class="analytics-bento" id="analyticsBento">
            <div class="analytics-card analytics-card-score" id="analyticsScoreCard">
              <div class="analytics-card-label">Productivity</div>
              <div class="analytics-ring-wrap">
                <svg class="analytics-ring" viewBox="0 0 72 72" aria-hidden="true">
                  <circle class="analytics-ring-bg" cx="36" cy="36" r="30" />
                  <circle class="analytics-ring-fg" id="analyticsRingFg" cx="36" cy="36" r="30" />
                </svg>
                <div class="analytics-ring-value" id="analyticsScoreValue">—</div>
              </div>
              <div class="analytics-card-foot" id="analyticsScoreFoot">Score / 100</div>
            </div>
            <div class="analytics-card analytics-card-time" id="analyticsTimeCard">
              <div class="analytics-card-label">Time on task</div>
              <div class="analytics-big" id="analyticsTotalTime">0m</div>
              <div class="analytics-bars" id="analyticsTimeBars"></div>
            </div>
            <div class="analytics-card analytics-card-code" id="analyticsCodeCard">
              <div class="analytics-card-label">Code</div>
              <div class="analytics-metric-grid" id="analyticsCodeMetrics"></div>
            </div>
            <div class="analytics-card analytics-card-ai" id="analyticsAiCard">
              <div class="analytics-card-label">AI used</div>
              <div id="analyticsAiBody"><div class="empty">No Tyne AI usage yet.</div></div>
            </div>
          </div>

          <div class="analytics-insights card" id="analyticsInsights">
            <div class="empty">Insights appear after you track time.</div>
          </div>

          <div class="analytics-detail card" id="analyticsDetailCard">
            <div class="analytics-detail-head">
              <div class="analytics-detail-title">Timeline</div>
              <div class="analytics-detail-total" id="analyticsDetailTotal">TOTAL: 0m</div>
            </div>
            <div class="analytics-timeline" id="analyticsTimeline">
              <div class="empty">No sessions yet for this task.</div>
            </div>
            <div class="analytics-detail-foot" id="analyticsDetailFoot"></div>
          </div>

          <div class="card" id="taskTimeSummaryCard" style="display:none" aria-hidden="true"></div>

          <button class="section-toggle" data-target="timeSessionBody" type="button">
            <span class="toggle-arrow">▸</span> Sessions
            <span class="toggle-count" data-target="timeSessionBody">0</span>
          </button>
          <div class="section-body hidden" id="timeSessionBody">
            <div id="timeSessionList"><div class="empty">No commit sessions found for this branch yet.</div></div>
          </div>

          <button class="section-toggle" data-target="manualTimeBody" type="button">
            <span class="toggle-arrow">▸</span> Manual Entries
            <span class="toggle-count" data-target="manualTimeBody">0</span>
          </button>
          <div class="section-body hidden" id="manualTimeBody">
            <div id="manualTimeList"><div class="empty">No manual time entries yet.</div></div>
            <div class="card hidden" id="manualTimeFormCard">
              <div class="label" style="margin-top:0">New Manual Entry</div>
              <div class="field"><label for="mtDate">Date</label><input type="date" id="mtDate" /></div>
              <div class="field"><label for="mtDuration">Duration (minutes)</label><input type="number" id="mtDuration" min="1" placeholder="e.g. 45" /></div>
              <div class="field"><label for="mtStartTime">Start time (optional)</label><input type="time" id="mtStartTime" /></div>
              <div class="field"><label for="mtEndTime">End time (optional)</label><input type="time" id="mtEndTime" /></div>
              <div class="field"><label for="mtNote">Note (optional)</label><input type="text" id="mtNote" placeholder="Coding, debugging, testing, review&hellip;" /></div>
              <div class="notice bad hidden" id="manualTimeError"><div class="notice-copy" id="manualTimeErrorText"></div></div>
              <div class="btn-row">
                <button class="btn primary" id="saveManualTimeBtn" type="button">Save</button>
                <button class="btn" id="cancelManualTimeBtn" type="button">Cancel</button>
              </div>
            </div>
          </div>

        </section>

        <!-- ===== AUTOMATION ===== -->
        <section class="page" id="automationPage">
          <div class="page-head">
            <span class="page-title">Automation</span>
            <button class="btn ghost compact" id="refreshAutomationBtn" type="button">Refresh</button>
          </div>

          <div class="label">Task Status</div>
          <div class="card" id="automationStatusCard">
            <div class="empty">No active task. Start a thread to use automation.</div>
          </div>

          <div class="notice bad hidden" id="automationConflictCard">
            <div class="notice-title">Status Mismatch</div>
            <div class="notice-copy" id="automationConflictText">Task status changed in PM tool. Refresh Tyne task state?</div>
            <div class="btn-row"><button class="btn" id="automationResolveConflictBtn" type="button">Refresh Status</button></div>
          </div>

          <div class="label">Actions</div>
          <div class="btn-stack" id="automationActionBtns">
            <button class="btn" id="automationRefreshStatusBtn" type="button">Refresh Status</button>
            <button class="btn" id="automationPreviewFeedbackBtn" type="button">Preview Feedback</button>
            <button class="btn" id="automationPostFeedbackBtn" type="button">Post Feedback</button>
            <button class="btn" id="automationMarkDoneBtn" type="button">Mark Task Done</button>
            <button class="btn primary" id="automationCompleteBtn" type="button">Complete Task &amp; Post Feedback</button>
          </div>

          <div class="card hidden" id="automationFeedbackPreviewCard">
            <label class="label" for="automationFeedbackPreviewText" style="margin-top:0">Tyne Update Preview</label>
            <textarea id="automationFeedbackPreviewText" rows="10" aria-label="Edit PM comment before posting"></textarea>
            <div class="btn-row">
              <button class="btn primary" id="automationPostPreviewedBtn" type="button">Post to Jira/Linear</button>
              <button class="btn" id="automationClosePreviewBtn" type="button">Cancel</button>
            </div>
          </div>

          <div class="label">Recent Events</div>
          <div id="automationEventList"><div class="empty">No automation events yet.</div></div>

          <div class="label">Commit Detection</div>
          <div class="card" id="commitDetectionCard">
            <div class="field-row">
              <span class="field-label">Status</span>
              <span id="commitDetectionStatus">Detecting...</span>
            </div>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn" id="reinstallCommitHookBtn" type="button">Reinstall Git Hook</button>
            </div>
          </div>

          <div class="label">Automation Settings</div>
          <div class="card" id="automationSettingsCard">
            <div class="settings-subhead">Workflow</div>
            <div class="field">
              <label for="autoCloseTrigger">Auto-close trigger</label>
              <select id="autoCloseTrigger">
                <option value="manual">Manual only</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div class="field toggle-row max-only hidden" id="autoCloseOnCommitRow">
              <label for="autoCloseOnCommit">Auto-close on commit (MAX)</label>
              <input type="checkbox" id="autoCloseOnCommit" />
            </div>
            <div class="field">
              <label for="autoFeedbackTrigger">Auto-feedback trigger</label>
              <select id="autoFeedbackTrigger">
                <option value="after_commit">After commit</option>
                <option value="after_validation_pass">After validation pass</option>
                <option value="manual">Manual</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            <div class="field toggle-row">
              <label for="requireValidationBeforeAutoClose">Require validation before close</label>
              <input type="checkbox" id="requireValidationBeforeAutoClose" />
            </div>
            <div class="field toggle-row">
              <label for="requireValidationBeforeFeedback">Require validation before feedback</label>
              <input type="checkbox" id="requireValidationBeforeFeedback" />
            </div>
            <div class="field toggle-row">
              <label for="autoPostFeedbackAfterClose">Auto-post feedback after close</label>
              <input type="checkbox" id="autoPostFeedbackAfterClose" />
            </div>

            <div class="settings-subhead">PM Sync</div>
            <div class="field toggle-row">
              <label for="syncPmStatusToTyne">Sync PM status to Tyne</label>
              <input type="checkbox" id="syncPmStatusToTyne" />
            </div>
            <div class="field toggle-row">
              <label for="syncTyneStatusToPm">Sync Tyne status to PM</label>
              <input type="checkbox" id="syncTyneStatusToPm" />
            </div>
            <div class="field toggle-row">
              <label for="autoMovePmToInProgressOnStart">Move PM to In Progress on start</label>
              <input type="checkbox" id="autoMovePmToInProgressOnStart" />
            </div>

            <div class="settings-subhead">Privacy &amp; Data</div>
            <div class="field" id="privacyModeField">
              <label>Privacy Mode</label>
              <div class="privacy-mode-options">
                <label><input type="radio" name="privacyMode" value="cloud" /> Cloud Review</label>
                <label><input type="radio" name="privacyMode" value="privacy_enhanced" /> Privacy Enhanced</label>
                <label><input type="radio" name="privacyMode" value="local_compliance" /> Local Compliance Mode</label>
              </div>
              <p class="hint">Controls what leaves your machine during Validate &amp; Review.</p>
            </div>
            <div class="field" id="dataResidencyField">
              <label for="dataResidency">Data Processing Location</label>
              <select id="dataResidency">
                <option value="us">US</option>
                <option value="eu">EU</option>
                <option value="local_only">Local Only</option>
                <option value="enterprise_managed">Enterprise Managed</option>
              </select>
              <p class="hint">Local Only keeps analysis on-device. Enterprise Managed routes to your self-hosted endpoint (Settings: tyne.enterpriseValidateReviewUrl).</p>
            </div>
            <div class="field hidden" id="enterpriseEndpointHint">
              <p class="hint">Set <code>tyne.enterpriseValidateReviewUrl</code> in VS Code settings to your self-hosted Tyne Validate &amp; Review URL.</p>
            </div>

            <div class="settings-subhead max-only hidden">Compliance (MAX)</div>
            <div class="field toggle-row max-only hidden" id="complianceChecksEnabledRow">
              <label for="complianceChecksEnabled">Compliance policy checks</label>
              <input type="checkbox" id="complianceChecksEnabled" />
            </div>
            <fieldset class="field max-only hidden compliance-frameworks" id="complianceFrameworksField">
              <legend>Enabled frameworks</legend>
              <div class="compliance-framework-grid">
                <label><input type="checkbox" data-compliance-framework="HIPAA" /> HIPAA</label>
                <label><input type="checkbox" data-compliance-framework="SOC2" /> SOC 2</label>
                <label><input type="checkbox" data-compliance-framework="PCI_DSS" /> PCI DSS</label>
                <label><input type="checkbox" data-compliance-framework="GDPR" /> GDPR</label>
                <label><input type="checkbox" data-compliance-framework="ISO27001" /> ISO 27001</label>
                <label><input type="checkbox" data-compliance-framework="NIST_CSF" /> NIST CSF</label>
                <label><input type="checkbox" data-compliance-framework="NIST_800_53" /> NIST 800-53</label>
                <label><input type="checkbox" data-compliance-framework="FEDRAMP" /> FedRAMP</label>
                <label><input type="checkbox" data-compliance-framework="CCPA_CPRA" /> CCPA / CPRA</label>
                <label><input type="checkbox" data-compliance-framework="SOX" /> SOX</label>
                <label><input type="checkbox" data-compliance-framework="CUSTOM" /> Custom policies</label>
              </div>
              <div class="vr-custom-policy-form max-only" id="customCompliancePolicyForm">
                <div class="label">Custom enterprise rule</div>
                <input id="customPolicyName" type="text" placeholder='Rule: "Customer emails cannot be logged"' />
                <input id="customPolicyCategory" type="text" placeholder="Category: PII Exposure" />
                <input id="customPolicyPattern" type="text" placeholder="Pattern: email|logger" />
                <select id="customPolicySeverity">
                  <option value="critical">Severity: Critical</option>
                  <option value="high">Severity: High</option>
                  <option value="medium">Severity: Medium</option>
                  <option value="low">Severity: Low</option>
                </select>
                <select id="customPolicyAction">
                  <option value="block">Action: Block</option>
                  <option value="review">Action: Review</option>
                  <option value="inform">Action: Inform</option>
                </select>
                <select id="customPolicySink">
                  <option value="log">Sink: Logs</option>
                  <option value="response">Sink: API response</option>
                  <option value="storage">Sink: Storage</option>
                </select>
                <button type="button" class="btn" id="customPolicyCreateBtn">Add policy</button>
                <ul class="vr-custom-policy-list" id="customPolicyList"></ul>
              </div>
            </fieldset>

            <div class="btn-row" style="margin-top:12px; align-items:center; gap:8px">
              <button class="btn primary" id="automationSaveSettingsBtn" type="button">Save Settings</button>
              <span class="unsaved-badge hidden" id="automationUnsaved">Unsaved changes</span>
            </div>
          </div>

          <div class="label max-only hidden" id="maxReportSettingsLabel">MAX Report Settings</div>
          <div class="card max-only hidden" id="maxReportSettingsCard">
            <p class="field-help" style="margin-top:0">Choose which sections appear in the MAX validation report posted to your PM tool.</p>
            <div class="field toggle-row">
              <label for="maxReportValidationStages">Validation stages</label>
              <input type="checkbox" id="maxReportValidationStages" data-section="validation_stages" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportRiskAssessment">Risk assessment</label>
              <input type="checkbox" id="maxReportRiskAssessment" data-section="risk_assessment" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportSecurityCheck">Security check</label>
              <input type="checkbox" id="maxReportSecurityCheck" data-section="security_check" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportCodeQuality">Code quality</label>
              <input type="checkbox" id="maxReportCodeQuality" data-section="code_quality" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportPerformanceMetrics">Performance metrics</label>
              <input type="checkbox" id="maxReportPerformanceMetrics" data-section="performance_metrics" />
            </div>
            <div class="field toggle-row">
              <label for="maxReportRecommendations">Recommendations</label>
              <input type="checkbox" id="maxReportRecommendations" data-section="recommendations" />
            </div>
            <div class="btn-row" style="margin-top:10px">
              <button class="btn primary" id="maxReportSaveSettingsBtn" type="button">Save Report Settings</button>
            </div>
          </div>
        </section>

        <!-- ===== SETTINGS (incl. Account + Integrations) ===== -->
        <section class="page" id="settingsPage">
          <div class="page-head"><span class="page-title">Settings</span></div>

          <div class="label">Account</div>
          <div class="account-card">
            <div class="name-row"><span class="name" id="accountName">Not connected</span><span class="beta-pill">BETA</span></div>
            <div class="tier-row">
              <span class="tier-cap">Plan</span>
              <img class="tier-logo t-core" src="${tier.core}" alt="Free" />
              <img class="tier-logo t-pro" src="${tier.pro}" alt="Pro" />
              <img class="tier-logo t-max" src="${tier.max}" alt="Max" />
              <span class="plan" id="accountPlan">Connect GitHub to load your plan</span>
            </div>
            <div class="plan-note hidden" id="planMaxNote">You're on the Max plan</div>
            <div class="credits hidden" id="accountCredits">Daily usage: <span id="accountCreditsVal">0</span>%</div>
          </div>
          <div class="btn-stack">
            <button class="btn primary hidden" id="upgradePlanBtn" type="button">Upgrade</button>
            <button class="btn hidden" id="manageBillingBtn" type="button">Manage billing</button>
            <button class="btn" id="signoutBtn">Log out</button>
          </div>

          <div class="label">Integrations</div>
          <div class="int-list" id="integrationsList">
            <div class="int-item" data-tool="github">
              <svg class="int-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.8c.85.01 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">GitHub</span>
                </div>
                <div class="int-desc" id="githubDesc">Account connection · draft PRs, branch push, review links</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="githubStateBtn" data-action="connect" data-provider="github">Connect</button>
                <button class="btn ghost compact hidden" id="githubDisconnectBtn" data-action="disconnect" data-tool="github">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="jira">
              <img class="int-logo" src="${logos.jira}" alt="Jira" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Jira</span>
                </div>
                <div class="int-desc" id="jiraDesc">Connect Jira to link this repository with your sprint work.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="jiraStateBtn" data-action="connect" data-provider="jira" data-github-required-id="jiraConnectGithubBtn" data-reconnect-id="jiraReconnectBtn">Connect</button>
                <button class="btn ghost compact hidden" id="jiraChangeProjectBtn" data-action="change-project" data-provider="jira">Change Project</button>
                <button class="btn ghost compact hidden" id="jiraDisconnectBtn" data-action="disconnect" data-tool="jira">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="slack">
              <img class="int-logo" src="${logos.slack}" alt="Slack" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Slack</span>
                  <span class="int-soon">Coming soon</span>
                </div>
                <div class="int-desc" id="slackDesc">Slack integration is coming soon.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact conn-badge-neutral" id="slackStateBtn" data-action="connect" data-provider="slack" disabled>Coming soon</button>
                <button class="btn ghost compact hidden" id="slackDisconnectBtn" data-action="disconnect" data-tool="slack">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="asana">
              <img class="int-logo" src="${logos.asana}" alt="Asana" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Asana</span>
                  <span class="int-soon">Coming soon</span>
                </div>
                <div class="int-desc" id="asanaDesc">Asana integration is coming soon.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact conn-badge-neutral" id="asanaStateBtn" data-action="connect" data-provider="asana" disabled>Coming soon</button>
                <button class="btn ghost compact hidden" id="asanaDisconnectBtn" data-action="disconnect" data-tool="asana">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="linear">
              <img class="int-logo" src="${logos.linear}" alt="Linear" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Linear</span>
                </div>
                <div class="int-desc" id="linearDesc">Connect Linear to link issues with your sprint work.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact primary" id="linearStateBtn" data-action="connect" data-provider="linear">Connect</button>
                <button class="btn ghost compact hidden" id="linearDisconnectBtn" data-action="disconnect" data-tool="linear">Disconnect</button>
              </div>
            </div>
            <div class="int-item" data-tool="monday">
              <img class="int-logo" src="${logos.monday}" alt="Monday" />
              <div class="int-body">
                <div class="int-title-row">
                  <span class="int-name">Monday</span>
                  <span class="int-soon">Coming soon</span>
                </div>
                <div class="int-desc" id="mondayDesc">Monday integration is coming soon.</div>
              </div>
              <div class="int-actions">
                <button class="btn compact conn-badge-neutral" id="mondayStateBtn" data-action="connect" data-provider="monday" disabled>Coming soon</button>
                <button class="btn ghost compact hidden" id="mondayDisconnectBtn" data-action="disconnect" data-tool="monday">Disconnect</button>
              </div>
            </div>
          </div>

          <div class="label">AI &amp; API</div>

          <div id="planConnectContainer" class="hidden">
            <div class="notice info">
              <div class="notice-title">Connect account</div>
              <div class="notice-copy">Tyne could not load your subscription yet. Connect GitHub to hydrate your tier.</div>
              <div class="btn-row"><button class="btn primary" id="connectGithubSettingsBtn" type="button">Connect GitHub</button></div>
            </div>
          </div>

          <div id="coreConfigContainer" class="hidden">
            <div class="notice warn">
              <div class="notice-copy">Free tier uses your own API key. <a href="#" id="upgradeFromSettingsLink">Upgrade to PRO</a> for Tyne's hosted models.</div>
            </div>
            <div class="field">
              <label>Provider</label>
              <div class="seg" id="coreProviderSeg">
                <button class="active" type="button" data-provider="claude">Claude</button>
                <button type="button" data-provider="openai">OpenAI</button>
              </div>
            </div>
            <div class="field"><label for="byokApiKey">API key</label><input type="password" id="byokApiKey" placeholder="sk-ant-… or sk-…" autocomplete="off" /></div>
            <div class="btn-row">
              <button class="btn primary" id="saveByokBtn" type="button">Save key</button>
              <button class="btn ghost compact" id="testByokBtn" type="button">Test</button>
              <button class="btn ghost compact" id="deleteByokBtn" type="button">Delete</button>
            </div>
            <div class="row-setting"><div class="ss" id="byokStatus">No key saved.</div></div>
          </div>

          <div id="premiumConfigContainer" class="hidden">
            <div class="notice good"><div class="notice-copy">Connected to Tyne hosted models.</div></div>
            <div class="row-setting">
              <div><div class="st">Override with custom key</div><div class="ss">Use your own API key (BYOK)</div></div>
              <button class="toggle" id="overrideByokToggle" type="button" aria-pressed="false"></button>
            </div>
            <div id="byokOverrideFields" class="hidden">
              <div class="field">
                <label>Provider</label>
                <div class="seg" id="premiumProviderSeg">
                  <button class="active" type="button" data-provider="claude">Claude</button>
                  <button type="button" data-provider="openai">OpenAI</button>
                </div>
              </div>
              <div class="field"><label for="byokApiKeyPremium">API key</label><input type="password" id="byokApiKeyPremium" placeholder="sk-ant-… or sk-…" autocomplete="off" /></div>
              <div class="btn-row">
                <button class="btn primary" id="saveByokBtnPremium" type="button">Save key</button>
                <button class="btn ghost compact" id="testByokBtnPremium" type="button">Test</button>
                <button class="btn ghost compact" id="deleteByokBtnPremium" type="button">Delete</button>
              </div>
              <div class="row-setting"><div class="ss" id="byokStatusPremium">No key saved.</div></div>
            </div>
          </div>

          <div class="label">Features</div>
          <div class="row-setting">
            <div><div class="st">Project Lead Mode</div><div class="ss">Prep repo, drift detection, synth commit.</div></div>
            <button class="toggle" data-toggle="projectLead" type="button" aria-pressed="false"></button>
          </div>

          <div class="label">About</div>
          <div class="about-ver">Tyne v0.1.0</div>
          <div class="about-sub">Local project lead for VS Code.</div>
        </section>

      </div>
    </div>
  </main>
</div>

<!-- Beta bug reporter: floating CTA + compact sheet (no new page/tab) -->
<button type="button" class="beta-bug-fab hidden" id="betaBugFab" title="Report a beta bug" aria-label="Report a beta bug">${ICON.bug}</button>
<div class="beta-bug-sheet hidden" id="betaBugSheet" role="dialog" aria-modal="true" aria-labelledby="betaBugTitle">
  <div class="beta-bug-sheet-scrim" id="betaBugScrim"></div>
  <div class="beta-bug-sheet-panel">
    <div class="beta-bug-sheet-head">
      <div>
        <div class="beta-bug-sheet-title" id="betaBugTitle">Report a beta issue</div>
        <div class="beta-bug-sheet-sub">Takes ~10 seconds. Context is attached automatically.</div>
      </div>
      <button type="button" class="icon-btn" id="betaBugCloseBtn" aria-label="Close">${ICON.x}</button>
    </div>
    <div class="beta-bug-kinds" role="radiogroup" aria-label="Issue type">
      <button type="button" class="beta-bug-kind active" data-kind="bug" aria-pressed="true">Broken</button>
      <button type="button" class="beta-bug-kind" data-kind="confusing" aria-pressed="false">Confusing</button>
      <button type="button" class="beta-bug-kind" data-kind="idea" aria-pressed="false">Idea</button>
    </div>
    <label class="beta-bug-label" for="betaBugMessage">What happened?</label>
    <textarea id="betaBugMessage" rows="4" maxlength="4000" placeholder="e.g. Validate stuck on partial after I fixed majors…"></textarea>
    <label class="beta-bug-label" for="betaBugEmail">Reply email <span class="req">*</span></label>
    <input type="email" id="betaBugEmail" maxlength="320" placeholder="you@company.com" autocomplete="email" />
    <div class="beta-bug-context" id="betaBugContext"></div>
    <div class="beta-bug-error hidden" id="betaBugError" role="alert"></div>
    <div class="beta-bug-actions">
      <button type="button" class="btn ghost compact" id="betaBugCancelBtn">Cancel</button>
      <button type="button" class="btn primary compact" id="betaBugSubmitBtn">Send</button>
    </div>
  </div>
</div>

<!-- ── Validation full report overlay (Max tier) ── -->
<div class="val-detail-overlay hidden" id="valDetailOverlay" role="dialog" aria-modal="true" aria-label="Validation report">
  <div class="val-detail-scrim" id="valDetailScrim"></div>
  <div class="val-detail-modal">
    <div class="val-detail-bar">
      <span class="val-detail-bar-title">Validation report</span>
      <div class="val-detail-bar-actions">
        <button class="btn ghost compact" id="valDetailCopyBtn" type="button">Copy</button>
        <button class="btn ghost compact" id="valDetailCloseBtn" type="button" aria-label="Close report">✕</button>
      </div>
    </div>
    <div class="val-detail-report" id="valDetailReport"></div>
    <div class="val-detail-foot">
      <button class="btn hidden" id="valDetailOpenCommitBtn" type="button">Open commit</button>
      <span class="val-detail-foot-spacer"></span>
      <button class="btn" id="valDetailCloseBtn2" type="button">Close</button>
      <button class="btn primary" id="valDetailRunAgainBtn" type="button">Run again</button>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="${taskInteractionsUri}"></script>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** Render a decomposed task as a plain-text Jira sub-task description. */
function buildPmSubtaskDescription(task: DecomposedTask): string {
  const lines: string[] = [];
  if (task.description) { lines.push(task.description, ''); }
  if (task.acceptanceCriteria.length) {
    lines.push('Acceptance criteria:', ...task.acceptanceCriteria.map(ac => `- ${ac}`), '');
  }
  if (task.proofPoints.length) {
    lines.push('Proof points:', ...task.proofPoints.map(p => `- ${p}`), '');
  }
  if (task.affectedFiles.length) {
    lines.push('Likely files:', ...task.affectedFiles.map(f => `- ${f}`), '');
  }
  if (task.dependencies.length) {
    lines.push(`Depends on: ${task.dependencies.join(', ')}`, '');
  }
  if (task.developerContext) { lines.push(`Developer context: ${task.developerContext}`, ''); }
  lines.push(`Estimated effort: ${task.estimatedHours}h`, '', 'Generated by Tyne story decomposition.');
  return lines.join('\n');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
