import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isSensitivePath } from './codebaseContextService';
import { StaticAnalysisFinding } from './validateReviewTypes';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;
const MAX_FINDINGS = 30;

export type { StaticAnalysisFinding };

export async function collectStaticAnalysis(
  changedFiles: string[],
  opts?: { skipTsc?: boolean; maxFiles?: number },
): Promise<StaticAnalysisFinding[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !changedFiles.length) { return []; }

  const root = folder.uri.fsPath;
  const maxFiles = opts?.maxFiles ?? 20;
  const targets = changedFiles
    .filter(f => !isSensitivePath(f))
    .filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(f))
    .slice(0, maxFiles);
  if (!targets.length) { return []; }

  const results: StaticAnalysisFinding[] = [];
  try {
    results.push(...await runEslint(root, targets));
  } catch { /* silent */ }
  // full tsc is whole-project and times out on large repos
  const skipTsc = opts?.skipTsc === true || changedFiles.length > 20;
  if (!skipTsc && results.length < MAX_FINDINGS) {
    try {
      results.push(...await runTsc(root, targets));
    } catch { /* silent */ }
  }
  return results.slice(0, MAX_FINDINGS);
}

function hasEslintConfig(root: string): boolean {
  return [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  ].some(name => fs.existsSync(path.join(root, name)));
}

async function runEslint(root: string, files: string[]): Promise<StaticAnalysisFinding[]> {
  if (!hasEslintConfig(root)) { return []; }
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern', ...files],
    { cwd: root, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: process.env },
  );
  let parsed: Array<{ filePath?: string; messages?: Array<{ line?: number; ruleId?: string | null; severity?: number; message?: string }> }> = [];
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
  const findings: StaticAnalysisFinding[] = [];
  for (const file of parsed) {
    const rel = file.filePath
      ? path.relative(root, file.filePath).replace(/\\/g, '/')
      : '';
    for (const msg of file.messages || []) {
      if (!rel || !msg.message) { continue; }
      findings.push({
        file: rel,
        line: msg.line || 1,
        ruleId: msg.ruleId || 'eslint',
        severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
        message: String(msg.message).slice(0, 240),
      });
      if (findings.length >= MAX_FINDINGS) { return findings; }
    }
  }
  return findings;
}

function hasTsconfig(root: string): boolean {
  return fs.existsSync(path.join(root, 'tsconfig.json'));
}

async function runTsc(root: string, changedFiles: string[]): Promise<StaticAnalysisFinding[]> {
  if (!hasTsconfig(root)) { return []; }
  const changedSet = new Set(changedFiles.map(f => f.replace(/\\/g, '/')));
  let stderr = '';
  try {
    await execFileAsync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsc', '--noEmit', '--pretty', 'false'],
      { cwd: root, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, env: process.env },
    );
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    stderr = String(e.stderr || e.stdout || '');
  }
  if (!stderr.trim()) { return []; }

  const findings: StaticAnalysisFinding[] = [];
  // e.g. src/foo.ts(12,5): error TS2322: Type 'string' is not assignable...
  const re = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) && findings.length < MAX_FINDINGS) {
    const rel = match[1].replace(/\\/g, '/');
    if (!changedSet.has(rel) && ![...changedSet].some(c => rel.endsWith(c) || c.endsWith(rel))) {
      continue;
    }
    findings.push({
      file: rel,
      line: parseInt(match[2], 10) || 1,
      ruleId: match[4],
      severity: match[3] === 'error' ? 'error' : 'warning',
      message: match[5].slice(0, 240),
    });
  }
  return findings;
}
