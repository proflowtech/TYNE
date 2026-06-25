import * as vscode from 'vscode';

const BRANCH_RECORDS_KEY = 'tyne.branchRecords';

export interface BranchRecord {
  taskId: string;
  taskTitle: string;
  taskSource: string;
  taskUrl?: string;
  branchName: string;
  repositoryPath: string;
  createdAt: string;
  lastCheckedOutAt: string;
  currentStatus: 'active' | 'inactive';
  commitCount: number;
  latestCommitHash: string;
  latestCommitMessage: string;
}

function isBranchRecord(value: unknown): value is BranchRecord {
  if (!value || typeof value !== 'object') { return false; }
  const record = value as Record<string, unknown>;
  return typeof record.taskId === 'string'
    && typeof record.taskTitle === 'string'
    && typeof record.taskSource === 'string'
    && typeof record.branchName === 'string'
    && typeof record.repositoryPath === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.lastCheckedOutAt === 'string'
    && (record.currentStatus === 'active' || record.currentStatus === 'inactive')
    && typeof record.commitCount === 'number'
    && typeof record.latestCommitHash === 'string'
    && typeof record.latestCommitMessage === 'string'
    && (record.taskUrl === undefined || typeof record.taskUrl === 'string');
}

function normalizeRecords(value: unknown): BranchRecord[] {
  if (!Array.isArray(value)) { return []; }
  return value.filter(isBranchRecord);
}

async function saveRecords(context: vscode.ExtensionContext, records: BranchRecord[]): Promise<void> {
  await context.workspaceState.update(BRANCH_RECORDS_KEY, records);
}

export function listTyneBranches(
  context: vscode.ExtensionContext,
  repositoryPath?: string,
): BranchRecord[] {
  const records = normalizeRecords(context.workspaceState.get<unknown>(BRANCH_RECORDS_KEY, []));
  if (!repositoryPath) { return records; }
  return records.filter(record => record.repositoryPath === repositoryPath);
}

export function getBranchByTaskId(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
): BranchRecord | undefined {
  return listTyneBranches(context, repositoryPath).find(record => record.taskId === taskId);
}

export function getBranchByName(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
): BranchRecord | undefined {
  return listTyneBranches(context, repositoryPath).find(record => record.branchName === branchName);
}

export async function createBranchRecord(
  context: vscode.ExtensionContext,
  record: BranchRecord,
): Promise<void> {
  const records = listTyneBranches(context);
  const next = records.filter(existing =>
    !(existing.repositoryPath === record.repositoryPath && existing.branchName === record.branchName),
  );
  next.push(record);
  await saveRecords(context, next);
}

export async function updateBranchRecord(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
  patch: Partial<BranchRecord>,
): Promise<BranchRecord | undefined> {
  const records = listTyneBranches(context);
  let updated: BranchRecord | undefined;
  const next = records.map(record => {
    if (record.repositoryPath !== repositoryPath || record.branchName !== branchName) {
      return record;
    }
    updated = { ...record, ...patch };
    return updated;
  });
  if (!updated) { return undefined; }
  await saveRecords(context, next);
  return updated;
}

export async function replaceBranchRecords(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  records: BranchRecord[],
): Promise<void> {
  const others = listTyneBranches(context).filter(record => record.repositoryPath !== repositoryPath);
  await saveRecords(context, [...others, ...records]);
}

export async function deleteBranchRecord(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  branchName: string,
): Promise<void> {
  const next = listTyneBranches(context).filter(record =>
    !(record.repositoryPath === repositoryPath && record.branchName === branchName),
  );
  await saveRecords(context, next);
}
