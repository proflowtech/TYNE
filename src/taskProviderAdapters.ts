import {
  TynePmTool,
  TyneTask,
  TyneTaskDetails,
  TyneTaskComment,
  TyneTaskHistoryEvent,
  TyneNormalizedTaskStatus,
  TyneNormalizedTaskPriority,
  TynePullTasksInput,
  TynePmConnectionResult,
  TyneTaskProviderAdapter,
  TyneSubtask,
  TyneTaskProviderCapabilities,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
  TyneTaskProviderUpdateEvent,
} from './taskTypes';
import { hasTaskProviderRuntimeContext } from './taskProviderRuntime';
import { LinearProvider } from './linearProvider';
import { AsanaProvider } from './asanaProvider';
import { NotionProvider } from './notionProvider';

const ISO = () => new Date().toISOString();

function isVscodeAvailable(): boolean {
  try {
    require('vscode');
    return true;
  } catch {
    return false;
  }
}

function makeDemoTask(
  tool: TynePmTool,
  id: string,
  title: string,
  status: TyneNormalizedTaskStatus,
  priority: TyneNormalizedTaskPriority,
  assignee?: string,
  project?: string,
  dueDate?: string,
): TyneTask {
  return {
    id: `${tool}:${id}`,
    externalId: id,
    title,
    description: `This is a demo task from ${tool}. Connect your real ${tool} account to see live tasks.`,
    status,
    normalizedStatus: status,
    priority,
    normalizedPriority: priority,
    assigneeName: assignee,
    sourceTool: tool,
    sourceProject: project,
    sourceUrl: `https://${tool}.example.com/task/${id}`,
    updatedAt: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
    createdAt: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
    dueDate,
    lastSyncedAt: ISO(),
    cachedAt: ISO(),
    isCachedOnly: false,
  };
}

function notImplemented(tool: string): never {
  throw new Error(`${tool} is not connected. Add your ${tool} API token in Settings → Integrations.`);
}

// ── Shared priority normalizer ────────────────────────────────────────────────
function normalizePriorityStr(raw?: string): TyneNormalizedTaskPriority {
  if (!raw) { return 'none'; }
  const s = raw.toLowerCase();
  if (s === 'urgent') { return 'urgent'; }
  if (s === 'high') { return 'high'; }
  if (s === 'medium' || s === 'normal') { return 'medium'; }
  if (s === 'low') { return 'low'; }
  if (s === 'none' || s === 'no priority') { return 'none'; }
  return 'unknown';
}

// ── Linear ────────────────────────────────────────────────────────────────────
export class LinearTaskAdapter implements TyneTaskProviderAdapter {
  readonly toolName: TynePmTool = 'linear';
  private _connected = false;

  async connect(): Promise<TynePmConnectionResult> {
    if (!hasTaskProviderRuntimeContext() || !isVscodeAvailable()) {
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    }
    try {
      const provider = new LinearProvider();
      const result = await provider.connect();
      this._connected = result.connected;
      return { connected: result.connected, toolName: this.toolName, errorMessage: result.errorMessage };
    } catch (err) {
      return { connected: false, toolName: this.toolName, errorMessage: err instanceof Error ? err.message : 'Could not connect to Linear.' };
    }
  }
  async disconnect(): Promise<void> {
    this._connected = false;
    if (hasTaskProviderRuntimeContext()) { await new LinearProvider().disconnect(); }
  }
  async isConnected(): Promise<boolean> {
    if (!hasTaskProviderRuntimeContext()) { return this._connected; }
    return new LinearProvider().isConnected();
  }

