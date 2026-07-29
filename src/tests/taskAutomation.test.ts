import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LinearAdapter,
  JiraAdapter,
  AsanaAdapter,
  NotionAdapter,
  MondayAdapter,
  getAdapterForTool,
  getAdapterForTaskSource,
  getAdapterForTaskId,
  resolvePmAdapter,
  pickDoneTransition,
} from '../pmAdapterInterface';

import {
  validateManualTimeEntry,
} from '../manualTimeEntryService';

import {
  enforcePmCommentPolicy,
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

test('pickDoneTransition: matches common Jira "done" transition names', () => {
  // Exact names.
  assert.equal(pickDoneTransition([{ id: '1', name: 'Done' }])?.id, '1');
  assert.equal(pickDoneTransition([{ id: '2', name: 'Closed' }])?.id, '2');
  // Non-standard names that still mean completed.
  assert.equal(pickDoneTransition([{ id: '3', name: 'In Progress' }, { id: '4', name: 'Mark as Done' }])?.id, '4');
  assert.equal(pickDoneTransition([{ id: '5', name: 'Resolve Issue' }])?.id, '5');
  assert.equal(pickDoneTransition([{ id: '6', name: 'Finish & Close' }])?.id, '6');
  // Falls back to the target status when the name is opaque.
  assert.equal(pickDoneTransition([{ id: '7', name: 'Move', toStatus: 'Done' }])?.id, '7');
  // No completion transition available.
  assert.equal(pickDoneTransition([{ id: '8', name: 'Start' }, { id: '9', name: 'Block' }]), undefined);
});

test('getAdapterForTaskId: resolves the tool from the unified id prefix', () => {
  assert.ok(getAdapterForTaskId('jira:TYNE-12') instanceof JiraAdapter);
  assert.ok(getAdapterForTaskId('linear:ENG-1') instanceof LinearAdapter);
  assert.equal(getAdapterForTaskId('TYNE-12'), null); // no prefix
  assert.equal(getAdapterForTaskId(''), null);
});

test('resolvePmAdapter: falls back to the task id when the source label is not a tool', () => {
  // The regression: a connected Jira task whose stored source drifted to a project
  // label or "Solo Mode" must NOT be misreported as a disconnected tool.
  assert.ok(resolvePmAdapter('TYNE · Tyne Project', 'jira:TYNE-12') instanceof JiraAdapter);
  assert.ok(resolvePmAdapter('Solo Mode', 'jira:TYNE-3') instanceof JiraAdapter);
  assert.ok(resolvePmAdapter('Recovered', 'linear:ENG-7') instanceof LinearAdapter);
  assert.ok(resolvePmAdapter('Recovered', 'asana:120') instanceof AsanaAdapter);
  assert.ok(resolvePmAdapter('Recovered', 'notion:page-id') instanceof NotionAdapter);
  // Still prefers a valid explicit source.
  assert.ok(resolvePmAdapter('Jira', 'jira:TYNE-1') instanceof JiraAdapter);
  // No source and no resolvable id → genuinely null.
  assert.equal(resolvePmAdapter('Solo Mode', 'local-123'), null);
  assert.equal(resolvePmAdapter('Solo Mode'), null);
});

test('LinearAdapter status mapping: done and todo', () => {
  const adapter = getAdapterForTool('linear') as LinearAdapter;
  assert.equal(adapter.mapExternalStatusToTyneStatus('Done'), 'done');
  assert.equal(adapter.mapExternalStatusToTyneStatus('Todo'), 'todo');
  assert.equal(adapter.mapExternalStatusToTyneStatus('In Progress'), 'in_progress');
  assert.equal(adapter.mapTyneStatusToExternalStatus('done'), 'Done');
  assert.equal(adapter.mapTyneStatusToExternalStatus('todo'), 'Todo');
});

test('AsanaAdapter status mapping: completed and incomplete', () => {
  const adapter = getAdapterForTool('asana') as AsanaAdapter;
  assert.equal(adapter.mapExternalStatusToTyneStatus('completed'), 'done');
  assert.equal(adapter.mapExternalStatusToTyneStatus('incomplete'), 'in_progress');
  assert.equal(adapter.mapTyneStatusToExternalStatus('done'), 'complete');
  assert.equal(adapter.mapTyneStatusToExternalStatus('in_progress'), 'incomplete');
});

test('NotionAdapter status mapping: done and not_started', () => {
  const adapter = getAdapterForTool('notion') as NotionAdapter;
  assert.equal(adapter.mapExternalStatusToTyneStatus('Done'), 'done');
  assert.equal(adapter.mapExternalStatusToTyneStatus('Not Started'), 'todo');
  assert.equal(adapter.mapTyneStatusToExternalStatus('done'), 'Done');
  assert.equal(adapter.mapTyneStatusToExternalStatus('todo'), 'Not Started');
});

// ── Automation settings tests ─────────────────────────────────────────────────
test('getAutomationSettings: returns defaults when no settings stored', () => {
  const ctx = makeFakeContext();
  const s = getAutomationSettings(ctx);
  assert.equal(s.autoCloseTrigger, 'manual');
  assert.equal(s.autoFeedbackTrigger, 'after_commit');
  assert.equal(s.syncPmStatusToTyne, true);
  assert.equal(s.requireValidationBeforeAutoClose, false);
  assert.equal(s.autoCloseOnCommit, false);
  assert.equal(s.complianceChecksEnabled, false);
  assert.deepEqual(s.complianceFrameworks, ['HIPAA']);
  assert.equal(s.commitDetectionMode, 'hook');
  assert.deepEqual(s.maxFeedbackSections, ['validation_stages', 'risk_assessment', 'performance_metrics', 'security_check', 'code_quality', 'recommendations']);
});

test('handleCommitDetected wiring: posts feedback on commit without requiring auto-close', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(process.cwd(), 'src/taskAutomationService.ts'), 'utf8');
  assert.match(src, /settings\.autoFeedbackTrigger === 'after_commit'/);
  assert.match(src, /wantsFeedbackOnCommit/);
  assert.match(src, /wantsCloseOnCommit/);
  assert.match(src, /!wantsFeedbackOnCommit && !wantsCloseOnCommit/);
});

