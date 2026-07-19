// ── Tyne Validate & Review Engine — Type Definitions ─────────────────────────

import type { AiSlopSignals } from './quality/vibeCodeScanner';
import type { ScopeDriftExplanation } from './services/scopeDriftExplainer';
import type { ACValidation } from './quality/acceptanceCriteriaValidator';

export type ReviewScope =
  | 'staged_changes'
  | 'unstaged_changes'
  | 'last_commit'
  | 'selected_commit';

export type ReviewTier = 'free' | 'pro' | 'max';

export type ReviewStatus = 'passed' | 'needs_work' | 'blocked' | 'context_limited';
export type ReviewRiskLevel = 'low' | 'medium' | 'high';
export type ReviewVibeCodeRisk = 'low' | 'medium' | 'high';

export type ReviewFindingSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewFindingConfidence = 'high' | 'medium' | 'low';

export type ReviewFindingCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'test_coverage'
  | 'pm_alignment'
  | 'vibe_code'
  | 'style'
  | 'breaking_change'
  | 'compliance';

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type ReviewTestType = 'unit' | 'integration' | 'e2e' | 'security' | 'manual';

export type SecurityStatus = 'passed' | 'warning' | 'needs_work' | 'blocked';

export type SecurityCategory =
  | 'secrets'
  | 'data_exposure'
  | 'authentication'
  | 'authorization'
  | 'prompt_injection'
  | 'agent_tool_security'
  | 'sql_injection'
  | 'command_injection'
  | 'xss'
  | 'ssrf'
  | 'path_traversal'
  | 'unsafe_deserialization'
  | 'dependency'
  | 'configuration'
  | 'supply_chain';

export type SecurityDetectedBy = 'ast_rule' | 'secret_scanner' | 'dependency_scanner' | 'dataflow' | 'llm' | 'combined';

export interface SecurityFinding {
  id: string;
  ruleId?: string;
  title: string;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingConfidence;
  category: SecurityCategory;
  file: string;
  line?: number;
  endLine?: number;
  source?: string;
  sink?: string;
  dataFlow?: Array<{ file: string; line?: number; description: string }>;
  evidence: string;
  impact: string;
  remediation: string;
  references?: Array<{ standard: 'OWASP' | 'CWE' | 'Tyne Rule'; id: string }>;
  detectedBy: SecurityDetectedBy;
  blocking: boolean;
}

export interface SecurityDataFlow {
  source: string;
  transformations: string[];
  sink: string;
  files: Array<{ path: string; line?: number }>;
}

// ── Policy-driven compliance ──────────────────────────────────────────────────

export type ComplianceFramework =
  | 'HIPAA'
  | 'SOC2'
  | 'PCI_DSS'
  | 'GDPR'
  | 'ISO27001'
  | 'NIST_CSF'
  | 'NIST_800_53'
  | 'FEDRAMP'
  | 'CCPA_CPRA'
  | 'SOX'
  | 'CUSTOM';
export type ComplianceStatus =
  | 'no_violations'
  | 'issues_detected'
  | 'review_required'
  | 'blocked'
  | 'not_enabled'
  // Legacy aliases still accepted when reading history
  | 'passed'
  | 'warning'
  | 'needs_work';

export type DataClassificationType =
  | 'PHI'
  | 'PII'
  | 'PCI'
  | 'Financial'
  | 'Credential'
  | 'Sensitive';

export interface EvidenceRecord {
  file: string;
  line?: number;
  hash: string;
  snippet: string;
  classification?: 'PHI' | 'PII' | 'PCI' | 'SECRET' | 'Financial' | 'Credential' | 'Sensitive';
  redacted: boolean;
}

/** Privacy-first evidence pointer — never carries raw sensitive content. */
export interface EvidenceReference {
  id: string;
  file: string;
  line?: number;
  hash: string;
  classification: string;
  redacted: boolean;
}

