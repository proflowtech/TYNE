/**
 * Similarity fusion and clone classification.
 *
 * The four views from `astNormalize` are scored independently and then fused.
 * The point of keeping them separate is that their *pattern* — not the fused
 * number — is what names the clone kind:
 *
 *   structure high + lexical high  → identical / copy-paste
 *   structure high + lexical low   → renamed copy (Type-2)
 *   structure mid  + api high      → restructured copy (Type-3)
 *   structure low  + api high      → REIMPLEMENTED (Type-4, semantic)
 *
 * That last row is the AI-assistant failure mode: the agent did not copy your
 * helper, it wrote a fresh one that does the same job because it never read
 * your codebase. No amount of lexical similarity finds it, and it is the case
 * this engine exists for.
 *
 * IDF weighting is not optional here. Without it `call:push`, `prop:length`
 * and `call:log` dominate every comparison and everything looks 60% similar.
 */

import type { ControlProfile } from './astNormalize';
import type { FunctionFingerprint } from './fingerprint';

export type CloneKind = 'identical' | 'renamed' | 'restructured' | 'reimplemented';

export interface SimilarityBreakdown {
  /** Alpha-renamed structural agreement (0–1). */
  structural: number;
  /** Symmetric IDF-weighted vocabulary agreement (0–1). */
  api: number;
  /**
   * Asymmetric: how much of the *existing* function's distinctive vocabulary
   * the new function covers (0–1). The metric that actually matches the
   * question "does this redo what we already have?".
   */
  apiCoverage: number;
  /** Canonicalized identifier-concept agreement (0–1). */
  naming: number;
  /** Raw token agreement — the copy-paste view (0–1). */
  lexical: number;
  /** Control-flow profile agreement (0–1). */
  control: number;
  /** Count of shared tokens that carry real evidence (literals, rare callees). */
  distinctiveShared: number;
  /** Fused score, composed per kind (0–1). */
  score: number;
}

export interface CloneMatch {
  kind: CloneKind;
  breakdown: SimilarityBreakdown;
  /** How much of the evidence came from a real parser vs heuristics. */
  confidence: 'high' | 'medium' | 'low';
}

/** Token document-frequency lookup, supplied by the index. */
export interface IdfSource {
  totalDocs: number;
  documentFrequency(token: string): number;
}

// ── Weights & thresholds ────────────────────────────────────────────────────
// Deliberately exported: these are the engine's calibration surface. Tuning
// happens here, in one place, not scattered through the detector.

/**
 * Copy-shaped kinds are judged mostly on structure and raw text.
 * A reimplementation is judged on coverage and intent — its structural and
 * lexical scores are *expected* to be near zero, so folding them into one
 * global formula would make the engine blind to exactly the case it exists
 * for. Hence two compositions rather than one.
 */
export const FUSION_WEIGHTS = {
  copy: { structural: 0.38, api: 0.20, naming: 0.10, lexical: 0.24, control: 0.08 },
  reimplementation: { apiCoverage: 0.50, api: 0.20, naming: 0.20, control: 0.10 },
} as const;

export const THRESHOLDS = {
  /** Fused score below this is never reported, whatever the pattern. */
  minScore: 0.52,
  identicalLexical: 0.92,
  renamedStructural: 0.88,
  restructuredStructural: 0.55,
  restructuredApi: 0.50,
  /** The semantic case: covers what the original did, same intent vocabulary. */
  reimplementedCoverage: 0.55,
  reimplementedNaming: 0.38,
  /**
   * Coverage alone is not enough, because it is asymmetric: a large function
   * incidentally contains most of a small one's vocabulary without being a
   * reimplementation of it. Requiring symmetric agreement too means "these two
   * do the same job", not merely "one subsumes the other". This single floor
   * removes the bulk of the observed false positives.
   */
  reimplementedMinApi: 0.32,
  /** A genuine reimplementation is about the same size as its original. */
  reimplementedMaxLocRatio: 2.2,
  /**
   * A reimplementation claim must rest on shared *evidence* — a literal, a
   * regex, a domain callee — not on shared boilerplate. Without this guard,
   * any two functions that both loop and push would look related.
   */
  reimplementedDistinctive: 2,
  /** Below this many distinct API tokens a function has no identity. */
  minApiTokens: 4,
  /** A reimplementation target needs enough vocabulary to be coverable. */
  minTargetApiTokens: 8,
  /** Guard against a huge function "matching" a tiny one. */
  maxLocRatio: 3.5,
} as const;

/**
 * Ubiquitous language/stdlib members. They describe *mechanism*, not intent —
 * two functions both calling `push` share nothing meaningful. IDF demotes
 * these automatically once a real corpus exists; this list keeps the engine
 * honest on small corpora, where every token looks rare.
 */
const LOW_SIGNAL_MEMBERS = new Set([
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'length', 'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'includes',
  'indexOf', 'keys', 'values', 'entries', 'has', 'get', 'set', 'add', 'delete',
  'toString', 'valueOf', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON',
  'log', 'error', 'warn', 'info', 'then', 'catch', 'finally', 'resolve', 'reject',
  'call', 'apply', 'bind', 'test', 'exec', 'sort', 'reverse', 'trim', 'toLowerCase',
  'toUpperCase', 'charAt', 'charCodeAt', 'substring', 'substr', 'padStart', 'padEnd',
]);

