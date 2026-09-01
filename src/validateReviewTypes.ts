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

/**
 * Display severity scale (CodeRabbit-style). Wire format stays on the legacy
 * critical/high/medium/low scale for history compatibility; UI and diagnostics
 * render through this scale via toDisplaySeverity().
 */
export type ReviewFindingDisplaySeverity = 'critical' | 'major' | 'minor' | 'nit' | 'info';

const DISPLAY_SEVERITY_RANK: Record<ReviewFindingDisplaySeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
  info: 0,
};

/** Accepts both the legacy scale and the display scale; anything unknown → minor. */
export function toDisplaySeverity(severity: unknown, category?: string): ReviewFindingDisplaySeverity {
  const raw = String(severity || '').toLowerCase();
  if (raw === 'critical') { return 'critical'; }
  if (raw === 'major' || raw === 'high' || raw === 'error') { return 'major'; }
  if (raw === 'minor' || raw === 'medium' || raw === 'warning') { return 'minor'; }
  if (raw === 'nit' || raw === 'hint') { return 'nit'; }
  if (raw === 'low') { return category === 'style' ? 'nit' : 'minor'; }
  if (raw === 'info') { return 'info'; }
  return 'minor';
}

export function displaySeverityRank(severity: unknown, category?: string): number {
  return DISPLAY_SEVERITY_RANK[toDisplaySeverity(severity, category)];
}

/** Categories that may scare-level as critical but must never hard-block a review. */
const NEVER_BLOCK_CATEGORIES = new Set([
  'pm_alignment',
  'style',
  'vibe_code',
  'maintainability',
  'performance',
]);

/**
 * Only verified security / compliance (and explicitly blocking test breakages)
 * may drive overallVerdict: block. LLM over-severity on alignment/style cannot.
 */
export function findingCanHardBlock(finding: {
  severity?: unknown;
  category?: string;
  blocking?: boolean;
  confidence?: string;
}): boolean {
  const cat = String(finding.category || '').toLowerCase();
  if (NEVER_BLOCK_CATEGORIES.has(cat)) { return false; }
  const sev = String(finding.severity || '').toLowerCase();
  const confidence = String(finding.confidence || 'medium').toLowerCase();
  if (confidence === 'low') { return false; }

  if (cat === 'security') {
    if (finding.blocking === true) { return sev === 'critical' || sev === 'high' || sev === 'major'; }
    if (sev === 'critical') { return true; }
    if ((sev === 'high' || sev === 'major') && confidence === 'high') { return true; }
    return false;
  }

  if (cat === 'compliance') {
    if (sev === 'critical') { return true; }
    if ((sev === 'high' || sev === 'major') && confidence === 'high') { return true; }
    if (finding.blocking === true && (sev === 'critical' || sev === 'high' || sev === 'major')) { return true; }
    return false;
  }

  // Explicit test-breakage hard flags only — never plain coverage nits.
  if (cat === 'test_coverage' && finding.blocking === true && sev === 'critical') { return true; }
  return false;
}

