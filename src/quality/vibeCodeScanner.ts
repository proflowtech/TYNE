/**
 * AI "vibe code" / slop scanner — 20+ deterministic signals.
 * Regex + light AST facts (extractFileFacts). # ponytail: heuristics, not ML.
 */
import { extractFileFacts, type FileFacts } from './astFacts';
import type { QualityFinding } from './qualityTypes';

const TEST_FILE = /(^|\/|\.)(test|spec)\.[a-z0-9]+$/i;
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|py)$/i;

const SLOP_WEIGHTS: Record<string, number> = {
  debugger: 20,
  empty_catch: 8,
  missing_await: 10,
  unhandled_promise: 8,
  orphaned_function: 5,
  unresolved_import: 7,
  todo: 4,
  placeholder: 6,
  generic_error: 5,
  console_log: 3,
  magic_number: 2,
  duplicated_code: 7,
  over_commented: 4,
  inconsistent_naming: 5,
  unvalidated_param: 6,
  ts_ignore: 6,
  eslint_disable: 4,
  fake_success: 12,
  unused_import: 4,
};

// ── AiSlopSignals (structured output) ────────────────────────────────────────

export interface SlopLineRef {
  file: string;
  line: number;
  fix?: string;
}

export interface AiSlopSignals {
  todos: Array<SlopLineRef & { type: string; text: string }>;
  placeholders: Array<SlopLineRef & { value: string }>;
  orphaned_functions: Array<SlopLineRef & { function: string }>;
  empty_catches: SlopLineRef[];
  unresolved_imports: Array<SlopLineRef & { module: string }>;
  console_logs: Array<SlopLineRef & { message: string }>;
  debugger_statements: SlopLineRef[];
  generic_errors: Array<SlopLineRef & { message: string }>;
  unvalidated_params: Array<SlopLineRef & { function: string; param: string }>;
  async_issues: Array<SlopLineRef & { type: 'missing_await' | 'unhandled_promise'; code: string }>;
  magic_numbers: Array<SlopLineRef & { value: number; context: string; explanation_needed: boolean }>;
  duplicated_code: Array<SlopLineRef & { duplicate_of: string }>;
  over_commented: Array<SlopLineRef & { comment_ratio: number }>;
  inconsistent_naming: Array<{ file: string; variants: string[]; fix?: string }>;
  slop_score: number;
  verdict: string;
}

function emptySignals(): AiSlopSignals {
  return {
    todos: [],
    placeholders: [],
    orphaned_functions: [],
    empty_catches: [],
    unresolved_imports: [],
    console_logs: [],
    debugger_statements: [],
    generic_errors: [],
    unvalidated_params: [],
    async_issues: [],
    magic_numbers: [],
    duplicated_code: [],
    over_commented: [],
    inconsistent_naming: [],
    slop_score: 0,
    verdict: 'Low slop risk',
  };
}

function scoreSignals(s: AiSlopSignals): number {
  let score = 0;
  score += s.debugger_statements.length * SLOP_WEIGHTS.debugger;
  score += s.empty_catches.length * SLOP_WEIGHTS.empty_catch;
  score += s.async_issues.filter(a => a.type === 'missing_await').length * SLOP_WEIGHTS.missing_await;
  score += s.async_issues.filter(a => a.type === 'unhandled_promise').length * SLOP_WEIGHTS.unhandled_promise;
  score += s.orphaned_functions.length * SLOP_WEIGHTS.orphaned_function;
  score += s.unresolved_imports.length * SLOP_WEIGHTS.unresolved_import;
  score += s.todos.length * SLOP_WEIGHTS.todo;
  score += s.placeholders.length * SLOP_WEIGHTS.placeholder;
  score += s.generic_errors.length * SLOP_WEIGHTS.generic_error;
  score += s.console_logs.length * SLOP_WEIGHTS.console_log;
  score += s.magic_numbers.length * SLOP_WEIGHTS.magic_number;
  score += s.duplicated_code.length * SLOP_WEIGHTS.duplicated_code;
  score += s.over_commented.length * SLOP_WEIGHTS.over_commented;
  score += s.inconsistent_naming.length * SLOP_WEIGHTS.inconsistent_naming;
  score += s.unvalidated_params.length * SLOP_WEIGHTS.unvalidated_param;
  return Math.min(100, score);
}

function verdictFor(score: number): string {
  if (score > 50) return 'High AI generation risk - review manually';
  if (score > 25) return 'Moderate slop signals - spot check recommended';
  return 'Low slop risk';
}

