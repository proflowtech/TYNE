import {
  TyneNormalizedPmStatus,
  TynePmTask,
  TynePmStatusUpdateResult,
  TynePmCommentResult,
  TynePmTransition,
  TynePmVisibleTyneStatus,
  TynePmStatusWriteResult,
  TynePmWorklogInput,
  TynePmWorklogResult,
} from './automationTypes';
import { hasTaskProviderRuntimeContext } from './taskProviderRuntime';

export interface TynePmToolAdapter {
  readonly toolName: string;

  getTask(taskId: string): Promise<TynePmTask>;
  getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus>;
  updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult>;
  postTaskComment(taskId: string, body: string): Promise<TynePmCommentResult>;
  updateTaskComment?(taskId: string, commentId: string, body: string): Promise<TynePmCommentResult>;
  updateTyneStatusInPm?(taskId: string, status: TynePmVisibleTyneStatus): Promise<TynePmStatusWriteResult>;
  logWorklog?(taskId: string, input: TynePmWorklogInput): Promise<TynePmWorklogResult>;
  listTransitions?(taskId: string): Promise<TynePmTransition[]>;
  transitionTask?(taskId: string, transitionId: string): Promise<TynePmStatusUpdateResult>;
  mapExternalStatusToTyneStatus(externalStatus: string): TyneNormalizedPmStatus;
  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string;
}

function notSupported(tool: string): never {
  throw new Error(`${tool} PM integration is not connected yet.`);
}

// Jira workflows name their "done" transition many ways ("Done", "Closed",
// "Mark as Done", "Resolve", "Complete", "Finish & Close", …). Prefer an exact
// Done/Closed match, then fall back to any transition whose name or target status
// clearly means completed, so tie-the-knot can close most boards.
export function pickDoneTransition(
  transitions: Array<{ id: string; name: string; toStatus?: string }>,
): { id: string; name: string; toStatus?: string } | undefined {
  const exact = transitions.find(t => /^(done|closed|resolved|complete|completed)$/i.test((t.name || '').trim()));
  if (exact) { return exact; }
  const fuzzy = /\b(done|close|closed|complete|completed|resolve|resolved|finish|finished|ship|shipped)\b/i;
  return transitions.find(t => fuzzy.test(t.name || '') || fuzzy.test(t.toStatus || ''));
}

export class LinearAdapter implements TynePmToolAdapter {
  readonly toolName = 'Linear';

  mapExternalStatusToTyneStatus(status: string): TyneNormalizedPmStatus {
    const s = status.toLowerCase();
    if (s === 'todo' || s === 'backlog') { return 'todo'; }
    if (s.includes('progress')) { return 'in_progress'; }
    if (s.includes('review')) { return 'in_review'; }
    if (s === 'done' || s === 'completed') { return 'done'; }
    if (s === 'canceled' || s === 'cancelled') { return 'canceled'; }
    return 'unknown';
  }

  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string {
    const map: Record<TyneNormalizedPmStatus, string> = {
      todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review',
      done: 'Done', blocked: 'In Progress', canceled: 'Canceled', unknown: 'Todo',
    };
    return map[status] ?? 'Todo';
  }

  async getTask(taskId: string): Promise<TynePmTask> {
    const provider = this._provider();
    const issue = await provider.getIssue(taskId);
    return { id: issue.identifier, title: issue.title, status: issue.state.name, url: issue.url, source: 'linear' };
  }

  async getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus> {
    const issue = await this._provider().getIssue(taskId);
    return this.mapExternalStatusToTyneStatus(issue.state.name);
  }

  async updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> {
    const provider = this._provider();
    const previousStatus = await this.getTaskStatus(taskId).catch(() => 'unknown' as TyneNormalizedPmStatus);
    if (status !== 'done') {
      return { success: false, taskId, previousStatus, errorMessage: 'Linear completion currently supports Done transitions only.' };
    }
    const issue = await provider.getIssue(taskId);
    const doneStateId = await provider.findDoneStateId(issue);
    const result = await provider.updateIssueStatus(taskId, doneStateId);
    return { success: true, taskId, previousStatus, newStatus: 'done', externalStatusName: result.stateName, resultMessage: `${issue.identifier} closed via ${result.stateName}.` };
  }

