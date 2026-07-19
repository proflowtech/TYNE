import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGit } from './gitManager';
import { GitCommitDetectorState } from './gitCommitTypes';

const HOOK_SIGNATURE = '# >>> Tyne post-commit hook';
const HOOK_END = '# <<< Tyne post-commit hook';
const PRE_COMMIT_SIGNATURE = '# >>> Tyne pre-commit hook';
const PRE_COMMIT_END = '# <<< Tyne pre-commit hook';
const PRE_PUSH_SIGNATURE = '# >>> Tyne pre-push hook';
const PRE_PUSH_END = '# <<< Tyne pre-push hook';
const PENDING_FILE_NAME = '.tyne-commit-pending';
const GATE_BLOCK_FILE = '.tyne-gate-block';
const GATE_WARN_FILE = '.tyne-gate-warn';
const HOOK_STATE_KEY = 'tyne.gitCommitDetectorState';

function getPendingFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', PENDING_FILE_NAME);
}

function getHookPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', 'post-commit');
}

function getPreCommitHookPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', 'pre-commit');
}

function getPrePushHookPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', 'pre-push');
}

function getGateBlockFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', GATE_BLOCK_FILE);
}

function getGateWarnFilePath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', GATE_WARN_FILE);
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

function buildPreCommitHookScript(): string {
  return [
    PRE_COMMIT_SIGNATURE,
    'REPO=$(git rev-parse --show-toplevel)',
    'BLOCK_FILE="$REPO/.git/hooks/' + GATE_BLOCK_FILE + '"',
    'WARN_FILE="$REPO/.git/hooks/' + GATE_WARN_FILE + '"',
    'if [ -f "$BLOCK_FILE" ]; then',
    '  echo "Tyne: Quality gate BLOCKED this commit."',
    '  cat "$BLOCK_FILE"',
    '  echo ""',
    '  echo "Resolve the issues above or remove the block override to commit anyway."',
    '  rm -f "$WARN_FILE"',
    '  exit 1',
    'fi',
    'if [ -f "$WARN_FILE" ]; then',
    '  echo "Tyne: Quality gate warnings:"',
    '  cat "$WARN_FILE"',
    '  echo ""',
    '  rm -f "$WARN_FILE"',
    'fi',
    PRE_COMMIT_END,
    '',
  ].join('\n');
}

function buildPrePushHookScript(): string {
  return [
    PRE_PUSH_SIGNATURE,
    'REPO=$(git rev-parse --show-toplevel)',
    'BLOCK_FILE="$REPO/.git/hooks/' + GATE_BLOCK_FILE + '"',
    'WARN_FILE="$REPO/.git/hooks/' + GATE_WARN_FILE + '"',
    'if [ -f "$BLOCK_FILE" ]; then',
    '  echo "Tyne: Quality gate BLOCKED this push."',
    '  cat "$BLOCK_FILE"',
    '  echo ""',
    '  echo "Resolve the issues above or remove the block override to push anyway."',
    '  rm -f "$WARN_FILE"',
    '  exit 1',
    'fi',
    'if [ -f "$WARN_FILE" ]; then',
    '  echo "Tyne: Quality gate warnings:"',
    '  cat "$WARN_FILE"',
    '  echo ""',
    '  rm -f "$WARN_FILE"',
    'fi',
    PRE_PUSH_END,
    '',
  ].join('\n');
}

function injectGenericHook(content: string, script: string, signature: string, endMarker: string): string {
  if (content.includes(signature)) {
    const start = content.indexOf(signature);
    const end = content.indexOf(endMarker);
    if (end === -1) {
      return content.slice(0, start) + script + content.slice(start + signature.length);
    }
    return content.slice(0, start) + script + content.slice(end + endMarker.length + 1);
  }
  return content + '\n' + script;
}

