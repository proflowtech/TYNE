/**
 * Language-agnostic AST facts from source text.
 * Prefer: Tree-Sitter (when media/tree-sitter/*.wasm present) → TypeScript
 * compiler API (TS/JS) → regex heuristics.
 */

import { extractTsCompilerFacts, type SignatureFact } from './tsCompilerAst';

export type SourceLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'unknown';

export interface FunctionFact {
  name: string;
  startLine: number;
  endLine: number;
  body: string;
  language: SourceLanguage;
}

export interface ImportFact {
  raw: string;
  module: string;
  line: number;
  language: SourceLanguage;
}

export interface ExportFact {
  name: string;
  line: number;
}

export interface FileFacts {
  path: string;
  language: SourceLanguage;
  lines: string[];
  functions: FunctionFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  /** Type/function signatures when a real AST was used. */
  signatures?: SignatureFact[];
  /** Which extractor produced the facts. */
  parser?: 'tree-sitter' | 'typescript' | 'regex';
}

export function detectLanguage(filePath: string): SourceLanguage {
  if (/\.tsx?$/i.test(filePath)) return 'typescript';
  if (/\.(jsx?|mjs|cjs)$/i.test(filePath)) return 'javascript';
  if (/\.py$/i.test(filePath)) return 'python';
  if (/\.go$/i.test(filePath)) return 'go';
  return 'unknown';
}

export function extractFileFacts(path: string, content: string): FileFacts {
  const language = detectLanguage(path);
  const lines = String(content || '').split(/\r?\n/);
  const text = String(content || '');

  // Real AST via TypeScript compiler for TS/JS (web-tree-sitter used async when WASM present).
  const compiled = extractTsCompilerFacts(path, text, language);
  if (compiled) {
    return {
      path,
      language,
      lines,
      functions: compiled.functions,
      imports: compiled.imports,
      exports: compiled.exports,
      signatures: compiled.signatures,
      parser: 'typescript',
    };
  }

  return {
    path,
    language,
    lines,
    functions: extractFunctions(lines, language),
    imports: extractImports(lines, language),
    exports: extractExports(lines, language),
    parser: 'regex',
  };
}

/** Async path: Tree-Sitter when grammar WASM is installed under media/tree-sitter/. */
export async function extractFileFactsAsync(path: string, content: string): Promise<FileFacts> {
  const language = detectLanguage(path);
  const lines = String(content || '').split(/\r?\n/);
  try {
    const { parseWithTreeSitter } = await import('./treeSitterRuntime');
    const nodes = await parseWithTreeSitter(language, content);
    if (nodes?.length) {
      const functions: FunctionFact[] = nodes
        .filter(n => /function|method|class|arrow/.test(n.type))
        .map(n => ({
          name: n.name,
          startLine: n.startLine,
          endLine: n.endLine,
          body: n.text,
          language,
        }))
        .slice(0, 40);
      const imports: ImportFact[] = nodes
        .filter(n => /import/.test(n.type))
        .map(n => {
          const m = n.text.match(/from\s+['"]([^'"]+)['"]/) || n.text.match(/import\s+['"]([^'"]+)['"]/);
          return { raw: n.text.split('\n')[0].slice(0, 200), module: m?.[1] || '', line: n.startLine, language };
        })
        .filter(i => i.module)
        .slice(0, 80);
      const signatures: SignatureFact[] = nodes
        .filter(n => /interface|type_alias|function|class/.test(n.type))
        .map(n => ({
          name: n.name,
          kind: /interface/.test(n.type) ? 'interface' as const
            : /type/.test(n.type) ? 'type' as const
              : /class/.test(n.type) ? 'class' as const
                : 'function' as const,
          signature: n.text.split('\n')[0].slice(0, 240),
          line: n.startLine,
        }))
        .slice(0, 40);
      if (functions.length || imports.length) {
        return {
          path,
          language,
          lines,
          functions,
          imports,
          exports: signatures.filter(s => s.kind !== 'function').map(s => ({ name: s.name, line: s.line })),
          signatures,
          parser: 'tree-sitter',
        };
      }
    }
  } catch {
    /* fall through */
  }
  return extractFileFacts(path, content);
}

