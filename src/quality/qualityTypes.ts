/**
 * Code quality engine types for Validate & Review.
 * Deterministic evidence is source of truth; LLM explains only.
 */

export type QualitySeverity = 'critical' | 'high' | 'medium' | 'low';
export type QualityConfidence = 'high' | 'medium' | 'low';
export type QualityCategory =
  | 'correctness'
  | 'maintainability'
  | 'vibe_code'
  | 'performance'
  | 'style'
  | 'breaking_change';

export type QualityDetectedBy =
  | 'ast_rule'
  | 'metric'
  | 'clone'
  | 'consistency'
  | 'architecture'
  | 'semgrep'
  | 'llm'
  | 'combined';

export type QualitySubcategory =
  | 'placeholder'
  | 'empty_catch'
  | 'console_leftover'
  | 'unused_export'
  | 'hallucinated_import'
  | 'over_abstraction'
  | 'complexity'
  | 'god_function'
  | 'clone'
  | 'naming_inconsistency'
  | 'error_handling_inconsistency'
  | 'layer_violation'
  | 'duplicate_utility'
  | 'hot_loop'
  | 'sync_io'
  | 'debt';

export interface QualityFinding {
  id: string;
  ruleId: string;
  subcategory: QualitySubcategory;
  category: QualityCategory;
  severity: QualitySeverity;
  confidence: QualityConfidence;
  title: string;
  explanation: string;
  file: string;
  line?: number;
  endLine?: number;
  evidence: string;
  suggestedFix?: string;
  detectedBy: QualityDetectedBy;
  blocking: boolean;
  metricValue?: number;
  betterPattern?: string;
  /** Estimated remediation minutes (Q4 debt). */
  debtMinutes?: number;
  language?: string;
}

export interface QualityMetrics {
  maxComplexity: number;
  avgComplexity: number;
  maxNesting: number;
  clonePairs: number;
  vibeFindings: number;
  maintainabilityFindings: number;
  architectureFindings: number;
  consistencyFindings: number;
  totalFindings: number;
  debtMinutes: number;
  /** Remediation minutes / budget (SQALE-style debt ratio). */
  debtRatio?: number;
  /** Overall maintainability-style rating A–E. */
  rating?: 'A' | 'B' | 'C' | 'D' | 'E';
}

export interface QualityScorecard {
  correctness: number;
  maintainability: number;
  vibe: number;
  architecture: number;
  overall: number;
}

export interface QualityReviewContext {
  findings: QualityFinding[];
  metrics: QualityMetrics;
  scorecard: QualityScorecard;
  qualityScore: number;
  vibeCodeRisk: 'low' | 'medium' | 'high';
  sectionScores: Array<{ id: string; label: string; score: number; status: 'good' | 'warn' | 'bad' | 'neutral' }>;
  recurringVibeTitles?: Array<{ title: string; count: number }>;
  /** Egress-safe summary (titles + metrics; no raw source). */
  egressSummary: QualityEgressSummary;
}

export interface QualityEgressSummary {
  qualityScore: number;
  vibeCodeRisk: 'low' | 'medium' | 'high';
  scorecard: QualityScorecard;
  metrics: QualityMetrics;
  findingTitles: Array<{
    title: string;
    severity: string;
    category: string;
    subcategory: string;
    file?: string;
    line?: number;
    debtMinutes?: number;
    metricValue?: number;
  }>;
  betterPatterns: string[];
}
