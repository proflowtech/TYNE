import * as vscode from 'vscode';
import { TyneValidationResult } from './validationTypes';
import {
  TyneAutomationEvent,
  TynePmTransition,
  TyneAutomationTriggerSource,
  TyneNormalizedPmStatus,
  TyneWorkFeedback,
} from './automationTypes';
import {
  getAutomationSettings,
  saveAutomationEvent,
  makeEventId,
  hasPostedFeedback,
  hasAutoClosedTask,
  getTaskSyncState,
} from './automationMetadataService';
import { getAdapterForTaskSource } from './pmAdapterInterface';
import { buildFeedback } from './workFeedbackService';
import { saveTaskSyncState } from './automationMetadataService';
import { getBranchByName } from './branchMetadataService';
import { getUnsyncedTimeLogsForTask, getTimeLogSyncSummary, markTimeLogsSynced } from './timeTrackingService';
import { markCommitSessionsSynced } from './commitMetadataService';

export interface AutomationContext {
  context: vscode.ExtensionContext;
  repositoryPath: string;
  taskId: string;
  taskTitle?: string;
  taskSource: string;
  taskUrl?: string;
  branchName?: string;
  validationResult: TyneValidationResult | null;
}

export async function markTaskDone(
  ctx: AutomationContext,
  triggerSource: TyneAutomationTriggerSource,
): Promise<TyneAutomationEvent> {
  const { context, repositoryPath, taskId, taskTitle, taskSource, taskUrl, branchName } = ctx;
  const now = new Date().toISOString();
  const eventId = makeEventId('close_task', taskId);
  const settings = getAutomationSettings(context);

  const baseEvent: TyneAutomationEvent = {
    id: eventId,
    taskId,
    taskTitle,
    taskSource,
    taskUrl,
    repositoryPath,
    branchName,
    actionType: 'close_task',
    status: 'pending',
    triggerSource,
    pmTool: taskSource,
    pmTaskId: taskId,
    createdAt: now,
    updatedAt: now,
  };

  if (settings.requireValidationBeforeAutoClose && !ctx.validationResult) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'skipped',
      errorMessage: 'Run validation before closing this task.',
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  if (hasAutoClosedTask(context, taskId)) {
    const existing = getTaskSyncState(context, taskId);
    if (existing?.pmStatus === 'done') {
      const ev: TyneAutomationEvent = {
        ...baseEvent, status: 'skipped',
        errorMessage: 'Task is already marked Done.',
      };
      await saveAutomationEvent(context, ev);
      return ev;
    }
  }

  const adapter = getAdapterForTaskSource(taskSource);
  if (!adapter) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'skipped',
      errorMessage: `Connect your PM tool to automate this task. ${taskSource} is not connected yet.`,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  const prevState = getTaskSyncState(context, taskId);

  try {
    const jiraWorklog = await syncJiraWorklogsIfNeeded(ctx, adapter, taskId);
    const result = await adapter.updateTaskStatus(taskId, 'done');
    if (!result.success) {
      const status: TyneAutomationEvent['status'] = jiraWorklog.synced ? 'partial_success' : 'failed';
      const ev: TyneAutomationEvent = {
        ...baseEvent, status,
        previousPmStatus: result.previousStatus,
        errorMessage: result.errorMessage ?? 'Task status could not be updated.',
        resultMessage: jiraWorklog.message,
        worklogSeconds: jiraWorklog.totalSeconds,
        worklogCount: jiraWorklog.count,
        availableTransitions: result.availableTransitions,
      };
      await saveAutomationEvent(context, ev);
      return ev;
    }

    const now2 = new Date().toISOString();
    await saveTaskSyncState(context, {
      taskId, taskTitle, taskSource, taskUrl, repositoryPath, branchName,
      pmTool: adapter.toolName, pmTaskId: taskId,
      pmStatus: 'done' as TyneNormalizedPmStatus,
      localStatus: 'completed',
      lastSyncedAt: now2, lastPmWriteAt: now2, updatedAt: now2,
    });

    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: 'success',
      previousPmStatus: prevState?.pmStatus ?? result.previousStatus,
      newPmStatus: 'done',
      previousTyneStatus: prevState?.localStatus,
      newTyneStatus: 'completed',
      resultMessage: buildCompletionMessage(taskId, jiraWorklog.label, result.resultMessage),
      worklogSeconds: jiraWorklog.totalSeconds,
      worklogCount: jiraWorklog.count,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  } catch (err) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }
}

