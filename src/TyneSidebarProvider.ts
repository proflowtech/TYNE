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
import { getTaskTimeSummary, formatDuration } from './timeSummaryService';
import { ManualTimeEntryInput } from './timeTypes';
import {
  AutomationContext,
} from './taskAutomationService';
import { TyneTaskAutomationSettings, TyneMaxFeedbackSection } from './automationTypes';
import { writeGateBlockFile, writeGateWarnFile, clearGateFiles } from './gitHookService';
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
import {
  hasActionableEnrichment,
  hasEnrichmentContent,
  isEnrichmentTriggerField,
} from './taskEnrichmentService';

import { TyneRankedTask } from './taskQueueRanking';
import { getByokKeyService } from './byokKeyService';
import { getValidationUsageService } from './validationUsageService';
import { getValidationHistoryService } from './validationHistoryService';
import { getCodeValidationService, CodeValidationService, normalizeTier } from './codeValidationService';
import { getValidationDisplayService } from './validationDisplayService';
import { TyneValidationResult } from './validationTypes';
import { getValidationTraceService } from './validationTraceService';
import { TyneValidateReviewResult, ReviewScope } from './validateReviewTypes';
import { renderSidebarHtml, getNonce } from './sidebar/sidebarHtml';
import { BetaBugController } from './sidebar/betaBugController';
import { ComplianceExportController } from './sidebar/complianceExportController';
import { TimeAnalyticsController } from './sidebar/timeAnalyticsController';
import { SettingsByokController } from './sidebar/settingsByokController';
import { FindingFixController } from './sidebar/findingFixController';
import { StoryDecompositionController } from './sidebar/storyDecompositionController';
import { ValidateReviewController } from './sidebar/validateReviewController';
import { AutomationController } from './sidebar/automationController';
import { PmIntelligenceController } from './sidebar/pmIntelligenceController';
import { PmToolsController } from './sidebar/pmToolsController';
type TyneReviewMode = 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr';
type TyneCodeReviewResult = Record<string, unknown>;
import { openFindingInEditor, clearReviewDiagnostics } from './reviewDiagnosticsService';
import { getQualityGateService } from './qualityGateService';
import { getJiraIntegrationSnapshot } from './jiraProvider';
import { getAdapter } from './taskProviderRegistry';
import {
  initRealTimeSync,
  startActiveTaskSync,
  stopActiveTaskSync,
} from './realTimeSyncService';
import {
  listCachedTasksSync,
  getCachedTaskDetailsSync,
} from './taskCacheService';
import {
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
  private _userProfile: { tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string; isBanned?: boolean } = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '', isBanned: false };
  private _lastCommitSessions: TyneCommitSession[] = [];
  private _analyticsTaskId: string | undefined;
  private _profileFetchedAt = 0;
  private _billingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private _deviceAuthFlow: DeviceAuthFlowHandle | undefined;
  private _deviceAuthFocusDisposable: vscode.Disposable | undefined;
  private _githubSessionInvalid = false;
  private readonly _validationService: CodeValidationService;
  private readonly _byokKeyService: ReturnType<typeof getByokKeyService>;
  private readonly _usageService: ReturnType<typeof getValidationUsageService>;
  private readonly _historyService: ReturnType<typeof getValidationHistoryService>;
  private readonly _displayService: ReturnType<typeof getValidationDisplayService>;
  private readonly _traceService: ReturnType<typeof getValidationTraceService>;
  private readonly _betaBug: BetaBugController;
  private readonly _complianceExport: ComplianceExportController;
  private readonly _timeAnalytics: TimeAnalyticsController;
  private readonly _settingsByok: SettingsByokController;
  private readonly _findingFix: FindingFixController;
  private readonly _storyDecomposition: StoryDecompositionController;
  private readonly _validateReview: ValidateReviewController;
  private readonly _automation: AutomationController;
  private readonly _pmIntelligence: PmIntelligenceController;
  private readonly _pmTools: PmToolsController;

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
    const self = this;
    this._betaBug = new BetaBugController({
      get context() { return self._context; },
      get state() { return self._state; },
      get userProfile() { return self._userProfile; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
    });
    this._complianceExport = new ComplianceExportController({
      get context() { return self._context; },
      get userProfile() { return self._userProfile; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      getRepositoryPath: () => self._getRepositoryPath(),
    });
    this._timeAnalytics = new TimeAnalyticsController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      hasWebview: () => Boolean(self._view),
      get analyticsTaskId() { return self._analyticsTaskId; },
      set analyticsTaskId(value) { self._analyticsTaskId = value; },
      get lastCommitSessions() { return self._lastCommitSessions; },
      getRepositoryPath: () => self._getRepositoryPath(),
      updateStatusBar: () => self._updateStatusBar(),
      get usageService() { return self._usageService; },
    });
    this._settingsByok = new SettingsByokController({
      get context() { return self._context; },
      get state() { return self._state; },
      get userProfile() { return self._userProfile; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get byokKeyService() { return self._byokKeyService; },
      get usageService() { return self._usageService; },
      get displayService() { return self._displayService; },
      agentDebugLog: (payload) => self._agentDebugLog(payload),
      isProjectLeadMode: () => self._isProjectLeadMode(),
      startProjectLeadWatcher: () => self._startProjectLeadWatcher(),
      buildPmIntegrationSnapshot: (jira) => self._buildPmIntegrationSnapshot(jira),
    });
    this._findingFix = new FindingFixController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get actionLog() { return self._actionLog; },
    });
    this._storyDecomposition = new StoryDecompositionController({
      get context() { return self._context; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get userProfile() { return self._userProfile; },
      findCachedTask: (taskId) => self._findCachedTask(taskId),
      resolvePmTaskRequest: (taskId, source) => self._resolvePmTaskRequest(taskId, source),
      storePmIntelligence: (taskId, intelligence) => self._storePmIntelligence(taskId, intelligence),
      postThreadCreateTasksVisibility: (taskId) => self._postThreadCreateTasksVisibility(taskId),
      refreshTasksContext: (postMessage) => self._refreshTasksContext(postMessage),
      startThreadFromTask: (taskId, title, tool, url) => self._handleStartThreadFromTask(taskId, title, tool, url),
      logJira: (message) => self._logJira(message),
      jiraKeyFromTaskId: (taskId) => self._jiraKeyFromTaskId(taskId),
    });
    this._validateReview = new ValidateReviewController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get userProfile() { return self._userProfile; },
      get isAuthenticated() { return self._isAuthenticated; },
      set isAuthenticated(value) { self._isAuthenticated = value; },
      get byokKeyService() { return self._byokKeyService; },
      get usageService() { return self._usageService; },
      get historyService() { return self._historyService; },
      get displayService() { return self._displayService; },
      get traceService() { return self._traceService; },
      get validationService() { return self._validationService; },
      postSettings: () => self._postSettings(),
      postState: () => self._postState(),
      setBusy: (kind, on) => self._setBusy(kind, on),
      logLinear: (message) => self._logLinear(message),
      getRepositoryId: () => self._getRepositoryId(),
      buildAutomationCtx: () => self._buildAutomationCtx(),
      refreshTasksContext: (postMessage) => self._refreshTasksContext(postMessage),
    });
    this._automation = new AutomationController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      hasWebview: () => Boolean(self._view),
      get userProfile() { return self._userProfile; },
      getRepositoryPath: () => self._getRepositoryPath(),
      pmTaskLabel: (taskId) => self._pmTaskLabel(taskId),
      refreshTasksContext: (postMessage) => self._refreshTasksContext(postMessage),
    });
    this._pmIntelligence = new PmIntelligenceController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get userProfile() { return self._userProfile; },
      findCachedTask: (taskId) => self._findCachedTask(taskId),
      taskShellForId: (taskId) => self._taskShellForId(taskId),
      postThreadCreateTasksVisibility: (taskId) => self._postThreadCreateTasksVisibility(taskId),
      logJira: (message) => self._logJira(message),
    });
    this._pmTools = new PmToolsController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      hasWebview: () => Boolean(self._view),
      get userProfile() { return self._userProfile; },
      get jiraLog() { return self._jiraLog; },
      postSettings: () => self._postSettings(),
      isGithubConnected: () => self._isGithubConnected(),
      logJira: (message) => self._logJira(message),
      logLinear: (message) => self._logLinear(message),
      agentDebugLog: (payload) => self._agentDebugLog(payload),
      getStoredPmIntelligence: (taskId) => self._getStoredPmIntelligence(taskId),
      ensurePmIntelligencePosted: (taskId, fromDetails) => self._ensurePmIntelligencePosted(taskId, fromDetails),
      postStoredDecompositionIfAny: (taskId) => self._postStoredDecompositionIfAny(taskId),
      runEnrichmentForActiveThreadTask: (reason) => self._runEnrichmentForActiveThreadTask(reason),
    });
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
        case 'settingChange': await this._settingsByok.handleSettingChange(msg.key as string, msg.value); break;
        case 'saveJiraSettings': await this._settingsByok.saveJiraSettings(msg); break;
        case 'connectJira':
          await this._settingsByok.saveJiraSettings(msg);
          await this._handleConnectPmTool('jira');
          break;
        case 'changeJiraProject':
          this.changeJiraProject();
          break;
        case 'saveByokKey': await this._settingsByok.saveByokKey(msg.apiKey as string, msg.provider as string); break;
        case 'deleteByokKey': await this._settingsByok.deleteByokKey(); break;
        case 'testByokKey': await this._settingsByok.testByokKey(msg.provider as string); break;
        case 'getValidationHistory': await this._handleValidationHistoryRequest(msg.filters); break;
        case 'getValidationTrends': await this._handleValidationTrendsRequest(); break;
        case 'getReviewTrends': await this._handleReviewTrendsRequest(); break;
        case 'exportValidationHistory': await this._handleExportValidationHistory(msg.format as 'csv' | 'json', msg.filters); break;
        case 'exportComplianceEvidence': await this._complianceExport.exportComplianceEvidence(msg.format as string, msg.report as Record<string, unknown>); break;
        case 'exportValidateReviewPdf': await this._complianceExport.exportValidateReviewPdf(msg.report as Record<string, unknown>); break;
        case 'complianceFindingWorkflow': await this._complianceExport.handleFindingWorkflow(msg as Record<string, unknown>); break;
        case 'listCustomCompliancePolicies': await this._complianceExport.listCustomPolicies(); break;
        case 'createCustomCompliancePolicy': await this._complianceExport.createCustomPolicy(msg.policy as Record<string, unknown>); break;
        case 'deleteCustomCompliancePolicy': await this._complianceExport.deleteCustomPolicy(msg.id as string); break;
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
        case 'storyDecomposeAnalyze': await this._storyDecomposition.analyze(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'storyDecomposeGenerate': await this._storyDecomposition.generate(msg.taskId as string, msg.answers as Record<string, string>); break;
        case 'storyDecomposeCreate': await this._storyDecomposition.create(msg.taskId as string, msg.tasks as unknown, msg.createInJira === true, msg.dueDate); break;
        case 'storyDecomposeCancel': this._storyDecomposition.cancel(msg.taskId as string); break;
        case 'storyDecomposeStartTask': await this._storyDecomposition.startTask(msg.parentTaskId as string, msg.pmKey as string | undefined, msg.title as string); break;
        case 'storyDecomposeRegenerate': await this._storyDecomposition.regenerate(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'getGitStatus': await this._refreshGitStatus(); break;
        case 'runCodeReview': await this._handleRunCodeReview(msg.mode as TyneReviewMode); break;
        case 'runValidateReview': await this._handleRunValidateReview(msg.scope as string | undefined, msg.selectedCommitSha as string | undefined); break;
        case 'loadValidateReviewReports': await this._postValidateReviewReports(); break;
        case 'submitBetaBug': await this._betaBug.submit(msg); break;
        case 'findingFeedback': await this._handleFindingFeedback(msg.feedback as Record<string, unknown>); break;
        case 'createTaskFromFinding': await this._handleCreateTaskFromFinding(msg.finding as Record<string, unknown>); break;
        case 'fixPendingGoal': await this._handleFixPendingGoal(msg.goal as Record<string, unknown>); break;
        case 'pendingGoalFeedback': await this._handlePendingGoalFeedback(msg.goal as Record<string, unknown>); break;
        case 'previewFix': await this._findingFix.previewFix(msg.finding as Record<string, unknown>); break;
        case 'applyFix': await this._findingFix.applyFix(msg.finding as Record<string, unknown>); break;
        case 'undoFix': await this._findingFix.undoFix(msg.finding as Record<string, unknown>); break;
        case 'agentFix': await this._findingFix.agentFix(msg.finding as Record<string, unknown>); break;
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
        case 'addManualTime': await this._timeAnalytics.addManualTime(msg.entry as ManualTimeEntryInput); break;
        case 'editManualTime': await this._timeAnalytics.editManualTime(msg.id as string, msg.entry as Partial<ManualTimeEntryInput>); break;
        case 'deleteManualTime': await this._timeAnalytics.deleteManualTime(msg.id as string); break;
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
    this._pmTools.postThreadCreateTasksVisibility(taskId);
  }


  /** Resolve cache by unified id, external key, or bare key (jira:TYNE-1 / TYNE-1). */
  private _findCachedTask(taskId: string): ReturnType<typeof listCachedTasksSync>[number] | undefined {
    return this._pmTools.findCachedTask(taskId);
  }

  private _getStoredPmIntelligence(taskId: string): TynePmTaskIntelligence | null {
    return this._pmIntelligence.getStoredPmIntelligence(taskId);
  }

  private _briefReadyTaskIds(tasks: TyneTask[]): string[] {
    return this._pmTools.briefReadyTaskIds(tasks);
  }

  private _rankTasksForView(filtered: TyneTask[], sortKey?: string): TyneRankedTask[] {
    return this._pmTools.rankTasksForView(filtered, sortKey);
  }

  private async _storePmIntelligence(taskId: string, intelligence: TynePmTaskIntelligence): Promise<void> {
    return this._pmIntelligence.storePmIntelligence(taskId, intelligence);
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
    return this._settingsByok.getParkedIdeas();
  }

  private async _setParkedIdeas(ideas: string[]): Promise<void> {
    return this._settingsByok.setParkedIdeas(ideas);
  }

  private _getAiAccessMode(): 'byok' | 'max' {
    return this._settingsByok.getAiAccessMode();
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
    return this._pmTools.postIntegrationState();
  }


  private async _postSettings(): Promise<void> {
    return this._settingsByok.postSettings();
  }
  private async _buildPmIntegrationSnapshot(
    jiraIntegration?: Awaited<ReturnType<typeof getJiraIntegrationSnapshot>>,
  ): Promise<TynePmIntegrationSnapshot> {
    return this._pmTools.buildPmIntegrationSnapshot(jiraIntegration);
  }

  private _getVisibleCachedTasks(): TyneTask[] {
    return this._pmTools.getVisibleCachedTasks();
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
    return this._settingsByok.handleSettingChange(key, value);
  }

  private async _handleSaveJiraSettings(msg: { assignedToMe?: boolean }): Promise<void> {
    return this._settingsByok.saveJiraSettings(msg);
  }

  private async _handleSaveByokKey(apiKey: string, provider: string): Promise<void> {
    return this._settingsByok.saveByokKey(apiKey, provider);
  }

  private async _handleDeleteByokKey(): Promise<void> {
    return this._settingsByok.deleteByokKey();
  }

  private async _handleTestByokKey(provider: string): Promise<void> {
    return this._settingsByok.testByokKey(provider);
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
  private _markProofPointsMet(result: TyneValidationResult): void {
    this._validateReview.markProofPointsMet(result);
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
    this._pmIntelligence.scheduleEnrichmentFromThreadEdit();
  }

  private async _runEnrichmentForActiveThreadTask(reason: string): Promise<void> {
    return this._pmIntelligence.runEnrichmentForActiveThreadTask(reason);
  }

  private _postEnrichmentToWebview(taskId: string): void {
    this._pmIntelligence.postEnrichmentToWebview(taskId);
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
    this._validateReview.postValidationRunning(tier);
  }

  private _mapResultToStages(result: TyneValidationResult, tier: string): Array<{ stage: number; name: string; status: 'completed' | 'failed'; details?: string }> {
    return this._validateReview.mapResultToStages(result, tier);
  }

  private async _validateGoal(): Promise<void> {
    return this._validateReview.validateGoal();
  }

  private _mapPmValidationToTyneValidation(pm: TynePmTaskValidationResult): TyneValidationResult {
    return this._validateReview.mapPmValidationToTyneValidation(pm);
  }

  private async _postValidationHistory(): Promise<void> {
    return this._validateReview.postValidationHistory();
  }

  private async _handleValidationHistoryRequest(filters?: unknown): Promise<void> {
    return this._validateReview.handleValidationHistoryRequest(filters);
  }

  private async _handleValidationTrendsRequest(): Promise<void> {
    return this._validateReview.handleValidationTrendsRequest();
  }

  private async _handleReviewTrendsRequest(): Promise<void> {
    return this._validateReview.handleReviewTrendsRequest();
  }

  private async _handleExportValidationHistory(format: 'csv' | 'json', filters?: unknown): Promise<void> {
    return this._validateReview.handleExportValidationHistory(format, filters);
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
    return this._automation.runTieKnotAutomation(branchName, taskId, validationResult, pushed);
  }

  private async _markCachedTaskDone(taskId: string): Promise<void> {
    return this._automation.markCachedTaskDone(taskId);
  }

  private async _refreshAutomationContext(postMessage: boolean): Promise<void> {
    return this._automation.refreshAutomationContext(postMessage);
  }

  private async _handleMarkTaskDone(): Promise<void> {
    return this._automation.handleMarkTaskDone();
  }

  private async _handlePostFeedback(bodyOverride?: string): Promise<void> {
    return this._automation.handlePostFeedback(bodyOverride);
  }

  private async _handleCompleteAndFeedback(bodyOverride?: string): Promise<void> {
    return this._automation.handleCompleteAndFeedback(bodyOverride);
  }

  private async _handleCompletionEvent(ev: import('./automationTypes').TyneAutomationEvent, autoTriggered = false): Promise<void> {
    return this._automation.handleCompletionEvent(ev, autoTriggered);
  }

  private async _promptForJiraTransition(
    transitions: Array<{ id: string; name: string; toStatus?: string }>,
    autoTriggered: boolean,
  ): Promise<void> {
    return this._automation.promptForJiraTransition(transitions, autoTriggered);
  }

  private async _handlePreviewFeedback(): Promise<void> {
    return this._automation.handlePreviewFeedback();
  }

  private async _handleSaveAutomationSettings(settings: TyneTaskAutomationSettings): Promise<void> {
    return this._automation.handleSaveAutomationSettings(settings);
  }

  private async _handleSaveMaxReportSettings(sections: TyneMaxFeedbackSection[]): Promise<void> {
    return this._automation.handleSaveMaxReportSettings(sections);
  }

  private async _handleReinstallCommitHook(): Promise<void> {
    return this._automation.handleReinstallCommitHook();
  }

  private _buildAutomationCtx(): AutomationContext | null {
    return this._automation.buildAutomationCtx();
  }


  // ── Task Management Methods ────────────────────────────────────────────────
  private async _refreshTasksContext(postMessage: boolean): Promise<void> {
    return this._pmTools.refreshTasksContext(postMessage);
  }

  private async _maybeRefreshStaleJiraTasks(
    syncSummary: { syncStates?: Array<{ sourceTool: string; syncStatus: string; lastSyncedAt?: string }> },
    jiraConnected: boolean,
  ): Promise<void> {
    return this._pmTools.maybeRefreshStaleJiraTasks(syncSummary, jiraConnected);
  }

  private async _handlePullTasks(tool?: TynePmTool): Promise<void> {
    return this._pmTools.pullTasks(tool);
  }


  private async _isGithubConnected(): Promise<boolean> {
    // Any Tyne session that can authorize PM OAuth (GitHub PAT or device-auth JWT).
    return Boolean(await getEffectiveAuthToken(this._context));
  }

  private _logJira(message: string): void {
    this._jiraLog.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private _logLinear(message: string): void {
    this._jiraLog.appendLine(`[${new Date().toISOString()}] [Linear] ${message}`);
  }
  private _jiraKeyFromTaskId(taskId: string): string {
    return this._pmTools.jiraKeyFromTaskId(taskId);
  }

  private _pmTaskLabel(taskId: string): string {
    return this._pmTools.pmTaskLabel(taskId);
  }

  private _jiraKeyFromUrl(url: string): string {
    return this._pmTools.jiraKeyFromUrl(url);
  }

  private _classifyJiraConnectError(message: string): string {
    return this._pmTools.classifyJiraConnectError(message);
  }

  private _classifyLinearConnectError(message: string): string {
    return this._pmTools.classifyLinearConnectError(message);
  }

  private async _handleConnectPmTool(tool: TynePmTool): Promise<void> {
    return this._pmTools.connectPmTool(tool);
  }

  private async _handleDisconnectPmTool(tool: TynePmTool): Promise<void> {
    return this._pmTools.disconnectPmTool(tool);
  }

  private async _handleRunCodeReview(mode: TyneReviewMode): Promise<void> {
    return this._validateReview.runCodeReview(mode);
  }

  private async _handleRunValidateReview(scope?: string, selectedCommitSha?: string): Promise<void> {
    return this._validateReview.runValidateReview(scope, selectedCommitSha);
  }

  private async _handleFindingFeedback(feedback: Record<string, unknown>): Promise<void> {
    return this._validateReview.handleFindingFeedback(feedback);
  }

  private async _handleCreateTaskFromFinding(finding: Record<string, unknown>): Promise<void> {
    return this._validateReview.createTaskFromFinding(finding);
  }

  private async _handleFixPendingGoal(goal: Record<string, unknown>): Promise<void> {
    return this._validateReview.fixPendingGoal(goal);
  }

  private async _handlePendingGoalFeedback(goal: Record<string, unknown>): Promise<void> {
    return this._validateReview.pendingGoalFeedback(goal);
  }

  private async _prepareWorkspaceForReview(scope?: ReviewScope): Promise<void> {
    return this._validateReview.prepareWorkspaceForReview(scope);
  }

  private _mapValidateReviewToTyneValidation(result: TyneValidateReviewResult): TyneValidationResult {
    return this._validateReview.mapValidateReviewToTyneValidation(result);
  }

  private async _postValidateReviewReports(): Promise<void> {
    return this._validateReview.postValidateReviewReports();
  }
  private async _handleOpenTaskDetail(taskId: string, tool: TynePmTool): Promise<void> {
    return this._pmTools.openTaskDetail(taskId, tool);
  }


  /** Post cached PM intelligence, or extract when proof points / subtasks are missing. */
  private async _ensurePmIntelligencePosted(
    taskId: string,
    fromDetails?: TynePmTaskIntelligence | null,
  ): Promise<void> {
    return this._pmIntelligence.ensurePmIntelligencePosted(taskId, fromDetails);
  }

  private async _fetchAndPostPmTaskIntelligence(taskId: string, forceRefresh: boolean): Promise<void> {
    return this._pmIntelligence.fetchAndPostPmTaskIntelligence(taskId, forceRefresh);
  }

  private async _resolvePmTaskRequest(
    taskId: string,
    tool: 'jira' | 'linear',
  ): Promise<{ source: 'jira' | 'linear'; issueId: string; issueIdentifier: string; cloudId?: string; linearWorkspaceId?: string } | null> {
    return this._pmIntelligence.resolvePmTaskRequest(taskId, tool);
  }

  private _handleQueryTasks(query: string, filters: TyneTaskFilters, sort: TyneTaskSort): void {
    this._pmTools.handleQueryTasks(query, filters, sort);
  }

  private _postPmEnrichmentLoading(taskId: string, title?: string): void {
    this._pmIntelligence.postPmEnrichmentLoading(taskId, title);
  }

  private _postPmEnrichmentDone(): void {
    this._pmIntelligence.postPmEnrichmentDone();
  }

  private async _extractIntelligenceForStartThread(
    taskId: string,
    tool: TynePmTool,
    title?: string,
    issueType?: string,
  ): Promise<{ intelligence: TynePmTaskIntelligence | null; error?: string }> {
    return this._pmIntelligence.extractIntelligenceForStartThread(taskId, tool, title, issueType);
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
    return this._pmIntelligence.handleRetryPmEnrichment();
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

  // ── Story decomposition (delegated) ───────────────────────────────────────

  private _postStoredDecompositionIfAny(taskId: string): void {
    this._storyDecomposition.postStoredDecompositionIfAny(taskId);
  }

  // ── Pro/Max: Advanced query ────────────────────────────────────────────────
  private _handleQueryTasksAdvanced(
    query: string,
    filters: TyneAdvancedTaskFilters,
    sort: TyneAdvancedTaskSort,
  ): void {
    this._pmTools.queryTasksAdvanced(query, filters, sort);
  }


  // ── Pro/Max: Filter presets ────────────────────────────────────────────────
  private _handleListPresets(): void {
    this._pmTools.listPresets();
  }

  private async _handleSavePreset(msg: unknown): Promise<void> {
    return this._pmTools.handleSavePreset(msg);
  }

  private async _handleRenamePreset(id: string, name: string): Promise<void> {
    return this._pmTools.handleRenamePreset(id, name);
  }

  private async _handleDeletePreset(id: string): Promise<void> {
    return this._pmTools.handleDeletePreset(id);
  }

  private async _handleSetDefaultPreset(id: string): Promise<void> {
    return this._pmTools.handleSetDefaultPreset(id);
  }

  private _handleApplyPreset(id: string): void {
    this._pmTools.applyPreset(id);
  }


  // ── Pro/Max: Writable task actions ─────────────────────────────────────────
  private async _handleCreateTask(input: TyneCreateTaskInput): Promise<void> {
    return this._pmTools.createTask(input);
  }

  private async _handleUpdateTask(taskId: string, sourceTool: TynePmTool, input: TyneUpdateTaskInput): Promise<void> {
    return this._pmTools.updateTask(taskId, sourceTool, input);
  }

  private async _handleAddSubtask(
    taskId: string, sourceTool: TynePmTool,
    input: { title: string; assigneeId?: string; dueDate?: string },
  ): Promise<void> {
    return this._pmTools.addSubtask(taskId, sourceTool, input);
  }

  private async _handleAddComment(taskId: string, sourceTool: TynePmTool, body: string): Promise<void> {
    return this._pmTools.addComment(taskId, sourceTool, body);
  }

  private async _handleCheckCapabilities(tool: TynePmTool): Promise<void> {
    return this._pmTools.checkCapabilities(tool);
  }

  private async _handleDetectConflict(taskId: string, tool: TynePmTool): Promise<void> {
    return this._pmTools.detectConflict(taskId, tool);
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
    return this._timeAnalytics.refreshTimeContext(postMessage);
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
    const logoUri = asset('tyne-icon.png');
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
