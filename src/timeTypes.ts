export type TyneTimeSource = 'automatic_git' | 'manual' | 'override';

export interface TyneTimeLog {
  id: string;
  repositoryPath: string;
  repositoryName?: string;
  branchName?: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  commitSessionId?: string;
  commitHashes?: string[];
  source: TyneTimeSource;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  originalDurationMinutes?: number;
  adjustedDurationMinutes?: number;
  adjustmentReason?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TyneManualTimeEntry {
  id: string;
  repositoryPath: string;
  repositoryName?: string;
  branchName?: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TyneTimeSummary {
  id: string;
  repositoryPath: string;
  taskId?: string;
  branchName?: string;
  dateRange: { start: string; end: string };
  totalMinutes: number;
  automaticMinutes: number;
  manualMinutes: number;
  overrideMinutes: number;
  sessionCount: number;
  commitCount: number;
  taskCount?: number;
  branchCount?: number;
  firstActivityAt?: string;
  lastActivityAt?: string;
  updatedAt: string;
}

export interface TyneTimeBreakdownItem {
  label: string;
  type: 'session' | 'task' | 'branch' | 'project' | 'day' | 'week' | 'month' | 'source';
  totalMinutes: number;
  automaticMinutes: number;
  manualMinutes: number;
  overrideMinutes: number;
  sessionCount?: number;
  commitCount?: number;
}

export type TimeBreakdownType = TyneTimeBreakdownItem['type'];

export interface ManualTimeEntryInput {
  repositoryPath: string;
  repositoryName?: string;
  branchName?: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  date: string;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  note?: string;
}

export interface TimeBreakdownFilters {
  taskId?: string;
  branchName?: string;
  repositoryPath?: string;
  dateStart?: string;
  dateEnd?: string;
}
