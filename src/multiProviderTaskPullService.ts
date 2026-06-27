import * as vscode from 'vscode';
import {
  TynePmTool,
  TyneTask,
  TynePullTasksInput,
} from './taskTypes';
import { getAdapter, getConnectedToolsSync } from './taskProviderRegistry';
import {
  replaceTasksForProvider,
  listCachedTasksSync,
  saveTaskSyncState,
  getTaskSyncStateSync,
  markTasksCachedOnlyForProvider,
} from './taskCacheService';
import { JiraCachedTasksError } from './jiraProvider';

const ISO = () => new Date().toISOString();

// ── Single provider ───────────────────────────────────────────────────────────

export async function pullTasksFromProvider(
  context: vscode.ExtensionContext,
  provider: TynePmTool,
  input: TynePullTasksInput = {},
): Promise<{ tasks: TyneTask[]; error?: string }> {
  const adapter = getAdapter(provider);
  const syncState = getTaskSyncStateSync(context, provider);
  await saveTaskSyncState(context, { ...syncState, syncStatus: 'syncing', sourceTool: provider });

  try {
    const tasks = await adapter.pullTasks(input);
    await replaceTasksForProvider(context, provider, tasks);
    await saveTaskSyncState(context, {
      sourceTool: provider,
      syncStatus: 'online',
      lastSyncedAt: ISO(),
      cachedTaskCount: listCachedTasksSync(context).filter(t => t.sourceTool === provider).length,
      connected: true,
      errorMessage: provider === 'jira' && tasks.length === 0 ? 'No open Jira issues assigned to you' : undefined,
    });
    return { tasks };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (provider === 'jira' && err instanceof JiraCachedTasksError) {
      await markTasksCachedOnlyForProvider(context, provider);
    }
    await saveTaskSyncState(context, {
      sourceTool: provider,
      syncStatus: provider === 'jira' && err instanceof JiraCachedTasksError ? 'offline' : 'failed',
      errorMessage: message,
      cachedTaskCount: syncState.cachedTaskCount,
      connected: !(provider === 'jira' && /reconnect jira|session expired/i.test(message)),
    });
    return { tasks: [], error: message };
  }
}

// ── All connected providers ───────────────────────────────────────────────────

export interface MultiProviderPullResult {
  tasks: TyneTask[];
  errors: Record<TynePmTool, string>;
  failedProviders: TynePmTool[];
  succeededProviders: TynePmTool[];
}

export async function pullTasksFromAllConnectedProviders(
  context: vscode.ExtensionContext,
  input: TynePullTasksInput = {},
): Promise<MultiProviderPullResult> {
  const connected = getConnectedToolsSync(context);
  const allTasks: TyneTask[] = [];
  const errors: Record<string, string> = {};
  const failedProviders: TynePmTool[] = [];
  const succeededProviders: TynePmTool[] = [];

  await Promise.all(connected.map(async (provider) => {
    const result = await pullTasksFromProvider(context, provider, input);
    if (result.error) {
      errors[provider] = result.error;
      failedProviders.push(provider);
    } else {
      allTasks.push(...result.tasks);
      succeededProviders.push(provider);
    }
  }));

  return {
    tasks: allTasks,
    errors: errors as Record<TynePmTool, string>,
    failedProviders,
    succeededProviders,
  };
}

// ── Refresh single provider ───────────────────────────────────────────────────

export async function refreshProvider(
  context: vscode.ExtensionContext,
  provider: TynePmTool,
): Promise<void> {
  await pullTasksFromProvider(context, provider);
}

// ── Refresh all providers ─────────────────────────────────────────────────────

export async function refreshAllProviders(context: vscode.ExtensionContext): Promise<void> {
  const connected = getConnectedToolsSync(context);
  await Promise.all(connected.map(p => pullTasksFromProvider(context, p)));
}

// ── Get unified task list from cache ─────────────────────────────────────────

export function getUnifiedTaskListSync(
  context: vscode.ExtensionContext,
  sourceFilter?: TynePmTool,
): TyneTask[] {
  const all = listCachedTasksSync(context);
  if (!sourceFilter) { return all; }
  return all.filter(t => t.sourceTool === sourceFilter);
}

// ── Build human-readable sync summary ────────────────────────────────────────

export function buildMultiProviderSyncSummary(
  context: vscode.ExtensionContext,
  connected: TynePmTool[],
): { tool: TynePmTool; syncStatus: string; lastSyncedAt?: string; cachedCount: number; error?: string }[] {
  return connected.map(tool => {
    const s = getTaskSyncStateSync(context, tool);
    return {
      tool,
      syncStatus: s.syncStatus,
      lastSyncedAt: s.lastSyncedAt,
      cachedCount: s.cachedTaskCount,
      error: s.errorMessage,
    };
  });
}
