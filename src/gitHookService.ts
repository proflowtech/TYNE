import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGit } from './gitManager';
import { GitCommitDetectorState } from './gitCommitTypes';

const HOOK_SIGNATURE = '# >>> Tyne post-commit hook';
const HOOK_END = '# <<< Tyne post-commit hook';
const PENDING_FILE_NAME = '.tyne-commit-pending';
const HOOK_STATE_KEY = 'tyne.gitCommitDetectorState';

function getPendingFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', PENDING_FILE_NAME);
}

function getHookPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', 'post-commit');
}

function buildHookScript(): string {
  return [
    HOOK_SIGNATURE,
    'REPO=$(git rev-parse --show-toplevel)',
    'COMMIT=$(git rev-parse HEAD)',
    'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
    'DATE=$(git log -1 --format=%cd --date=iso-strict)',
    'MESSAGE=$(git log -1 --format=%s)',
    'PENDING_FILE="$REPO/.git/hooks/' + PENDING_FILE_NAME + '"',
    'node -e "',
    'const fs = require(\'fs\');',
    'const payload = JSON.stringify({',
    '  repositoryPath: process.argv[1],',
    '  branchName: process.argv[2],',
    '  commitHash: process.argv[3],',
    '  committedAt: process.argv[4],',
    '  message: process.argv[5]',
    '});',
    'fs.writeFileSync(process.argv[6], payload);',
    '" "$REPO" "$BRANCH" "$COMMIT" "$DATE" "$MESSAGE" "$PENDING_FILE"',
    HOOK_END,
    '',
  ].join('\n');
}

function readHookContent(hookPath: string): string {
  try {
    return fs.readFileSync(hookPath, 'utf8');
  } catch {
    return '';
  }
}

function injectHookScript(content: string, script: string): string {
  if (content.includes(HOOK_SIGNATURE)) {
    const start = content.indexOf(HOOK_SIGNATURE);
    const end = content.indexOf(HOOK_END);
    if (end === -1) {
      return content.slice(0, start) + script + content.slice(start + HOOK_SIGNATURE.length);
    }
    return content.slice(0, start) + script + content.slice(end + HOOK_END.length + 1);
  }
  return content + '\n' + script;
}

function removeHookScript(content: string): string {
  if (!content.includes(HOOK_SIGNATURE)) { return content; }
  const start = content.indexOf(HOOK_SIGNATURE);
  const end = content.indexOf(HOOK_END);
  if (end === -1) { return content.slice(0, start).trimEnd() + '\n'; }
  return (content.slice(0, start) + content.slice(end + HOOK_END.length + 1)).trimEnd() + '\n';
}

async function resolveRepoPath(): Promise<string | null> {
  try {
    const git = getGit();
    if (!git) { return null; }
    const raw = await git.raw(['rev-parse', '--show-toplevel']);
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function saveState(context: vscode.ExtensionContext, state: GitCommitDetectorState): void {
  try {
    context.workspaceState.update(HOOK_STATE_KEY, state);
  } catch {
    // best-effort persistence
  }
}

export async function installPostCommitHook(
  context: vscode.ExtensionContext,
): Promise<GitCommitDetectorState> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    const state: GitCommitDetectorState = {
      mode: 'none',
      hookInstalled: false,
      error: 'No Git repository found in the workspace.',
    };
    saveState(context, state);
    return state;
  }

  const hookPath = getHookPath(repoPath);
  const pendingFilePath = getPendingFilePath(repoPath);

  try {
    const hooksDir = path.dirname(hookPath);
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const existing = readHookContent(hookPath);
    const script = buildHookScript();
    const shebang = existing.trim().startsWith('#!') ? '' : '#!/bin/sh\n';
    const updated = injectHookScript(shebang + existing, script);
    fs.writeFileSync(hookPath, updated, { mode: 0o755 });

    // Ensure the pending file exists so the watcher can attach to it immediately
    if (!fs.existsSync(pendingFilePath)) {
      fs.writeFileSync(pendingFilePath, '', { mode: 0o644 });
    }

    const state: GitCommitDetectorState = {
      mode: 'hook',
      hookInstalled: true,
      hookPath,
      pendingFilePath,
    };
    saveState(context, state);
    return state;
  } catch (err) {
    const state: GitCommitDetectorState = {
      mode: 'watcher',
      hookInstalled: false,
      pendingFilePath,
      error: err instanceof Error ? err.message : String(err),
    };
    saveState(context, state);
    return state;
  }
}

export async function reinstallPostCommitHook(
  context: vscode.ExtensionContext,
): Promise<GitCommitDetectorState> {
  return installPostCommitHook(context);
}

export async function uninstallPostCommitHook(
  context: vscode.ExtensionContext,
): Promise<GitCommitDetectorState> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    const state: GitCommitDetectorState = {
      mode: 'none',
      hookInstalled: false,
      error: 'No Git repository found in the workspace.',
    };
    saveState(context, state);
    return state;
  }

  const hookPath = getHookPath(repoPath);
  const pendingFilePath = getPendingFilePath(repoPath);

  try {
    if (fs.existsSync(hookPath)) {
      const existing = readHookContent(hookPath);
      const cleaned = removeHookScript(existing);
      if (cleaned.trim()) {
        fs.writeFileSync(hookPath, cleaned, { mode: 0o755 });
      } else {
        fs.unlinkSync(hookPath);
      }
    }
    if (fs.existsSync(pendingFilePath)) {
      fs.unlinkSync(pendingFilePath);
    }
  } catch {
    // best-effort cleanup
  }

  const state: GitCommitDetectorState = {
    mode: 'watcher',
    hookInstalled: false,
    pendingFilePath,
  };
  saveState(context, state);
  return state;
}

export function getSavedDetectorState(
  context: vscode.ExtensionContext,
): GitCommitDetectorState | undefined {
  return context.workspaceState.get<GitCommitDetectorState>(HOOK_STATE_KEY);
}

export async function getDetectorState(
  context: vscode.ExtensionContext,
): Promise<GitCommitDetectorState> {
  const saved = getSavedDetectorState(context);
  if (saved) { return saved; }
  return installPostCommitHook(context);
}
