import * as vscode from 'vscode';
import { TyneTimeLog, TyneManualTimeEntry, TyneTimeSummary, TyneTimeBreakdownItem, TimeBreakdownType, TimeBreakdownFilters } from './timeTypes';
import { listTimeLogs, listManualEntries } from './timeMetadataService';

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) { return '0m'; }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) { return `${rem}m`; }
  if (rem === 0) { return `${h}h`; }
  return `${h}h ${rem}m`;
}

function startOfDay(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(dateStr: string): Date {
  const d = startOfDay(dateStr);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d;
}

function startOfMonth(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildSummary(
  id: string,
  repositoryPath: string,
  logs: TyneTimeLog[],
  manuals: TyneManualTimeEntry[],
  dateRange: { start: string; end: string },
  extra: Partial<TyneTimeSummary> = {},
): TyneTimeSummary {
  const autoMinutes = logs
    .filter(l => l.source === 'automatic_git')
    .reduce((s, l) => s + l.durationMinutes, 0);
  const manualMinutes = manuals.reduce((s, e) => s + e.durationMinutes, 0);
  const overrideMinutes = logs
    .filter(l => l.source === 'override')
    .reduce((s, l) => s + (l.adjustedDurationMinutes ?? 0), 0);

  const allTimes = [
    ...logs.filter(l => l.startTime).map(l => l.startTime!),
    ...manuals.map(e => e.date),
  ].sort();

  const sessionCommitCounts = logs
    .filter(l => l.source === 'automatic_git')
    .reduce((s, l) => s + (l.commitHashes?.length ?? 0), 0);

  return {
    id,
    repositoryPath,
    dateRange,
    totalMinutes: autoMinutes + manualMinutes + overrideMinutes,
    automaticMinutes: autoMinutes,
    manualMinutes,
    overrideMinutes,
    sessionCount: logs.filter(l => l.source === 'automatic_git').length,
    commitCount: sessionCommitCounts,
    firstActivityAt: allTimes[0],
    lastActivityAt: allTimes[allTimes.length - 1],
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

export function getTaskTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
): TyneTimeSummary {
  const logs = listTimeLogs(context).filter(l => l.taskId === taskId);
  const manuals = listManualEntries(context).filter(e => e.taskId === taskId);
  return buildSummary(`task:${taskId}`, repositoryPath, logs, manuals, { start: '', end: '' }, { taskId });
}

export function getBranchTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
): TyneTimeSummary {
  const logs = listTimeLogs(context).filter(l => l.branchName === branchName);
  const manuals = listManualEntries(context).filter(e => e.branchName === branchName);
  return buildSummary(`branch:${branchName}`, repositoryPath, logs, manuals, { start: '', end: '' }, { branchName });
}

export function getProjectTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
): TyneTimeSummary {
  const logs = listTimeLogs(context).filter(l => l.repositoryPath === repositoryPath);
  const manuals = listManualEntries(context).filter(e => e.repositoryPath === repositoryPath);
  const taskIds = new Set([...logs.map(l => l.taskId), ...manuals.map(e => e.taskId)].filter(Boolean));
  const branchNames = new Set([...logs.map(l => l.branchName), ...manuals.map(e => e.branchName)].filter(Boolean));
  return buildSummary(`project:${repositoryPath}`, repositoryPath, logs, manuals, { start: '', end: '' }, {
    taskCount: taskIds.size,
    branchCount: branchNames.size,
  });
}

function getDateRangeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  rangeStart: Date,
  rangeEnd: Date,
  id: string,
): TyneTimeSummary {
  const startStr = isoDate(rangeStart);
  const endStr = isoDate(rangeEnd);
  const inRange = (dateStr?: string) => {
    if (!dateStr) { return false; }
    const d = dateStr.slice(0, 10);
    return d >= startStr && d < endStr;
  };
  const logs = listTimeLogs(context).filter(l =>
    l.repositoryPath === repositoryPath && inRange(l.startTime ?? l.createdAt),
  );
  const manuals = listManualEntries(context).filter(e =>
    e.repositoryPath === repositoryPath && inRange(e.date),
  );
  return buildSummary(id, repositoryPath, logs, manuals, { start: startStr, end: endStr });
}

export function getDailyTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  date: string,
): TyneTimeSummary {
  const start = startOfDay(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return getDateRangeSummary(context, repositoryPath, start, end, `day:${isoDate(start)}`);
}

export function getWeeklyTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  date: string,
): TyneTimeSummary {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return getDateRangeSummary(context, repositoryPath, start, end, `week:${isoDate(start)}`);
}

export function getMonthlyTimeSummary(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  date: string,
): TyneTimeSummary {
  const start = startOfMonth(date);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return getDateRangeSummary(context, repositoryPath, start, end, `month:${isoDate(start)}`);
}

