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
import { collectPriorContext } from './quality/priorContext';
import { getLineHistory } from './gitManager';

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
  /** Unified diff — used to locate which lines to check prior history for. */
  diff?: string;
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

  const graphNeighbors = graphNeighborsFromHop1(input.hop1);
  const nearbyFiles = findNearbyFiles(relativePaths, changedPaths, keywords, input.maxRelevantFiles, graphNeighbors);
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
    ? findPmTaskRelevantFiles(relativePaths, input.pmTask, input.maxRelevantFiles, graphNeighbors)
    : [];
  const priorContext = input.diff
    ? await collectPriorContext(changedPaths, input.diff, getLineHistory).catch(() => [])
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
    priorContext,
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

/**
 * Import-graph neighbors of the changed files: the exact set the AST-backed
 * `queryHop1` already computed, keyed by relationship so `reasonForPath` can
 * say which direction it goes rather than a generic "nearby".
 *
 * This is the piece `findNearbyFiles` and `findPmTaskRelevantFiles` were
 * missing — both ranked purely by keyword string-match, so a file one import
 * away from the diff lost to any file that merely shared a word with the
 * ticket title. `hop1ToImpacted` already wires the graph into `impactedFiles`;
 * this extends the same graph into the *other* two selectors that read from
 * `relativePaths`.
 */
export function graphNeighborsFromHop1(hop1: Hop1Result | undefined): Map<string, 'importer' | 'importee'> {
  const neighbors = new Map<string, 'importer' | 'importee'>();
  if (!hop1) { return neighbors; }
  for (const importer of hop1.importers) { neighbors.set(importer.file, 'importer'); }
  for (const importee of hop1.importees) { if (!neighbors.has(importee.path)) { neighbors.set(importee.path, 'importee'); } }
  return neighbors;
}

export function findNearbyFiles(
  paths: string[],
  changedPaths: string[],
  keywords: string[],
  maxFiles: number,
  graphNeighbors: Map<string, 'importer' | 'importee'> = new Map(),
): SafeCodebaseContext['nearbyFiles'] {
  const changed = new Set(changedPaths);
  const scored = paths
    .filter(p => !TEST_FILE.test(p))
    .map(p => ({
      path: p,
      score: scorePath(p, keywords, changed, graphNeighbors),
      reason: reasonForPath(p, keywords, changed, graphNeighbors),
    }))
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

export function findPmTaskRelevantFiles(
  paths: string[],
  pmTask: ReviewPmTaskContext,
  maxFiles: number,
  graphNeighbors: Map<string, 'importer' | 'importee'> = new Map(),
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
    .map(p => ({
      path: p,
      // A keyword hit means the file's *name* echoes the ticket; a graph edge
      // means the file is *actually wired to* the code the ticket touches.
      // The latter is the stronger and cheaper-to-trust signal, so it counts
      // for more than any single keyword match.
      score: keywords.filter(k => p.toLowerCase().includes(k)).length + (graphNeighbors.has(p) ? GRAPH_NEIGHBOR_KEYWORD_WEIGHT : 0),
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(x => x.path);
}

/**
 * Score weights, in one place so the ranking is legible as a whole rather
 * than scattered across two functions:
 *   changed file            > graph neighbor + a keyword match > graph neighbor alone > keyword match(es) alone
 *   CHANGED_FILE_SCORE (20) > GRAPH_NEIGHBOR_SCORE (14) + KEYWORD_MATCH_SCORE (4) = 18 > 14 > 4 each
 * A direct import edge is stronger evidence than any single loose keyword
 * match (e.g. both files mentioning "user"), but weaker than being the
 * literal file under review.
 */
const CHANGED_FILE_SCORE = 20;
const KEYWORD_MATCH_SCORE = 4;
const GRAPH_NEIGHBOR_SCORE = 14;
const GRAPH_NEIGHBOR_KEYWORD_WEIGHT = 4; // findPmTaskRelevantFiles counts in keyword-match units, not raw score.

export function scorePath(
  filePath: string,
  keywords: string[],
  changed: Set<string>,
  graphNeighbors: Map<string, 'importer' | 'importee'>,
): number {
  const normalized = filePath.toLowerCase();
  let score = changed.has(filePath) ? CHANGED_FILE_SCORE : 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) { score += KEYWORD_MATCH_SCORE; }
  }
  if (graphNeighbors.has(filePath)) { score += GRAPH_NEIGHBOR_SCORE; }
  return score;
}

export function reasonForPath(
  filePath: string,
  keywords: string[],
  changed: Set<string>,
  graphNeighbors: Map<string, 'importer' | 'importee'>,
): string {
  if (changed.has(filePath)) { return 'Changed in the current edit scope'; }

  const matches = keywords.filter(k => filePath.toLowerCase().includes(k)).slice(0, 3);
  const relation = graphNeighbors.get(filePath);
  const graphReason = relation === 'importer'
    ? 'Imports a changed file'
    : relation === 'importee'
      ? 'Imported by a changed file'
      : undefined;

  if (graphReason && matches.length) { return `${graphReason}; matches keyword(s): ${matches.join(', ')}`; }
  if (graphReason) { return graphReason; }
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
