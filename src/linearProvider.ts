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
import { LinearOAuthTeam, LinearOAuthTokenResult, startHostedLinearOAuth } from './linearOAuth';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const SECRET_KEY = 'tyne_linear_oauth';
const TEAM_MAPPING_KEY = 'tyne.linear.teamMapping';
const ISSUE_CACHE_KEY = 'tyne.linear.issueCache';
const LINEAR_API_REQUEST_PATH = '/functions/v1/linear-api-request';
const LIST_TEAMS_FUNCTION_PATH = '/functions/v1/list-linear-teams';
const SAVE_TEAM_MAPPING_FUNCTION_PATH = '/functions/v1/save-linear-team-mapping';

function isLinearIssueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface LinearConnectionBundle {
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  expiresAt: number;
  availableTeams?: LinearOAuthTeam[];
  serverManaged?: boolean;
}

export interface LinearTeamMapping {
  repositoryId: string;
  repositoryName?: string;
  workspacePathHash?: string;
  workspaceId: string;
  workspaceName?: string;
  teamId: string;
  teamKey?: string;
  teamName: string;
}

export interface LinearIntegrationSnapshot {
  connected: boolean;
  workspaceId?: string;
  workspaceName?: string;
  selectedTeam?: LinearTeamMapping | null;
}

export interface LinearIssueState {
  id: string;
  name: string;
  color?: string;
  type?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  state: { id: string; name: string; type?: string };
  priority?: number;
  assignee?: { id: string; name?: string; email?: string };
  team?: { id: string; key?: string; name: string; states?: { nodes: LinearIssueState[] } };
  project?: { id: string; name: string } | null;
  cycle?: { id: string; name: string } | null;
  parent?: { id: string; identifier: string; title: string } | null;
  labels?: { nodes: Array<{ id: string; name: string }> };
  children?: { nodes: Array<{ id: string; identifier: string; title: string; state?: { name?: string } }> };
  comments?: { nodes: Array<{ id: string; body: string; createdAt?: string; updatedAt?: string; user?: { id: string; name?: string } }> };
  createdAt?: string;
  updatedAt?: string;
}

interface LinearIssueListResponse {
  issues: LinearIssue[];
}

function normalizeStatus(status: string): TyneNormalizedTaskStatus {
  const s = status.toLowerCase();
  if (s === 'todo' || s === 'backlog' || s === 'triage') { return 'todo'; }
  if (s.includes('progress') || s === 'started') { return 'in_progress'; }
  if (s.includes('review')) { return 'in_review'; }
  if (s === 'done' || s === 'completed') { return 'done'; }
  if (s === 'blocked') { return 'blocked'; }
  if (s === 'canceled' || s === 'cancelled') { return 'canceled'; }
  return 'unknown';
}

function normalizePriority(raw?: number): TyneNormalizedTaskPriority {
  switch (raw) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'low';
    case 0:
    default:
      return 'none';
  }
}

