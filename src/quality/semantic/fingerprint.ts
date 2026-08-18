/**
 * Function-level fingerprints — the unit of comparison for semantic clone
 * detection.
 *
 * The existing lexical clone detector compares *a file's added lines* against
 * *whole nearby files*. That granularity is why it can only find copy-paste:
 * a reimplemented helper is a few dozen lines inside a big file and drowns in
 * the noise. Everything here is per-function so the comparison is apples to
 * apples, and so a finding can point at a real callable target ("you already
 * have `slugify()` at src/utils/text.ts:12") instead of a file.
 *
 * TS/JS go through the TypeScript compiler (already a dependency). Other
 * languages fall back to a regex normalizer that produces the same shape at
 * lower fidelity — findings from that path are emitted with reduced confidence
 * rather than suppressed, so Python/Go users still get signal.
 */

import * as ts from 'typescript';
import { detectLanguage, extractFileFacts, type SourceLanguage } from '../astFacts';
import {
  MAX_EVIDENCE_LINES,
  fnv1a,
  ngrams,
  normalizeFunction,
  splitIdentifier,
  toMultiset,
  type ControlProfile,
} from './astNormalize';

export interface FunctionFingerprint {
  /** Stable identity: `path#name@line`. */
  id: string;
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  loc: number;
  language: SourceLanguage;
  parser: 'typescript' | 'regex';
  exported: boolean;
  /** Hash of the alpha-renamed structural token stream (Type-2 equality). */
  shapeHash: string;
  /** 4-grams over the shape stream (partial structural overlap). */
  shapeGrams: Set<string>;
  /** Weighted vocabulary of callees / properties / literals / types. */
  apiTokens: Map<string, number>;
  /** Canonicalized identifier concepts. */
  nameTokens: Map<string, number>;
  /** 5-gram shingles over comment-stripped source (copy-paste view). */
  lexGrams: Set<string>;
  control: ControlProfile;
  arity: number;
  isAsync: boolean;
  /** Token -> absolute source line, for pointing a gap report at real code. */
  evidence: Map<string, number>;
  /** Literal tokens the function compares against, rather than emits. */
  guardLiterals: Set<string>;
  /** First lines of the function, for finding evidence. */
  snippet: string;
}

// ── Serialization ───────────────────────────────────────────────────────────
// Fingerprints hold Sets and Maps, which JSON cannot represent. The workspace
// index persists thousands of these, so the wire form is deliberately terse:
// positional arrays, no field names repeated per record.

export type SerializedFingerprint = [
  file: string,
  name: string,
  startLine: number,
  endLine: number,
  language: string,
  parser: string,
  exported: 0 | 1,
  shapeHash: string,
  shapeGrams: string[],
  apiTokens: Array<[string, number]>,
  nameTokens: Array<[string, number]>,
  lexGrams: string[],
  control: number[],
  arity: number,
  isAsync: 0 | 1,
  snippet: string,
  evidence: Array<[string, number]>,
  guardLiterals: string[],
];

const CONTROL_KEYS: Array<keyof ControlProfile> = [
  'loops', 'branches', 'ternaries', 'tryCatch', 'awaits', 'returns', 'throws', 'maxDepth', 'statements',
];

export function serializeFingerprint(fp: FunctionFingerprint): SerializedFingerprint {
  return [
    fp.file, fp.name, fp.startLine, fp.endLine, fp.language, fp.parser,
    fp.exported ? 1 : 0, fp.shapeHash,
    [...fp.shapeGrams], [...fp.apiTokens], [...fp.nameTokens], [...fp.lexGrams],
    CONTROL_KEYS.map(k => fp.control[k]),
    fp.arity, fp.isAsync ? 1 : 0, fp.snippet, [...fp.evidence], [...fp.guardLiterals],
  ];
}

export function deserializeFingerprint(row: SerializedFingerprint): FunctionFingerprint {
  const [
    file, name, startLine, endLine, language, parser, exported, shapeHash,
    shapeGrams, apiTokens, nameTokens, lexGrams, control, arity, isAsync, snippet, evidence, guardLiterals,
  ] = row;

  const profile = {} as ControlProfile;
  CONTROL_KEYS.forEach((key, i) => { profile[key] = control[i] || 0; });

  return {
    id: `${file}#${name}@${startLine}`,
    file,
    name,
    startLine,
    endLine,
    loc: endLine - startLine + 1,
    language: language as SourceLanguage,
    parser: parser === 'typescript' ? 'typescript' : 'regex',
    exported: exported === 1,
    shapeHash,
    shapeGrams: new Set(shapeGrams),
    apiTokens: new Map(apiTokens),
    nameTokens: new Map(nameTokens),
    lexGrams: new Set(lexGrams),
    control: profile,
    arity,
    isAsync: isAsync === 1,
    evidence: new Map(evidence || []),
    guardLiterals: new Set(guardLiterals || []),
    snippet,
  };
}

