/**
 * Detects real side-effect call sites — database access, LLM calls, and other
 * external I/O — in TypeScript/JavaScript source, using the TypeScript compiler
 * AST (already a project dependency; no new deps, no bundler).
 *
 * Philosophy: the architecture chart is a *claim* about the code. A database or
 * LLM node must be backed by an actual call site we can point at, not inferred
 * from a filename or guessed by a model. Every EffectSite carries the file and
 * line of its evidence so the UI can jump straight to it. If a changed file
 * issues no such call, it contributes no effect node — honest omission beats a
 * connection that may not exist.
 */

import * as ts from 'typescript';
import { detectLanguage } from './astFacts';

export type EffectKind = 'database' | 'llm' | 'external';

export interface EffectSite {
  /** Workspace-relative path of the file containing the call. */
  file: string;
  /** 1-based line of the call site — the evidence. */
  line: number;
  /** Enclosing function/method name, when the call sits inside one. */
  functionName?: string;
  kind: EffectKind;
  /** What is being reached: a table, an RPC, a provider, a host. */
  target: string;
  /** A short human verb for the edge label: "queries", "calls", "fetches". */
  verb: string;
  /** The offending call, trimmed — shown on hover / in the inspector. */
  evidence: string;
}

const DB_BASE_IDENTS = new Set(['supabase', 'db', 'client', 'knex', 'trx', 'sql', 'pool', 'conn', 'database']);
const DB_CHAIN_VERBS = new Set(['insert', 'upsert', 'update', 'delete', 'select', 'delete']);
const PRISMA_VERBS = new Set(['findMany', 'findFirst', 'findUnique', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate']);
const PRISMA_BASE_IDENTS = new Set(['prisma', 'db']);
const LLM_SDK_IDENTS = new Set(['anthropic', 'openai', 'genai', 'gemini', 'mistral', 'cohere', 'groq']);
const MODEL_ID = /\b(claude|gpt|gemini|o1|o3|mistral|command|llama|deepseek)[-\w.]*/i;
const LLM_HOSTS = /(anthropic\.com|openai\.(?:com|azure\.com)|generativelanguage\.googleapis\.com|x\.ai|api\.mistral\.ai|cohere\.(?:ai|com)|api\.groq\.com)/i;

/** The leftmost identifier of a `a.b.c(...)` chain, e.g. `supabase` in `supabase.from(...)`. */
function rootIdentifier(expr: ts.Expression, sf: ts.SourceFile): string {
  let cur: ts.Node = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = (cur as ts.PropertyAccessExpression).expression || (cur as ts.CallExpression).expression;
  }
  return ts.isIdentifier(cur) ? cur.text : cur.getText(sf).split('.').shift() || '';
}

/** True when a `.select()/.update()/…` is just refining a query already anchored
 *  by a `.from(...)`/`.rpc(...)` in the same chain, so we don't double-count it. */
function chainHasDbAnchor(expr: ts.Node): boolean {
  let cur: ts.Node | undefined = expr;
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const c: ts.Node = cur.expression;
      if (ts.isPropertyAccessExpression(c) && (c.name.text === 'from' || c.name.text === 'rpc')) return true;
      cur = c;
    } else if (ts.isPropertyAccessExpression(cur)) {
      if (cur.name.text === 'from' || cur.name.text === 'rpc') return true;
      cur = cur.expression;
    } else {
      break;
    }
  }
  return false;
}

function firstStringArg(node: ts.CallExpression): string | undefined {
  const arg = node.arguments[0];
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return undefined;
}

/** Collapse a host / model id / SDK name to one provider, so a fetch to
 *  api.openai.com and a `model: 'gpt-4o'` in the same function read as one node. */
function llmProviderName(hint: string): string {
  const s = String(hint).toLowerCase();
  if (/anthropic|claude/.test(s)) return 'Anthropic';
  if (/openai|gpt|\bo1\b|\bo3\b/.test(s)) return 'OpenAI';
  if (/gemini|generativelanguage|googleapis/.test(s)) return 'Gemini';
  if (/mistral/.test(s)) return 'Mistral';
  if (/cohere/.test(s)) return 'Cohere';
  if (/groq/.test(s)) return 'Groq';
  if (/llama|deepseek/.test(s)) return 'LLM';
  return hint.slice(0, 24);
}

function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : url.replace(/^\//, '').split(/[/?#]/)[0] || url;
}

/** Any object-literal `model: 'claude-…'` argument is a strong LLM signal. */
function hasModelArg(node: ts.CallExpression): string | undefined {
  for (const arg of node.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : '';
      if (key !== 'model') continue;
      const val = prop.initializer;
      if ((ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) && MODEL_ID.test(val.text)) {
        return val.text;
      }
    }
  }
  return undefined;
}

function enclosingName(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) {
      const parent = cur.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    cur = cur.parent;
  }
  return undefined;
}

