import * as vscode from 'vscode';
import { TyneManualTimeEntry } from './timeTypes';
import { ManualTimeEntryInput } from './timeTypes';
import {
  listManualEntries,
  saveManualEntry,
  deleteManualEntry,
} from './timeMetadataService';

export interface ManualTimeValidationError {
  field: string;
  message: string;
}

export function validateManualTimeEntry(input: ManualTimeEntryInput): ManualTimeValidationError[] {
  const errors: ManualTimeValidationError[] = [];
  if (!input.date || !input.date.trim()) {
    errors.push({ field: 'date', message: 'Date is required.' });
  }
  if (input.durationMinutes === undefined || input.durationMinutes === null) {
    errors.push({ field: 'durationMinutes', message: 'Duration is required.' });
  } else if (input.durationMinutes <= 0) {
    errors.push({ field: 'durationMinutes', message: 'Duration must be greater than 0 minutes.' });
  }
  if (input.startTime && input.endTime) {
    const start = new Date(`${input.date}T${input.startTime}`).getTime();
    const end = new Date(`${input.date}T${input.endTime}`).getTime();
    if (!isNaN(start) && !isNaN(end) && end <= start) {
      errors.push({ field: 'endTime', message: 'End time must be after start time.' });
    }
  }
  return errors;
}

export async function createManualTimeEntry(
  context: vscode.ExtensionContext,
  input: ManualTimeEntryInput,
): Promise<{ entry?: TyneManualTimeEntry; errors?: ManualTimeValidationError[] }> {
  const errors = validateManualTimeEntry(input);
  if (errors.length) { return { errors }; }
  const now = new Date().toISOString();
  const entry: TyneManualTimeEntry = {
    id: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    repositoryPath: input.repositoryPath,
    repositoryName: input.repositoryName,
    branchName: input.branchName,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    taskSource: input.taskSource,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    durationMinutes: input.durationMinutes,
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
  await saveManualEntry(context, entry);
  return { entry };
}

export async function updateManualTimeEntry(
  context: vscode.ExtensionContext,
  id: string,
  input: Partial<ManualTimeEntryInput>,
): Promise<{ entry?: TyneManualTimeEntry; errors?: ManualTimeValidationError[] }> {
  const entries = listManualEntries(context);
  const existing = entries.find(e => e.id === id);
  if (!existing) { return { errors: [{ field: 'id', message: 'Entry not found.' }] }; }
  const merged: ManualTimeEntryInput = {
    repositoryPath: input.repositoryPath ?? existing.repositoryPath,
    repositoryName: input.repositoryName ?? existing.repositoryName,
    branchName: input.branchName ?? existing.branchName,
    taskId: input.taskId ?? existing.taskId,
    taskTitle: input.taskTitle ?? existing.taskTitle,
    taskSource: input.taskSource ?? existing.taskSource,
    date: input.date ?? existing.date,
    startTime: input.startTime ?? existing.startTime,
    endTime: input.endTime ?? existing.endTime,
    durationMinutes: input.durationMinutes ?? existing.durationMinutes,
    note: input.note ?? existing.note,
  };
  const errors = validateManualTimeEntry(merged);
  if (errors.length) { return { errors }; }
  const updated: TyneManualTimeEntry = {
    ...existing,
    ...merged,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await saveManualEntry(context, updated);
  return { entry: updated };
}

export async function deleteManualTimeEntry(context: vscode.ExtensionContext, id: string): Promise<void> {
  await deleteManualEntry(context, id);
}

export function listManualTimeEntriesForTask(
  context: vscode.ExtensionContext,
  taskId: string,
): TyneManualTimeEntry[] {
  return listManualEntries(context).filter(e => e.taskId === taskId);
}

export function listManualTimeEntriesForBranch(
  context: vscode.ExtensionContext,
  branchName: string,
): TyneManualTimeEntry[] {
  return listManualEntries(context).filter(e => e.branchName === branchName);
}

export function listManualTimeEntriesForProject(
  context: vscode.ExtensionContext,
  repositoryPath: string,
): TyneManualTimeEntry[] {
  return listManualEntries(context).filter(e => e.repositoryPath === repositoryPath);
}
