import * as vscode from 'vscode';
import {
  TyneTaskAutomationSettings,
  TyneAutomationEvent,
  TyneTaskSyncState,
  DEFAULT_AUTOMATION_SETTINGS,
} from './automationTypes';

const SETTINGS_KEY = 'tyne.automationSettings';
const EVENTS_KEY = 'tyne.automationEvents';
const SYNC_STATE_KEY = 'tyne.taskSyncState';

export function getAutomationSettings(context: vscode.ExtensionContext): TyneTaskAutomationSettings {
  try {
    const stored = context.workspaceState.get<TyneTaskAutomationSettings>(SETTINGS_KEY);
    if (stored && typeof stored === 'object') {
      return { ...DEFAULT_AUTOMATION_SETTINGS, ...stored };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_AUTOMATION_SETTINGS };
}

export async function saveAutomationSettings(
  context: vscode.ExtensionContext,
  settings: TyneTaskAutomationSettings,
): Promise<void> {
  await context.workspaceState.update(SETTINGS_KEY, settings);
}

export function listAutomationEvents(context: vscode.ExtensionContext): TyneAutomationEvent[] {
  try {
    return context.workspaceState.get<TyneAutomationEvent[]>(EVENTS_KEY, []);
  } catch {
    return [];
  }
}

export async function saveAutomationEvent(
  context: vscode.ExtensionContext,
  event: TyneAutomationEvent,
): Promise<void> {
  const events = listAutomationEvents(context);
  const idx = events.findIndex(e => e.id === event.id);
  if (idx >= 0) {
    events[idx] = { ...event, updatedAt: new Date().toISOString() };
  } else {
    events.push(event);
  }
  await context.workspaceState.update(EVENTS_KEY, events);
}

export function listAutomationEventsForTask(
  context: vscode.ExtensionContext,
  taskId: string,
): TyneAutomationEvent[] {
  return listAutomationEvents(context).filter(e => e.taskId === taskId);
}

export function listSyncStates(context: vscode.ExtensionContext): TyneTaskSyncState[] {
  try {
    return context.workspaceState.get<TyneTaskSyncState[]>(SYNC_STATE_KEY, []);
  } catch {
    return [];
  }
}

export function getTaskSyncState(
  context: vscode.ExtensionContext,
  taskId: string,
): TyneTaskSyncState | null {
  return listSyncStates(context).find(s => s.taskId === taskId) ?? null;
}

export async function saveTaskSyncState(
  context: vscode.ExtensionContext,
  state: TyneTaskSyncState,
): Promise<void> {
  const states = listSyncStates(context);
  const idx = states.findIndex(s => s.taskId === state.taskId);
  if (idx >= 0) {
    states[idx] = { ...state, updatedAt: new Date().toISOString() };
  } else {
    states.push(state);
  }
  await context.workspaceState.update(SYNC_STATE_KEY, states);
}

export function hasPostedFeedback(
  context: vscode.ExtensionContext,
  taskId: string,
): boolean {
  return listAutomationEventsForTask(context, taskId).some(
    e => e.actionType === 'post_feedback' && e.status === 'success',
  );
}

export function hasAutoClosedTask(
  context: vscode.ExtensionContext,
  taskId: string,
): boolean {
  return listAutomationEventsForTask(context, taskId).some(
    e => e.actionType === 'close_task' && e.status === 'success',
  );
}

export async function repairAutomationStorage(context: vscode.ExtensionContext): Promise<void> {
  try {
    const events = context.workspaceState.get<unknown>(EVENTS_KEY);
    if (!Array.isArray(events)) {
      await context.workspaceState.update(EVENTS_KEY, []);
    }
  } catch {
    await context.workspaceState.update(EVENTS_KEY, []);
  }
  try {
    const states = context.workspaceState.get<unknown>(SYNC_STATE_KEY);
    if (!Array.isArray(states)) {
      await context.workspaceState.update(SYNC_STATE_KEY, []);
    }
  } catch {
    await context.workspaceState.update(SYNC_STATE_KEY, []);
  }
}

export function makeEventId(actionType: string, taskId: string): string {
  return `${actionType}:${taskId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}