export interface DataClassification {
  type: DataClassificationType;
  source: string;
  destination: string;
  confidence: ReviewFindingConfidence;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface DataFlowTrace {
  source: string;
  transformations: string[];
  sink: string;
  dataType?: DataClassificationType;
  files: Array<{ path: string; line?: number }>;
  issues?: string[];
}

export interface ComplianceFinding {
  id: string;
  framework: ComplianceFramework;
  frameworkVersion?: string;
  controlId?: string;
  ruleId?: string;
  control: string;
  title: string;
  severity: ReviewFindingSeverity;
  confidence: ReviewFindingConfidence;
  evidence: string | EvidenceRecord;
  evidenceRecord?: EvidenceRecord;
  impact?: string;
  remediation: string;
  affectedFiles: string[];
  file?: string;
  line?: number;
  dataType?: DataClassificationType;
  dataFlow?: Array<{ file: string; line?: number; description: string }>;
  blocking: boolean;
  detectedBy: 'rule' | 'ast' | 'dataflow' | 'llm' | 'combined' | 'ast_rule';
}

export interface ComplianceControlChecked {
  id: string;
  label: string;
  framework: ComplianceFramework;
  status: 'no_issues' | 'issues_detected' | 'not_reviewed' | 'passed' | 'failed';
  passed?: boolean;
}

export interface ComplianceFrameworkAssessment {
  framework: ComplianceFramework;
  name: string;
  version?: string;
  status: ComplianceStatus;
  score: number;
  findingCount: number;
  controlsChecked: number;
  scopeNote?: string;
  confidence?: ReviewFindingConfidence;
  coverage?: Array<{
    id: string;
    label: string;
    percent: number | null;
    status: 'scored' | 'not_reviewed';
  }>;
}

export interface ComplianceRegressionAlert {
  framework: string;
  previousStatus: string;
  currentStatus: string;
  previousFindingCount: number;
  currentFindingCount: number;
  newFindings: Array<{ title: string; severity?: string }>;
  message: string;
}

/** Reserved for Max-tier custom policies later — optional and unused in v1. */
export interface CompliancePolicyHook {
  policyIds?: string[];
  evaluated?: boolean;
}

export const COMPLIANCE_DISCLAIMER =
  'Tyne provides developer-assistance compliance assessments based on reviewed code changes and available evidence. ' +
  'This is not a compliance certification, audit, legal opinion, or guarantee of security.';

export function normalizeComplianceStatus(value: unknown): Exclude<ComplianceStatus, 'passed' | 'warning' | 'needs_work'> | 'not_enabled' {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '_');
  if (raw === 'blocked' || raw === 'failed') return 'blocked';
  if (raw === 'review_required' || raw === 'needs_work' || raw === 'needs_review') return 'review_required';
  if (raw === 'issues_detected' || raw === 'warning') return 'issues_detected';
  if (raw === 'no_violations' || raw === 'passed' || raw === 'pass' || raw === 'clean') return 'no_violations';
  if (raw === 'not_enabled' || raw === 'disabled') return 'not_enabled';
  return 'not_enabled';
}

export function complianceStatusLabel(status: string): string {
  switch (normalizeComplianceStatus(status)) {
    case 'blocked':
      return 'Blocked';
    case 'review_required':
      return 'Review required';
    case 'issues_detected':
      return 'Issues detected';
    case 'no_violations':
      return 'No detected violations';
    default:
      return 'Not enabled';
  }
}

export type ReviewSectionScoreId =
  | 'scope_alignment'
  | 'correctness'
  | 'tests'
  | 'security'
  | 'maintainability'
  | 'vibe_code'
  | 'compliance';
export type ReviewSectionScoreStatus = 'good' | 'warn' | 'bad' | 'neutral';

// ── Scope resolution ──────────────────────────────────────────────────────────

export interface ChangedFileInfo {
  path: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
}

export interface LastEditedCodeContext {
  scope: ReviewScope;
  baseSha?: string;
  headSha?: string;
  currentBranch: string;
  changedFiles: ChangedFileInfo[];
  diff: string;
}

// ── Safe codebase context ────────────────────────────────────────────────────

