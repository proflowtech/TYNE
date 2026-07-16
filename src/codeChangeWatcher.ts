/**
 * Automatic Validate & Review reminders.
 * Triggers: large edits, live syntax errors, long active coding sessions.
 * One visible prompt + global cooldown — no spam.
 */
import * as vscode from 'vscode';
import {
  countAddedLines,
  countWorkspaceErrors,
  isCooldownActive,
  normalizeReminderConfig,
  shouldPromptLongSession,
  type ReminderConfig,
  type ReminderReason,
} from './validationReminderUtils';

export {
  countAddedLines,
  countWorkspaceErrors,
  isCooldownActive,
  isCountableError,
  shouldPromptLongSession,
  normalizeReminderConfig,
  type ReminderConfig,
  type ReminderReason,
} from './validationReminderUtils';

const COMMAND_RUN_VALIDATE_REVIEW = 'tyne.runValidateReview';
const DIAGNOSTICS_DEBOUNCE_MS = 5_000;
const SESSION_CHECK_MS = 60_000;
const STATE_LAST_PROMPT = 'tyne.validationReminders.lastPromptAt';
const STATE_SESSION_START = 'tyne.validationReminders.sessionStartedAt';

export function countAddedLinesFromEvents(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
): number {
  return countAddedLines(changes.map(change => ({
    text: change.text,
    rangeEmpty: change.range.isEmpty,
    rangeLineSpan: change.range.end.line - change.range.start.line + 1,
  })));
}

export function readReminderConfig(
  getConfig: () => { get<T>(key: string, defaultValue: T): T } = () => vscode.workspace.getConfiguration('tyne'),
): ReminderConfig {
  const config = getConfig();
  return normalizeReminderConfig({
    enabled: config.get<boolean>('validationReminders.enabled', true),
    lineThreshold: config.get<number>('validateReviewLineThreshold', 50),
    cooldownMinutes: config.get<number>('validationReminders.cooldownMinutes', 20),
    sessionMinutes: config.get<number>('validationReminders.sessionMinutes', 45),
  });
}

export function startCodeChangeWatcher(context: vscode.ExtensionContext): vscode.Disposable {
  const trackers = new Map<string, { addedLines: number }>();
  let workspaceAddedLines = 0;
  let promptVisible = false;
  let reviewRunning = false;
  let lastEditAt = 0;
  let hadErrors = false;
  let diagnosticsTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  function getLastPromptAt(): number | undefined {
    const raw = context.workspaceState.get<number>(STATE_LAST_PROMPT);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  function getSessionStartedAt(): number | undefined {
    const raw = context.workspaceState.get<number>(STATE_SESSION_START);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  async function setLastPromptAt(ts: number): Promise<void> {
    await context.workspaceState.update(STATE_LAST_PROMPT, ts);
  }

  async function setSessionStartedAt(ts: number | undefined): Promise<void> {
    await context.workspaceState.update(STATE_SESSION_START, ts);
  }

  function resetCounters(): void {
    trackers.clear();
    workspaceAddedLines = 0;
    hadErrors = false;
  }

  async function maybePrompt(reason: ReminderReason): Promise<void> {
    if (disposed || promptVisible || reviewRunning) return;
    const cfg = readReminderConfig();
    if (!cfg.enabled) return;
    const now = Date.now();
    if (isCooldownActive(getLastPromptAt(), now, cfg.cooldownMinutes)) return;

    promptVisible = true;
    await setLastPromptAt(now);

    const message = reason === 'large_edit'
      ? `You've added about ${cfg.lineThreshold}+ lines. Run Validate & Review before continuing?`
      : reason === 'syntax_error'
        ? 'Tyne detected syntax errors in your workspace. Run Validate & Review to catch issues early?'
        : `You've been coding for about ${cfg.sessionMinutes} minutes. Quick Validate & Review checkpoint?`;

    const runLabel = 'Run Validation';
    const dismissLabel = 'Not Now';

    try {
      const selection = await vscode.window.showInformationMessage(message, runLabel, dismissLabel);
      if (selection === runLabel) {
        reviewRunning = true;
        try {
          await vscode.commands.executeCommand(COMMAND_RUN_VALIDATE_REVIEW);
          resetCounters();
          await setSessionStartedAt(undefined);
          lastEditAt = 0;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Could not start Validate & Review: ${msg}`);
        } finally {
          reviewRunning = false;
        }
      }
    } finally {
      promptVisible = false;
    }
  }

  function onEditActivity(): void {
    const now = Date.now();
    lastEditAt = now;
    if (!getSessionStartedAt()) {
      void setSessionStartedAt(now);
    }
  }

  const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.reason === vscode.TextDocumentChangeReason.Undo) return;
    if (event.document.uri.scheme !== 'file') return;

    onEditActivity();
    const cfg = readReminderConfig();
    if (!cfg.enabled) return;

    const key = event.document.uri.toString();
    const tracker = trackers.get(key) || { addedLines: 0 };
    const added = countAddedLinesFromEvents(event.contentChanges);
    tracker.addedLines += added;
    workspaceAddedLines += added;
    trackers.set(key, tracker);

    if (workspaceAddedLines >= cfg.lineThreshold) {
      void maybePrompt('large_edit');
    }
  });

  const closeSubscription = vscode.workspace.onDidCloseTextDocument((doc) => {
    trackers.delete(doc.uri.toString());
  });

  const diagnosticsSubscription = vscode.languages.onDidChangeDiagnostics(() => {
    if (disposed) return;
    if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
    diagnosticsTimer = setTimeout(() => {
      if (disposed) return;
      const cfg = readReminderConfig();
      if (!cfg.enabled) return;

      const entries = vscode.languages.getDiagnostics().map(([uri, diagnostics]) => ({
        scheme: uri.scheme,
        diagnostics,
      }));
      const errorCount = countWorkspaceErrors(entries, vscode.DiagnosticSeverity.Error);
      const rising = errorCount > 0 && !hadErrors;
      hadErrors = errorCount > 0;
      if (rising) void maybePrompt('syntax_error');
    }, DIAGNOSTICS_DEBOUNCE_MS);
  });

  sessionTimer = setInterval(() => {
    if (disposed) return;
    const cfg = readReminderConfig();
    if (!cfg.enabled) return;
    const started = getSessionStartedAt();
    if (!started || !lastEditAt) return;
    if (shouldPromptLongSession({
      sessionStartedAt: started,
      lastEditAt,
      now: Date.now(),
      sessionMinutes: cfg.sessionMinutes,
    })) {
      void maybePrompt('long_session');
    }
  }, SESSION_CHECK_MS);

  context.subscriptions.push(changeSubscription, closeSubscription, diagnosticsSubscription);

  return {
    dispose() {
      disposed = true;
      trackers.clear();
      if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
      if (sessionTimer) clearInterval(sessionTimer);
      changeSubscription.dispose();
      closeSubscription.dispose();
      diagnosticsSubscription.dispose();
    },
  };
}