  normalizeStatus(s: string): TyneNormalizedTaskStatus {
    const l = s.toLowerCase();
    if (l === 'todo' || l === 'backlog') { return 'todo'; }
    if (l.includes('progress')) { return 'in_progress'; }
    if (l.includes('review')) { return 'in_review'; }
    if (l === 'done' || l === 'completed') { return 'done'; }
    if (l === 'canceled' || l === 'cancelled') { return 'canceled'; }
    return 'unknown';
  }
  normalizePriority(raw?: string): TyneNormalizedTaskPriority { return normalizePriorityStr(raw); }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    if (hasTaskProviderRuntimeContext()) {
      return new LinearProvider().pullTasks(_input);
    }
    return [
      makeDemoTask('linear', 'ENG-101', 'Implement OAuth refresh token handling', 'in_progress', 'high', 'Alex', 'Engineering'),
      makeDemoTask('linear', 'ENG-102', 'Fix sidebar state persistence bug', 'todo', 'medium', 'Alex', 'Engineering'),
      makeDemoTask('linear', 'ENG-103', 'Write unit tests for billing flow', 'todo', 'low', 'Alex', 'Engineering'),
    ];
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    if (hasTaskProviderRuntimeContext()) {
      return new LinearProvider().getTaskDetails(taskId);
    }
    const base = makeDemoTask('linear', taskId, `Linear Task ${taskId}`, 'in_progress', 'high', 'Alex', 'Engineering');
    return {
      ...base,
      subtasks: _makeDemoSubtasks('linear'),
      comments: _makeDemoComments('linear'),
      notes: [],
      historyLast30Days: _makeDemoHistory('linear'),
    };
  }

  async getTaskComments(taskId: string): Promise<TyneTaskComment[]> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    return _makeDemoComments('linear');
  }

  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    return _makeDemoHistory('linear');
  }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return makeCapabilities({ supportsRealtimeEvents: false, supportsSprints: true });
  }
  async createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    const base = makeDemoTask('linear', `ENG-${Date.now()}`, input.title, input.status ?? 'todo', input.priority ?? 'medium', undefined, input.projectId);
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Linear'); }
    const base = makeDemoTask('linear', taskId, input.title ?? `Linear Task ${taskId}`, input.status ?? 'in_progress', input.priority ?? 'medium');
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async addSubtask(_taskId: string, input: { title: string }): Promise<TyneSubtask> {
    return { id: `linear:sub:${Date.now()}`, title: input.title, normalizedStatus: 'todo' };
  }
  async updateSubtask(_taskId: string, subtaskId: string, input: Partial<TyneSubtask>): Promise<TyneSubtask> {
    return { id: subtaskId, title: input.title ?? '', normalizedStatus: input.normalizedStatus ?? 'todo' };
  }
  async addComment(_taskId: string, body: string): Promise<TyneTaskComment> {
    if (hasTaskProviderRuntimeContext()) {
      await new LinearProvider().addComment(_taskId, body);
    }
    return { id: `linear:cmt:${Date.now()}`, authorName: 'You', body, createdAt: new Date().toISOString(), sourceTool: 'linear' };
  }
  async chooseAndSaveTeam(): Promise<unknown> {
    return new LinearProvider().chooseAndSaveTeam();
  }
  async subscribeToTaskUpdates(callback: (e: TyneTaskProviderUpdateEvent) => void): Promise<() => void> {
    void callback;
    return () => undefined;
  }
  mapTyneStatusToExternalStatus(s: TyneNormalizedTaskStatus): string { return defaultMapStatus(s); }
  mapTynePriorityToExternalPriority(p: TyneNormalizedTaskPriority): string { return defaultMapPriority(p); }
}

// ── Jira ──────────────────────────────────────────────────────────────────────
export class JiraTaskAdapter implements TyneTaskProviderAdapter {
  readonly toolName: TynePmTool = 'jira';
  private _connected = false;

  async connect(): Promise<TynePmConnectionResult> {
    if (!hasTaskProviderRuntimeContext()) {
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    }
    const result = await this._provider().connect();
    this._connected = result.connected;
    return { connected: result.connected, toolName: this.toolName, errorMessage: result.errorMessage };
  }
  async disconnect(): Promise<void> { this._connected = false; if (hasTaskProviderRuntimeContext()) { await this._provider().disconnect(); } }
  async isConnected(): Promise<boolean> {
    if (!hasTaskProviderRuntimeContext()) { return this._connected; }
    return await this._provider().isConnected();
  }

