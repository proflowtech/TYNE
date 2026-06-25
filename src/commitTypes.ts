export type CommitChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TyneCommitFileChange {
  filePath: string;
  changeType: CommitChangeType;
  linesAdded: number;
  linesDeleted: number;
  previousPath?: string;
}

export interface TyneCommitRecord {
  id: string;
  repositoryPath: string;
  branchName: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  commitHash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail?: string;
  committedAt: string;
  filesChanged: TyneCommitFileChange[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  sessionId?: string;
  linkedStatus: 'linked' | 'partial' | 'unlinked';
  createdAt: string;
  updatedAt: string;
}

export interface TyneCommitSession {
  id: string;
  repositoryPath: string;
  branchName: string;
  taskId?: string;
  taskTitle?: string;
  taskSource?: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  commitCount: number;
  commitHashes: string[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  createdAt: string;
  updatedAt: string;
}