/** Below this a function is boilerplate (getters, one-line wrappers). */
export const MIN_FINGERPRINT_LOC = 5;
export const MIN_FINGERPRINT_STATEMENTS = 3;

const SHAPE_GRAM_N = 4;
const LEX_GRAM_N = 5;
const MAX_FUNCTIONS_PER_FILE = 120;
const MAX_SNIPPET_LINES = 6;

// ── Public API ──────────────────────────────────────────────────────────────

export interface FingerprintOptions {
  /** Skip functions the diff did not touch (used for the changed side). */
  lineFilter?: (startLine: number, endLine: number) => boolean;
  /** Include short functions. Off by default — they generate noise. */
  includeTrivial?: boolean;
}

export function fingerprintSource(
  path: string,
  content: string,
  options: FingerprintOptions = {},
): FunctionFingerprint[] {
  const language = detectLanguage(path);
  if (language === 'typescript' || language === 'javascript') {
    const viaAst = fingerprintTypeScript(path, content, language, options);
    if (viaAst) return viaAst;
  }
  return fingerprintByHeuristic(path, content, language, options);
}

/**
 * Names declared as methods on an interface or function-typed members of a
 * type literal.
 *
 * These are *contract* names: every implementation of `PmAdapter` is supposed
 * to have an `isConnected`, and those implementations are supposed to resemble
 * each other. Reporting them as duplication punishes correct polymorphism, and
 * it is the single largest false-positive class the detector faces in any
 * codebase with an adapter or plugin layer.
 */
export function extractContractNames(path: string, content: string): string[] {
  const language = detectLanguage(path);
  if (language !== 'typescript' && language !== 'javascript') return [];

  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path, language));
  } catch {
    return [];
  }

  const names = new Set<string>();
  const collectMembers = (members: ts.NodeArray<ts.TypeElement>) => {
    for (const member of members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      const isMethod = ts.isMethodSignature(member)
        || (ts.isPropertySignature(member) && member.type
          && (ts.isFunctionTypeNode(member.type) || ts.isTypeLiteralNode(member.type)));
      if (isMethod) names.add(member.name.text);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node)) {
      collectMembers(node.members);
    } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      collectMembers(node.type.members);
    } else if (ts.isClassDeclaration(node)) {
      // Abstract members are contracts too.
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword)) {
          names.add(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names];
}

/** Convenience: fingerprint many files, tolerating per-file parse failures. */
export function fingerprintFiles(
  files: Array<{ path: string; content: string }>,
  options: FingerprintOptions = {},
): FunctionFingerprint[] {
  const out: FunctionFingerprint[] = [];
  for (const file of files) {
    if (!file?.path || !file.content) continue;
    try {
      out.push(...fingerprintSource(file.path, file.content, options));
    } catch {
      /* one bad file must never fail a review */
    }
  }
  return out;
}

// ── TypeScript / JavaScript path ────────────────────────────────────────────