const LOW_SIGNAL_WEIGHT = 0.25;

/** True when a shared token is real evidence rather than boilerplate. */
export function isDistinctiveToken(token: string): boolean {
  if (token.startsWith('lit:')) return true;
  const [kind, ...rest] = token.split(':');
  const name = rest.join(':');
  if (kind === 'prop') return false;
  if (kind === 'type') return true;
  return Boolean(name) && !LOW_SIGNAL_MEMBERS.has(name);
}

function intrinsicWeight(token: string): number {
  const [kind, ...rest] = token.split(':');
  const name = rest.join(':');
  if (kind === 'lit') return 1;
  return LOW_SIGNAL_MEMBERS.has(name) ? LOW_SIGNAL_WEIGHT : 1;
}

// ── Metric primitives ───────────────────────────────────────────────────────

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Weighted Jaccard over multisets, with each token scaled by its IDF so that
 * rare, meaningful tokens (`lit:re:/^[a-z0-9-]+$/`, `call:createHmac`) outvote
 * ubiquitous ones (`prop:length`).
 */
export function weightedJaccard(
  a: Map<string, number>,
  b: Map<string, number>,
  idf: IdfSource | null,
): number {
  if (!a.size || !b.size) return 0;
  const weightOf = tokenWeigher(idf);

  let inter = 0;
  let union = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const av = a.get(key) || 0;
    const bv = b.get(key) || 0;
    const w = weightOf(key);
    inter += w * Math.min(av, bv);
    union += w * Math.max(av, bv);
  }
  return union > 0 ? inter / union : 0;
}

/**
 * Asymmetric coverage: what fraction of `target`'s weighted vocabulary appears
 * in `other`.
 *
 * This — not Jaccard — is the metric for reimplementation. A rewrite is
 * usually more verbose than the helper it duplicates (a loop where the
 * original chained calls), and Jaccard charges it for every extra mechanism
 * token. Coverage asks the question the reviewer actually cares about: does
 * the new code do everything the existing helper did?
 *
 * Deliberately presence-based rather than multiset-based. Calling `replace`
 * three times where the original called it once is a difference in mechanism,
 * not in capability, and counting it would re-introduce the same penalty this
 * metric exists to avoid. Multiplicity is already represented in `api` and
 * `control`.
 */
export function containment(
  target: Map<string, number>,
  other: Map<string, number>,
  idf: IdfSource | null,
): number {
  if (!target.size || !other.size) return 0;
  const weightOf = tokenWeigher(idf);

  let covered = 0;
  let total = 0;
  for (const key of target.keys()) {
    const w = weightOf(key);
    total += w;
    if (other.has(key)) covered += w;
  }
  return total > 0 ? covered / total : 0;
}

/** Shared tokens that constitute evidence rather than boilerplate. */
export function countDistinctiveShared(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const key of a.keys()) {
    if (b.has(key) && isDistinctiveToken(key)) n++;
  }
  return n;
}

/**
 * Token weight = intrinsic signal × corpus rarity. The intrinsic factor keeps
 * `push` cheap even when the corpus is one file; IDF sharpens it further once
 * a real index exists.
 */
function tokenWeigher(idf: IdfSource | null): (token: string) => number {
  return (token: string): number => {
    const intrinsic = intrinsicWeight(token);
    if (!idf || idf.totalDocs <= 0) return intrinsic;
    const df = Math.max(1, idf.documentFrequency(token));
    return intrinsic * Math.log(1 + idf.totalDocs / df);
  };
}

/** Cosine over sparse count vectors — used for identifier concepts. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) {
    nb += v * v;
    const av = a.get(k);
    if (av) dot += av * v;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** 1 − normalized L1 distance over the control-flow profile. */
export function controlSimilarity(a: ControlProfile, b: ControlProfile): number {
  const keys: Array<keyof ControlProfile> = [
    'loops', 'branches', 'ternaries', 'tryCatch', 'awaits', 'returns', 'throws', 'maxDepth',
  ];
  let diff = 0;
  let total = 0;
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    diff += Math.abs(av - bv);
    total += Math.max(av, bv);
  }
  if (total === 0) return 1;
  return Math.max(0, 1 - diff / total);
}

// ── Comparison ──────────────────────────────────────────────────────────────

/**
 * Compare a candidate pair. Returns null when the pair is ineligible (too
 * small, too lopsided, same function) or when nothing crosses threshold.
 */
