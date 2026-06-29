export type TynePmTool =
  | 'linear'
  | 'jira'
  | 'asana'
  | 'notion'
  | 'monday';

export const ALL_PM_TOOLS: TynePmTool[] = ['linear', 'jira', 'asana', 'notion', 'monday'];

export type TyneNormalizedTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'canceled'
  | 'unknown';

export type TyneNormalizedTaskPriority =
  | 'urgent'
  | 'high'
  | 'medium'
  | 'low'
  | 'none'
  | 'unknown';

export const PRIORITY_RANK: Record<TyneNormalizedTaskPriority, number> = {
  urgent: 0, high: 1, medium: 2, low: 3, none: 4, unknown: 5,
};

export interface TyneTask {
  id: string;
  externalId: string;
  title: string;
  description?: string;
  status: string;
  normalizedStatus: TyneNormalizedTaskStatus;
  priority?: string;
  normalizedPriority: TyneNormalizedTaskPriority;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeAvatarUrl?: string;
  sourceTool: TynePmTool;
  sourceProject?: string;
  sourceUrl?: string;
  issueType?: string;
  issueTypeIconUrl?: string;
  statusCategory?: string;
  labels?: string[];
  parentKey?: string;
  parentTitle?: string;
  createdAt?: string;
  updatedAt?: string;
  dueDate?: string;
  lastSyncedAt: string;
  cachedAt: string;
  isCachedOnly?: boolean;
}

export interface TyneSubtask {
  id: string;
  title: string;
  status?: string;
  normalizedStatus?: TyneNormalizedTaskStatus;
  assigneeName?: string;
  dueDate?: string;
}

export interface TyneTaskComment {
  id: string;
  authorName?: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  sourceTool: TynePmTool;
}

export interface TyneTaskNote {
  id: string;
  authorName?: string;
  body: string;
  createdAt?: string;
  sourceTool: TynePmTool;
}

export interface TyneTaskHistoryEvent {
  id: string;
  type: string;
  title?: string;
  fromValue?: string;
  toValue?: string;
  actorName?: string;
  createdAt: string;
  sourceTool: TynePmTool;
}

export interface TyneTaskDetails extends TyneTask {
  subtasks: TyneSubtask[];
  comments: TyneTaskComment[];
  notes: TyneTaskNote[];
  historyLast30Days: TyneTaskHistoryEvent[];
}

export interface TyneTaskSyncState {
  sourceTool: TynePmTool;
  lastSyncedAt?: string;
  syncStatus: 'online' | 'offline' | 'syncing' | 'failed' | 'idle';
  errorMessage?: string;
  cachedTaskCount: number;
  connected: boolean;
}

export interface TyneTaskFilters {
  statuses?: TyneNormalizedTaskStatus[];
  assignees?: string[];
  priorities?: TyneNormalizedTaskPriority[];
  sourceTools?: TynePmTool[];
  projects?: string[];
  dueDatePreset?: 'today' | 'this_week' | 'overdue';
  updatedPreset?: 'last_7_days' | 'last_30_days';
}

export type TyneTaskSortKey =
  | 'updatedAt'
  | 'createdAt'
  | 'dueDate'
  | 'priority'
  | 'title'
  | 'status';

export interface TyneTaskSort {
  key: TyneTaskSortKey;
  direction: 'asc' | 'desc';
}

export const DEFAULT_TASK_SORT: TyneTaskSort = { key: 'updatedAt', direction: 'desc' };

export interface TynePullTasksInput {
  assignedOnly?: boolean;
  includeCompleted?: boolean;
  updatedSinceDays?: number;
  projectId?: string;
  // When true, bypass any in-memory/provider-side task cache and always hit the
  // backend so the result reflects the current PM-tool state (e.g. an explicit
  // "Refresh" press after the user changed assignments in Jira).
  forceRefresh?: boolean;
}