function getVscode(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

export class LinearProvider {
  private _connected = false;

  async connect(): Promise<{ connected: boolean; errorMessage?: string }> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      this._connected = true;
      return { connected: true };
    }

    const token = await startHostedLinearOAuth(context, this._getSupabaseUrl());
    const bundle: LinearConnectionBundle = {
      workspaceId: token.workspaceId,
      workspaceName: token.workspaceName,
      userId: token.userId,
      userEmail: token.userEmail,
      userName: token.userName,
      expiresAt: Date.now() + token.expiresIn * 1000,
      availableTeams: token.availableTeams,
      serverManaged: token.serverManaged,
    };

    await context.secrets.store(SECRET_KEY, JSON.stringify(bundle));
    this._connected = true;
    const teamMapping = await this.chooseAndSaveTeam(token.availableTeams);
    if (!teamMapping) {
      return { connected: true, errorMessage: 'Linear connected, but no team was selected. Use "Change Team" to pick a Linear team before pulling tasks.' };
    }
    return { connected: true };
  }

  async disconnect(): Promise<void> {
    const context = getTaskProviderRuntimeContext();
    this._connected = false;
    if (context) {
      await context.secrets.delete(SECRET_KEY);
      await context.workspaceState.update(TEAM_MAPPING_KEY, undefined);
      await context.workspaceState.update(ISSUE_CACHE_KEY, undefined);
    }
  }

  async isConnected(): Promise<boolean> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return this._connected; }
    return Boolean(await context.secrets.get(SECRET_KEY));
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    const id = issueId.replace(/^linear:/, '');
    const response = await this._api<{ issue: LinearIssue }>('getIssueDetail', { id });
    if (!response.issue) {
      throw new Error(`Linear issue ${id} not found.`);
    }
    return response.issue;
  }

  async findDoneStateId(issue: LinearIssue): Promise<string> {
    const states = issue.team?.states?.nodes || [];
    const done = states.find(state => /done|complete|closed/i.test(state.name) || state.type === 'completed');
    if (done) { return done.id; }
    throw new Error(`No Done state found in Linear team ${issue.team?.name || 'unknown'}.`);
  }

  async updateIssueStatus(issueId: string, stateId: string): Promise<{ id: string; stateName: string }> {
    const id = issueId.replace(/^linear:/, '');
    const data = await this._api<{ issueUpdate: { success: boolean; issue: { id: string; state: { name: string } } } }>('updateIssueStatus', { id, stateId });
    if (!data.issueUpdate?.success) {
      throw new Error('Linear issueUpdate mutation failed.');
    }
    return { id: data.issueUpdate.issue.id, stateName: data.issueUpdate.issue.state.name };
  }

  async addComment(issueId: string, body: string): Promise<{ id: string }> {
    // Linear CommentCreateInput.issueId requires the issue UUID, not the
    // human identifier (e.g. PRO-123). Resolve identifiers before posting.
    let id = issueId.replace(/^linear:/, '');
    if (!isLinearIssueUuid(id)) {
      const issue = await this.getIssue(id);
      id = issue.id;
    }
    const data = await this._api<{ commentCreate: { success: boolean; comment: { id: string } } }>('createComment', { issueId: id, body });
    if (!data.commentCreate?.success) {
      throw new Error('Linear commentCreate mutation failed.');
    }
    return { id: data.commentCreate.comment.id };
  }

  async pullTasks(input: TynePullTasksInput): Promise<TyneTask[]> {
    const mapping = await this.getSelectedTeamMapping();
    if (!mapping) {
      throw new Error('Choose a Linear team before refreshing issues.');
    }
    const response = await this._api<LinearIssueListResponse>('listAssignedIssues', {
      teamId: mapping.teamId,
      assignedOnly: input.assignedOnly !== false,
      includeCompleted: input.includeCompleted === true,
      forceRefresh: input.forceRefresh === true,
      first: 50,
    });

    const issues = Array.isArray(response.issues) ? response.issues : [];
    return issues.map(issue => this._mapIssueToTask(issue));
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    const issue = await this.getIssue(taskId);
    return this._mapIssueToDetails(issue);
  }

  async getTaskComments(taskId: string): Promise<TyneTaskComment[]> {
    const id = taskId.replace(/^linear:/, '');
    try {
      const data = await this._api<{ issue: { comments?: { nodes: Array<{ id: string; body: string; createdAt?: string; updatedAt?: string; user?: { id: string; name?: string } }> } } }>('listComments', { id });
      const nodes = data.issue?.comments?.nodes || [];
      return nodes.map(node => ({
        id: node.id,
        authorName: node.user?.name,
        body: node.body,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        sourceTool: 'linear',
      }));
    } catch {
      return [];
    }
  }
  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> { return []; }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return {
      canCreateTask: false,
      canEditTitle: false,
      canEditDescription: false,
      canEditStatus: true,
      canEditPriority: false,
      canEditAssignee: false,
      canEditDueDate: false,
      canEditLabels: false,
      canAddSubtask: false,
      canEditSubtask: false,
      canAddComment: true,
      supportsRealtimeEvents: false,
      supportsTaskHistory: false,
      supportsLabels: true,
      supportsSprints: true,
      supportsMilestones: true,
    };
  }
  async createTask(_input: TyneCreateTaskInput): Promise<TyneTaskDetails> { throw new Error('Not implemented'); }
  async updateTask(_taskId: string, _input: TyneUpdateTaskInput): Promise<TyneTaskDetails> { throw new Error('Not implemented'); }
  async addSubtask(_taskId: string, _input: { title: string }): Promise<TyneSubtask> { throw new Error('Not implemented'); }
  async updateSubtask(_taskId: string, _subtaskId: string, _input: Partial<TyneSubtask>): Promise<TyneSubtask> { throw new Error('Not implemented'); }
  async subscribeToTaskUpdates(_callback: (e: TyneTaskProviderUpdateEvent) => void): Promise<() => void> { return () => undefined; }

  async listTeams(): Promise<LinearOAuthTeam[]> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return []; }
    const githubToken = await context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('Connect GitHub before listing Linear teams.');
    }
    const response = await fetch(`${this._getSupabaseUrl()}${LIST_TEAMS_FUNCTION_PATH}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': getVscode().env.machineId,
        'Accept': 'application/json',
      },
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Failed to list Linear teams (${response.status}).`);
    }
    return Array.isArray(payload.teams)
      ? payload.teams
          .map(team => normalizeTeam(team as Record<string, unknown>))
          .filter((team): team is LinearOAuthTeam => Boolean(team))
      : [];
  }

  async chooseAndSaveTeam(initialTeams?: LinearOAuthTeam[]): Promise<LinearTeamMapping | null> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return null; }
    const bundle = await this._loadBundle();
    const teams = initialTeams?.length ? initialTeams : await this.listTeams();
    if (!teams.length) {
      getVscode().window.showWarningMessage('Linear connected, but no teams were found.');
      return null;
    }

    const selected = teams.length === 1
      ? teams[0]
      : await getVscode().window.showQuickPick(
          teams.map(team => ({
            label: team.key ? `${team.key} — ${team.name}` : team.name,
            description: bundle?.workspaceName,
            team,
          })),
          { placeHolder: 'Choose Linear team for this repository', ignoreFocusOut: true },
        ).then(item => item?.team);

    if (!selected) { return null; }
    const mapping = await this.saveTeamMapping(selected);
    getVscode().window.showInformationMessage(`Linear connected: ${mapping.teamKey || 'Team'} · ${mapping.teamName}`);
    return mapping;
  }

  async getSelectedTeamMapping(): Promise<LinearTeamMapping | null> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return null; }
    return context.workspaceState.get<LinearTeamMapping | null>(TEAM_MAPPING_KEY, null);
  }

  async getWorkspaceId(): Promise<string> {
    const mapping = await this.getSelectedTeamMapping();
    if (mapping?.workspaceId) { return mapping.workspaceId; }
    const bundle = await this._loadBundle();
    return bundle?.workspaceId || '';
  }

  private async saveTeamMapping(team: LinearOAuthTeam): Promise<LinearTeamMapping> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      return {
        repositoryId: 'test',
        workspaceId: 'test',
        teamId: team.id,
        teamKey: team.key,
        teamName: team.name,
      };
    }
    const githubToken = await context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('Connect GitHub before saving a Linear team.');
    }
    const bundle = await this._loadBundle();
    if (!bundle?.workspaceId) {
      throw new Error('Linear workspace information is missing. Reconnect Linear.');
    }
    const repo = getRepositoryIdentity();
    const response = await fetch(`${this._getSupabaseUrl()}${SAVE_TEAM_MAPPING_FUNCTION_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': getVscode().env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        repository_id: repo.repositoryId,
        repository_name: repo.repositoryName,
        workspace_path_hash: repo.workspacePathHash,
        linear_workspace_id: bundle.workspaceId,
        linear_workspace_name: bundle.workspaceName,
        linear_team_id: team.id,
        linear_team_key: team.key,
        linear_team_name: team.name,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload?.mapping || typeof payload.mapping !== 'object') {
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Failed to save Linear team mapping (${response.status}).`);
    }

    const mapping = normalizeTeamMapping(payload.mapping as Record<string, unknown>);
    if (!mapping) {
      throw new Error('Linear team mapping response was incomplete.');
    }
    await context.workspaceState.update(TEAM_MAPPING_KEY, mapping);
    return mapping;
  }

  private async _api<T>(operation: string, variables?: Record<string, unknown>): Promise<T> {
    const context = getTaskProviderRuntimeContext();
    if (!context) {
      throw new Error('Linear provider runtime is unavailable.');
    }
    const githubToken = await context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('Connect GitHub before using Linear through Tyne.');
    }
    const response = await fetch(`${this._getSupabaseUrl()}${LINEAR_API_REQUEST_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': getVscode().env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ operation, variables }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Linear API request failed (${response.status}).`);
    }
    return payload as unknown as T;
  }

  private async _loadBundle(): Promise<LinearConnectionBundle | null> {
    const context = getTaskProviderRuntimeContext();
    if (!context) { return null; }
    const raw = await context.secrets.get(SECRET_KEY);
    if (!raw) { return null; }
    try {
      return JSON.parse(raw) as LinearConnectionBundle;
    } catch {
      return null;
    }
  }

  private _mapIssueToTask(issue: LinearIssue): TyneTask {
    return {
      id: `linear:${issue.id}`,
      externalId: issue.identifier,
      title: issue.title,
      description: issue.description || '',
      status: issue.state?.name || 'Unknown',
      normalizedStatus: normalizeStatus(issue.state?.name || ''),
      priority: issue.priority !== undefined ? String(issue.priority) : undefined,
      normalizedPriority: normalizePriority(issue.priority),
      assigneeName: issue.assignee?.name,
      assigneeEmail: issue.assignee?.email,
      sourceTool: 'linear',
      sourceProject: issue.team?.name || issue.project?.name || undefined,
      sourceUrl: issue.url,
      labels: issue.labels?.nodes?.map(label => label.name) || [],
      parentKey: issue.parent?.identifier,
      parentTitle: issue.parent?.title,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      lastSyncedAt: new Date().toISOString(),
      cachedAt: new Date().toISOString(),
      isCachedOnly: false,
    };
  }

  private _mapIssueToDetails(issue: LinearIssue): TyneTaskDetails {
    const base = this._mapIssueToTask(issue);
    return {
      ...base,
      subtasks: issue.children?.nodes?.map(child => ({
        id: `linear:${child.id}`,
        title: child.title,
        status: child.state?.name,
        normalizedStatus: normalizeStatus(child.state?.name || ''),
      })) || [],
      comments: (issue.comments?.nodes || []).map(node => ({
        id: node.id,
        authorName: node.user?.name,
        body: node.body,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        sourceTool: 'linear',
      })),
      notes: [],
      historyLast30Days: [],
    };
  }

  private _getSupabaseUrl(): string {
    return getVscode().workspace.getConfiguration('tyne').get<string>('supabaseUrl', DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  }
}