function scriptKindFor(path: string, language: SourceLanguage): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  return language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function fingerprintTypeScript(
  path: string,
  content: string,
  language: SourceLanguage,
  options: FingerprintOptions,
): FunctionFingerprint[] | null {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path, language));
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const out: FunctionFingerprint[] = [];

  const isExported = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      const mods = (cur as ts.HasModifiers).modifiers;
      if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
      cur = cur.parent;
      if (cur && ts.isSourceFile(cur)) break;
    }
    return false;
  };

  const nameOf = (node: ts.Node): string | null => {
    const named = node as ts.NamedDeclaration;
    if (named.name && ts.isIdentifier(named.name)) return named.name.text;
    // `const foo = () => {}` / `foo: () => {}`
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    return null;
  };

  const visit = (node: ts.Node) => {
    if (out.length >= MAX_FUNCTIONS_PER_FILE) return;

    const isFunctionLike = ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node);

    if (isFunctionLike) {
      const name = nameOf(node);
      if (name) {
        const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const fp = buildTsFingerprint({
          path, language, node, sf, lines, name, startLine, endLine,
          exported: isExported(node), options,
        });
        if (fp) out.push(fp);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

function buildTsFingerprint(args: {
  path: string;
  language: SourceLanguage;
  node: ts.Node;
  sf: ts.SourceFile;
  lines: string[];
  name: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  options: FingerprintOptions;
}): FunctionFingerprint | null {
  const { path, language, node, sf, lines, name, startLine, endLine, exported, options } = args;
  const loc = endLine - startLine + 1;

  if (options.lineFilter && !options.lineFilter(startLine, endLine)) return null;

  const normalized = normalizeFunction(node, sf);
  if (!options.includeTrivial) {
    if (loc < MIN_FINGERPRINT_LOC) return null;
    if (normalized.control.statements < MIN_FINGERPRINT_STATEMENTS) return null;
  }

  const body = lines.slice(startLine - 1, endLine).join('\n');
  const apiTokens = buildApiTokens(normalized.api);
  const nameTokens = toMultiset([...normalized.identifierTokens, ...splitIdentifier(name)]);

  return {
    id: `${path}#${name}@${startLine}`,
    file: path,
    name,
    startLine,
    endLine,
    loc,
    language,
    parser: 'typescript',
    exported,
    shapeHash: normalized.shapeHash,
    shapeGrams: ngrams(normalized.shapeTokens, SHAPE_GRAM_N),
    apiTokens,
    nameTokens,
    lexGrams: ngrams(lexTokens(body), LEX_GRAM_N),
    control: normalized.control,
    arity: normalized.arity,
    isAsync: normalized.isAsync,
    evidence: new Map(normalized.evidenceLines),
    guardLiterals: new Set(normalized.guardLiterals),
    snippet: lines.slice(startLine - 1, Math.min(endLine, startLine - 1 + MAX_SNIPPET_LINES)).join('\n'),
  };
}

/**
 * Namespace the vocabulary so a property named `parse` cannot collide with a
 * call to `parse()`. Calls and literals carry more intent than bare property
 * reads, so they enter the multiset with extra weight before IDF is applied.
 */
function buildApiTokens(api: {
  calls: string[]; props: string[]; literals: string[]; types: string[];
}): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (key: string, weight: number) => m.set(key, (m.get(key) || 0) + weight);
  for (const c of api.calls) bump(`call:${c}`, 2);
  for (const p of api.props) bump(`prop:${p}`, 1);
  for (const l of api.literals) bump(`lit:${l}`, 3);
  for (const t of api.types) bump(`type:${t}`, 1);
  return m;
}

// ── Heuristic path (Python, Go, anything without a real parser) ─────────────

const KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'while', 'return', 'def', 'func', 'class', 'try',
  'except', 'catch', 'finally', 'import', 'from', 'const', 'let', 'var', 'new',
  'async', 'await', 'function', 'range', 'len', 'nil', 'null', 'true', 'false',
  'not', 'and', 'or', 'in', 'is', 'raise', 'throw', 'switch', 'case', 'default',
  'break', 'continue', 'with', 'as', 'pass', 'yield', 'type', 'struct', 'err',
]);

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/#.*$/gm, ' ');
}

function lexTokens(text: string): string[] {
  return stripComments(text)
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter(t => t.length > 2);
}

