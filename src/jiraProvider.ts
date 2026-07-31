import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
  TyneNormalizedTaskPriority,
  TyneNormalizedTaskStatus,
  TynePullTasksInput,
  TyneTask,
  TyneTaskComment,
  TyneTaskDetails,
  TyneTaskHistoryEvent,
  TyneTaskProviderCapabilities,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
  TyneSubtask,
  TyneTaskProviderUpdateEvent,
} from './taskTypes';
import { getTaskProviderRuntimeContext } from './taskProviderRuntime';
import { JiraOAuthSite, startHostedJiraOAuth } from './jiraOAuth';
import { inferJiraProjectKey, sortJiraProjectsForSuggestion } from './jiraOAuthSecurity';
import { jiraDocToPlainText } from './jiraTextUtils';

const SECRET_KEY = 'tyne_jira_oauth';
const ISSUE_CACHE_KEY = 'tyne.jira.issueCache';
const PROJECT_MAPPING_KEY = 'tyne.jira.projectMapping';
const RECONNECT_KEY = 'tyne.jira.reconnectRequired';
/** Set on explicit Disconnect so hosted recover cannot silently reconnect. */
const USER_DISCONNECTED_KEY = 'tyne.jira.userDisconnected';
const ISSUE_CACHE_TTL_MS = 5 * 60 * 1000;
const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const LIST_PROJECTS_FUNCTION_PATH = '/functions/v1/list-jira-projects';
const SAVE_PROJECT_MAPPING_FUNCTION_PATH = '/functions/v1/save-jira-project-mapping';
const JIRA_API_REQUEST_FUNCTION_PATH = '/functions/v1/jira-api-request';

interface JiraTokenBundle {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  cloudId: string;
  siteName?: string;
  siteUrl?: string;
  availableSites?: JiraOAuthSite[];
  scope?: string;
  accountEmail?: string;
  accountName?: string;
  serverManaged?: boolean;
}

interface JiraSearchResponse {
  issues: JiraIssue[];
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: JiraDoc;
    status?: { name?: string; statusCategory?: { name?: string } };
    issuetype?: { name?: string; iconUrl?: string; subtask?: boolean };
    priority?: { name?: string };
    assignee?: { displayName?: string; emailAddress?: string; avatarUrls?: Record<string, string> };
    project?: { key?: string; name?: string };
    labels?: string[];
    parent?: { key?: string; fields?: { summary?: string; issuetype?: { name?: string } } };
    created?: string;
    updated?: string;
    duedate?: string | null;
    subtasks?: Array<{
      id: string;
      key: string;
      fields?: { summary?: string; status?: { name?: string } };
    }>;
    comment?: { comments?: JiraComment[] };
  };
  changelog?: {
    histories?: Array<{
      id: string;
      author?: { displayName?: string };
      created?: string;
      items?: Array<{ field?: string; fromString?: string; toString?: string }>;
    }>;
  };
}

interface JiraComment {
  id: string;
  body?: JiraDoc;
  author?: { displayName?: string; avatarUrls?: Record<string, string> };
  created?: string;
  updated?: string;
}

interface JiraAccessibleResource {
  id: string;
  url: string;
  name: string;
}

interface JiraTransitionResponse {
  transitions?: Array<{
    id: string;
    name: string;
    to?: { name?: string };
  }>;
}

interface JiraCurrentUser {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
}

interface JiraIssueCacheEntry {
  signature: string;
  fetchedAt: number;
  tasks: TyneTask[];
}

interface HostedJiraProjectsPayload {
  cloud_id?: unknown;
  site_name?: unknown;
  site_url?: unknown;
  projects?: unknown;
}

export interface JiraIntegrationSnapshot {
  configured: boolean;
  connected: boolean;
  githubConnected: boolean;
  reconnectRequired: boolean;
  cloudId: string;
  siteName?: string;
  siteUrl?: string;
  projectKeys: string[];
  selectedProject?: JiraProjectMapping;
  assignedToMe: boolean;
  accountEmail?: string;
  accountName?: string;
}

interface JiraDoc {
  type?: string;
  text?: string;
  content?: JiraDoc[];
}

export interface JiraProjectOption {
  id: string;
  key: string;
  name: string;
  avatarUrl?: string;
  style?: string;
  simplified?: boolean;
  cloudId: string;
  siteName?: string;
  siteUrl?: string;
}

export interface JiraProjectMapping {
  repositoryId: string;
  repositoryName?: string;
  workspacePathHash?: string;
  cloudId: string;
  siteName?: string;
  siteUrl?: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  projectAvatarUrl?: string;
}

export class JiraProvider {
  private _connected = false;

  constructor(
    private readonly normalizeStatus: (status: string) => TyneNormalizedTaskStatus,
    private readonly normalizePriority: (priority?: string) => TyneNormalizedTaskPriority,
  ) {}