export async function getLinearIntegrationSnapshot(context: import('vscode').ExtensionContext): Promise<LinearIntegrationSnapshot> {
  const raw = await context.secrets.get(SECRET_KEY);
  const bundle = raw ? safeParseBundle(raw) : null;
  const mapping = context.workspaceState.get<LinearTeamMapping | null>(TEAM_MAPPING_KEY, null);
  return {
    connected: Boolean(bundle),
    workspaceId: mapping?.workspaceId || bundle?.workspaceId,
    workspaceName: mapping?.workspaceName || bundle?.workspaceName,
    selectedTeam: mapping,
  };
}

function safeParseBundle(raw: string): LinearConnectionBundle | null {
  try {
    return JSON.parse(raw) as LinearConnectionBundle;
  } catch {
    return null;
  }
}

function normalizeTeam(team: Record<string, unknown>): LinearOAuthTeam | null {
  const id = typeof team.id === 'string' ? team.id : '';
  const name = typeof team.name === 'string' ? team.name : '';
  if (!id || !name) { return null; }
  return {
    id,
    key: typeof team.key === 'string' ? team.key : undefined,
    name,
  };
}

function normalizeTeamMapping(mapping: Record<string, unknown>): LinearTeamMapping | null {
  const repositoryId = typeof mapping.repository_id === 'string' ? mapping.repository_id : typeof mapping.repositoryId === 'string' ? mapping.repositoryId : '';
  const workspaceId = typeof mapping.linear_workspace_id === 'string' ? mapping.linear_workspace_id : typeof mapping.workspaceId === 'string' ? mapping.workspaceId : '';
  const teamId = typeof mapping.linear_team_id === 'string' ? mapping.linear_team_id : typeof mapping.teamId === 'string' ? mapping.teamId : '';
  const teamName = typeof mapping.linear_team_name === 'string' ? mapping.linear_team_name : typeof mapping.teamName === 'string' ? mapping.teamName : '';
  if (!repositoryId || !workspaceId || !teamId || !teamName) { return null; }
  return {
    repositoryId,
    repositoryName: typeof mapping.repository_name === 'string' ? mapping.repository_name : typeof mapping.repositoryName === 'string' ? mapping.repositoryName : undefined,
    workspacePathHash: typeof mapping.workspace_path_hash === 'string' ? mapping.workspace_path_hash : typeof mapping.workspacePathHash === 'string' ? mapping.workspacePathHash : undefined,
    workspaceId,
    workspaceName: typeof mapping.linear_workspace_name === 'string' ? mapping.linear_workspace_name : typeof mapping.workspaceName === 'string' ? mapping.workspaceName : undefined,
    teamId,
    teamKey: typeof mapping.linear_team_key === 'string' ? mapping.linear_team_key : typeof mapping.teamKey === 'string' ? mapping.teamKey : undefined,
    teamName,
  };
}

function getRepositoryIdentity(): { repositoryId: string; repositoryName?: string; workspacePathHash?: string } {
  const folder = getVscode().workspace.workspaceFolders?.[0];
  const workspacePath = folder?.uri.fsPath || 'unknown-workspace';
  const repositoryName = folder?.name;
  const workspacePathHash = createHash('sha256').update(workspacePath).digest('hex');
  return {
    repositoryId: repositoryName ? `${repositoryName}:${workspacePathHash.slice(0, 16)}` : workspacePathHash,
    repositoryName,
    workspacePathHash,
  };
}