  normalizeStatus(s: string): TyneNormalizedTaskStatus {
    const l = s.toLowerCase();
    if (l === 'to do' || l === 'open' || l === 'backlog') { return 'todo'; }
    if (l === 'in progress') { return 'in_progress'; }
    if (l.includes('review') || l.includes('code review')) { return 'in_review'; }
    if (l === 'done' || l === 'closed' || l === 'resolved') { return 'done'; }
    if (l === 'blocked') { return 'blocked'; }
    return 'unknown';
  }
  normalizePriority(raw?: string): TyneNormalizedTaskPriority { return normalizePriorityStr(raw); }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().pullTasks(_input);
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().getTaskDetails(taskId);
  }

  async getTaskComments(_taskId: string): Promise<TyneTaskComment[]> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().getTaskComments(_taskId);
  }

  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().getTaskHistoryLast30Days(_taskId);
  }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    if (!hasTaskProviderRuntimeContext()) {
      return makeCapabilities({ supportsLabels: true, supportsSprints: true, supportsMilestones: true });
    }
    return this._provider().getCapabilities();
  }
  async createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().createTask(input);
  }
  async updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    if (!await this.isConnected()) { notImplemented('Jira'); }
    return this._provider().updateTask(taskId, input);
  }
  async addSubtask(_taskId: string, input: { title: string }): Promise<TyneSubtask> {
    return this._provider().addSubtask(_taskId, input);
  }
  async updateSubtask(_taskId: string, subtaskId: string, input: Partial<TyneSubtask>): Promise<TyneSubtask> {
    return this._provider().updateSubtask(_taskId, subtaskId, input);
  }
  async addComment(_taskId: string, body: string): Promise<TyneTaskComment> {
    return this._provider().addComment(_taskId, body);
  }
  async subscribeToTaskUpdates(callback: (e: TyneTaskProviderUpdateEvent) => void): Promise<() => void> {
    return this._provider().subscribeToTaskUpdates(callback);
  }
  async chooseAndSaveProject(): Promise<unknown> {
    return this._provider().chooseAndSaveProject();
  }
  async getCloudId(): Promise<string> {
    return this._provider().getCloudId();
  }
  mapTyneStatusToExternalStatus(s: TyneNormalizedTaskStatus): string { return defaultMapStatus(s); }
  mapTynePriorityToExternalPriority(p: TyneNormalizedTaskPriority): string { return defaultMapPriority(p); }

  private _provider() {
    const { JiraProvider } = require('./jiraProvider') as typeof import('./jiraProvider');
    return new JiraProvider(
      this.normalizeStatus.bind(this),
      this.normalizePriority.bind(this),
    );
  }
}

// ── Asana ─────────────────────────────────────────────────────────────────────
export class AsanaTaskAdapter implements TyneTaskProviderAdapter {
  readonly toolName: TynePmTool = 'asana';
  private _connected = false;

  async connect(): Promise<TynePmConnectionResult> {
    if (!isVscodeAvailable()) {
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    }
    try {
      const provider = new AsanaProvider();
      const ok = await provider.isConnected();
      if (!ok) { return { connected: false, toolName: this.toolName, errorMessage: 'Asana API key is invalid or missing.' }; }
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    } catch (err) {
      return { connected: false, toolName: this.toolName, errorMessage: err instanceof Error ? err.message : 'Could not connect to Asana.' };
    }
  }
  async disconnect(): Promise<void> { this._connected = false; }
  async isConnected(): Promise<boolean> { return this._connected; }