export interface SafeCodebaseContext {
  repositoryName: string;
  currentBranch: string;
  projectHints: {
    language?: string;
    framework?: string;
    packageManager?: string;
    testFramework?: string;
  };
  nearbyFiles: Array<{
    path: string;
    reason: string;
    snippet?: string;
  }>;
  nearbyTests: Array<{
    path: string;
    reason: string;
  }>;
  importedSymbols: string[];
  changedFileContents?: Array<{
    path: string;
    content: string;
    totalLines: number;
    truncated: boolean;
  }>;
  impactedFiles?: Array<{
    path: string;
    importsChangedFile: string;
    importLine: string;
  }>;
  /** Blast-radius: interface/type/function signatures of dependencies of changed code. */
  dependencyInterfaces?: Array<{
    path: string;
    name: string;
    kind: string;
    signature: string;
    line: number;
  }>;
  /** Compact AST summary of changed functions (from local Plan stage). */
  astDiffSummary?: string;
  pmTaskRelevantFiles: string[];
}

// ── Guardrails ───────────────────────────────────────────────────────────────

export interface ReviewTierPolicy {
  tier: ReviewTier;
  monthlyLimit: number | null;
  maxDiffChars: number;
  maxRelevantFiles: number;
  models: string[];
  basicChecksEnabled: boolean;
  vibeCodeDetectorEnabled: boolean;
  pmAlignmentEnabled: boolean;
  missingTestReviewEnabled: boolean;
  customGuardrailsEnabled: boolean;
  fullReportEnabled: boolean;
  compactReportOnly: boolean;
}

export interface ReviewCustomGuardrails {
  requireTests?: boolean;
  allowedCommitTypes?: string[];
  customRules?: string[];
}

// ── PM task context (optional) ───────────────────────────────────────────────

export interface ReviewPmTaskContext {
  source: 'jira' | 'linear';
  issueIdentifier?: string;
  title: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  subtasks?: Array<{ title: string; status?: string }>;
  validationSteps?: string[];
  decisions?: string[];
  constraints?: string[];
  blockers?: string[];
  openQuestions?: string[];
  attachments?: Array<{ name: string; summary: string }>;
  comments?: Array<{ author: string; date: string; content: string; importance: 'high' | 'medium' | 'low' }>;
  linkedIssues?: Array<{ identifier: string; title: string; relationship: string; status?: string }>;
  developerTaskPlan?: {
    implementationTasks?: Array<{ title: string; status: string }>;
    testingTasks?: Array<{ title: string; testType: string }>;
  };
}

// ── Request payload ──────────────────────────────────────────────────────────

export interface QualityReviewPayload {
  qualityScore?: number;
  vibeCodeRisk?: 'low' | 'medium' | 'high';
  scorecard?: {
    correctness: number;
    maintainability: number;
    vibe: number;
    architecture: number;
    overall: number;
  };
  metrics?: Record<string, number>;
  findings?: Array<Record<string, unknown>>;
  sectionScores?: Array<{ id: string; label: string; score: number; status: string }>;
  egressSummary?: Record<string, unknown>;
  debtMinutes?: number;
}

export interface TyneValidateReviewRequest {
  editedCode: LastEditedCodeContext;
  codebaseContext: SafeCodebaseContext;
  staticAnalysis?: StaticAnalysisFinding[];
  /** Local deterministic code quality engine output. */
  qualityReview?: QualityReviewPayload;
  externalScanners?: Array<Record<string, unknown>>;
  pmTask?: ReviewPmTaskContext;
  guardrails?: ReviewCustomGuardrails;
  complianceChecksEnabled?: boolean;
  complianceFrameworks?: ComplianceFramework[];
  byokKey?: string;
  byokProvider?: string;
  /** Client privacy mode — set by payloadSanitizer before egress. */
  privacyMode?: 'cloud' | 'privacy_enhanced' | 'local_compliance';
  dataResidency?: 'us' | 'eu' | 'local_only' | 'enterprise_managed';
  evidencePersistenceDisabled?: boolean;
  privacyMeta?: Record<string, unknown>;
  localComplianceSummary?: Record<string, unknown>;
  thread?: {
    threadId?: string;
    issueSource?: 'jira' | 'linear' | 'manual';
    issueId?: string;
    issueIdentifier?: string;
    issueTitle?: string;
  };
  repository?: {
    repositoryId?: string;
    repositoryName?: string;
  };
}

