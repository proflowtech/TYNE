import * as vscode from 'vscode';
import {
  TyneTaskSyncState,
  TyneLocalTaskStatus,
  TyneNormalizedPmStatus,
  TyneTaskStatusConflict,
  TyneAutomationEvent,
  TyneAutomationStatus,
} from './automationTypes';
import {
  getTaskSyncState,
  saveTaskSyncState,
  saveAutomationEvent,
  makeEventId,
} from './automationMetadataService';
import { getAdapterForTaskSource } from './pmAdapterInterface';

export async function refreshTaskStatus(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
  taskTitle: string | undefined,
  taskSource: string,
  taskUrl: string | undefined,
  branchName: string | undefined,
): Promise<TyneTaskSyncState> {
  return syncTaskStatusFromPm(
    context, repositoryPath, taskId, taskTitle, taskSource, taskUrl, branchName,
  );
}

export async function syncTaskStatusFromPm(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
  taskTitle: string | undefined,
  taskSource: string,
  taskUrl: string | undefined,
  branchName: string | undefined,
): Promise<TyneTaskSyncState> {
  const now = new Date().toISOString();
  const adapter = getAdapterForTaskSource(taskSource);
  const existing = getTaskSyncState(context, taskId);

  if (!adapter) {
    const state: TyneTaskSyncState = {
      taskId,
      taskTitle,
      taskSource,
      taskUrl,
      repositoryPath,
      branchName,
      pmTool: taskSource,
      pmTaskId: taskId,
      pmStatus: existing?.pmStatus ?? 'unknown',
      localStatus: existing?.localStatus ?? 'unknown',
      lastSyncedAt: now,
      syncError: `${taskSource} PM tool is not connected yet.`,
      updatedAt: now,
    };
    await saveTaskSyncState(context, state);
    return state;
  }

  let pmStatus: TyneNormalizedPmStatus = existing?.pmStatus ?? 'unknown';
  let syncError: string | undefined;

  try {
    pmStatus = await adapter.getTaskStatus(taskId);
  } catch (err) {
    syncError = err instanceof Error ? err.message : String(err);
  }

  const state: TyneTaskSyncState = {
    taskId,
    taskTitle,
    taskSource,
    taskUrl,
    repositoryPath,
    branchName,
    pmTool: adapter.toolName,
    pmTaskId: taskId,
    pmStatus,
    localStatus: existing?.localStatus ?? mapPmStatusToLocal(pmStatus),
    lastSyncedAt: now,
    syncError,
    updatedAt: now,
  };

  await saveTaskSyncState(context, state);
  return state;
}

export async function updateLocalTaskStatus(
  context: vscode.ExtensionContext,
  taskId: string,
  status: TyneLocalTaskStatus,
): Promise<TyneTaskSyncState> {
  const existing = getTaskSyncState(context, taskId);
  const now = new Date().toISOString();
  const state: TyneTaskSyncState = {
    taskId,
    taskTitle: existing?.taskTitle,
    taskSource: existing?.taskSource ?? 'unknown',
    taskUrl: existing?.taskUrl,
    repositoryPath: existing?.repositoryPath ?? '',
    branchName: existing?.branchName,
    pmTool: existing?.pmTool ?? 'unknown',
    pmTaskId: existing?.pmTaskId ?? taskId,
    pmStatus: existing?.pmStatus ?? 'unknown',
    localStatus: status,
    lastSyncedAt: existing?.lastSyncedAt,
    lastTyneStatusWriteAt: now,
    syncError: existing?.syncError,
    updatedAt: now,
  };
  await saveTaskSyncState(context, state);
  return state;
}

export async function syncTyneStatusToPm(
  context: vscode.ExtensionContext,
  taskId: string,
  taskSource: string,
  branchName: string | undefined,
  latestCommitHash: string | undefined,
  latestCommitUrl: string | undefined,
): Promise<TyneAutomationEvent> {
  const now = new Date().toISOString();
  const syncState = getTaskSyncState(context, taskId);
  const adapter = getAdapterForTaskSource(taskSource);
  const eventId = makeEventId('sync_status', taskId);

  const baseEvent: TyneAutomationEvent = {
    id: eventId,
    taskId,
    taskSource,
    repositoryPath: syncState?.repositoryPath ?? '',
    branchName,
    actionType: 'sync_status',
    status: 'pending' as TyneAutomationStatus,
    triggerSource: 'status_refresh',
    pmTool: taskSource,
    pmTaskId: taskId,
    commitHash: latestCommitHash,
    createdAt: now,
    updatedAt: now,
  };

  if (!adapter || !adapter.updateTyneStatusInPm) {
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: 'skipped',
      errorMessage: `${taskSource} does not support writing Tyne status to PM.`,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  try {
    const result = await adapter.updateTyneStatusInPm(taskId, {
      localStatus: syncState?.localStatus ?? 'unknown',
      branchName,
      latestCommitHash,
      latestCommitUrl,
      lastSyncedAt: now,
    });
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: result.success ? 'success' : 'failed',
      errorMessage: result.errorMessage,
    };
    if (result.success) {
      await saveTaskSyncState(context, { ...syncState!, lastPmWriteAt: now, updatedAt: now });
    }
    await saveAutomationEvent(context, ev);
    return ev;
  } catch (err) {
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }
}

export function detectStatusConflict(
  context: vscode.ExtensionContext,
  taskId: string,
): TyneTaskStatusConflict | null {
  const state = getTaskSyncState(context, taskId);
  if (!state) { return null; }
  const pmDone = state.pmStatus === 'done';
  const localDone = state.localStatus === 'completed';
  const mismatch =
    (pmDone && !localDone) ||
    (!pmDone && localDone && state.localStatus !== 'sync_error');
  if (!mismatch) { return null; }
  return {
    taskId,
    pmStatus: state.pmStatus,
    localStatus: state.localStatus,
    detectedAt: new Date().toISOString(),
  };
}

function mapPmStatusToLocal(pmStatus: TyneNormalizedPmStatus): TyneLocalTaskStatus {
  if (pmStatus === 'done') { return 'completed'; }
  if (pmStatus === 'in_progress' || pmStatus === 'in_review') { return 'active'; }
  if (pmStatus === 'todo') { return 'not_started'; }
  if (pmStatus === 'blocked') { return 'paused'; }
  if (pmStatus === 'canceled') { return 'completed'; }
  return 'unknown';
}
