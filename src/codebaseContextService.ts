import * as vscode from 'vscode';
import * as path from 'path';
import { getCurrentBranch } from './gitManager';
import { TyneCodebaseContextPack } from './taskTypes';

const IGNORE_GLOB = '**/{node_modules,dist,build,out,.next,coverage,.git}/**';
const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,css,scss,html,vue,svelte,py,go,rs,java,kt,swift}';
const PREFERRED_DIRS = /(^|\/)(src|app|pages|components|services|lib|api|routes|tests|test|__tests__)(\/|$)/i;
const TEST_FILE = /(^|\/|\.)(test|spec)\.[a-z0-9]+$/i;
const GENERATED_FILE = /(\.min\.[a-z0-9]+$|generated|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|bun\.lockb$|composer\.lock$|Gemfile\.lock$|Cargo\.lock$|go\.sum$)/i;

const SENSITIVE_PATH_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /\.envrc$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /id_dsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /\.csr$/i,
  /credentials/i,
  /\.serviceaccount\.json$/i,
  /service[-_]?account/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /private/i,
  /\.keystore$/i,
  /\.jks$/i,
  /supabase_service_role/i,
  /anthropic_key/i,
  /openai_key/i,
  /api[-_]?key/i,
  /\.htpasswd$/i,
  /\.netrc$/i,
  /oauth/i,
  /\.aws\//i,
  /credentials\.json$/i,
  /secrets\.json$/i,
  /secrets\.yml$/i,
  /secrets\.yaml$/i,
];

export function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(filePath));
}

export interface CollectCodebaseContextInput {
  issueTitle?: string;
  issueDescription?: string;
  acceptanceCriteria?: string[];
  subtasks?: Array<{ title: string; description?: string }>;
  validationSteps?: string[];
  changedFiles?: string[];
  diffText?: string;
}

export async function collectCodebaseContext(input: CollectCodebaseContextInput): Promise<TyneCodebaseContextPack | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }
  const workspaceRoot = folder.uri.fsPath;
  const repositoryName = folder.name;
  const currentBranch = await getCurrentBranch().catch(() => '');
  const keywords = extractKeywords([
    input.issueTitle,
    input.issueDescription,
    ...(input.acceptanceCriteria || []),
    ...(input.subtasks || []).flatMap(s => [s.title, s.description || '']),
    ...(input.validationSteps || []),
    ...(input.changedFiles || []),
  ].filter(Boolean).join(' '));

  const uris = await vscode.workspace.findFiles(SOURCE_GLOB, IGNORE_GLOB, 500);
  const relativePaths = uris
    .map(uri => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
    .filter(p => !GENERATED_FILE.test(p))
    .filter(p => !isSensitivePath(p));
  const projectHints = await inferProjectHints(workspaceRoot);
  const changed = (input.changedFiles || []).map(p => p.replace(/\\/g, '/'));
  const relevantFiles = await findRelevantFiles(relativePaths, keywords, changed);
  const existingTests = findExistingTests(relativePaths, keywords, changed);
  const fileTreeSummary = summarizeTree(relativePaths);

  return {
    repositoryName,
    currentBranch,
    workspaceRoot,
    projectHints,
    fileTreeSummary,
    relevantFiles,
    existingTests,
    changedFiles: changed,
    diff: trimText(input.diffText || '', 20_000),
  };
}

function extractKeywords(text: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'task', 'issue', 'user', 'add', 'fix', 'use', 'when', 'then', 'should', 'must', 'need', 'needs']);
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !stop.has(w));
  return Array.from(new Set(words)).slice(0, 40);
}

