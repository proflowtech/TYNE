export type TyneValidationStatus = 'pass' | 'partial' | 'fail';

export type TyneEnrichmentStatus = 'success' | 'partial' | 'failed' | 'skipped';

export type TyneContextualValidationStatus = 'passed' | 'needs_work' | 'blocked' | 'context_limited';

export type TyneValidationContextSource = 'enriched_pm' | 'stored_pm' | 'raw_pm' | 'branch_only' | 'diff_only';

export type TyneValidationConfidence = 'high' | 'medium' | 'low';

export type TyneRiskLevel = 'low' | 'medium' | 'high' | 'not_assessed';

export type TyneAiProvider = 'anthropic' | 'openai' | 'managed';

export type TynePlanTier = 'free' | 'pro' | 'max';

export type TyneValidationStepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'warning'
  | 'failed'
  | 'skipped';

export type TyneValidationTraceProvider =
  | 'rule_engine'
  | 'internal'
  | 'deepseek'
  | 'claude'
  | 'openai'
  | 'manual'
  | 'system'
  | 'axiom';

export type TyneValidationTraceOverallStatus = 'pending' | 'running' | 'success' | 'warning' | 'failed';

export type TyneValidationWorkflowType = 'code_validation';

export interface TyneValidationCompletedGoal {
  title: string;
  evidence?: string;
  relatedFiles?: string[];
}