  async postTaskComment(taskId: string, body: string): Promise<TynePmCommentResult> {
    const provider = this._provider();
    const issue = await provider.getIssue(taskId);
    // Always comment against the resolved UUID — identifiers fail commentCreate.
    const comment = await provider.addComment(issue.id, body);
    return { success: true, taskId, commentId: comment.id, commentUrl: `${issue.url}#comment-${comment.id}` };
  }

  private _provider(): import('./linearProvider').LinearProvider {
    const { LinearProvider } = require('./linearProvider') as typeof import('./linearProvider');
    return new LinearProvider();
  }
}

export class JiraAdapter implements TynePmToolAdapter {
  readonly toolName = 'Jira';

  mapExternalStatusToTyneStatus(status: string): TyneNormalizedPmStatus {
    const s = status.toLowerCase();
    if (s === 'to do' || s === 'open' || s === 'backlog') { return 'todo'; }
    if (s === 'in progress') { return 'in_progress'; }
    if (s.includes('review') || s.includes('code review')) { return 'in_review'; }
    if (s === 'done' || s === 'closed' || s === 'resolved') { return 'done'; }
    if (s === 'blocked') { return 'blocked'; }
    if (s === 'canceled' || s === 'cancelled') { return 'canceled'; }
    return 'unknown';
  }

  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string {
    const map: Record<TyneNormalizedPmStatus, string> = {
      todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review',
      done: 'Done', blocked: 'Blocked', canceled: 'Canceled', unknown: 'To Do',
    };
    return map[status] ?? 'To Do';
  }

  async getTask(taskId: string): Promise<TynePmTask> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const task = await this._provider().getTaskDetails(taskId);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      url: task.sourceUrl,
      source: 'jira',
    };
  }

  async getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const task = await this._provider().getTaskDetails(taskId);
    return this.mapExternalStatusToTyneStatus(task.status);
  }

  async updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const previousStatus = await this.getTaskStatus(taskId).catch(() => 'unknown' as TyneNormalizedPmStatus);
    if (status !== 'done') {
      return {
        success: false,
        taskId,
        previousStatus,
        errorMessage: 'Jira completion currently supports Done/Closed transitions only.',
      };
    }
    const transitions = await this._provider().listTransitions(taskId);
    const preferred = pickDoneTransition(transitions);
    if (!preferred) {
      return {
        success: false,
        taskId,
        previousStatus,
        availableTransitions: transitions,
        errorMessage: `No Done/Closed transition was found for this Jira issue. Available: ${transitions.map(t => t.name).join(', ') || 'none'}.`,
      };
    }
    const result = await this._provider().transitionTask(taskId, preferred.id);
    return {
      success: true,
      taskId,
      previousStatus,
      newStatus: 'done',
      externalStatusName: result.transitionName,
      resultMessage: `${this._issueKey(taskId)} closed via ${result.transitionName}.`,
    };
  }

  async postTaskComment(taskId: string, body: string): Promise<TynePmCommentResult> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const comment = await this._provider().addComment(taskId, body);
    return { success: true, taskId, commentId: comment.id };
  }

  async logWorklog(taskId: string, input: TynePmWorklogInput): Promise<TynePmWorklogResult> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const result = await this._provider().addWorklog(taskId, input);
    return { success: true, taskId, worklogId: result.worklogId };
  }

  async listTransitions(taskId: string): Promise<TynePmTransition[]> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    return this._provider().listTransitions(taskId);
  }

  async transitionTask(taskId: string, transitionId: string): Promise<TynePmStatusUpdateResult> {
    if (!hasTaskProviderRuntimeContext()) { notSupported(this.toolName); }
    const previousStatus = await this.getTaskStatus(taskId).catch(() => 'unknown' as TyneNormalizedPmStatus);
    const result = await this._provider().transitionTask(taskId, transitionId);
    return {
      success: true,
      taskId,
      previousStatus,
      newStatus: 'done',
      externalStatusName: result.transitionName,
      resultMessage: `${this._issueKey(taskId)} moved via ${result.transitionName}.`,
    };
  }

  private _provider() {
    const { JiraProvider } = require('./jiraProvider') as typeof import('./jiraProvider');
    return new JiraProvider(
      this.mapExternalStatusToTyneStatus.bind(this),
      () => 'none',
    );
  }

  private _issueKey(taskId: string): string {
    return taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
  }
}

