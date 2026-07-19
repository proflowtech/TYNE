export type TyneReviewMode =
  | 'staged_changes'
  | 'current_branch'
  | 'pm_task'
  | 'before_commit'
  | 'before_pr';

export type TyneCodeReviewStatus = 'passed' | 'needs_work' | 'blocked';
export type TyneCodeReviewRiskLevel = 'low' | 'medium' | 'high';

export type TynePmAlignmentStatus = 'aligned' | 'partially_aligned' | 'not_aligned' | 'unknown';
export type TyneCodeReviewPmValidationStatus = 'addressed' | 'not_addressed' | 'unclear' | 'unknown';

export type TyneCodeReviewIssueCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'test_coverage'
  | 'maintainability';

export type TyneCodeReviewIssueSeverity = 'critical' | 'high' | 'medium';
export type TyneCodeReviewInlineSeverity = 'critical' | 'high' | 'medium' | 'low';
export type TyneMissingTestType = 'unit' | 'integration' | 'e2e' | 'manual';

export interface TyneCodeReviewMustFix {
  title: string;
  file?: string;
  line?: number;
  category: TyneCodeReviewIssueCategory;
  severity: TyneCodeReviewIssueSeverity;
  reason: string;
  suggestedFix?: string;
}

export interface TyneCodeReviewSuggestion {
  title: string;
  file?: string;
  line?: number;
  reason: string;
  suggestedFix?: string;
}

export interface TyneCodeReviewGoodPoint {
  title: string;
  evidence?: string;
}

export interface TyneCodeReviewMissingTest {
  title: string;
  testType: TyneMissingTestType;
  relatedFile?: string;
  reason: string;
}

export interface TyneCodeReviewInlineComment {
  file: string;
  line?: number;
  severity: TyneCodeReviewInlineSeverity;
  category: string;
  title?: string;
  comment: string;
  body?: string;
  suggestion?: string;
  diffSuggestion?: string;
  committableSuggestion?: boolean;
}

export interface TyneCodeReviewPmAlignment {
  status: TynePmAlignmentStatus;
  completedGoals: string[];
  pendingGoals: string[];
}

export interface TyneCodeReviewEffort {
  score: 1 | 2 | 3 | 4 | 5;
  label: string;
  estimatedMinutes: number;
  reason?: string;
}

export interface TyneCodeReviewSequenceDiagram {
  title: string;
  mermaid: string;
  relatedFiles?: string[];
}

export interface TyneCodeReviewChangedFileSummary {
  title: string;
  files: string[];
  summary: string;
}

export interface TyneCodeReviewDetails {
  reviewedFileCount: number;
  filesSelected: string[];
  filesSkipped: string[];
  noReviewableChangeFiles: string[];
}

export interface TyneCodeReviewPmValidation {
  status: TyneCodeReviewPmValidationStatus;
  issueIdentifier?: string;
  summary?: string;
  completedRequirements: string[];
  gaps: string[];
  actionRequired?: string;
}

export interface TyneCodeReviewResult {
  id?: string;
  createdAt?: string;
  reviewMode?: TyneReviewMode;
  currentBranch?: string;
  changedFiles?: string[];
  status: TyneCodeReviewStatus;
  score: number;
  riskLevel: TyneCodeReviewRiskLevel;
  summary: string;
  /** Legacy only. Task-fit/scope validation now comes from Validate & Review. */
  pmAlignment?: TyneCodeReviewPmAlignment;
  /** Legacy only. Task-fit/scope validation now comes from Validate & Review. */
  pmValidation?: TyneCodeReviewPmValidation;
  reviewEffort?: TyneCodeReviewEffort;
  sequenceDiagrams?: TyneCodeReviewSequenceDiagram[];
  changedFilesSummary?: TyneCodeReviewChangedFileSummary[];
  reviewDetails?: TyneCodeReviewDetails;
  mustFix: TyneCodeReviewMustFix[];
  suggestions: TyneCodeReviewSuggestion[];
  goodPoints: TyneCodeReviewGoodPoint[];
  missingTests: TyneCodeReviewMissingTest[];
  inlineComments: TyneCodeReviewInlineComment[];
  fullReport?: string;
}