test('saveAutomationSettings: persists and retrieves settings', async () => {
  const ctx = makeFakeContext();
  const custom: TyneTaskAutomationSettings = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    autoCloseTrigger: 'on_push',
    requireValidationBeforeAutoClose: true,
    autoCloseOnCommit: true,
    complianceChecksEnabled: true,
    complianceFrameworks: ['SOC2', 'GDPR'],
    maxFeedbackSections: ['validation_stages', 'code_quality'],
  };
  await saveAutomationSettings(ctx, custom);
  const loaded = getAutomationSettings(ctx);
  assert.equal(loaded.autoCloseTrigger, 'on_push');
  assert.equal(loaded.requireValidationBeforeAutoClose, true);
  assert.equal(loaded.autoCloseOnCommit, true);
  assert.equal(loaded.complianceChecksEnabled, true);
  assert.deepEqual(loaded.complianceFrameworks, ['SOC2', 'GDPR']);
  assert.deepEqual(loaded.maxFeedbackSections, ['validation_stages', 'code_quality']);
});

test('getAutomationSettings: merges legacy stored settings with new defaults', () => {
  const ctx = makeFakeContext({
    'tyne.automationSettings': {
      autoCloseTrigger: 'on_push',
      autoFeedbackTrigger: 'after_push',
      syncPmStatusToTyne: true,
      syncTyneStatusToPm: true,
      requireValidationBeforeAutoClose: false,
      requireValidationBeforeFeedback: false,
      autoPostFeedbackAfterClose: true,
      autoMovePmToInProgressOnStart: false,
    },
  });
  const s = getAutomationSettings(ctx);
  assert.equal(s.autoCloseOnCommit, false);
  assert.equal(s.complianceChecksEnabled, false);
  assert.deepEqual(s.complianceFrameworks, ['HIPAA']);
  assert.equal(s.commitDetectionMode, 'hook');
  assert.deepEqual(s.maxFeedbackSections, ['validation_stages', 'risk_assessment', 'performance_metrics', 'security_check', 'code_quality', 'recommendations']);
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
const sampleValidation = {
  id: 'v1', provider: 'managed' as const, tier: 'max' as const, status: 'pass' as const,
  summary: 'Implements token refresh and clears stale sessions.', matchPercent: 92, riskLevel: 'low' as const,
  filesReviewed: ['src/auth.ts', 'src/session.ts'],
  criteriaMet: ['Refreshes expired tokens'],
  criteriaNotMet: [{ criterion: 'Logs out on 401', reason: 'No 401 handler added' }],
  suggestions: ['Add a 401 interceptor'],
  codeQualityNotes: ['Clean structure'],
  createdAt: new Date().toISOString(),
};

test('formatFeedbackBody: concise human update for a passing validation', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123', taskTitle: 'Token refresh', branchName: 'tyne/TASK-123-auth',
    commitHash: 'a1b2c3d4', validationStatus: 'pass', riskLevel: 'low', synced: '2026-06-24 14:30',
    requireValidation: false, planTier: 'free', maxSections: [], validationResult: sampleValidation,
  });
  assert.ok(body.includes('Implemented:'));
  assert.ok(body.includes('Completed:'));
  assert.ok(body.includes('Validation:'));
  assert.ok(body.includes('✓ Refreshes expired tokens'));
  assert.ok(body.includes('Pending:'));
  assert.ok(body.includes('Add a 401 interceptor'));
  assert.ok(body.includes('PR: a1b2c3d4'));
  assert.ok(body.split(/\s+/).length <= 120);
  assert.ok(!/AI analysis|system determined|Generated by Tyne/i.test(body));
});

