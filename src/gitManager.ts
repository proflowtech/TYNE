import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';

export function getGit(): SimpleGit | null {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) { return null; }
  return simpleGit(workspaceRoot);
}

export function sanitizeBranchName(taskId: string, goal: string): string {
  const sanitizedGoal = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'goal';
  const sanitizedTaskId = taskId.toLowerCase().replace(/[^a-z0-9-]/g, '') || 'task';
  return `tyne/${sanitizedTaskId}-${sanitizedGoal}`;
}

export async function createBranch(branchName: string): Promise<void> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  await git.checkoutLocalBranch(branchName);
}

export async function isGitRepo(): Promise<boolean> {
  try {
    const git = getGit();
    if (!git) { return false; }
    await git.status();
    return true;
  } catch {
    return false;
  }
}

const STITCH_SIGNATURE = '🔗 Tyne stitch:';

export async function saveStitch(taskId: string): Promise<string> {
  const git = getGit();
  if (!git) { throw new Error('No git repo'); }

  const status = await git.status();
  if (!status.current?.startsWith('tyne/')) {
    throw new Error('Not on a Tyne branch. Start a thread first.');
  }

  if (status.files.length === 0) {
    throw new Error('No changes to stitch. Make some edits first.');
  }

  await git.add('.');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const message = `${STITCH_SIGNATURE} [${taskId}] @ ${timestamp}`;
  const result = await git.commit(message);
  return result.commit;
}

export async function hasStitch(): Promise<boolean> {
  const git = getGit();
  if (!git) { return false; }
  try {
    const log = await git.log({ maxCount: 10 });
    return log.all.some(c => c.message.startsWith(STITCH_SIGNATURE));
  } catch { return false; }
}

export async function undoStitch(): Promise<void> {
  const git = getGit();
  if (!git) { throw new Error('No git repo'); }

  const log = await git.log({ maxCount: 1 });
  const lastCommit = log.latest;
  if (!lastCommit?.message.startsWith(STITCH_SIGNATURE)) {
    throw new Error('Last commit is not a Tyne stitch. Undo blocked for safety.');
  }

  await git.reset(['--hard', 'HEAD~1']);
}

export interface KnotResult {
  branch: string;
  pushed: boolean;
}

export async function tieTheKnot(
  taskId: string,
  commitSubjectOrGoal: string,
  commitBody = '',
): Promise<KnotResult> {
  const git = getGit();
  if (!git) { throw new Error('No git repo'); }

  // Stage any remaining uncommitted changes
  const status = await git.status();
  if (status.files.length > 0) {
    await git.add('.');
  }

  // Semantic commit message
  const scope = taskId ? `(${taskId.toLowerCase()})` : '';
  const subject = /^(feat|fix|refactor|chore|docs|test)(\([^)]+\))?:\s/i.test(commitSubjectOrGoal)
    ? commitSubjectOrGoal
    : `feat${scope}: ${commitSubjectOrGoal}`;
  const message = commitBody ? `${subject}\n\n${commitBody}` : subject;

  // Only commit if there's something to commit
  const freshStatus = await git.status();
  if (freshStatus.files.length > 0 || freshStatus.staged.length > 0) {
    await git.commit(message);
  }

  const currentBranch = (await git.status()).current || '';

  // Push to remote, with graceful fallback for no-remote and conflict cases
  let pushed = false;
  try {
    await git.push(['--set-upstream', 'origin', currentBranch]);
    pushed = true;
  } catch (firstErr: unknown) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (msg.includes('remote') || msg.includes('does not appear') || msg.includes('Repository')) {
      // No remote configured — commit stays local
      pushed = false;
    } else {
      // Likely a non-fast-forward conflict — retry with --force-with-lease
      try {
        await git.push(['--force-with-lease', '--set-upstream', 'origin', currentBranch]);
        pushed = true;
      } catch {
        throw new Error(
          `Push failed. Resolve manually with: git push --force-with-lease origin ${currentBranch}`
        );
      }
    }
  }

  return { branch: currentBranch, pushed };
}
