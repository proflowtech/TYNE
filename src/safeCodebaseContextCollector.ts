import * as vscode from 'vscode';
import * as path from 'path';
import { getCurrentBranch } from './gitManager';
import { isSensitivePath } from './codebaseContextService';
import {
  SafeCodebaseContext,
  ChangedFileInfo,
  ReviewPmTaskContext,
} from './validateReviewTypes';
import { extractFileFacts } from './quality/astFacts';
import type { Hop1Result } from './quality/importGraph';

const IGNORE_GLOB = '**/{node_modules,dist,build,out,.next,coverage,.git}/**';
const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,css,scss,html,vue,svelte,py,go,rs,java,kt,swift}';
const TEST_FILE = /(^|\/|\.)(test|spec)\.[a-z0-9]+$/i;
const BINARY_EXT = /\.(png|jpg|jpeg|gif|bmp|ico|svg|woff|woff2|ttf|eot|otf|mp3|mp4|webm|avi|mov|zip|tar|gz|rar|7z|pdf|doc|docx|xls|xlsx|exe|dll|so|dylib|class|jar|war)$/i;

export interface SafeCodebaseContextInput {
  changedFiles: ChangedFileInfo[];
  pmTask?: ReviewPmTaskContext;
  maxRelevantFiles: number;
  /** Persistent import-graph 1-hop; skips the 200-file basename scan when present. */
  hop1?: Hop1Result;
}

export async function collectSafeCodebaseContext(
  input: SafeCodebaseContextInput,
): Promise<SafeCodebaseContext | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }

  const workspaceRoot = folder.uri.fsPath;
  const repositoryName = folder.name;
  const currentBranch = await getCurrentBranch().catch(() => '');

  const changedPaths = input.changedFiles.map(f => f.path);
  const keywords = extractKeywords([
    input.pmTask?.title,
    input.pmTask?.description,
    input.pmTask?.goal,
    ...(input.pmTask?.acceptanceCriteria || []),
    ...(input.pmTask?.subtasks || []).map(s => s.title),
    ...changedPaths,
  ]);

  const projectHints = await inferProjectHints(workspaceRoot);
  const uris = await vscode.workspace.findFiles(SOURCE_GLOB, IGNORE_GLOB, 500);
  const relativePaths = uris
    .map(uri => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'))
    .filter(p => !isSensitivePath(p))
    .filter(p => !BINARY_EXT.test(p));

  const nearbyFiles = findNearbyFiles(relativePaths, changedPaths, keywords, input.maxRelevantFiles);
  await populateSnippets(nearbyFiles, changedPaths, workspaceRoot);
  const nearbyTests = findNearbyTests(relativePaths, changedPaths, keywords);
  const importedSymbols = await extractImportedSymbols(changedPaths, workspaceRoot);
  const changedFileContents = await collectChangedFileContents(changedPaths, workspaceRoot);
  const graphImpacted = hop1ToImpacted(input.hop1, input.maxRelevantFiles);
  const impactedFiles = graphImpacted.length
    ? graphImpacted
    : await findImpactedFiles(relativePaths, changedPaths, workspaceRoot, input.maxRelevantFiles);
  const dependencyInterfaces = await extractDependencyInterfaces(
    changedPaths,
    nearbyFiles.map(f => f.path),
    workspaceRoot,
  );
  const astDiffSummary = buildAstDiffSummary(changedFileContents || []);
  const pmTaskRelevantFiles = input.pmTask
    ? findPmTaskRelevantFiles(relativePaths, input.pmTask, input.maxRelevantFiles)
    : [];

  return {
    repositoryName,
    currentBranch,
    projectHints: {
      language: projectHints.language,
      framework: projectHints.framework,
      packageManager: projectHints.packageManager,
      testFramework: projectHints.testFramework,
    },
    nearbyFiles,
    nearbyTests,
    importedSymbols,
    changedFileContents,
    impactedFiles,
    dependencyInterfaces,
    astDiffSummary,
    pmTaskRelevantFiles,
  };
}

const MAX_SNIPPET_LINES = 60;
const MAX_CONTENT_LINES = 400;
const MAX_CONTENT_FILES = 8;

async function readWorkspaceFile(workspaceRoot: string, relPath: string): Promise<string | undefined> {
  try {
    const fullPath = path.join(workspaceRoot, relPath);
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath))).toString('utf8');
  } catch {
    return undefined;
  }
}