function fingerprintByHeuristic(
  path: string,
  content: string,
  language: SourceLanguage,
  options: FingerprintOptions,
): FunctionFingerprint[] {
  const facts = extractFileFacts(path, content);
  const out: FunctionFingerprint[] = [];

  for (const fn of facts.functions.slice(0, MAX_FUNCTIONS_PER_FILE)) {
    if (options.lineFilter && !options.lineFilter(fn.startLine, fn.endLine)) continue;
    const loc = fn.endLine - fn.startLine + 1;
    if (!options.includeTrivial && loc < MIN_FINGERPRINT_LOC) continue;

    const clean = stripComments(fn.body);
    const control = heuristicControlProfile(clean);
    if (!options.includeTrivial && control.statements < MIN_FINGERPRINT_STATEMENTS) continue;

    const calls: string[] = [];
    const props: string[] = [];
    const literals: string[] = [];
    const identifiers: string[] = [...splitIdentifier(fn.name)];
    const evidence = new Map<string, number>();
    // Offset within the cleaned body -> absolute file line.
    const lineAt = (offset: number) =>
      fn.startLine + clean.slice(0, offset).split('\n').length - 1;
    const note = (token: string, offset: number) => {
      if (!evidence.has(token) && evidence.size < MAX_EVIDENCE_LINES) {
        evidence.set(token, lineAt(offset));
      }
    };

    for (const m of clean.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (KEYWORDS.has(m[1])) continue;
      calls.push(m[1]);
      identifiers.push(...splitIdentifier(m[1]));
      note(`call:${m[1]}`, m.index ?? 0);
    }
    for (const m of clean.matchAll(/\.([A-Za-z_$][\w$]*)/g)) {
      props.push(m[1]);
      identifiers.push(...splitIdentifier(m[1]));
    }
    for (const m of clean.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const v = m[2];
      if (!v) continue;
      const lit = v.length > 24 ? `str#${Math.floor(Math.log2(v.length))}` : `str:${v.toLowerCase()}`;
      literals.push(lit);
      note(`lit:${lit}`, m.index ?? 0);
    }
    for (const m of clean.matchAll(/\b(\d+(?:\.\d+)?)\b/g)) {
      const value = Number(m[1]);
      if (![0, 1, 2, 100].includes(value)) {
        literals.push(`num:${value}`);
        note(`lit:num:${value}`, m.index ?? 0);
      }
    }

    // Alpha-renamed shape stream: keywords and punctuation survive, every other
    // identifier collapses to a slot keyed by first appearance.
    const slots = new Map<string, string>();
    const shapeTokens = (clean.match(/[A-Za-z_$][\w$]*|[^\sA-Za-z0-9_$]/g) || []).map(tok => {
      if (!/^[A-Za-z_$]/.test(tok)) return tok;
      if (KEYWORDS.has(tok.toLowerCase())) return tok.toLowerCase();
      let slot = slots.get(tok);
      if (!slot) {
        slot = `$v${slots.size}`;
        slots.set(tok, slot);
      }
      return slot;
    });

    out.push({
      id: `${path}#${fn.name}@${fn.startLine}`,
      file: path,
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      loc,
      language,
      parser: 'regex',
      exported: facts.exports.some(e => e.name === fn.name),
      shapeHash: fnv1a(shapeTokens.join('|')),
      shapeGrams: ngrams(shapeTokens, SHAPE_GRAM_N),
      apiTokens: buildApiTokens({ calls, props, literals, types: [] }),
      nameTokens: toMultiset(identifiers),
      lexGrams: ngrams(lexTokens(fn.body), LEX_GRAM_N),
      control,
      arity: (fn.body.match(/^[^(]*\(([^)]*)\)/)?.[1] || '').split(',').filter(s => s.trim()).length,
      isAsync: /\basync\b/.test(fn.body.slice(0, 200)),
      evidence,
      // The regex path has no reliable notion of syntactic position, so no
      // literal is promoted to a guard. Gap reports there stay conservative.
      guardLiterals: new Set<string>(),
      snippet: fn.body.split('\n').slice(0, MAX_SNIPPET_LINES).join('\n'),
    });
  }

  return out;
}

function heuristicControlProfile(clean: string): ControlProfile {
  const count = (re: RegExp) => (clean.match(re) || []).length;
  const lines = clean.split('\n').filter(l => l.trim());
  let maxDepth = 0;
  let depth = 0;
  for (const ch of clean) {
    if (ch === '{') { depth++; maxDepth = Math.max(maxDepth, depth); }
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  if (!maxDepth) {
    // Indentation-scoped languages (Python): depth from leading whitespace.
    for (const line of lines) {
      const indent = (line.match(/^[ \t]*/)?.[0].length || 0) / 2;
      maxDepth = Math.max(maxDepth, Math.round(indent));
    }
  }
  return {
    loops: count(/\b(for|while)\b/g),
    branches: count(/\b(if|elif|case)\b/g),
    ternaries: count(/\?[^?:]*:/g),
    tryCatch: count(/\b(try|catch|except)\b/g),
    awaits: count(/\bawait\b/g),
    returns: count(/\breturn\b/g),
    throws: count(/\b(throw|raise)\b/g),
    maxDepth,
    statements: lines.length,
  };
}