export class AsanaAdapter implements TynePmToolAdapter {
  readonly toolName = 'Asana';

  mapExternalStatusToTyneStatus(status: string): TyneNormalizedPmStatus {
    const s = status.toLowerCase();
    if (s === 'complete' || s === 'completed') { return 'done'; }
    if (s === 'incomplete' || s === 'in_progress') { return 'in_progress'; }
    if (s === 'not_started') { return 'todo'; }
    return 'unknown';
  }

  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string {
    return status === 'done' ? 'complete' : 'incomplete';
  }

  async getTask(taskId: string): Promise<TynePmTask> {
    const provider = this._provider();
    const task = await provider.getTask(taskId);
    return { id: task.gid, title: task.name, status: task.completed ? 'done' : 'in_progress', url: task.permalink_url, source: 'asana' };
  }

  async getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus> {
    const task = await this._provider().getTask(taskId);
    return this.mapExternalStatusToTyneStatus(task.completed ? 'completed' : 'in_progress');
  }

  async updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> {
    const provider = this._provider();
    const previousStatus = await this.getTaskStatus(taskId).catch(() => 'unknown' as TyneNormalizedPmStatus);
    if (status !== 'done') {
      return { success: false, taskId, previousStatus, errorMessage: 'Asana completion currently supports Complete transitions only.' };
    }
    const task = await provider.updateTaskCompleted(taskId, true);
    return { success: true, taskId, previousStatus, newStatus: 'done', externalStatusName: 'Completed', resultMessage: `${task.gid} marked complete.` };
  }

  async postTaskComment(taskId: string, body: string): Promise<TynePmCommentResult> {
    const provider = this._provider();
    const story = await provider.addTaskComment(taskId, body);
    return { success: true, taskId, commentId: story.gid };
  }

  private _provider(): import('./asanaProvider').AsanaProvider {
    const { AsanaProvider } = require('./asanaProvider') as typeof import('./asanaProvider');
    return new AsanaProvider();
  }
}

export class NotionAdapter implements TynePmToolAdapter {
  readonly toolName = 'Notion';

  mapExternalStatusToTyneStatus(status: string): TyneNormalizedPmStatus {
    const s = status.toLowerCase().replace(/\s+/g, '_');
    if (s === 'not_started') { return 'todo'; }
    if (s === 'in_progress') { return 'in_progress'; }
    if (s === 'done') { return 'done'; }
    return 'unknown';
  }

  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string {
    const map: Record<TyneNormalizedPmStatus, string> = {
      todo: 'Not Started', in_progress: 'In Progress', in_review: 'In Progress',
      done: 'Done', blocked: 'In Progress', canceled: 'Not Started', unknown: 'Not Started',
    };
    return map[status] ?? 'Not Started';
  }

  async getTask(taskId: string): Promise<TynePmTask> {
    const provider = this._provider();
    const page = await provider.getPage(taskId);
    const titleProp = Object.values(page.properties).find(p => typeof p === 'object' && 'title' in (p as Record<string, unknown>)) as { title?: Array<{ plain_text?: string }> } | undefined;
    const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Untitled';
    return { id: page.id, title, status: 'unknown', url: page.url, source: 'notion' };
  }

