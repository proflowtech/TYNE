import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
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
  TyneTask,
} from '../taskTypes';
import { TynePmIntegrationSnapshot, filterTasksForConnectedTools } from '../taskViewModel';
import { getJiraIntegrationSnapshot } from '../jiraProvider';
import { getLinearIntegrationSnapshot } from '../linearProvider';
import { JiraOAuthStateError } from '../jiraOAuth';
import { LinearOAuthStateError } from '../linearOAuth';
import {
  getAdapter,
  getConnectedToolsSync,
  connectTool,
  markToolConnected,
  markToolDisconnected,
  disconnectTool,
  canConnectProvider,
  isFreeTier,
} from '../taskProviderRegistry';
import {
  pullTasks,
  pullTaskDetails,
  pullAllConnectedProviderTasks,
  DEFAULT_PULL_INPUT,
} from '../taskPullService';
import { getUnifiedTaskListSync } from '../multiProviderTaskPullService';
import { queryTasks as searchQueryTasks } from '../taskSearchService';
import { queryTasksAdvanced } from '../advancedTaskFilterService';
import { rankTaskQueue, applyRankMetadata, TyneRankedTask } from '../taskQueueRanking';
import {
  listPresetsSync,
  savePreset as savePresetToStore,
  renamePreset as renamePresetInStore,
  deletePreset as deletePresetFromStore,
  setDefaultPreset as setDefaultPresetInStore,
  getDefaultPreset,
  repairPresetStorage,
} from '../taskFilterPresetService';
import {
  listCachedTasksSync,
  repairTaskCache,
  getCachedTaskDetailsSync,
} from '../taskCacheService';
import { buildOfflineSyncSummary, isOnline } from '../offlineSyncService';
import { isDecomposableIssueType } from '../storyDecompositionHarness';
import { hasEnrichmentContent } from '../taskEnrichmentService';
import {
  createTask as pmCreateTask,
  updateTask as pmUpdateTask,
  addSubtask as pmAddSubtask,
  addComment as pmAddComment,
  canUsePmWrite,
} from '../writableTaskService';
import { detectTaskEditConflict } from '../realTimeSyncService';

type PmToolsHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'hasWebview'
  | 'userProfile'
  | 'jiraLog'
  | 'postSettings'
  | 'isGithubConnected'
  | 'logJira'
  | 'logLinear'
  | 'agentDebugLog'
  | 'getStoredPmIntelligence'
  | 'ensurePmIntelligencePosted'
  | 'postStoredDecompositionIfAny'
  | 'runEnrichmentForActiveThreadTask'
>;

export class PmToolsController {
  effectiveConnectedTools: TynePmTool[] = [];
  private jiraBackgroundRefreshInFlight = false;
  private jiraLastBackgroundRefreshAt = 0;

  constructor(private readonly host: PmToolsHost) {}

  postThreadCreateTasksVisibility(taskId?: string): void {
    const id = (taskId || this.host.state.taskId || '').trim();
    if (!id) {
      this.host.postMessage({ type: 'taskCreationEligibility', taskId: '', eligible: false, issueType: '' });
      return;
    }
    const cached = this.findCachedTask(id);
    const issueType = cached?.issueType || getCachedTaskDetailsSync(this.host.context, cached?.id || id)?.issueType || '';
    this.host.postMessage({
      type: 'taskCreationEligibility',
      taskId: cached?.id || id,
      eligible: isDecomposableIssueType(issueType),
      issueType,
    });
  }

  findCachedTask(taskId: string): ReturnType<typeof listCachedTasksSync>[number] | undefined {
    const id = (taskId || '').trim();
    if (!id) { return undefined; }
    const all = listCachedTasksSync(this.host.context);
    const bare = id.replace(/^(jira|linear|asana|notion|monday):/i, '');
    return all.find(t =>
      t.id === id
      || t.externalId === id
      || t.externalId === bare
      || t.id === `jira:${bare}`
      || t.id === `linear:${bare}`
    );
  }

  briefReadyTaskIds(tasks: TyneTask[]): string[] {
    return tasks
      .filter(t => hasEnrichmentContent(this.host.getStoredPmIntelligence(t.id)))
      .map(t => t.id);
  }

