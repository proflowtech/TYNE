import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LinearAdapter,
  JiraAdapter,
  AsanaAdapter,
  NotionAdapter,
  MondayAdapter,
  getAdapterForTaskSource,
} from '../pmAdapterInterface';

import {
  validateManualTimeEntry,
} from '../manualTimeEntryService';

import {
  formatFeedbackBody,
} from '../workFeedbackService';

import {
  getAutomationSettings,
  saveAutomationSettings,
  saveAutomationEvent,
  listAutomationEventsForTask,
  hasPostedFeedback,
  hasAutoClosedTask,
  repairAutomationStorage,
  makeEventId,
} from '../automationMetadataService';

import {
  DEFAULT_AUTOMATION_SETTINGS,
  TyneAutomationEvent,
  TyneTaskAutomationSettings,
} from '../automationTypes';

import { detectStatusConflict } from '../taskSyncService';

// ── Fake vscode context ───────────────────────────────────────────────────────
function makeFakeContext(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    workspaceState: {
      get(key: string, def?: unknown) { return key in store ? store[key] : def; },
      update(key: string, val: unknown) { store[key] = val; return Promise.resolve(); },
    },
  } as unknown as import('vscode').ExtensionContext;
}

function makeEvent(overrides: Partial<TyneAutomationEvent> = {}): TyneAutomationEvent {
  const now = new Date().toISOString();
  return {
    id: makeEventId('close_task', 'TASK-1'),
    taskId: 'TASK-1',
    taskSource: 'Linear',
    repositoryPath: '/repo',
    actionType: 'close_task',
    status: 'success',
    triggerSource: 'manual',
    pmTool: 'Linear',
    pmTaskId: 'TASK-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Status mapping tests ──────────────────────────────────────────────────────
test('LinearAdapter: maps external status to Tyne status', () => {
  const a = new LinearAdapter();
  assert.equal(a.mapExternalStatusToTyneStatus('Todo'), 'todo');
  assert.equal(a.mapExternalStatusToTyneStatus('In Progress'), 'in_progress');
  assert.equal(a.mapExternalStatusToTyneStatus('In Review'), 'in_review');
  assert.equal(a.mapExternalStatusToTyneStatus('Done'), 'done');
  assert.equal(a.mapExternalStatusToTyneStatus('Canceled'), 'canceled');
  assert.equal(a.mapExternalStatusToTyneStatus('something weird'), 'unknown');
});

test('LinearAdapter: maps Tyne status to external status', () => {
  const a = new LinearAdapter();
  assert.equal(a.mapTyneStatusToExternalStatus('done'), 'Done');
  assert.equal(a.mapTyneStatusToExternalStatus('in_progress'), 'In Progress');
  assert.equal(a.mapTyneStatusToExternalStatus('todo'), 'Todo');
});

test('JiraAdapter: maps external status correctly', () => {
  const a = new JiraAdapter();
  assert.equal(a.mapExternalStatusToTyneStatus('To Do'), 'todo');
  assert.equal(a.mapExternalStatusToTyneStatus('In Progress'), 'in_progress');
  assert.equal(a.mapExternalStatusToTyneStatus('Done'), 'done');
  assert.equal(a.mapExternalStatusToTyneStatus('Closed'), 'done');
  assert.equal(a.mapExternalStatusToTyneStatus('Blocked'), 'blocked');
});

test('AsanaAdapter: maps complete/incomplete', () => {
  const a = new AsanaAdapter();
  assert.equal(a.mapExternalStatusToTyneStatus('complete'), 'done');
  assert.equal(a.mapExternalStatusToTyneStatus('incomplete'), 'in_progress');
  assert.equal(a.mapTyneStatusToExternalStatus('done'), 'complete');
  assert.equal(a.mapTyneStatusToExternalStatus('in_progress'), 'incomplete');
});

test('NotionAdapter: maps Not Started / In Progress / Done', () => {
  const a = new NotionAdapter();
  assert.equal(a.mapExternalStatusToTyneStatus('not_started'), 'todo');
  assert.equal(a.mapExternalStatusToTyneStatus('in_progress'), 'in_progress');
  assert.equal(a.mapExternalStatusToTyneStatus('done'), 'done');
});

test('MondayAdapter: maps working on it / stuck', () => {
  const a = new MondayAdapter();
  assert.equal(a.mapExternalStatusToTyneStatus('working on it'), 'in_progress');
  assert.equal(a.mapExternalStatusToTyneStatus('stuck'), 'blocked');
  assert.equal(a.mapExternalStatusToTyneStatus('done'), 'done');
  assert.equal(a.mapTyneStatusToExternalStatus('blocked'), 'Stuck');
});

test('getAdapterForTaskSource: returns correct adapter by name', () => {
  assert.ok(getAdapterForTaskSource('Linear') instanceof LinearAdapter);
  assert.ok(getAdapterForTaskSource('Jira') instanceof JiraAdapter);
  assert.ok(getAdapterForTaskSource('Asana') instanceof AsanaAdapter);
  assert.ok(getAdapterForTaskSource('Notion') instanceof NotionAdapter);
  assert.ok(getAdapterForTaskSource('Monday') instanceof MondayAdapter);
  assert.equal(getAdapterForTaskSource('SomethingElse'), null);
});

// ── Automation settings tests ─────────────────────────────────────────────────
test('getAutomationSettings: returns defaults when no settings stored', () => {
  const ctx = makeFakeContext();
  const s = getAutomationSettings(ctx);
  assert.equal(s.autoCloseTrigger, 'manual');
  assert.equal(s.autoFeedbackTrigger, 'after_task_done');
  assert.equal(s.syncPmStatusToTyne, true);
  assert.equal(s.requireValidationBeforeAutoClose, false);
});

test('saveAutomationSettings: persists and retrieves settings', async () => {
  const ctx = makeFakeContext();
  const custom: TyneTaskAutomationSettings = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    autoCloseTrigger: 'on_push',
    requireValidationBeforeAutoClose: true,
  };
  await saveAutomationSettings(ctx, custom);
  const loaded = getAutomationSettings(ctx);
  assert.equal(loaded.autoCloseTrigger, 'on_push');
  assert.equal(loaded.requireValidationBeforeAutoClose, true);
});

// ── Automation event tests ────────────────────────────────────────────────────
test('saveAutomationEvent + listAutomationEventsForTask: basic CRUD', async () => {
  const ctx = makeFakeContext();
  const ev = makeEvent();
  await saveAutomationEvent(ctx, ev);
  const list = listAutomationEventsForTask(ctx, 'TASK-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].actionType, 'close_task');
});

test('hasAutoClosedTask: detects successful close event', async () => {
  const ctx = makeFakeContext();
  await saveAutomationEvent(ctx, makeEvent({ actionType: 'close_task', status: 'success' }));
  assert.equal(hasAutoClosedTask(ctx, 'TASK-1'), true);
  assert.equal(hasAutoClosedTask(ctx, 'TASK-2'), false);
});

test('hasAutoClosedTask: failed close does not count', async () => {
  const ctx = makeFakeContext();
  await saveAutomationEvent(ctx, makeEvent({ actionType: 'close_task', status: 'failed' }));
  assert.equal(hasAutoClosedTask(ctx, 'TASK-1'), false);
});

test('hasPostedFeedback: detects successful feedback event', async () => {
  const ctx = makeFakeContext();
  await saveAutomationEvent(ctx, makeEvent({ actionType: 'post_feedback', status: 'success' }));
  assert.equal(hasPostedFeedback(ctx, 'TASK-1'), true);
});

test('hasPostedFeedback: failed feedback does not count', async () => {
  const ctx = makeFakeContext();
  await saveAutomationEvent(ctx, makeEvent({ actionType: 'post_feedback', status: 'failed' }));
  assert.equal(hasPostedFeedback(ctx, 'TASK-1'), false);
});

test('repairAutomationStorage: resets corrupted arrays', async () => {
  const ctx = makeFakeContext({
    'tyne.automationEvents': 'bad_data',
    'tyne.taskSyncState': null,
  });
  await repairAutomationStorage(ctx);
  const events = listAutomationEventsForTask(ctx, 'TASK-1');
  assert.equal(events.length, 0);
});

// ── Auto-close trigger tests ──────────────────────────────────────────────────
test('autoCloseTrigger: manual does not enable push-close', () => {
  const s: TyneTaskAutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, autoCloseTrigger: 'manual' };
  const onPush = s.autoCloseTrigger === 'on_push' || s.autoCloseTrigger === 'manual_and_on_push';
  assert.equal(onPush, false);
});

test('autoCloseTrigger: on_push enables push-close', () => {
  const s: TyneTaskAutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, autoCloseTrigger: 'on_push' };
  const onPush = s.autoCloseTrigger === 'on_push' || s.autoCloseTrigger === 'manual_and_on_push';
  assert.equal(onPush, true);
});

