import * as vscode from 'vscode';
import { getGit } from './gitManager';
import { TyneCommitFileChange, TyneCommitRecord } from './commitTypes';

function getRepositoryPath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function parseNameStatus(code: string, pathInfo: string): Pick<TyneCommitFileChange, 'changeType' | 'filePath' | 'previousPath'> {
  const normalizedCode = code.trim().toUpperCase();
  if (normalizedCode.startsWith('R')) {
    const [previousPath = '', filePath = previousPath] = pathInfo.split('\t');
    return { changeType: 'renamed', filePath, previousPath };
  }
  if (normalizedCode === 'A') { return { changeType: 'added', filePath: pathInfo }; }
  if (normalizedCode === 'D') { return { changeType: 'deleted', filePath: pathInfo }; }
  return { changeType: 'modified', filePath: pathInfo };
}

export async function getChangedFiles(commitHash: string): Promise<TyneCommitFileChange[]> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }
  const raw = await git.raw(['show', '--numstat', '--format=', '--name-status', commitHash]);
  const lines = raw.split('\n').filter(Boolean);
  const byPath = new Map<string, TyneCommitFileChange>();

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3 && (/^\d+$/.test(parts[0]) || parts[0] === '-')) {
      const [addedRaw, deletedRaw, filePath] = parts;
      const current = byPath.get(filePath) || {
        filePath,
        changeType: 'modified' as const,
        linesAdded: 0,
        linesDeleted: 0,
      };
      current.linesAdded = addedRaw === '-' ? 0 : Number(addedRaw);
      current.linesDeleted = deletedRaw === '-' ? 0 : Number(deletedRaw);
      byPath.set(filePath, current);
      continue;
    }

    if (parts.length >= 2) {
      const [code, ...pathParts] = parts;
      const parsed = parseNameStatus(code, pathParts.join('\t'));
      const current = byPath.get(parsed.filePath) || {
        filePath: parsed.filePath,
        changeType: parsed.changeType,
        previousPath: parsed.previousPath,
        linesAdded: 0,
        linesDeleted: 0,
      };
      current.changeType = parsed.changeType;
      current.previousPath = parsed.previousPath;
      byPath.set(parsed.filePath, current);
    }
  }

  return Array.from(byPath.values());
}

export async function getCommitDetails(commitHash: string, branchName: string): Promise<TyneCommitRecord> {
  const git = getGit();
  const repositoryPath = getRepositoryPath();
  if (!git || !repositoryPath) { throw new Error('No workspace open'); }

  const meta = await git.raw(['show', '-s', '--format=%H%n%an%n%ae%n%aI%n%s', commitHash]);
  const [fullHash = commitHash, authorName = '', authorEmail = '', committedAt = '', ...messageParts] = meta.trim().split('\n');
  const message = messageParts.join('\n') || '';
  const filesChanged = await getChangedFiles(commitHash);
  const totalLinesAdded = filesChanged.reduce((sum, file) => sum + file.linesAdded, 0);
  const totalLinesDeleted = filesChanged.reduce((sum, file) => sum + file.linesDeleted, 0);
  const now = new Date().toISOString();

  return {
    id: `${repositoryPath}:${fullHash}`,
    repositoryPath,
    branchName,
    commitHash: fullHash,
    shortHash: fullHash.slice(0, 8),
    message,
    authorName,
    authorEmail,
    committedAt,
    filesChanged,
    totalFilesChanged: filesChanged.length,
    totalLinesAdded,
    totalLinesDeleted,
    linkedStatus: 'unlinked',
    createdAt: now,
    updatedAt: now,
  };
}

export async function getCommitsForBranch(branchName: string, maxCount = 20): Promise<TyneCommitRecord[]> {
  const git = getGit();
  if (!git) { throw new Error('No workspace open'); }

  const cap = String(maxCount);
  let raw: string;
  try {
    const defaultBranch = vscode.workspace.getConfiguration('tyne').get<string>('defaultBranch', 'main');
    const mergeBase = await git.raw(['merge-base', branchName, defaultBranch]).catch(() => '');
    const base = mergeBase.trim();
    if (base && base !== branchName) {
      raw = await git.raw(['log', `${base}..${branchName}`, '--format=%H', `--max-count=${cap}`]);
    } else {
      raw = await git.raw(['log', branchName, '--format=%H', `--max-count=${cap}`]);
    }
  } catch {
    raw = await git.raw(['log', branchName, '--format=%H', `--max-count=${cap}`]);
  }

  const hashes = raw.split('\n').map(line => line.trim()).filter(Boolean);
  const commits: TyneCommitRecord[] = [];
  for (const hash of hashes) {
    try {
      commits.push(await getCommitDetails(hash, branchName));
    } catch {
      // skip unparseable commits (e.g. merge commits with no files)
    }
  }
  return commits.sort((a, b) => new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime());
}
