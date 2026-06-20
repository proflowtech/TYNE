import * as vscode from 'vscode';
import { ValidationResponse } from './validator';

export interface TyneState {
  appName: string;
  taskId: string;
  goal: string;
  status: 'waiting' | 'weaving';
  subtasks: Array<{ id: string; text: string; done: boolean }>;
  validationResult: ValidationResponse | null;
  validationOverride: boolean;
  branchName: string;
  stitchCount: number;
  lastStitchTime: string;
}

const PREFIX = 'tyne.';

export function getState(context: vscode.ExtensionContext): TyneState {
  return {
    appName: context.workspaceState.get<string>(`${PREFIX}appName`, ''),
    taskId: context.workspaceState.get<string>(`${PREFIX}taskId`, ''),
    goal: context.workspaceState.get<string>(`${PREFIX}goal`, ''),
    status: context.workspaceState.get<'waiting' | 'weaving'>(`${PREFIX}status`, 'waiting'),
    subtasks: context.workspaceState.get<TyneState['subtasks']>(`${PREFIX}subtasks`, []),
    validationResult: context.workspaceState.get<ValidationResponse | null>(`${PREFIX}validationResult`, null),
    validationOverride: context.workspaceState.get<boolean>(`${PREFIX}validationOverride`, false),
    branchName: context.workspaceState.get<string>(`${PREFIX}branchName`, ''),
    stitchCount: context.workspaceState.get<number>(`${PREFIX}stitchCount`, 0),
    lastStitchTime: context.workspaceState.get<string>(`${PREFIX}lastStitchTime`, ''),
  };
}

export async function saveState(context: vscode.ExtensionContext, state: TyneState): Promise<void> {
  await Promise.all([
    context.workspaceState.update(`${PREFIX}appName`, state.appName),
    context.workspaceState.update(`${PREFIX}taskId`, state.taskId),
    context.workspaceState.update(`${PREFIX}goal`, state.goal),
    context.workspaceState.update(`${PREFIX}status`, state.status),
    context.workspaceState.update(`${PREFIX}subtasks`, state.subtasks),
    context.workspaceState.update(`${PREFIX}validationResult`, state.validationResult),
    context.workspaceState.update(`${PREFIX}validationOverride`, state.validationOverride),
    context.workspaceState.update(`${PREFIX}branchName`, state.branchName),
    context.workspaceState.update(`${PREFIX}stitchCount`, state.stitchCount),
    context.workspaceState.update(`${PREFIX}lastStitchTime`, state.lastStitchTime),
  ]);
}

export async function clearState(context: vscode.ExtensionContext): Promise<void> {
  const keys = ['appName', 'taskId', 'goal', 'status', 'subtasks', 'validationResult', 'validationOverride', 'branchName', 'stitchCount', 'lastStitchTime'];
  await Promise.all(keys.map(k => context.workspaceState.update(`${PREFIX}${k}`, undefined)));
}