test('formatFeedbackBody: posts a comment for every tier (free is no longer empty)', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123', validationStatus: 'pass', riskLevel: 'low', synced: '2026-06-24 14:30',
    requireValidation: false, planTier: 'free', maxSections: [], validationResult: sampleValidation,
  });
  assert.notEqual(body.trim(), '');
  assert.ok(body.includes('Implemented:'));
});

test('formatFeedbackBody: commit shows the URL when provided', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123', commitHash: 'a1b2c3d4', commitUrl: 'https://github.com/org/repo/commit/a1b2c3d4',
    validationStatus: 'pass', riskLevel: 'low', synced: '2026-06-24 14:30',
    requireValidation: false, planTier: 'pro', maxSections: [], validationResult: sampleValidation,
  });
  assert.ok(body.includes('PR: https://github.com/org/repo/commit/a1b2c3d4'));
});

test('formatFeedbackBody: reflects PARTIAL and FAIL outcomes', () => {
  const partial = formatFeedbackBody({ taskId: 'T', validationStatus: 'partial', riskLevel: 'medium', synced: 's', requireValidation: false, planTier: 'pro', maxSections: [], validationResult: null });
  assert.ok(partial.includes('Validation needs follow-up'));
  const fail = formatFeedbackBody({ taskId: 'T', validationStatus: 'fail', riskLevel: 'high', synced: 's', requireValidation: false, planTier: 'pro', maxSections: [], validationResult: null });
  assert.ok(fail.includes('Validation incomplete.'));
  assert.ok(fail.includes('Issues found:'));
  assert.ok(fail.includes('before merging'));
});

test('formatFeedbackBody: not_run without requireValidation still posts a work-completed comment', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123', validationStatus: 'not_run', riskLevel: 'not_assessed', synced: '2026-06-24 14:30',
    requireValidation: false, planTier: 'pro', maxSections: [], validationResult: null,
  });
  assert.ok(body.includes('Implemented:'));
  assert.ok(body.includes('Validation not run'));
});

test('formatFeedbackBody: not_run with requireValidation blocks feedback', () => {
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    validationStatus: 'not_run',
    riskLevel: 'not_assessed',
    synced: '2026-06-24 14:30',
    requireValidation: true,
    planTier: 'pro',
    maxSections: [],
    validationResult: null,
  });
  assert.ok(body.includes('validation has not been run'));
  assert.ok(!body.includes('Validation: PASS'));
});

test('formatFeedbackBody: Max tier still posts only the concise PM update', () => {
  const validationResult = {
    id: 'v1',
    provider: 'managed' as const,
    tier: 'max' as const,
    status: 'pass' as const,
    summary: 'Matches goal',
    matchPercent: 92,
    riskLevel: 'low' as const,
    durationMs: 3400,
    filesReviewed: ['src/auth.ts'],
    codeQualityNotes: ['Clean structure'],
    suggestions: ['Add more tests'],
    createdAt: new Date().toISOString(),
    trace: {
      id: 't1', traceType: 'code_validation' as const, overallStatus: 'success' as const,
      steps: [{ id: 's1', key: 'axiom_review', title: 'AXIOM review', status: 'success' as const, model: 'AXIOM Max' }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  };
  const body = formatFeedbackBody({
    taskId: 'TASK-123',
    branchName: 'tyne/TASK-123-auth',
    commitHash: 'a1b2c3d4',
    validationStatus: 'pass',
    riskLevel: 'low',
    synced: '2026-06-24 14:30',
    requireValidation: false,
    planTier: 'max',
    maxSections: ['validation_stages', 'performance_metrics', 'code_quality', 'recommendations'],
    validationResult,
  });
  assert.ok(body.includes('Implemented:'));
  assert.ok(body.includes('Validation:'));
  assert.ok(body.includes('Clean structure'));
  assert.ok(body.includes('Add more tests'));
  assert.ok(!body.includes('Validation stages'));
  assert.ok(!body.includes('Performance metrics'));
  assert.ok(body.split(/\s+/).length <= 120);
});

test('enforcePmCommentPolicy removes AI language and caps comments at 120 words', () => {
  const body = enforcePmCommentPolicy(`AI analysis:\n\nThe system determined\n\n${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}`);
  assert.ok(!/AI analysis|system determined/i.test(body));
  assert.ok(body.split(/\s+/).length <= 120);
  assert.ok(!body.includes('\n\n'));
});

test('PM feedback requires an editable preview before manual posting', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const host = fs.readFileSync(path.join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
    + '\n' + fs.readFileSync(path.join(process.cwd(), 'src/sidebar/sidebarHtml.ts'), 'utf8');
  const webview = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(host, /textarea id="automationFeedbackPreviewText"/);
  assert.match(host, /Tyne Update Preview/);
  assert.match(webview, /automationPostFeedbackBtn\.addEventListener\('click'/);
  assert.match(webview, /automationCompleteBtn\.addEventListener\('click'/);
  assert.match(webview, /type: 'automationPreviewFeedback'/);
  assert.match(webview, /previewedFeedbackAction === 'complete'/);
  assert.match(webview, /bodyOverride: previewedFeedbackBody/);
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