// ── Response ─────────────────────────────────────────────────────────────────

/** How the Action Needed UI should treat this finding. */
export type FindingActionClass = 'applyable' | 'agent' | 'guidance';
export type FindingFixKind = 'patch' | 'agent_prompt' | 'guidance';

export interface TyneValidateReviewFinding {
  id: string;
  file: string;
  line?: number;
  endLine?: number;
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  title: string;
  explanation: string;
  /** Drop-in code patch only when actionClass is applyable. */
  suggestedFix?: string;
  confidence: ReviewFindingConfidence;
  architectureImpact?: string;
  detectedBy?: string;
  lineVerified?: boolean;
  actionClass?: FindingActionClass;
  fixKind?: FindingFixKind;
  /** Structured prompt for Cursor/VS Code agent handoff. */
  agentPrompt?: string;
  evidence?: string;
  remediation?: string;
}

export interface StaticAnalysisFinding {
  file: string;
  line: number;
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface TyneValidateReviewPendingGoal {
  title: string;
  reason: string;
  suggestedAction: string;
  priority?: 'high' | 'medium' | 'low';
  relatedFiles?: string[];
}

/** PM Ghost Cop scope-drift matrix + A2A verdicts (PEV harness). */
export interface TyneScopeDriftMatrix {
  ticket_requirements: string[];
  developer_additions: string[];
  unmapped_additions: string[];
  drift_detected: boolean;
  verdicts?: Array<{
    addition: string;
    required_dependency: boolean;
    reason: string;
  }>;
  overruled?: string[];
  lockedDrift?: string[];
}

export interface TyneValidateReviewMissingTest {
  title: string;
  relatedFile?: string;
  testType: ReviewTestType;
  reason?: string;
}

export interface TyneValidateReviewNextAction {
  title: string;
  fileHint?: string;
  reason?: string;
}

export interface TyneValidateReviewVisualDiffEntry {
  file: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  findings?: string[];
  findingIds?: string[];
}

export interface TyneValidateReviewSectionScore {
  id: ReviewSectionScoreId;
  title: string;
  score: number;
  status: ReviewSectionScoreStatus;
  summary: string;
  findingIds?: string[];
  actionIds?: string[];
}

export type TyneArchitectureFlowLayerId = 'extension' | 'backend' | 'database' | 'external';

export type TyneArchitectureFlowNodeKind =
  | 'entry'
  | 'file'
  | 'function'
  | 'review'
  | 'risk'
  | 'test'
  | 'external'
  | 'database'
  | 'service'
  | 'ui'
  | 'auth'
  | 'api';

export type TyneArchitectureFlowVerdict = 'right' | 'wrong' | 'mixed' | 'neutral';

export interface TyneValidateReviewArchitectureFlowLayer {
  id: TyneArchitectureFlowLayerId;
  title: string;
}

export interface TyneValidateReviewArchitectureFlowNode {
  id: string;
  label: string;
  kind?: TyneArchitectureFlowNodeKind;
  layer?: TyneArchitectureFlowLayerId;
  file?: string;
  additions?: number;
  deletions?: number;
  risk?: ReviewRiskLevel;
  highlighted?: boolean;
  changed?: boolean;
  verdict?: TyneArchitectureFlowVerdict;
  note?: string;
}

export interface TyneValidateReviewArchitectureFlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface TyneValidateReviewArchitectureFlow {
  title?: string;
  summary?: string;
  layers?: TyneValidateReviewArchitectureFlowLayer[];
  nodes: TyneValidateReviewArchitectureFlowNode[];
  edges: TyneValidateReviewArchitectureFlowEdge[];
  mermaid?: string;
  totalAdditions?: number;
  totalDeletions?: number;
  whatWentRight?: string[];
  whatWentWrong?: string[];
}

export interface TyneValidateReviewResult {
  id?: string;
  repositoryId?: string;
  repositoryName?: string;
  threadId?: string;
  issueSource?: 'jira' | 'linear' | 'manual';
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  branchName?: string;
  commitSha?: string;
  baseSha?: string;
  headSha?: string;
  scope: ReviewScope;
  status: ReviewStatus;
  score: number;
  riskLevel: ReviewRiskLevel;
  vibeCodeRisk: ReviewVibeCodeRisk;
  confidence?: 'high' | 'medium' | 'low';
  summary: string;
  completedGoals: Array<string | { title: string; evidence?: string; relatedFiles?: string[] }>;
  pendingGoals: TyneValidateReviewPendingGoal[];
  /** Scope-drift matrix from PM Ghost Cop + A2A debate (when PM alignment enabled). */
  driftMatrix?: TyneScopeDriftMatrix;
  scopeDriftExplanation?: ScopeDriftExplanation;
  /** Acceptance criteria coverage vs changed code. */
  acValidation?: ACValidation;
  findings: TyneValidateReviewFinding[];
  missingTests: TyneValidateReviewMissingTest[];
  nextActions: TyneValidateReviewNextAction[];
  visualDiff: TyneValidateReviewVisualDiffEntry[];
  sectionScores?: TyneValidateReviewSectionScore[];
  architectureFlow?: TyneValidateReviewArchitectureFlow;
  securityStatus?: SecurityStatus;
  securityFindings?: SecurityFinding[];
  securityDataFlows?: SecurityDataFlow[];
  complianceStatus?: ComplianceStatus;
  complianceFindings?: ComplianceFinding[];
  dataClassifications?: DataClassification[];
  dataFlows?: DataFlowTrace[];
  controlsChecked?: ComplianceControlChecked[];
  complianceAssessments?: ComplianceFrameworkAssessment[];
  complianceRegressions?: ComplianceRegressionAlert[];
  complianceScope?: { reviewed: string[]; notReviewed: string[] };
  /** Reserved Max-tier hook; deferred evaluation. */
  compliancePolicyHook?: CompliancePolicyHook;
  complianceDisclaimer?: string;
  privacyInfo?: {
    reviewMode?: string;
    codeProcessing?: string;
    evidenceStorage?: string;
    dataSent?: string;
    dataResidency?: string;
    evidenceRedacted?: boolean;
    llmExecutionPath?: string;
  };
  languageBreakdown?: Array<{ language: string; percent: number; lines: number }>;
  contributionBreakdown?: Array<{ id: string; label: string; kind: 'human' | 'ai'; percent: number; lines: number }>;
  /** Deterministic code quality scorecard (local engine). */
  qualityScore?: number;
  qualityScorecard?: {
    correctness: number;
    maintainability: number;
    vibe: number;
    architecture: number;
    overall: number;
  };
  qualityMetrics?: Record<string, number>;
  debtMinutes?: number;
  /** Structured AI slop scan (local vibe scanner). */
  aiSlop?: AiSlopSignals;
  fullReport?: string;
  modelInfo?: {
    primaryModel?: string;
    secondaryModel?: string;
    judgeModel?: string;
    tier?: ReviewTier;
  };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  createdAt?: string;
}

export interface TyneValidateReviewResponse {
  result: TyneValidateReviewResult;
  provider: string;
  model: string;
  usage: { used: number; limit: number | null; remaining: number | null };
}

export interface TyneValidateReviewHistoryResponse {
  reports: TyneValidateReviewResult[];
}

export interface TyneValidateReviewError {
  error: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isValidateReviewResult(value: unknown): value is TyneValidateReviewResult {
  if (!value || typeof value !== 'object') { return false; }
  const r = value as Record<string, unknown>;
  return (
    (r.status === 'passed' || r.status === 'needs_work' || r.status === 'blocked' || r.status === 'context_limited') &&
    typeof r.score === 'number' &&
    (r.riskLevel === 'low' || r.riskLevel === 'medium' || r.riskLevel === 'high') &&
    (r.vibeCodeRisk === 'low' || r.vibeCodeRisk === 'medium' || r.vibeCodeRisk === 'high') &&
    typeof r.summary === 'string' &&
    Array.isArray(r.findings) &&
    Array.isArray(r.completedGoals) &&
    Array.isArray(r.pendingGoals) &&
    Array.isArray(r.missingTests) &&
    Array.isArray(r.nextActions) &&
    Array.isArray(r.visualDiff) &&
    (r.sectionScores === undefined || Array.isArray(r.sectionScores)) &&
    (r.architectureFlow === undefined || (typeof r.architectureFlow === 'object' && r.architectureFlow !== null))
  );
}

export function compactReviewLimits(result: TyneValidateReviewResult): TyneValidateReviewResult {
  const sentences = result.summary.split(/\.\s+/).filter(Boolean);
  const shortSummary = (sentences[0] || result.summary).trim();
  return {
    ...result,
    summary: /[.!?]$/.test(shortSummary) ? shortSummary : shortSummary + '.',
    findings: result.findings.slice(0, 8),
    pendingGoals: result.pendingGoals.slice(0, 4),
    completedGoals: result.completedGoals.slice(0, 4),
    missingTests: result.missingTests.slice(0, 4),
    nextActions: result.nextActions.slice(0, 5),
    sectionScores: result.sectionScores?.slice(0, 7),
    securityFindings: result.securityFindings?.slice(0, 4),
    securityDataFlows: result.securityDataFlows?.slice(0, 3),
    complianceFindings: result.complianceFindings?.slice(0, 4),
    dataClassifications: result.dataClassifications?.slice(0, 6),
    dataFlows: result.dataFlows?.slice(0, 4),
    controlsChecked: result.controlsChecked?.slice(0, 6),
    complianceAssessments: result.complianceAssessments?.slice(0, 10),
    languageBreakdown: result.languageBreakdown?.slice(0, 8),
    contributionBreakdown: result.contributionBreakdown?.slice(0, 6),
  };
}

// ── Finding Feedback (Feature 12: False Positive Feedback) ──────────────────

export type FindingVerdict = 'accepted' | 'dismissed' | 'not_relevant' | 'wrong';

export interface FindingFeedbackRequest {
  reportId: string;
  findingId: string;
  verdict: FindingVerdict;
  findingTitle: string;
  findingFile?: string;
  findingCategory?: string;
  findingSeverity?: string;
  comment?: string;
  repositoryId?: string;
}

export interface FindingFeedbackResponse {
  success: boolean;
}

// ── Quality Gate (Feature 14: Quality Gate Rules) ───────────────────────────

export type QualityGateType = 'pre_commit' | 'pre_push';

export interface QualityGateRuleResult {
  rule: string;
  passed: boolean;
  reason: string;
  severity: 'block' | 'warn';
}

export interface QualityGateResult {
  passed: boolean;
  gateType: QualityGateType;
  branchName: string;
  blocks: QualityGateRuleResult[];
  warnings: QualityGateRuleResult[];
  overridden: boolean;
}

export function isQualityGateResult(value: unknown): value is QualityGateResult {
  if (!value || typeof value !== 'object') { return false; }
  const r = value as Record<string, unknown>;
  return (
    typeof r.passed === 'boolean' &&
    typeof r.gateType === 'string' &&
    Array.isArray(r.blocks) &&
    Array.isArray(r.warnings)
  );
}

// ── Review-to-Task Conversion (Feature 13) ───────────────────────────────────

export interface CreateTaskFromFindingRequest {
  findingId: string;
  findingTitle: string;
  findingFile?: string;
  findingLine?: number;
  findingExplanation: string;
  suggestedFix?: string;
  severity: string;
  category: string;
  sourceTool: 'jira' | 'linear';
}