  async connect(): Promise<{ connected: boolean; errorMessage?: string }> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      return { connected: false, errorMessage: 'Tyne is still starting. Try Connect again in a moment.' };
    }

    const config = this._getConfig();
    const token = await startHostedJiraOAuth(context, config.supabaseUrl);
    const cloudId = token.cloudId || token.availableSites?.[0]?.cloudId || '';
    if (!cloudId) {
      return { connected: false, errorMessage: 'Jira connected, but no Jira site was found for this Atlassian account.' };
    }
    const siteUrl = token.siteUrl || token.availableSites?.find(site => site.cloudId === cloudId)?.siteUrl || (token.accessToken ? await this._resolveSiteUrl(token.accessToken, cloudId).catch(() => undefined) : undefined);
    const siteName = token.siteName || token.availableSites?.find(site => site.cloudId === cloudId)?.siteName;
    const profile = token.accountEmail || token.accountName
      ? { emailAddress: token.accountEmail, displayName: token.accountName }
      : token.accessToken ? await this._resolveCurrentUser(token.accessToken, cloudId).catch(() => null) : null;
    const bundle: JiraTokenBundle = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
      cloudId,
      siteName,
      siteUrl,
      availableSites: token.availableSites,
      scope: token.scope,
      accountEmail: profile?.emailAddress,
      accountName: profile?.displayName,
      serverManaged: token.serverManaged,
    };
    await context.secrets.store(SECRET_KEY, JSON.stringify(bundle));
    await context.workspaceState.update(USER_DISCONNECTED_KEY, undefined);
    await this._setReconnectRequired(false);
    this._connected = true;
    const existingMapping = context.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const projectWarning = existingMapping
      ? undefined
      : 'Jira connected. Use "Change Project" to pick a Jira project for this repository.';
    return { connected: true, errorMessage: projectWarning };
  }

  async disconnect(): Promise<void> {
    const context = getTaskProviderRuntimeContext();
    this._connected = false;
    if (context) {
      await context.secrets.delete(SECRET_KEY);
      await context.workspaceState.update(ISSUE_CACHE_KEY, undefined);
      await context.workspaceState.update(PROJECT_MAPPING_KEY, undefined);
      await context.workspaceState.update(RECONNECT_KEY, undefined);
      await context.workspaceState.update(USER_DISCONNECTED_KEY, true);
    }
  }

  async isConnected(): Promise<boolean> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return this._connected; }
    if (context.workspaceState.get<boolean>(USER_DISCONNECTED_KEY, false)) {
      return false;
    }
    if (await context.secrets.get(SECRET_KEY)) {
      return true;
    }
    return Boolean(await recoverHostedJiraConnection(context, this._getConfig()));
  }

  async chooseAndSaveProject(): Promise<JiraProjectMapping | null> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return null; }
    const projects = await this.listProjects();
    if (!projects.length) {
      vscode.window.showWarningMessage('Jira connected, but no Jira projects were found for this site.');
      return null;
    }

    const suggestedKey = await suggestJiraProjectKey();
    const sorted = sortJiraProjectsForSuggestion(projects, suggestedKey);
    const selected = sorted.length === 1
      ? sorted[0]
      : await vscode.window.showQuickPick(
          sorted.map(project => ({
            label: `${project.key} — ${project.name}`,
            description: project.siteName || project.siteUrl,
            detail: suggestedKey && project.key.toUpperCase() === suggestedKey ? 'Suggested from branch/repository' : undefined,
            project,
          })),
          { placeHolder: 'Choose Jira project for this repository', ignoreFocusOut: true },
        ).then(item => item?.project);

    if (!selected) { return null; }
    const mapping = await this.saveProjectMapping(selected);
    vscode.window.showInformationMessage(`Jira connected: ${mapping.projectKey} · ${mapping.projectName}`);
    return mapping;
  }

  private async _hostedAuthToken(): Promise<string> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Jira provider runtime is not initialized.');
    }
    const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
    const token = await getEffectiveAuthToken(context);
    if (!token) {
      throw new Error('Sign in to Tyne before using Jira.');
    }
    return token;
  }

  async listProjects(cloudId?: string): Promise<JiraProjectOption[]> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return []; }
    const authToken = await this._hostedAuthToken();
    const config = this._getConfig();
    const params = cloudId ? `?${new URLSearchParams({ cloud_id: cloudId }).toString()}` : '';
    const response = await fetch(`${config.supabaseUrl}${LIST_PROJECTS_FUNCTION_PATH}${params}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Accept': 'application/json',
      },
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      throw new Error(`Failed to list Jira projects (${response.status}).`);
    }
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    return projects.map(project => normalizeJiraProjectOption(project as Record<string, unknown>)).filter((project): project is JiraProjectOption => Boolean(project));
  }

  async saveProjectMapping(project: JiraProjectOption): Promise<JiraProjectMapping> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Jira provider runtime is not initialized.');
    }
    const authToken = await this._hostedAuthToken();
    const repo = getRepositoryIdentity();
    const config = this._getConfig();
    const response = await fetch(`${config.supabaseUrl}${SAVE_PROJECT_MAPPING_FUNCTION_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        repository_id: repo.repositoryId,
        repository_name: repo.repositoryName,
        workspace_path_hash: repo.workspacePathHash,
        cloud_id: project.cloudId,
        project_id: project.id,
        project_key: project.key,
        project_name: project.name,
        project_avatar_url: project.avatarUrl,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload || typeof payload.mapping !== 'object' || !payload.mapping) {
      throw new Error(`Failed to save Jira project mapping (${response.status}).`);
    }
    const mapping = normalizeJiraProjectMapping(payload.mapping as Record<string, unknown>);
    await context.workspaceState.update(PROJECT_MAPPING_KEY, mapping);
    return mapping;
  }

  async pullTasks(input: TynePullTasksInput = {}): Promise<TyneTask[]> {
    const config = this._getConfig();
    const bundle = await this._getBundle(true);
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const cacheSignature = this._buildCacheSignature(config, input, bundle);
    const cached = context ? this._readIssueCache(context, cacheSignature) : null;
    // Honour the short-lived issue cache only for passive/background pulls. An
    // explicit refresh (forceRefresh) must always re-query Jira so reassignment
    // changes are reflected — the cache is still retained below as an offline
    // fallback when the live request fails.
    if (!input.forceRefresh && cached && Date.now() - cached.fetchedAt < ISSUE_CACHE_TTL_MS) {
      return cached.tasks.map(task => ({ ...task, lastSyncedAt: new Date(cached.fetchedAt).toISOString(), cachedAt: new Date().toISOString(), isCachedOnly: false }));
    }
    const jql = this._buildJql(config, input);
    try {
      // Atlassian deprecated GET /rest/api/3/search in favour of /rest/api/3/search/jql.
      const response = await this._jiraGet<JiraSearchResponse>(
        `/rest/api/3/search/jql?${new URLSearchParams({
          jql,
          fields: 'summary,description,status,issuetype,priority,assignee,project,labels,parent,created,updated,duedate',
          maxResults: '100',
        }).toString()}`,
      );
      const tasks = (response.issues || []).map(issue => this._mapIssueToTask(issue, mapping?.cloudId || bundle.cloudId, mapping?.siteUrl || bundle.siteUrl));
      if (context) {
        this._writeIssueCache(context, cacheSignature, tasks);
      }
      await this._setReconnectRequired(false);
      return tasks;
    } catch (err) {
      await this._notePullError(err);
      const message = err instanceof Error ? err.message : String(err);
      if (cached?.tasks.length) {
        throw new JiraCachedTasksError(
          this._toFriendlyPullError(message),
          cached.tasks.map(task => ({ ...task, isCachedOnly: true, lastSyncedAt: new Date(cached.fetchedAt).toISOString(), cachedAt: new Date().toISOString() })),
        );
      }
      const friendly = this._classifyJiraStatus(message);
      throw friendly ? new Error(friendly) : err;
    }
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    const issueKey = this._issueKey(taskId);
    const bundle = await this._getBundle(true);
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const issue = await this._jiraGet<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?${new URLSearchParams({
        fields: 'summary,description,status,issuetype,priority,assignee,project,labels,parent,created,updated,duedate,subtasks,comment',
        expand: 'changelog',
      }).toString()}`,
    );
    const task = this._mapIssueToTask(issue, mapping?.cloudId || bundle.cloudId, mapping?.siteUrl || bundle.siteUrl);
    return {
      ...task,
      subtasks: this._mapSubtasks(issue),
      comments: this._mapComments(issue.fields.comment?.comments || []),
      notes: [],
      historyLast30Days: this._mapHistory(issue),
    };
  }

  async getTaskComments(taskId: string): Promise<TyneTaskComment[]> {
    const issueKey = this._issueKey(taskId);
    const data = await this._jiraGet<{ comments?: JiraComment[] }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
    return this._mapComments(data.comments || []);
  }

  async getTaskHistoryLast30Days(taskId: string): Promise<TyneTaskHistoryEvent[]> {
    const issueKey = this._issueKey(taskId);
    const issue = await this._jiraGet<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=changelog&fields=summary`);
    return this._mapHistory(issue);
  }

  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return {
      canCreateTask: false,
      canEditTitle: false,
      canEditDescription: false,
      canEditStatus: false,
      canEditPriority: false,
      canEditAssignee: false,
      canEditDueDate: false,
      canEditLabels: false,
      canAddSubtask: false,
      canEditSubtask: false,
      canAddComment: false,
      supportsRealtimeEvents: false,
      supportsTaskHistory: true,
      supportsLabels: true,
      supportsSprints: true,
      supportsMilestones: true,
    };
  }

  async createTask(_input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    throw new Error('Jira task creation is not implemented yet.');
  }

  async updateTask(_taskId: string, _input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    throw new Error('Jira task updates are not implemented yet.');
  }

  async addSubtask(_taskId: string, _input: { title: string }): Promise<TyneSubtask> {
    throw new Error('Jira subtasks are not implemented yet.');
  }

  /**
   * Create real Jira child issues under a parent Story/Epic.
   * Stories get Sub-tasks; Epics get Story/Task (Jira rejects Sub-task under Epic).
   */
  async createSubtaskIssues(
    parentTaskId: string,
    subtasks: Array<{ title: string; description?: string; dueDate?: string }>,
  ): Promise<Array<{ key: string; url?: string }>> {
    const parentKey = this._issueKey(parentTaskId);
    const projectKey = parentKey.split('-')[0];
    const parentMeta = await this._jiraGet<{ fields?: { issuetype?: { name?: string } } }>(
      `/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=issuetype`,
    );
    const parentType = parentMeta.fields?.issuetype?.name || '';
    const underEpic = /epic/i.test(parentType);
    const issueTypeId = underEpic
      ? await this._findStandardChildIssueTypeId(projectKey)
      : await this._findSubtaskIssueTypeId(projectKey);

    const bundle = await this._getBundle(true);
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const siteUrl = (mapping?.siteUrl || bundle.siteUrl || '').replace(/\/+$/, '');
    // Assign to self so assignee=currentUser() pulls pick them up on the Task page.
    const me = await this._jiraGet<JiraCurrentUser>('/rest/api/3/myself').catch(() => null);

    const created: Array<{ key: string; url?: string }> = [];
    for (const subtask of subtasks) {
      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        parent: { key: parentKey },
        issuetype: { id: issueTypeId },
        summary: subtask.title,
        ...(subtask.description ? { description: plainTextToAdf(subtask.description) } : {}),
        // Jira's duedate is a bare calendar date; anything else is rejected.
        ...(subtask.dueDate ? { duedate: subtask.dueDate } : {}),
      };
      if (me?.accountId) { fields.assignee = { accountId: me.accountId }; }
      const payload = await this._jiraRequest<{ key: string }>(
        'POST',
        '/rest/api/3/issue',
        { body: { fields } },
      );
      created.push({
        key: payload.key,
        url: siteUrl ? `${siteUrl}/browse/${payload.key}` : undefined,
      });
    }
    return created;
  }

  private async _listCreatableIssueTypes(
    projectKey: string,
  ): Promise<Array<{ id: string; name?: string; subtask?: boolean }>> {
    try {
      const meta = await this._jiraGet<{ issueTypes?: Array<{ id: string; name?: string; subtask?: boolean }> }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      );
      if (meta.issueTypes?.length) { return meta.issueTypes; }
    } catch {
      // fall through to legacy endpoint
    }
    const legacy = await this._jiraGet<{ projects?: Array<{ issuetypes?: Array<{ id: string; name?: string; subtask?: boolean }> }> }>(
      `/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}`,
    );
    return legacy.projects?.[0]?.issuetypes || [];
  }

  private async _findSubtaskIssueTypeId(projectKey: string): Promise<string> {
    const match = (await this._listCreatableIssueTypes(projectKey)).find(t => t.subtask);
    if (!match) {
      throw new Error(`Project ${projectKey} has no sub-task issue type. Enable sub-tasks in Jira settings.`);
    }
    return match.id;
  }

  /** Non-subtask child for Epics — prefer Story, then Task, then any non-subtask/non-epic. */
  private async _findStandardChildIssueTypeId(projectKey: string): Promise<string> {
    const types = (await this._listCreatableIssueTypes(projectKey)).filter(t => !t.subtask && !/epic/i.test(t.name || ''));
    const preferred = types.find(t => /^(story|task)$/i.test(t.name || '')) || types[0];
    if (!preferred) {
      throw new Error(`Project ${projectKey} has no Story/Task issue type to create under an Epic.`);
    }
    return preferred.id;
  }

  async updateSubtask(_taskId: string, _subtaskId: string, _input: Partial<TyneSubtask>): Promise<TyneSubtask> {
    throw new Error('Jira subtasks are not implemented yet.');
  }

  async addComment(taskId: string, body: string): Promise<TyneTaskComment> {
    const issueKey = this._issueKey(taskId);
    const payload = await this._jiraRequest<{ id: string; created?: string; updated?: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        body: {
          body: plainTextToAdf(body),
        },
      },
    );
    return {
      id: payload.id,
      body,
      createdAt: payload.created,
      updatedAt: payload.updated,
      sourceTool: 'jira',
    };
  }

  async subscribeToTaskUpdates(_callback: (event: TyneTaskProviderUpdateEvent) => void): Promise<() => void> {
    return () => undefined;
  }

  async addWorklog(taskId: string, input: { started: string; timeSpentSeconds: number }): Promise<{ worklogId: string }> {
    const issueKey = this._issueKey(taskId);
    const payload = await this._jiraRequest<{ id: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
      {
        body: {
          started: formatJiraDateTime(input.started),
          timeSpentSeconds: input.timeSpentSeconds,
        },
      },
    );
    return { worklogId: payload.id };
  }

  async listTransitions(taskId: string): Promise<Array<{ id: string; name: string; toStatus?: string }>> {
    const issueKey = this._issueKey(taskId);
    const payload = await this._jiraGet<JiraTransitionResponse>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    return (payload.transitions || []).map(transition => ({
      id: transition.id,
      name: transition.name,
      toStatus: transition.to?.name,
    }));
  }

  async transitionTask(taskId: string, transitionId: string): Promise<{ transitionName: string }> {
    const issueKey = this._issueKey(taskId);
    const transitions = await this.listTransitions(taskId);
    const matched = transitions.find(transition => transition.id === transitionId);
    await this._jiraRequest(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      { body: { transition: { id: transitionId } }, expectJson: false },
    );
    return { transitionName: matched?.name || 'transition' };
  }

  private async _jiraGet<T>(path: string): Promise<T> {
    return this._jiraRequest<T>('GET', path);
  }

  private async _jiraRequest<T>(method: 'GET' | 'POST', path: string, options: { body?: unknown; expectJson?: boolean } = {}): Promise<T> {
    const config = this._getConfig();
    const bundle = await this._getBundle(true);
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const cloudId = mapping?.cloudId || bundle.cloudId;
    if (!cloudId) {
      throw new Error('Choose a Jira project before pulling Jira tasks.');
    }
    if (bundle.serverManaged || !bundle.accessToken) {
      return this._hostedJiraRequest<T>(method, path, options, cloudId);
    }
    const url = `https://api.atlassian.com/ex/jira/${cloudId}${path.startsWith('/') ? path : `/${path}`}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${bundle.accessToken}`,
        'Accept': 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' && options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 401) {
      const refreshed = await this._refreshBundle(bundle);
      const retry = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${refreshed.accessToken}`,
          'Accept': 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      return this._parseResponse<T>(retry, 'Jira API request failed after token refresh', options.expectJson ?? true);
    }

    return this._parseResponse<T>(response, 'Jira API request failed', options.expectJson ?? true);
  }

  private async _parseResponse<T>(response: Response, prefix: string, expectJson: boolean): Promise<T> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const truncated = body.length > 200 ? body.slice(0, 200) + '…' : body;
      throw new JiraApiError(`${prefix} (${response.status}): ${truncated || 'Unknown error'}`, response.status);
    }
    if (!expectJson) {
      return undefined as T;
    }
    return await response.json() as T;
  }

  private async _hostedJiraRequest<T>(method: 'GET' | 'POST', path: string, options: { body?: unknown; expectJson?: boolean }, cloudId: string): Promise<T> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Jira provider runtime is not initialized.');
    }
    const authToken = await this._hostedAuthToken();
    const response = await fetch(`${this._getConfig().supabaseUrl}${JIRA_API_REQUEST_FUNCTION_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        cloud_id: cloudId,
        method,
        path,
        body: options.body,
        expect_json: options.expectJson ?? true,
      }),
    });
    return this._parseResponse<T>(response, 'Hosted Jira API request failed', options.expectJson ?? true);
  }

  async getCloudId(): Promise<string> {
    const bundle = await this._getBundle(true);
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    return mapping?.cloudId || bundle.cloudId || '';
  }

  private async _getBundle(allowRefresh: boolean): Promise<JiraTokenBundle> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Jira provider runtime is not initialized.');
    }
    const raw = await context.secrets.get(SECRET_KEY);
    if (!raw) {
      const recovered = await recoverHostedJiraConnection(context, this._getConfig());
      if (recovered) {
        return recovered;
      }
      throw new Error('Jira is not connected. Connect Jira first.');
    }
    const bundle = JSON.parse(raw) as JiraTokenBundle;
    if (allowRefresh && bundle.expiresAt <= Date.now() + 60_000) {
      return await this._refreshBundle(bundle);
    }
    return bundle;
  }

  private async _refreshBundle(bundle: JiraTokenBundle): Promise<JiraTokenBundle> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Jira provider runtime is not initialized.');
    }
    // Server-managed tokens are refreshed by the Supabase backend on each
    // _hostedJiraRequest call. Return the bundle as-is so the caller can
    // proceed — the backend will reject with 401 if the session is truly dead.
    if (bundle.serverManaged) {
      return bundle;
    }
    if (!bundle.refreshToken) {
      await context.secrets.delete(SECRET_KEY);
      this._connected = false;
      throw new Error('Jira session expired. Reconnect Jira to continue.');
    }
    await context.secrets.delete(SECRET_KEY);
    this._connected = false;
    throw new Error('Jira session expired. Reconnect Jira to continue.');
  }

  private async _resolveSiteUrl(accessToken: string, cloudId: string): Promise<string | undefined> {
    const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) { return undefined; }
    const resources = await response.json() as JiraAccessibleResource[];
    return resources.find(resource => resource.id === cloudId)?.url;
  }

  private async _resolveCurrentUser(accessToken: string, cloudId: string): Promise<JiraCurrentUser | null> {
    const response = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) { return null; }
    return await response.json() as JiraCurrentUser;
  }

  private _mapIssueToTask(issue: JiraIssue, cloudId: string, siteUrl?: string): TyneTask {
    const fields = issue.fields || {};
    const status = fields.status?.name || 'Unknown';
    const priority = fields.priority?.name;
    const project = [fields.project?.key, fields.project?.name].filter(Boolean).join(' · ') || undefined;
    return {
      id: `jira:${issue.key}`,
      externalId: issue.key,
      title: fields.summary || issue.key,
      description: jiraDocToPlainText(fields.description),
      status,
      normalizedStatus: this.normalizeStatus(status),
      priority,
      normalizedPriority: this.normalizePriority(priority),
      assigneeName: fields.assignee?.displayName,
      assigneeEmail: fields.assignee?.emailAddress,
      assigneeAvatarUrl: fields.assignee?.avatarUrls?.['48x48'],
      sourceTool: 'jira',
      sourceProject: project,
      sourceUrl: siteUrl ? `${siteUrl}/browse/${issue.key}` : `https://api.atlassian.com/ex/jira/${cloudId}/browse/${issue.key}`,
      issueType: fields.issuetype?.name,
      issueTypeIconUrl: fields.issuetype?.iconUrl,
      statusCategory: fields.status?.statusCategory?.name,
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      parentKey: fields.parent?.key,
      parentTitle: fields.parent?.fields?.summary,
      createdAt: fields.created,
      updatedAt: fields.updated,
      dueDate: fields.duedate || undefined,
      lastSyncedAt: new Date().toISOString(),
      cachedAt: new Date().toISOString(),
      isCachedOnly: false,
    };
  }

  private _mapSubtasks(issue: JiraIssue): TyneSubtask[] {
    return (issue.fields.subtasks || []).map(subtask => ({
      id: `jira:${subtask.key}`,
      title: subtask.fields?.summary || subtask.key,
      status: subtask.fields?.status?.name,
      normalizedStatus: this.normalizeStatus(subtask.fields?.status?.name || ''),
    }));
  }

  private _mapComments(comments: JiraComment[]): TyneTaskComment[] {
    return comments.map(comment => ({
      id: comment.id,
      authorName: comment.author?.displayName,
      authorAvatarUrl: comment.author?.avatarUrls?.['48x48'],
      body: jiraDocToPlainText(comment.body),
      createdAt: comment.created,
      updatedAt: comment.updated,
      sourceTool: 'jira',
    }));
  }

  private _mapHistory(issue: JiraIssue): TyneTaskHistoryEvent[] {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const histories = issue.changelog?.histories || [];
    return histories
      .filter(history => history.created && new Date(history.created).getTime() >= since)
      .flatMap(history => (history.items || []).map((item, index) => ({
        id: `${history.id}:${index}`,
        type: item.field || 'changed',
        fromValue: item.fromString,
        toValue: item.toString,
        actorName: history.author?.displayName,
        createdAt: history.created || new Date().toISOString(),
        sourceTool: 'jira' as const,
      })));
  }

  private _buildJql(config: JiraConfig, input: TynePullTasksInput): string {
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    const clauses: string[] = [];
    const assignedOnly = input.assignedOnly ?? config.assignedToMe;
    if (assignedOnly) {
      clauses.push('assignee = currentUser()');
    }
    if (!(input.includeCompleted ?? false)) {
      // Keep the list focused on active work, but still surface recently-completed
      // issues so they appear under the "Done" section (and don't vanish on refresh
      // right after Tyne closes them) instead of being dropped entirely.
      clauses.push('(statusCategory != Done OR updated >= -14d)');
    }
    const projectKeys = mapping?.projectKey ? [mapping.projectKey] : config.projectKeys.filter(Boolean);
    if (projectKeys.length) {
      clauses.push(`project in (${projectKeys.map(key => `"${key}"`).join(', ')})`);
    }
    const base = clauses.join(' AND ');
    return base ? `${base} ORDER BY updated DESC` : 'ORDER BY updated DESC';
  }

  private _issueKey(taskId: string): string {
    return taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
  }

  private _buildCacheSignature(config: JiraConfig, input: TynePullTasksInput, bundle: JiraTokenBundle): string {
    const context = getTaskProviderRuntimeContext();
    const mapping = context?.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    return JSON.stringify({
      cloudId: mapping?.cloudId || bundle.cloudId,
      assignedOnly: input.assignedOnly ?? config.assignedToMe,
      includeCompleted: input.includeCompleted ?? false,
      updatedSinceDays: input.updatedSinceDays ?? null,
      projectKeys: mapping?.projectKey ? [mapping.projectKey] : [...config.projectKeys].sort(),
    });
  }

  private _readIssueCache(context: vscode.ExtensionContext, signature: string): JiraIssueCacheEntry | null {
    const raw = context.workspaceState.get<JiraIssueCacheEntry | null>(ISSUE_CACHE_KEY, null);
    if (!raw || raw.signature !== signature || !Array.isArray(raw.tasks)) { return null; }
    return raw;
  }

  private _writeIssueCache(context: vscode.ExtensionContext, signature: string, tasks: TyneTask[]): void {
    void context.workspaceState.update(ISSUE_CACHE_KEY, {
      signature,
      fetchedAt: Date.now(),
      tasks,
    } satisfies JiraIssueCacheEntry);
  }

  private _toFriendlyPullError(message: string): string {
    return this._classifyJiraStatus(message) || 'Network error. Showing last cached Jira issues.';
  }

  private _statusFromMessage(message: string): number {
    const match = message.match(/\((\d{3})\)/);
    return match ? Number(match[1]) : 0;
  }

  // Map an HTTP status (or known message) to a clear, actionable reconnect/error message.
  // Returns null when the failure is not a recognized auth/access/endpoint problem.
  private _classifyJiraStatus(message: string): string | null {
    const status = this._statusFromMessage(message);
    if (status === 401 || /session expired|reconnect jira|unauthorized/i.test(message)) {
      return 'Jira session expired. Reconnect Jira.';
    }
    if (status === 403) {
      return 'Tyne does not have access to this Jira project.';
    }
    if (status === 410) {
      return 'Jira API endpoint changed. Please update Tyne.';
    }
    if (/Jira request is not allowed/i.test(message)) {
      return 'Tyne blocked an unsupported Jira API request. Update the Jira API allowlist.';
    }
    return null;
  }

  private async _notePullError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof JiraApiError ? err.status : this._statusFromMessage(message);
    if (status === 401 || /session expired|reconnect jira|unauthorized/i.test(message)) {
      await this._setReconnectRequired(true);
    }
  }

  private async _setReconnectRequired(value: boolean): Promise<void> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return; }
    await context.workspaceState.update(RECONNECT_KEY, value ? true : undefined);
  }

  private _getConfig(): JiraConfig {
    const cfg = vscode.workspace.getConfiguration('tyne');
    return {
      projectKeys: cfg.get<string[]>('jira.projectKeys', []),
      assignedToMe: cfg.get<boolean>('jira.assignedToMe', true),
      supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
    };
  }
}

