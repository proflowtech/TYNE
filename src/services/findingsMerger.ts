// ── Findings merger ──────────────────────────────────────────────────────────
// Merges findings from the local engine, LLM packs, and PEV agents into one
// deduplicated list: overlapping line ranges in the same file collapse into a
// single finding, and the same rule firing in 3+ files becomes one grouped
// finding with relatedLocations instead of N near-identical entries.

import {
  TyneValidateReviewFinding,
  CodeLocation,
  displaySeverityRank,
  toDisplaySeverity,
} from '../validateReviewTypes';
import { groundReviewFindings, emptyGroundingStats, type ChangedFileRef, type GroundingStats } from './findingGrounding';

const DEFAULT_LINE_OVERLAP_THRESHOLD = 3;
const DEFAULT_MAX_MINOR_PER_FILE = 3;

/**
 * Only cosmetic findings may be throttled. Governance categories feed the
 * Scope / Security / Compliance / Tests section panels, so dropping them would
 * silently empty those sections even though the score still reflects them.
 */
const THROTTLEABLE_CATEGORIES = new Set(['style', 'vibe_code', 'maintainability', 'performance']);

/** Deterministic sources whose fixes are usually more precise than the LLM's. */
const DETERMINISTIC_SOURCES = new Set(['local_engine']);
const DETERMINISTIC_DETECTORS = new Set([
  'secret_scanner', 'dependency_scanner', 'ast_rule', 'dataflow', 'metric', 'architecture', 'ac_validator',
]);

function isDeterministic(f: TyneValidateReviewFinding): boolean {
  if (f.source && DETERMINISTIC_SOURCES.has(f.source)) { return true; }
  return Boolean(f.detectedBy && DETERMINISTIC_DETECTORS.has(f.detectedBy));
}

function startLine(f: TyneValidateReviewFinding): number {
  return typeof f.line === 'number' && f.line > 0 ? f.line : 0;
}

function endLine(f: TyneValidateReviewFinding): number {
  const end = typeof f.endLine === 'number' ? f.endLine : 0;
  return Math.max(startLine(f), end);
}

function locationOf(f: TyneValidateReviewFinding): CodeLocation {
  return {
    file: f.file,
    startLine: startLine(f),
    endLine: endLine(f),
    startColumn: f.startColumn,
    endColumn: f.endColumn,
  };
}

function normalizeTitle(title: unknown): string {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export type SuppressionHint = { title?: string; ruleId?: string; file?: string };

/**
 * Hard-drop findings the user marked as false positives (👎 / Ignore / Not relevant).
 * Exact normalized title; when a suppress hint includes a file, require file match too.
 */
export function dropSuppressedFindings<T extends { title?: string; ruleId?: string; file?: string }>(
  findings: T[],
  suppressed: SuppressionHint[] = [],
  extraTitles?: Iterable<string>,
): { findings: T[]; suppressedCount: number } {
  const titleOnly = new Set<string>();
  const titleAndFile = new Set<string>();
  const ruleIds = new Set<string>();
  for (const s of suppressed) {
    const t = normalizeTitle(s.title);
    const file = String(s.file || '').replace(/\\/g, '/').toLowerCase().trim();
    if (t && file) {
      titleAndFile.add(`${t}|${file}`);
    } else if (t) {
      titleOnly.add(t);
    }
    const r = String(s.ruleId || '').toLowerCase().trim();
    if (r) { ruleIds.add(r); }
  }
  if (extraTitles) {
    for (const raw of extraTitles) {
      const t = normalizeTitle(raw);
      if (t) { titleOnly.add(t); }
    }
  }
  if (!titleOnly.size && !titleAndFile.size && !ruleIds.size) {
    return { findings: findings || [], suppressedCount: 0 };
  }

  const kept: T[] = [];
  let suppressedCount = 0;
  for (const f of findings || []) {
    const ft = normalizeTitle(f.title);
    const ff = String(f.file || '').replace(/\\/g, '/').toLowerCase().trim();
    const fr = String(f.ruleId || '').toLowerCase().trim();
    const ruleHit = Boolean(fr) && ruleIds.has(fr);
    const fileScopedHit = Boolean(ft && ff) && titleAndFile.has(`${ft}|${ff}`);
    const titleHit = Boolean(ft) && titleOnly.has(ft);
    if (ruleHit || fileScopedHit || titleHit) {
      suppressedCount += 1;
      continue;
    }
    kept.push(f);
  }
  return { findings: kept, suppressedCount };
}

/** Split sentences and drop near-duplicates so merged explanations stay readable. */
export function dedupeSentences(text: string): string {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) { continue; }
    seen.add(key);
    kept.push(sentence);
  }
  return kept.join(' ');
}

