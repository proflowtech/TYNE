import { BranchRecord } from './branchMetadataService';
import { TyneCommitRecord } from './commitTypes';

export function extractTaskIdFromBranch(branchName: string): string | null {
  const match = branchName.match(/^tyne\/([A-Za-z0-9]+-\d+)(?:-|$)/);
  return match ? match[1].toUpperCase() : null;
}

export function linkCommitToTask(
  commit: TyneCommitRecord,
  branchRecord?: BranchRecord,
): TyneCommitRecord {
  if (branchRecord) {
    return {
      ...commit,
      taskId: branchRecord.taskId,
      taskTitle: branchRecord.taskTitle,
      taskSource: branchRecord.taskSource,
      linkedStatus: 'linked',
    };
  }

  const extractedTaskId = extractTaskIdFromBranch(commit.branchName);
  if (extractedTaskId) {
    return {
      ...commit,
      taskId: extractedTaskId,
      linkedStatus: 'partial',
    };
  }

  return {
    ...commit,
    linkedStatus: 'unlinked',
  };
}
