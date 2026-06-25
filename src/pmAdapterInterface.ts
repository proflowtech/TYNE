import {
  TyneNormalizedPmStatus,
  TynePmTask,
  TynePmStatusUpdateResult,
  TynePmCommentResult,
  TynePmVisibleTyneStatus,
  TynePmStatusWriteResult,
} from './automationTypes';

export interface TynePmToolAdapter {
  readonly toolName: string;

  getTask(taskId: string): Promise<TynePmTask>;
  getTaskStatus(taskId: string): Promise<TyneNormalizedPmStatus>;
  updateTaskStatus(taskId: string, status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult>;
  postTaskComment(taskId: string, body: string): Promise<TynePmCommentResult>;
  updateTaskComment?(taskId: string, commentId: string, body: string): Promise<TynePmCommentResult>;
  updateTyneStatusInPm?(taskId: string, status: TynePmVisibleTyneStatus): Promise<TynePmStatusWriteResult>;
  mapExternalStatusToTyneStatus(externalStatus: string): TyneNormalizedPmStatus;
  mapTyneStatusToExternalStatus(status: TyneNormalizedPmStatus): string;
}

function notSupported(tool: string): never {
  throw new Error(`${tool} PM integration is not connected yet.`);
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

  async getTask(_taskId: string): Promise<TynePmTask> { notSupported(this.toolName); }
  async getTaskStatus(_taskId: string): Promise<TyneNormalizedPmStatus> { notSupported(this.toolName); }
  async updateTaskStatus(_taskId: string, _status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> { notSupported(this.toolName); }
  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> { notSupported(this.toolName); }
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

  async getTask(_taskId: string): Promise<TynePmTask> { notSupported(this.toolName); }
  async getTaskStatus(_taskId: string): Promise<TyneNormalizedPmStatus> { notSupported(this.toolName); }
  async updateTaskStatus(_taskId: string, _status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> { notSupported(this.toolName); }
  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> { notSupported(this.toolName); }
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

  async getTask(_taskId: string): Promise<TynePmTask> { notSupported(this.toolName); }
  async getTaskStatus(_taskId: string): Promise<TyneNormalizedPmStatus> { notSupported(this.toolName); }
  async updateTaskStatus(_taskId: string, _status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> { notSupported(this.toolName); }
  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> { notSupported(this.toolName); }
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

  async getTask(_taskId: string): Promise<TynePmTask> { notSupported(this.toolName); }
  async getTaskStatus(_taskId: string): Promise<TyneNormalizedPmStatus> { notSupported(this.toolName); }
  async updateTaskStatus(_taskId: string, _status: TyneNormalizedPmStatus): Promise<TynePmStatusUpdateResult> { notSupported(this.toolName); }
  async postTaskComment(_taskId: string, _body: string): Promise<TynePmCommentResult> { notSupported(this.toolName); }
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
  return ADAPTER_REGISTRY[toolName.toLowerCase()] ?? null;
}

export function getAdapterForTaskSource(taskSource: string): TynePmToolAdapter | null {
  return getAdapterForTool(taskSource);
}
