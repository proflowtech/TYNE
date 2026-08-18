/**
 * AST normalization for semantic clone detection.
 *
 * Every function is reduced to FOUR independent views. The whole engine rests
 * on the fact that these views fail independently:
 *
 *   shape   — alpha-renamed structural token stream. Survives variable/param
 *             renaming, comment churn and formatting. Dies when the author
 *             restructures (loop → map, guard → ternary).
 *   api     — the vocabulary of things the function *touches*: callees,
 *             property names, meaningful literals, referenced types. Survives
 *             restructuring. Dies when the author swaps the underlying library.
 *   control — a coarse behavioural profile (loops/branches/awaits/depth).
 *             Cheap tie-breaker; never decisive on its own.
 *   naming  — canonicalized subword tokens from every identifier in scope,
 *             collapsed through a verb lexicon so `fetchUser` and
 *             `getUserRecord` land on the same concept.
 *
 * Lexical clone detection only ever sees one view, which is why it cannot tell
 * "copy-pasted" from "rewritten from scratch doing the identical job". Keeping
 * the views separate is what lets `similarity.ts` name the clone *kind*.
 *
 * Hashing is a pure FNV-1a over strings — no `crypto` import, so this module
 * stays usable from any runtime the review pipeline runs in.
 */

import * as ts from 'typescript';

// ── Public shapes ───────────────────────────────────────────────────────────

export interface ControlProfile {
  loops: number;
  branches: number;
  ternaries: number;
  tryCatch: number;
  awaits: number;
  returns: number;
  throws: number;
  maxDepth: number;
  statements: number;
}

export interface ApiVocabulary {
  /** Leaf name of each call target, in source order (multiset). */
  calls: string[];
  /** Property names read or written. */
  props: string[];
  /** Normalized high-signal literals (strings, regexes, non-trivial numbers). */
  literals: string[];
  /** Type names referenced in annotations. */
  types: string[];
}

export interface NormalizedFunction {
  shapeTokens: string[];
  shapeHash: string;
  api: ApiVocabulary;
  control: ControlProfile;
  /** Canonicalized identifier subwords (function name, params, locals, callees). */
  identifierTokens: string[];
  arity: number;
  isAsync: boolean;
  localCount: number;
  /**
   * First source line of each call/literal/type token, 1-based.
   *
   * This is what lets a gap report say "the original collapses `/-{2,}/g` at
   * line 18" instead of "the original does something more". Only high-value
   * token kinds are tracked (properties are excluded) and the count is capped,
   * so the cost to a workspace-wide index stays small.
   */
  evidenceLines: Array<[token: string, line: number]>;
  /**
   * Literal tokens that appear in *guard* position — compared with `===`, in a
   * `case`, or passed to a membership test like `includes`/`startsWith`.
   *
   * The distinction matters for gap reporting. A literal a function compares
   * against is a case it handles (`status === 'cancelled'`, a lockfile name);
   * a literal it merely emits is configuration (`model: 'gpt-4o-mini'`, a log
   * message). Only the former is worth telling a reviewer about, and position
   * is the only reliable way to tell them apart — the strings themselves look
   * identical.
   */
  guardLiterals: string[];
}

/** Cap on tracked evidence lines per function. */
export const MAX_EVIDENCE_LINES = 40;

// ── Hashing ─────────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit, returned as 8 hex chars. Deterministic across runtimes. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Identifier canonicalization ─────────────────────────────────────────────

const NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'var', 'val', 'tmp', 'temp', 'obj', 'arr', 'str', 'num', 'idx', 'len', 'ret',
  'res', 'req', 'ctx', 'cfg', 'opt', 'opts', 'args', 'arg', 'params', 'param',
  'result', 'results', 'value', 'values', 'item', 'items', 'data', 'input',
  'output', 'options', 'config', 'callback', 'fn', 'func', 'cb', 'self',
]);

/**
 * Verb synonym lexicon — the piece that turns "different names" into "same
 * intent". An AI rewriting `slugifyTitle` as `convertHeadingToUrlSafeString`
 * still lands on CONVERT + the shared domain nouns.
 *
 * Deliberately hand-curated and small: every entry is a claim we are willing to
 * defend in a finding. Adding a wrong synonym here creates false positives
 * across the whole engine, so entries must be true synonyms in code, not merely
 * related words.
 */
