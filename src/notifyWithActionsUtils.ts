/**
 * Pure notification / status-bar helpers (no vscode import — unit-testable).
 */
import type { TyneState } from './stateManager';
import type { TyneValidationResult } from './validationTypes';

export type NotifyAction = {
  title: string;
  command: string;
  args?: unknown[];
};

export type StatusBarNextAction = {
  text: string;
  tooltip: string;
  command: string;
};

/** Derive the status-bar one-click next step from Thread state. */
export function resolveStatusBarNextAction(state: Pick<
  TyneState,
  'taskId' | 'status' | 'validationResult' | 'validationOverride' | 'goal'
>): StatusBarNextAction {
  const taskId = String(state.taskId || '').trim();
  if (!taskId) {
    return {
      text: 'Tyne: No active task',
      tooltip: 'Open Tyne sidebar',
      command: 'tyne.focusSidebar',
    };
  }

  if (state.status !== 'weaving') {
    return {
      text: `Tyne: ${taskId}`,
      tooltip: state.goal || 'Open Tyne sidebar',
      command: 'tyne.focusSidebar',
    };
  }

  const result = state.validationResult;
  if (result?.status === 'pass' || state.validationOverride) {
    return {
      text: `Tyne: ${taskId} · Tie knot`,
      tooltip: 'Tie the knot — commit and push',
      command: 'tyne.tieTheKnot',
    };
  }
  if (result) {
    return {
      text: `Tyne: ${taskId} · Open report`,
      tooltip: 'Open latest Validate & Review report',
      command: 'tyne.openLatestValidateReview',
    };
  }
  return {
    text: `Tyne: ${taskId} · Validate`,
    tooltip: 'Run Validate & Review',
    command: 'tyne.runValidateReview',
  };
}

/** True when Tyne sidebar webview is visible (prefer in-panel CTAs). */
export function isTyneSidebarFocused(view: { visible?: boolean } | undefined | null): boolean {
  return Boolean(view && view.visible);
}

export function validationPassNotifyActions(result: Pick<TyneValidationResult, 'status'>): NotifyAction[] {
  if (result.status === 'pass') {
    return [
      { title: 'Tie the knot', command: 'tyne.tieTheKnot' },
      { title: 'Open report', command: 'tyne.openLatestValidateReview' },
    ];
  }
  return [
    { title: 'Open findings', command: 'tyne.openLatestValidateReview' },
    { title: 'Re-run', command: 'tyne.runValidateReview' },
  ];
}