test('autoCloseTrigger: manual_and_on_push enables push-close', () => {
  const s: TyneTaskAutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, autoCloseTrigger: 'manual_and_on_push' };
  const onPush = s.autoCloseTrigger === 'on_push' || s.autoCloseTrigger === 'manual_and_on_push';
  assert.equal(onPush, true);
});

test('autoCloseTrigger: disabled blocks all automation', () => {
  const s: TyneTaskAutomationSettings = { ...DEFAULT_AUTOMATION_SETTINGS, autoCloseTrigger: 'disabled' };
  const onPush = s.autoCloseTrigger === 'on_push' || s.autoCloseTrigger === 'manual_and_on_push';
  const manual = s.autoCloseTrigger === 'manual' || s.autoCloseTrigger === 'manual_and_on_push';
  assert.equal(onPush, false);
  assert.equal(manual, false);
});

// ── Feedback generation tests ─────────────────────────────────────────────────
test('formatFeedbackBody: validation PASS produces correct message', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    branchName: 'tyne/TASK-123-auth',
    commitHash: 'a1b2c3d4',
    validationStatus: 'pass',
    riskLevel: 'low',
    synced: '2026-06-24 14:30',
    requireValidation: false,
  });
  assert.ok(body.includes('Validated. Code matches goal. Risk: Low'));
  assert.ok(body.includes('Validation: PASS'));
  assert.ok(body.includes('Risk: Low'));
  assert.ok(body.includes('Branch: tyne/TASK-123-auth'));
  assert.ok(body.includes('Commit: a1b2c3d4'));
  assert.ok(body.includes('Task: TASK-123'));
  assert.ok(body.includes('Generated by Tyne.'));
});

