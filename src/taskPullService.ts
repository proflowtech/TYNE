import * as vscode from 'vscode';
import {
  TynePmTool,
  TyneTask,
  TyneTaskDetails,
  TynePullTasksInput,
  TyneTaskSyncState,
} from './taskTypes';
import {
  replaceTasksForProvider,
  saveTaskDetails,
  listCachedTasksSync,
  saveTaskSyncState,
  getTaskSyncStateSync,
  markTasksCachedOnlyForProvider,
} from './taskCacheService';
import { getAdapter, getConnectedToolsSync } from './taskProviderRegistry';
import { JiraCachedTasksError } from './jiraProvider';

export const DEFAULT_PULL_INPUT: TynePullTasksInput = {
  assignedOnly: true,
  includeCompleted: false,
  updatedSinceDays: 30,
};

function now(): string { return new Date().toISOString(); }

// ── Pull tasks from a single provider ─────────────────────────────────────────

export async function pullTasks(
  context: vscode.ExtensionContext,
  tool: TynePmTool,
  input: TynePullTasksInput = DEFAULT_PULL_INPUT,
): Promise<TyneTask[]> {
  const state = getTaskSyncStateSync(context, tool);
  const updating: TyneTaskSyncState = { ...state, syncStatus: 'syncing', connected: true };
  await saveTaskSyncState(context, updating);

  try {
    const adapter = getAdapter(tool);
    const tasks = await adapter.pullTasks(input);
    await replaceTasksForProvider(context, tool, tasks);

    const cached = listCachedTasksSync(context).filter(t => t.sourceTool === tool);
    await saveTaskSyncState(context, {
      ...updating,
      syncStatus: 'online',
      lastSyncedAt: now(),
      cachedTaskCount: cached.length,
      errorMessage: undefined,
      connected: true,
    });
    if (tool === 'jira' && tasks.length === 0) {
      await saveTaskSyncState(context, {
        ...updating,
        syncStatus: 'online',
        lastSyncedAt: now(),
        cachedTaskCount: 0,
        connected: true,
        errorMessage: 'No open Jira issues assigned to you',
      });
    }
    return tasks;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (tool === 'jira' && err instanceof JiraCachedTasksError) {
      await markTasksCachedOnlyForProvider(context, tool);
    }
    await saveTaskSyncState(context, {
      ...updating,
      syncStatus: tool === 'jira' && err instanceof JiraCachedTasksError ? 'offline' : 'failed',
      errorMessage: msg,
      connected: !(tool === 'jira' && /reconnect jira|session expired/i.test(msg)),
    });
    throw err;
  }
}

// ── Pull from all connected providers ─────────────────────────────────────────

export async function pullAllConnectedProviderTasks(
  context: vscode.ExtensionContext,
  input: TynePullTasksInput = DEFAULT_PULL_INPUT,
): Promise<TyneTask[]> {
  const tools = getConnectedToolsSync(context);
  const results: TyneTask[] = [];
  for (const tool of tools) {
    const tasks = await pullTasks(context, tool, input).catch(() => [] as TyneTask[]);
    results.push(...tasks);
  }
  return results;
}

// ── Pull full task detail ─────────────────────────────────────────────────────

export async function pullTaskDetails(
  context: vscode.ExtensionContext,
  taskId: string,
  tool: TynePmTool,
): Promise<TyneTaskDetails> {
  const adapter = getAdapter(tool);
  const details = await adapter.getTaskDetails(taskId);
  await saveTaskDetails(context, details);
  return details;
}

// ── Refresh a single task ─────────────────────────────────────────────────────

export async function refreshTask(
  context: vscode.ExtensionContext,
  taskId: string,
  tool: TynePmTool,
): Promise<TyneTaskDetails> {
  return pullTaskDetails(context, taskId, tool);
}