  async getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus> {
    const provider = this._provider();
    const page = await provider.getPage(taskId);
    const statusProp = page.properties[provider.statusPropertyName()];
    const statusName = (statusProp as { status?: { name?: string } } | undefined)?.status?.name ?? 'Unknown';
    return this.mapExternalStatusToTyneStatus(statusName);
  }

  async updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> {
    const provider = this._provider();
    const previousStatus = await this.getTaskStatus(taskId).catch(() => 'unknown' as TyneNormalizedPmStatus);
    if (status !== 'done') {
      return { success: false, taskId, previousStatus, errorMessage: 'Notion completion currently supports Done transitions only.' };
    }
    const result = await provider.completeTask(taskId);
    return { success: true, taskId, previousStatus, newStatus: 'done', externalStatusName: result.statusName, resultMessage: `Notion page updated to ${result.statusName}.` };
  }

  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> {
    return { success: true, taskId: _taskId, commentId: '' };
  }

  private _provider(): import('./notionProvider').NotionProvider {
    const { NotionProvider } = require('./notionProvider') as typeof import('./notionProvider');
    return new NotionProvider();
  }
}

export class MondayAdapter implements TynePmToolAdapter {
  readonly toolName = 'Monday';

  mapExternalStatusToTyneStatus(status: string): TyneNormalizedPmStatus {
    const s = status.toLowerCase();
    if (s === 'not started' || s === 'waiting') { return 'todo'; }
    if (s === 'working on it' || s === 'in progress') { return 'in_progress'; }
    if (s === 'done' || s === 'complete') { return 'done'; }
    if (s === 'stuck' || s === 'blocked') { return 'blocked'; }
    return 'unknown';
  }

  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string {
    const map: Record<TyneNormalizedPmStatus, string> = {
      todo: 'Not Started', in_progress: 'Working on it', in_review: 'Working on it',
      done: 'Done', blocked: 'Stuck', canceled: 'Not Started', unknown: 'Not Started',
    };
    return map[status] ?? 'Not Started';
  }

  async getTask(_taskId: string): Promise<TynePmTask> { notSupported(this.toolName); }
  async getTaskStatus(_taskId: string): Promise<TyneNormalizedPmStatus> { notSupported(this.toolName); }
  async updateTaskStatus(_taskId: string, _status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> { notSupported(this.toolName); }
  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> { notSupported(this.toolName); }
}

const ADAPTER_REGISTRY: Record<string, TynePmToolAdapter> = {
  linear: new LinearAdapter(),
  jira: new JiraAdapter(),
  asana: new AsanaAdapter(),
  notion: new NotionAdapter(),
  monday: new MondayAdapter(),
};

export function getAdapterForTool(toolName: string): TynePmToolAdapter | null {
  return ADAPTER_REGISTRY[(toolName || '').toLowerCase()] ?? null;
}

export function getAdapterForTaskSource(taskSource: string): TynePmToolAdapter | null {
  return getAdapterForTool(taskSource);
}

// Unified task ids are prefixed with their tool (e.g. "jira:TYNE-12"). When the
// human-facing task source is a project label, "Solo Mode", etc., the source no
// longer maps to a tool — but the id prefix still does. Use it as a fallback.
export function getAdapterForTaskId(taskId: string): TynePmToolAdapter | null {
  const prefix = taskId && taskId.includes(':') ? taskId.slice(0, taskId.indexOf(':')) : '';
  return prefix ? getAdapterForTool(prefix) : null;
}

// Resolve a PM adapter tolerantly: prefer the explicit task source, but fall back
// to the tool encoded in the task id so a connected tool is never misreported as
// "not connected" just because the stored source label drifted.
export function resolvePmAdapter(taskSource: string, taskId?: string): TynePmToolAdapter | null {
  return getAdapterForTaskSource(taskSource) || (taskId ? getAdapterForTaskId(taskId) : null);
}