async function populateSnippets(
  nearbyFiles: SafeCodebaseContext['nearbyFiles'],
  changedPaths: string[],
  workspaceRoot: string,
): Promise<void> {
  const changedBasenames = changedPaths.map(p => path.basename(p, path.extname(p)).toLowerCase());
  for (const item of nearbyFiles) {
    const content = await readWorkspaceFile(workspaceRoot, item.path);
    if (!content) { continue; }
    const lines = content.split('\n');
    const relevant: string[] = [];
    for (let i = 0; i < lines.length && relevant.length < MAX_SNIPPET_LINES; i++) {
      const line = lines[i];
      const lower = line.toLowerCase();
      const isImport = /^\s*(import|export|from|require)\b/.test(line);
      const mentionsChanged = changedBasenames.some(name => name.length >= 3 && lower.includes(name));
      const isSignature = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const)\s+\w/.test(line);
      if (isImport || mentionsChanged || isSignature) {
        relevant.push(`${i + 1}: ${line.slice(0, 200)}`);
      }
    }
    if (relevant.length) {
      item.snippet = relevant.join('\n');
    }
  }
}

async function collectChangedFileContents(
  changedPaths: string[],
  workspaceRoot: string,
): Promise<SafeCodebaseContext['changedFileContents']> {
  const results: NonNullable<SafeCodebaseContext['changedFileContents']> = [];
  for (const relPath of changedPaths.slice(0, MAX_CONTENT_FILES)) {
    if (isSensitivePath(relPath) || BINARY_EXT.test(relPath)) { continue; }
    const content = await readWorkspaceFile(workspaceRoot, relPath);
    if (!content) { continue; }
    const lines = content.split('\n');
    const truncated = lines.length > MAX_CONTENT_LINES;
    results.push({
      path: relPath,
      content: lines.slice(0, MAX_CONTENT_LINES).map(l => l.slice(0, 300)).join('\n'),
      totalLines: lines.length,
      truncated,
    });
  }
  return results;
}

function hop1ToImpacted(
  hop1: Hop1Result | undefined,
  maxFiles: number,
): NonNullable<SafeCodebaseContext['impactedFiles']> {
  if (!hop1?.importers.length) { return []; }
  return hop1.importers.slice(0, maxFiles).map(i => ({
    path: i.file,
    importsChangedFile: i.targetFile,
    importLine: `${i.line}: import ${i.importedSymbols.join(', ') || i.fromModule} from '${i.fromModule}'`,
  }));
}

async function findImpactedFiles(
  allPaths: string[],
  changedPaths: string[],
  workspaceRoot: string,
  maxFiles: number,
): Promise<SafeCodebaseContext['impactedFiles']> {
  const changedSet = new Set(changedPaths);
  const changedModules = changedPaths
    .map(p => p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ''))
    .map(p => path.basename(p))
    .filter(name => name.length >= 3 && name !== 'index');
  if (!changedModules.length) { return []; }

  const results: NonNullable<SafeCodebaseContext['impactedFiles']> = [];
  const candidates = allPaths.filter(p => !changedSet.has(p) && !TEST_FILE.test(p)).slice(0, 200);
  for (const candidate of candidates) {
    if (results.length >= maxFiles) { break; }
    const content = await readWorkspaceFile(workspaceRoot, candidate);
    if (!content) { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*(import|export)\b.*from\s+['"]/.test(line) && !/require\s*\(/.test(line)) { continue; }
      const matched = changedModules.find(name => line.includes(`/${name}'`) || line.includes(`/${name}"`) || line.includes(`'./${name}'`) || line.includes(`"./${name}"`));
      if (matched) {
        results.push({ path: candidate, importsChangedFile: matched, importLine: `${i + 1}: ${line.trim().slice(0, 200)}` });
        break;
      }
    }
  }
  return results;
}