  normalizeStatus(s: string): TyneNormalizedTaskStatus {
    const l = s.toLowerCase();
    if (l === 'complete' || l === 'completed') { return 'done'; }
    if (l === 'in_progress' || l === 'incomplete') { return 'in_progress'; }
    if (l === 'not_started') { return 'todo'; }
    return 'unknown';
  }
  normalizePriority(raw?: string): TyneNormalizedTaskPriority { return normalizePriorityStr(raw); }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> {
    if (!this._connected) { notImplemented('Asana'); }
    return [
      makeDemoTask('asana', 'ASN-301', 'Design new onboarding flow', 'in_progress', 'medium', 'Sam', 'Product'),
    ];
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Asana'); }
    const base = makeDemoTask('asana', taskId, `Asana Task ${taskId}`, 'in_progress', 'medium', 'Sam', 'Product');
    return { ...base, subtasks: _makeDemoSubtasks('asana'), comments: _makeDemoComments('asana'), notes: [], historyLast30Days: [] };
  }

  async getTaskComments(_taskId: string): Promise<TyneTaskComment[]> {
    if (!this._connected) { notImplemented('Asana'); }
    return _makeDemoComments('asana');
  }

  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> {
    return [];
  }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return makeCapabilities({ supportsTaskHistory: false, supportsLabels: true, supportsSprints: false });
  }
  async createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Asana'); }
    const base = makeDemoTask('asana', `ASN-${Date.now()}`, input.title, input.status ?? 'todo', input.priority ?? 'medium', undefined, input.projectId);
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Asana'); }
    const base = makeDemoTask('asana', taskId, input.title ?? `Asana Task ${taskId}`, input.status ?? 'in_progress', input.priority ?? 'medium');
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async addSubtask(_taskId: string, input: { title: string }): Promise<TyneSubtask> {
    return { id: `asana:sub:${Date.now()}`, title: input.title, normalizedStatus: 'todo' };
  }
  async updateSubtask(_taskId: string, subtaskId: string, input: Partial<TyneSubtask>): Promise<TyneSubtask> {
    return { id: subtaskId, title: input.title ?? '', normalizedStatus: input.normalizedStatus ?? 'todo' };
  }
  async addComment(_taskId: string, body: string): Promise<TyneTaskComment> {
    return { id: `asana:cmt:${Date.now()}`, authorName: 'You', body, createdAt: new Date().toISOString(), sourceTool: 'asana' };
  }
  mapTyneStatusToExternalStatus(s: TyneNormalizedTaskStatus): string { return defaultMapStatus(s); }
  mapTynePriorityToExternalPriority(p: TyneNormalizedTaskPriority): string { return defaultMapPriority(p); }
}

// ── Notion ────────────────────────────────────────────────────────────────────
export class NotionTaskAdapter implements TyneTaskProviderAdapter {
  readonly toolName: TynePmTool = 'notion';
  private _connected = false;

  async connect(): Promise<TynePmConnectionResult> {
    if (!isVscodeAvailable()) {
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    }
    try {
      const provider = new NotionProvider();
      const ok = await provider.isConnected();
      if (!ok) { return { connected: false, toolName: this.toolName, errorMessage: 'Notion API key is invalid or missing.' }; }
      this._connected = true;
      return { connected: true, toolName: this.toolName };
    } catch (err) {
      return { connected: false, toolName: this.toolName, errorMessage: err instanceof Error ? err.message : 'Could not connect to Notion.' };
    }
  }
  async disconnect(): Promise<void> { this._connected = false; }
  async isConnected(): Promise<boolean> { return this._connected; }

