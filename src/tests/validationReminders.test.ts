import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import {
  countAddedLines,
  countWorkspaceErrors,
  isCooldownActive,
  isCountableError,
  normalizeReminderConfig,
  shouldPromptLongSession,
} from '../validationReminderUtils';

const MIN = 60_000;

function readSrc(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', name), 'utf8');
}

test('countAddedLines reaches threshold exactly and counts multiline paste', () => {
  // 50 newline-separated inserts into empty ranges → 50 net added lines
  const fifty = Array.from({ length: 50 }, () => ({ text: 'line\n', rangeEmpty: true, rangeLineSpan: 1 }));
  assert.strictEqual(countAddedLines(fifty), 50);
  // Multiline paste: 'a\nb\nc' into empty range → 3 lines vs 1 → +2
  assert.strictEqual(countAddedLines([{ text: 'a\nb\nc', rangeEmpty: true, rangeLineSpan: 1 }]), 2);
  // Replace 2-line span with 5-line text → +3
  assert.strictEqual(countAddedLines([{ text: 'a\nb\nc\nd\ne', rangeEmpty: false, rangeLineSpan: 2 }]), 3);
  // Pure deletion adds nothing
  assert.strictEqual(countAddedLines([{ text: '', rangeEmpty: false, rangeLineSpan: 5 }]), 0);
});

test('workspace line counter aggregates across files (one global prompt path)', () => {
  const src = readSrc('codeChangeWatcher.ts');
  assert.ok(src.includes('workspaceAddedLines'), 'must track workspace-wide added lines');
  assert.ok(src.includes("maybePrompt('large_edit')"), 'threshold must call maybePrompt once');
  assert.ok(!src.includes('tracker.notified'), 'must not notify per-file');
});

test('syntax warnings ignored; Tyne diagnostics ignored; only Error severity counts', () => {
  const Error = 0;
  const Warning = 1;
  assert.strictEqual(isCountableError({ severity: Warning, source: 'ts' }, Error), false);
  assert.strictEqual(isCountableError({ severity: Error, source: 'ts' }, Error), true);
  assert.strictEqual(isCountableError({ severity: Error, source: 'Tyne' }, Error), false);
  assert.strictEqual(isCountableError({ severity: Error, source: 'tyne' }, Error), false);

  const total = countWorkspaceErrors([
    { scheme: 'file', diagnostics: [{ severity: Error, source: 'ts' }, { severity: Warning, source: 'eslint' }] },
    { scheme: 'untitled', diagnostics: [{ severity: Error, source: 'ts' }] },
    { scheme: 'file', diagnostics: [{ severity: Error, source: 'Tyne' }] },
  ], Error);
  assert.strictEqual(total, 1);
});

test('syntax errors prompt only on zero-to-nonzero transition after debounce', () => {
  const src = readSrc('codeChangeWatcher.ts');
  assert.ok(src.includes('onDidChangeDiagnostics'), 'must subscribe to diagnostics');
  assert.ok(src.includes('DIAGNOSTICS_DEBOUNCE_MS'), 'must debounce diagnostics');
  assert.ok(src.includes('5_000') || src.includes('5000'), 'debounce is 5 seconds');
  assert.ok(src.includes('errorCount > 0 && !hadErrors'), 'must require zero→nonzero transition');
  assert.ok(src.includes("maybePrompt('syntax_error')"), 'must prompt for syntax errors');
});

test('active 45-minute session prompts; inactive session does not', () => {
  const now = 1_000_000_000;
  assert.strictEqual(shouldPromptLongSession({
    sessionStartedAt: now - 45 * MIN,
    lastEditAt: now - 2 * MIN,
    now,
    sessionMinutes: 45,
  }), true);

  assert.strictEqual(shouldPromptLongSession({
    sessionStartedAt: now - 45 * MIN,
    lastEditAt: now - 6 * MIN, // inactive > 5 min
    now,
    sessionMinutes: 45,
  }), false);

  assert.strictEqual(shouldPromptLongSession({
    sessionStartedAt: now - 44 * MIN,
    lastEditAt: now - 1 * MIN,
    now,
    sessionMinutes: 45,
  }), false);
});

