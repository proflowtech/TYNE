export type TyneValidationStatus = 'pass' | 'partial' | 'fail';

export type TyneRiskLevel = 'low' | 'medium' | 'high' | 'not_assessed';

export type TyneAiProvider = 'anthropic' | 'openai' | 'managed';

export type TynePlanTier = 'free' | 'pro' | 'max';

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
  suggestions?: string[];
  codeQualityNotes?: string[];
  filesReviewed?: string[];
  durationMs?: number;
  createdAt: string;
}

export interface TyneValidationInput {
  taskId?: string;
  taskTitle?: string;
  taskDescription?: string;
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
  reason?: 'ok' | 'free_limit_reached' | 'pro_limit_reached_no_byok' | 'missing_byok' | 'missing_task' | 'missing_diff' | 'no_git_repo' | 'provider_error';
  message?: string;
  usage: TyneValidationUsage;
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
}

export interface TyneEnhancedValidationView {
  id: string;
  status: TyneValidationStatus;
  matchPercent?: number;
  riskLevel?: TyneRiskLevel;
  summary: string;
  detailedExplanation?: string;
  missingRequirements?: string[];
  suggestions?: string[];
  codeQualityNotes?: string[];
  filesReviewed?: string[];
  taskId?: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  provider: TyneAiProvider;
  createdAt: string;
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
