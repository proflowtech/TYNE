import * as vscode from 'vscode';
import { getGit, getCurrentBranch } from './gitManager';
import {
  ReviewScope,
  LastEditedCodeContext,
  ChangedFileInfo,
  ReviewFileStatus,
} from './validateReviewTypes';

const IGNORE_PATHS = /\/(node_modules|dist|build|out|\.next|coverage|\.git)\//;

// ── ReviewScopeResolver ──────────────────────────────────────────────────────
// Determines which scope to review based on git state.
// Priority: staged > unstaged > last_commit. Never reviews full repo.

export async function resolveReviewScope(): Promise<ReviewScope> {
  const git = getGit();
  if (!git) { throw new Error('No git repository found.'); }

  const status = await git.status();
  const hasStaged = status.files.some(f => f.index !== ' ' && f.index !== '?' && f.index !== '');
  if (hasStaged) { return 'staged_changes'; }

  const hasUnstaged = status.files.some(f => f.working_dir !== ' ' && f.working_dir !== '?' && f.working_dir !== '');
  if (hasUnstaged) { return 'unstaged_changes'; }

  return 'last_commit';
}

// ── LastEditedCodeCollector ──────────────────────────────────────────────────
// Collects the diff and changed files for the resolved scope.

export async function collectLastEditedCode(scope?: ReviewScope, selectedCommitSha?: string): Promise<LastEditedCodeContext | undefined> {
  const git = getGit();
  if (!git) { return undefined; }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }

  const resolvedScope = scope || await resolveReviewScope();
  const currentBranch = await getCurrentBranch().catch(() => '');

  if (resolvedScope === 'staged_changes') {
    return collectStagedChanges(git, currentBranch);
  }
  if (resolvedScope === 'unstaged_changes') {
    return collectUnstagedChanges(git, currentBranch);
  }
  if (resolvedScope === 'last_commit') {
    return collectLastCommit(git, currentBranch);
  }
  if (resolvedScope === 'selected_commit' && selectedCommitSha) {
    return collectSelectedCommit(git, currentBranch, selectedCommitSha);
  }
  return collectStagedChanges(git, currentBranch);
}

async function collectStagedChanges(git: NonNullable<ReturnType<typeof getGit>>, currentBranch: string): Promise<LastEditedCodeContext> {
  const status = await git.status();
  const changedFiles = status.files
    .filter(f => f.index !== ' ' && f.index !== '?' && f.index !== '')
    .map(f => parseFileStatus(f))
    .filter(f => !IGNORE_PATHS.test('/' + f.path));

  const diff = await git.diff(['--cached']).catch(() => '');
  return {
    scope: 'staged_changes',
    currentBranch,
    changedFiles,
    diff,
  };
}

async function collectUnstagedChanges(git: NonNullable<ReturnType<typeof getGit>>, currentBranch: string): Promise<LastEditedCodeContext> {
  const status = await git.status();
  const changedFiles = status.files
    .filter(f => f.working_dir !== ' ' && f.working_dir !== '?' && f.working_dir !== '')
    .map(f => parseFileStatus(f))
    .filter(f => !IGNORE_PATHS.test('/' + f.path));

  const diff = await git.diff().catch(() => '');
  return {
    scope: 'unstaged_changes',
    currentBranch,
    changedFiles,
    diff,
  };
}

async function collectLastCommit(git: NonNullable<ReturnType<typeof getGit>>, currentBranch: string): Promise<LastEditedCodeContext> {
  const log = await git.log({ maxCount: 1 }).catch(() => null);
  const headSha = log?.latest?.hash || '';
  if (!headSha) {
    return { scope: 'last_commit', currentBranch, changedFiles: [], diff: '' };
  }

  const diff = await git.show(['--format=', '--patch', headSha]).catch(() => '');
  const nameOnly = await git.show(['--format=', '--name-only', headSha]).catch(() => '');
  const changedFiles: ChangedFileInfo[] = nameOnly
    .split('\n')
    .map(p => p.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter(p => !IGNORE_PATHS.test('/' + p))
    .map(p => ({ path: p, status: 'modified' as ReviewFileStatus, additions: 0, deletions: 0 }));

  const statRaw = await git.show(['--format=', '--stat', headSha]).catch(() => '');
  const additions = countStat(statRaw, '+');
  const deletions = countStat(statRaw, '-');
  changedFiles.forEach((f, i) => {
    f.additions = additions[i] || 0;
    f.deletions = deletions[i] || 0;
  });

  return {
    scope: 'last_commit',
    headSha,
    currentBranch,
    changedFiles,
    diff,
  };
}

async function collectSelectedCommit(git: NonNullable<ReturnType<typeof getGit>>, currentBranch: string, commitSha: string): Promise<LastEditedCodeContext> {
  const diff = await git.show(['--format=', '--patch', commitSha]).catch(() => '');
  const nameOnly = await git.show(['--format=', '--name-only', commitSha]).catch(() => '');
  const changedFiles: ChangedFileInfo[] = nameOnly
    .split('\n')
    .map(p => p.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter(p => !IGNORE_PATHS.test('/' + p))
    .map(p => ({ path: p, status: 'modified' as ReviewFileStatus, additions: 0, deletions: 0 }));

  const statRaw = await git.show(['--format=', '--stat', commitSha]).catch(() => '');
  const additions = countStat(statRaw, '+');
  const deletions = countStat(statRaw, '-');
  changedFiles.forEach((f, i) => {
    f.additions = additions[i] || 0;
    f.deletions = deletions[i] || 0;
  });

  return {
    scope: 'selected_commit',
    headSha: commitSha,
    currentBranch,
    changedFiles,
    diff,
  };
}

function parseFileStatus(f: { path: string; index: string; working_dir: string; x?: string; y?: string }): ChangedFileInfo {
  const filePath = f.path.replace(/\\/g, '/');
  const code = f.index !== ' ' ? f.index : f.working_dir;
  let status: ReviewFileStatus = 'modified';
  if (code === 'A') { status = 'added'; }
  else if (code === 'D') { status = 'deleted'; }
  else if (code === 'R') { status = 'renamed'; }
  return { path: filePath, status, additions: 0, deletions: 0 };
}

function countStat(statRaw: string, sign: '+' | '-'): number[] {
  const lines = statRaw.split('\n');
  const counts: number[] = [];
  for (const line of lines) {
    const match = line.match(/(\d+) insertion/);
    if (sign === '+' && match) { counts.push(Number(match[1])); continue; }
    const delMatch = line.match(/(\d+) deletion/);
    if (sign === '-' && delMatch) { counts.push(Number(delMatch[1])); continue; }
    if (sign === '+') { counts.push(0); }
  }
  return counts;
}