/** Greedily cluster findings whose line ranges sit within `threshold` lines. */
export function clusterByLineOverlap(
  findings: TyneValidateReviewFinding[],
  threshold: number = DEFAULT_LINE_OVERLAP_THRESHOLD,
): TyneValidateReviewFinding[][] {
  const sorted = [...findings].sort((a, b) => startLine(a) - startLine(b));
  const clusters: TyneValidateReviewFinding[][] = [];
  for (const finding of sorted) {
    const last = clusters[clusters.length - 1];
    const previous = last ? last[last.length - 1] : undefined;
    // Two findings that name different rules are different issues even on the
    // same line — only cluster when the rule ids are absent or agree.
    const ruleCompatible = !previous
      || !finding.ruleId
      || !previous.ruleId
      || finding.ruleId === previous.ruleId;
    // Findings without a line anchor never cluster — merging them risks hiding
    // distinct issues behind one card.
    if (
      previous &&
      ruleCompatible &&
      startLine(finding) > 0 &&
      startLine(previous) > 0 &&
      startLine(finding) - endLine(previous) <= threshold
    ) {
      last!.push(finding);
    } else {
      clusters.push([finding]);
    }
  }
  return clusters;
}

/** Same lines, multiple engines: highest severity wins, deterministic fix preferred. */
export function mergeCluster(cluster: TyneValidateReviewFinding[]): TyneValidateReviewFinding {
  if (cluster.length === 1) { return cluster[0]; }

  const primary = cluster.reduce((a, b) =>
    displaySeverityRank(a.severity, a.category) >= displaySeverityRank(b.severity, b.category) ? a : b,
  );

  const deterministic = cluster.find(f => isDeterministic(f) && (f.fix || f.suggestedFix));
  const anyFix = cluster.find(f => f.fix)?.fix;
  const anySnippet = cluster.find(f => f.codeSnippet)?.codeSnippet;

  const explanations = cluster
    .map(f => String(f.explanation || '').trim())
    .filter(Boolean);

  return {
    ...primary,
    fix: deterministic?.fix ?? primary.fix ?? anyFix,
    suggestedFix: deterministic?.suggestedFix ?? primary.suggestedFix,
    codeSnippet: primary.codeSnippet ?? anySnippet,
    ruleId: primary.ruleId ?? cluster.find(f => f.ruleId)?.ruleId,
    cwe: primary.cwe ?? cluster.find(f => f.cwe)?.cwe,
    explanation: dedupeSentences(explanations.join(' ')),
    confidence: cluster.some(f => f.confidence === 'high') ? 'high' : primary.confidence,
  };
}

/** 3+ occurrences of the same rule collapse into one finding with relatedLocations. */
export function groupCrossFileByRule(findings: TyneValidateReviewFinding[]): TyneValidateReviewFinding[] {
  const byRule = new Map<string, TyneValidateReviewFinding[]>();
  for (const f of findings) {
    const key = f.ruleId || '';
    if (!key) { continue; }
    const arr = byRule.get(key) || [];
    arr.push(f);
    byRule.set(key, arr);
  }

  const grouped: TyneValidateReviewFinding[] = [];
  const groupedIds = new Set<string>();

  for (const [, group] of byRule) {
    const distinctFiles = new Set(group.map(f => f.file));
    if (group.length < 3 || distinctFiles.size < 2) { continue; }
    const sorted = [...group].sort((a, b) =>
      displaySeverityRank(b.severity, b.category) - displaySeverityRank(a.severity, a.category),
    );
    const [primary, ...rest] = sorted;
    grouped.push({
      ...primary,
      title: `${primary.title} (found in ${group.length} places)`,
      relatedLocations: [
        ...(primary.relatedLocations || []),
        ...rest.map(locationOf),
      ],
    });
    group.forEach(f => groupedIds.add(f.id));
  }

  if (!grouped.length) { return findings; }

  const result: TyneValidateReviewFinding[] = [];
  const emittedGroupIds = new Set(grouped.map(g => g.id));
  for (const f of findings) {
    if (!groupedIds.has(f.id)) {
      result.push(f);
    } else if (emittedGroupIds.has(f.id)) {
      result.push(grouped.find(g => g.id === f.id)!);
    }
  }
  return result;
}