async function inferProjectHints(root: string): Promise<TyneCodebaseContextPack['projectHints']> {
  const hints: TyneCodebaseContextPack['projectHints'] = {};
  const packageUri = vscode.Uri.file(path.join(root, 'package.json'));
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(packageUri)).toString('utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string };
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    hints.packageManager = pkg.packageManager?.split('@')[0] || (await exists(root, 'pnpm-lock.yaml') ? 'pnpm' : await exists(root, 'yarn.lock') ? 'yarn' : 'npm');
    hints.language = deps.typescript ? 'TypeScript' : 'JavaScript';
    if (deps.next) { hints.framework = 'Next.js'; }
    else if (deps.vite) { hints.framework = 'Vite'; }
    else if (deps.react) { hints.framework = 'React'; }
    else if (deps.vue) { hints.framework = 'Vue'; }
    if (deps.vitest) { hints.testFramework = 'Vitest'; }
    else if (deps.jest) { hints.testFramework = 'Jest'; }
    else if (deps.mocha) { hints.testFramework = 'Mocha'; }
    else if (deps['@playwright/test']) { hints.testFramework = 'Playwright'; }
  } catch {
    hints.packageManager = await exists(root, 'pnpm-lock.yaml') ? 'pnpm' : await exists(root, 'yarn.lock') ? 'yarn' : undefined;
  }
  if (!hints.framework) {
    if (await exists(root, 'next.config.js') || await exists(root, 'next.config.mjs') || await exists(root, 'next.config.ts')) { hints.framework = 'Next.js'; }
    else if (await exists(root, 'vite.config.ts') || await exists(root, 'vite.config.js')) { hints.framework = 'Vite'; }
  }
  return hints;
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, relative)));
    return true;
  } catch {
    return false;
  }
}

async function findRelevantFiles(paths: string[], keywords: string[], changedFiles: string[]): Promise<TyneCodebaseContextPack['relevantFiles']> {
  const changed = new Set(changedFiles);
  const scored = paths
    .filter(p => !TEST_FILE.test(p))
    .map(p => ({ path: p, score: scorePath(p, keywords, changed), reason: reasonForPath(p, keywords, changed) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  const withSnippets: TyneCodebaseContextPack['relevantFiles'] = [];
  for (const item of scored) {
    withSnippets.push({
      path: item.path,
      reason: item.reason,
      snippet: await readSnippet(item.path, keywords),
    });
  }
  return withSnippets;
}

function findExistingTests(paths: string[], keywords: string[], changedFiles: string[]): TyneCodebaseContextPack['existingTests'] {
  const changed = new Set(changedFiles);
  return paths
    .filter(p => TEST_FILE.test(p) || /(^|\/)(__tests__|tests|test)\//i.test(p))
    .map(p => ({ path: p, score: scorePath(p, keywords, changed), reason: changed.has(p) ? 'Changed test file' : 'Existing nearby test file' }))
    .filter(x => x.score > 0 || PREFERRED_DIRS.test(x.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ path, reason }) => ({ path, reason }));
}

function scorePath(filePath: string, keywords: string[], changed: Set<string>): number {
  const normalized = filePath.toLowerCase();
  let score = changed.has(filePath) ? 20 : 0;
  if (PREFERRED_DIRS.test(filePath)) { score += 5; }
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) { score += 4; }
  }
  return score;
}

function reasonForPath(filePath: string, keywords: string[], changed: Set<string>): string {
  if (changed.has(filePath)) { return 'Already changed in the current git diff'; }
  const matches = keywords.filter(k => filePath.toLowerCase().includes(k)).slice(0, 3);
  if (matches.length) { return `Path matches issue keyword(s): ${matches.join(', ')}`; }
  return PREFERRED_DIRS.test(filePath) ? 'Likely implementation area in the repository' : 'Potentially relevant repository file';
}

async function readSnippet(relativePath: string, keywords: string[]): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }
  if (isSensitivePath(relativePath)) { return undefined; }
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(folder.uri.fsPath, relativePath)))).toString('utf8');
    const lines = raw.split(/\r?\n/);
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    const matchIndex = lines.findIndex(line => lowerKeywords.some(k => line.toLowerCase().includes(k)));
    const start = Math.max(0, matchIndex >= 0 ? matchIndex - 3 : 0);
    return trimText(lines.slice(start, start + 18).join('\n'), 2000);
  } catch {
    return undefined;
  }
}

function summarizeTree(paths: string[]): string[] {
  const dirs = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/');
    const key = parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.';
    dirs.set(key, (dirs.get(key) || 0) + 1);
  }
  return Array.from(dirs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([dir, count]) => `${dir}/ (${count} files)`);
}

function trimText(text: string, max: number): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) { return undefined; }
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n... [truncated] ...` : trimmed;
}