/** Map a display severity back onto the legacy wire scale used by history storage. */
export function fromDisplaySeverity(severity: ReviewFindingDisplaySeverity): ReviewFindingSeverity {
  switch (severity) {
    case 'critical': return 'critical';
    case 'major': return 'high';
    case 'minor': return 'medium';
    default: return 'low';
  }
}

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
  'IMPORTANT LEGAL NOTICE: Tyne Validate & Review and any compliance-related output are automated, advisory suggestions only. ' +
  'They do not constitute a compliance certificate, attestation, audit opinion, legal advice, regulatory filing, warranty, or guarantee of any kind. ' +
  'Tyne does not certify that software, systems, processes, or organizations meet HIPAA, SOC 2, GDPR, PCI-DSS, ISO, NIST, FedRAMP, or any other legal, regulatory, industry, or contractual standard. ' +
  'Findings and scores are heuristic and may be incomplete, inaccurate, or out of date. Recipients remain solely responsible for independent professional review, formal certification by qualified auditors or counsel, and all compliance decisions. ' +
  'Use of this report does not create an attorney-client, auditor-client, or similar professional relationship with Tyne or its affiliates.';

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
  /** Compact 1-hop graph slice packed for the review LLM (callers/callees/similar). */
  codegraphNeighborhood?: {
    importers: Array<{
      file: string;
      line: number;
      importedSymbols: string[];
      fromModule: string;
      targetFile: string;
    }>;
    importees: Array<{ path: string; name: string; line: number }>;
    similar: Array<{ path: string; name: string; startLine: number }>;
    text: string;
  };
  pmTaskRelevantFiles: string[];
  /** Prior commits that touched the same lines the current diff touches. */
  priorContext?: Array<{
    file: string;
    hash: string;
    date: string;
    author: string;
    subject: string;
  }>;
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
  /** Review depth — edge uses this to cap LLM packs / skip PEV. */
  mode?: 'full' | 'quick' | 'triage';
  guardrails?: ReviewCustomGuardrails;
  /**
   * Team learnings from `.tyne/learnings.md`, sent so the model can avoid
   * *generating* an already-accepted finding rather than us filtering it
   * afterwards. Titles only — the note and scope stay local.
   */
  teamLearnings?: Array<{ title: string; file?: string }>;
  /**
   * House rules from the `## Require` section of `.tyne/learnings.md` —
   * conventions the model must check and report violations of. Findings they
   * produce are model judgment, never deterministic evidence.
   */
  teamRules?: Array<{ id: string; text: string; scope?: string }>;
  /**
   * Previous review's suppression match counts. Suppression matching runs
   * client-side, so the backend cannot observe it directly — the client
   * carries the counts forward one review so staleness can be measured.
   */
  suppressionUsage?: Array<{ hash: string; text: string; scope?: string; count: number }>;
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

/** Exact code anchor for a finding (1-indexed lines, 0-indexed columns). */
export interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

/** Committable fix: a real unified diff, not prose instructions. */
export interface StructuredSuggestedFix {
  /** One short sentence, e.g. "Use parameterized query". */
  description: string;
  /** Unified diff format (- old / + new), ready to apply. */
  diff: string;
  /** Can this be one-click applied automatically? */
  applyable: boolean;
  /** How safe auto-apply is: high = mechanical, low = suggestion only. */
  applyConfidence: 'high' | 'medium' | 'low';
}

export type ReviewFindingSource =
  | 'local_engine'
  | 'llm'
  | 'pev_sentinel'
  | 'pev_staff_engineer'
  | 'pev_pm_ghost_cop';

/** Provenance for a finding produced by a team house rule. */
export interface HouseRuleOrigin {
  /** `HR1` — matches the id sent in the prompt. */
  id: string;
  text: string;
  scope?: string;
  /** `.tyne/learnings.md:14` */
  source: string;
}

export interface TyneValidateReviewFinding {
  /** Set when this finding came from a team house rule rather than a detector. */
  houseRule?: HouseRuleOrigin;
  id: string;
  file: string;
  line?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  title: string;
  explanation: string;
  /** Drop-in code patch only when actionClass is applyable. */
  suggestedFix?: string;
  /** Structured before/after diff fix — preferred over plain suggestedFix. */
  fix?: StructuredSuggestedFix;
  /** The exact offending code, copied verbatim from the diff. */
  codeSnippet?: string;
  /** Other places the same underlying issue appears (grouped, not repeated). */
  relatedLocations?: CodeLocation[];
  confidence: ReviewFindingConfidence;
  architectureImpact?: string;
  detectedBy?: string;
  /** Which engine produced this finding (for merge preference + display). */
  source?: ReviewFindingSource;
  ruleId?: string;
  cwe?: string;
  learnMoreUrl?: string;
  lineVerified?: boolean;
  actionClass?: FindingActionClass;
  fixKind?: FindingFixKind;
  /** Structured prompt for Cursor/VS Code agent handoff. */
  agentPrompt?: string;
  evidence?: string;
  remediation?: string;
}

/** PR-level verdict shown before individual findings. */
export type ReviewOverallVerdict = 'approve' | 'approve_with_suggestions' | 'changes_requested' | 'block';

