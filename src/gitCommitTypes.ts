export interface GitCommitEvent {
  repositoryPath: string;
  branchName: string;
  commitHash: string;
  shortHash: string;
  committedAt: string;
  message?: string;
}

export type GitCommitListener = (event: GitCommitEvent) => void;

export type GitCommitDetectionMode = 'hook' | 'watcher' | 'none';

export interface GitCommitDetectorState {
  mode: GitCommitDetectionMode;
  hookInstalled: boolean;
  hookPath?: string;
  pendingFilePath?: string;
  error?: string;
}
