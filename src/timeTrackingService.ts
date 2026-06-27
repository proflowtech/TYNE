import * as vscode from 'vscode';
import { TyneCommitSession } from './commitTypes';
import { TyneTimeLog } from './timeTypes';
import {
  listTimeLogs,
  saveTimeLog,
  replaceTimeLogs,
} from './timeMetadataService';
import { formatDuration } from './timeSummaryService';

function sessionToTimeLogId(session: TyneCommitSession): string {
  return `auto:${session.id}`;
}

export function buildTimeLogFromSession(
  session: TyneCommitSession,
  repositoryPath: string,
  repositoryName?: string,
): TyneTimeLog {
  const now = new Date().toISOString();
  const isSingleCommit = session.commitCount <= 1;
  return {
    id: sessionToTimeLogId(session),
    repositoryPath,
    repositoryName,
    branchName: session.branchName,
    taskId: session.taskId,
    taskTitle: session.taskTitle,
    taskSource: session.taskSource,
    commitSessionId: session.id,
    commitHashes: session.commitHashes,
    source: 'automatic_git',
    startTime: session.startTime,
    endTime: session.endTime,
    durationMinutes: isSingleCommit ? 0 : session.durationMinutes,
    originalDurationMinutes: isSingleCommit ? 0 : session.durationMinutes,
    note: isSingleCommit
      ? 'Single commit session. Add manual time if needed.'
      : 'Estimated from Git activity',
    createdAt: now,
    updatedAt: now,
  };
}

export async function generateTimeLogsFromSessions(
  context: vscode.ExtensionContext,
  sessions: TyneCommitSession[],
  repositoryPath: string,
  repositoryName?: string,
): Promise<TyneTimeLog[]> {
  const existingLogs = listTimeLogs(context);

  const newAutoLogs: TyneTimeLog[] = sessions.map(s =>
    buildTimeLogFromSession(s, repositoryPath, repositoryName),
  );

  const existingAutoIds = new Set(
    existingLogs.filter(l => l.source === 'automatic_git').map(l => l.id),
  );
  const newAutoIds = new Set(newAutoLogs.map(l => l.id));

  const nonAutoLogs = existingLogs.filter(l => l.source !== 'automatic_git');
  const overrideLogs = existingLogs.filter(
    l => l.source === 'override' && l.commitSessionId,
  );

  const mergedAuto = newAutoLogs.map(newLog => {
    if (existingAutoIds.has(newLog.id)) {
      const existing = existingLogs.find(l => l.id === newLog.id)!;
      if (existing.source === 'automatic_git') {
        return {
          ...newLog,
          createdAt: existing.createdAt,
          synced: existing.synced,
          syncedAt: existing.syncedAt,
          syncedWorklogIds: existing.syncedWorklogIds,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return newLog;
  });

  const staleLogs = existingLogs.filter(
    l => l.source === 'automatic_git' && !newAutoIds.has(l.id),
  );
  void staleLogs;

  const merged = [...mergedAuto, ...nonAutoLogs.filter(l => l.source !== 'override'), ...overrideLogs];
  await replaceTimeLogs(context, merged);
  return merged;
}

export function getTimeLogsForTask(context: vscode.ExtensionContext, taskId: string): TyneTimeLog[] {
  return listTimeLogs(context).filter(l => l.taskId === taskId);
}

export function getTimeLogsForBranch(context: vscode.ExtensionContext, branchName: string): TyneTimeLog[] {
  return listTimeLogs(context).filter(l => l.branchName === branchName);
}

export function getTimeLogsForProject(context: vscode.ExtensionContext, repositoryPath: string): TyneTimeLog[] {
  return listTimeLogs(context).filter(l => l.repositoryPath === repositoryPath);
}

export function getUnsyncedTimeLogsForTask(context: vscode.ExtensionContext, taskId: string): TyneTimeLog[] {
  const logs = listTimeLogs(context).filter(log =>
    log.taskId === taskId &&
    log.durationMinutes > 0 &&
    !log.synced &&
    (log.source === 'automatic_git' || log.source === 'override'),
  );

  const preferredBySession = new Map<string, TyneTimeLog>();
  for (const log of logs) {
    const key = log.commitSessionId || log.id;
    const existing = preferredBySession.get(key);
    if (!existing || (existing.source === 'automatic_git' && log.source === 'override')) {
      preferredBySession.set(key, log);
    }
  }

  return Array.from(preferredBySession.values()).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
}

export async function markTimeLogsSynced(
  context: vscode.ExtensionContext,
  logsToSync: TyneTimeLog[],
  worklogIds: string[] = [],
): Promise<void> {
  if (!logsToSync.length) { return; }
  const now = new Date().toISOString();
  const ids = new Set(logsToSync.map(log => log.id));
  const sessionIds = new Set(logsToSync.map(log => log.commitSessionId).filter((value): value is string => Boolean(value)));
  const logs = listTimeLogs(context).map(log => {
    const sameSession = log.commitSessionId && sessionIds.has(log.commitSessionId);
    if (!ids.has(log.id) && !sameSession) { return log; }
    return {
      ...log,
      synced: true,
      syncedAt: now,
      syncedWorklogIds: Array.from(new Set([...(log.syncedWorklogIds || []), ...worklogIds])),
      updatedAt: now,
    };
  });
  await replaceTimeLogs(context, logs);
}

export function getTimeLogSyncSummary(logs: TyneTimeLog[]): { totalSeconds: number; label: string } {
  const totalMinutes = logs.reduce((sum, log) => sum + Math.max(0, log.durationMinutes), 0);
  return {
    totalSeconds: Math.max(0, Math.round(totalMinutes * 60)),
    label: formatDuration(totalMinutes),
  };
}

export async function createOverrideLog(
  context: vscode.ExtensionContext,
  originalLogId: string,
  newDurationMinutes: number,
  reason: string,
): Promise<TyneTimeLog | null> {
  const logs = listTimeLogs(context);
  const original = logs.find(l => l.id === originalLogId);
  if (!original) { return null; }
  const now = new Date().toISOString();
  const override: TyneTimeLog = {
    ...original,
    id: `override:${originalLogId}`,
    source: 'override',
    durationMinutes: newDurationMinutes,
    originalDurationMinutes: original.durationMinutes,
    adjustedDurationMinutes: newDurationMinutes,
    adjustmentReason: reason,
    updatedAt: now,
  };
  await saveTimeLog(context, override);
  return override;
}