/**
 * Merge all engines' findings into one clean list:
 * 1. exact title+file+line duplicates collapse,
 * 2. overlapping line ranges per file merge (severity wins, deterministic fix preferred),
 * 3. same rule in 3+ files becomes one grouped finding.
 * Severity order is preserved (worst first).
 */
export function mergeAndDeduplicateFindings(
  findings: TyneValidateReviewFinding[],
  overlapThreshold: number = DEFAULT_LINE_OVERLAP_THRESHOLD,
): TyneValidateReviewFinding[] {
  const seen = new Set<string>();
  const unique: TyneValidateReviewFinding[] = [];
  for (const f of findings || []) {
    if (!f || !f.title) { continue; }
    const key = `${f.file || ''}:${startLine(f)}:${f.ruleId || ''}:${normalizeTitle(f.title)}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    unique.push(f);
  }

  const byFile = new Map<string, TyneValidateReviewFinding[]>();
  const noFile: TyneValidateReviewFinding[] = [];
  for (const f of unique) {
    if (!f.file) { noFile.push(f); continue; }
    const arr = byFile.get(f.file) || [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  const merged: TyneValidateReviewFinding[] = [];
  for (const [, fileFindings] of byFile) {
    // Only cluster findings within the same category family — a security issue
    // and a style nit on adjacent lines are different findings, not duplicates.
    const byCategory = new Map<string, TyneValidateReviewFinding[]>();
    for (const f of fileFindings) {
      const cat = String(f.category || 'general');
      const arr = byCategory.get(cat) || [];
      arr.push(f);
      byCategory.set(cat, arr);
    }
    for (const [, catFindings] of byCategory) {
      for (const cluster of clusterByLineOverlap(catFindings, overlapThreshold)) {
        merged.push(mergeCluster(cluster));
      }
    }
  }
  merged.push(...noFile);

  const grouped = groupCrossFileByRule(merged);
  return grouped.sort((a, b) =>
    displaySeverityRank(b.severity, b.category) - displaySeverityRank(a.severity, a.category),
  );
}

/**
 * Cap minor/nit findings per file so nitpicks never bury the review. Overflow
 * collapses into a single info row per file; critical/major always survive.
 */
export function throttleLowPriorityFindings(
  findings: TyneValidateReviewFinding[],
  maxPerFileForMinorNit: number = DEFAULT_MAX_MINOR_PER_FILE,
): TyneValidateReviewFinding[] {
  const important: TyneValidateReviewFinding[] = [];
  const low: TyneValidateReviewFinding[] = [];
  for (const f of findings || []) {
    const display = toDisplaySeverity(f.severity, f.category);
    const cosmetic = THROTTLEABLE_CATEGORIES.has(String(f.category || ''));
    if (display === 'critical' || display === 'major' || !cosmetic) {
      important.push(f);
    } else {
      low.push(f);
    }
  }

  const byFile = new Map<string, TyneValidateReviewFinding[]>();
  for (const f of low) {
    const key = f.file || '';
    const arr = byFile.get(key) || [];
    arr.push(f);
    byFile.set(key, arr);
  }

  const throttled: TyneValidateReviewFinding[] = [];
  for (const [file, arr] of byFile) {
    throttled.push(...arr.slice(0, maxPerFileForMinorNit));
    const hidden = arr.length - maxPerFileForMinorNit;
    if (hidden > 0) {
      throttled.push({
        id: `throttled-${file || 'general'}`,
        file,
        title: `${hidden} more minor suggestion${hidden === 1 ? '' : 's'} in this file`,
        severity: 'low',
        category: 'style',
        confidence: 'high',
        explanation: 'Collapsed to reduce noise — expand the file in Changed files to view all.',
        source: 'local_engine',
      });
    }
  }

  return [...important, ...throttled];
}

/**
 * Re-runs often drop soft findings once majors are fixed (LLM noise). Keep prior
 * minor/nit items that still touch the current diff and weren't re-reported.
 */
export function carryForwardUnresolvedMinors(
  current: TyneValidateReviewFinding[],
  previous: TyneValidateReviewFinding[],
  opts?: { changedFiles?: string[]; dismissedTitles?: Set<string> },
): TyneValidateReviewFinding[] {
  const currentList = current || [];
  const previousList = previous || [];
  if (!previousList.length) { return currentList; }

  const changed = new Set((opts?.changedFiles || []).map(f => f.replace(/\\/g, '/')));
  const dismissed = opts?.dismissedTitles || new Set<string>();
  const seen = new Set(
    currentList.map(f => `${normalizeTitle(f.title)}|${(f.file || '').replace(/\\/g, '/')}`),
  );

  const carried: TyneValidateReviewFinding[] = [];
  for (const f of previousList) {
    const display = toDisplaySeverity(f.severity, f.category);
    if (display !== 'minor' && display !== 'nit') { continue; }
    const titleKey = normalizeTitle(f.title);
    if (!titleKey || dismissed.has(titleKey)) { continue; }
    const file = (f.file || '').replace(/\\/g, '/');
    if (changed.size && file && !changed.has(file)) { continue; }
    const key = `${titleKey}|${file}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    carried.push({
      ...f,
      id: f.id?.startsWith('carried-') ? f.id : `carried-${f.id || titleKey.slice(0, 24)}`,
      confidence: f.confidence || 'medium',
    });
  }

  if (!carried.length) { return currentList; }
  return postProcessReviewFindings([...currentList, ...carried]);
}

