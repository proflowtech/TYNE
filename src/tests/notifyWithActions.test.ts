import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveStatusBarNextAction,
  isTyneSidebarFocused,
  validationPassNotifyActions,
} from '../notifyWithActionsUtils';

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf8');
}

test('resolveStatusBarNextAction idle without task focuses sidebar', () => {
  const next = resolveStatusBarNextAction({
    taskId: '',
    status: 'waiting',
    validationResult: null,
    validationOverride: false,
    goal: '',
  });
  assert.equal(next.command, 'tyne.focusSidebar');
  assert.match(next.text, /No active task/);
});

test('resolveStatusBarNextAction weaving without validation → Validate', () => {
  const next = resolveStatusBarNextAction({
    taskId: 'TASK-1',
    status: 'weaving',
    validationResult: null,
    validationOverride: false,
    goal: 'Ship it',
  });
  assert.equal(next.command, 'tyne.runValidateReview');
  assert.match(next.text, /Validate/);
});

test('resolveStatusBarNextAction weaving pass → Tie knot', () => {
  const next = resolveStatusBarNextAction({
    taskId: 'TASK-1',
    status: 'weaving',
    validationResult: {
      id: 'v1',
      provider: 'openai',
      tier: 'pro',
      status: 'pass',
      summary: 'ok',
      createdAt: new Date().toISOString(),
    },
    validationOverride: false,
    goal: 'Ship it',
  });
  assert.equal(next.command, 'tyne.tieTheKnot');
  assert.match(next.text, /Tie knot/);
});

test('resolveStatusBarNextAction weaving fail → Open report', () => {
  const next = resolveStatusBarNextAction({
    taskId: 'TASK-1',
    status: 'weaving',
    validationResult: {
      id: 'v1',
      provider: 'openai',
      tier: 'pro',
      status: 'fail',
      summary: 'needs work',
      createdAt: new Date().toISOString(),
    },
    validationOverride: false,
    goal: 'Ship it',
  });
  assert.equal(next.command, 'tyne.openLatestValidateReview');
});

test('validationPassNotifyActions differs for pass vs fail', () => {
  const pass = validationPassNotifyActions({ status: 'pass' });
  assert.ok(pass.some(a => a.command === 'tyne.tieTheKnot'));
  const fail = validationPassNotifyActions({ status: 'fail' });
  assert.ok(fail.some(a => a.command === 'tyne.runValidateReview'));
  assert.ok(!fail.some(a => a.command === 'tyne.tieTheKnot'));
});

test('isTyneSidebarFocused reads visible flag', () => {
  assert.equal(isTyneSidebarFocused(undefined), false);
  assert.equal(isTyneSidebarFocused({ visible: false }), false);
  assert.equal(isTyneSidebarFocused({ visible: true }), true);
});

test('notifyWithActions helper and P0 command wiring exist', () => {
  const helper = readSrc('notifyWithActions.ts');
  assert.ok(helper.includes('export async function notifyWithActions'));
  assert.ok(helper.includes('scheduleOneShotValidateReminder'));

  const extension = readSrc('extension.ts');
  assert.ok(extension.includes("registerCommand('tyne.tieTheKnot'"));
  assert.ok(extension.includes("registerCommand('tyne.openLatestValidateReview'"));
  assert.ok(extension.includes("registerCommand('tyne.undoLastFindingFix'"));
  assert.ok(extension.includes("registerCommand('tyne.scheduleValidateReminder'"));
  assert.ok(extension.includes("registerCommand('tyne.statusBarNextAction'"));
  assert.ok(extension.includes("registerCommand('tyne.startThread'"));

  const thread = readSrc('sidebar/threadWorkflowController.ts');
  assert.ok(thread.includes("title: 'Validate & Review'"));
  assert.ok(thread.includes("command: 'tyne.runValidateReview'"));
  assert.ok(thread.includes("command: 'tyne.connectGitHub'") || thread.includes('Connect GitHub'));

  const fixes = readSrc('sidebar/findingFixController.ts');
  assert.ok(fixes.includes("command: 'tyne.runValidateReview'"));
  assert.ok(fixes.includes("command: 'tyne.undoLastFindingFix'"));
  assert.ok(fixes.includes('undoLastAppliedFix'));

  const pm = readSrc('sidebar/pmToolsController.ts');
  assert.ok(pm.includes("command: 'tyne.connectGitHub'"));
  assert.ok(pm.includes("command: 'tyne.openSettingsPage'"));
});

test('focus-aware validation toast and rehydrate Open report are wired', () => {
  const provider = readSrc('TyneSidebarProvider.ts');
  assert.ok(provider.includes('notifyValidationOutcome'));
  assert.ok(provider.includes('isTyneSidebarFocused'));
  assert.ok(provider.includes("command = 'tyne.statusBarNextAction'") || provider.includes("tyne.statusBarNextAction"));

  const validate = readSrc('sidebar/validateReviewController.ts');
  assert.ok(validate.includes('notifyValidationOutcome'));
  assert.ok(validate.includes("title: 'Open report'"));
  assert.ok(validate.includes("command: 'tyne.openLatestValidateReview'"));
});