test('global cooldown and visible-prompt lock prevent duplicates', () => {
  const now = Date.now();
  assert.strictEqual(isCooldownActive(undefined, now, 20), false);
  assert.strictEqual(isCooldownActive(now - 10 * MIN, now, 20), true);
  assert.strictEqual(isCooldownActive(now - 21 * MIN, now, 20), false);
  // minimum clamp at 5 minutes
  assert.strictEqual(isCooldownActive(now - 4 * MIN, now, 1), true);

  const src = readSrc('codeChangeWatcher.ts');
  assert.ok(src.includes('promptVisible'), 'must lock while a prompt is visible');
  assert.ok(src.includes('reviewRunning'), 'must suppress while review is running');
  assert.ok(src.includes('isCooldownActive'), 'must use shared cooldown helper');
});

test('Run Validation reaches triggerValidation / _handleRunValidateReview', () => {
  const extension = readSrc('extension.ts');
  assert.ok(extension.includes('tyne.runValidateReview'), 'command registered');
  assert.ok(extension.includes('triggerValidation()'), 'must execute real validation');
  assert.ok(!extension.includes('provider.triggerValidateReview()'), 'must not use navigation-only trigger');

  const provider = readSrc('TyneSidebarProvider.ts');
  assert.ok(provider.includes('public triggerValidation(): Promise<void>'), 'triggerValidation must return a promise');
  assert.ok(provider.includes('return this._handleRunValidateReview()'), 'must await real review run');

  const watcher = readSrc('codeChangeWatcher.ts');
  assert.ok(watcher.includes('executeCommand(COMMAND_RUN_VALIDATE_REVIEW)'), 'watcher must invoke run command');
  assert.ok(watcher.includes('showErrorMessage'), 'must surface rejected command errors');
  assert.ok(watcher.includes('Not Now'), 'must offer dismiss action');
});

test('rejected command execution is handled', () => {
  const src = readSrc('codeChangeWatcher.ts');
  assert.ok(src.includes('catch (err'), 'must catch command failures');
  assert.ok(src.includes('Could not start Validate & Review'), 'must show a user-facing error');
  assert.ok(src.includes('reviewRunning = false'), 'must clear running lock in finally');
});

test('all listeners and timer are disposed', () => {
  const src = readSrc('codeChangeWatcher.ts');
  assert.ok(src.includes('dispose()'), 'must expose dispose');
  assert.ok(src.includes('clearTimeout(diagnosticsTimer)'), 'must clear diagnostics debounce');
  assert.ok(src.includes('clearInterval(sessionTimer)'), 'must clear session timer');
  assert.ok(src.includes('changeSubscription.dispose()'), 'must dispose change listener');
  assert.ok(src.includes('diagnosticsSubscription.dispose()'), 'must dispose diagnostics listener');
});

test('reminder settings exist with expected defaults', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  assert.strictEqual(props['tyne.validationReminders.enabled'].default, true);
  assert.strictEqual(props['tyne.validationReminders.cooldownMinutes'].default, 20);
  assert.strictEqual(props['tyne.validationReminders.cooldownMinutes'].minimum, 5);
  assert.strictEqual(props['tyne.validationReminders.sessionMinutes'].default, 45);
  assert.strictEqual(props['tyne.validationReminders.sessionMinutes'].minimum, 10);
  assert.strictEqual(props['tyne.validateReviewLineThreshold'].default, 50);
});

test('normalizeReminderConfig clamps mins and respects disables', () => {
  const cfg = normalizeReminderConfig({
    enabled: false,
    cooldownMinutes: 1,
    sessionMinutes: 2,
    lineThreshold: 0,
  });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.cooldownMinutes, 5);
  assert.strictEqual(cfg.sessionMinutes, 10);
  assert.strictEqual(cfg.lineThreshold, 1);
});