function findNearbyFiles(
  paths: string[],
  changedPaths: string[],
  keywords: string[],
  maxFiles: number,
): SafeCodebaseContext['nearbyFiles'] {
  const changed = new Set(changedPaths);
  const scored = paths
    .filter(p => !TEST_FILE.test(p))
    .map(p => ({ path: p, score: scorePath(p, keywords, changed), reason: reasonForPath(p, keywords, changed) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  return scored.map(item => ({
    path: item.path,
    reason: item.reason,
    snippet: undefined,
  }));
}

function findNearbyTests(
  paths: string[],
  changedPaths: string[],
  keywords: string[],
): SafeCodebaseContext['nearbyTests'] {
  const changed = new Set(changedPaths);
  return paths
    .filter(p => TEST_FILE.test(p) || /(^|\/)(__tests__|tests|test)\//i.test(p))
    .map(p => ({ path: p, reason: changed.has(p) ? 'Changed test file' : 'Nearby test file' }))
    .filter(x => changed.has(x.path) || keywords.some(k => x.path.toLowerCase().includes(k)))
    .slice(0, 10);
}

/** Blast radius: signatures of deps imported by changed files (+ nearby). */
async function extractDependencyInterfaces(
  changedPaths: string[],
  nearbyPaths: string[],
  workspaceRoot: string,
): Promise<NonNullable<SafeCodebaseContext['dependencyInterfaces']>> {
  const out: NonNullable<SafeCodebaseContext['dependencyInterfaces']> = [];
  const seen = new Set<string>();
  const targets = [...changedPaths, ...nearbyPaths].slice(0, 12);
  for (const rel of targets) {
    const content = await readWorkspaceFile(workspaceRoot, rel);
    if (!content) continue;
    const facts = extractFileFacts(rel, content);
    for (const sig of facts.signatures || []) {
      const key = `${rel}:${sig.name}:${sig.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: rel,
        name: sig.name,
        kind: sig.kind,
        signature: sig.signature,
        line: sig.line,
      });
      if (out.length >= 40) return out;
    }
    // Fallback: exported names when signatures absent (regex path).
    if (!facts.signatures?.length) {
      for (const exp of facts.exports) {
        const key = `${rel}:${exp.name}:export`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          path: rel,
          name: exp.name,
          kind: 'export',
          signature: exp.name,
          line: exp.line,
        });
        if (out.length >= 40) return out;
      }
    }
  }
  return out;
}

function buildAstDiffSummary(
  changedContents: NonNullable<SafeCodebaseContext['changedFileContents']>,
): string {
  const parts: string[] = [];
  for (const file of changedContents.slice(0, 8)) {
    const facts = extractFileFacts(file.path, file.content);
    const fns = facts.functions.slice(0, 8).map(f =>
      `${f.name}@${f.startLine}-${f.endLine}`);
    const imps = facts.imports.slice(0, 6).map(i => i.module);
    parts.push(
      `${file.path} [${facts.parser || 'regex'}]: functions=${fns.join(', ') || '(none)'}; imports=${imps.join(', ') || '(none)'}`,
    );
  }
  return parts.join('\n').slice(0, 4000);
}

async function extractImportedSymbols(changedPaths: string[], workspaceRoot: string): Promise<string[]> {
  const symbols = new Set<string>();
  for (const filePath of changedPaths.slice(0, 5)) {
    try {
      const fullPath = path.join(workspaceRoot, filePath);
      const content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath))).toString('utf8');
      const importMatches = content.matchAll(/import\s+(?:{([^}]+)}|\*\s+as\s+(\w+)|(\w+))\s+from/g);
      for (const match of importMatches) {
        const named = match[1];
        const namespace = match[2];
        const default_ = match[3];
        if (named) {
          named.split(',').forEach(s => { const t = s.trim(); if (t) symbols.add(t); });
        }
        if (namespace) symbols.add(namespace);
        if (default_) symbols.add(default_);
      }
    } catch { /* file may not exist */ }
  }
  return Array.from(symbols).slice(0, 30);
}

function findPmTaskRelevantFiles(
  paths: string[],
  pmTask: ReviewPmTaskContext,
  maxFiles: number,
): string[] {
  const keywords = extractKeywords([
    pmTask.title,
    pmTask.description,
    pmTask.goal,
    ...(pmTask.acceptanceCriteria || []),
    ...(pmTask.subtasks || []).map(s => s.title),
  ]);
  return paths
    .filter(p => !TEST_FILE.test(p))
    .map(p => ({ path: p, score: keywords.filter(k => p.toLowerCase().includes(k)).length }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(x => x.path);
}

function scorePath(filePath: string, keywords: string[], changed: Set<string>): number {
  const normalized = filePath.toLowerCase();
  let score = changed.has(filePath) ? 20 : 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) { score += 4; }
  }
  return score;
}

function reasonForPath(filePath: string, keywords: string[], changed: Set<string>): string {
  if (changed.has(filePath)) { return 'Changed in the current edit scope'; }
  const matches = keywords.filter(k => filePath.toLowerCase().includes(k)).slice(0, 3);
  if (matches.length) { return `Matches keyword(s): ${matches.join(', ')}`; }
  return 'Nearby file';
}

function extractKeywords(texts: (string | undefined)[]): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'task', 'issue', 'user', 'add', 'fix', 'use', 'when', 'then', 'should', 'must', 'need', 'needs']);
  const words = texts
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !stop.has(w));
  return Array.from(new Set(words)).slice(0, 30);
}

async function inferProjectHints(root: string): Promise<SafeCodebaseContext['projectHints']> {
  const hints: SafeCodebaseContext['projectHints'] = {};
  const packageUri = vscode.Uri.file(path.join(root, 'package.json'));
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(packageUri)).toString('utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string };
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    hints.packageManager = pkg.packageManager?.split('@')[0] || 'npm';
    hints.language = deps.typescript ? 'TypeScript' : 'JavaScript';
    if (deps.next) { hints.framework = 'Next.js'; }
    else if (deps.vite) { hints.framework = 'Vite'; }
    else if (deps.react) { hints.framework = 'React'; }
    if (deps.vitest) { hints.testFramework = 'Vitest'; }
    else if (deps.jest) { hints.testFramework = 'Jest'; }
    else if (deps.mocha) { hints.testFramework = 'Mocha'; }
  } catch { /* no package.json */ }
  return hints;
}
