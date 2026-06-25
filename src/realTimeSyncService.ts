import * as vscode from 'vscode';
import {
  TynePmTool,
  TyneTaskConflict,
  TyneTaskProviderUpdateEvent,
} from './taskTypes';
import { getAdapter, getConnectedToolsSync } from './taskProviderRegistry';
import { pullTasksFromProvider } from './multiProviderTaskPullService';
import { getCachedTaskDetailsSync, saveTaskDetails } from './taskCacheService';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 90_000;    // 90s conservative poll while active
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 600_000;     // 10 min max backoff

// ── Internal state ────────────────────────────────────────────────────────────

interface ProviderPollState {
  timer?: ReturnType<typeof setTimeout>;
  consecutiveFailures: number;
  currentIntervalMs: number;
  unsubscribe?: () => void;
}

const _pollStates = new Map<TynePmTool, ProviderPollState>();
let _postMessage: ((msg: unknown) => void) | null = null;
let _context: vscode.ExtensionContext | null = null;
let _active = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function initRealTimeSync(
  context: vscode.ExtensionContext,
  postMessage: (msg: unknown) => void,
): void {
  _context = context;
  _postMessage = postMessage;
}

export async function startActiveTaskSync(): Promise<void> {
  if (!_context || _active) { return; }
  _active = true;
  const connected = getConnectedToolsSync(_context);
  for (const provider of connected) {
    await _startProviderSync(provider);
  }
}

export async function stopActiveTaskSync(): Promise<void> {
  _active = false;
  for (const [, state] of _pollStates) {
    if (state.timer) { clearTimeout(state.timer); }
    if (state.unsubscribe) { state.unsubscribe(); }
  }
  _pollStates.clear();
}

export async function refreshTaskFromProvider(
  taskId: string,
  sourceTool: TynePmTool,
): Promise<void> {
  if (!_context) { return; }
  try {
    const adapter = getAdapter(sourceTool);
    const details = await adapter.getTaskDetails(taskId);
    await saveTaskDetails(_context, details);
    _postMessage?.({ type: 'taskDetailLoaded', details, offline: false });
  } catch (err: unknown) {
    _postMessage?.({ type: 'taskDetailError', message: err instanceof Error ? err.message : String(err) });
  }
}

export async function refreshAllActiveProviders(): Promise<void> {
  if (!_context) { return; }
  const connected = getConnectedToolsSync(_context);
  _postMessage?.({ type: 'tasksSyncing' });
  await Promise.all(connected.map(p => pullTasksFromProvider(_context!, p)));
  const tasks = (await import('./taskCacheService')).listCachedTasksSync(_context);
  _postMessage?.({ type: 'tasksDataLoaded', tasks, syncStates: [] });
}

export async function handleProviderUpdate(event: TyneTaskProviderUpdateEvent): Promise<void> {
  if (!_context) { return; }
  if (event.eventType === 'deleted') {
    _postMessage?.({ type: 'taskDeletedExternally', taskId: event.taskId, sourceTool: event.sourceTool });
    return;
  }
  if (event.snapshot) {
    await refreshTaskFromProvider(event.taskId, event.sourceTool);
  }
}

export async function detectTaskEditConflict(
  taskId: string,
  sourceTool: TynePmTool,
): Promise<TyneTaskConflict | null> {
  if (!_context) { return null; }
  const cached = getCachedTaskDetailsSync(_context, taskId);
  if (!cached) { return null; }

  try {
    const adapter = getAdapter(sourceTool);
    const live = await adapter.getTaskDetails(taskId);
    const cachedUpdated = cached.updatedAt ?? '';
    const liveUpdated = live.updatedAt ?? '';

    if (liveUpdated > cachedUpdated) {
      const conflict: TyneTaskConflict = {
        taskId,
        sourceTool,
        conflictType: 'external_change',
        message: `This task changed in ${sourceTool} while you were editing. Review the latest version before saving.`,
        latestPmSnapshot: live,
        detectedAt: new Date().toISOString(),
      };
      return conflict;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Internal polling ──────────────────────────────────────────────────────────

async function _startProviderSync(provider: TynePmTool): Promise<void> {
  if (!_context) { return; }
  const adapter = getAdapter(provider);
  const state: ProviderPollState = { consecutiveFailures: 0, currentIntervalMs: POLL_INTERVAL_MS };

  // Try native subscription first
  if (adapter.subscribeToTaskUpdates) {
    try {
      const unsub = await adapter.subscribeToTaskUpdates(async (event) => {
        await handleProviderUpdate(event);
      });
      state.unsubscribe = unsub;
      _pollStates.set(provider, state);
      return;
    } catch {
      // Fall through to polling
    }
  }

  // Polling fallback
  const poll = async () => {
    if (!_active || !_context) { return; }
    try {
      await pullTasksFromProvider(_context, provider);
      state.consecutiveFailures = 0;
      state.currentIntervalMs = POLL_INTERVAL_MS;
    } catch {
      state.consecutiveFailures++;
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS,
      );
    }
    if (_active) {
      state.timer = setTimeout(poll, state.currentIntervalMs);
    }
  };

  state.timer = setTimeout(poll, state.currentIntervalMs);
  _pollStates.set(provider, state);
}

export function isActiveSync(): boolean { return _active; }
