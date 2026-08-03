/**
 * VS Code notification helpers with command-backed CTAs.
 * Prefer one primary action (optional secondary). Never spam when the sidebar is enough.
 */
import * as vscode from 'vscode';
import {
  type NotifyAction,
  resolveStatusBarNextAction,
  isTyneSidebarFocused,
  validationPassNotifyActions,
} from './notifyWithActionsUtils';

export type { NotifyAction, StatusBarNextAction } from './notifyWithActionsUtils';
export {
  resolveStatusBarNextAction,
  isTyneSidebarFocused,
  validationPassNotifyActions,
} from './notifyWithActionsUtils';

export type NotifyKind = 'info' | 'warn' | 'error';

export async function notifyWithActions(
  message: string,
  actions: NotifyAction[] = [],
  kind: NotifyKind = 'info',
): Promise<string | undefined> {
  const titles = actions.map(a => a.title);
  const show =
    kind === 'warn' ? vscode.window.showWarningMessage.bind(vscode.window)
      : kind === 'error' ? vscode.window.showErrorMessage.bind(vscode.window)
        : vscode.window.showInformationMessage.bind(vscode.window);
  const choice = await show(message, ...titles);
  if (!choice) { return undefined; }
  const action = actions.find(a => a.title === choice);
  if (action?.command) {
    await vscode.commands.executeCommand(action.command, ...(action.args || []));
  }
  return choice;
}

let reminderTimer: ReturnType<typeof setTimeout> | undefined;

/** One-shot nudge to re-run Validate & Review (agent handoff path). */
export function scheduleOneShotValidateReminder(delayMs = 10 * 60 * 1000): void {
  if (reminderTimer) { clearTimeout(reminderTimer); }
  reminderTimer = setTimeout(() => {
    reminderTimer = undefined;
    void notifyWithActions(
      'Ready to re-run Validate & Review on your fixes?',
      [{ title: 'Run Validation', command: 'tyne.runValidateReview' }],
    );
  }, delayMs);
}

export function cancelScheduledValidateReminder(): void {
  if (reminderTimer) {
    clearTimeout(reminderTimer);
    reminderTimer = undefined;
  }
}