export async function resolveTaskTransition(
  ctx: AutomationContext,
  transitionId: string,
  triggerSource: TyneAutomationTriggerSource,
): Promise<TyneAutomationEvent> {
  const { context, repositoryPath, taskId, taskTitle, taskSource, taskUrl, branchName } = ctx;
  const now = new Date().toISOString();
  const adapter = getAdapterForTaskSource(taskSource);
  const baseEvent: TyneAutomationEvent = {
    id: makeEventId('close_task', taskId),
    taskId,
    taskTitle,
    taskSource,
    taskUrl,
    repositoryPath,
    branchName,
    actionType: 'close_task',
    status: 'pending',
    triggerSource,
    pmTool: taskSource,
    pmTaskId: taskId,
    createdAt: now,
    updatedAt: now,
  };
  if (!adapter?.transitionTask) {
    const ev: TyneAutomationEvent = { ...baseEvent, status: 'failed', errorMessage: `${taskSource} does not support custom transitions.` };
    await saveAutomationEvent(context, ev);
    return ev;
  }
  try {
    const result = await adapter.transitionTask(taskId, transitionId);
    if (!result.success) {
      const ev: TyneAutomationEvent = {
        ...baseEvent,
        status: 'failed',
        errorMessage: result.errorMessage ?? 'Could not update Jira transition.',
        availableTransitions: result.availableTransitions,
      };
      await saveAutomationEvent(context, ev);
      return ev;
    }
    const now2 = new Date().toISOString();
    await saveTaskSyncState(context, {
      taskId, taskTitle, taskSource, taskUrl, repositoryPath, branchName,
      pmTool: adapter.toolName, pmTaskId: taskId,
      pmStatus: 'done',
      localStatus: 'completed',
      lastSyncedAt: now2, lastPmWriteAt: now2, updatedAt: now2,
    });
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: 'success',
      newPmStatus: 'done',
      newTyneStatus: 'completed',
      resultMessage: result.resultMessage,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  } catch (err) {
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }
}

export async function postFeedback(
  ctx: AutomationContext,
  triggerSource: TyneAutomationTriggerSource,
  bodyOverride?: string,
): Promise<TyneAutomationEvent> {
  const { context, repositoryPath, taskId, taskTitle, taskSource, taskUrl, branchName, validationResult } = ctx;
  const now = new Date().toISOString();
  const eventId = makeEventId('post_feedback', taskId);
  const settings = getAutomationSettings(context);

  const baseEvent: TyneAutomationEvent = {
    id: eventId,
    taskId, taskTitle, taskSource, taskUrl, repositoryPath, branchName,
    actionType: 'post_feedback',
    status: 'pending',
    triggerSource,
    pmTool: taskSource,
    pmTaskId: taskId,
    createdAt: now, updatedAt: now,
  };

  if (settings.requireValidationBeforeFeedback && !validationResult) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'skipped',
      errorMessage: 'Validation has not been run, so Tyne cannot post validation-based feedback.',
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  let feedback: TyneWorkFeedback;
  try {
    feedback = await buildFeedback(
      context, repositoryPath, taskId, taskTitle, branchName,
      validationResult, settings.requireValidationBeforeFeedback,
    );
  } catch (err) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'failed',
      errorMessage: `Failed to generate feedback: ${err instanceof Error ? err.message : String(err)}`,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  const body = bodyOverride ?? feedback.body;

  const adapter = getAdapterForTaskSource(taskSource);
  if (!adapter) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'skipped',
      errorMessage: `Connect your PM tool to post feedback. ${taskSource} is not connected yet.`,
      messagePreview: body,
      validationStatus: feedback.validationStatus,
      riskLevel: feedback.riskLevel,
      commitHash: feedback.commitHash,
      commitUrl: feedback.commitUrl,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }

  try {
    const result = await adapter.postTaskComment(taskId, body);
    const ev: TyneAutomationEvent = {
      ...baseEvent,
      status: result.success ? 'success' : 'failed',
      pmCommentId: result.commentId,
      pmCommentUrl: result.commentUrl,
      errorMessage: result.success ? undefined : (result.errorMessage ?? 'Could not post feedback. Please check PM tool permissions.'),
      messagePreview: body.slice(0, 200),
      validationStatus: feedback.validationStatus,
      riskLevel: feedback.riskLevel,
      commitHash: feedback.commitHash,
      commitUrl: feedback.commitUrl,
    };
    await saveAutomationEvent(context, ev);
    return ev;
  } catch (err) {
    const ev: TyneAutomationEvent = {
      ...baseEvent, status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      messagePreview: body.slice(0, 200),
    };
    await saveAutomationEvent(context, ev);
    return ev;
  }
}

