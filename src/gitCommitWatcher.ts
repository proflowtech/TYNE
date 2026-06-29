import * as vscode from 'vscode';
import * as fs from 'fs';
import { getGit, getCurrentBranch, getLatestCommit } from './gitManager';
import { GitCommitEvent, GitCommitListener } from './gitCommitTypes';
import { getDetectorState, installPostCommitHook } from './gitHookService';

const POLL_INTERVAL_MS = 10_000;
const RECENT_COMMIT_WINDOW_MS = 60_000;

const lastSeenByRepo = new Map<string, string>();
let watcherDisposables: vscode.Disposable[] = [];

function parsePendingFile(filePath: string): GitCommitEvent | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) { return null; }
    const parsed = JSON.parse(raw) as Partial<GitCommitEvent>;
    if (!parsed.repositoryPath || !parsed.commitHash || !parsed.branchName) { return null; }
    return {
      repositoryPath: parsed.repositoryPath,
      branchName: parsed.branchName,
      commitHash: parsed.commitHash,
      shortHash: parsed.shortHash || parsed.commitHash.slice(0, 8),
      committedAt: parsed.committedAt || new Date().toISOString(),
      message: parsed.message,
    };
  } catch {
    return null;
  }
}

function emitIfNew(event: GitCommitEvent, listener: GitCommitListener): void {
  const key = `${event.repositoryPath}:${event.branchName}`;
  const previous = lastSeenByRepo.get(key);
  if (previous === event.commitHash) { return; }
  lastSeenByRepo.set(key, event.commitHash);
  listener(event);
}

async function pollLatestCommit(listener: GitCommitListener): Promise<void> {
  try {
    const git = getGit();
    if (!git) { return; }
    const repoPath = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    const branchName = await getCurrentBranch();
    if (!repoPath || !branchName) { return; }

    const latest = await getLatestCommit(branchName);
    if (!latest.hash) { return; }

    const key = `${repoPath}:${branchName}`;
    if (lastSeenByRepo.get(key) === latest.hash) { return; }

    const logRaw = await git.raw(['log', '-1', '--format=%cd', '--date=iso-strict', branchName]).catch(() => '');
    const committedAt = logRaw.trim() || new Date().toISOString();

    const event: GitCommitEvent = {
      repositoryPath: repoPath,
      branchName,
      commitHash: latest.hash,
      shortHash: latest.hash.slice(0, 8),
      committedAt,
      message: latest.message,
    };
    emitIfNew(event, listener);
  } catch {
    // Polling is best-effort; do not spam the user.
  }
}

async function handlePendingFile(
  filePath: string,
  listener: GitCommitListener,
): Promise<void> {
  const event = parsePendingFile(filePath);
  if (!event) { return; }
  emitIfNew(event, listener);
}

export async function startGitCommitWatcher(
  context: vscode.ExtensionContext,
  listener: GitCommitListener,
): Promise<vscode.Disposable> {
  stopGitCommitWatcher();

  let state = await getDetectorState(context);
  if (!state.hookInstalled) {
    state = await installPostCommitHook(context);
  }

  // If hook is installed, watch the pending file for instant notifications.
  if (state.hookInstalled && state.pendingFilePath) {
    const pendingUri = vscode.Uri.file(state.pendingFilePath);
    const watcher = vscode.workspace.createFileSystemWatcher(pendingUri.fsPath, false, false, false);
    watcher.onDidChange(() => void handlePendingFile(state.pendingFilePath!, listener));
    watcher.onDidCreate(() => void handlePendingFile(state.pendingFilePath!, listener));

    // Process any pending commit from before activation.
    await handlePendingFile(state.pendingFilePath, listener);

    watcherDisposables.push(watcher);
  }

  // Always run a lightweight poll as a safety net and to catch commits when the hook
  // was not installed or failed to notify the extension.
  const pollTimer = setInterval(() => void pollLatestCommit(listener), POLL_INTERVAL_MS);
  watcherDisposables.push({ dispose: () => clearInterval(pollTimer) });

  // Initial poll to set the baseline without emitting an event.
  try {
    const git = getGit();
    if (git) {
      const repoPath = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
      const branchName = await getCurrentBranch();
      if (repoPath && branchName) {
        const latest = await getLatestCommit(branchName);
        if (latest.hash) {
          lastSeenByRepo.set(`${repoPath}:${branchName}`, latest.hash);
        }
      }
    }
  } catch {
    // Baseline is best-effort.
  }

  return {
    dispose: () => stopGitCommitWatcher(),
  };
}

export function stopGitCommitWatcher(): void {
  for (const d of watcherDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  watcherDisposables = [];
}

export function isRecentCommit(event: GitCommitEvent): boolean {
  try {
    const committedAt = new Date(event.committedAt).getTime();
    return Date.now() - committedAt < RECENT_COMMIT_WINDOW_MS;
  } catch {
    return true;
  }
}
