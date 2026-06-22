import * as path from 'path';
import * as vscode from 'vscode';

export interface DriftEvent {
  file: string;
  fullPath: string;
  goalKeywords: string[];
  matchedKeywords: string[];
  severity: 'low' | 'medium' | 'high';
}

let watcher: vscode.FileSystemWatcher | undefined;
const recentAlerts = new Map<string, ReturnType<typeof setTimeout>>();

export function startDriftDetection(
  goal: string,
  _taskId: string,
  onDrift: (event: DriftEvent) => void,
): void {
  stopDriftDetection();
  if (!goal.trim()) { return; }

  const goalKeywords = extractKeywords(goal);
  const sensitivity = vscode.workspace.getConfiguration('tyne').get<string>('driftSensitivity', 'medium');
  watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, true);

  watcher.onDidChange(uri => checkDrift(uri, goalKeywords, sensitivity, onDrift));
  watcher.onDidCreate(uri => checkDrift(uri, goalKeywords, sensitivity, onDrift));
}

export function stopDriftDetection(): void {
  watcher?.dispose();
  watcher = undefined;
  recentAlerts.forEach(timeout => clearTimeout(timeout));
  recentAlerts.clear();
}

function checkDrift(
  uri: vscode.Uri,
  goalKeywords: string[],
  sensitivity: string,
  onDrift: (event: DriftEvent) => void,
): void {
  const fullPath = uri.fsPath;
  const file = path.basename(fullPath);
  if (shouldIgnoreFile(fullPath) || recentAlerts.has(fullPath)) { return; }

  const fileKeywords = extractFileKeywords(fullPath);
  const matchedKeywords = goalKeywords.filter(keyword =>
    fileKeywords.some(fileKeyword => fileKeyword.includes(keyword) || keyword.includes(fileKeyword)),
  );
  if (matchedKeywords.length > 0) { return; }

  const severity = calculateDriftSeverity(fullPath, goalKeywords, sensitivity);
  if (!severity) { return; }

  const timeout = setTimeout(() => {
    recentAlerts.delete(fullPath);
  }, 30_000);
  recentAlerts.set(fullPath, timeout);

  onDrift({ file, fullPath, goalKeywords, matchedKeywords, severity });
}

function extractKeywords(goal: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'to', 'for', 'fix', 'add', 'update', 'create', 'implement',
    'build', 'make', 'get', 'set', 'use', 'with', 'and', 'or', 'in', 'on', 'at',
    'of', 'from', 'into', 'this', 'that', 'your',
  ]);

  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function extractFileKeywords(filePath: string): string[] {
  return filePath
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|py|css|html|json|md|sql)$/, '')
    .split(/[/\\_.-]/)
    .filter(part => part.length > 2);
}

function shouldIgnoreFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const ignored = [
    '/node_modules/', '/.git/', '/out/', '/dist/', '/build/', '/coverage/',
    '/.vscode/', '/.next/', '/.turbo/', '/__pycache__/',
  ];
  if (ignored.some(pattern => normalized.includes(pattern))) { return true; }

  return [
    '.lock', '.log', '.md', '.env', '.map', '.png', '.jpg', '.jpeg', '.gif',
    '.svg', '.ico', '.DS_Store',
  ].some(suffix => normalized.endsWith(suffix.toLowerCase()));
}

function calculateDriftSeverity(
  filePath: string,
  goalKeywords: string[],
  sensitivity: string,
): 'low' | 'medium' | 'high' | null {
  const normalized = filePath.toLowerCase();
  const knownDomains = [
    'auth', 'login', 'payment', 'billing', 'invoice', 'user', 'admin', 'api',
    'db', 'database', 'ui', 'style', 'test', 'config', 'webhook', 'license',
    'github', 'slack', 'email',
  ];
  const fileDomains = knownDomains.filter(domain => normalized.includes(domain));
  const goalDomains = knownDomains.filter(domain =>
    goalKeywords.some(keyword => keyword.includes(domain) || domain.includes(keyword)),
  );
  const conflictingDomain = fileDomains.length > 0
    && goalDomains.length > 0
    && !fileDomains.some(domain => goalDomains.includes(domain));

  if (conflictingDomain) { return sensitivity === 'low' ? 'medium' : 'high'; }
  if (sensitivity === 'high' && fileDomains.length > 0) { return 'medium'; }
  if (sensitivity === 'medium' && fileDomains.length > 0) { return 'low'; }
  return null;
}