export function verdictFromFindings(findings: Array<{
  severity?: unknown;
  category?: string;
  blocking?: boolean;
  confidence?: string;
}>): ReviewOverallVerdict {
  const list = findings || [];
  if (list.some(findingCanHardBlock)) { return 'block'; }

  let worst = -1;
  for (const f of list) {
    let rank = displaySeverityRank(f.severity, f.category);
    // Cap never-block categories so "critical" alignment cannot outrank majors.
    if (NEVER_BLOCK_CATEGORIES.has(String(f.category || '').toLowerCase()) && rank >= 4) {
      rank = 3;
    }
    worst = Math.max(worst, rank);
  }
  if (worst >= 3) { return 'changes_requested'; }
  if (worst >= 1) { return 'approve_with_suggestions'; }
  return 'approve';
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
  | 'api'
  // Effect + control-flow kinds. `llm`/`external`/`database` effect nodes are
  // backed by a real call site (see evidenceFile/evidenceLine); the rest are
  // reserved for the decision-flow work.
  | 'llm'
  | 'decision'
  | 'terminal'
  | 'io'
  | 'module';

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
  /**
   * Board section for the Architecture UI (Outside callers / App / API /
   * Database / External / Tests). Set by local graph builder so the webview
   * does not re-guess.
   */
  section?: TyneArchitectureSectionId;
  file?: string;
  additions?: number;
  deletions?: number;
  risk?: ReviewRiskLevel;
  highlighted?: boolean;
  /**
   * `true` = file/decision in this diff.
   * `false` + evidence = ghost outside-diff importer (blast radius), or an effect/
   * overflow node. Ghosts are never invented — they require a proven import site.
   */
  changed?: boolean;
  verdict?: TyneArchitectureFlowVerdict;
  note?: string;
  /** Enclosing symbol for a function node. */
  symbol?: string;
  /** Finding ids that land on this node — drives the fault marker + click-through. */
  findingIds?: string[];
  /** For an effect node (db/llm/external): the call site it was proven by. */
  evidenceFile?: string;
  evidenceLine?: number;
}

/** Architecture board bands — same ids as reading-order cohorts where they overlap. */
export type TyneArchitectureSectionId =
  | 'callers'
  | 'extension'
  | 'backend'
  | 'database'
  | 'effects'
  | 'tests';

/** Dependency-ordered walkthrough cohorts for the Architecture section. */
export interface TyneArchitectureReadingOrderCohort {
  id: string;
  title: string;
  nodeIds: string[];
  summary: string;
}

/** Proven call/import chain rendered as a compact sequence (no decorative diagrams). */
export interface TyneArchitectureSequenceMessage {
  fromLabel: string;
  toLabel: string;
  label?: string;
}

export interface TyneArchitectureSequence {
  messages: TyneArchitectureSequenceMessage[];
}

export interface TyneValidateReviewArchitectureFlowEdge {
  from: string;
  to: string;
  label?: string;
  /** contains = grouping, imports = static dep, calls/data = an effect edge. */
  kind?: 'contains' | 'imports' | 'calls' | 'data' | 'branch';
  /** A dependency this diff introduced (rendered dashed/accent). */
  changed?: boolean;
}