export interface TyneReviewPmSubtask {
  title: string;
  description?: string;
  status?: string;
}

export interface TyneReviewDeveloperTaskPlan {
  issueKey: string;
  title: string;
  technicalSummary: string;
  implementationTasks: Array<{
    title: string;
    description: string;
    likelyFiles: string[];
    dependencies?: string[];
    status: 'not_started' | 'in_progress' | 'completed';
  }>;
  testingTasks: Array<{
    title: string;
    testType: 'unit' | 'integration' | 'e2e' | 'manual';
    likelyFiles?: string[];
  }>;
  riskNotes: string[];
  questionsForPM?: string[];
}

export interface TyneReviewPmTask {
  source: 'jira' | 'linear';
  issueId?: string;
  issueIdentifier?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  subtasks?: TyneReviewPmSubtask[];
  developerTaskPlan?: TyneReviewDeveloperTaskPlan;
}

export interface TyneReviewRelevantFile {
  path: string;
  reason: string;
  snippet?: string;
}

export interface TyneReviewExistingTest {
  path: string;
  reason: string;
}

export interface TyneReviewGuardrails {
  requireTests?: boolean;
  allowedCommitTypes?: string[];
  customRules?: string[];
}

export interface TyneReviewContextPack {
  repositoryName: string;
  currentBranch: string;
  reviewMode: TyneReviewMode;
  projectHints: {
    language?: string;
    framework?: string;
    packageManager?: string;
    testFramework?: string;
  };
  git: {
    changedFiles: string[];
    stagedDiff?: string;
    branchDiff?: string;
  };
  pmTask?: TyneReviewPmTask;
  relevantFiles: TyneReviewRelevantFile[];
  existingTests: TyneReviewExistingTest[];
  guardrails?: TyneReviewGuardrails;
}

export interface TyneCodeReviewRequest {
  context: TyneReviewContextPack;
  byokKey?: string;
  byokProvider?: string;
  model?: string;
}

export interface TyneCodeReviewResponse {
  result: TyneCodeReviewResult;
  provider: string;
  model: string;
}

export interface TyneCodeReviewError {
  error: string;
}

export function isReviewResult(value: unknown): value is TyneCodeReviewResult {
  if (!value || typeof value !== 'object') { return false; }
  const r = value as Record<string, unknown>;
  return (
    (r.status === 'passed' || r.status === 'needs_work' || r.status === 'blocked') &&
    typeof r.score === 'number' &&
    (r.riskLevel === 'low' || r.riskLevel === 'medium' || r.riskLevel === 'high') &&
    typeof r.summary === 'string' &&
    Array.isArray(r.mustFix) &&
    Array.isArray(r.suggestions) &&
    Array.isArray(r.goodPoints) &&
    Array.isArray(r.missingTests) &&
    Array.isArray(r.inlineComments)
  );
}

export function compactReviewResultLimits(result: TyneCodeReviewResult): TyneCodeReviewResult {
  const sentences = result.summary.split(/\.\s+/).filter(Boolean);
  const short = sentences.slice(0, 2).join('. ') + '.';
  return {
    ...result,
    summary: short,
    sequenceDiagrams: result.sequenceDiagrams?.slice(0, 3),
    changedFilesSummary: result.changedFilesSummary?.slice(0, 6),
    reviewDetails: result.reviewDetails ? {
      ...result.reviewDetails,
      filesSelected: result.reviewDetails.filesSelected.slice(0, 20),
      filesSkipped: result.reviewDetails.filesSkipped.slice(0, 20),
      noReviewableChangeFiles: result.reviewDetails.noReviewableChangeFiles.slice(0, 20),
    } : undefined,
    pmValidation: result.pmValidation ? {
      ...result.pmValidation,
      completedRequirements: result.pmValidation.completedRequirements.slice(0, 6),
      gaps: result.pmValidation.gaps.slice(0, 6),
    } : undefined,
    mustFix: result.mustFix.slice(0, 5),
    suggestions: result.suggestions.slice(0, 5),
    goodPoints: result.goodPoints.slice(0, 3),
    missingTests: result.missingTests.slice(0, 4),
  };
}