interface JiraConfig {
  projectKeys: string[];
  assignedToMe: boolean;
  supabaseUrl: string;
}

function readJiraTokenBundle(raw: string | undefined): JiraTokenBundle | null {
  if (!raw) { return null; }
  try {
    return JSON.parse(raw) as JiraTokenBundle;
  } catch {
    return null;
  }
}

export async function getJiraIntegrationSnapshot(context: vscode.ExtensionContext): Promise<JiraIntegrationSnapshot> {
    const config = getJiraConfigSnapshot();
    const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
    const githubConnected = Boolean(await getEffectiveAuthToken(context));
    const userDisconnected = Boolean(context.workspaceState.get<boolean>(USER_DISCONNECTED_KEY, false));
    const raw = userDisconnected ? undefined : await context.secrets.get(SECRET_KEY);
    const bundle = userDisconnected
      ? null
      : (readJiraTokenBundle(raw ?? undefined) ?? await recoverHostedJiraConnection(context, config));
    const mapping = context.workspaceState.get<JiraProjectMapping | undefined>(PROJECT_MAPPING_KEY);
    return {
      configured: Boolean(mapping?.projectKey || bundle?.cloudId),
      connected: Boolean(bundle),
      githubConnected,
    reconnectRequired: Boolean(bundle) && Boolean(context.workspaceState.get<boolean>(RECONNECT_KEY, false)),
    cloudId: mapping?.cloudId || bundle?.cloudId || '',
    siteName: mapping?.siteName || bundle?.siteName,
    siteUrl: mapping?.siteUrl || bundle?.siteUrl,
    projectKeys: mapping?.projectKey ? [mapping.projectKey] : [],
    selectedProject: mapping,
    assignedToMe: config.assignedToMe,
    accountEmail: bundle?.accountEmail,
    accountName: bundle?.accountName,
  };
}

