import * as vscode from 'vscode';
import { TynePmTool, TyneTask, TyneTaskSyncState } from './taskTypes';
import {
  listCachedTasksSync,
  getTaskSyncStateSync,
  saveTaskSyncState,
  markAllTasksAsCachedOnly,
} from './taskCacheService';
import { getConnectedToolsSync } from './taskProviderRegistry';
import { pullAllConnectedProviderTasks } from './taskPullService';

const KEY_LAST_ONLINE = 'tyne.lastOnlineAt';

// ── Online detection ──────────────────────────────────────────────────────────

export async function isOnline(): Promise<boolean> {
  try {
    await fetch('https://clients3.google.com/generate_204', {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

// ── Sync when online ──────────────────────────────────────────────────────────

let _syncInProgress = false;

export async function syncWhenOnline(context: vscode.ExtensionContext): Promise<void> {
  if (_syncInProgress) { return; }
  const online = await isOnline();
  if (!online) {
    await markAllTasksAsCachedOnly(context);
    return;
  }
  _syncInProgress = true;
  try {
    await context.workspaceState.update(KEY_LAST_ONLINE, new Date().toISOString());
    const tools = getConnectedToolsSync(context);
    if (!tools.length) { return; }
    await pullAllConnectedProviderTasks(context);
  } finally {
    _syncInProgress = false;
  }
}

// ── Use cache when offline ────────────────────────────────────────────────────

export async function useCachedTasksWhenOffline(
  context: vscode.ExtensionContext,
): Promise<TyneTask[]> {
  const online = await isOnline();
  if (online) { return []; }
  const cached = listCachedTasksSync(context);
  return cached.map(t => ({ ...t, isCachedOnly: true }));
}

// ── Get sync state for one provider ──────────────────────────────────────────

export async function getTaskSyncState(
  context: vscode.ExtensionContext,
  tool: TynePmTool,
): Promise<TyneTaskSyncState> {
  return getTaskSyncStateSync(context, tool);
}

export { saveTaskSyncState };

// ── Summarize all provider states for UI ─────────────────────────────────────

export function buildOfflineSyncSummary(context: vscode.ExtensionContext): {
  anyConnected: boolean;
  syncStates: TyneTaskSyncState[];
  lastOnlineAt?: string;
  totalCached: number;
} {
  const tools = getConnectedToolsSync(context);
  const syncStates = tools.map(t => getTaskSyncStateSync(context, t));
  const totalCached = listCachedTasksSync(context).length;
  const lastOnlineAt = context.workspaceState.get<string>(KEY_LAST_ONLINE);
  return {
    anyConnected: tools.length > 0,
    syncStates,
    lastOnlineAt,
    totalCached,
  };
}
