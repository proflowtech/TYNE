import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import {
  getAutomationSettings,
  saveAutomationSettings,
  listAutomationEventsForTask,
  repairAutomationStorage,
} from '../automationMetadataService';
import {
  markTaskDone,
  postFeedback,
  completeTaskAndPostFeedback,
  hasResolvableTransitions,
  resolveTaskTransition,
  buildAutomationContextFromBranch,
  AutomationContext,
} from '../taskAutomationService';
import { previewFeedback } from '../workFeedbackService';
import {
  TyneTaskAutomationSettings,
  TynePlanTier,
  TyneMaxFeedbackSection,
  ALL_MAX_FEEDBACK_SECTIONS,
  TyneAutomationEvent,
} from '../automationTypes';
import { normalizeTier } from '../codeValidationService';
import { TyneValidationResult } from '../validationTypes';
import { ComplianceFramework } from '../validateReviewTypes';
import { markCachedTaskDone as persistCachedTaskDone } from '../taskCacheService';
import { refreshTaskStatus, detectStatusConflict } from '../taskSyncService';
import { reinstallPostCommitHook, getDetectorState, installQualityGateHooks } from '../gitHookService';

type AutomationHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'hasWebview'
  | 'userProfile'
  | 'getRepositoryPath'
  | 'pmTaskLabel'
  | 'refreshTasksContext'
>;

export class AutomationController {
  constructor(private readonly host: AutomationHost) {}

  async runTieKnotAutomation(
    branchName: string,
    taskId: string,
    validationResult: TyneValidationResult | null,
    pushed: boolean,
  ): Promise<void> {
    if (!taskId || !branchName) { return; }
    const repositoryPath = this.host.getRepositoryPath();
    const automationCtx = buildAutomationContextFromBranch(
      this.host.context, repositoryPath, branchName, validationResult,
    );
    if (!automationCtx) {
      vscode.window.showWarningMessage(`Tie-the-knot: branch ${branchName} has no linked PM task, so the PM tool was not updated.`);
      return;
    }

    const settings = getAutomationSettings(this.host.context);
    const trigger = settings.autoCloseTrigger;

    const shouldClose = trigger === 'on_push' || trigger === 'manual_and_on_push';
    const shouldPostFeedback = settings.autoPostFeedbackAfterClose;
    if (trigger === 'disabled' && !shouldPostFeedback) { return; }
    if (!shouldClose && !shouldPostFeedback) { return; }

    const planTier: TynePlanTier = normalizeTier(this.host.userProfile.tier);

    if (shouldClose) {
      vscode.window.showInformationMessage('Tie-the-knot: updating the linked PM task…');
      const closeEvent = await markTaskDone(automationCtx, 'task_done');
      if (closeEvent.status === 'success') {
        await this.markCachedTaskDone(taskId);
        vscode.window.showInformationMessage(`Task status updated successfully. ${this.host.pmTaskLabel(taskId)} marked Done.`);
      } else if (closeEvent.status === 'skipped') {
        if (/already marked done/i.test(closeEvent.errorMessage ?? '')) {
          await this.markCachedTaskDone(taskId);
        } else {
          vscode.window.showInformationMessage(closeEvent.errorMessage ?? 'Task close skipped.');
        }
      } else if (closeEvent.status === 'failed') {
        vscode.window.showWarningMessage(closeEvent.errorMessage ?? 'Could not mark the PM task Done.');
      }
    }

    // Post work-summary comment on tie-the-knot even when auto-close is manual/disabled.
    if (shouldPostFeedback) {
      const feedbackEvent = await postFeedback(automationCtx, 'task_done', undefined, planTier, settings.maxFeedbackSections);
      if (feedbackEvent.status === 'success') {
        vscode.window.showInformationMessage('Feedback comment posted to the PM task.');
      } else if (feedbackEvent.status === 'failed') {
        vscode.window.showWarningMessage(feedbackEvent.errorMessage ?? 'Could not post the feedback comment.');
      } else if (feedbackEvent.status === 'skipped' && feedbackEvent.errorMessage) {
        vscode.window.showInformationMessage(feedbackEvent.errorMessage);
      }
    }
    await this.refreshAutomationContext(true);
    await this.host.refreshTasksContext(true);
  }

