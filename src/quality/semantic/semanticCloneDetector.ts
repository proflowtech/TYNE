/**
 * Semantic clone detector — orchestration layer.
 *
 * Two properties separate this from generic clone detection, and both exist
 * because of what the finding has to *say* to be worth showing:
 *
 *   Directional. We only report "the function you just wrote duplicates
 *   something that already existed", never the reverse and never a symmetric
 *   "these two files are similar". Pre-existing duplication is not this
 *   review's business; code the author just added is.
 *
 *   Actionable target. Every finding names a concrete callable — file, line,
 *   function name, and whether it is exported — so the fix is "import this"
 *   rather than "consider refactoring".
 *
 * Scope stays diff-bound like the rest of the quality engine: only functions
 * the diff actually touched are queried against the corpus.
 */

import { changedLinesFromDiff } from '../astFacts';
import type { QualityFinding } from '../qualityTypes';
import {
  computeBehavioralGaps,
  formatGapList,
  type BehavioralGapReport,
} from './behavioralGap';
import {
  extractContractNames,
  fingerprintFiles,
  fingerprintSource,
  type FunctionFingerprint,
} from './fingerprint';
import { FingerprintIndex } from './fingerprintIndex';
import {
  compareFingerprints,
  describeKind,
  formatBreakdown,
  type CloneKind,
  type CloneMatch,
} from './similarity';

export interface SemanticCloneInput {
  /** Unified diff for the reviewed scope. */
  diff: string;
  /** Full contents of the changed files (post-change). */
  changedFiles: Array<{ path: string; content: string }>;
  /**
   * Pre-existing corpus to match against. Today this is the review's nearby
   * file window; a persistent workspace index can be passed via `index`
   * instead without changing anything else.
   */
  repoFiles?: Array<{ path: string; content: string }>;
  /** Prebuilt corpus index — takes precedence over `repoFiles`. */
  index?: FingerprintIndex;
  /** Report duplication inside test files too. Off by default (noisy). */
  includeTests?: boolean;
  /** Cap on emitted findings. */
  maxFindings?: number;
}

export interface SemanticCloneResult {
  findings: QualityFinding[];
  /** Diagnostics for the report footer / debugging — no source text. */
  stats: {
    changedFunctions: number;
    corpusFunctions: number;
    comparisons: number;
    matched: number;
    /** Pairs skipped as parallel implementations of a declared contract. */
    suppressedByContract: number;
  };
}

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|fixtures)\//i;
const TEST_NAME = /\.(test|spec)\.[a-z0-9]+$/i;
const DEFAULT_MAX_FINDINGS = 10;
const CANDIDATES_PER_FUNCTION = 40;

export function detectSemanticClones(input: SemanticCloneInput): SemanticCloneResult {
  const stats = {
    changedFunctions: 0, corpusFunctions: 0, comparisons: 0, matched: 0, suppressedByContract: 0,
  };

  const changedRanges = changedLineRanges(input.diff);
  const changedPaths = new Set(input.changedFiles.map(f => f.path));

  // ── Query side: only functions the diff touched ──
  const queries: FunctionFingerprint[] = [];
  for (const file of input.changedFiles) {
    if (!file?.path || !file.content) continue;
    if (!input.includeTests && isTestPath(file.path)) continue;
    const touched = changedRanges.get(file.path);
    try {
      queries.push(...fingerprintSource(file.path, file.content, {
        // When the diff carries no line info for this file (rename, or a diff
        // we could not parse), fall back to fingerprinting the whole file
        // rather than silently reviewing nothing.
        lineFilter: touched
          ? (start, end) => rangeTouches(touched, start, end)
          : undefined,
      }));
    } catch { /* never fail a review on one file */ }
  }
  stats.changedFunctions = queries.length;
  if (!queries.length) return { findings: [], stats };

  // ── Corpus side ──
  const index = input.index ?? buildCorpusIndex(input.repoFiles || [], changedPaths, input.includeTests);
  // Contracts declared in the changed files count too — a diff that adds an
  // interface and its second implementation must not flag its own work.
  for (const file of input.changedFiles) {
    try {
      index.addContractNames(extractContractNames(file.path, file.content));
    } catch { /* ignore */ }
  }
  stats.corpusFunctions = index.size;
  if (!index.size) return { findings: [], stats };

  // ── Match: best single target per changed function ──
  const best = new Map<string, { query: FunctionFingerprint; target: FunctionFingerprint; match: CloneMatch }>();

  for (const query of queries) {
    const candidates = index.candidatesFor(query, {
      limit: CANDIDATES_PER_FUNCTION,
      excludeFiles: changedPaths,
    });
    for (const candidate of candidates) {
      stats.comparisons++;
      if (!input.includeTests && isTestPath(candidate.file)) continue;
      if (isParallelImplementation(query, candidate, index)) {
        stats.suppressedByContract++;
        continue;
      }
      const match = compareFingerprints(query, candidate, index);
      if (!match) continue;
      const current = best.get(query.id);
      if (!current || match.breakdown.score > current.match.breakdown.score) {
        best.set(query.id, { query, target: candidate, match });
      }
    }
  }
  stats.matched = best.size;

  const findings = [...best.values()]
    .sort((a, b) => b.match.breakdown.score - a.match.breakdown.score)
    .slice(0, input.maxFindings ?? DEFAULT_MAX_FINDINGS)
    .map(({ query, target, match }) => toFinding(query, target, match));

  return { findings, stats };
}