export interface TynePmConnectionResult {
  connected: boolean;
  toolName: TynePmTool;
  errorMessage?: string;
}

export interface TyneTaskProviderAdapter {
  readonly toolName: TynePmTool;
  connect(): Promise<TynePmConnectionResult>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getCapabilities(): Promise<TyneTaskProviderCapabilities>;
  pullTasks(input: TynePullTasksInput): Promise<TyneTask[]>;
  getTaskDetails(taskId: string): Promise<TyneTaskDetails>;
  getTaskComments(taskId: string): Promise<TyneTaskComment[]>;
  getTaskHistoryLast30Days(taskId: string): Promise<TyneTaskHistoryEvent[]>;
  createTask(input: TyneCreateTaskInput): Promise<TyneTaskDetails>;
  updateTask(taskId: string, input: TyneUpdateTaskInput): Promise<TyneTaskDetails>;
  addSubtask?(taskId: string, input: { title: string; assigneeId?: string; dueDate?: string }): Promise<TyneSubtask>;
  updateSubtask?(taskId: string, subtaskId: string, input: Partial<TyneSubtask>): Promise<TyneSubtask>;
  addComment?(taskId: string, body: string): Promise<TyneTaskComment>;
  subscribeToTaskUpdates?(callback: (event: TyneTaskProviderUpdateEvent) => void): Promise<() => void>;
  normalizeStatus(externalStatus: string): TyneNormalizedTaskStatus;
  normalizePriority(externalPriority?: string): TyneNormalizedTaskPriority;
  mapTyneStatusToExternalStatus(status: TyneNormalizedTaskStatus): string;
  mapTynePriorityToExternalPriority(priority: TyneNormalizedTaskPriority): string;
}

// ── Pro/Max tier ──────────────────────────────────────────────────────────────

export type TynePlanTier = 'free' | 'pro' | 'max';

export interface TyneTaskProviderCapabilities {
  canCreateTask: boolean;
  canEditTitle: boolean;
  canEditDescription: boolean;
  canEditStatus: boolean;
  canEditPriority: boolean;
  canEditAssignee: boolean;
  canEditDueDate: boolean;
  canEditLabels: boolean;
  canAddSubtask: boolean;
  canEditSubtask: boolean;
  canAddComment: boolean;
  supportsRealtimeEvents: boolean;
  supportsTaskHistory: boolean;
  supportsLabels: boolean;
  supportsSprints: boolean;
  supportsMilestones: boolean;
}

export const FREE_CAPABILITIES: TyneTaskProviderCapabilities = {
  canCreateTask: false, canEditTitle: false, canEditDescription: false,
  canEditStatus: false, canEditPriority: false, canEditAssignee: false,
  canEditDueDate: false, canEditLabels: false, canAddSubtask: false,
  canEditSubtask: false, canAddComment: false, supportsRealtimeEvents: false,
  supportsTaskHistory: false, supportsLabels: false, supportsSprints: false, supportsMilestones: false,
};

export interface TyneAdvancedTaskFilters {
  statuses?: TyneNormalizedTaskStatus[];
  assignees?: string[];
  priorities?: TyneNormalizedTaskPriority[];
  sourceTools?: TynePmTool[];
  projects?: string[];
  labels?: string[];
  sprints?: string[];
  milestones?: string[];
  taskTypes?: string[];
  dueDatePreset?: 'today' | 'this_week' | 'overdue' | 'none';
  updatedPreset?: 'last_7_days' | 'last_30_days' | 'none';
  createdPreset?: 'last_7_days' | 'last_30_days' | 'none';
  hasBranch?: boolean;
  hasCommits?: boolean;
  hasTimeTracked?: boolean;
  validationStatuses?: Array<'pass' | 'partial' | 'fail' | 'not_run'>;
  localStatuses?: string[];
}