export interface TyneValidationPendingGoal {
  title: string;
  reason: string;
  suggestedAction: string;
  relatedFiles?: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface TyneValidationDeveloperAction {
  title: string;
  fileHint?: string;
  reason?: string;
}

export interface TyneValidationCodeEvidence {
  file: string;
  reason: string;
}

export interface TyneValidationStepTrace {
  id: string;
  key: string;
  title: string;
  description?: string;
  status: TyneValidationStepStatus;
  provider?: TyneValidationTraceProvider;
  model?: string;
  summary?: string;
  details?: string;
  evidence?: string[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  confidence?: number | null;
  errorMessage?: string | null;
  retryCount?: number;
  costEstimate?: number | null;
  tokenEstimate?: number | null;
  metadata?: Record<string, unknown>;
}

export interface TyneValidationTrace {
  id: string;
  traceType: TyneValidationWorkflowType;
  entityType?: string;
  entityId?: string;
  overallStatus: TyneValidationTraceOverallStatus;
  currentStepKey?: string;
  planTier?: 'core' | 'pro' | 'max';
  strategySummary?: string;
  executionMode?: 'deterministic' | 'hybrid' | 'staged';
  steps: TyneValidationStepTrace[];
  createdAt: string;
  updatedAt: string;
}

export interface TyneValidationResult {
  id: string;
  taskId?: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  provider: TyneAiProvider;
  tier: TynePlanTier;
  status: TyneValidationStatus;
  matchPercent?: number;
  riskLevel?: TyneRiskLevel;
  summary: string;
  detailedExplanation?: string;
  missingRequirements?: string[];
  criteriaMet?: string[];
  criteriaNotMet?: Array<{ criterion: string; reason: string }>;
  suggestions?: string[];
  codeQualityNotes?: string[];
  /** Evidence that acceptance criteria were satisfied (from PM validation). */
  generatedProofPoints?: string[];
  filesReviewed?: string[];
  completedGoals?: TyneValidationCompletedGoal[];
  pendingGoals?: TyneValidationPendingGoal[];
  developerActions?: TyneValidationDeveloperAction[];
  codeEvidence?: TyneValidationCodeEvidence[];
  fullReport?: string;
  enrichmentStatus?: TyneEnrichmentStatus;
  enrichmentError?: string;
  contextSource?: TyneValidationContextSource;
  confidence?: TyneValidationConfidence;
  validationStatus?: TyneContextualValidationStatus;
  warnings?: string[];
  resolvedContext?: unknown;
  developerTaskPlan?: unknown;
  durationMs?: number;
  createdAt: string;
  trace?: TyneValidationTrace;
}

export interface TyneValidationInput {
  taskId?: string;
  taskTitle?: string;
  taskDescription?: string;
  provider?: string;
  subtasks?: string[];
  acceptanceCriteria?: string[];
  goal?: string;
  branchName?: string;
  commitHash?: string;
  changedFiles: string[];
  diffText: string;
  linesAdded?: number;
  linesDeleted?: number;
  tier: TynePlanTier;
}

export interface TyneValidationUsage {
  tier: TynePlanTier;
  month: string;
  used: number;
  limit: number | 'unlimited';
  byokUnlimitedActive: boolean;
  resetAt: string;
  updatedAt: string;
}

export interface TyneValidationLimitDecision {
  allowed: boolean;
  reason?: 'ok' | 'free_limit_reached' | 'pro_limit_reached_no_byok' | 'missing_byok' | 'missing_task' | 'missing_diff' | 'no_git_repo' | 'provider_error' | 'usage_unavailable';
  message?: string;
  usage?: TyneValidationUsage;
  warnings?: string[];
}

export interface TyneValidationHistoryFilters {
  dateRange?: { start: string; end: string };
  statuses?: TyneValidationStatus[];
  taskIds?: string[];
  branches?: string[];
  riskLevels?: TyneRiskLevel[];
  providers?: TyneAiProvider[];
  minMatchPercent?: number;
  maxMatchPercent?: number;
  hasMissingRequirements?: boolean;
  hasSuggestions?: boolean;
  currentProjectOnly?: boolean;
  query?: string;
  // Legacy single-value filters retained for simple callers.
  taskId?: string;
  branchName?: string;
  status?: TyneValidationStatus;
  riskLevel?: TyneRiskLevel;
  since?: string;
  until?: string;
  provider?: TyneAiProvider;
}

export interface TyneValidationTrendSummary {
  totalValidations: number;
  passRatePercent: number;
  partialRatePercent: number;
  failRatePercent: number;
  averageMatchPercent?: number;
  averageRiskLevel?: TyneRiskLevel;
  validationsThisWeek: number;
  validationsThisMonth: number;
  mostValidatedTaskId?: string;
  mostValidatedTaskTitle?: string;
  trendDirection: 'improving' | 'declining' | 'stable' | 'not_enough_data';
}

export interface TyneFreeValidationView {
  id: string;
  status: TyneValidationStatus;
  summary: string;
  taskId?: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  createdAt: string;
  trace?: TyneValidationTrace;
}

export interface TyneEnhancedValidationView {
  id: string;
  status: TyneValidationStatus;
  matchPercent?: number;
  riskLevel?: TyneRiskLevel;
  summary: string;
  detailedExplanation?: string;
  missingRequirements?: string[];
  criteriaMet?: string[];
  criteriaNotMet?: Array<{ criterion: string; reason: string }>;
  suggestions?: string[];
  codeQualityNotes?: string[];
  /** Evidence that acceptance criteria were satisfied (from PM validation). */
  generatedProofPoints?: string[];
  filesReviewed?: string[];
  taskId?: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  provider: TyneAiProvider;
  createdAt: string;
  trace?: TyneValidationTrace;
}

export interface TyneAiProviderTestResult {
  ok: boolean;
  error?: string;
}

export interface TyneAiProviderAdapter {
  readonly provider: TyneAiProvider;

  testConnection(apiKey?: string): Promise<TyneAiProviderTestResult>;

  validateCode(input: TyneValidationInput, apiKey?: string): Promise<TyneValidationResult>;
}

export interface TyneByokConfig {
  ai: {
    provider: TyneAiProvider;
    hasKey: boolean;
    maskedKey: string;
    updatedAt: string;
  };
}

export interface TyneValidationUsageSummary {
  used: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  isWarning: boolean;
  isBlocked: boolean;
  byokUnlimitedActive: boolean;
  message?: string;
}