  async markCachedTaskDone(taskId: string): Promise<void> {
    try {
      await persistCachedTaskDone(this.host.context, taskId);
    } catch (err) {
      console.error('Tyne: failed to mark cached task done', err);
    }
  }

  async refreshAutomationContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath) { return; }
    const taskId = this.host.state.taskId;
    const branchName = this.host.state.branchName;
    try {
      await repairAutomationStorage(this.host.context);
      const settings = getAutomationSettings(this.host.context);
      let syncState = null;
      let conflict = null;
      if (taskId) {
        syncState = await refreshTaskStatus(
          this.host.context, repositoryPath, taskId,
          this.host.state.taskTitle, this.host.state.taskSource,
          this.host.state.taskUrl || undefined, branchName || undefined,
        ).catch(() => null);
        conflict = detectStatusConflict(this.host.context, taskId);
      }
      const events = taskId ? listAutomationEventsForTask(this.host.context, taskId) : [];
      const detectorState = await getDetectorState(this.host.context);
      if (postMessage || this.host.hasWebview()) {
        this.host.postMessage({
          type: 'automationDataLoaded',
          settings,
          syncState,
          conflict,
          events: events.slice(-20),
          detectorState,
          userTier: normalizeTier(this.host.userProfile.tier),
        });
      }
    } catch (err) {
      console.error('Tyne: automation refresh failed', err);
    }
  }

  async handleMarkTaskDone(): Promise<void> {
    const taskId = this.host.state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task to mark Done.'); return; }
    const pick = await vscode.window.showWarningMessage(
      `Mark task ${taskId} as Done in your PM tool?`, 'Yes, mark Done', 'Cancel',
    );
    if (pick !== 'Yes, mark Done') { return; }
    const ctx = this.buildAutomationCtx();
    if (!ctx) { return; }
    const ev = await markTaskDone(ctx, 'manual');
    await this.handleCompletionEvent(ev);
  }

  async handlePostFeedback(bodyOverride?: string): Promise<void> {
    const taskId = this.host.state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task to post feedback for.'); return; }
    const ctx = this.buildAutomationCtx();
    if (!ctx) { return; }
    const settings = getAutomationSettings(this.host.context);
    const planTier: TynePlanTier = normalizeTier(this.host.userProfile.tier);
    const ev = await postFeedback(ctx, 'manual', bodyOverride, planTier, settings.maxFeedbackSections);
    if (ev.status === 'success') {
      vscode.window.showInformationMessage('Feedback posted to PM task.');
    } else if (ev.status === 'skipped') {
      vscode.window.showInformationMessage(ev.errorMessage ?? 'Feedback skipped.');
    } else {
      vscode.window.showWarningMessage(ev.errorMessage ?? 'Could not post feedback. Please check PM tool permissions.');
    }
    await this.refreshAutomationContext(true);
  }

  async handleCompleteAndFeedback(bodyOverride?: string): Promise<void> {
    const taskId = this.host.state.taskId;
    if (!taskId) { vscode.window.showErrorMessage('No active task.'); return; }
    const pick = await vscode.window.showWarningMessage(
      `Post feedback and mark task ${taskId} Done?`, 'Yes, complete task', 'Cancel',
    );
    if (pick !== 'Yes, complete task') { return; }
    const ctx = this.buildAutomationCtx();
    if (!ctx) { return; }
    const settings = getAutomationSettings(this.host.context);
    const planTier: TynePlanTier = normalizeTier(this.host.userProfile.tier);
    const [feedbackEv, closeEv] = await completeTaskAndPostFeedback(ctx, bodyOverride, planTier, settings.maxFeedbackSections);
    const bothOk = feedbackEv.status === 'success' && closeEv.status === 'success';
    const feedbackOkCloseNot = feedbackEv.status === 'success' && closeEv.status !== 'success';
    const closeOkFeedbackNot = closeEv.status === 'success' && feedbackEv.status !== 'success';
    if (closeEv.status === 'success') { await this.markCachedTaskDone(taskId); }
    if (bothOk) {
      vscode.window.showInformationMessage('Task marked Done and feedback posted.');
    } else if (feedbackOkCloseNot) {
      vscode.window.showWarningMessage('Feedback posted, but task status could not be updated.');
    } else if (closeOkFeedbackNot) {
      vscode.window.showWarningMessage('Task marked Done, but feedback could not be posted.');
    } else {
      vscode.window.showWarningMessage(
        [feedbackEv.errorMessage, closeEv.errorMessage].filter(Boolean).join(' | ') || 'Automation step failed.',
      );
    }
    await this.refreshAutomationContext(true);
    await this.host.refreshTasksContext(true);
  }

  async handleCompletionEvent(ev: TyneAutomationEvent, autoTriggered = false): Promise<void> {
    if (ev.status === 'success') {
      if (ev.taskId) { await this.markCachedTaskDone(ev.taskId); await this.host.refreshTasksContext(true); }
      vscode.window.showInformationMessage(ev.resultMessage || 'Task status updated successfully.');
    } else if (ev.status === 'partial_success') {
      if (ev.resultMessage) {
        vscode.window.showInformationMessage(ev.resultMessage);
      }
      if (hasResolvableTransitions(ev)) {
        await this.promptForJiraTransition(ev.availableTransitions, autoTriggered);
      } else {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'Jira worklog was saved, but the issue was not closed.');
      }
    } else if (ev.status === 'skipped') {
      vscode.window.showInformationMessage(ev.errorMessage ?? 'Task close skipped.');
    } else {
      if (hasResolvableTransitions(ev)) {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'No matching Jira close transition was found.');
        await this.promptForJiraTransition(ev.availableTransitions, autoTriggered);
      } else {
        vscode.window.showWarningMessage(ev.errorMessage ?? 'Could not update task status.');
      }
    }
    await this.refreshAutomationContext(true);
  }

  async promptForJiraTransition(
    transitions: Array<{ id: string; name: string; toStatus?: string }>,
    autoTriggered: boolean,
  ): Promise<void> {
    const ctx = this.buildAutomationCtx();
    if (!ctx) { return; }
    const picks = transitions.map(transition => ({
      label: transition.name,
      description: transition.toStatus ? `to ${transition.toStatus}` : undefined,
      transitionId: transition.id,
    }));
    const choice = await vscode.window.showQuickPick(picks, {
      title: autoTriggered ? 'Validation logged time to Jira. Pick a transition to close the issue.' : 'No Done/Closed Jira transition found. Pick one to finish the issue.',
      placeHolder: picks.map(item => item.label).join(', '),
    });
    if (!choice) {
      vscode.window.showWarningMessage(`Jira transition still needs action. Available: ${picks.map(item => item.label).join(', ')}`);
      return;
    }
    const resolved = await resolveTaskTransition(ctx, choice.transitionId, autoTriggered ? 'validation_pass' : 'manual');
    if (resolved.status === 'success') {
      vscode.window.showInformationMessage(resolved.resultMessage || 'Jira task transitioned successfully.');
    } else {
      vscode.window.showWarningMessage(resolved.errorMessage ?? 'Could not apply the selected Jira transition.');
    }
  }

  async handlePreviewFeedback(): Promise<void> {
    const taskId = this.host.state.taskId;
    if (!taskId) { return; }
    const repositoryPath = this.host.getRepositoryPath();
    const settings = getAutomationSettings(this.host.context);
    const planTier: TynePlanTier = normalizeTier(this.host.userProfile.tier);
    try {
      const preview = await previewFeedback(
        this.host.context, repositoryPath, taskId,
        this.host.state.taskTitle, this.host.state.branchName || undefined,
        this.host.state.validationResult, settings.requireValidationBeforeFeedback,
        planTier, settings.maxFeedbackSections,
      );
      this.host.postMessage({ type: 'automationFeedbackPreview', preview });
    } catch (err) {
      vscode.window.showErrorMessage('Could not generate feedback preview.');
      console.error(err);
    }
  }

  async handleSaveAutomationSettings(settings: TyneTaskAutomationSettings): Promise<void> {
    if (!settings) { return; }
    const existing = getAutomationSettings(this.host.context);
    const isMax = normalizeTier(this.host.userProfile.tier) === 'max';
    const allowedFrameworks: ComplianceFramework[] = ['HIPAA', 'SOC2', 'PCI_DSS', 'GDPR', 'ISO27001', 'NIST_CSF', 'NIST_800_53', 'FEDRAMP', 'CCPA_CPRA', 'SOX', 'CUSTOM'];
    const complianceFrameworks = Array.isArray(settings.complianceFrameworks)
      ? settings.complianceFrameworks.filter((framework): framework is ComplianceFramework => allowedFrameworks.includes(framework))
      : [];
    const merged = {
      ...existing,
      ...settings,
      complianceChecksEnabled: isMax && settings.complianceChecksEnabled === true,
      // Honor the user's explicit selection — including an empty list — instead of
      // silently forcing HIPAA. Non-MAX users carry no frameworks.
      complianceFrameworks: isMax ? complianceFrameworks : [],
      privacyMode: ['cloud', 'privacy_enhanced', 'local_compliance'].includes(String(settings.privacyMode))
        ? settings.privacyMode
        : existing.privacyMode || 'cloud',
      dataResidency: ['us', 'eu', 'local_only', 'enterprise_managed'].includes(String(settings.dataResidency))
        ? settings.dataResidency
        : existing.dataResidency || 'us',
      evidencePersistenceDisabled: settings.evidencePersistenceDisabled === true
        || settings.privacyMode === 'local_compliance',
    };
    await saveAutomationSettings(this.host.context, merged);
    vscode.window.showInformationMessage('Automation settings saved.');
    await this.refreshAutomationContext(true);
  }

  async handleSaveMaxReportSettings(sections: TyneMaxFeedbackSection[]): Promise<void> {
    if (!Array.isArray(sections)) { return; }
    const settings = getAutomationSettings(this.host.context);
    const validSections = sections.filter((s): s is TyneMaxFeedbackSection => ALL_MAX_FEEDBACK_SECTIONS.includes(s));
    settings.maxFeedbackSections = validSections.length ? validSections : [...ALL_MAX_FEEDBACK_SECTIONS];
    await saveAutomationSettings(this.host.context, settings);
    vscode.window.showInformationMessage('MAX report settings saved.');
    await this.refreshAutomationContext(true);
  }

  async handleReinstallCommitHook(): Promise<void> {
    const state = await reinstallPostCommitHook(this.host.context);
    this.host.postMessage({ type: 'commitDetectorState', state });
    // Also install quality gate hooks (pre-commit + pre-push)
    const gateResult = await installQualityGateHooks(this.host.context);
    vscode.window.showInformationMessage(
      state.hookInstalled
        ? `Git hooks installed.${gateResult.preCommitInstalled ? ' Pre-commit quality gate active.' : ''}${gateResult.prePushInstalled ? ' Pre-push quality gate active.' : ''}`
        : `Git hook could not be installed: ${state.error || 'unknown error'}. Watcher fallback active.`,
    );
  }

  buildAutomationCtx(): AutomationContext | null {
    const taskId = this.host.state.taskId;
    if (!taskId) { return null; }
    return {
      context: this.host.context,
      repositoryPath: this.host.getRepositoryPath(),
      taskId,
      taskTitle: this.host.state.taskTitle || undefined,
      taskSource: this.host.state.taskSource,
      taskUrl: this.host.state.taskUrl || undefined,
      branchName: this.host.state.branchName || undefined,
      validationResult: this.host.state.validationResult,
    };
  }
}
