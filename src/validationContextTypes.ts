// ── PM Enrichment + Validation Graceful Degradation Types ───────────────────

import { TyneDeveloperTaskPlan, TynePmContext } from './taskTypes';

export type EnrichmentStatus = 'success' | 'partial' | 'failed' | 'skipped';

export type ValidationStatus = 'passed' | 'needs_work' | 'blocked' | 'context_limited';

export type ValidationContextSource =
  | 'enriched_pm'
  | 'stored_pm'
  | 'raw_pm'
  | 'branch_only'
  | 'diff_only';

export type ValidationConfidence = 'high' | 'medium' | 'low';

export type FallbackSubtaskSource = 'pm_child' | 'developer_plan' | 'fallback_generated';

export interface ResolvedValidationSubtask {
  title: string;
  description?: string;
  status?: string;
  source: FallbackSubtaskSource;
}

export interface ResolvedValidationContext {
  enrichmentStatus: EnrichmentStatus;
  enrichmentError?: string;
  source: ValidationContextSource;
  goal: string;
  taskDescription?: string;
  subtasks: ResolvedValidationSubtask[];
  acceptanceCriteria: string[];
  validationSteps: string[];
  pmContext?: TynePmContext;
  developerTaskPlan?: TyneDeveloperTaskPlan;
  confidence: ValidationConfidence;
}

export interface ValidationScoringPolicy {
  pmGoalCompletion: number;
  acceptanceCriteria: number;
  codeCorrectness: number;
  tests: number;
  risk: number;
  changedFileRelevance?: number;
  maintainability?: number;
}

export function getScoringPolicy(source: ValidationContextSource): ValidationScoringPolicy {
  switch (source) {
    case 'enriched_pm':
    case 'stored_pm':
      return {
        pmGoalCompletion: 35,
        acceptanceCriteria: 25,
        codeCorrectness: 20,
        tests: 15,
        risk: 5,
      };
    case 'raw_pm':
      return {
        pmGoalCompletion: 25,
        acceptanceCriteria: 0,
        codeCorrectness: 35,
        changedFileRelevance: 15,
        tests: 15,
        risk: 10,
      };
    case 'branch_only':
      return {
        pmGoalCompletion: 10,
        acceptanceCriteria: 0,
        codeCorrectness: 35,
        changedFileRelevance: 20,
        tests: 20,
        risk: 15,
      };
    case 'diff_only':
    default:
      return {
        pmGoalCompletion: 0,
        acceptanceCriteria: 0,
        codeCorrectness: 45,
        tests: 25,
        risk: 15,
        maintainability: 15,
      };
  }
}

export function confidenceFromSource(source: ValidationContextSource, enrichmentStatus: EnrichmentStatus): ValidationConfidence {
  if (enrichmentStatus === 'failed') {
    return source === 'diff_only' ? 'low' : 'low';
  }
  if (enrichmentStatus === 'partial') {
    return 'medium';
  }
  switch (source) {
    case 'enriched_pm':
      return 'high';
    case 'stored_pm':
      return 'high';
    case 'raw_pm':
      return 'medium';
    case 'branch_only':
      return 'low';
    case 'diff_only':
      return 'low';
    default:
      return 'medium';
  }
}

export function enrichmentWarningMessage(enrichmentStatus: EnrichmentStatus, source: ValidationContextSource): string | undefined {
  if (enrichmentStatus === 'failed') {
    return 'PM enrichment failed. Used fallback validation context.';
  }
  if (enrichmentStatus === 'partial') {
    return 'PM enrichment was partial. Validation used available context.';
  }
  if (source === 'raw_pm') {
    return 'Used raw PM task data. Enriched intelligence was unavailable.';
  }
  if (source === 'branch_only') {
    return 'Limited task context. Validation based on branch and changed files.';
  }
  if (source === 'diff_only') {
    return 'Limited task context. Validation based on code diff only.';
  }
  return undefined;
}

export function shouldShowRetryEnrichment(enrichmentStatus: EnrichmentStatus): boolean {
  return enrichmentStatus === 'failed' || enrichmentStatus === 'partial';
}

export function normalizeError(err: unknown): string {
  if (err instanceof Error) { return err.message; }
  return String(err);
}
