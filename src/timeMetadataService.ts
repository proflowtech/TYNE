import * as vscode from 'vscode';
import { TyneTimeLog, TyneManualTimeEntry } from './timeTypes';

const TIME_LOGS_KEY = 'tyne.timeLogs';
const MANUAL_ENTRIES_KEY = 'tyne.manualTimeEntries';

export function listTimeLogs(context: vscode.ExtensionContext): TyneTimeLog[] {
  try {
    return context.workspaceState.get<TyneTimeLog[]>(TIME_LOGS_KEY, []);
  } catch {
    return [];
  }
}

export function listManualEntries(context: vscode.ExtensionContext): TyneManualTimeEntry[] {
  try {
    return context.workspaceState.get<TyneManualTimeEntry[]>(MANUAL_ENTRIES_KEY, []);
  } catch {
    return [];
  }
}

export async function saveTimeLog(context: vscode.ExtensionContext, log: TyneTimeLog): Promise<void> {
  const logs = listTimeLogs(context);
  const idx = logs.findIndex(l => l.id === log.id);
  if (idx >= 0) {
    logs[idx] = { ...log, updatedAt: new Date().toISOString() };
  } else {
    logs.push(log);
  }
  await context.workspaceState.update(TIME_LOGS_KEY, logs);
}

export async function saveManualEntry(context: vscode.ExtensionContext, entry: TyneManualTimeEntry): Promise<void> {
  const entries = listManualEntries(context);
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = { ...entry, updatedAt: new Date().toISOString() };
  } else {
    entries.push(entry);
  }
  await context.workspaceState.update(MANUAL_ENTRIES_KEY, entries);
}

export async function deleteTimeLog(context: vscode.ExtensionContext, id: string): Promise<void> {
  const logs = listTimeLogs(context).filter(l => l.id !== id);
  await context.workspaceState.update(TIME_LOGS_KEY, logs);
}

export async function deleteManualEntry(context: vscode.ExtensionContext, id: string): Promise<void> {
  const entries = listManualEntries(context).filter(e => e.id !== id);
  await context.workspaceState.update(MANUAL_ENTRIES_KEY, entries);
}

export async function replaceTimeLogs(context: vscode.ExtensionContext, logs: TyneTimeLog[]): Promise<void> {
  await context.workspaceState.update(TIME_LOGS_KEY, logs);
}

export async function repairTimeStorage(context: vscode.ExtensionContext): Promise<void> {
  try {
    const logs = context.workspaceState.get<unknown>(TIME_LOGS_KEY);
    if (!Array.isArray(logs)) {
      await context.workspaceState.update(TIME_LOGS_KEY, []);
    }
  } catch {
    await context.workspaceState.update(TIME_LOGS_KEY, []);
  }
  try {
    const entries = context.workspaceState.get<unknown>(MANUAL_ENTRIES_KEY);
    if (!Array.isArray(entries)) {
      await context.workspaceState.update(MANUAL_ENTRIES_KEY, []);
    }
  } catch {
    await context.workspaceState.update(MANUAL_ENTRIES_KEY, []);
  }
}
