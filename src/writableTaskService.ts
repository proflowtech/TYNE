import * as vscode from 'vscode';
import {
  TynePmTool,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
  TyneTaskDetails,
  TyneSubtask,
  TyneTaskComment,
  TyneTaskEditEvent,
} from './taskTypes';
import { getAdapter } from './taskProviderRegistry';
import { saveTaskDetails } from './taskCacheService';
import { isFreeTier } from './taskProviderRegistry';

const KEY_EDIT_EVENTS = 'tyne.taskEditEvents';
const ISO = () => new Date().toISOString();

function makeEditEventId(): string {
  return `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Edit event log ────────────────────────────────────────────────────────────

export function listEditEventsSync(context: vscode.ExtensionContext): TyneTaskEditEvent[] {
  const raw = context.workspaceState.get<TyneTaskEditEvent[]>(KEY_EDIT_EVENTS, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveEditEvent(context: vscode.ExtensionContext, event: TyneTaskEditEvent): Promise<void> {
  const events = listEditEventsSync(context);
  events.push(event);
  await context.workspaceState.update(KEY_EDIT_EVENTS, events.slice(-200));
}

// ── Tier gate ─────────────────────────────────────────────────────────────────

export function canUsePmWrite(tier: string): boolean {
  return !isFreeTier(tier);
}

// ── Writable operations ───────────────────────────────────────────────────────

export async function createTask(
  context: vscode.ExtensionContext,
  tier: string,
  input: TyneCreateTaskInput,
): Promise<TyneTaskDetails> {
  if (!canUsePmWrite(tier)) {
    throw new Error('Creating tasks is available in Pro and Max. Upgrade to unlock writable task management.');
  }

  const adapter = getAdapter(input.sourceTool);
  const eventId = makeEditEventId();
  const pending: TyneTaskEditEvent = {
    id: eventId,
    taskId: '',
    sourceTool: input.sourceTool,
    action: 'create_task',
    status: 'pending',
    newValue: input,
    createdAt: ISO(),
    updatedAt: ISO(),
  };

  try {
    const details = await adapter.createTask(input);
    pending.taskId = details.id;
    pending.status = 'success';
    pending.updatedAt = ISO();
    await saveTaskDetails(context, details);
    await saveEditEvent(context, pending);
    return details;
  } catch (err: unknown) {
    pending.status = 'failed';
    pending.errorMessage = err instanceof Error ? err.message : String(err);
    pending.updatedAt = ISO();
    await saveEditEvent(context, pending);
    throw err;
  }
}

export async function updateTask(
  context: vscode.ExtensionContext,
  tier: string,
  taskId: string,
  sourceTool: TynePmTool,
  input: TyneUpdateTaskInput,
  previousValue?: unknown,
): Promise<TyneTaskDetails> {
  if (!canUsePmWrite(tier)) {
    throw new Error('Editing tasks is available in Pro and Max. Upgrade to unlock writable task management.');
  }

  const adapter = getAdapter(sourceTool);
  const eventId = makeEditEventId();
  const pending: TyneTaskEditEvent = {
    id: eventId,
    taskId,
    sourceTool,
    action: 'update_task',
    status: 'pending',
    previousValue,
    newValue: input,
    createdAt: ISO(),
    updatedAt: ISO(),
  };

  try {
    const details = await adapter.updateTask(taskId, input);
    pending.status = 'success';
    pending.updatedAt = ISO();
    await saveTaskDetails(context, details);
    await saveEditEvent(context, pending);
    return details;
  } catch (err: unknown) {
    pending.status = 'failed';
    pending.errorMessage = err instanceof Error ? err.message : String(err);
    pending.updatedAt = ISO();
    await saveEditEvent(context, pending);
    throw err;
  }
}

export async function addSubtask(
  context: vscode.ExtensionContext,
  tier: string,
  taskId: string,
  sourceTool: TynePmTool,
  input: { title: string; assigneeId?: string; dueDate?: string },
): Promise<TyneSubtask> {
  if (!canUsePmWrite(tier)) {
    throw new Error('Adding subtasks is available in Pro and Max.');
  }

  const adapter = getAdapter(sourceTool);
  if (!adapter.addSubtask) {
    throw new Error(`${sourceTool} does not support adding subtasks.`);
  }

  const subtask = await adapter.addSubtask(taskId, input);
  const event: TyneTaskEditEvent = {
    id: makeEditEventId(), taskId, sourceTool,
    action: 'add_subtask', status: 'success',
    newValue: subtask, createdAt: ISO(), updatedAt: ISO(),
  };
  await saveEditEvent(context, event);
  return subtask;
}

export async function updateSubtask(
  context: vscode.ExtensionContext,
  tier: string,
  taskId: string,
  sourceTool: TynePmTool,
  subtaskId: string,
  input: Partial<TyneSubtask>,
): Promise<TyneSubtask> {
  if (!canUsePmWrite(tier)) {
    throw new Error('Editing subtasks is available in Pro and Max.');
  }

  const adapter = getAdapter(sourceTool);
  if (!adapter.updateSubtask) {
    throw new Error(`${sourceTool} does not support editing subtasks.`);
  }

  const result = await adapter.updateSubtask(taskId, subtaskId, input);
  const event: TyneTaskEditEvent = {
    id: makeEditEventId(), taskId, sourceTool,
    action: 'update_subtask', status: 'success',
    newValue: result, createdAt: ISO(), updatedAt: ISO(),
  };
  await saveEditEvent(context, event);
  return result;
}

export async function addComment(
  context: vscode.ExtensionContext,
  tier: string,
  taskId: string,
  sourceTool: TynePmTool,
  body: string,
): Promise<TyneTaskComment> {
  if (!canUsePmWrite(tier)) {
    throw new Error('Adding comments is available in Pro and Max.');
  }

  const adapter = getAdapter(sourceTool);
  if (!adapter.addComment) {
    throw new Error(`${sourceTool} does not support adding comments.`);
  }

  const comment = await adapter.addComment(taskId, body);
  const event: TyneTaskEditEvent = {
    id: makeEditEventId(), taskId, sourceTool,
    action: 'add_comment', status: 'success',
    newValue: comment, createdAt: ISO(), updatedAt: ISO(),
  };
  await saveEditEvent(context, event);
  return comment;
}

export async function repairEditEventStorage(context: vscode.ExtensionContext): Promise<{ repaired: boolean }> {
  const raw = context.workspaceState.get<unknown>(KEY_EDIT_EVENTS);
  if (!Array.isArray(raw)) {
    await context.workspaceState.update(KEY_EDIT_EVENTS, []);
    return { repaired: true };
  }
  return { repaired: false };
}