export function compareFingerprints(
  left: FunctionFingerprint,
  right: FunctionFingerprint,
  idf: IdfSource | null = null,
): CloneMatch | null {
  if (left.id === right.id) return null;
  if (left.file === right.file && left.startLine === right.startLine) return null;

  // Identity guard: a function that calls almost nothing cannot be shown to
  // duplicate anything — its similarity is an artifact of being short.
  if (left.apiTokens.size < THRESHOLDS.minApiTokens || right.apiTokens.size < THRESHOLDS.minApiTokens) {
    return null;
  }

  const locRatio = Math.max(left.loc, right.loc) / Math.max(1, Math.min(left.loc, right.loc));
  if (locRatio > THRESHOLDS.maxLocRatio) return null;

  const structural = left.shapeHash === right.shapeHash
    ? 1
    : jaccard(left.shapeGrams, right.shapeGrams);
  const api = weightedJaccard(left.apiTokens, right.apiTokens, idf);
  // `right` is the pre-existing side — coverage is always measured against it.
  const apiCoverage = containment(right.apiTokens, left.apiTokens, idf);
  const naming = cosine(left.nameTokens, right.nameTokens);
  const lexical = jaccard(left.lexGrams, right.lexGrams);
  const control = controlSimilarity(left.control, right.control);
  const distinctiveShared = countDistinctiveShared(left.apiTokens, right.apiTokens);

  const breakdown: SimilarityBreakdown = {
    structural, api, apiCoverage, naming, lexical, control, distinctiveShared, score: 0,
  };

  const kind = classify(breakdown, left, right);
  if (!kind) return null;

  breakdown.score = scoreFor(kind, breakdown);
  if (breakdown.score < THRESHOLDS.minScore) return null;

  return { kind, breakdown, confidence: confidenceFor(kind, breakdown, left, right) };
}

function classify(
  b: SimilarityBreakdown,
  query: FunctionFingerprint,
  target: FunctionFingerprint,
): CloneKind | null {
  if (b.lexical >= THRESHOLDS.identicalLexical && b.structural >= THRESHOLDS.renamedStructural) {
    return 'identical';
  }
  if (b.structural >= THRESHOLDS.renamedStructural) {
    return 'renamed';
  }
  if (b.structural >= THRESHOLDS.restructuredStructural && b.api >= THRESHOLDS.restructuredApi) {
    return 'restructured';
  }
  const sizeRatio = Math.max(query.loc, target.loc) / Math.max(1, Math.min(query.loc, target.loc));
  if (
    b.apiCoverage >= THRESHOLDS.reimplementedCoverage
    && b.api >= THRESHOLDS.reimplementedMinApi
    && b.naming >= THRESHOLDS.reimplementedNaming
    && b.distinctiveShared >= THRESHOLDS.reimplementedDistinctive
    && target.apiTokens.size >= THRESHOLDS.minTargetApiTokens
    && sizeRatio <= THRESHOLDS.reimplementedMaxLocRatio
  ) {
    return 'reimplemented';
  }
  return null;
}

/** Kind-specific composition — see FUSION_WEIGHTS for why there are two. */
function scoreFor(kind: CloneKind, b: SimilarityBreakdown): number {
  if (kind === 'reimplemented') {
    const w = FUSION_WEIGHTS.reimplementation;
    return w.apiCoverage * b.apiCoverage
      + w.api * b.api
      + w.naming * b.naming
      + w.control * b.control;
  }
  const w = FUSION_WEIGHTS.copy;
  return w.structural * b.structural
    + w.api * b.api
    + w.naming * b.naming
    + w.lexical * b.lexical
    + w.control * b.control;
}

function confidenceFor(
  kind: CloneKind,
  b: SimilarityBreakdown,
  left: FunctionFingerprint,
  right: FunctionFingerprint,
): 'high' | 'medium' | 'low' {
  // Heuristic parsing degrades every view, so it caps confidence regardless of
  // how strong the numbers look.
  const heuristic = left.parser === 'regex' || right.parser === 'regex';

  if (kind === 'identical' || (kind === 'renamed' && b.structural === 1)) {
    return heuristic ? 'medium' : 'high';
  }
  if (heuristic) return 'low';
  if (kind === 'reimplemented') {
    // Confidence here tracks evidence density, not the fused score: three
    // shared regexes beat a high number built from generic agreement.
    if (b.apiCoverage >= 0.7 && b.distinctiveShared >= 3) return 'high';
    if (b.apiCoverage >= 0.6 && b.distinctiveShared >= 2) return 'medium';
    return 'low';
  }
  if (b.score >= 0.72 && b.api >= 0.65) return 'high';
  if (b.score >= 0.60) return 'medium';
  return 'low';
}

// ── Presentation helpers ────────────────────────────────────────────────────

export function describeKind(kind: CloneKind): string {
  switch (kind) {
    case 'identical':
      return 'Copy-pasted';
    case 'renamed':
      return 'Copy-pasted with renamed variables';
    case 'restructured':
      return 'Same logic, rearranged';
    case 'reimplemented':
      return 'Reimplements existing logic';
  }
}

/** Human-auditable evidence string — every number that drove the verdict. */
export function formatBreakdown(b: SimilarityBreakdown): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `score=${pct(b.score)} structure=${pct(b.structural)} api=${pct(b.api)} `
    + `coverage=${pct(b.apiCoverage)} naming=${pct(b.naming)} lexical=${pct(b.lexical)} `
    + `control=${pct(b.control)} sharedEvidence=${b.distinctiveShared}`;
}
