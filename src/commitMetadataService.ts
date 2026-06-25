import * as vscode from 'vscode';
import { TyneCommitRecord, TyneCommitSession } from './commitTypes';

const COMMITS_KEY = 'tyne.commitRecords';
const SESSIONS_KEY = 'tyne.commitSessions';

function normalizeCommits(value: unknown): TyneCommitRecord[] {
  return Array.isArray(value) ? value as TyneCommitRecord[] : [];
}

function normalizeSessions(value: unknown): TyneCommitSession[] {
  return Array.isArray(value) ? value as TyneCommitSession[] : [];
}

export function listCommitRecords(
  context: vscode.ExtensionContext,
  repositoryPath?: string,
): TyneCommitRecord[] {
  const records = normalizeCommits(context.workspaceState.get<unknown>(COMMITS_KEY, []));
  return repositoryPath ? records.filter(record => record.repositoryPath === repositoryPath) : records;
}

export function listCommitSessions(
  context: vscode.ExtensionContext,
  repositoryPath?: string,
): TyneCommitSession[] {
  const sessions = normalizeSessions(context.workspaceState.get<unknown>(SESSIONS_KEY, []));
  return repositoryPath ? sessions.filter(session => session.repositoryPath === repositoryPath) : sessions;
}

export async function replaceCommitRecords(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  records: TyneCommitRecord[],
): Promise<void> {
  const others = listCommitRecords(context).filter(record => record.repositoryPath !== repositoryPath);
  await context.workspaceState.update(COMMITS_KEY, [...others, ...records]);
}

export async function replaceCommitSessions(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  sessions: TyneCommitSession[],
): Promise<void> {
  const others = listCommitSessions(context).filter(session => session.repositoryPath !== repositoryPath);
  await context.workspaceState.update(SESSIONS_KEY, [...others, ...sessions]);
}

export function listCommitsForBranch(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
): TyneCommitRecord[] {
  return listCommitRecords(context, repositoryPath).filter(record => record.branchName === branchName);
}

export function listSessionsForBranch(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
): TyneCommitSession[] {
  return listCommitSessions(context, repositoryPath).filter(session => session.branchName === branchName);
}