export interface TyneValidateReviewArchitectureFlow {
  title?: string;
  summary?: string;
  layers?: TyneValidateReviewArchitectureFlowLayer[];
  nodes: TyneValidateReviewArchitectureFlowNode[];
  edges: TyneValidateReviewArchitectureFlowEdge[];
  /** Local reading-order cohorts (schema → backend → ui → effects → tests → callers). */
  readingOrder?: TyneArchitectureReadingOrderCohort[];
  /** Proven multi-hop chain for HTML sequence UI (only when length >= 2 messages). */
  sequence?: TyneArchitectureSequence;
  mermaid?: string;
  totalAdditions?: number;
  totalDeletions?: number;
  whatWentRight?: string[];
  whatWentWrong?: string[];
  /** Which pass produced the graph: locally from the AST, the LLM, or a fallback. */
  generatedBy?: 'local_ast' | 'llm' | 'fallback';
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
  /** 2-4 sentence plain-English description of what the change actually does. */
  walkthrough?: string;
  /** 1-3 "if you read nothing else" highlights. */
  topConcerns?: string[];
  /** PR-level verdict derived from findings (block > changes_requested > …). */
  overallVerdict?: ReviewOverallVerdict;
  completedGoals: Array<string | { title: string; evidence?: string; relatedFiles?: string[] }>;
  pendingGoals: TyneValidateReviewPendingGoal[];
  /** Scope-drift matrix from PM Ghost Cop + A2A debate (when PM alignment enabled). */
  driftMatrix?: TyneScopeDriftMatrix;
  scopeDriftExplanation?: ScopeDriftExplanation;
  /** Acceptance criteria coverage vs changed code. */
  acValidation?: ACValidation;
  /** Review depth mode actually used (may be auto-downgraded for large PRs). */
  actualModeUsed?: 'full' | 'quick' | 'triage';
  requestedMode?: 'full' | 'quick' | 'triage';
  prSizeClass?: 'small' | 'medium' | 'large' | 'huge';
  reviewWarnings?: Array<{ type: string; count?: number; files?: string[]; reason?: string; message?: string }>;
  stageTimings?: Array<{ stage: string; durationMs: number; inputSize: number }>;
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
  /** Harness quality counters from finding grounding (hallucination telemetry). */
  groundingStats?: {
    rawFindingCount: number;
    droppedUngroundedCount: number;
    syntheticPathCount: number;
    hallucinationRate: number;
  };
  /**
   * Findings hidden by a team learning or a prior dismissal, with the reason.
   * Surfaced in the UI on request — a suppression the reviewer cannot inspect
   * is indistinguishable from a bug.
   */
  /** Learnings evaluated repeatedly that have never once acted — housekeeping. */
  staleLearnings?: Array<{
    kind: 'rule' | 'suppression';
    origin?: 'team' | 'personal';
    hash: string;
    text: string;
    scope?: string;
    evaluations: number;
    lastSeen: string;
    reason: string;
  }>;
  suppressedFindings?: Array<{
    title: string;
    file?: string;
    line?: number;
    severity?: string;
    category?: string;
    source: 'learning' | 'dismissed';
    learningTitle?: string;
    learningNote?: string;
    /** `.tyne/learnings.md:12` */
    learningSource?: string;
    /** The learning's path glob, needed to remove exactly the right entry. */
    learningScope?: string;
    /** 'team' (repo file) or 'personal' (~/.tyne/learnings.md). */
    learningOrigin?: string;
    /** exact | scoped | rule | fuzzy */
    matchKind?: string;
    score?: number;
    /** Who added the learning, from git blame. */
    author?: string;
    /** ISO date the learning was added. */
    addedOn?: string;
  }>;
  modelInfo?: {
    primaryModel?: string;
    secondaryModel?: string;
    judgeModel?: string;
    tier?: ReviewTier;
    groundingStats?: {
      rawFindingCount: number;
      droppedUngroundedCount: number;
      syntheticPathCount: number;
      hallucinationRate: number;
    };
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
  /** False when the review completed but history insert failed. */
  persisted?: boolean;
}

export interface TyneValidateReviewHistoryResponse {
  reports: TyneValidateReviewResult[];
}

export interface TyneValidateReviewError {
  error: string;
  /** Present when save failed after a successful review — host must not discard. */
  result?: TyneValidateReviewResult;
  persisted?: false;
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
  // Keep all findings / security / compliance — silent post-verdict truncation
  // made UI/PDF disagree with overallVerdict. Soft-cap only ancillary lists.
  return {
    ...result,
    summary: /[.!?]$/.test(shortSummary) ? shortSummary : shortSummary + '.',
    findings: result.findings || [],
    pendingGoals: result.pendingGoals.slice(0, 4),
    completedGoals: result.completedGoals.slice(0, 4),
    missingTests: result.missingTests.slice(0, 4),
    nextActions: result.nextActions.slice(0, 5),
    sectionScores: result.sectionScores?.slice(0, 7),
    securityFindings: result.securityFindings || [],
    securityDataFlows: result.securityDataFlows?.slice(0, 3),
    complianceFindings: result.complianceFindings || [],
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