// ── Corpus construction ─────────────────────────────────────────────────────

export function buildCorpusIndex(
  files: Array<{ path: string; content: string }>,
  excludePaths: Set<string> = new Set(),
  includeTests = false,
): FingerprintIndex {
  const index = new FingerprintIndex();
  const eligible = files.filter(f =>
    f?.path && f.content
    && !excludePaths.has(f.path)
    && (includeTests || !isTestPath(f.path)));
  index.addAll(fingerprintFiles(eligible));
  // Contract names are collected from every corpus file, including the ones
  // excluded above — an interface declaration is worth reading even in a file
  // whose implementations we skip.
  for (const file of files) {
    if (!file?.path || !file.content) continue;
    try {
      index.addContractNames(extractContractNames(file.path, file.content));
    } catch { /* ignore */ }
  }
  return index;
}

// ── Finding construction ────────────────────────────────────────────────────

function toFinding(
  query: FunctionFingerprint,
  target: FunctionFingerprint,
  match: CloneMatch,
): QualityFinding {
  const { kind, breakdown, confidence } = match;
  const pct = Math.round(breakdown.score * 100);
  const semantic = kind === 'reimplemented' || kind === 'restructured';
  const gaps = computeBehavioralGaps(query, target);

  // Several diverging mechanisms make a finding worth reading carefully, but
  // a token gap is not proof that behaviour was lost (the rewrite may cover the
  // case another way), so this raises prominence only. Escalating the category
  // to `correctness` on this evidence would assert a bug we have not shown.
  const worthAttention = gaps.notableCount >= 2;

  return {
    id: `QUALITY_SEMANTIC_CLONE:${query.id}->${target.id}`,
    ruleId: semantic ? 'QUALITY_SEMANTIC_CLONE' : 'QUALITY_CLONE_FUNCTION',
    subcategory: semantic ? 'duplicate_utility' : 'clone',
    category: 'maintainability',
    severity: severityFor(kind, breakdown.score, target.exported, gaps.notableCount),
    confidence,
    title: worthAttention
      ? `\`${query.name}()\` duplicates \`${target.name}()\` — ${gaps.notableCount} behaviours to verify`
      : titleFor(kind, query, target, pct),
    explanation: explanationFor(kind, query, target, gaps),
    file: query.file,
    line: query.startLine,
    endLine: query.endLine,
    evidence: `${formatBreakdown(breakdown)} target=${target.file}:${target.startLine} `
      + `kind=${kind} parser=${query.parser}/${target.parser} missingBehaviours=${gaps.notableCount}`,
    suggestedFix: target.exported
      ? `Import \`${target.name}\` from ${target.file} and call it instead of reimplementing it here.`
      : `Extract \`${target.name}\` (${target.file}:${target.startLine}) into a shared module and use it from both call sites.`,
    detectedBy: 'clone',
    blocking: false,
    metricValue: pct,
    debtMinutes: debtFor(kind, query.loc),
    betterPattern: `Reuse ${target.name}() from ${target.file}`,
    language: query.language,
  };
}

function titleFor(kind: CloneKind, query: FunctionFingerprint, target: FunctionFingerprint, pct: number): string {
  if (kind === 'reimplemented') {
    return `\`${query.name}()\` reimplements existing \`${target.name}()\` (${pct}% behavioural match)`;
  }
  if (kind === 'restructured') {
    return `\`${query.name}()\` duplicates \`${target.name}()\` with rearranged logic (${pct}% match)`;
  }
  if (kind === 'renamed') {
    return `\`${query.name}()\` is \`${target.name}()\` with renamed variables (${pct}% match)`;
  }
  return `\`${query.name}()\` duplicates \`${target.name}()\` (${pct}% match)`;
}