  normalizeStatus(s: string): TyneNormalizedTaskStatus {
    const l = s.toLowerCase().replace(/\s+/g, '_');
    if (l === 'not_started') { return 'todo'; }
    if (l === 'in_progress') { return 'in_progress'; }
    if (l === 'done') { return 'done'; }
    return 'unknown';
  }
  normalizePriority(raw?: string): TyneNormalizedTaskPriority { return normalizePriorityStr(raw); }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> {
    if (!this._connected) { notImplemented('Notion'); }
    return [
      makeDemoTask('notion', 'NTN-401', 'Write release notes for v1.2', 'todo', 'low', 'Riley', 'Docs'),
    ];
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Notion'); }
    const base = makeDemoTask('notion', taskId, `Notion Page ${taskId}`, 'todo', 'low', 'Riley', 'Docs');
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }

  async getTaskComments(_taskId: string): Promise<TyneTaskComment[]> { return []; }
  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> { return []; }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return makeCapabilities({ supportsTaskHistory: false, supportsLabels: true, canEditLabels: false, supportsRealtimeEvents: false });
  }
  async createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Notion'); }
    const base = makeDemoTask('notion', `NTN-${Date.now()}`, input.title, input.status ?? 'todo', input.priority ?? 'none', undefined, input.projectId);
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Notion'); }
    const base = makeDemoTask('notion', taskId, input.title ?? `Notion Page ${taskId}`, input.status ?? 'in_progress', input.priority ?? 'none');
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  mapTyneStatusToExternalStatus(s: TyneNormalizedTaskStatus): string { return defaultMapStatus(s); }
  mapTynePriorityToExternalPriority(p: TyneNormalizedTaskPriority): string { return defaultMapPriority(p); }
}

// ── Monday ────────────────────────────────────────────────────────────────────
export class MondayTaskAdapter implements TyneTaskProviderAdapter {
  readonly toolName: TynePmTool = 'monday';
  private _connected = false;

  async connect(): Promise<TynePmConnectionResult> { this._connected = true; return { connected: true, toolName: this.toolName }; }
  async disconnect(): Promise<void> { this._connected = false; }
  async isConnected(): Promise<boolean> { return this._connected; }

  normalizeStatus(s: string): TyneNormalizedTaskStatus {
    const l = s.toLowerCase();
    if (l === 'not started' || l === 'waiting') { return 'todo'; }
    if (l === 'working on it' || l === 'in progress') { return 'in_progress'; }
    if (l === 'done' || l === 'complete') { return 'done'; }
    if (l === 'stuck' || l === 'blocked') { return 'blocked'; }
    return 'unknown';
  }
  normalizePriority(raw?: string): TyneNormalizedTaskPriority { return normalizePriorityStr(raw); }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> {
    if (!this._connected) { notImplemented('Monday'); }
    return [
      makeDemoTask('monday', 'MON-501', 'Campaign landing page revamp', 'in_progress', 'high', 'Morgan', 'Marketing'),
    ];
  }

  async getTaskDetails(taskId: string): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Monday'); }
    const base = makeDemoTask('monday', taskId, `Monday Item ${taskId}`, 'in_progress', 'high', 'Morgan', 'Marketing');
    return { ...base, subtasks: _makeDemoSubtasks('monday'), comments: _makeDemoComments('monday'), notes: [], historyLast30Days: _makeDemoHistory('monday') };
  }

  async getTaskComments(_taskId: string): Promise<TyneTaskComment[]> {
    if (!this._connected) { notImplemented('Monday'); }
    return _makeDemoComments('monday');
  }

  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> {
    if (!this._connected) { notImplemented('Monday'); }
    return _makeDemoHistory('monday');
  }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> {
    return makeCapabilities({ supportsLabels: false, canEditLabels: false, supportsRealtimeEvents: false });
  }
  async createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Monday'); }
    const base = makeDemoTask('monday', `MON-${Date.now()}`, input.title, input.status ?? 'todo', input.priority ?? 'medium', undefined, input.projectId);
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails> {
    if (!this._connected) { notImplemented('Monday'); }
    const base = makeDemoTask('monday', taskId, input.title ?? `Monday Item ${taskId}`, input.status ?? 'in_progress', input.priority ?? 'medium');
    return { ...base, subtasks: [], comments: [], notes: [], historyLast30Days: [] };
  }
  async addSubtask(_taskId: string, input: { title: string }): Promise<TyneSubtask> {
    return { id: `monday:sub:${Date.now()}`, title: input.title, normalizedStatus: 'todo' };
  }
  async updateSubtask(_taskId: string, subtaskId: string, input: Partial<TyneSubtask>): Promise<TyneSubtask> {
    return { id: subtaskId, title: input.title ?? '', normalizedStatus: input.normalizedStatus ?? 'todo' };
  }
  async addComment(_taskId: string, body: string): Promise<TyneTaskComment> {
    return { id: `monday:cmt:${Date.now()}`, authorName: 'You', body, createdAt: new Date().toISOString(), sourceTool: 'monday' };
  }
  mapTyneStatusToExternalStatus(s: TyneNormalizedTaskStatus): string { return defaultMapStatus(s); }
  mapTynePriorityToExternalPriority(p: TyneNormalizedTaskPriority): string { return defaultMapPriority(p); }
}

