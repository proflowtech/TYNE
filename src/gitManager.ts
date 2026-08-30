import simpleGit, { SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import { parseBlamePorcelain, type PriorLineCommit } from './quality/priorContext';

export type { PriorLineCommit } from './quality/priorContext';

export function getGit(): SimpleGit | null {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) { return null; }
  return simpleGit(workspaceRoot);
}

/**
 * Commits that last touched a line range, read from HEAD rather than the
 * working tree — so a range covered by the diff under review always
 * resolves to genuinely prior history, not the uncommitted change itself.
 *
 * Best-effort, not exact: the line numbers come from the new-file side of the
 * diff, so if the file has shifted significantly since HEAD the blamed range
 * may land a few lines off. That's an acceptable trade for advisory context —
 * this feeds LLM prompt prose, never a deterministic finding, so an
 * approximate "this area's history" beats none at all.
 */
export async function getLineHistory(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<PriorLineCommit[]> {
  const git = getGit();
  if (!git || startLine < 1 || endLine < startLine) { return []; }
  try {
    const raw = await git.raw(['blame', 'HEAD', '-L', `${startLine},${endLine}`, '--porcelain', '--', filePath]);
    return parseBlamePorcelain(raw);
  } catch {
    // New file (no HEAD history), rename, binary, or blame unsupported here —
    // all mean "no prior context available", never a hard failure.
    return [];
  }
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

export interface LatestCommitInfo {
  hash: string;
  message: string;
}

export interface WorkingTreeStatus {
  currentBranch: string;
  isClean: boolean;
  changedFiles: number;
}

export interface DetailedGitStatus {
  currentBranch: string;
  stagedFiles: number;
  unstagedFiles: number;
  isClean: boolean;
}

export async function createBranch(branchName: string): Promise<void> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  await git.checkoutLocalBranch(branchName);
}

export async function branchExists(branchName: string): Promise<boolean> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const branches = await git.branchLocal();
  return branches.all.includes(branchName);
}

export async function checkoutBranch(branchName: string): Promise<void> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  await git.checkout(branchName);
}

export async function getCurrentBranch(): Promise<string> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const status = await git.status();
  return status.current || '';
}

export async function getWorkingTreeStatus(): Promise<WorkingTreeStatus> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const status = await git.status();
  return {
    currentBranch: status.current || '',
    isClean: status.files.length === 0,
    changedFiles: status.files.length,
  };
}

export async function getDetailedGitStatus(): Promise<DetailedGitStatus> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const status = await git.status();
  const stagedFiles = status.files.filter(f => f.index !== ' ' && f.index !== '?' && f.index !== '').length;
  const unstagedFiles = status.files.filter(f => f.working_dir !== ' ' && f.working_dir !== '?' && f.working_dir !== '').length;
  return {
    currentBranch: status.current || '',
    stagedFiles,
    unstagedFiles,
    isClean: status.files.length === 0,
  };
}

export async function getCommitCount(branchName: string): Promise<number> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  try {
    const raw = await git.raw(['rev-list', '--count', branchName]);
    return Number(raw.trim() || '0');
  } catch {
    return 0;
  }
}

export async function getLatestCommit(branchName: string): Promise<LatestCommitInfo> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  try {
    const raw = await git.raw(['log', '-1', '--format=%H%n%s', branchName]);
    const [hash = '', message = ''] = raw.trim().split('\n');
    return { hash, message };
  } catch {
    return { hash: '', message: '' };
  }
}

export async function deleteLocalBranch(branchName: string, force = false): Promise<void> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  await git.deleteLocalBranch(branchName, force);
}

export async function isBranchMerged(branchName: string): Promise<boolean> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const raw = await git.raw(['branch', '--merged']);
  return raw
    .split('\n')
    .map(line => line.replace(/^\*\s*/, '').trim())
    .includes(branchName);
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