function explanationFor(
  kind: CloneKind,
  query: FunctionFingerprint,
  target: FunctionFingerprint,
  gaps: BehavioralGapReport,
): string {
  const where = `${target.file}:${target.startLine}`;
  const exportNote = target.exported
    ? 'That function is already exported, so it can be imported directly.'
    : 'That function is currently module-private, so reuse means extracting it first.';

  const base = kind === 'reimplemented'
    ? `${describeKind(kind)}: the structure differs, but the two functions call the same APIs, use the same literals `
      + `and share the same naming concepts — the usual signature of code written from scratch by an assistant that did `
      + `not see the existing helper at ${where}.`
    : kind === 'restructured'
      ? `${describeKind(kind)}: same underlying behaviour as ${where}, reorganised. Two copies will drift apart `
        + `the first time one of them is fixed.`
      : `${describeKind(kind)} from ${where}. Structural fingerprints match after variable renaming, so a bug fixed `
        + `in one copy will silently persist in the other.`;

  // The gap list is the part reviewers act on, so it leads the explanation
  // rather than trailing the similarity prose.
  const gapList = formatGapList(gaps, target.file);
  if (!gapList) return `${base} ${exportNote}`;

  return `${gaps.summary}\n\nSteps in \`${target.name}()\` with no equivalent in yours — verify each is covered `
    + `(it may be handled a different way):\n${gapList}\n\n${base} ${exportNote}`;
}

function severityFor(
  kind: CloneKind,
  score: number,
  targetExported: boolean,
  notableGaps: number,
): QualityFinding['severity'] {
  // Diverging mechanisms raise the stakes — if the two really do disagree, the
  // bug is subtle and long-lived. But the gap is unproven, so this tops out at
  // `high`; `critical` is reserved for findings we can actually demonstrate.
  if (notableGaps >= 2) return 'high';
  if (kind === 'reimplemented' && targetExported && score >= 0.65) return 'high';
  if (kind === 'identical' || kind === 'renamed') return score >= 0.8 ? 'high' : 'medium';
  if (kind === 'reimplemented') return 'medium';
  return score >= 0.7 ? 'medium' : 'low';
}

function debtFor(kind: CloneKind, loc: number): number {
  const base = kind === 'reimplemented' ? 35 : kind === 'restructured' ? 30 : 20;
  return Math.round(base + Math.min(60, loc * 1.2));
}

// ── Diff helpers ────────────────────────────────────────────────────────────

/** Changed line numbers per file, collapsed into sorted ranges. */
export function changedLineRanges(diff: string): Map<string, Array<[number, number]>> {
  const byFile = new Map<string, number[]>();
  for (const row of changedLinesFromDiff(diff)) {
    if (!row.line) continue;
    const list = byFile.get(row.file) || [];
    list.push(row.line);
    byFile.set(row.file, list);
  }

  const out = new Map<string, Array<[number, number]>>();
  for (const [file, lines] of byFile) {
    lines.sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    let start = lines[0];
    let prev = lines[0];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] - prev > 1) {
        ranges.push([start, prev]);
        start = lines[i];
      }
      prev = lines[i];
    }
    ranges.push([start, prev]);
    out.set(file, ranges);
  }
  return out;
}

function rangeTouches(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([a, b]) => a <= end && b >= start);
}

function isTestPath(path: string): boolean {
  return TEST_NAME.test(path) || TEST_DIR.test(path);
}

/**
 * Two same-named functions in different files, where that name is part of a
 * declared contract, are parallel implementations rather than duplication.
 * `JiraProvider.isConnected` resembling `LinearProvider.isConnected` is the
 * interface working as intended; telling the author to deduplicate it would be
 * wrong advice.
 *
 * The check is deliberately narrow — it requires an *exact* name match against
 * an interface member. A helper that merely happens to sit next to an adapter
 * (`getRepositoryIdentity` copied into four services) is not a contract member,
 * so it still gets reported.
 */
function isParallelImplementation(
  query: FunctionFingerprint,
  candidate: FunctionFingerprint,
  index: FingerprintIndex,
): boolean {
  if (query.name !== candidate.name) return false;
  if (query.file === candidate.file) return false;
  return index.isContractName(query.name);
}
