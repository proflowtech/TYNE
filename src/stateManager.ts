import * as vscode from 'vscode';
import { TyneValidationResult } from './validationTypes';
import { TyneEnrichmentStatus, TynePmTaskIntelligence, TynePmTaskValidationResult } from './taskTypes';
import { TyneValidateReviewResult } from './validateReviewTypes';

export interface TyneState {
  appName: string;
  taskId: string;
  taskTitle: string;
  taskSource: string;
  taskUrl: string;
  goal: string;
  status: 'waiting' | 'weaving';
  subtasks: Array<{ id: string; text: string; done: boolean }>;
  validationResult: TyneValidationResult | null;
  validationOverride: boolean;
  branchName: string;
  stitchCount: number;
  lastStitchTime: string;
  pmTaskContext: TynePmTaskIntelligence | null;
  pmTaskValidationResult: TynePmTaskValidationResult | null;
  validateReviewResult: TyneValidateReviewResult | null;
  latestValidateReviewReportId: string;
  pmEnrichmentStatus: TyneEnrichmentStatus;
  pmEnrichmentError: string;
  acceptanceCriteria: string[];
  proofPointTemplates: string[];
  validationSteps: string[];
}

const PREFIX = 'tyne.';

export function getState(context: vscode.ExtensionContext): TyneState {
  return {
    appName: context.workspaceState.get<string>(`${PREFIX}appName`, ''),
    taskId: context.workspaceState.get<string>(`${PREFIX}taskId`, ''),
    taskTitle: context.workspaceState.get<string>(`${PREFIX}taskTitle`, ''),
    taskSource: context.workspaceState.get<string>(`${PREFIX}taskSource`, 'Solo Mode'),
    taskUrl: context.workspaceState.get<string>(`${PREFIX}taskUrl`, ''),
    goal: context.workspaceState.get<string>(`${PREFIX}goal`, ''),
    status: context.workspaceState.get<'waiting' | 'weaving'>(`${PREFIX}status`, 'waiting'),
    subtasks: context.workspaceState.get<TyneState['subtasks']>(`${PREFIX}subtasks`, []),
    validationResult: context.workspaceState.get<TyneValidationResult | null>(`${PREFIX}validationResult`, null),
    validationOverride: context.workspaceState.get<boolean>(`${PREFIX}validationOverride`, false),
    branchName: context.workspaceState.get<string>(`${PREFIX}branchName`, ''),
    stitchCount: context.workspaceState.get<number>(`${PREFIX}stitchCount`, 0),
    lastStitchTime: context.workspaceState.get<string>(`${PREFIX}lastStitchTime`, ''),
    pmTaskContext: context.workspaceState.get<TynePmTaskIntelligence | null>(`${PREFIX}pmTaskContext`, null),
    pmTaskValidationResult: context.workspaceState.get<TynePmTaskValidationResult | null>(`${PREFIX}pmTaskValidationResult`, null),
    validateReviewResult: context.workspaceState.get<TyneValidateReviewResult | null>(`${PREFIX}validateReviewResult`, null),
    latestValidateReviewReportId: context.workspaceState.get<string>(`${PREFIX}latestValidateReviewReportId`, ''),
    pmEnrichmentStatus: context.workspaceState.get<TyneEnrichmentStatus>(`${PREFIX}pmEnrichmentStatus`, 'skipped'),
    pmEnrichmentError: context.workspaceState.get<string>(`${PREFIX}pmEnrichmentError`, ''),
    acceptanceCriteria: context.workspaceState.get<string[]>(`${PREFIX}acceptanceCriteria`, []),
    proofPointTemplates: context.workspaceState.get<string[]>(`${PREFIX}proofPointTemplates`, []),
    validationSteps: context.workspaceState.get<string[]>(`${PREFIX}validationSteps`, []),
  };
}

export async function saveState(context: vscode.ExtensionContext, state: TyneState): Promise<void> {
  await Promise.all([
    context.workspaceState.update(`${PREFIX}appName`, state.appName),
    context.workspaceState.update(`${PREFIX}taskId`, state.taskId),
    context.workspaceState.update(`${PREFIX}taskTitle`, state.taskTitle),
    context.workspaceState.update(`${PREFIX}taskSource`, state.taskSource),
    context.workspaceState.update(`${PREFIX}taskUrl`, state.taskUrl),
    context.workspaceState.update(`${PREFIX}goal`, state.goal),
    context.workspaceState.update(`${PREFIX}status`, state.status),
    context.workspaceState.update(`${PREFIX}subtasks`, state.subtasks),
    context.workspaceState.update(`${PREFIX}validationResult`, state.validationResult),
    context.workspaceState.update(`${PREFIX}validationOverride`, state.validationOverride),
    context.workspaceState.update(`${PREFIX}branchName`, state.branchName),
    context.workspaceState.update(`${PREFIX}stitchCount`, state.stitchCount),
    context.workspaceState.update(`${PREFIX}lastStitchTime`, state.lastStitchTime),
    context.workspaceState.update(`${PREFIX}pmTaskContext`, state.pmTaskContext),
    context.workspaceState.update(`${PREFIX}pmTaskValidationResult`, state.pmTaskValidationResult),
    context.workspaceState.update(`${PREFIX}validateReviewResult`, state.validateReviewResult),
    context.workspaceState.update(`${PREFIX}latestValidateReviewReportId`, state.latestValidateReviewReportId),
    context.workspaceState.update(`${PREFIX}pmEnrichmentStatus`, state.pmEnrichmentStatus),
    context.workspaceState.update(`${PREFIX}pmEnrichmentError`, state.pmEnrichmentError),
    context.workspaceState.update(`${PREFIX}acceptanceCriteria`, state.acceptanceCriteria),
    context.workspaceState.update(`${PREFIX}proofPointTemplates`, state.proofPointTemplates),
    context.workspaceState.update(`${PREFIX}validationSteps`, state.validationSteps),
  ]);
}

export async function clearState(context: vscode.ExtensionContext): Promise<void> {
  const keys = ['appName', 'taskId', 'taskTitle', 'taskSource', 'taskUrl', 'goal', 'status', 'subtasks', 'validationResult', 'validationOverride', 'branchName', 'stitchCount', 'lastStitchTime', 'pmTaskContext', 'pmTaskValidationResult', 'validateReviewResult', 'latestValidateReviewReportId', 'pmEnrichmentStatus', 'pmEnrichmentError', 'acceptanceCriteria', 'proofPointTemplates', 'validationSteps'];
  await Promise.all(keys.map(k => context.workspaceState.update(`${PREFIX}${k}`, undefined)));
}
