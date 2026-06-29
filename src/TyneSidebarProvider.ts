import * as vscode from 'vscode';
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
import { getJiraOutputChannel } from './jiraLog';
import { isInvalidGitHubTokenResponse, logGitHub } from './githubAuth';
import { prepareWorkspace } from './workspacePrep';
import { DriftEvent, startDriftDetection, stopDriftDetection } from './driftDetector';
import { synthesizeCommitMessage } from './commitSynthesizer';
import { closePMTicket, fetchPMTasksForStandup } from './pmIntegration';
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
import { createManualTimeEntry, updateManualTimeEntry, deleteManualTimeEntry, listManualTimeEntriesForTask } from './manualTimeEntryService';
import { getTaskTimeSummary, getBranchTimeSummary, getProjectTimeSummary, getDailyTimeSummary, getWeeklyTimeSummary, getMonthlyTimeSummary, getTimeBreakdown, formatDuration } from './timeSummaryService';
import { ManualTimeEntryInput, TimeBreakdownType, TimeBreakdownFilters } from './timeTypes';
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
import { reinstallPostCommitHook, getDetectorState } from './gitHookService';
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
} from './taskTypes';
import { getPmTaskIntelligenceService } from './pmTaskIntelligenceService';
import { queryTasksAdvanced, parseCustomQuery } from './advancedTaskFilterService';
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
  saveTaskSyncState,
  markCachedTaskDone,
} from './taskCacheService';
import {
  getConnectedToolsSync,
  connectTool,
  disconnectTool,
  canConnectProvider,
  isFreeTier,
} from './taskProviderRegistry';
import { pullTasks, pullTaskDetails, pullAllConnectedProviderTasks, DEFAULT_PULL_INPUT } from './taskPullService';
import { queryTasks } from './taskSearchService';
import { buildOfflineSyncSummary, isOnline, syncWhenOnline } from './offlineSyncService';

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
  private readonly _driftEvents = new Map<string, DriftEvent>();
  private _userProfile: { tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string } = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
  private _lastCommitSessions: TyneCommitSession[] = [];
  private _profileFetchedAt = 0;
  private _jiraBackgroundRefreshInFlight = false;
  private _jiraLastBackgroundRefreshAt = 0;
  private _githubSessionInvalid = false;
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
    this._state = getState(this._context);
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);
    initRealTimeSync(this._context, (msg) => this._view?.webview.postMessage(msg));

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'WEBVIEW_READY') {
        console.log('HOST: Received WEBVIEW_READY, fetching profile...');
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
        case 'continueWithGitHub': await this._continueWithGitHub(); break;
        case 'reconnectGitHub': await this._reconnectGitHub(); break;
        case 'logout': await this._logout(); break;
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
        case 'exportValidationHistory': await this._handleExportValidationHistory(msg.format as 'csv' | 'json', msg.filters); break;
        case 'driftAction': await this._handleDriftAction(msg.file as string, msg.action as string); break;
        case 'parkedIdeasClear': await this._setParkedIdeas([]); this._postSettings(); break;
        case 'standupSelect': await this._handleStandupSelect(msg.task); break;
        case 'connectIntegration': this._handleConnectIntegration(msg.provider as string); break;
        case 'switchBranch': await this._switchToBranch(msg.branchName as string); break;
        case 'deleteBranch': await this._deleteBranch(msg.branchName as string); break;
        case 'refreshBranches':
          await this._refreshBranchContext(true);
          await this._refreshCommitContext(true, 200);
          break;
        case 'refreshCommits': await this._refreshCommitContext(true, 200); break;
        case 'refreshTime': await this._refreshTimeContext(true); break;
        case 'refreshAutomation': await this._refreshAutomationContext(true); break;
        case 'refreshTasks': await this._refreshTasksContext(true); break;
        case 'pullTasks': await this._handlePullTasks(msg.tool as TynePmTool | undefined); break;
        case 'connectPmTool': await this._handleConnectPmTool(msg.tool as TynePmTool); break;
        case 'disconnectPmTool': await this._handleDisconnectPmTool(msg.tool as TynePmTool); break;
        case 'openTaskDetail': await this._handleOpenTaskDetail(msg.taskId as string, msg.tool as TynePmTool); break;
        case 'selectTaskIntoThread': await this._handleSelectTaskIntoThread(msg.taskId as string, msg.tool as TynePmTool); break;
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
        case 'getGitStatus': await this._refreshGitStatus(); break;
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
        case 'requestTimeBreakdown':
          await this._handleTimeBreakdownRequest(
            msg.breakdownType as TimeBreakdownType,
            msg.filters as TimeBreakdownFilters,
          );
          break;
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

  private _handleConnectIntegration(provider: string): void {
    const names: Record<string, string> = { slack: 'Slack', salesforce: 'Salesforce', jira: 'Jira', linear: 'Linear', monday: 'Monday' };
    const name = names[provider] || provider;
    if (provider === 'jira' || provider === 'linear' || provider === 'monday' || provider === 'asana' || provider === 'notion') {
      void this._handleConnectPmTool(provider as TynePmTool);
      return;
    }
    vscode.window.showInformationMessage(`Connect ${name} — OAuth integration coming soon.`);
  }

  private async _logout(): Promise<void> {
    await this._context.secrets.delete('tyne_github_token');
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
    this._view?.webview.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this._userProfile.tier,
        credits: this._userProfile.credits,
        githubUsername: this._userProfile.githubUsername || '',
        githubId: this._userProfile.githubId || '',
        email: this._userProfile.email || '',
        avatarUrl: this._userProfile.avatarUrl || '',
      }
    });
  }

  private async _fetchUserProfile(): Promise<{ tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string }> {
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) {
      return { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
    }
    const machineId = vscode.env.machineId;
    try {
      const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'X-Machine-ID': machineId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ feature: 'profile' })
      });
      if (res.ok) {
        this._githubSessionInvalid = false;
        const data = await res.json() as { tier: string; credits: number; githubUsername?: string; githubId?: string; email?: string; avatarUrl?: string };
        return data;
      }
      const text = await res.text().catch(() => '');
      if (isInvalidGitHubTokenResponse(res.status, text)) {
        await this._handleInvalidGitHubToken('profile');
        return { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
      }
      this._view?.webview.postMessage({ type: 'profileLoadFailed', error: text || `Profile request failed (${res.status})` });
    } catch (e) {
      console.error("Error fetching user profile:", e);
      this._view?.webview.postMessage({ type: 'profileLoadFailed', error: e instanceof Error ? e.message : String(e) });
    }
    return { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
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

  private async _postSettings(): Promise<void> {
    const projectLeadMode = this._isProjectLeadMode();
    const aiAccessMode = this._getAiAccessMode();
    const aiProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    const byokConfig = await this._byokKeyService.getConfig();
    const hasBYOKKey = await this._byokKeyService.hasApiKey();
    const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
    const tier = normalizeTier(this._userProfile.tier);
    const usageSummary = await this._usageService.getUsageSummary(tier).catch(() => undefined);
    const aiUsageUsed = usageSummary?.used ?? 0;
    const aiUsageLimit = usageSummary?.limit === 'unlimited' ? -1 : usageSummary?.limit ?? 50;
    this._view?.webview.postMessage({
      type: 'settingsLoaded',
      projectLeadMode,
      parkedIdeas: this._getParkedIdeas(),
      aiAccessMode,
      aiProvider,
      hasBYOKKey,
      byokConfig,
      jiraIntegration,
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

  private _getRepositoryPath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
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
      case 'undoStitch': await this._undoStitch(); break;
      case 'validateGoal': await this._validateGoal(); break;
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

  private async _saveStitch(): Promise<void> {
    try {
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

  public triggerValidation(): void {
    void this._validateGoal();
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
      const isJiraTask = this._state.taskSource.toLowerCase() === 'jira' && this._state.taskId;
      let result: TyneValidationResult;
      let pmValidationResult: TynePmTaskValidationResult | null = null;

      if (isJiraTask) {
        pmValidationResult = await this._validationService.validateJiraTask(this._userProfile.tier);
        this._state.pmTaskValidationResult = pmValidationResult;
        result = this._mapPmValidationToTyneValidation(pmValidationResult);
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
      filesReviewed: pm.changedFiles?.length ? pm.changedFiles : undefined,
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

  private async _overrideProceed(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Override validation? Tie the Knot will proceed even though validation did not fully pass.', 'Yes, override', 'Cancel');
    if (pick !== 'Yes, override') { return; }
    this._state.validationOverride = true;
    await saveState(this._context, this._state);
    this._view?.webview.postMessage({ type: 'tieKnotUnlocked' });
  }

  private async _tieTheKnot(): Promise<void> {
    if (!this._state.validationResult && !this._state.validationOverride) { vscode.window.showErrorMessage('Validate your goal first, or use Override.'); return; }
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
      // Close the linked PM task + post the feedback comment on tie-the-knot
      // (i.e. on commit), whether or not a remote push happened.
      this._maybeClosePMTicket(threadState.taskId);
      void this._runTieKnotAutomation(branch, threadState.taskId, validationAtShip);
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

  private _maybeClosePMTicket(taskId: string): void {
    if (!this._isProjectLeadMode() || !taskId) { return; }
    closePMTicket().then(result => { if (result.skipped) { return; } this._view?.webview.postMessage({ type: 'ticketClosed', taskId }); })
      .catch((err: unknown) => { vscode.window.showWarningMessage(`Ticket close failed (thread still done): ${err instanceof Error ? err.message : String(err)}`); });
  }

  private async _runTieKnotAutomation(
    branchName: string,
    taskId: string,
    validationResult: TyneValidationResult | null,
  ): Promise<void> {
    if (!taskId || !branchName) { return; }
    const repositoryPath = this._getRepositoryPath();
    const automationCtx = buildAutomationContextFromBranch(
      this._context, repositoryPath, branchName, validationResult,
    );
    if (!automationCtx) {
      vscode.window.showWarningMessage(`Tie-the-knot: branch ${branchName} has no linked PM task, so Jira was not updated.`);
      return;
    }
    // Tie-the-knot is the explicit "ship it" action, so always complete the linked
    // PM task: transition it to Done and post a feedback comment. markTaskDone is
    // idempotent (skips when already Done) and honours the require-validation gate.
    vscode.window.showInformationMessage('Tie-the-knot: updating the linked PM task…');
    const closeEvent = await markTaskDone(automationCtx, 'task_done');
    if (closeEvent.status === 'success') {
      await this._markCachedTaskDone(taskId);
      vscode.window.showInformationMessage(`Task status updated successfully. ${this._jiraKeyFromTaskId(taskId)} marked Done.`);
    } else if (closeEvent.status === 'skipped') {
      if (/already marked done/i.test(closeEvent.errorMessage ?? '')) {
        await this._markCachedTaskDone(taskId);
      } else {
        vscode.window.showInformationMessage(closeEvent.errorMessage ?? 'Task close skipped.');
      }
    } else if (closeEvent.status === 'failed') {
      vscode.window.showWarningMessage(closeEvent.errorMessage ?? 'Could not mark the PM task Done.');
    }

    // Always post the work-summary comment — it does not depend on the status
    // transition, so the developer still gets a record even if the close fails.
    const feedbackEvent = await postFeedback(automationCtx, 'task_done');
    if (feedbackEvent.status === 'success') {
      vscode.window.showInformationMessage('Feedback comment posted to the PM task.');
    } else if (feedbackEvent.status === 'failed') {
      vscode.window.showWarningMessage(feedbackEvent.errorMessage ?? 'Could not post the feedback comment.');
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
    const merged = { ...existing, ...settings };
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
    vscode.window.showInformationMessage(
      state.hookInstalled ? 'Git hook installed.' : `Git hook could not be installed: ${state.error || 'unknown error'}. Watcher fallback active.`,
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
      const connectedTools = getConnectedToolsSync(this._context);
      const allTasks = listCachedTasksSync(this._context);
      const syncSummary = buildOfflineSyncSummary(this._context);
      const rawTier = (this._userProfile?.tier ?? 'CORE').toLowerCase();
      const normTier = (rawTier === 'core' ? 'free' : rawTier) as 'free' | 'pro' | 'max';
      const jiraIntegration = await getJiraIntegrationSnapshot(this._context);
      if (postMessage || this._view) {
        this._view?.webview.postMessage({
          type: 'tasksDataLoaded',
          tasks: allTasks,
          connectedTools,
          syncSummary,
          jiraIntegration,
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
      const result = await connectTool(this._context, tool, tier);
      if (result.ok) {
        if (tool === 'jira') { this._logJira('Jira connected successfully.'); }
        if (tool === 'linear') { this._logLinear('Linear connected successfully'); }
        vscode.window.showInformationMessage(`Connected to ${tool}. Pulling tasks…`);
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

    await this._postSettings();
    await this._refreshTasksContext(true);
  }

  private async _handleDisconnectPmTool(tool: TynePmTool): Promise<void> {
    if (!tool) { return; }
    const pick = await vscode.window.showWarningMessage(
      `Disconnect ${tool}? Cached tasks will be kept locally.`, 'Yes, disconnect', 'Cancel',
    );
    if (pick !== 'Yes, disconnect') { return; }
    await disconnectTool(this._context, tool);
    vscode.window.showInformationMessage(`Disconnected from ${tool}.`);
    await this._postSettings();
    await this._refreshTasksContext(true);
  }

  private async _handleOpenTaskDetail(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId || !tool) { return; }
    if (tool === 'jira') { this._logJira(`Selected Jira task: ${this._jiraKeyFromTaskId(taskId)}`); }
    if (tool === 'linear') { this._logLinear(`Selected Linear issue: ${taskId.replace(/^linear:/, '')}`); }
    const cached = getCachedTaskDetailsSync(this._context, taskId);
    if (cached) {
      this._view?.webview.postMessage({ type: 'taskDetailLoaded', details: cached });
    }
    try {
      const online = await isOnline();
      if (!online) {
        if (!cached) {
          this._view?.webview.postMessage({ type: 'taskDetailLoaded', details: null, taskId, offline: true });
        }
        return;
      }
      const details = await pullTaskDetails(this._context, taskId, tool);
      this._view?.webview.postMessage({ type: 'taskDetailLoaded', details });
      if (tool === 'jira') {
        await this._fetchAndPostPmTaskIntelligence(taskId, false);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!cached) {
        this._view?.webview.postMessage({ type: 'taskDetailError', taskId, message: msg });
      }
    }
  }

  private async _fetchAndPostPmTaskIntelligence(taskId: string, forceRefresh: boolean): Promise<void> {
    if (!taskId) { return; }
    const jiraAdapter = getAdapter('jira') as { getCloudId?: () => Promise<string> } | null;
    const cloudId = jiraAdapter?.getCloudId ? await jiraAdapter.getCloudId() : '';
    if (!cloudId) { return; }
    const issueKey = taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
    try {
      this._view?.webview.postMessage({ type: 'pmTaskIntelligenceLoading', taskId });
      const pmService = getPmTaskIntelligenceService(this._context);
      const intelligence = await pmService.extractIntelligence({
        context: this._context,
        jiraIssueKey: issueKey,
        cloudId,
        tier: this._userProfile.tier,
      });
      this._view?.webview.postMessage({
        type: 'pmTaskIntelligenceLoaded',
        taskId,
        intelligence,
        forceRefresh,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'pmTaskIntelligenceError', taskId, message: msg });
    }
  }

  private _handleQueryTasks(query: string, filters: TyneTaskFilters, sort: TyneTaskSort): void {
    const all = listCachedTasksSync(this._context);
    const result = queryTasks(all, query ?? '', filters ?? {}, sort ?? DEFAULT_TASK_SORT);
    this._view?.webview.postMessage({ type: 'tasksQueryResult', tasks: result });
  }

  private async _extractIntelligenceForStartThread(taskId: string, tool: TynePmTool): Promise<TynePmTaskIntelligence | null> {
    if (tool !== 'jira') { return null; }
    const jiraAdapter = getAdapter('jira') as { getCloudId?: () => Promise<string> } | null;
    const cloudId = jiraAdapter?.getCloudId ? await jiraAdapter.getCloudId() : '';
    if (!cloudId) { return null; }
    const issueKey = taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
    try {
      const pmService = getPmTaskIntelligenceService(this._context);
      return await pmService.extractIntelligence({
        context: this._context,
        jiraIssueKey: issueKey,
        cloudId,
        tier: this._userProfile.tier,
      });
    } catch (err) {
      console.warn('PM task intelligence extraction failed during start thread:', err);
      return null;
    }
  }

  // Load a PM task into the thread brief (goal, acceptance criteria, proof points)
  // and navigate to the thread page — WITHOUT creating a branch. Validation state
  // is reset so the new task starts clean.
  private async _loadTaskIntoThread(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    const intelligence = await this._extractIntelligenceForStartThread(taskId, tool);

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
    this._state.subtasks = (intelligence?.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    this._state.appName = this._state.appName || vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    this._clearValidationForNewTask();
    await saveState(this._context, this._state);

    // Prefill the webview form fields immediately so the thread page reflects the task.
    this._view?.webview.postMessage({
      type: 'prefillThread',
      taskId,
      taskTitle: title,
      taskSource: tool,
      taskUrl: url ?? '',
      goal: this._state.goal,
      subtasks: this._state.subtasks,
      acceptanceCriteria: this._state.acceptanceCriteria,
      proofPointTemplates: this._state.proofPointTemplates,
      validationSteps: this._state.validationSteps,
      pmTaskContext: intelligence,
    });
    this._view?.webview.postMessage({ type: 'navigateTo', page: 'thread' });
  }

  // Clicking a task in the list: load it into the thread page (no branch yet).
  // Title/url are resolved from the cached task so the card only needs id + tool.
  private async _handleSelectTaskIntoThread(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    const cached = listCachedTasksSync(this._context).find(task => task.id === taskId);
    const title = cached?.title || taskId;
    const resolvedTool = (cached?.sourceTool as TynePmTool) || tool;
    this._logJira(`Task selected into thread: ${taskId}`);
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
    this._logJira(`Start Thread clicked: ${taskId}`);
    this._setRunner(true);
    try {
      await this._loadTaskIntoThread(taskId, title, tool, url);
      // Now start the thread (create branch, set weaving state, refresh).
      await this._startThread();
    } finally {
      this._setRunner(false);
    }
  }

  // ── Pro/Max: Advanced query ────────────────────────────────────────────────

  private _handleQueryTasksAdvanced(
    query: string,
    filters: TyneAdvancedTaskFilters,
    sort: TyneAdvancedTaskSort,
  ): void {
    const all = getUnifiedTaskListSync(this._context);
    const { tasks, parseErrors } = queryTasksAdvanced(
      all,
      query ?? '',
      filters ?? {},
      sort ?? DEFAULT_ADVANCED_SORT,
    );
    this._view?.webview.postMessage({ type: 'tasksQueryResult', tasks, parseErrors });
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
      const taskId = this._state.taskId;
      const currentBranch = this._state.branchName;
      const taskSummary = taskId
        ? getTaskTimeSummary(this._context, repositoryPath, taskId)
        : null;
      const branchSummary = currentBranch
        ? getBranchTimeSummary(this._context, repositoryPath, currentBranch)
        : null;
      const projectSummary = getProjectTimeSummary(this._context, repositoryPath);
      const dailySummary = getDailyTimeSummary(this._context, repositoryPath, today);
      const weeklySummary = getWeeklyTimeSummary(this._context, repositoryPath, today);
      const monthlySummary = getMonthlyTimeSummary(this._context, repositoryPath, today);
      const taskLogs = taskId ? getTimeLogsForTask(this._context, taskId) : [];
      const branchLogs = currentBranch ? getTimeLogsForBranch(this._context, currentBranch) : [];
      const manualEntries = taskId ? listManualTimeEntriesForTask(this._context, taskId) : [];
      const allLogs = listTimeLogs(this._context).filter(l => l.repositoryPath === repositoryPath);
      const allManuals = listManualEntries(this._context).filter(e => e.repositoryPath === repositoryPath);
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
          manualEntries,
          allLogs,
          allManuals,
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

  private async _handleTimeBreakdownRequest(type: TimeBreakdownType, filters: TimeBreakdownFilters): Promise<void> {
    const repositoryPath = this._getRepositoryPath();
    const breakdown = getTimeBreakdown(this._context, repositoryPath, type, filters ?? {});
    this._view?.webview.postMessage({ type: 'timeBreakdownLoaded', breakdownType: type, items: breakdown });
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
    const logos = { slack: asset('logo-slack.svg'), salesforce: asset('logo-salesforce.svg'), jira: asset('logo-jira.svg'), linear: asset('logo-linear.svg'), monday: asset('logo-monday.svg') };
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} https://*.vscode-cdn.net data:;`;
    return renderSidebarHtml(csp, nonce, logoUri, cssUri, jsUri, taskInteractionsUri, tier, logos);
  }
}

function renderSidebarHtml(csp: string, nonce: string, logoUri: string, cssUri: string, jsUri: string, taskInteractionsUri: string, tier: { mark: string; core: string; pro: string; max: string }, logos: { slack: string; salesforce: string; jira: string; linear: string; monday: string }): string {
  const ICON = {
    thread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
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
    <div class="welcome-foot">By continuing you agree to the Terms &amp; Privacy Policy.</div>
  </section>

  <main id="shellView" class="shell active">
    <nav class="rail">
      <div class="rail-logo"><img src="${tier.mark}" alt="Tyne" /></div>
      <button class="rail-btn active" data-nav="thread" title="Thread" aria-label="Thread">${ICON.thread}</button>
      <button class="rail-btn" data-nav="tasks" title="Tasks" aria-label="Tasks">${ICON.tasks}</button>
      <button class="rail-btn" data-nav="branches" title="Branches" aria-label="Branches">${ICON.branch}</button>
      <button class="rail-btn" data-nav="commits" title="Commits" aria-label="Commits">${ICON.commit}</button>
      <button class="rail-btn" data-nav="time" title="Time" aria-label="Time">${ICON.clock}</button>
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
      <!-- GitHub session-expired banner (shown when the saved token is rejected) -->
      <div class="gh-expired-banner hidden" id="githubExpiredBanner" role="alert">
        <div class="gh-expired-copy" id="githubExpiredText">Your GitHub session expired. Reconnect GitHub to continue.</div>
        <button class="btn primary compact" id="githubReconnectBtn" type="button">Reconnect GitHub</button>
      </div>
      <div class="pages">

        <!-- ===== THREAD ===== -->
        <section class="page active" id="threadPage">

          <!-- Header: title + status pill -->
          <div class="page-head">
            <span class="page-title">Thread</span>
            <span class="pill standby" id="statusPill"><span class="status-ascii" id="statusAscii" data-status="standby"></span><span id="statusText">Standby</span></span>
          </div>

          <!-- Stepper -->
          <div class="stepper" id="stepper">
            <div class="step" data-step="0"><div class="bar"></div><div class="name">Task</div></div>
            <div class="step" data-step="1"><div class="bar"></div><div class="name">Weave</div></div>
            <div class="step" data-step="2"><div class="bar"></div><div class="name">Verify</div></div>
            <div class="step" data-step="3"><div class="bar"></div><div class="name">Ship</div></div>
          </div>

          <!-- Metrics -->
          <div class="metrics" id="threadMetrics">
            <div class="metric"><div class="k">Task</div><div class="v" id="mTask">—</div></div>
            <div class="metric"><div class="k">Stitches</div><div class="v" id="mStitch">0</div></div>
            <div class="metric"><div class="k">Time</div><div class="v" id="mTime">0m</div></div>
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

          <!-- Thread brief form -->
          <div id="briefSection">
            <div class="label-row">
              <div class="label">Thread brief</div>
              <button class="link-action" id="addTaskBtn" type="button" data-flow-action="addTask" title="Create a task from this brief">${ICON.plus}<span>Add task</span></button>
            </div>
            <div class="field">
              <label for="appName">Project / app</label>
              <input type="text" id="appName" placeholder="My App" autocomplete="off" />
            </div>
            <div class="field hidden" id="threadTaskPickerField">
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

          <!-- Brief summary (shown while weaving) -->
          <div id="briefSummary" class="card hidden">
            <div class="row"><div class="k">Task</div><div class="v" id="bsTask"></div></div>
            <div class="row"><div class="k">Goal</div><div class="v" id="bsGoal"></div></div>
            <div class="row"><div class="k">Branch</div><div class="v branch" id="bsBranch"></div></div>
            <div class="field hidden" id="weavingTaskPickerField">
              <label for="weavingTaskPicker">Change task</label>
              <select id="weavingTaskPicker">
                <option value="">— Select an assigned task —</option>
              </select>
            </div>
          </div>

          <!-- Git status hint (shown while weaving) -->
          <div id="gitStatusHint" class="notice hidden" style="font-size:11px;margin-top:6px;"></div>

          <!-- Deep review lock notice -->
          <div class="notice bad hidden" id="deepReviewLock">
            <div class="notice-title">Deep goal tracking locked</div>
            <div class="notice-copy">Your hosted validation quota is used up for this month. Connect your own AXIOM key to keep validating, or upgrade your plan.</div>
            <div class="btn-row"><button class="btn primary" id="upgradeToMaxBtn" type="button">Upgrade to MAX</button></div>
          </div>

          <!-- Proof points -->
          <div id="proofSection">
            <div class="label">Proof points</div>
            <div id="subtaskList"></div>
            <div class="add-row">
              <input type="text" id="newSubtask" placeholder="Add a proof point&hellip;" autocomplete="off" />
              <button class="icon-btn" id="addSubtaskBtn" title="Add" aria-label="Add proof point">${ICON.plus}</button>
            </div>
          </div>

          <!-- Primary action -->
          <button class="btn primary full" id="flowPrimaryBtn" type="button" data-flow-action="selectTask">Select task</button>
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

            <!-- AI Usage -->
            <div class="hidden" id="usageWrap">
              <button class="section-toggle" data-target="usageBody">
                <span class="toggle-arrow">&#9658;</span> AI Usage
                <span class="toggle-count" data-target="usageBody"></span>
              </button>
              <div class="section-body hidden" id="usageBody">
                <div class="usage-row"><span id="usageLabel">AI usage</span><span id="usageText">0 / 50</span></div>
                <div class="usage-track"><div class="usage-fill" id="usageFill"></div></div>
              </div>
            </div>

            <!-- Validation -->
            <div class="hidden" id="validationWrap">
              <button class="section-toggle" data-target="validationBody">
                <span class="toggle-arrow">&#9658;</span> Validation
                <span class="toggle-count" data-target="validationBody"></span>
              </button>
              <div class="section-body hidden" id="validationBody">
                <!-- Validation counter bar -->
                <div class="val-counter-bar" id="valCounterBar" aria-label="Validation usage">
                  <div class="val-counter-row">
                    <span class="val-counter" id="valCounter">Validations: loading…</span>
                    <span class="val-provider" id="valProviderBadge"></span>
                  </div>
                  <div class="val-counter-track" id="valCounterTrack" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
                    <div class="val-counter-fill" id="valCounterFill"></div>
                  </div>
                </div>

                <!-- Live validation stages panel -->
                <div class="val-stages-panel hidden" id="valStagesPanel" aria-live="polite" aria-label="Validation progress">
                  <div class="val-stages-title">Validation Timeline</div>
                  <div class="val-stages-list" id="valStagesList"></div>
                </div>

                <!-- Validation counter + provider (legacy slot kept for compat) -->
                <div class="val-meta-row hidden" id="valMetaRow">
                  <span class="val-counter-legacy" id="valCounterLegacy"></span>
                  <span class="val-provider" id="valProviderBadgeLegacy"></span>
                </div>

                <!-- Latest result panel -->
                <div class="card" id="validationPanel">
                  <div class="val-empty" id="valEmpty">No validations yet. Run Validate Goal after coding.</div>
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
                      <button class="btn primary" id="btnRevalidate" type="button">Run again</button>
                      <button class="btn" id="btnOverride" type="button">Override</button>
                      <button class="btn ghost compact" id="btnCopyValSummary" type="button">Copy</button>
                    </div>
                  </div>
                </div>

                <!-- History -->
                <div class="val-history-controls hidden" id="valHistoryControls">
                  <input type="text" class="val-search" id="valHistorySearch" placeholder="Search history…" />
                  <select class="val-filter" id="valHistoryFilter" title="Filter">
                    <option value="">All</option>
                    <option value="today">Today</option>
                    <option value="this_week">This week</option>
                    <option value="this_month">This month</option>
                    <option value="last_30_days">Last 30 days</option>
                    <option value="pass">PASS</option>
                    <option value="partial">PARTIAL</option>
                    <option value="fail">FAIL</option>
                    <option value="low">Risk: Low</option>
                    <option value="medium">Risk: Medium</option>
                    <option value="high">Risk: High</option>
                    <option value="anthropic">AXIOM</option>
                    <option value="openai">AXIOM</option>
                    <option value="managed">AXIOM</option>
                  </select>
                  <select class="val-sort" id="valHistorySort" title="Sort">
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="status">Status</option>
                    <option value="risk">Risk</option>
                    <option value="match">Match %</option>
                    <option value="task">Task</option>
                    <option value="branch">Branch</option>
                  </select>
                  <div class="val-more-menu-wrap">
                    <button class="btn ghost compact" id="valHistoryMoreBtn" type="button">More</button>
                    <div class="val-more-menu hidden" id="valHistoryMoreMenu">
                      <button class="val-more-item" data-export="csv" type="button">Export CSV</button>
                      <button class="val-more-item" data-export="json" type="button">Export JSON</button>
                    </div>
                  </div>
                </div>
                <div class="val-trends hidden" id="valTrends"></div>
                <div class="val-history" id="valHistory"><div class="empty" id="valHistoryEmpty">No validations yet.</div></div>
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

            <!-- Commit activity -->
            <div id="commitActivitySection">
              <button class="section-toggle" data-target="commitActivityBody">
                <span class="toggle-arrow">&#9658;</span> Commit Activity
                <span class="toggle-count" data-target="commitActivityBody"></span>
              </button>
              <div class="section-body hidden" id="commitActivityBody">
                <div id="taskCommitSummaryCard" class="card">
                  <div class="empty">No linked commit history yet.</div>
                </div>
                <div id="taskCommitList"></div>
              </div>
            </div>

          </div>

        </section>

        <!-- ===== TASKS ===== -->
        <section class="page" id="tasksPage">

          <!-- Header: title + sync icon only -->
          <div class="page-head">
            <span class="page-title">Tasks</span>
            <div class="task-head-right">
              <span class="sync-dot" id="taskSyncDot" title=""></span>
              <button class="btn ghost compact task-sync-icon-btn" id="pullTasksBtn" type="button" title="Sync tasks">↺</button>
            </div>
          </div>

          <!-- STATE 1: No tool connected — one-tap pill connect -->
          <div class="hidden" id="taskConnectCard">
            <div class="task-connect-prompt">Connect a PM tool to pull your tasks</div>
            <div class="pm-connect-pills">
              <button class="pm-pill" data-connect-tool="linear">Linear</button>
              <button class="pm-pill" data-connect-tool="jira">Jira</button>
              <button class="pm-pill" data-connect-tool="asana">Asana</button>
              <button class="pm-pill" data-connect-tool="notion">Notion</button>
              <button class="pm-pill" data-connect-tool="monday">Monday</button>
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

            <!-- PRIMARY ACTION — full width -->
            <button class="btn primary task-detail-primary-btn" id="taskDetailStartThreadBtn" type="button">▶ Start Thread</button>

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
              <div id="pmIntelligenceLoading" class="pm-intelligence-loading hidden">Extracting intelligence…</div>
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

        <!-- ===== TIME ===== -->
        <section class="page" id="timePage">
          <div class="page-head">
            <span class="page-title">Time</span>
            <div class="time-header-actions">
              <button class="icon-btn" id="addManualTimeHeaderBtn" type="button" title="Add manual time">+</button>
              <button class="icon-btn" id="refreshTimeBtn" type="button" title="Refresh time">↺</button>
            </div>
          </div>

          <div class="card" id="taskTimeSummaryCard">
            <div class="empty">No time tracked yet. Commit on a Tyne branch or add manual time.</div>
          </div>

          <button class="section-toggle" data-target="timeSessionBody" type="button">
            <span class="toggle-arrow">▸</span> Sessions
            (<span class="toggle-count" data-target="timeSessionBody">0</span>)
          </button>
          <div class="section-body hidden" id="timeSessionBody">
            <div id="timeSessionList"><div class="empty">No commit sessions found for this branch yet.</div></div>
          </div>

          <button class="section-toggle" data-target="manualTimeBody" type="button">
            <span class="toggle-arrow">▸</span> Manual Entries
            (<span class="toggle-count" data-target="manualTimeBody">0</span>)
          </button>
          <div class="section-body hidden" id="manualTimeBody">
            <div id="manualTimeList"><div class="empty">No manual time entries yet.</div></div>
            <div class="card hidden" id="manualTimeFormCard">
              <div class="label" style="margin-top:0">New Manual Entry</div>
              <div class="field"><label for="mtDate">Date</label><input type="date" id="mtDate" /></div>
              <div class="field"><label for="mtDuration">Duration (minutes)</label><input type="number" id="mtDuration" min="1" placeholder="e.g. 45" /></div>
              <div class="field"><label for="mtStartTime">Start time (optional)</label><input type="time" id="mtStartTime" /></div>
              <div class="field"><label for="mtEndTime">End time (optional)</label><input type="time" id="mtEndTime" /></div>
              <div class="field"><label for="mtNote">Note (optional)</label><input type="text" id="mtNote" placeholder="Planning, debugging, discussion&hellip;" /></div>
              <div class="notice bad hidden" id="manualTimeError"><div class="notice-copy" id="manualTimeErrorText"></div></div>
              <div class="btn-row">
                <button class="btn primary" id="saveManualTimeBtn" type="button">Save</button>
                <button class="btn" id="cancelManualTimeBtn" type="button">Cancel</button>
              </div>
            </div>
          </div>

          <div class="section-header-row">
            <button class="section-toggle" data-target="timeBreakdownBody" type="button">
              <span class="toggle-arrow">▸</span> Breakdown
            </button>
            <select id="breakdownSelect" class="time-breakdown-select">
              <option value="" disabled selected>By&hellip;</option>
              <option value="task">By Task</option>
              <option value="branch">By Branch</option>
              <option value="day">By Day</option>
              <option value="week">By Week</option>
              <option value="month">By Month</option>
              <option value="source">By Source</option>
            </select>
          </div>
          <div class="section-body hidden" id="timeBreakdownBody">
            <div id="timeBreakdownList"><div class="empty">Select a breakdown above.</div></div>
          </div>

          <button class="section-toggle" data-target="timeSummariesBody" type="button">
            <span class="toggle-arrow">▸</span> Summaries
          </button>
          <div class="section-body hidden" id="timeSummariesBody">
            <div class="card" id="timeSummariesCard">
              <div class="empty">—</div>
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
            <div class="label" style="margin-top:0">Feedback Preview</div>
            <pre id="automationFeedbackPreviewText" style="white-space:pre-wrap;font-size:11px;line-height:1.6;font-family:var(--mono);color:var(--fg);margin:0;"></pre>
            <div class="btn-row">
              <button class="btn primary" id="automationPostPreviewedBtn" type="button">Post This</button>
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
          <div class="card">
            <div class="field">
              <label for="autoCloseTrigger">Auto-close trigger</label>
              <select id="autoCloseTrigger">
                <option value="manual">Manual only</option>
                <option value="on_push">When branch is pushed</option>
                <option value="manual_and_on_push">Manual and branch push</option>
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
                <option value="after_task_done">After task done</option>
                <option value="after_validation_pass">After validation pass</option>
                <option value="after_push">After push</option>
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
            <div class="btn-row" style="margin-top:10px">
              <button class="btn primary" id="automationSaveSettingsBtn" type="button">Save Settings</button>
            </div>
          </div>

          <div class="label max-only hidden" id="maxReportSettingsLabel">MAX Report Settings</div>
          <div class="card max-only hidden" id="maxReportSettingsCard">
            <div class="tab-bar" id="maxReportTabBar">
              <button class="tab-btn active" data-tab="general" type="button">General</button>
              <button class="tab-btn" data-tab="validation" type="button">Validation</button>
              <button class="tab-btn" data-tab="risk" type="button">Risk</button>
              <button class="tab-btn" data-tab="security" type="button">Security</button>
              <button class="tab-btn" data-tab="quality" type="button">Quality</button>
              <button class="tab-btn" data-tab="performance" type="button">Performance</button>
              <button class="tab-btn" data-tab="recommendations" type="button">Recommendations</button>
            </div>
            <div class="tab-panels" id="maxReportTabPanels">
              <div class="tab-panel active" data-tab="general">
                <div class="field toggle-row">
                  <label for="maxReportValidationStages">Include validation stages</label>
                  <input type="checkbox" id="maxReportValidationStages" data-section="validation_stages" />
                </div>
                <div class="field toggle-row">
                  <label for="maxReportRiskAssessment">Include risk assessment</label>
                  <input type="checkbox" id="maxReportRiskAssessment" data-section="risk_assessment" />
                </div>
                <div class="field toggle-row">
                  <label for="maxReportPerformanceMetrics">Include performance metrics</label>
                  <input type="checkbox" id="maxReportPerformanceMetrics" data-section="performance_metrics" />
                </div>
                <div class="field toggle-row">
                  <label for="maxReportSecurityCheck">Include security check</label>
                  <input type="checkbox" id="maxReportSecurityCheck" data-section="security_check" />
                </div>
                <div class="field toggle-row">
                  <label for="maxReportCodeQuality">Include code quality</label>
                  <input type="checkbox" id="maxReportCodeQuality" data-section="code_quality" />
                </div>
                <div class="field toggle-row">
                  <label for="maxReportRecommendations">Include recommendations</label>
                  <input type="checkbox" id="maxReportRecommendations" data-section="recommendations" />
                </div>
              </div>
              <div class="tab-panel" data-tab="validation">
                <p class="field-help">Validation stages show the step-by-step breakdown of how Tyne evaluated the code against the goal.</p>
                <div class="field toggle-row">
                  <label for="maxReportValidationStagesTab">Include validation stages</label>
                  <input type="checkbox" id="maxReportValidationStagesTab" data-section="validation_stages" />
                </div>
              </div>
              <div class="tab-panel" data-tab="risk">
                <p class="field-help">Risk assessment includes the overall risk level, missing requirements, and criteria that were not met.</p>
                <div class="field toggle-row">
                  <label for="maxReportRiskAssessmentTab">Include risk assessment</label>
                  <input type="checkbox" id="maxReportRiskAssessmentTab" data-section="risk_assessment" />
                </div>
              </div>
              <div class="tab-panel" data-tab="security">
                <p class="field-help">Security check surfaces any security-related notes from the validation.</p>
                <div class="field toggle-row">
                  <label for="maxReportSecurityCheckTab">Include security check</label>
                  <input type="checkbox" id="maxReportSecurityCheckTab" data-section="security_check" />
                </div>
              </div>
              <div class="tab-panel" data-tab="quality">
                <p class="field-help">Code quality includes the quality notes and the list of files reviewed.</p>
                <div class="field toggle-row">
                  <label for="maxReportCodeQualityTab">Include code quality</label>
                  <input type="checkbox" id="maxReportCodeQualityTab" data-section="code_quality" />
                </div>
              </div>
              <div class="tab-panel" data-tab="performance">
                <p class="field-help">Performance metrics include match percentage, duration, and files reviewed.</p>
                <div class="field toggle-row">
                  <label for="maxReportPerformanceMetricsTab">Include performance metrics</label>
                  <input type="checkbox" id="maxReportPerformanceMetricsTab" data-section="performance_metrics" />
                </div>
              </div>
              <div class="tab-panel" data-tab="recommendations">
                <p class="field-help">Recommendations include the actionable suggestions from the validation.</p>
                <div class="field toggle-row">
                  <label for="maxReportRecommendationsTab">Include recommendations</label>
                  <input type="checkbox" id="maxReportRecommendationsTab" data-section="recommendations" />
                </div>
              </div>
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
            <div class="name" id="accountName">Not connected</div>
            <div class="tier-row">
              <span class="tier-cap">Plan</span>
              <img class="tier-logo t-core" src="${tier.core}" alt="CORE" />
              <img class="tier-logo t-pro" src="${tier.pro}" alt="PRO" />
              <img class="tier-logo t-max" src="${tier.max}" alt="MAX" />
              <span class="plan" id="accountPlan">Connect GitHub to load your plan</span>
            </div>
            <div class="credits hidden" id="accountCredits">Daily usage: <span id="accountCreditsVal">0</span>%</div>
          </div>
          <div class="btn-stack">
            <button class="btn primary" id="manageBillingBtn">Manage billing / upgrade</button>
            <button class="btn" id="signoutBtn">Log out</button>
          </div>

          <div class="label">Integrations</div>
          <div class="list-item">
            <div class="int-head">
              <span class="lt">GitHub</span>
              <span class="conn-badge hidden" id="githubConnBadge"><span class="dot"></span>Connected</span>
            </div>
            <div class="lm plain" id="githubConnSub">Account connection &middot; draft PRs, branch push, review links</div>
            <div class="tags"><span class="tag">repo</span><span class="tag">pull-request</span></div>
            <button class="btn primary hidden" id="connectGithubBtn">Connect GitHub</button>
          </div>
          <div class="list-item jira-settings-card">
            <div class="int-head">
              <span class="lt">Jira</span>
              <span class="conn-badge conn-badge-neutral" id="jiraConnBadge"><span class="dot"></span><span id="jiraConnBadgeText">Not connected</span></span>
            </div>
            <div class="lm plain jira-conn-sub" id="jiraConnSub">Connect Jira to link this repository with your sprint work.</div>
            <div class="btn-row">
              <button class="btn primary hidden" id="jiraConnectGithubBtn" type="button">Connect GitHub</button>
              <button class="btn primary" id="jiraConnectBtn" type="button">Connect Jira</button>
              <button class="btn primary hidden" id="jiraReconnectBtn" type="button">Reconnect Jira</button>
              <button class="btn ghost compact" id="jiraChangeProjectBtn" type="button">Change Project</button>
              <button class="btn ghost compact" id="jiraDisconnectBtn" type="button">Disconnect</button>
            </div>
          </div>
          <div class="int-add">
            <button class="btn int-add-trigger" id="addIntegrationBtn" type="button" aria-expanded="false" aria-controls="integrationMenu">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span style="flex:1;text-align:left;margin-left:2px;">Add integration</span>
              <svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="int-menu" id="integrationMenu" role="menu">
              <button class="int-row" data-provider="slack" type="button" role="menuitem" aria-label="Connect Slack"><img class="int-logo" src="${logos.slack}" alt="" /><span class="int-name">Slack</span><span class="int-cta">Connect</span></button>
              <button class="int-row" data-provider="salesforce" type="button" role="menuitem" aria-label="Connect Salesforce"><img class="int-logo" src="${logos.salesforce}" alt="Salesforce" /><span class="int-cta">Connect</span></button>
              <button class="int-row" data-provider="linear" type="button" role="menuitem" aria-label="Connect Linear"><img class="int-logo" src="${logos.linear}" alt="Linear" /><span class="int-cta">Connect</span></button>
              <button class="int-row" data-provider="monday" type="button" role="menuitem" aria-label="Connect Monday"><img class="int-logo" src="${logos.monday}" alt="Monday" /><span class="int-cta">Connect</span></button>
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

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
