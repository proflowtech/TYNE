import * as vscode from 'vscode';
import { TyneTask, TyneTaskDetails, TynePmTool, TyneTaskSyncState } from './taskTypes';

const KEY_TASKS = 'tyne.tasksCache';
const KEY_DETAILS = 'tyne.taskDetailsCache';
const KEY_SYNC_STATES = 'tyne.taskProviderSyncStates';

function now(): string { return new Date().toISOString(); }

// ── Tasks cache ───────────────────────────────────────────────────────────────

export async function saveTasks(
  context: vscode.ExtensionContext,
  tasks: TyneTask[],
): Promise<void> {
  const existing = listCachedTasksSync(context);
  const merged = mergePulledTasksWithCacheSync(existing, tasks);
  await context.workspaceState.update(KEY_TASKS, merged);
}

export function listCachedTasksSync(context: vscode.ExtensionContext): TyneTask[] {
  const raw = context.workspaceState.get<unknown>(KEY_TASKS);
  if (!Array.isArray(raw)) { return []; }
  return raw as TyneTask[];
}

export async function listCachedTasks(
  context: vscode.ExtensionContext,
): Promise<TyneTask[]> {
  return listCachedTasksSync(context);
}

export function mergePulledTasksWithCacheSync(
  cached: TyneTask[],
  pulled: TyneTask[],
): TyneTask[] {
  const map = new Map<string, TyneTask>();
  for (const t of cached) { map.set(t.id, t); }
  for (const t of pulled) {
    const existing = map.get(t.id);
    if (existing) {
      map.set(t.id, {
        ...existing,
        ...t,
        cachedAt: now(),
        isCachedOnly: false,
      });
    } else {
      map.set(t.id, { ...t, cachedAt: now(), isCachedOnly: false });
    }
  }
  return Array.from(map.values());
}

export async function mergePulledTasksWithCache(
  context: vscode.ExtensionContext,
  tasks: TyneTask[],
): Promise<TyneTask[]> {
  const cached = listCachedTasksSync(context);
  return mergePulledTasksWithCacheSync(cached, tasks);
}

// ── Task details cache ────────────────────────────────────────────────────────

export async function saveTaskDetails(
  context: vscode.ExtensionContext,
  details: TyneTaskDetails,
): Promise<void> {
  const all = getDetailsMapSync(context);
  all[details.id] = { ...details, cachedAt: now() };
  await context.workspaceState.update(KEY_DETAILS, all);
}

export function getCachedTaskDetailsSync(
  context: vscode.ExtensionContext,
  taskId: string,
): TyneTaskDetails | null {
  const all = getDetailsMapSync(context);
  return all[taskId] ?? null;
}

export async function getCachedTaskDetails(
  context: vscode.ExtensionContext,
  taskId: string,
): Promise<TyneTaskDetails | null> {
  return getCachedTaskDetailsSync(context, taskId);
}

function getDetailsMapSync(
  context: vscode.ExtensionContext,
): Record<string, TyneTaskDetails> {
  const raw = context.workspaceState.get<unknown>(KEY_DETAILS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return {}; }
  return raw as Record<string, TyneTaskDetails>;
}

// ── Sync state per provider ───────────────────────────────────────────────────

export function getTaskSyncStateSync(
  context: vscode.ExtensionContext,
  tool: TynePmTool,
): TyneTaskSyncState {
  const all = getSyncStatesMapSync(context);
  return all[tool] ?? {
    sourceTool: tool, syncStatus: 'idle', cachedTaskCount: 0, connected: false,
  };
}

export async function saveTaskSyncState(
  context: vscode.ExtensionContext,
  state: TyneTaskSyncState,
): Promise<void> {
  const all = getSyncStatesMapSync(context);
  all[state.sourceTool] = state;
  await context.workspaceState.update(KEY_SYNC_STATES, all);
}

export function getAllSyncStates(
  context: vscode.ExtensionContext,
): TyneTaskSyncState[] {
  return Object.values(getSyncStatesMapSync(context));
}

function getSyncStatesMapSync(
  context: vscode.ExtensionContext,
): Record<string, TyneTaskSyncState> {
  const raw = context.workspaceState.get<unknown>(KEY_SYNC_STATES);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return {}; }
  return raw as Record<string, TyneTaskSyncState>;
}

// ── Repair ────────────────────────────────────────────────────────────────────

export async function repairTaskCache(
  context: vscode.ExtensionContext,
): Promise<{ repaired: boolean; message?: string }> {
  let repaired = false;
  const rawTasks = context.workspaceState.get<unknown>(KEY_TASKS);
  if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
    await context.workspaceState.update(KEY_TASKS, []);
    repaired = true;
  }
  const rawDetails = context.workspaceState.get<unknown>(KEY_DETAILS);
  if (rawDetails !== undefined && (typeof rawDetails !== 'object' || Array.isArray(rawDetails))) {
    await context.workspaceState.update(KEY_DETAILS, {});
    repaired = true;
  }
  const rawStates = context.workspaceState.get<unknown>(KEY_SYNC_STATES);
  if (rawStates !== undefined && (typeof rawStates !== 'object' || Array.isArray(rawStates))) {
    await context.workspaceState.update(KEY_SYNC_STATES, {});
    repaired = true;
  }
  return repaired
    ? { repaired: true, message: 'Task cache was damaged and has been repaired.' }
    : { repaired: false };
}

// ── Mark cached-only tasks when offline ──────────────────────────────────────

export async function markAllTasksAsCachedOnly(
  context: vscode.ExtensionContext,
): Promise<void> {
  const tasks = listCachedTasksSync(context);
  if (!tasks.length) { return; }
  const marked = tasks.map(t => ({ ...t, isCachedOnly: true }));
  await context.workspaceState.update(KEY_TASKS, marked);
}
