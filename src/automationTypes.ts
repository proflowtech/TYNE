import type { ComplianceFramework } from './validateReviewTypes';

export type TyneAutoCloseTrigger =
  | 'manual'
  | 'on_push'
  | 'manual_and_on_push'
  | 'disabled';

export type TyneAutoFeedbackTrigger =
  | 'after_validation_pass'
  | 'after_task_done'
  | 'after_commit'
  | 'after_push'
  | 'manual'
  | 'disabled';

export type TyneNormalizedPmStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'canceled'
  | 'unknown';

export type TyneLocalTaskStatus =
  | 'not_started'
  | 'active'
  | 'paused'
  | 'ready_to_complete'
  | 'completed'
  | 'sync_error'
  | 'unknown';

export type TyneValidationStatus =
  | 'pass'
  | 'partial'
  | 'fail'
  | 'not_run';

export type TyneRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'not_assessed';

export type TyneAutomationActionType =
  | 'close_task'
  | 'post_feedback'
  | 'complete_task_and_post_feedback'
  | 'sync_status'
  | 'move_pm_to_in_progress';

export type TyneAutomationStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'partial_success'
  | 'skipped';

export type TyneAutomationTriggerSource =
  | 'manual'
  | 'branch_push'
  | 'commit'
  | 'validation_pass'
  | 'task_done'
  | 'status_refresh'
  | 'branch_switch';

export type TynePlanTier = 'free' | 'pro' | 'max';

export type TyneMaxFeedbackSection =
  | 'validation_stages'
  | 'risk_assessment'
  | 'performance_metrics'
  | 'security_check'
  | 'code_quality'
  | 'recommendations';

export const ALL_MAX_FEEDBACK_SECTIONS: TyneMaxFeedbackSection[] = [
  'validation_stages',
  'risk_assessment',
  'performance_metrics',
  'security_check',
  'code_quality',
  'recommendations',
];

export interface TyneTaskAutomationSettings {
  autoCloseTrigger: TyneAutoCloseTrigger;
  autoFeedbackTrigger: TyneAutoFeedbackTrigger;
  syncPmStatusToTyne: boolean;
  syncTyneStatusToPm: boolean;
  requireValidationBeforeAutoClose: boolean;
  requireValidationBeforeFeedback: boolean;
  autoPostFeedbackAfterClose: boolean;
  autoMovePmToInProgressOnStart: boolean;
  autoCloseOnCommit: boolean;
  complianceChecksEnabled: boolean;
  complianceFrameworks: ComplianceFramework[];
  /** Privacy-first Validate & Review mode (workspaceState only). */
  privacyMode: 'cloud' | 'privacy_enhanced' | 'local_compliance';
  /** Preferred data processing location (Phase 3 enterprise control; stored locally). */
  dataResidency: 'us' | 'eu' | 'local_only' | 'enterprise_managed';
  /** When true, ask edge not to persist evidence snippets. */
  evidencePersistenceDisabled: boolean;
  maxFeedbackSections: TyneMaxFeedbackSection[];
  commitDetectionMode: 'hook' | 'watcher' | 'none';
}

export const DEFAULT_AUTOMATION_SETTINGS: TyneTaskAutomationSettings = {
  autoCloseTrigger: 'manual',
  autoFeedbackTrigger: 'after_commit',
  // Pulling PM status into Tyne is a read, so it is safe to default on.
  syncPmStatusToTyne: true,
  // Writes back to the customer's PM tool (Jira/Linear) are opt-in: never post
  // comments or move tickets on their system of record without explicit consent.
  syncTyneStatusToPm: false,
  requireValidationBeforeAutoClose: false,
  requireValidationBeforeFeedback: false,
  autoPostFeedbackAfterClose: true,
  autoMovePmToInProgressOnStart: false,
  autoCloseOnCommit: false,
  complianceChecksEnabled: false,
  complianceFrameworks: ['HIPAA'],
  privacyMode: 'cloud',
  dataResidency: 'us',
  evidencePersistenceDisabled: false,
  maxFeedbackSections: [...ALL_MAX_FEEDBACK_SECTIONS],
  commitDetectionMode: 'hook',
};

export interface TyneAutomationEvent {
  id: string;
  taskId: string;
  taskTitle?: string;
  taskSource: string;
  taskUrl?: string;
  repositoryPath: string;
  branchName?: string;
  actionType: TyneAutomationActionType;
  status: TyneAutomationStatus;
  triggerSource: TyneAutomationTriggerSource;
  pmTool: string;
  pmTaskId: string;
  pmCommentId?: string;
  pmCommentUrl?: string;
  previousPmStatus?: TyneNormalizedPmStatus;
  newPmStatus?: TyneNormalizedPmStatus;
  previousTyneStatus?: TyneLocalTaskStatus;
  newTyneStatus?: TyneLocalTaskStatus;
  validationStatus?: TyneValidationStatus;
  riskLevel?: TyneRiskLevel;
  commitHash?: string;
  commitUrl?: string;
  resultMessage?: string;
  worklogSeconds?: number;
  worklogCount?: number;
  availableTransitions?: TynePmTransition[];
  messagePreview?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TyneTaskSyncState {
  taskId: string;
  taskTitle?: string;
  taskSource: string;
  taskUrl?: string;
  repositoryPath: string;
  branchName?: string;
  pmTool: string;
  pmTaskId: string;
  pmStatus: TyneNormalizedPmStatus;
  localStatus: TyneLocalTaskStatus;
  lastSyncedAt?: string;
  lastPmWriteAt?: string;
  lastTyneStatusWriteAt?: string;
  syncError?: string;
  updatedAt: string;
}

export interface TyneWorkFeedback {
  taskId: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  validationStatus: TyneValidationStatus;
  riskLevel: TyneRiskLevel;
  matchPercent?: number;
  missingRequirementsCount?: number;
  generatedAt: string;
  body: string;
  evidenceHtml?: string;
}

export interface TyneTaskStatusConflict {
  taskId: string;
  pmStatus: TyneNormalizedPmStatus;
  localStatus: TyneLocalTaskStatus;
  detectedAt: string;
}

export interface TynePmTask {
  id: string;
  title: string;
  status: string;
  url?: string;
  source: string;
}

export interface TynePmStatusUpdateResult {
  success: boolean;
  taskId: string;
  previousStatus?: TyneNormalizedPmStatus;
  newStatus?: TyneNormalizedPmStatus;
  externalStatusName?: string;
  availableTransitions?: TynePmTransition[];
  resultMessage?: string;
  errorMessage?: string;
}

export interface TynePmCommentResult {
  success: boolean;
  taskId: string;
  commentId?: string;
  commentUrl?: string;
  errorMessage?: string;
}

export interface TynePmVisibleTyneStatus {
  localStatus: TyneLocalTaskStatus;
  branchName?: string;
  latestCommitHash?: string;
  latestCommitUrl?: string;
  lastSyncedAt: string;
}

export interface TynePmStatusWriteResult {
  success: boolean;
  taskId: string;
  errorMessage?: string;
}

export interface TynePmTransition {
  id: string;
  name: string;
  toStatus?: string;
}

export interface TynePmWorklogInput {
  started: string;
  timeSpentSeconds: number;
}

export interface TynePmWorklogResult {
  success: boolean;
  taskId: string;
  worklogId?: string;
  errorMessage?: string;
}

export interface TyneLinkedTask {
  taskId: string;
  taskTitle?: string;
  taskSource: string;
  taskUrl?: string;
  pmTaskId: string;
  pmTool: string;
}