export interface TyneSortRule {
  key:
    | 'updatedAt' | 'createdAt' | 'dueDate' | 'priority' | 'title'
    | 'status' | 'sourceTool' | 'project' | 'assignee'
    | 'localActivity' | 'latestCommitDate' | 'timeTracked' | 'validationStatus';
  direction: 'asc' | 'desc';
}

export interface TyneAdvancedTaskSort {
  rules: TyneSortRule[];
}

export const DEFAULT_ADVANCED_SORT: TyneAdvancedTaskSort = {
  rules: [{ key: 'updatedAt', direction: 'desc' }],
};

export interface TyneTaskFilterPreset {
  id: string;
  name: string;
  query?: string;
  sourceTools?: TynePmTool[];
  filters: TyneAdvancedTaskFilters;
  sort: TyneAdvancedTaskSort;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TyneCreateTaskInput {
  sourceTool: TynePmTool;
  projectId?: string;
  title: string;
  description?: string;
  status?: TyneNormalizedTaskStatus;
  priority?: TyneNormalizedTaskPriority;
  assigneeId?: string;
  dueDate?: string;
  labels?: string[];
}

export interface TyneUpdateTaskInput {
  title?: string;
  description?: string;
  status?: TyneNormalizedTaskStatus;
  priority?: TyneNormalizedTaskPriority;
  assigneeId?: string;
  dueDate?: string;
  labels?: string[];
}

export interface TyneTaskEditEvent {
  id: string;
  taskId: string;
  sourceTool: TynePmTool;
  action: 'create_task' | 'update_task' | 'add_subtask' | 'update_subtask' | 'add_comment';
  status: 'pending' | 'success' | 'failed';
  previousValue?: unknown;
  newValue?: unknown;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TyneTaskConflict {
  taskId: string;
  sourceTool: TynePmTool;
  conflictType: 'external_change' | 'deleted' | 'moved' | 'assignee_removed';
  message: string;
  latestPmSnapshot?: Partial<TyneTask>;
  detectedAt: string;
}

export interface TyneTaskProviderUpdateEvent {
  sourceTool: TynePmTool;
  taskId: string;
  eventType: 'updated' | 'deleted' | 'created' | 'status_changed';
  snapshot?: Partial<TyneTask>;
  receivedAt: string;
}

export interface TyneParsedTaskQuery {
  textQuery: string;
  filters: TyneAdvancedTaskFilters;
  sort?: TyneAdvancedTaskSort;
  parseErrors: string[];
}

// Extended TyneTask fields for Pro/Max (optional enrichment)
export interface TyneTaskProFields {
  labels?: string[];
  sprint?: string;
  milestone?: string;
  taskType?: string;
  sourceWorkspace?: string;
  localTyneStatus?: string;
  linkedBranchName?: string;
  commitCount?: number;
  timeTrackedMinutes?: number;
  validationStatus?: 'pass' | 'partial' | 'fail' | 'not_run';
  latestCommitDate?: string;
  assigneeId?: string;
  assigneeEmail?: string;
  assigneeAvatarUrl?: string;
}

export interface TynePmTaskIntelligenceSubtask {
  title: string;
  description: string;
}

export interface TynePmTaskIntelligence {
  issueKey: string;
  goal: string;
  subtasks: TynePmTaskIntelligenceSubtask[];
  acceptanceCriteria: string[];
  proofPointTemplates: string[];
  validationSteps: string[];
  suggestedBranchName: string;
  repositoryId?: string;
  storedAt?: string;
  modelProvider?: string;
  modelName?: string;
}

export interface TynePmTaskValidationResult {
  status: 'pass' | 'partial' | 'fail';
  matchPercent?: number;
  summary: string;
  passedCriteria: string[];
  failedCriteria: Array<{ criterion: string; reason: string }>;
  missingWork: string[];
  generatedProofPoints: string[];
  recommendedNextActions: string[];
  modelProvider: string;
  modelName: string;
  jiraIssueKey?: string;
  repositoryId?: string | null;
  branchName?: string;
  changedFiles?: string[];
}