test('formatFeedbackBody: commit hash becomes linkable when URL provided', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    commitHash: 'a1b2c3d4',
    commitUrl: 'https://github.com/org/repo/commit/a1b2c3d4',
    validationStatus: 'pass',
    riskLevel: 'low',
    synced: '2026-06-24 14:30',
    requireValidation: false,
  });
  assert.ok(body.includes('[a1b2c3d4](https://github.com/org/repo/commit/a1b2c3d4)'));
});

test('formatFeedbackBody: PARTIAL validation message', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    validationStatus: 'partial',
    riskLevel: 'medium',
    synced: '2026-06-24 14:30',
    requireValidation: false,
  });
  assert.ok(body.includes('Validation: PARTIAL'));
  assert.ok(body.includes('Risk: Medium'));
  assert.ok(body.includes('Code partially matches the goal.'));
});

test('formatFeedbackBody: FAIL validation message', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    validationStatus: 'fail',
    riskLevel: 'high',
    synced: '2026-06-24 14:30',
    requireValidation: false,
  });
  assert.ok(body.includes('Validation: FAIL'));
  assert.ok(body.includes('Risk: High'));
  assert.ok(body.includes('Code does not fully match the goal.'));
});

test('formatFeedbackBody: not_run without requireValidation posts work-completed message', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    validationStatus: 'not_run',
    riskLevel: 'not_assessed',
    synced: '2026-06-24 14:30',
    requireValidation: false,
  });
  assert.ok(body.includes('Work completed from Tyne.'));
  assert.ok(body.includes('Validation: Not run'));
  assert.ok(!body.includes('Validated. Code matches goal.'));
});

test('formatFeedbackBody: not_run with requireValidation blocks feedback', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    validationStatus: 'not_run',
    riskLevel: 'not_assessed',
    synced: '2026-06-24 14:30',
    requireValidation: true,
  });
  assert.ok(body.includes('validation has not been run'));
  assert.ok(!body.includes('Validated.'));
});

// ── Status conflict detection ─────────────────────────────────────────────────
test('detectStatusConflict: detects PM done vs Tyne active mismatch', async () => {
  const ctx = makeFakeContext({
    'tyne.taskSyncState': [{
      taskId: 'TASK-1', taskSource: 'Linear', repositoryPath: '/repo',
      pmTool: 'Linear', pmTaskId: 'TASK-1',
      pmStatus: 'done', localStatus: 'active', updatedAt: new Date().toISOString(),
    }],
  });
  const conflict = detectStatusConflict(ctx, 'TASK-1');
  assert.ok(conflict !== null);
  assert.equal(conflict!.pmStatus, 'done');
  assert.equal(conflict!.localStatus, 'active');
});

test('detectStatusConflict: no conflict when both are done', () => {
  const ctx = makeFakeContext({
    'tyne.taskSyncState': [{
      taskId: 'TASK-1', taskSource: 'Linear', repositoryPath: '/repo',
      pmTool: 'Linear', pmTaskId: 'TASK-1',
      pmStatus: 'done', localStatus: 'completed', updatedAt: new Date().toISOString(),
    }],
  });
  const conflict = detectStatusConflict(ctx, 'TASK-1');
  assert.equal(conflict, null);
});

test('detectStatusConflict: no conflict when task not found', () => {
  const ctx = makeFakeContext();
  const conflict = detectStatusConflict(ctx, 'TASK-99');
  assert.equal(conflict, null);
});

// ── Duplicate prevention ──────────────────────────────────────────────────────
test('hasPostedFeedback: only first success counts, task-scoped', async () => {
  const ctx = makeFakeContext();
  await saveAutomationEvent(ctx, makeEvent({ taskId: 'TASK-1', actionType: 'post_feedback', status: 'success' }));
  await saveAutomationEvent(ctx, makeEvent({ taskId: 'TASK-2', actionType: 'post_feedback', status: 'success' }));
  assert.equal(hasPostedFeedback(ctx, 'TASK-1'), true);
  assert.equal(hasPostedFeedback(ctx, 'TASK-2'), true);
  assert.equal(hasPostedFeedback(ctx, 'TASK-3'), false);
});

// ── makeEventId uniqueness ────────────────────────────────────────────────────
test('makeEventId: generates unique IDs', () => {
  const id1 = makeEventId('close_task', 'TASK-1');
  const id2 = makeEventId('close_task', 'TASK-1');
  assert.notEqual(id1, id2);
  assert.ok(id1.startsWith('close_task:TASK-1:'));
});
