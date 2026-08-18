/**
 * Local Code Quality Review Engine orchestrator.
 * Diff-scoped AST facts + vibe/complexity/clone/consistency/architecture/perf (+ optional Semgrep).
 */
import { extractFileFacts, type FileFacts } from './astFacts';
import { scanComplexity, summarizeComplexity } from './complexityMetrics';
import { scanVibeCode } from './vibeCodeScanner';
import { detectClones } from './cloneDetector';
import { mineConsistency } from './consistencyMiner';
import { scanArchitecture } from './architectureRules';
import { scanPerformance } from './performancePatterns';
import { collectSemgrepFindings } from './semgrepAdapter';
import { scoreQuality, toEgressSummary } from './qualityScoring';
import { detectSemanticClones } from './semantic/semanticCloneDetector';
import type { FingerprintIndex } from './semantic/fingerprintIndex';
import type { QualityFinding, QualityReviewContext } from './qualityTypes';
import { withClassifiedAction } from '../actionEngine';

export type { QualityReviewContext, QualityFinding } from './qualityTypes';

export interface QualityEngineInput {
  diff: string;
  changedFiles: Array<{ path: string }>;
  /** Nearby / changed file contents from safe context. */
  fileContents?: Array<{ path: string; content: string }>;
  nearbyContents?: Array<{ path: string; content?: string; snippet?: string }>;
  workspaceRoot?: string;
  /** Optional recurring vibe titles from trends (Q3). */
  recurringVibeTitles?: Array<{ title: string; count: number }>;
  /** Pre-computed per-file vibe findings (parallel batch path). */
  parallelVibeFindings?: QualityFinding[];
  /**
   * Prebuilt workspace fingerprint index for semantic clone detection. When
   * absent the detector falls back to the nearby-file window, which only sees
   * what safe-context collection already loaded.
   */
  semanticIndex?: FingerprintIndex;
}

export async function runLocalQualityEngine(input: QualityEngineInput): Promise<QualityReviewContext> {
  const contents = collectContents(input);
  const changedPaths = new Set(input.changedFiles.map(f => f.path));
  const changedFacts: FileFacts[] = [];
  const nearbyFacts: FileFacts[] = [];

  for (const item of contents) {
    const facts = extractFileFacts(item.path, item.content);
    if (changedPaths.has(item.path)) changedFacts.push(facts);
    else nearbyFacts.push(facts);
  }

  // If we only have diff (no contents), still run vibe/perf on diff text alone
  const vibeFindings = input.parallelVibeFindings?.length
    ? input.parallelVibeFindings
    : scanVibeCode({ diff: input.diff, fileFacts: [...changedFacts, ...nearbyFacts] });
  const corpusContents = contents.filter(c => !changedPaths.has(c.path));

  // Function-level semantic duplication. Runs before the coarse lexical clone
  // pass so its findings can take precedence — see pruneCoarseClones.
  let semanticFindings: QualityFinding[] = [];
  try {
    semanticFindings = detectSemanticClones({
      diff: input.diff,
      changedFiles: contents.filter(c => changedPaths.has(c.path)),
      repoFiles: corpusContents,
      index: input.semanticIndex,
    }).findings;
  } catch { /* duplication analysis must never fail a review */ }

  const findings: QualityFinding[] = [
    ...vibeFindings,
    ...scanComplexity(changedFacts.length ? changedFacts : nearbyFacts.filter(f => changedPaths.has(f.path))),
    ...semanticFindings,
    ...pruneCoarseClones(
      detectClones({
        diff: input.diff,
        nearbyContents: corpusContents.map(c => ({ path: c.path, content: c.content })),
      }),
      semanticFindings,
    ),
    ...mineConsistency({ diff: input.diff, changedFacts, nearbyFacts }),
    ...scanArchitecture(changedFacts),
    ...scanPerformance(input.diff),
  ];

  if (input.workspaceRoot) {
    try {
      findings.push(...await collectSemgrepFindings({
        workspaceRoot: input.workspaceRoot,
        changedFiles: input.changedFiles.map(f => f.path),
      }));
    } catch { /* ignore */ }
  }

  // Boost severity when title recurs in history
  if (input.recurringVibeTitles?.length) {
    const recur = new Map(input.recurringVibeTitles.map(r => [r.title.toLowerCase(), r.count]));
    for (const f of findings) {
      if (f.category !== 'vibe_code') continue;
      const count = recur.get(f.title.toLowerCase()) || 0;
      if (count >= 2) {
        f.explanation = `${f.explanation} Recurring vibe issue (seen ${count} times in recent reviews).`;
        f.debtMinutes = (f.debtMinutes || 20) + count * 10;
        if (f.severity === 'medium') f.severity = 'high';
      }
    }
  }

  const deduped = dedupeFindings(findings).slice(0, 40);
  const complexity = summarizeComplexity(changedFacts);
  const scored = scoreQuality(deduped, complexity);

  const ctxWithoutEgress = {
    findings: deduped,
    metrics: scored.metrics,
    scorecard: scored.scorecard,
    qualityScore: scored.qualityScore,
    vibeCodeRisk: scored.vibeCodeRisk,
    sectionScores: scored.sectionScores,
    recurringVibeTitles: input.recurringVibeTitles,
  };

  return {
    ...ctxWithoutEgress,
    egressSummary: toEgressSummary(ctxWithoutEgress),
  };
}

function collectContents(input: QualityEngineInput): Array<{ path: string; content: string }> {
  const map = new Map<string, string>();
  for (const f of input.fileContents || []) {
    if (f.path && f.content) map.set(f.path, f.content);
  }
  for (const f of input.nearbyContents || []) {
    const content = f.content || f.snippet || '';
    if (f.path && content && !map.has(f.path)) map.set(f.path, content);
  }
  return [...map.entries()].map(([path, content]) => ({ path, content })).slice(0, 24);
}

/**
 * Drop file-level clone findings for files where the semantic pass already
 * reported duplication. Both detectors would otherwise describe the same
 * duplication twice, and the function-level finding is strictly more useful:
 * it names the callable to reuse instead of the file it lives in.
 */
function pruneCoarseClones(
  coarse: QualityFinding[],
  semantic: QualityFinding[],
): QualityFinding[] {
  if (!semantic.length) return coarse;
  const covered = new Set(semantic.map(f => f.file));
  return coarse.filter(f => !covered.has(f.file));
}

function dedupeFindings(findings: QualityFinding[]): QualityFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.ruleId}:${f.file}:${f.line || 0}:${f.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Map quality findings into Validate & Review finding shape. */
export function qualityFindingsToReviewFindings(findings: QualityFinding[]): Array<Record<string, unknown>> {
  return findings.map(f => withClassifiedAction({
    id: f.id,
    file: f.file,
    line: f.line,
    endLine: f.endLine,
    severity: f.severity,
    category: f.category,
    title: f.title,
    explanation: f.explanation + (f.betterPattern ? ` Better pattern: ${f.betterPattern}` : ''),
    suggestedFix: f.suggestedFix,
    confidence: f.confidence,
    evidence: f.evidence,
    architectureImpact: f.detectedBy === 'architecture'
      ? f.explanation
      : undefined,
    detectedBy: f.detectedBy,
    ruleId: f.ruleId,
    debtMinutes: f.debtMinutes,
    metricValue: f.metricValue,
  }) as unknown as Record<string, unknown>);
}