export async function completeTaskAndPostFeedback(
  ctx: AutomationContext,
  bodyOverride?: string,
): Promise<[TyneAutomationEvent, TyneAutomationEvent]> {
  const feedbackEvent = await postFeedback(ctx, 'task_done', bodyOverride);
  const closeEvent = await markTaskDone(ctx, 'task_done');
  return [feedbackEvent, closeEvent];
}

export async function handleBranchPushed(
  ctx: AutomationContext,
): Promise<TyneAutomationEvent[]> {
  const { context } = ctx;
  const settings = getAutomationSettings(context);
  const results: TyneAutomationEvent[] = [];

  if (settings.autoCloseTrigger === 'on_push' || settings.autoCloseTrigger === 'manual_and_on_push') {
    const closeEvent = await markTaskDone(ctx, 'branch_push');
    results.push(closeEvent);
    if (closeEvent.status === 'success' && settings.autoPostFeedbackAfterClose) {
      const feedbackEvent = await postFeedback(ctx, 'task_done');
      results.push(feedbackEvent);
    }
  }

  if (
    results.length === 0 &&
    settings.autoFeedbackTrigger === 'after_push'
  ) {
    const feedbackEvent = await postFeedback(ctx, 'branch_push');
    results.push(feedbackEvent);
  }

  return results;
}

export async function handleValidationPass(
  ctx: AutomationContext,
): Promise<TyneAutomationEvent | null> {
  const { context } = ctx;
  const settings = getAutomationSettings(context);
  if (settings.autoFeedbackTrigger !== 'after_validation_pass') { return null; }
  if (hasPostedFeedback(context, ctx.taskId)) { return null; }
  return postFeedback(ctx, 'validation_pass');
}

async function syncJiraWorklogsIfNeeded(
  ctx: AutomationContext,
  adapter: ReturnType<typeof getAdapterForTaskSource>,
  taskId: string,
): Promise<{ synced: boolean; count: number; totalSeconds: number; label: string; message?: string }> {
  if (!adapter?.logWorklog || ctx.taskSource.toLowerCase() !== 'jira') {
    return { synced: false, count: 0, totalSeconds: 0, label: '0m' };
  }
  const logs = getUnsyncedTimeLogsForTask(ctx.context, taskId);
  if (!logs.length) {
    return { synced: false, count: 0, totalSeconds: 0, label: '0m', message: 'No unsynced Tyne sessions found for this Jira task.' };
  }
  const worklogIds: string[] = [];
  for (const log of logs) {
    const started = log.startTime || log.createdAt;
    const timeSpentSeconds = Math.max(60, Math.round(log.durationMinutes * 60));
    const result = await adapter.logWorklog(taskId, { started, timeSpentSeconds });
    if (!result.success || !result.worklogId) {
      throw new Error(result.errorMessage || 'Failed to write Jira worklog.');
    }
    worklogIds.push(result.worklogId);
  }
  await markTimeLogsSynced(ctx.context, logs, worklogIds);
  await markCommitSessionsSynced(
    ctx.context,
    ctx.repositoryPath,
    logs.map(log => log.commitSessionId).filter((value): value is string => Boolean(value)),
    worklogIds,
  );
  const summary = getTimeLogSyncSummary(logs);
  return {
    synced: true,
    count: logs.length,
    totalSeconds: summary.totalSeconds,
    label: summary.label,
    message: `Logged ${summary.label} to Jira.`,
  };
}

function buildCompletionMessage(taskId: string, timeLabel: string, fallback?: string): string {
  if (timeLabel && timeLabel !== '0m') {
    return `Logged ${timeLabel} → ${taskId.replace(/^jira:/, '')} closed`;
  }
  return fallback || `${taskId.replace(/^jira:/, '')} closed`;
}

export function hasResolvableTransitions(event: TyneAutomationEvent | null): event is TyneAutomationEvent & { availableTransitions: TynePmTransition[] } {
  return Boolean(event && Array.isArray(event.availableTransitions) && event.availableTransitions.length > 0);
}

export function canAutoCloseOnPush(context: vscode.ExtensionContext): boolean {
  const settings = getAutomationSettings(context);
  return settings.autoCloseTrigger === 'on_push' || settings.autoCloseTrigger === 'manual_and_on_push';
}

export function buildAutomationContextFromBranch(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
  validationResult: TyneValidationResult | null,
): AutomationContext | null {
  const branchRecord = getBranchByName(context, repositoryPath, branchName);
  if (!branchRecord || !branchRecord.taskId) { return null; }
  return {
    context,
    repositoryPath,
    taskId: branchRecord.taskId,
    taskTitle: branchRecord.taskTitle,
    taskSource: branchRecord.taskSource,
    taskUrl: branchRecord.taskUrl,
    branchName,
    validationResult,
  };
}
