import * as vscode from 'vscode';
import { getGit, getCurrentBranch } from './gitManager';
import {
  ReviewScope,
  LastEditedCodeContext,
  ChangedFileInfo,
  ReviewFileStatus,
} from './validateReviewTypes';
import { parseNumstat, mergeNumstat } from './numstat';

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
  const numstat = await git.raw(['diff', '--cached', '--numstat']).catch(() => '');
  return {
    scope: 'staged_changes',
    currentBranch,
    changedFiles: mergeNumstat(changedFiles, parseNumstat(numstat)),
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
  const numstat = await git.raw(['diff', '--numstat']).catch(() => '');
  return {
    scope: 'unstaged_changes',
    currentBranch,
    changedFiles: mergeNumstat(changedFiles, parseNumstat(numstat)),
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

  // `show --numstat` also covers the root commit, where `sha^` would not resolve.
  const numstat = await git.show(['--format=', '--numstat', headSha]).catch(() => '');

  return {
    scope: 'last_commit',
    headSha,
    currentBranch,
    changedFiles: mergeNumstat(changedFiles, parseNumstat(numstat)),
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

  const numstat = await git.show(['--format=', '--numstat', commitSha]).catch(() => '');

  return {
    scope: 'selected_commit',
    headSha: commitSha,
    currentBranch,
    changedFiles: mergeNumstat(changedFiles, parseNumstat(numstat)),
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

