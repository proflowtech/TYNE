import { TyneCommitRecord, TyneCommitSession } from './commitTypes';

export function calculateSessionDuration(session: TyneCommitSession): number {
  const start = new Date(session.startTime).getTime();
  const end = new Date(session.endTime).getTime();
  return Math.max(1, Math.round((end - start) / 60000));
}

export function clusterCommits(
  commits: TyneCommitRecord[],
  gapMinutes = 30,
): TyneCommitSession[] {
  const sorted = [...commits].sort((a, b) =>
    new Date(a.committedAt).getTime() - new Date(b.committedAt).getTime(),
  );
  const sessions: TyneCommitSession[] = [];
  let current: TyneCommitSession | null = null;
  let lastCommitTime = 0;

  for (const commit of sorted) {
    const commitTime = new Date(commit.committedAt).getTime();
    const shouldStartNew = !current || ((commitTime - lastCommitTime) / 60000) > gapMinutes;

    if (shouldStartNew) {
      if (current) {
        current.durationMinutes = calculateSessionDuration(current);
        sessions.push(current);
      }
      current = {
        id: `${commit.branchName}:${commit.commitHash}`,
        repositoryPath: commit.repositoryPath,
        branchName: commit.branchName,
        taskId: commit.taskId,
        taskTitle: commit.taskTitle,
        taskSource: commit.taskSource,
        startTime: commit.committedAt,
        endTime: commit.committedAt,
        durationMinutes: 1,
        commitCount: 0,
        commitHashes: [],
        totalFilesChanged: 0,
        totalLinesAdded: 0,
        totalLinesDeleted: 0,
        createdAt: commit.createdAt,
        updatedAt: commit.updatedAt,
      };
    }

    if (!current) { continue; }
    current.commitCount += 1;
    current.commitHashes.push(commit.commitHash);
    current.endTime = commit.committedAt;
    current.updatedAt = commit.updatedAt;
    current.totalFilesChanged += commit.totalFilesChanged;
    current.totalLinesAdded += commit.totalLinesAdded;
    current.totalLinesDeleted += commit.totalLinesDeleted;
    lastCommitTime = commitTime;
  }

  if (current) {
    current.durationMinutes = calculateSessionDuration(current);
    sessions.push(current);
  }

  return sessions;
}