const VERB_SYNONYMS: Record<string, string> = {
  get: 'GET', fetch: 'GET', retrieve: 'GET', load: 'GET', read: 'GET', pull: 'GET',
  set: 'WRITE', save: 'WRITE', store: 'WRITE', write: 'WRITE', persist: 'WRITE', put: 'WRITE',
  create: 'CREATE', make: 'CREATE', build: 'CREATE', generate: 'CREATE', construct: 'CREATE',
  init: 'CREATE', new: 'CREATE', spawn: 'CREATE',
  parse: 'PARSE', extract: 'PARSE', decode: 'PARSE', deserialize: 'PARSE', unmarshal: 'PARSE',
  format: 'FORMAT', render: 'FORMAT', stringify: 'FORMAT', serialize: 'FORMAT',
  encode: 'FORMAT', print: 'FORMAT',
  validate: 'VALIDATE', verify: 'VALIDATE', check: 'VALIDATE', ensure: 'VALIDATE',
  assert: 'VALIDATE', test: 'VALIDATE', is: 'VALIDATE', has: 'VALIDATE',
  convert: 'CONVERT', transform: 'CONVERT', map: 'CONVERT', translate: 'CONVERT',
  cast: 'CONVERT', normalize: 'CONVERT', sanitize: 'CONVERT', clean: 'CONVERT',
  slugify: 'CONVERT', slug: 'CONVERT',
  remove: 'DELETE', delete: 'DELETE', destroy: 'DELETE', drop: 'DELETE',
  clear: 'DELETE', purge: 'DELETE', strip: 'DELETE',
  find: 'FIND', search: 'FIND', lookup: 'FIND', locate: 'FIND', query: 'FIND',
  filter: 'FILTER', select: 'FILTER', where: 'FILTER', pick: 'FILTER',
  merge: 'MERGE', combine: 'MERGE', join: 'MERGE', concat: 'MERGE', union: 'MERGE',
  sort: 'SORT', order: 'SORT', rank: 'SORT',
  count: 'COUNT', total: 'COUNT', sum: 'COUNT', tally: 'COUNT',
  send: 'SEND', post: 'SEND', emit: 'SEND', dispatch: 'SEND', publish: 'SEND',
  handle: 'HANDLE', process: 'HANDLE', run: 'HANDLE', execute: 'HANDLE', exec: 'HANDLE',
  update: 'UPDATE', patch: 'UPDATE', modify: 'UPDATE', edit: 'UPDATE', apply: 'UPDATE',
};

/** Split camelCase / snake_case / kebab-case into canonical concept tokens. */
export function splitIdentifier(name: string): string[] {
  if (!name) return [];
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(p => p.toLowerCase())
    .filter(Boolean);

  const out: string[] = [];
  for (const raw of parts) {
    const canon = VERB_SYNONYMS[raw];
    if (canon) {
      out.push(canon);
      continue;
    }
    // Light plural stemming only — aggressive stemming merges unrelated nouns.
    const stem = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss')
      ? raw.slice(0, -1)
      : raw;
    if (stem.length < 3 || NAME_STOPWORDS.has(stem)) continue;
    out.push(stem);
  }
  return out;
}

// ── Literal normalization ───────────────────────────────────────────────────

/** Numbers so common they carry no identity. */
const TRIVIAL_NUMBERS = new Set([0, 1, -1, 2, 100]);

function normalizeStringLiteral(text: string): string | null {
  const v = text.trim();
  if (!v) return null;
  // Long strings (messages, templates) match by length bucket, not content —
  // an LLM rewrite almost always reflows the prose but keeps the size class.
  if (v.length > 24) return `str#${Math.floor(Math.log2(v.length))}`;
  return `str:${v.toLowerCase()}`;
}

// ── Normalizer ──────────────────────────────────────────────────────────────

/** Calls that test membership/prefix rather than consume a payload. */
const GUARD_CALLS = new Set([
  'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf',
  'match', 'test', 'has', 'equals', 'is', 'contains',
]);

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * True when a literal node sits somewhere that tests a value rather than
 * supplies one: an equality comparison, a `case` label, or an argument to a
 * membership test. Array literals are transparent, so `['a','b'].includes(x)`
 * marks both entries.
 */
function isGuardPosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;

  // Step through an enclosing array literal — its elements share its position.
  if (parent && ts.isArrayLiteralExpression(parent)) {
    current = parent;
    parent = current.parent;
  }
  if (!parent) return false;

  if (ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent)) return true;

  // `['jira', 'linear'].includes(x)` — the array is the *receiver* of the
  // membership test, not an argument, so it arrives here as the object of a
  // property access rather than in the call-argument branch below.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
    const call = parent.parent;
    return Boolean(call && ts.isCallExpression(call) && GUARD_CALLS.has(parent.name.text));
  }

  if (ts.isCallExpression(parent)) {
    // Only arguments count; a literal in callee position is not a guard.
    if (!parent.arguments.some(a => a === current)) return false;
    const callee = parent.expression;
    const leaf = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isIdentifier(callee) ? callee.text
        : '';
    if (GUARD_CALLS.has(leaf)) return true;
    // A literal handed to a call whose *result* is tested is also a case the
    // function checks for — `exists(root, 'pnpm-lock.yaml') ? … : …` asks a
    // question about that filename just as much as `x === 'pnpm-lock.yaml'`
    // does. Without this, guard detection only recognises the built-in
    // predicates and misses every project-specific one.
    return isTestedExpression(parent);
  }
  return false;
}

