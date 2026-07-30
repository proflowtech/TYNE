import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TyneState, getState, saveState } from './stateManager';
import {
  getEffectiveAuthToken,
} from './deviceAuth';
import { getJiraOutputChannel } from './jiraLog';
import { DriftEvent, startDriftDetection } from './driftDetector';
import {
  BranchRecord,
  getBranchByTaskId,
} from './branchMetadataService';
import { TyneCommitRecord, TyneCommitSession } from './commitTypes';
import { getTaskTimeSummary, formatDuration } from './timeSummaryService';
import { ManualTimeEntryInput } from './timeTypes';
import {
  AutomationContext,
} from './taskAutomationService';
import { TyneTaskAutomationSettings, TyneMaxFeedbackSection } from './automationTypes';
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
import { GitContextController } from './sidebar/gitContextController';
import { ThreadWorkflowController } from './sidebar/threadWorkflowController';
import { AuthSessionController } from './sidebar/authSessionController';
import { BillingController } from './sidebar/billingController';
type TyneReviewMode = 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr';
type TyneCodeReviewResult = Record<string, unknown>;
import { openFindingInEditor, clearReviewDiagnostics } from './reviewDiagnosticsService';
import { getJiraIntegrationSnapshot } from './jiraProvider';
import { getAdapter } from './taskProviderRegistry';
import {
  initRealTimeSync,
  startActiveTaskSync,
  stopActiveTaskSync,
} from './realTimeSyncService';
import {
  listCachedTasksSync,
} from './taskCacheService';
import {
  TynePmIntegrationSnapshot,
} from './taskViewModel';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';

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
  private _userProfile: { tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string; isBanned?: boolean } = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '', isBanned: false };
  private _lastCommitSessions: TyneCommitSession[] = [];
  private _analyticsTaskId: string | undefined;
  private _profileFetchedAt = 0;
  private _billingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
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
  private readonly _gitContext: GitContextController;
  private readonly _threadWorkflow: ThreadWorkflowController;
  private readonly _authSession: AuthSessionController;
  private readonly _billing: BillingController;

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
    this._gitContext = new GitContextController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      hasWebview: () => Boolean(self._view),
      get userProfile() { return self._userProfile; },
      getRepositoryPath: () => self._getRepositoryPath(),
      updateStatusBar: (activeRecord, currentBranchName, commitSummary) => self._updateStatusBar(activeRecord, currentBranchName, commitSummary as CommitSummary | undefined),
      debouncedSave: () => self._debouncedSave(),
      logJira: (message) => self._logJira(message),
      get lastCommitSessions() { return self._lastCommitSessions; },
      set lastCommitSessions(value) { self._lastCommitSessions = value; },
      getParkedIdeas: () => self._getParkedIdeas(),
      setParkedIdeas: (ideas) => self._setParkedIdeas(ideas),
      refreshTimeContext: (postMessage) => self._refreshTimeContext(postMessage),
      refreshAutomationContext: (postMessage) => self._refreshAutomationContext(postMessage),
      refreshTasksContext: (postMessage) => self._refreshTasksContext(postMessage),
    });
    this._threadWorkflow = new ThreadWorkflowController({
      get context() { return self._context; },
      get state() { return self._state; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get userProfile() { return self._userProfile; },
      get byokKeyService() { return self._byokKeyService; },
      getRepositoryPath: () => self._getRepositoryPath(),
      setRunner: (on) => self._setRunner(on),
      setBusy: (kind, on) => self._setBusy(kind, on),
      logJira: (message) => self._logJira(message),
      logLinear: (message) => self._logLinear(message),
      isProjectLeadMode: () => self._isProjectLeadMode(),
      startProjectLeadWatcher: () => self._startProjectLeadWatcher(),
      switchToBranch: (branchName) => self._switchToBranch(branchName),
      refreshBranchContext: (postMessage) => self._refreshBranchContext(postMessage),
      refreshCommitContext: (postMessage, maxCommits) => self._refreshCommitContext(postMessage, maxCommits),
      refreshGitStatus: () => self._refreshGitStatus(),
      evaluateQualityGate: (gateType) => self._evaluateQualityGate(gateType),
      runTieKnotAutomation: (branch, taskId, validation, pushed) => self._runTieKnotAutomation(branch, taskId, validation, pushed),
      postThreadCreateTasksVisibility: (taskId) => self._postThreadCreateTasksVisibility(taskId),
      getStoredPmIntelligence: (taskId) => self._getStoredPmIntelligence(taskId),
      extractIntelligenceForStartThread: (taskId, tool, title, issueType) => self._extractIntelligenceForStartThread(taskId, tool, title, issueType),
      postEnrichmentToWebview: (taskId) => self._postEnrichmentToWebview(taskId),
      findCachedTask: (taskId) => self._findCachedTask(taskId),
    });
    this._authSession = new AuthSessionController({
      get context() { return self._context; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get isAuthenticated() { return self._isAuthenticated; },
      set isAuthenticated(value) { self._isAuthenticated = value; },
      get userProfile() { return self._userProfile; },
      set userProfile(value) { self._userProfile = value; },
      get profileFetchedAt() { return self._profileFetchedAt; },
      set profileFetchedAt(value) { self._profileFetchedAt = value; },
      get githubSessionInvalid() { return self._githubSessionInvalid; },
      set githubSessionInvalid(value) { self._githubSessionInvalid = value; },
      postAuthState: () => self._postAuthState(),
      postState: () => self._postState(),
      updateAuthenticationState: (isAuthenticated) => self.updateAuthenticationState(isAuthenticated),
      updateProfile: (force) => self._updateProfile(force),
      postSettings: () => self._postSettings(),
      refreshTasksContext: (postMessage) => self._refreshTasksContext(postMessage),
      isGithubConnected: () => self._isGithubConnected(),
    });
    this._billing = new BillingController({
      get context() { return self._context; },
      postMessage: (message) => { self._view?.webview.postMessage(message); },
      get userProfile() { return self._userProfile; },
      set userProfile(value) { self._userProfile = value; },
      get profileFetchedAt() { return self._profileFetchedAt; },
      set profileFetchedAt(value) { self._profileFetchedAt = value; },
      get billingRefreshTimer() { return self._billingRefreshTimer; },
      set billingRefreshTimer(value) { self._billingRefreshTimer = value; },
      get isAuthenticated() { return self._isAuthenticated; },
      get githubSessionInvalid() { return self._githubSessionInvalid; },
      set githubSessionInvalid(value) { self._githubSessionInvalid = value; },
      getSupabaseUrl: () => self._getSupabaseUrl(),
      postSettings: () => self._postSettings(),
      updateAuthenticationState: (isAuthenticated) => self.updateAuthenticationState(isAuthenticated),
      handleInvalidGitHubToken: (source) => self._handleInvalidGitHubToken(source),
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
    return this._authSession.continueWithGitHub();
  }

  /** Dogfood device-auth path (live by default). Does not use githubOAuth / tyne_github_token. */
  private async _continueWithDeviceAuth(): Promise<void> {
    return this._authSession.continueWithDeviceAuth();
  }

  private _cancelDeviceAuth(reason: string): void {
    this._authSession.cancelDeviceAuth(reason);
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
    return this._authSession.logout();
  }

  // Called when a Tyne backend call rejects the saved GitHub token. Clears the
  // stale session, marks GitHub disconnected, and surfaces a clear reconnect path
  // instead of silently failing profile/usage/validation loads.
  private async _handleInvalidGitHubToken(source: string): Promise<void> {
    return this._authSession.handleInvalidGitHubToken(source);
  }

  public reconnectGitHub(): void {
    void this._reconnectGitHub();
  }

  private async _reconnectGitHub(): Promise<void> {
    return this._authSession.reconnectGitHub();
  }

  private _isProjectLeadMode(): boolean {
    return vscode.workspace.getConfiguration('tyne').get<boolean>('projectLeadMode', false);
  }

  private async _updateProfile(force = false): Promise<void> {
    return this._billing.updateProfile(force);
  }

  private async _handleBillingCheckout(plan: string): Promise<void> {
    return this._billing.handleBillingCheckout(plan);
  }

  private _startBillingProfileRefresh(previousTier: string): void {
    this._billing.startBillingProfileRefresh(previousTier);
  }

  private async _fetchUserProfile(): Promise<{ tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string; isBanned?: boolean }> {
    return this._billing.fetchUserProfile();
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
    return this._gitContext.refreshBranchContext(postMessage);
  }

  private async _refreshGitStatus(): Promise<void> {
    return this._gitContext.refreshGitStatus();
  }

  private _buildCommitSummary(commits: TyneCommitRecord[], sessions: TyneCommitSession[]): CommitSummary {
    return this._gitContext.buildCommitSummary(commits, sessions);
  }

  private async _refreshCommitContext(postMessage: boolean, maxCommits = 20): Promise<void> {
    return this._gitContext.refreshCommitContext(postMessage, maxCommits);
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
    this._threadWorkflow.clearValidationForNewTask();
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
    return this._threadWorkflow.startThread();
  }
  private async _switchToBranch(branchName: string): Promise<void> {
    return this._gitContext.switchToBranch(branchName);
  }

  private async _deleteBranch(branchName: string): Promise<void> {
    return this._gitContext.deleteBranch(branchName);
  }


  private _startProjectLeadWatcher(): void {
    if (!this._isProjectLeadMode() || this._state.status !== 'weaving') { return; }
    startDriftDetection(this._state.goal, this._state.taskId, event => { this._handleDriftDetected(event); });
  }
  private _handleDriftDetected(event: DriftEvent): void {
    this._gitContext.handleDriftDetected(event);
  }

  private async _handleDriftAction(file: string, action: string): Promise<void> {
    return this._gitContext.handleDriftAction(file, action);
  }

  private async _evaluateQualityGate(gateType: 'pre_commit' | 'pre_push') {
    return this._gitContext.evaluateQualityGate(gateType);
  }


  private async _saveStitch(): Promise<void> {
    return this._threadWorkflow.saveStitch();
  }

  private async _undoStitch(): Promise<void> {
    return this._threadWorkflow.undoStitch();
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
    return this._threadWorkflow.overrideProceed();
  }

  private async _tieTheKnot(): Promise<void> {
    return this._threadWorkflow.tieTheKnot();
  }

  private async _resolveCommitMessage(): Promise<{ subject: string; body: string }> {
    return this._threadWorkflow.resolveCommitMessage();
  }

  private async _generateCommitPreview(): Promise<void> {
    return this._threadWorkflow.generateCommitPreview();
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
    return this._threadWorkflow.loadTaskIntoThread(taskId, title, tool, url);
  }
  private async _handleRetryPmEnrichment(): Promise<void> {
    return this._pmIntelligence.handleRetryPmEnrichment();
  }


  // Clicking a task in the list: load it into the thread page (no branch yet).
  // Title/url are resolved from the cached task so the card only needs id + tool.
  private async _handleSelectTaskIntoThread(taskId: string, tool: TynePmTool): Promise<void> {
    return this._threadWorkflow.selectTaskIntoThread(taskId, tool);
  }

  // Switching tasks while weaving: ask the user whether to switch to the new
  // task's existing branch, start a new thread for it, or keep the current branch.
  private async _handleSwitchTaskInThread(taskId: string, tool: TynePmTool): Promise<void> {
    return this._threadWorkflow.switchTaskInThread(taskId, tool);
  }

  private async _handleStartThreadFromTask(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    return this._threadWorkflow.startThreadFromTask(taskId, title, tool, url);
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
    return this._threadWorkflow.maybeCreateDraftPR(thread);
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