function extractFunctions(lines: string[], language: SourceLanguage): FunctionFact[] {
  const out: FunctionFact[] = [];
  if (language === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)def\s+([A-Za-z_][\w]*)\s*\(/);
      if (!m) continue;
      const indent = m[1].length;
      let end = i + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (line.trim() && !line.startsWith(' '.repeat(indent + 1)) && !line.startsWith('\t') && !/^\s*#/.test(line)) {
          if (/^(\s*)def\s+|^\s*class\s+|^\S/.test(line) && (line.match(/^(\s*)/)?.[1].length || 0) <= indent) break;
        }
        end++;
        if (end - i > 400) break;
      }
      out.push({
        name: m[2],
        startLine: i + 1,
        endLine: end,
        body: lines.slice(i, end).join('\n'),
        language,
      });
    }
    return out.slice(0, 40);
  }

  if (language === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/);
      if (!m) continue;
      let depth = 0;
      let started = false;
      let end = i;
      for (let j = i; j < lines.length && j < i + 400; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          if (ch === '}') depth--;
        }
        end = j;
        if (started && depth <= 0) break;
      }
      out.push({
        name: m[1],
        startLine: i + 1,
        endLine: end + 1,
        body: lines.slice(i, end + 1).join('\n'),
        language,
      });
    }
    return out.slice(0, 40);
  }

  // TS/JS
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /(?:(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|(?:export\s+)?class\s+([A-Za-z_$][\w$]*))/,
    );
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || 'anonymous';
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length && j < i + 400; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      end = j;
      if (started && depth <= 0) break;
      // arrow one-liners
      if (!started && /=>/.test(lines[j]) && !/\{/.test(lines[j])) {
        end = j;
        break;
      }
    }
    out.push({
      name,
      startLine: i + 1,
      endLine: end + 1,
      body: lines.slice(i, end + 1).join('\n'),
      language,
    });
  }
  return out.slice(0, 40);
}

function extractImports(lines: string[], language: SourceLanguage): ImportFact[] {
  const out: ImportFact[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let module = '';
    if (language === 'python') {
      const m = line.match(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/);
      module = (m?.[1] || m?.[2] || '').trim();
    } else if (language === 'go') {
      const m = line.match(/^\s*"([^"]+)"\s*$/) || line.match(/import\s+"([^"]+)"/);
      module = m?.[1] || '';
    } else {
      const m = line.match(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/)
        || line.match(/^\s*import\s+['"]([^'"]+)['"]/)
        || line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
      module = m?.[1] || '';
    }
    if (module) out.push({ raw: line.trim(), module, line: i + 1, language });
  }
  return out.slice(0, 80);
}

function extractExports(lines: string[], language: SourceLanguage): ExportFact[] {
  const out: Array<{ name: string; line: number }> = [];
  if (language === 'python' || language === 'go') return out;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/export\s+(?:async\s+)?(?:function|const|class|let|var|type|interface)\s+([A-Za-z_$][\w$]*)/);
    if (m) out.push({ name: m[1], line: i + 1 });
  }
  return out.slice(0, 40);
}

/** Changed + context lines from a unified diff. */
export function changedLinesFromDiff(diff: string): Array<{ file: string; line?: number; text: string }> {
  const rows: Array<{ file: string; line?: number; text: string }> = [];
  let file = 'unknown';
  let newLine = 0;
  for (const rawLine of String(diff || '').split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch) { file = fileMatch[1]; continue; }
    const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) { newLine = Number(hunk[1]) || 0; continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      rows.push({ file, line: newLine || undefined, text: rawLine.slice(1) });
      newLine++;
    } else if (!rawLine.startsWith('-') && newLine) {
      newLine++;
    }
  }
  return rows;
}