  rankTasksForView(filtered: TyneTask[], sortKey?: string): TyneRankedTask[] {
    const ranked = rankTaskQueue(filtered, {
      activeTaskId: this.host.state.taskId || undefined,
      briefReadyTaskIds: this.briefReadyTaskIds(filtered),
    });
    return sortKey === 'recommended' ? ranked : applyRankMetadata(filtered, ranked);
  }

  async postIntegrationState(): Promise<void> {
    const jiraIntegration = await getJiraIntegrationSnapshot(this.host.context);
    const pmIntegration = await this.buildPmIntegrationSnapshot(jiraIntegration);
    this.host.postMessage({
      type: 'integrationStateUpdated',
      jiraIntegration,
      pmIntegration,
      connectedTools: pmIntegration.connectedTools,
    });
  }

  async buildPmIntegrationSnapshot(
    jiraIntegration?: Awaited<ReturnType<typeof getJiraIntegrationSnapshot>>,
  ): Promise<TynePmIntegrationSnapshot> {
    const jira = jiraIntegration ?? await getJiraIntegrationSnapshot(this.host.context);
    const linearIntegration = await getLinearIntegrationSnapshot(this.host.context);
    const connectedTools: Array<'jira' | 'linear'> = [];

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
        await markToolConnected(this.host.context, tool);
        connectedTools.push(tool);
      } else {
        await markToolDisconnected(this.host.context, tool);
      }
    }

    this.effectiveConnectedTools = connectedTools;
    const githubConnected = await this.host.isGithubConnected();
    return {
      githubConnected,
      connectedTools,
      jira: {
        connected: connectedTools.includes('jira'),
        projectKey: jira.selectedProject?.projectKey,
        projectName: jira.selectedProject?.projectName,
        siteName: jira.siteName,
      },
      linear: {
        connected: connectedTools.includes('linear'),
        workspaceName: linearIntegration.workspaceName,
        teamKey: linearIntegration.selectedTeam?.teamKey,
        teamName: linearIntegration.selectedTeam?.teamName,
      },
    };
  }

  getVisibleCachedTasks(): TyneTask[] {
    const connectedTools = this.effectiveConnectedTools.length ? this.effectiveConnectedTools : getConnectedToolsSync(this.host.context);
    return filterTasksForConnectedTools(listCachedTasksSync(this.host.context), connectedTools);
  }

  async refreshTasksContext(postMessage: boolean): Promise<void> {
    try {
      const repairResult = await repairTaskCache(this.host.context);
      if (repairResult.repaired) {
        vscode.window.showWarningMessage(repairResult.message ?? 'Task cache repaired.');
      }
      await repairPresetStorage(this.host.context);
      const syncSummary = buildOfflineSyncSummary(this.host.context);
      const rawTier = (this.host.userProfile?.tier ?? 'CORE').toLowerCase();
      const normTier = (rawTier === 'core' ? 'free' : rawTier) as 'free' | 'pro' | 'max';
      const jiraIntegration = await getJiraIntegrationSnapshot(this.host.context);
      const pmIntegration = await this.buildPmIntegrationSnapshot(jiraIntegration);
      const connectedTools = pmIntegration.connectedTools;
      const allTasks = this.getVisibleCachedTasks();
      if (postMessage || this.host.hasWebview()) {
        this.host.postMessage({
          type: 'tasksDataLoaded',
          // Ranked so the Thread picker and the Tasks list agree on what to
          // start first, without the webview re-deriving anything.
          tasks: this.rankTasksForView(allTasks, 'recommended'),
          connectedTools,
          syncSummary,
          jiraIntegration,
          pmIntegration,
          tier: normTier,
          isFreeTier: isFreeTier(this.host.userProfile?.tier ?? 'CORE'),
          canWrite: canUsePmWrite(this.host.userProfile?.tier ?? 'CORE'),
          presets: listPresetsSync(this.host.context),
          defaultPreset: getDefaultPreset(this.host.context),
        });
      }
      if (!postMessage) {
        void this.maybeRefreshStaleJiraTasks(syncSummary, jiraIntegration.connected);
      }
    } catch (err) {
      console.error('Tyne: task refresh failed', err);
    }
  }

  async maybeRefreshStaleJiraTasks(
    syncSummary: { syncStates?: Array<{ sourceTool: string; syncStatus: string; lastSyncedAt?: string }> },
    jiraConnected: boolean,
  ): Promise<void> {
    if (this.jiraBackgroundRefreshInFlight || !jiraConnected) { return; }
    const jiraState = (syncSummary.syncStates || []).find(state => state.sourceTool === 'jira');
    if (!jiraState || jiraState.syncStatus === 'syncing') { return; }
    const lastSyncedAt = jiraState.lastSyncedAt ? new Date(jiraState.lastSyncedAt).getTime() : 0;
    const stale = !lastSyncedAt || Date.now() - lastSyncedAt >= 5 * 60 * 1000;
    if (!stale) { return; }
    if (Date.now() - this.jiraLastBackgroundRefreshAt < 60_000) { return; }

    const online = await isOnline().catch(() => false);
    if (!online) { return; }

    this.jiraBackgroundRefreshInFlight = true;
    this.jiraLastBackgroundRefreshAt = Date.now();
    try {
      await pullTasks(this.host.context, 'jira');
    } catch {
      // Keep cached data visible and let sync state drive the UI.
    } finally {
      this.jiraBackgroundRefreshInFlight = false;
      await this.refreshTasksContext(true);
    }
  }

  async pullTasks(tool?: TynePmTool): Promise<void> {
    const connectedTools = getConnectedToolsSync(this.host.context);
    if (!connectedTools.length) {
      vscode.window.showInformationMessage('Connect a PM tool to pull your tasks.');
      return;
    }
    this.host.postMessage({ type: 'tasksSyncing', tool: tool ?? 'all' });
    const touchesJira = tool === 'jira' || !tool;
    const touchesLinear = tool === 'linear' || !tool;
    if (touchesJira) { this.host.logJira('Refreshing Jira tasks...'); }
    if (touchesLinear) { this.host.logLinear('Refreshing Linear issues...'); }
    try {
      const online = await isOnline();
      if (!online) {
        vscode.window.showWarningMessage('You are offline. Showing cached tasks.');
        await this.refreshTasksContext(true);
        return;
      }
      // Explicit refresh: always bypass the provider-side issue cache so the list
      // reflects current Jira assignment, then replace (not merge) the cached list.
      const input = { ...DEFAULT_PULL_INPUT, forceRefresh: true };
      if (tool) {
        const tasks = await pullTasks(this.host.context, tool, input);
        if (tool === 'jira') { this.host.logJira(`Jira tasks refreshed: count=${tasks.length}`); }
        if (tool === 'linear') { this.host.logLinear(`Linear issues refreshed: count=${tasks.length}`); }
      } else {
        const tasks = await pullAllConnectedProviderTasks(this.host.context, input);
        this.host.logJira(`Jira tasks refreshed: count=${tasks.filter(t => t.sourceTool === 'jira').length}`);
        this.host.logLinear(`Linear issues refreshed: count=${tasks.filter(t => t.sourceTool === 'linear').length}`);
      }
      await this.refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (touchesJira) { this.host.logJira(`Jira task refresh failed: ${msg}`); }
      if (touchesLinear) { this.host.logLinear(`Linear issue refresh failed: ${msg}`); }
      vscode.window.showWarningMessage(`Task pull failed: ${msg}`);
      // Keep the previously cached list visible; the sync state surfaces the error.
      await this.refreshTasksContext(true);
    }
  }

  jiraKeyFromTaskId(taskId: string): string {
    return taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
  }

  pmTaskLabel(taskId: string): string {
    return taskId.replace(/^(linear|jira|asana|notion|monday):/i, '');
  }

  jiraKeyFromUrl(url: string): string {
    const match = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(url);
    return match ? match[1] : '';
  }

  classifyJiraConnectError(message: string): string {
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

  classifyLinearConnectError(message: string): string {
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

  async connectPmTool(tool: TynePmTool): Promise<void> {
    if (!tool) { return; }

    if ((tool === 'jira' || tool === 'linear') && !(await this.host.isGithubConnected())) {
      if (tool === 'jira') { this.host.logJira('Connect blocked: GitHub is not connected.'); }
      if (tool === 'linear') { this.host.logLinear('Connect blocked: GitHub is not connected.'); }
      const message = `Connect GitHub first to use ${tool === 'jira' ? 'Jira' : 'Linear'}.`;
      vscode.window.showErrorMessage(message);
      this.host.postMessage({ type: 'pmConnectFailed', tool, message, needsGithub: true });
      return;
    }

    const tier = this.host.userProfile?.tier ?? 'CORE';
    const canConnect = await canConnectProvider(this.host.context, tier, tool);
    if (!canConnect) {
      vscode.window.showWarningMessage('Free plan supports one PM tool. Upgrade to Pro or Max to connect all PM tools.');
      this.host.postMessage({ type: 'pmConnectBlocked', tool, reason: 'tier_limit' });
      return;
    }

    try {
      if (tool === 'jira') { this.host.logJira('Starting Jira connection (hosted OAuth)…'); }
      if (tool === 'linear') { this.host.logLinear('Starting Linear connection...'); }
      this.host.postMessage({ type: 'pmConnecting', tool });
      const result = await connectTool(this.host.context, tool, tier);
      if (result.ok) {
        if (tool === 'jira') { this.host.logJira('Jira connected successfully.'); }
        if (tool === 'linear') { this.host.logLinear('Linear connected successfully'); }
        const jiraIntegration = await getJiraIntegrationSnapshot(this.host.context);
        const pmIntegration = await this.buildPmIntegrationSnapshot(jiraIntegration);
        // #region agent log
        this.host.agentDebugLog({
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
        this.host.postMessage({
          type: 'pmConnectSuccess',
          tool,
          jiraIntegration,
          pmIntegration,
          connectedTools: pmIntegration.connectedTools,
        });
        await this.postIntegrationState();
        if (tool === 'jira') {
          const adapter = getAdapter('jira') as unknown as { chooseAndSaveProject?: () => Promise<unknown> };
          const snap = await getJiraIntegrationSnapshot(this.host.context);
          if (!snap.selectedProject?.projectKey) {
            this.host.logJira('No Jira project mapped yet — prompting project picker.');
            await adapter.chooseAndSaveProject?.();
          }
        }
        if (result.warning) {
          vscode.window.showWarningMessage(result.warning);
        } else {
          vscode.window.showInformationMessage(`Connected to ${tool}. Pulling tasks…`);
        }
        await this.pullTasks(tool);
      } else {
        if (tool === 'jira') { this.host.logJira(`Jira connection not completed: ${result.message}`); }
        if (tool === 'linear') { this.host.logLinear(`Linear connection not completed: ${result.message}`); }
        vscode.window.showWarningMessage(result.message);
        this.host.postMessage({ type: 'pmConnectFailed', tool, message: result.message });
      }
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      if (tool === 'jira') {
        if (err instanceof JiraOAuthStateError) {
          this.host.logJira(`Jira OAuth state failed: status=${err.status} error=${err.backendError}`);
        } else {
          this.host.logJira(`Jira connection failed: ${raw}`);
        }
        const friendly = this.classifyJiraConnectError(raw);
        void vscode.window.showErrorMessage(friendly, 'Open Tyne logs').then(choice => {
          if (choice === 'Open Tyne logs') { this.host.jiraLog.show(true); }
        });
        this.host.postMessage({ type: 'pmConnectFailed', tool, message: friendly });
      } else if (tool === 'linear') {
        if (err instanceof LinearOAuthStateError) {
          this.host.logLinear(`Linear OAuth state failed: status=${err.status} error=${err.backendError}`);
        } else {
          this.host.logLinear(`Linear connection failed: ${raw}`);
        }
        const friendly = this.classifyLinearConnectError(raw);
        void vscode.window.showErrorMessage(friendly, 'Open Tyne logs').then(choice => {
          if (choice === 'Open Tyne logs') { this.host.jiraLog.show(true); }
        });
        this.host.postMessage({ type: 'pmConnectFailed', tool, message: friendly });
      } else {
        vscode.window.showErrorMessage(`Could not connect ${tool}: ${raw}`);
        this.host.postMessage({ type: 'pmConnectFailed', tool, message: raw });
      }
    }

    try { await this.host.postSettings(); } catch (e) { console.error('Tyne: _postSettings after connect failed', e); }
    try { await this.refreshTasksContext(true); } catch (e) { console.error('Tyne: _refreshTasksContext after connect failed', e); }
  }

  async disconnectPmTool(tool: TynePmTool): Promise<void> {
    if (!tool) { return; }
    const pick = await vscode.window.showWarningMessage(
      `Disconnect ${tool}? Cached tasks will be kept locally.`, 'Yes, disconnect', 'Cancel',
    );
    if (pick !== 'Yes, disconnect') { return; }
    await disconnectTool(this.host.context, tool);
    this.effectiveConnectedTools = getConnectedToolsSync(this.host.context);
    vscode.window.showInformationMessage(`Disconnected from ${tool}.`);
    await this.postIntegrationState();
    await this.host.postSettings();
    await this.refreshTasksContext(true);
  }

  async openTaskDetail(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId || !tool) { return; }
    if (tool === 'jira') { this.host.logJira(`Selected Jira task: ${this.jiraKeyFromTaskId(taskId)}`); }
    if (tool === 'linear') { this.host.logLinear(`Selected Linear issue: ${taskId.replace(/^linear:/, '')}`); }
    const cached = getCachedTaskDetailsSync(this.host.context, taskId);
    if (cached) {
      this.host.postMessage({ type: 'taskDetailLoaded', details: cached });
    }
    // An epic that was already decomposed reopens on its generated tasks.
    this.host.postStoredDecompositionIfAny(taskId);
    try {
      const online = await isOnline();
      if (!online) {
        if (!cached) {
          this.host.postMessage({ type: 'taskDetailLoaded', details: null, taskId, offline: true });
        } else {
          await this.host.ensurePmIntelligencePosted(taskId, cached.pmIntelligence);
        }
        return;
      }
      const details = await pullTaskDetails(this.host.context, taskId, tool);
      this.host.postMessage({ type: 'taskDetailLoaded', details });
      // Selecting a task should surface proof points — reuse cache or extract once.
      await this.host.ensurePmIntelligencePosted(taskId, details?.pmIntelligence);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!cached) {
        this.host.postMessage({ type: 'taskDetailError', taskId, message: msg });
      }
    }
  }

  handleQueryTasks(query: string, filters: TyneTaskFilters, sort: TyneTaskSort): void {
    const all = this.getVisibleCachedTasks();
    const effective = sort ?? DEFAULT_TASK_SORT;
    const result = searchQueryTasks(all, query ?? '', filters ?? {}, effective);
    this.host.postMessage({
      type: 'tasksQueryResult',
      tasks: this.rankTasksForView(result, effective.key),
      rankMode: effective.key === 'recommended',
    });
  }

  queryTasksAdvanced(
    query: string,
    filters: TyneAdvancedTaskFilters,
    sort: TyneAdvancedTaskSort,
  ): void {
    const connectedTools = this.effectiveConnectedTools.length ? this.effectiveConnectedTools : getConnectedToolsSync(this.host.context);
    const all = filterTasksForConnectedTools(getUnifiedTaskListSync(this.host.context), connectedTools);
    const effective = sort ?? DEFAULT_ADVANCED_SORT;
    const sortKey = effective.rules?.[0]?.key;
    const { tasks, parseErrors } = queryTasksAdvanced(
      all,
      query ?? '',
      filters ?? {},
      effective,
    );
    this.host.postMessage({
      type: 'tasksQueryResult',
      tasks: this.rankTasksForView(tasks, sortKey),
      parseErrors,
      rankMode: sortKey === 'recommended',
    });
  }

  listPresets(): void {
    const presets = listPresetsSync(this.host.context);
    this.host.postMessage({ type: 'presetsLoaded', presets });
  }

  async handleSavePreset(msg: unknown): Promise<void> {
    const m = msg as { name?: string; query?: string; filters?: TyneAdvancedTaskFilters; sort?: TyneAdvancedTaskSort; isDefault?: boolean };
    try {
      const preset = await savePresetToStore(this.host.context, {
        name: m.name ?? 'Untitled Preset',
        query: m.query,
        filters: m.filters ?? {},
        sort: m.sort ?? DEFAULT_ADVANCED_SORT,
        isDefault: m.isDefault,
      });
      this.listPresets();
      this.host.postMessage({ type: 'presetSaved', preset });
      vscode.window.showInformationMessage(`Filter preset "${preset.name}" saved.`);
    } catch (err: unknown) {
      this.host.postMessage({ type: 'presetError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleRenamePreset(id: string, name: string): Promise<void> {
    try {
      await renamePresetInStore(this.host.context, id, name);
      this.listPresets();
    } catch (err: unknown) {
      this.host.postMessage({ type: 'presetError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async handleDeletePreset(id: string): Promise<void> {
    await deletePresetFromStore(this.host.context, id);
    this.listPresets();
    vscode.window.showInformationMessage('Filter preset deleted.');
  }

  async handleSetDefaultPreset(id: string): Promise<void> {
    await setDefaultPresetInStore(this.host.context, id);
    this.listPresets();
  }

  applyPreset(id: string): void {
    const presets = listPresetsSync(this.host.context);
    const preset = presets.find(p => p.id === id);
    if (!preset) { this.host.postMessage({ type: 'presetError', message: `Preset not found.` }); return; }
    this.host.postMessage({ type: 'presetApplied', preset });
    this.queryTasksAdvanced(preset.query ?? '', preset.filters, preset.sort);
  }

  async createTask(input: TyneCreateTaskInput): Promise<void> {
    const tier = this.host.userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this.host.postMessage({ type: 'taskWriteBlocked', reason: 'Creating tasks is available in Pro and Max.' });
      return;
    }
    try {
      const details = await pmCreateTask(this.host.context, tier, input);
      this.host.postMessage({ type: 'taskCreated', details });
      vscode.window.showInformationMessage(`Task created: ${details.title}`);
      await this.refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Create task failed: ${msg}`);
    }
  }

  async updateTask(taskId: string, sourceTool: TynePmTool, input: TyneUpdateTaskInput): Promise<void> {
    const tier = this.host.userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this.host.postMessage({ type: 'taskWriteBlocked', reason: 'Editing tasks is available in Pro and Max.' });
      return;
    }
    try {
      const details = await pmUpdateTask(this.host.context, tier, taskId, sourceTool, input);
      this.host.postMessage({ type: 'taskUpdated', details });
      vscode.window.showInformationMessage(`Task updated.`);
      await this.openTaskDetail(taskId, sourceTool);
      // Same enrichment path as Start Thread / Thread field edits when this is
      // the active thread task (or after edit, sync thread brief if loaded).
      if (this.host.state.taskId === taskId) {
        if (input.title) { this.host.state.taskTitle = input.title; this.host.state.goal = input.title; }
        if (input.description) { this.host.state.goal = input.description; }
        await this.host.runEnrichmentForActiveThreadTask('task_update');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Update task failed: ${msg}`);
    }
  }

  async addSubtask(
    taskId: string, sourceTool: TynePmTool,
    input: { title: string; assigneeId?: string; dueDate?: string },
  ): Promise<void> {
    const tier = this.host.userProfile?.tier ?? 'CORE';
    try {
      const subtask = await pmAddSubtask(this.host.context, tier, taskId, sourceTool, input);
      this.host.postMessage({ type: 'subtaskAdded', taskId, subtask });
    } catch (err: unknown) {
      this.host.postMessage({ type: 'taskWriteError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async addComment(taskId: string, sourceTool: TynePmTool, body: string): Promise<void> {
    const tier = this.host.userProfile?.tier ?? 'CORE';
    try {
      const comment = await pmAddComment(this.host.context, tier, taskId, sourceTool, body);
      this.host.postMessage({ type: 'commentAdded', taskId, comment });
    } catch (err: unknown) {
      this.host.postMessage({ type: 'taskWriteError', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async checkCapabilities(tool: TynePmTool): Promise<void> {
    try {
      const capabilities = await getAdapter(tool).getCapabilities();
      this.host.postMessage({ type: 'capabilitiesLoaded', tool, capabilities });
    } catch (err: unknown) {
      this.host.postMessage({ type: 'capabilitiesLoaded', tool, capabilities: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async detectConflict(taskId: string, tool: TynePmTool): Promise<void> {
    const conflict = await detectTaskEditConflict(taskId, tool);
    this.host.postMessage({ type: 'conflictCheckResult', taskId, conflict });
  }
}