// ── Shared capabilities + write helpers ───────────────────────────────────────

function makeCapabilities(overrides: Partial<TyneTaskProviderCapabilities> = {}): TyneTaskProviderCapabilities {
  return {
    canCreateTask: true, canEditTitle: true, canEditDescription: true,
    canEditStatus: true, canEditPriority: true, canEditAssignee: true,
    canEditDueDate: true, canEditLabels: true, canAddSubtask: true,
    canEditSubtask: true, canAddComment: true, supportsRealtimeEvents: false,
    supportsTaskHistory: true, supportsLabels: true, supportsSprints: false, supportsMilestones: false,
    ...overrides,
  };
}

const STATUS_TO_EXTERNAL: Record<TyneNormalizedTaskStatus, string> = {
  todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review',
  done: 'Done', blocked: 'Blocked', canceled: 'Canceled', unknown: 'Unknown',
};
const PRIORITY_TO_EXTERNAL: Record<TyneNormalizedTaskPriority, string> = {
  urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority', unknown: 'Unknown',
};

function defaultMapStatus(s: TyneNormalizedTaskStatus): string { return STATUS_TO_EXTERNAL[s] ?? s; }
function defaultMapPriority(p: TyneNormalizedTaskPriority): string { return PRIORITY_TO_EXTERNAL[p] ?? p; }

// ── Demo data helpers ─────────────────────────────────────────────────────────
function _makeDemoSubtasks(tool: TynePmTool): import('./taskTypes').TyneSubtask[] {
  return [
    { id: `${tool}:sub:1`, title: 'Initial implementation', status: 'done', normalizedStatus: 'done' },
    { id: `${tool}:sub:2`, title: 'Write tests', status: 'in_progress', normalizedStatus: 'in_progress' },
    { id: `${tool}:sub:3`, title: 'Code review', status: 'todo', normalizedStatus: 'todo' },
  ];
}

function _makeDemoComments(tool: TynePmTool): TyneTaskComment[] {
  const ts = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  return [
    { id: `${tool}:cmt:1`, authorName: 'Alex', body: 'Started working on this. Initial scaffolding looks good.', createdAt: ts(3), sourceTool: tool },
    { id: `${tool}:cmt:2`, authorName: 'Jordan', body: 'Reviewed the PR. Needs minor changes in error handling.', createdAt: ts(1), sourceTool: tool },
  ];
}

function _makeDemoHistory(tool: TynePmTool): TyneTaskHistoryEvent[] {
  const ts = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  return [
    { id: `${tool}:ev:1`, type: 'status_change', fromValue: 'Todo', toValue: 'In Progress', actorName: 'Alex', createdAt: ts(5), sourceTool: tool },
    { id: `${tool}:ev:2`, type: 'comment_added', title: 'Comment added', actorName: 'Jordan', createdAt: ts(1), sourceTool: tool },
  ];
}
