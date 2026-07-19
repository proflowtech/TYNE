import type { QualityFinding, QualityMetrics, QualityScorecard, QualityReviewContext } from './qualityTypes';

/**
 * Industry-style quality measurement (Sonar/SQALE-inspired):
 * severity-weighted issues + density + complexity + debt ratio → 0–100 dims.
 * # ponytail: heuristic model on diff-scoped findings; upgrade to LOC-normalized
 * debt ratio when changed-line counts are always available.
 */

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function statusFor(score: number): 'good' | 'warn' | 'bad' | 'neutral' {
  if (score >= 85) return 'good';
  if (score >= 65) return 'warn';
  return 'bad';
}

/** Rating bands roughly aligned with maintainability rating A–E. */
export function qualityRating(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 50) return 'D';
  return 'E';
}

/** Blocker/Critical/Major/Minor-style weights. */
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 28,
  high: 16,
  medium: 9,
  low: 3,
};

function issuePenalty(list: QualityFinding[]): number {
  const base = list.reduce((n, f) => {
    const w = SEVERITY_WEIGHT[f.severity] || 3;
    return n + (f.blocking ? w * 1.35 : w);
  }, 0);
  // Density: repeated issues in one dimension compound (not just sum).
  const density = list.length <= 1 ? 0 : Math.min(24, (list.length - 1) * 4);
  return base + density;
}

function scoreDimension(list: QualityFinding[], extraPenalty = 0): number {
  return clamp(100 - issuePenalty(list) - extraPenalty);
}

export function scoreQuality(findings: QualityFinding[], baseMetrics: Partial<QualityMetrics>): {
  metrics: QualityMetrics;
  scorecard: QualityScorecard;
  qualityScore: number;
  vibeCodeRisk: 'low' | 'medium' | 'high';
  sectionScores: QualityReviewContext['sectionScores'];
  debtMinutes: number;
} {
  const vibeFindings = findings.filter(f => f.category === 'vibe_code');
  const maintainabilityFindings = findings.filter(f =>
    f.category === 'maintainability' || f.category === 'performance' || f.category === 'style'
    || f.subcategory === 'complexity' || f.subcategory === 'clone' || f.subcategory === 'god_function',
  );
  const architectureFindings = findings.filter(f =>
    f.detectedBy === 'architecture' || f.subcategory === 'layer_violation',
  );
  const consistencyFindings = findings.filter(f => f.detectedBy === 'consistency');
  const correctnessFindings = findings.filter(f =>
    f.category === 'correctness' || f.category === 'breaking_change',
  );
  const debtMinutes = findings.reduce((n, f) => n + (f.debtMinutes || 0), 0);

  const complexityExtra = Math.max(0, (baseMetrics.maxComplexity || 0) - 10) * 2.5
    + Math.max(0, (baseMetrics.maxNesting || 0) - 4) * 2;
  const cloneExtra = findings.filter(f => f.subcategory === 'clone').length * 6;

  const scorecard: QualityScorecard = {
    correctness: scoreDimension(correctnessFindings),
    maintainability: scoreDimension(maintainabilityFindings, complexityExtra + cloneExtra),
    vibe: scoreDimension(vibeFindings),
    architecture: scoreDimension(architectureFindings),
    overall: 0,
  };
  // Reliability-leaning blend (correctness+vibe) + maintainability + architecture.
  scorecard.overall = clamp(
    scorecard.correctness * 0.28
    + scorecard.maintainability * 0.32
    + scorecard.vibe * 0.25
    + scorecard.architecture * 0.15,
  );

  const vibeCodeRisk: 'low' | 'medium' | 'high' =
    vibeFindings.some(f => f.severity === 'critical' || f.blocking)
      ? 'high'
      : vibeFindings.some(f => f.severity === 'high') || vibeFindings.length >= 3
        ? 'medium'
        : 'low';

  // Debt ratio: remediation minutes vs a baseline “healthy change” budget (~30 min / finding slot).
  const remediationBudget = Math.max(30, findings.length * 25, 60);
  const debtRatio = Math.round((debtMinutes / remediationBudget) * 100) / 100;

  const metrics: QualityMetrics = {
    maxComplexity: baseMetrics.maxComplexity || 0,
    avgComplexity: baseMetrics.avgComplexity || 0,
    maxNesting: baseMetrics.maxNesting || 0,
    clonePairs: findings.filter(f => f.subcategory === 'clone').length,
    vibeFindings: vibeFindings.length,
    maintainabilityFindings: maintainabilityFindings.length,
    architectureFindings: architectureFindings.length,
    consistencyFindings: consistencyFindings.length,
    totalFindings: findings.length,
    debtMinutes,
    debtRatio,
    rating: qualityRating(scorecard.overall),
  };

  const sectionScores: QualityReviewContext['sectionScores'] = [
    { id: 'correctness', label: 'Correctness', score: scorecard.correctness, status: statusFor(scorecard.correctness) },
    { id: 'maintainability', label: 'Maintainability', score: scorecard.maintainability, status: statusFor(scorecard.maintainability) },
    { id: 'vibe_code', label: 'Vibe Code', score: scorecard.vibe, status: statusFor(scorecard.vibe) },
    { id: 'architecture', label: 'Architecture', score: scorecard.architecture, status: statusFor(scorecard.architecture) },
  ];

  return {
    metrics,
    scorecard,
    qualityScore: scorecard.overall,
    vibeCodeRisk,
    sectionScores,
    debtMinutes,
  };
}

export function toEgressSummary(ctx: Omit<QualityReviewContext, 'egressSummary' | 'recurringVibeTitles'>): QualityReviewContext['egressSummary'] {
  return {
    qualityScore: ctx.qualityScore,
    vibeCodeRisk: ctx.vibeCodeRisk,
    scorecard: ctx.scorecard,
    metrics: ctx.metrics,
    findingTitles: ctx.findings.slice(0, 24).map(f => ({
      title: f.title,
      severity: f.severity,
      category: f.category,
      subcategory: f.subcategory,
      file: f.file,
      line: f.line,
      debtMinutes: f.debtMinutes,
      metricValue: f.metricValue,
    })),
    betterPatterns: ctx.findings.map(f => f.betterPattern).filter(Boolean).slice(0, 8) as string[],
  };
}