function removeGenericHook(content: string, signature: string, endMarker: string): string {
  if (!content.includes(signature)) { return content; }
  const start = content.indexOf(signature);
  const end = content.indexOf(endMarker);
  if (end === -1) { return content.slice(0, start).trimEnd() + '\n'; }
  return (content.slice(0, start) + content.slice(end + endMarker.length + 1)).trimEnd() + '\n';
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

// ── Quality Gate Hooks (pre-commit / pre-push) ──────────────────────────────

export async function installQualityGateHooks(
  context: vscode.ExtensionContext,
): Promise<{ preCommitInstalled: boolean; prePushInstalled: boolean; error?: string }> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) {
    return { preCommitInstalled: false, prePushInstalled: false, error: 'No Git repository found.' };
  }

  const preCommitPath = getPreCommitHookPath(repoPath);
  const prePushPath = getPrePushHookPath(repoPath);
  let preCommitInstalled = false;
  let prePushInstalled = false;

  try {
    const hooksDir = path.dirname(preCommitPath);
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Pre-commit hook
    const preCommitExisting = readHookContent(preCommitPath);
    const preCommitScript = buildPreCommitHookScript();
    const preCommitShebang = preCommitExisting.trim().startsWith('#!') ? '' : '#!/bin/sh\n';
    const preCommitUpdated = injectGenericHook(preCommitShebang + preCommitExisting, preCommitScript, PRE_COMMIT_SIGNATURE, PRE_COMMIT_END);
    fs.writeFileSync(preCommitPath, preCommitUpdated, { mode: 0o755 });
    preCommitInstalled = true;

    // Pre-push hook
    const prePushExisting = readHookContent(prePushPath);
    const prePushScript = buildPrePushHookScript();
    const prePushShebang = prePushExisting.trim().startsWith('#!') ? '' : '#!/bin/sh\n';
    const prePushUpdated = injectGenericHook(prePushShebang + prePushExisting, prePushScript, PRE_PUSH_SIGNATURE, PRE_PUSH_END);
    fs.writeFileSync(prePushPath, prePushUpdated, { mode: 0o755 });
    prePushInstalled = true;
  } catch (err) {
    return { preCommitInstalled, prePushInstalled, error: err instanceof Error ? err.message : String(err) };
  }

  return { preCommitInstalled, prePushInstalled };
}

export async function uninstallQualityGateHooks(): Promise<void> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) { return; }

  const preCommitPath = getPreCommitHookPath(repoPath);
  const prePushPath = getPrePushHookPath(repoPath);

  try {
    if (fs.existsSync(preCommitPath)) {
      const existing = readHookContent(preCommitPath);
      const cleaned = removeGenericHook(existing, PRE_COMMIT_SIGNATURE, PRE_COMMIT_END);
      if (cleaned.trim()) {
        fs.writeFileSync(preCommitPath, cleaned, { mode: 0o755 });
      } else {
        fs.unlinkSync(preCommitPath);
      }
    }
    if (fs.existsSync(prePushPath)) {
      const existing = readHookContent(prePushPath);
      const cleaned = removeGenericHook(existing, PRE_PUSH_SIGNATURE, PRE_PUSH_END);
      if (cleaned.trim()) {
        fs.writeFileSync(prePushPath, cleaned, { mode: 0o755 });
      } else {
        fs.unlinkSync(prePushPath);
      }
    }
    clearGateFiles(repoPath);
  } catch {
    // best-effort cleanup
  }
}

export async function writeGateBlockFile(reasons: string[]): Promise<void> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) { return; }
  const blockPath = getGateBlockFilePath(repoPath);
  try {
    fs.writeFileSync(blockPath, reasons.join('\n'), { mode: 0o644 });
  } catch {
    // best-effort
  }
}

export async function writeGateWarnFile(reasons: string[]): Promise<void> {
  const repoPath = await resolveRepoPath();
  if (!repoPath) { return; }
  const warnPath = getGateWarnFilePath(repoPath);
  try {
    fs.writeFileSync(warnPath, reasons.join('\n'), { mode: 0o644 });
  } catch {
    // best-effort
  }
}

export function clearGateFiles(repoPath: string): void {
  try {
    const blockPath = getGateBlockFilePath(repoPath);
    const warnPath = getGateWarnFilePath(repoPath);
    if (fs.existsSync(blockPath)) { fs.unlinkSync(blockPath); }
    if (fs.existsSync(warnPath)) { fs.unlinkSync(warnPath); }
  } catch {
    // best-effort
  }
}