/** True when an expression's value is consumed as a boolean condition. */
function isTestedExpression(node: ts.Node): boolean {
  let current: ts.Node = node;
  // Unwrap the shapes that preserve "this value is the condition".
  for (let hops = 0; hops < 4; hops++) {
    const parent: ts.Node | undefined = current.parent;
    if (!parent) return false;

    if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      current = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent)) return parent.condition === current;
    if (ts.isIfStatement(parent)) return parent.expression === current;
    if (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return parent.expression === current;
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      const logical = op === ts.SyntaxKind.AmpersandAmpersandToken
        || op === ts.SyntaxKind.BarBarToken
        || op === ts.SyntaxKind.QuestionQuestionToken;
      if (!logical) return false;
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

const DECL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
]);

/**
 * Reduce one function node to its four normalized views.
 * `sf` must be the SourceFile the node came from (parsed with parentNodes on).
 */
export function normalizeFunction(node: ts.Node, sf: ts.SourceFile): NormalizedFunction {
  // Pass 1 — collect locally declared names so we can alpha-rename them.
  // Preserving *which* slot each use refers to keeps data-flow shape, which a
  // blanket `$ID` placeholder would throw away.
  const locals = new Map<string, string>();
  const collect = (n: ts.Node) => {
    if (DECL_KINDS.has(n.kind)) {
      const named = n as ts.NamedDeclaration;
      if (named.name && ts.isIdentifier(named.name) && !locals.has(named.name.text)) {
        locals.set(named.name.text, `$v${locals.size}`);
      }
    }
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(node, collect);

  const shapeTokens: string[] = [];
  const calls: string[] = [];
  const props: string[] = [];
  const literals: string[] = [];
  const types: string[] = [];
  const identifierTokens: string[] = [];

  const control: ControlProfile = {
    loops: 0, branches: 0, ternaries: 0, tryCatch: 0,
    awaits: 0, returns: 0, throws: 0, maxDepth: 0, statements: 0,
  };

  const guardLiterals = new Set<string>();
  const noteGuard = (token: string, n: ts.Node) => {
    if (isGuardPosition(n)) guardLiterals.add(token);
  };

  const evidence = new Map<string, number>();
  const noteEvidence = (token: string, n: ts.Node) => {
    if (evidence.has(token) || evidence.size >= MAX_EVIDENCE_LINES) return;
    try {
      evidence.set(token, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    } catch { /* synthesized nodes have no position */ }
  };

  const pushName = (name: string) => {
    for (const t of splitIdentifier(name)) identifierTokens.push(t);
  };

  const calleeLeafName = (expr: ts.Expression): string | null => {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
      return expr.argumentExpression.text;
    }
    return null;
  };

  const visit = (n: ts.Node, depth: number) => {
    control.maxDepth = Math.max(control.maxDepth, depth);

    switch (n.kind) {
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
        control.loops++;
        break;
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.CaseClause:
        control.branches++;
        break;
      case ts.SyntaxKind.ConditionalExpression:
        control.ternaries++;
        break;
      case ts.SyntaxKind.TryStatement:
        control.tryCatch++;
        break;
      case ts.SyntaxKind.AwaitExpression:
        control.awaits++;
        break;
      case ts.SyntaxKind.ReturnStatement:
        control.returns++;
        break;
      case ts.SyntaxKind.ThrowStatement:
        control.throws++;
        break;
      default:
        break;
    }
    if (ts.isStatement(n)) control.statements++;

    // ── shape + vocabulary emission ──
    if (ts.isIdentifier(n)) {
      const local = locals.get(n.text);
      shapeTokens.push(local || '$g');
      if (!local) pushName(n.text);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      shapeTokens.push('$s');
      const lit = normalizeStringLiteral(n.text);
      if (lit) { literals.push(lit); noteEvidence(`lit:${lit}`, n); noteGuard(`lit:${lit}`, n); }
    } else if (ts.isNumericLiteral(n)) {
      shapeTokens.push('$n');
      const value = Number(n.text);
      if (Number.isFinite(value) && !TRIVIAL_NUMBERS.has(value)) {
        literals.push(`num:${value}`);
        noteEvidence(`lit:num:${value}`, n);
        noteGuard(`lit:num:${value}`, n);
      }
    } else if (ts.isRegularExpressionLiteral(n)) {
      shapeTokens.push('$r');
      literals.push(`re:${n.text.slice(0, 48)}`);
      noteEvidence(`lit:re:${n.text.slice(0, 48)}`, n);
    } else if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) {
      shapeTokens.push('$b');
    } else if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.UndefinedKeyword) {
      shapeTokens.push('$u');
    } else {
      shapeTokens.push(ts.SyntaxKind[n.kind] || `k${n.kind}`);
    }

    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const leaf = calleeLeafName(n.expression);
      if (leaf) {
        calls.push(leaf);
        pushName(leaf);
        noteEvidence(`call:${leaf}`, n);
      }
    } else if (ts.isPropertyAccessExpression(n)) {
      props.push(n.name.text);
      pushName(n.name.text);
    } else if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
      types.push(n.typeName.text);
      noteEvidence(`type:${n.typeName.text}`, n);
    }

    const childDepth = ts.isBlock(n) || ts.isCaseBlock(n) ? depth + 1 : depth;
    ts.forEachChild(n, c => visit(c, childDepth));
  };

  // Function name and parameters describe intent; fold them in explicitly
  // because the body walk sees params only as alpha-renamed slots.
  const named = node as ts.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) pushName(named.name.text);
  const sig = node as ts.SignatureDeclarationBase;
  const params = sig.parameters ? Array.from(sig.parameters) : [];
  for (const p of params) {
    if (ts.isIdentifier(p.name)) pushName(p.name.text);
    if (p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName)) {
      types.push(p.type.typeName.text);
    }
  }

  ts.forEachChild(node, c => visit(c, 1));

  const isAsync = Boolean(
    (node as ts.HasModifiers).modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
  );

  return {
    shapeTokens,
    shapeHash: fnv1a(shapeTokens.join('|')),
    api: { calls, props, literals, types },
    control,
    identifierTokens,
    arity: params.length,
    isAsync,
    localCount: locals.size,
    evidenceLines: [...evidence],
    guardLiterals: [...guardLiterals],
  };
}