function classifyCall(node: ts.CallExpression, sf: ts.SourceFile): Omit<EffectSite, 'file' | 'line' | 'functionName'> | null {
  const callee = node.expression;
  const model = hasModelArg(node);

  // Identifier callee: fetch(url)
  if (ts.isIdentifier(callee)) {
    if (callee.text === 'fetch') {
      const url = firstStringArg(node);
      if (model || (url && LLM_HOSTS.test(url))) {
        return { kind: 'llm', target: llmProviderName(model || (url ? hostOf(url) : 'LLM')), verb: 'calls', evidence: node.getText(sf).slice(0, 120) };
      }
      return { kind: 'external', target: url ? hostOf(url) : 'HTTP', verb: 'fetches', evidence: node.getText(sf).slice(0, 120) };
    }
    if (model) {
      return { kind: 'llm', target: llmProviderName(model), verb: 'calls', evidence: node.getText(sf).slice(0, 120) };
    }
    return null;
  }

  if (!ts.isPropertyAccessExpression(callee)) return null;
  const prop = callee.name.text;
  const root = rootIdentifier(callee.expression, sf);
  const calleeText = callee.getText(sf);
  const evidence = node.getText(sf).replace(/\s+/g, ' ').slice(0, 120);

  // LLM SDKs: anthropic.messages.create(...), openai.chat.completions.create(...)
  if (LLM_SDK_IDENTS.has(root) || /\.(messages|chat\.completions|completions|responses)\.create$/.test(calleeText) || /\.generateContent$/.test(calleeText) || model) {
    const provider = LLM_SDK_IDENTS.has(root) ? root : (model || calleeText);
    return { kind: 'llm', target: llmProviderName(provider), verb: 'calls', evidence: evidence };
  }

  // Database: supabase.from('table'), .rpc('fn'), prisma.model.findMany(), knex chains.
  const str = firstStringArg(node);
  if (prop === 'from' && str && root !== 'Array') {
    return { kind: 'database', target: str, verb: 'queries', evidence: evidence };
  }
  if (prop === 'rpc' && str) {
    return { kind: 'database', target: str + '()', verb: 'calls', evidence: evidence };
  }
  if (PRISMA_VERBS.has(prop) && ts.isPropertyAccessExpression(callee.expression)) {
    const base = callee.expression;
    if (PRISMA_BASE_IDENTS.has(rootIdentifier(base.expression, sf))) {
      return { kind: 'database', target: base.name.text, verb: 'queries', evidence: evidence };
    }
  }
  if (DB_CHAIN_VERBS.has(prop) && DB_BASE_IDENTS.has(root) && !chainHasDbAnchor(callee.expression)) {
    return { kind: 'database', target: str || prop, verb: 'queries', evidence: evidence };
  }

  // External HTTP clients: axios.get(url), http.request(...)
  if (root === 'axios' || (['get', 'post', 'put', 'patch', 'request'].includes(prop) && (root === 'axios' || root === 'http' || root === 'https'))) {
    return { kind: 'external', target: str ? hostOf(str) : 'HTTP', verb: 'fetches', evidence: evidence };
  }

  return null;
}

/**
 * @param changedLines when provided, only call sites on these (1-based) lines
 *   are returned, so the chart asserts only about what this diff touched.
 */
export function detectEffects(filePath: string, content: string, changedLines?: Set<number>): EffectSite[] {
  const language = detectLanguage(filePath);

  // A migration/schema file *is* a database change — the whole file is evidence.
  if (/(^|\/)migrations?\//i.test(filePath) || /\.sql$/i.test(filePath) || /(^|\/)schema\//i.test(filePath)) {
    return [{ file: filePath, line: 1, kind: 'database', target: filePath.split('/').pop() || 'schema', verb: 'migrates', evidence: 'schema / migration file' }];
  }

  if (language !== 'typescript' && language !== 'javascript') return [];

  try {
    const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(filePath) ? ts.ScriptKind.JSX
        : language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
    const sites: EffectSite[] = [];
    const seen = new Set<string>();

    const visit = (node: ts.Node) => {
      if (ts.isTaggedTemplateExpression(node)) {
        const tag = node.tag.getText(sf);
        if (/(^|\.)sql$/.test(tag)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (!changedLines || changedLines.has(line)) {
            addSite(sites, seen, { file: filePath, line, functionName: enclosingName(node, sf), kind: 'database', target: 'sql`…`', verb: 'queries', evidence: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120) });
          }
        }
      } else if (ts.isCallExpression(node)) {
        const hit = classifyCall(node, sf);
        if (hit) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (!changedLines || changedLines.has(line)) {
            addSite(sites, seen, { file: filePath, line, functionName: enclosingName(node, sf), ...hit });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return sites.slice(0, 40);
  } catch {
    return [];
  }
}

function addSite(sites: EffectSite[], seen: Set<string>, site: EffectSite): void {
  // One site per (kind, target, function) — a query in a loop counts once.
  const key = site.kind + '|' + site.target + '|' + (site.functionName || site.line);
  if (seen.has(key)) return;
  seen.add(key);
  sites.push(site);
}