function resolveRelative(fromFile: string, spec: string): string {
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || !seg) continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return /^\/\//.test(t) || /^\/\*/.test(t) || /^\*/.test(t) || /^#/.test(t);
}

function tokenize(text: string): string[] {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .toLowerCase().split(/[^a-z0-9_$]+/).filter(t => t.length > 2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function shingles(tokens: string[], n = 5): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) set.add(tokens.slice(i, i + n).join(' '));
  return set;
}

/** Core slop scan over full file contents. */
export function scanForAiSlopSync(
  files: Record<string, string>,
  knownFiles: Set<string> = new Set(Object.keys(files)),
): AiSlopSignals {
  const s = emptySignals();
  const paths = Object.keys(files).filter(p => CODE_EXT.test(p));
  if (!paths.length) return s;

  const allFacts: FileFacts[] = paths.map(p => extractFileFacts(p, files[p] || ''));
  const allText = paths.map(p => files[p]).join('\n');
  const functionDefs: Array<{ file: string; name: string; line: number; exported: boolean; body: string }> = [];

  for (const facts of allFacts) {
    const content = files[facts.path] || '';
    const lines = content.split(/\r?\n/);
    const isTest = TEST_FILE.test(facts.path);
    const exportNames = new Set(facts.exports.map(e => e.name));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      if (isCommentLine(line)) continue;
      const trimmed = line.trim();

      const todoM = line.match(/(TODO|FIXME|XXX|HACK|BUG)\s*[:]*\s*(.+)/i);
      if (todoM) {
        s.todos.push({
          file: facts.path, line: lineNum, type: todoM[1].toUpperCase(),
          text: todoM[2].trim().slice(0, 120),
          fix: 'Resolve or ticket the TODO before merge.',
        });
      }

      if (/["'](placeholder|temp|dummy)["']/i.test(line) || (/["']test["']/i.test(line) && !isTest)) {
        s.placeholders.push({
          file: facts.path, line: lineNum,
          value: trimmed.match(/["'](\w+)["']/)?.[1] || 'placeholder',
          fix: 'Replace placeholder string with real value or config.',
        });
      }

      if (/debugger\s*;/.test(line)) {
        s.debugger_statements.push({
          file: facts.path, line: lineNum,
          fix: 'Remove debugger statement before commit.',
        });
      }

      if (!isTest && /console\.(log|debug|info)\s*\(/.test(line)) {
        s.console_logs.push({
          file: facts.path, line: lineNum, message: trimmed.slice(0, 80),
          fix: 'Remove debug logging or use a structured logger.',
        });
      }

      if (/throw\s+new\s+Error\s*\(\s*["'](error|failed|something went wrong|unknown error)["']\s*\)/i.test(line)) {
        s.generic_errors.push({
          file: facts.path, line: lineNum,
          message: trimmed.slice(0, 80),
          fix: 'Use a specific error message with context.',
        });
      }

      const magicM = line.match(/(?:^|[^\w.])(\d{3,})(?:[^\w.]|$)/);
      if (magicM && !/\/\/|\/\*|\* /.test(line.slice(0, line.indexOf(magicM[1])))
        && !/^\s*(const|let|var|enum)\s+\w+\s*=/.test(line)) {
        s.magic_numbers.push({
          file: facts.path, line: lineNum,
          value: Number(magicM[1]),
          context: trimmed.slice(0, 60),
          explanation_needed: true,
          fix: 'Extract magic number to a named constant.',
        });
      }

      if (/(?:^|[^\w])await\s+\w/.test(line)) { /* ok */ } else {
        const missAwait = line.match(/\b(fetch(?:\w*)|load(?:\w*)|save(?:\w*)|get(?:Data|User|Item)\w*)\s*\(/);
        if (missAwait && !/^\s*\/\//.test(line) && !/\.catch\s*\(/.test(line)) {
          s.async_issues.push({
            file: facts.path, line: lineNum, type: 'missing_await',
            code: missAwait[0],
            fix: `await ${missAwait[1]}(...)`,
          });
        }
      }

      if (/\)\s*;?\s*$/.test(line) && /\b(fetch|axios\.\w+|\.then)\s*\(/.test(line)
        && !/\bawait\b/.test(line) && !/\.catch\s*\(/.test(line)) {
        s.async_issues.push({
          file: facts.path, line: lineNum, type: 'unhandled_promise',
          code: trimmed.slice(0, 60),
          fix: 'Add await, .catch(), or void operator with explicit handling.',
        });
      }

      if (/@ts-ignore|@ts-nocheck/.test(line)) {
        s.todos.push({
          file: facts.path, line: lineNum, type: 'TS_IGNORE',
          text: trimmed,
          fix: 'Fix the type error instead of suppressing it.',
        });
      }

      if (/eslint-disable(?!.*reason)/i.test(line)) {
        s.todos.push({
          file: facts.path, line: lineNum, type: 'ESLINT_DISABLE',
          text: trimmed.slice(0, 80),
          fix: 'Fix lint issue or document why disable is required.',
        });
      }
    }

    // Empty catch (multiline)
    const catchRe = /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/g;
    let cm: RegExpExecArray | null;
    while ((cm = catchRe.exec(content)) !== null) {
      const line = content.slice(0, cm.index).split(/\r?\n/).length;
      s.empty_catches.push({
        file: facts.path, line,
        fix: 'Log, handle, or rethrow the error — do not swallow silently.',
      });
    }

    for (const fn of facts.functions) {
      const exported = exportNames.has(fn.name) || /^use[A-Z]/.test(fn.name)
        || /^handle[A-Z]/.test(fn.name) || /^on[A-Z]/.test(fn.name);
      functionDefs.push({
        file: facts.path, name: fn.name, line: fn.startLine,
        exported, body: fn.body,
      });

      if (!exported && fn.name !== 'main') {
        const callRe = new RegExp(`\\b${fn.name}\\s*\\(`, 'g');
        const callsInOthers = paths.filter(p => p !== facts.path)
          .some(p => callRe.test(files[p] || ''));
        const callsInSelf = (content.match(callRe) || []).length > 1;
        if (!callsInOthers && !callsInSelf) {
          s.orphaned_functions.push({
            file: facts.path, line: fn.startLine, function: fn.name,
            fix: 'Remove dead code or wire the function into the call graph.',
          });
        }
      }

      const params = fn.body.match(/(?:function\s+\w+|def\s+\w+)\s*\(([^)]*)\)/)?.[1]
        || fn.body.match(/(?:async\s+)?(?:function\s+)?\w+\s*\(([^)]*)\)/)?.[1];
      if (params) {
        for (const raw of params.split(',')) {
          const param = raw.trim().split(/[:=]/)[0].replace(/\.\.\./, '').trim();
          if (!param || param.length < 2 || param === '_') continue;
          const bodySlice = fn.body.split('\n').slice(0, 12).join('\n');
          const guarded = new RegExp(`if\\s*\\(!\\s*${param}|${param}\\?\\.|typeof\\s+${param}|${param}\\s*===\\s*undefined`).test(bodySlice);
          const used = new RegExp(`\\b${param}\\b`).test(bodySlice.replace(/\([^)]*\)/, ''));
          if (used && !guarded && !/^\*/.test(bodySlice)) {
            s.unvalidated_params.push({
              file: facts.path, line: fn.startLine, function: fn.name, param,
              fix: `Validate "${param}" at the start of ${fn.name}().`,
            });
          }
        }
      }
    }

    for (const imp of facts.imports) {
      if (!imp.module.startsWith('.')) continue;
      const resolved = resolveRelative(facts.path, imp.module);
      const exists = [...knownFiles].some(p =>
        p === resolved || p.startsWith(resolved + '.') || p.replace(/\.[^.]+$/, '') === resolved);
      if (!exists) {
        s.unresolved_imports.push({
          file: facts.path, line: imp.line, module: imp.module,
          fix: 'Verify import path exists in the workspace.',
        });
      }

      const named = imp.raw.match(/import\s+\{([^}]+)\}/)?.[1];
      if (named) {
        for (const sym of named.split(',').map(x => x.trim().split(/\s+as\s+/).pop()!.trim())) {
          if (sym && !new RegExp(`\\b${sym}\\b`).test(content.replace(imp.raw, ''))) {
            s.todos.push({
              file: facts.path, line: imp.line, type: 'UNUSED_IMPORT',
              text: sym,
              fix: `Remove unused import "${sym}".`,
            });
          }
        }
      }
    }

    const codeLines = lines.filter(l => l.trim() && !isCommentLine(l));
    const commentLines = lines.filter(l => /^\s*(\/\/|\/\*|\*)/.test(l));
    if (codeLines.length >= 8 && commentLines.length / codeLines.length > 0.45) {
      s.over_commented.push({
        file: facts.path, line: 1,
        comment_ratio: Math.round((commentLines.length / codeLines.length) * 100) / 100,
        fix: 'Reduce narrating comments; keep only non-obvious intent.',
      });
    }

    if (/return\s+true\s*;?\s*$/.test(content) && /\/\/\s*(fake|stub|placeholder|for now)/im.test(content)) {
      s.placeholders.push({
        file: facts.path, line: facts.functions[0]?.startLine || 1,
        value: 'fake_success',
        fix: 'Return real operation results instead of hardcoded success.',
      });
    }
  }

  // Duplicated blocks across files in this PR
  const fileBlocks = paths.map(p => ({ path: p, sh: shingles(tokenize(files[p] || ''), 5) }));
  for (let i = 0; i < fileBlocks.length; i++) {
    for (let j = i + 1; j < fileBlocks.length; j++) {
      if (jaccard(fileBlocks[i].sh, fileBlocks[j].sh) >= 0.72 && fileBlocks[i].sh.size >= 8) {
        s.duplicated_code.push({
          file: fileBlocks[i].path, line: 1, duplicate_of: fileBlocks[j].path,
          fix: 'Extract shared logic into one helper instead of copy-paste.',
        });
      }
    }
  }

  // Inconsistent naming: userId vs user_id vs userID in same codebase
  const variants = new Map<string, Set<string>>();
  const idents = allText.match(/\b([a-z]+[_][a-z0-9_]+|[a-z]+Id|[a-z]+ID)\b/g) || [];
  for (const id of idents) {
    const stem = id.toLowerCase().replace(/_/g, '').replace(/id$/i, '');
    if (stem.length < 4) continue;
    if (!variants.has(stem)) variants.set(stem, new Set());
    variants.get(stem)!.add(id);
  }
  for (const [stem, names] of variants) {
    if (names.size >= 2) {
      const hasSnake = [...names].some(n => n.includes('_'));
      const hasCamel = [...names].some(n => /[a-z]Id$/.test(n));
      if (hasSnake && hasCamel) {
        s.inconsistent_naming.push({
          file: paths[0],
          variants: [...names],
          fix: `Pick one naming style for "${stem}" (${[...names].join(' vs ')}).`,
        });
      }
    }
  }

  s.slop_score = scoreSignals(s);
  s.verdict = verdictFor(s.slop_score);
  return s;
}

/** Async wrapper (all work is sync; API for harness compatibility). */
export async function scanForAiSlop(
  files: Record<string, string>,
  knownFiles?: Set<string>,
): Promise<AiSlopSignals> {
  return scanForAiSlopSync(files, knownFiles);
}

function slopToFindings(slop: AiSlopSignals, diffLineFilter?: Set<string>): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const inDiff = (file: string, line: number) =>
    !diffLineFilter || diffLineFilter.has(`${file}:${line}`);

  const push = (f: Omit<Parameters<typeof make>[0], 'text'> & { text?: string }) => {
    if (diffLineFilter && f.line && !inDiff(f.file, f.line)) return;
    findings.push(make({ ...f, text: f.text || f.title }));
  };

  for (const t of slop.todos) {
    push({
      ruleId: t.type === 'UNUSED_IMPORT' ? 'VIBE_UNUSED_IMPORT' : 'VIBE_PLACEHOLDER',
      subcategory: t.type === 'UNUSED_IMPORT' ? 'unused_export' : 'placeholder',
      file: t.file, line: t.line, severity: 'high',
      title: `${t.type}: ${t.text.slice(0, 60)}`,
      explanation: t.text,
      suggestedFix: t.fix || 'Clean up before merge.',
      blocking: t.type === 'TS_IGNORE',
      debtMinutes: 20,
      text: t.text,
    });
  }
  for (const p of slop.placeholders) {
    push({
      ruleId: 'VIBE_PLACEHOLDER', subcategory: 'placeholder',
      file: p.file, line: p.line, severity: 'high',
      title: `Placeholder value: ${p.value}`,
      explanation: 'Placeholder or stub string in production path.',
      suggestedFix: p.fix || 'Replace with real data.',
      blocking: true, debtMinutes: 40, text: p.value,
    });
  }
  for (const c of slop.empty_catches) {
    push({
      ruleId: 'VIBE_EMPTY_CATCH', subcategory: 'empty_catch',
      file: c.file, line: c.line, severity: 'high',
      title: 'Empty catch swallows errors',
      explanation: 'Silent catch hides failures — common AI-generated pattern.',
      suggestedFix: c.fix || 'Handle the error explicitly.',
      blocking: false, debtMinutes: 20,
    });
  }
  for (const cl of slop.console_logs) {
    push({
      ruleId: 'VIBE_CONSOLE', subcategory: 'console_leftover',
      file: cl.file, line: cl.line, severity: 'low',
      title: 'Console leftover in non-test code',
      explanation: cl.message,
      suggestedFix: cl.fix || 'Remove debug log.',
      blocking: false, debtMinutes: 5, text: cl.message,
    });
  }
  for (const d of slop.debugger_statements) {
    push({
      ruleId: 'VIBE_DEBUGGER', subcategory: 'console_leftover',
      file: d.file, line: d.line, severity: 'critical',
      title: 'Debugger statement left in code',
      explanation: 'debugger; must not ship.',
      suggestedFix: d.fix || 'Remove debugger.',
      blocking: true, debtMinutes: 5,
    });
  }
  for (const u of slop.unresolved_imports) {
    push({
      ruleId: 'VIBE_HALLUCINATED_IMPORT', subcategory: 'hallucinated_import',
      file: u.file, line: u.line, severity: 'high',
      title: `Import may not resolve: ${u.module}`,
      explanation: 'Relative import not found among known files.',
      suggestedFix: u.fix || 'Fix import path.',
      blocking: false, debtMinutes: 30, confidence: 'medium',
      text: u.module,
    });
  }
  for (const a of slop.async_issues) {
    push({
      ruleId: a.type === 'missing_await' ? 'VIBE_MISSING_AWAIT' : 'VIBE_UNHANDLED_PROMISE',
      subcategory: 'placeholder',
      file: a.file, line: a.line, severity: 'high',
      title: a.type === 'missing_await' ? 'Missing await on async call' : 'Unhandled promise',
      explanation: a.code,
      suggestedFix: a.fix || 'Add await or error handling.',
      blocking: false, debtMinutes: 25, text: a.code,
    });
  }

  return dedupe(findings).slice(0, 40);
}

/** Diff-scoped vibe scan (quality engine entry). */
export function scanVibeCode(input: {
  diff: string;
  fileFacts: FileFacts[];
}): QualityFinding[] {
  const files: Record<string, string> = {};
  for (const f of input.fileFacts) {
    files[f.path] = f.lines.join('\n');
  }
  if (!Object.keys(files).length && input.diff) {
    Object.assign(files, filesFromDiff(input.diff));
  }
  const known = new Set(Object.keys(files).length ? Object.keys(files) : input.fileFacts.map(f => f.path));
  const diffKeys = new Set(parseDiffKeys(input.diff).map(r => `${r.file}:${r.line}`));
  const slop = scanForAiSlopSync(files, known);
  return slopToFindings(slop, diffKeys.size ? diffKeys : undefined);
}

function filesFromDiff(diff: string): Record<string, string> {
  const byFile: Record<string, string[]> = {};
  let file = 'unknown';
  for (const rawLine of String(diff || '').split(/\r?\n/)) {
    const fm = rawLine.match(/^\+\+\+\s+b\/(.+)$/);
    if (fm) { file = fm[1]; continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      (byFile[file] ||= []).push(rawLine.slice(1));
    }
  }
  return Object.fromEntries(Object.entries(byFile).map(([k, v]) => [k, v.join('\n')]));
}

function parseDiffKeys(diff: string): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
  let file = 'unknown';
  let newLine = 0;
  for (const rawLine of String(diff || '').split(/\r?\n/)) {
    const fm = rawLine.match(/^\+\+\+\s+b\/(.+)$/);
    if (fm) { file = fm[1]; continue; }
    const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) { newLine = Number(hunk[1]) || 0; continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      out.push({ file, line: newLine || 1 });
      newLine++;
    } else if (!rawLine.startsWith('-') && newLine) newLine++;
  }
  return out;
}

function make(input: {
  ruleId: string;
  subcategory: QualityFinding['subcategory'];
  file: string;
  line?: number;
  text: string;
  severity: QualityFinding['severity'];
  title: string;
  explanation: string;
  suggestedFix: string;
  blocking: boolean;
  debtMinutes: number;
  confidence?: QualityFinding['confidence'];
}): QualityFinding {
  return {
    id: `${input.ruleId}:${input.file}:${input.line || 0}`,
    ruleId: input.ruleId,
    subcategory: input.subcategory,
    category: 'vibe_code',
    severity: input.severity,
    confidence: input.confidence || 'high',
    title: input.title,
    explanation: input.explanation,
    file: input.file,
    line: input.line,
    evidence: input.text.slice(0, 200),
    suggestedFix: input.suggestedFix,
    detectedBy: 'ast_rule',
    blocking: input.blocking,
    debtMinutes: input.debtMinutes,
  };
}

function dedupe(findings: QualityFinding[]): QualityFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.ruleId}:${f.file}:${f.line}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