// ── Shared helpers used by the fingerprint layer ────────────────────────────

/**
 * Maximum grams retained per function (bottom-k sketch size).
 *
 * Gram counts are extremely skewed — median ~80, but a few generated or
 * god-sized functions produce thousands, and those tails dominate the size of
 * a workspace-wide index. Keeping the k numerically smallest hashes bounds the
 * cost per function without biasing the comparison: for any set with ≤ k grams
 * (the overwhelming majority) the sketch *is* the full set and Jaccard is
 * exact; above k it becomes a standard bottom-k estimator.
 *
 * Measured on this repo (1172 functions): k=256 keeps 92% of functions exact
 * for a 3.5MB cache; k=96 cuts the cache to 2.9MB with no measurable change in
 * detector output (161 vs 160 findings). 256 is kept because exactness for the
 * majority is worth more than 0.6MB — but the smaller value is a safe knob if
 * index size ever becomes the binding constraint on a large repo.
 */
export const GRAM_SKETCH_SIZE = 256;

/**
 * Contiguous n-grams over a token stream, as a set of hashed grams.
 *
 * Grams are hashed rather than stored verbatim because a workspace-wide index
 * holds these for every function in the repo: an 8-char hash costs ~6× less
 * than the raw gram text, in memory and on disk. Set arithmetic (the only
 * thing we ever do with them) is unaffected, and at 32 bits the collision
 * probability across a few hundred grams is negligible.
 *
 * Sketching happens here, at construction, so that every fingerprint anywhere
 * in the system is sampled the same way. Comparing a sketched set against a
 * full one would silently understate similarity.
 */
export function ngrams(tokens: string[], n: number): Set<string> {
  const all = new Set<string>();
  if (tokens.length < n) {
    if (tokens.length) all.add(fnv1a(tokens.join(' ')));
    return all;
  }
  for (let i = 0; i <= tokens.length - n; i++) {
    all.add(fnv1a(tokens.slice(i, i + n).join(' ')));
  }
  if (all.size <= GRAM_SKETCH_SIZE) return all;

  // Fixed-width hex sorts lexicographically in numeric order, and FNV output
  // is uniform, so "smallest k" is a uniform random sample of the gram space —
  // the same sample for any function containing the same grams.
  return new Set([...all].sort().slice(0, GRAM_SKETCH_SIZE));
}

/** Count occurrences into a weighted multiset. */
export function toMultiset(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