export function getTimeBreakdown(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  type: TimeBreakdownType,
  filters: TimeBreakdownFilters = {},
): TyneTimeBreakdownItem[] {
  let logs = listTimeLogs(context).filter(l => l.repositoryPath === repositoryPath);
  let manuals = listManualEntries(context).filter(e => e.repositoryPath === repositoryPath);

  if (filters.taskId) {
    logs = logs.filter(l => l.taskId === filters.taskId);
    manuals = manuals.filter(e => e.taskId === filters.taskId);
  }
  if (filters.branchName) {
    logs = logs.filter(l => l.branchName === filters.branchName);
    manuals = manuals.filter(e => e.branchName === filters.branchName);
  }
  if (filters.dateStart) {
    const s = filters.dateStart.slice(0, 10);
    logs = logs.filter(l => (l.startTime ?? l.createdAt).slice(0, 10) >= s);
    manuals = manuals.filter(e => e.date >= s);
  }
  if (filters.dateEnd) {
    const e = filters.dateEnd.slice(0, 10);
    logs = logs.filter(l => (l.startTime ?? l.createdAt).slice(0, 10) <= e);
    manuals = manuals.filter(me => me.date <= e);
  }

  if (type === 'source') {
    const autoMin = logs.filter(l => l.source === 'automatic_git').reduce((s, l) => s + l.durationMinutes, 0);
    const manMin = manuals.reduce((s, e) => s + e.durationMinutes, 0);
    const overMin = logs.filter(l => l.source === 'override').reduce((s, l) => s + (l.adjustedDurationMinutes ?? 0), 0);
    return ([
      { label: 'Automatic Git', type: 'source' as const, totalMinutes: autoMin, automaticMinutes: autoMin, manualMinutes: 0, overrideMinutes: 0 },
      { label: 'Manual', type: 'source' as const, totalMinutes: manMin, automaticMinutes: 0, manualMinutes: manMin, overrideMinutes: 0 },
      { label: 'Override', type: 'source' as const, totalMinutes: overMin, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: overMin },
    ] as TyneTimeBreakdownItem[]).filter(i => i.totalMinutes > 0);
  }

  if (type === 'session') {
    return logs
      .filter(l => l.source === 'automatic_git')
      .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
      .map(l => ({
        label: l.commitSessionId ?? l.id,
        type: 'session' as const,
        totalMinutes: l.durationMinutes,
        automaticMinutes: l.durationMinutes,
        manualMinutes: 0,
        overrideMinutes: 0,
        sessionCount: 1,
        commitCount: l.commitHashes?.length ?? 0,
      }));
  }

  if (type === 'task') {
    const map = new Map<string, TyneTimeBreakdownItem>();
    logs.forEach(l => {
      const key = l.taskId ?? 'Unlinked';
      const ex = map.get(key) ?? { label: l.taskTitle ?? key, type: 'task' as const, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0, sessionCount: 0, commitCount: 0 };
      ex.automaticMinutes += l.source === 'automatic_git' ? l.durationMinutes : 0;
      ex.overrideMinutes += l.source === 'override' ? (l.adjustedDurationMinutes ?? 0) : 0;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      ex.sessionCount = (ex.sessionCount ?? 0) + (l.source === 'automatic_git' ? 1 : 0);
      ex.commitCount = (ex.commitCount ?? 0) + (l.commitHashes?.length ?? 0);
      map.set(key, ex);
    });
    manuals.forEach(e => {
      const key = e.taskId ?? 'Unlinked';
      const ex = map.get(key) ?? { label: e.taskTitle ?? key, type: 'task' as const, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0, sessionCount: 0, commitCount: 0 };
      ex.manualMinutes += e.durationMinutes;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      map.set(key, ex);
    });
    return [...map.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
  }

  if (type === 'branch') {
    const map = new Map<string, TyneTimeBreakdownItem>();
    logs.forEach(l => {
      const key = l.branchName ?? 'Unknown';
      const ex = map.get(key) ?? { label: key, type: 'branch' as const, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0, sessionCount: 0, commitCount: 0 };
      ex.automaticMinutes += l.source === 'automatic_git' ? l.durationMinutes : 0;
      ex.overrideMinutes += l.source === 'override' ? (l.adjustedDurationMinutes ?? 0) : 0;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      ex.sessionCount = (ex.sessionCount ?? 0) + (l.source === 'automatic_git' ? 1 : 0);
      ex.commitCount = (ex.commitCount ?? 0) + (l.commitHashes?.length ?? 0);
      map.set(key, ex);
    });
    manuals.forEach(e => {
      const key = e.branchName ?? 'Unknown';
      const ex = map.get(key) ?? { label: key, type: 'branch' as const, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0 };
      ex.manualMinutes += e.durationMinutes;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      map.set(key, ex);
    });
    return [...map.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
  }

  if (type === 'day' || type === 'week' || type === 'month') {
    const periodType = type as TyneTimeBreakdownItem['type'];
    const map = new Map<string, TyneTimeBreakdownItem>();
    const getKey = (dateStr: string) => {
      if (type === 'day') { return dateStr.slice(0, 10); }
      if (type === 'week') { return isoDate(startOfWeek(dateStr)); }
      return isoDate(startOfMonth(dateStr));
    };
    logs.forEach(l => {
      const raw = l.startTime ?? l.createdAt;
      const key = getKey(raw);
      const ex = map.get(key) ?? { label: key, type: periodType, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0 };
      ex.automaticMinutes += l.source === 'automatic_git' ? l.durationMinutes : 0;
      ex.overrideMinutes += l.source === 'override' ? (l.adjustedDurationMinutes ?? 0) : 0;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      map.set(key, ex);
    });
    manuals.forEach(e => {
      const key = getKey(e.date);
      const ex = map.get(key) ?? { label: key, type: periodType, totalMinutes: 0, automaticMinutes: 0, manualMinutes: 0, overrideMinutes: 0 };
      ex.manualMinutes += e.durationMinutes;
      ex.totalMinutes = ex.automaticMinutes + ex.manualMinutes + ex.overrideMinutes;
      map.set(key, ex);
    });
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([, v]) => v);
  }

  return [];
}