export function getJiraConfigSnapshot(): JiraConfig {
  const cfg = vscode.workspace.getConfiguration('tyne');
  return {
    projectKeys: cfg.get<string[]>('jira.projectKeys', []),
    assignedToMe: cfg.get<boolean>('jira.assignedToMe', true),
    supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
  };
}

async function recoverHostedJiraConnection(context: vscode.ExtensionContext, config: JiraConfig): Promise<JiraTokenBundle | null> {
  if (context.workspaceState.get<boolean>(USER_DISCONNECTED_KEY, false)) {
    return null;
  }
  if (await context.secrets.get(SECRET_KEY)) {
    return null;
  }
  const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
  const authToken = await getEffectiveAuthToken(context);
  if (!authToken) {
    return null;
  }

  const response = await fetch(`${config.supabaseUrl}${LIST_PROJECTS_FUNCTION_PATH}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Machine-ID': vscode.env.machineId,
      'Accept': 'application/json',
    },
  });
  if (response.status === 404) {
    return null;
  }
  const payload = await response.json().catch(() => null) as HostedJiraProjectsPayload | null;
  if (!response.ok || !payload) {
    return null;
  }
  const cloudId = typeof payload.cloud_id === 'string' ? payload.cloud_id : '';
  if (!cloudId) {
    return null;
  }
  const siteName = typeof payload.site_name === 'string' ? payload.site_name : undefined;
  const siteUrl = typeof payload.site_url === 'string' ? payload.site_url : undefined;
  const bundle: JiraTokenBundle = {
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    cloudId,
    siteName,
    siteUrl,
    availableSites: [{ cloudId, siteName, siteUrl }],
    serverManaged: true,
  };
  await context.secrets.store(SECRET_KEY, JSON.stringify(bundle));
  await context.workspaceState.update(RECONNECT_KEY, undefined);
  return bundle;
}

export class JiraCachedTasksError extends Error {
  constructor(
    message: string,
    public readonly cachedTasks: TyneTask[],
  ) {
    super(message);
  }
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function normalizeJiraProjectOption(project: Record<string, unknown>): JiraProjectOption | null {
  const id = typeof project.id === 'string' ? project.id : '';
  const key = typeof project.key === 'string' ? project.key : '';
  const name = typeof project.name === 'string' ? project.name : '';
  const avatarUrls = typeof project.avatarUrls === 'object' && project.avatarUrls ? project.avatarUrls as Record<string, unknown> : {};
  const cloudId = typeof project.cloud_id === 'string' ? project.cloud_id : typeof project.cloudId === 'string' ? project.cloudId : '';
  if (!id || !key || !name || !cloudId) { return null; }
  return {
    id,
    key,
    name,
    avatarUrl: typeof avatarUrls['48x48'] === 'string' ? avatarUrls['48x48'] : typeof avatarUrls['32x32'] === 'string' ? avatarUrls['32x32'] : undefined,
    style: typeof project.style === 'string' ? project.style : undefined,
    simplified: typeof project.simplified === 'boolean' ? project.simplified : undefined,
    cloudId,
    siteName: typeof project.site_name === 'string' ? project.site_name : undefined,
    siteUrl: typeof project.site_url === 'string' ? project.site_url : undefined,
  };
}

function normalizeJiraProjectMapping(mapping: Record<string, unknown>): JiraProjectMapping {
  return {
    repositoryId: String(mapping.repository_id || mapping.repositoryId || ''),
    repositoryName: typeof mapping.repository_name === 'string' ? mapping.repository_name : typeof mapping.repositoryName === 'string' ? mapping.repositoryName : undefined,
    workspacePathHash: typeof mapping.workspace_path_hash === 'string' ? mapping.workspace_path_hash : typeof mapping.workspacePathHash === 'string' ? mapping.workspacePathHash : undefined,
    cloudId: String(mapping.cloud_id || mapping.cloudId || ''),
    siteName: typeof mapping.site_name === 'string' ? mapping.site_name : typeof mapping.siteName === 'string' ? mapping.siteName : undefined,
    siteUrl: typeof mapping.site_url === 'string' ? mapping.site_url : typeof mapping.siteUrl === 'string' ? mapping.siteUrl : undefined,
    projectId: String(mapping.project_id || mapping.projectId || ''),
    projectKey: String(mapping.project_key || mapping.projectKey || '').toUpperCase(),
    projectName: String(mapping.project_name || mapping.projectName || ''),
    projectAvatarUrl: typeof mapping.project_avatar_url === 'string' ? mapping.project_avatar_url : typeof mapping.projectAvatarUrl === 'string' ? mapping.projectAvatarUrl : undefined,
  };
}

async function suggestJiraProjectKey(): Promise<string | undefined> {
  const repoName = getRepositoryIdentity().repositoryName || '';
  const branchName = await getCurrentGitBranchName();
  return inferJiraProjectKey([branchName, repoName].filter(Boolean));
}

async function getCurrentGitBranchName(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return ''; }
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
    const api = gitExtension?.getAPI?.(1);
    const repo = api?.repositories?.find((candidate: { rootUri?: vscode.Uri }) => candidate.rootUri?.fsPath === folder.uri.fsPath) || api?.repositories?.[0];
    return repo?.state?.HEAD?.name || '';
  } catch {
    return '';
  }
}

function getRepositoryIdentity(): { repositoryId: string; repositoryName?: string; workspacePathHash?: string } {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = folder?.uri.fsPath || 'unknown-workspace';
  const repositoryName = folder?.name;
  const workspacePathHash = createHash('sha256').update(workspacePath).digest('hex');
  return {
    repositoryId: repositoryName ? `${repositoryName}:${workspacePathHash.slice(0, 16)}` : workspacePathHash,
    repositoryName,
    workspacePathHash,
  };
}

// Convert a plain-text comment (with newlines) into Atlassian Document Format so
// Jira renders paragraphs and line breaks instead of one long unbroken line.
// HTML report appendix (between markers) becomes an ADF codeBlock so PMs can copy it.
function plainTextToAdf(text: string): { type: 'doc'; version: 1; content: unknown[] } {
  const safe = (text ?? '').replace(/\r\n/g, '\n').trim();
  const htmlStart = '--- HTML report ---';
  const htmlEnd = '--- end HTML report ---';
  const start = safe.indexOf(htmlStart);
  const end = safe.indexOf(htmlEnd);
  let narrative = safe;
  let html = '';
  if (start >= 0 && end > start) {
    narrative = safe.slice(0, start).trim();
    html = safe.slice(start + htmlStart.length, end).trim()
      .replace(/^```html\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  const blocks = narrative ? narrative.split(/\n{2,}/) : [''];
  const content: unknown[] = blocks.map(block => {
    const lines = block.split('\n');
    const inner: unknown[] = [];
    lines.forEach((line, index) => {
      if (index > 0) { inner.push({ type: 'hardBreak' }); }
      if (line.length) { inner.push({ type: 'text', text: line }); }
    });
    return { type: 'paragraph', content: inner.length ? inner : [{ type: 'text', text: ' ' }] };
  });

  if (html) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'HTML report (copy into a browser / doc):', marks: [{ type: 'strong' }] }],
    });
    content.push({
      type: 'codeBlock',
      attrs: { language: 'html' },
      content: [{ type: 'text', text: html.slice(0, 100_000) }],
    });
  }

  return { type: 'doc', version: 1, content };
}

function formatJiraDateTime(value: string): string {
  const date = new Date(value);
  const pad = (num: number, width = 2) => String(Math.abs(num)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetMins = pad(Math.abs(offsetMinutes) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${offsetHours}${offsetMins}`;
}