/**
 * Bridge structured diff fixes onto the legacy apply machinery: when a finding
 * carries fix.diff but no plain suggestedFix, derive the replacement text from
 * the diff's added lines, and the offending snippet from its removed lines.
 */
export function normalizeStructuredFix(finding: TyneValidateReviewFinding): TyneValidateReviewFinding {
  const fix = finding.fix;
  if (!fix || !fix.diff || typeof fix.diff !== 'string') { return finding; }

  const lines = fix.diff.replace(/\r\n/g, '\n').split('\n');
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    if (/^\+\+\+|^---|^@@|^diff /.test(line)) { continue; }
    if (line.startsWith('+')) { added.push(line.slice(1)); }
    else if (line.startsWith('-')) { removed.push(line.slice(1)); }
  }

  const next: TyneValidateReviewFinding = { ...finding };
  if (!next.suggestedFix && added.length && fix.applyable && fix.applyConfidence !== 'low') {
    next.suggestedFix = added.join('\n');
  }
  if (!next.codeSnippet && removed.length) {
    next.codeSnippet = removed.join('\n');
  }
  if (!next.evidence && next.codeSnippet) {
    next.evidence = next.codeSnippet;
  }
  return next;
}

/** Full post-processing pass used after the edge result + local findings land. */
export function postProcessReviewFindings(
  findings: TyneValidateReviewFinding[],
  options?: {
    overlapThreshold?: number;
    maxMinorPerFile?: number;
    changedFiles?: ChangedFileRef[];
    groundingStats?: GroundingStats;
    suppressed?: SuppressionHint[];
    dismissedTitles?: Iterable<string>;
    suppressionStats?: { suppressedCount: number };
  },
): TyneValidateReviewFinding[] {
  const stats = options?.groundingStats || emptyGroundingStats();
  const grounded = groundReviewFindings(findings || [], options?.changedFiles, stats);
  if (options?.groundingStats) {
    options.groundingStats.rawFindingCount = stats.rawFindingCount;
    options.groundingStats.droppedUngroundedCount = stats.droppedUngroundedCount;
    options.groundingStats.syntheticPathCount = stats.syntheticPathCount;
    options.groundingStats.hallucinationRate = stats.hallucinationRate;
  }
  const normalized = grounded.map(normalizeStructuredFix);
  const merged = mergeAndDeduplicateFindings(normalized, options?.overlapThreshold);
  const throttled = throttleLowPriorityFindings(merged, options?.maxMinorPerFile);
  const dropped = dropSuppressedFindings(
    throttled,
    options?.suppressed || [],
    options?.dismissedTitles,
  );
  if (options?.suppressionStats) {
    options.suppressionStats.suppressedCount = dropped.suppressedCount;
  }
  return dropped.findings;
}
