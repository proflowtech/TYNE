import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
  TyneCodebaseContextPack,
  TyneDeveloperTaskPlan,
  TyneEnrichmentStatus,
  TynePmTaskIntelligence,
  TynePmContext,
  TynePmTaskValidationResult,
  TyneValidationConfidence,
  TyneValidationContextSource,
  TyneContextualValidationStatus,
} from './taskTypes';
import { getEffectiveAuthToken } from './deviceAuth';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const PM_INTELLIGENCE_PATH = '/functions/v1/pm-task-intelligence';
const PM_VALIDATION_PATH = '/functions/v1/pm-task-validation';

const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secret/i,
  /token/i,
  /password/i,
  /private/i,
  /supabase_service_role/i,
  /anthropic_key/i,
  /openai_key/i,
];

const IGNORED_FILE_PATTERNS = [
  /node_modules\//i,
  /\.git\//i,
  /\.vscode\//i,
  /dist\//i,
  /out\//i,
  /build\//i,
  /\.DS_Store$/i,
  /\.log$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
];

export interface ExtractPmTaskIntelligenceInput {
  context: vscode.ExtensionContext;
  source: 'jira' | 'linear';
  issueId: string;
  issueIdentifier: string;
  cloudId?: string;
  linearWorkspaceId?: string;
  repositoryId?: string;
  tier: string;
  useGemini?: boolean;
  codebaseContext?: TyneCodebaseContextPack;
}

export interface ValidatePmTaskInput {
  context: vscode.ExtensionContext;
  source: 'jira' | 'linear';
  issueId: string;
  issueIdentifier: string;
  cloudId?: string;
  linearWorkspaceId?: string;
  repositoryId?: string;
  tier: string;
  currentBranch: string;
  diffText: string;
  changedFiles: string[];
  goal?: string;
  subtasks?: Array<{ title: string; description: string }>;
  acceptanceCriteria?: string[];
  proofPointTemplates?: string[];
  validationSteps?: string[];
  pmContext?: TynePmContext;
  codebaseContext?: TyneCodebaseContextPack;
  developerTaskPlan?: TyneDeveloperTaskPlan;
  enrichmentStatus?: string;
  enrichmentError?: string;
  contextSource?: string;
  confidence?: string;
}

export class PmTaskIntelligenceService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async extractIntelligence(input: ExtractPmTaskIntelligenceInput): Promise<TynePmTaskIntelligence> {
    const authToken = await getEffectiveAuthToken(this.context);
    if (!authToken) {
      throw new Error('Sign in before extracting PM task intelligence.');
    }
    const repo = getRepositoryIdentity();
    const supabaseUrl = getSupabaseUrl();
    const response = await fetch(`${supabaseUrl}${PM_INTELLIGENCE_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source: input.source,
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        cloudId: input.cloudId,
        linearWorkspaceId: input.linearWorkspaceId,
        repositoryId: input.repositoryId || repo.repositoryId,
        tier: input.tier,
        useGemini: input.useGemini,
        codebaseContext: input.codebaseContext,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      throw new Error(buildBackendErrorMessage(payload, response.status, 'PM intelligence'));
    }
    return parsePmTaskIntelligence(payload);
  }

  async validateTask(input: ValidatePmTaskInput): Promise<TynePmTaskValidationResult> {
    const authToken = await getEffectiveAuthToken(this.context);
    if (!authToken) {
      throw new Error('Sign in before validating PM task work.');
    }
    const sanitized = sanitizeDiff(input.diffText, input.changedFiles);
    const supabaseUrl = getSupabaseUrl();
    const response = await fetch(`${supabaseUrl}${PM_VALIDATION_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source: input.source,
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        cloudId: input.cloudId,
        linearWorkspaceId: input.linearWorkspaceId,
        repositoryId: input.repositoryId,
        tier: input.tier,
        currentBranch: input.currentBranch,
        diff: sanitized.diffText,
        changedFiles: sanitized.changedFiles,
        goal: input.goal,
        subtasks: input.subtasks,
        acceptanceCriteria: input.acceptanceCriteria,
        proofPointTemplates: input.proofPointTemplates,
        validationSteps: input.validationSteps,
        pmContext: input.pmContext,
        codebaseContext: input.codebaseContext,
        developerTaskPlan: input.developerTaskPlan,
        enrichmentStatus: input.enrichmentStatus,
        enrichmentError: input.enrichmentError,
        contextSource: input.contextSource,
        confidence: input.confidence,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      throw new Error(buildBackendErrorMessage(payload, response.status, 'PM validation'));
    }
    return parsePmTaskValidationResult(payload);
  }
}

export function getPmTaskIntelligenceService(context: vscode.ExtensionContext): PmTaskIntelligenceService {
  return new PmTaskIntelligenceService(context);
}

/**
 * The backend returns a generic `error` plus a `detail` carrying the real
 * cause. Dropping `detail` made failures like "Failed to extract PM
 * intelligence" undiagnosable, so surface both, plus the status code.
 */
export function buildBackendErrorMessage(
  payload: Record<string, unknown> | null,
  status: number,
  label: string,
): string {
  const error = typeof payload?.error === 'string' ? payload.error.trim() : '';
  const detail = typeof payload?.detail === 'string' ? payload.detail.trim() : '';
  const base = error || `${label} failed`;
  const withDetail = detail && detail !== error ? `${base}: ${detail}` : base;
  return `${withDetail} (HTTP ${status})`;
}

function getSupabaseUrl(): string {
  return vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
}

function getRepositoryIdentity(): { repositoryId: string; repositoryName?: string; workspacePathHash?: string } {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = folder?.uri.fsPath || 'unknown-workspace';
  const repositoryName = folder?.name;
  const repositoryId = createHash('sha256').update(workspacePath).digest('hex');
  const workspacePathHash = repositoryId;
  return { repositoryId, repositoryName, workspacePathHash };
}

function sanitizeDiff(diffText: string, changedFiles: string[]): { diffText: string; changedFiles: string[] } {
  const safeFiles = changedFiles.filter(p => !isSensitivePath(p) && !isIgnoredPath(p));
  const lines = diffText.split('\n');
  let currentFile: string | null = null;
  let keepFile = true;
  const output: string[] = [];
  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      keepFile = !isSensitivePath(currentFile) && !isIgnoredPath(currentFile);
      if (keepFile) {
        output.push(line);
      }
      continue;
    }
    if (keepFile) {
      output.push(line);
    }
  }
  return { diffText: output.join('\n'), changedFiles: safeFiles };
}

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(p => p.test(path));
}

function isIgnoredPath(path: string): boolean {
  return IGNORED_FILE_PATTERNS.some(p => p.test(path));
}

function parsePmTaskIntelligence(payload: Record<string, unknown>): TynePmTaskIntelligence {
  const subtasks = Array.isArray(payload.subtasks)
    ? payload.subtasks
      .map((s: unknown) => {
        if (!s || typeof s !== 'object') return null;
        const r = s as Record<string, unknown>;
        const title = typeof r.title === 'string' ? r.title.trim() : '';
        const description = typeof r.description === 'string' ? r.description.trim() : '';
        return title ? { title, description } : null;
      })
      .filter((s): s is { title: string; description: string } => Boolean(s))
    : [];
  return {
    source: payload.source === 'linear' ? 'linear' : 'jira',
    issueId: typeof payload.issueId === 'string' ? payload.issueId : undefined,
    issueIdentifier: typeof payload.issueIdentifier === 'string'
      ? payload.issueIdentifier
      : typeof payload.issueKey === 'string'
        ? payload.issueKey
        : '',
    issueKey: typeof payload.issueKey === 'string' ? payload.issueKey : undefined,
    goal: typeof payload.goal === 'string' ? payload.goal : '',
    subtasks,
    acceptanceCriteria: toStringArray(payload.acceptanceCriteria),
    proofPointTemplates: toStringArray(payload.proofPointTemplates),
    validationSteps: toStringArray(payload.validationSteps),
    suggestedBranchName: typeof payload.suggestedBranchName === 'string' ? payload.suggestedBranchName : '',
    repositoryId: typeof payload.repositoryId === 'string' ? payload.repositoryId : undefined,
    storedAt: typeof payload.storedAt === 'string' ? payload.storedAt : undefined,
    modelProvider: typeof payload.modelProvider === 'string' ? payload.modelProvider : undefined,
    modelName: typeof payload.modelName === 'string' ? payload.modelName : undefined,
    pmContext: parsePmContext(payload.pmContext),
    developerTaskPlan: parseDeveloperTaskPlan(payload.developerTaskPlan),
    codebaseContext: parseCodebaseContext(payload.codebaseContext),
  };
}

function parsePmTaskValidationResult(payload: Record<string, unknown>): TynePmTaskValidationResult {
  const status = typeof payload.status === 'string' && ['pass', 'partial', 'fail'].includes(payload.status.toLowerCase())
    ? (payload.status.toLowerCase() as 'pass' | 'partial' | 'fail')
    : 'partial';
  const matchPercent = typeof payload.matchPercent === 'number' ? payload.matchPercent : undefined;
  return {
    source: payload.source === 'linear' ? 'linear' : payload.source === 'jira' ? 'jira' : undefined,
    issueId: typeof payload.issueId === 'string' ? payload.issueId : undefined,
    issueIdentifier: typeof payload.issueIdentifier === 'string'
      ? payload.issueIdentifier
      : typeof payload.jiraIssueKey === 'string'
        ? payload.jiraIssueKey
        : undefined,
    status,
    matchPercent,
    summary: typeof payload.summary === 'string' ? payload.summary : 'Validation completed.',
    passedCriteria: toStringArray(payload.passedCriteria),
    failedCriteria: toFailedCriteriaArray(payload.failedCriteria),
    missingWork: toStringArray(payload.missingWork),
    generatedProofPoints: toStringArray(payload.generatedProofPoints),
    recommendedNextActions: toStringArray(payload.recommendedNextActions),
    modelProvider: typeof payload.modelProvider === 'string' ? payload.modelProvider : '',
    modelName: typeof payload.modelName === 'string' ? payload.modelName : '',
    completedGoals: parseCompletedGoals(payload.completedGoals),
    pendingGoals: parsePendingGoals(payload.pendingGoals),
    developerActions: parseDeveloperActions(payload.developerActions),
    codeEvidence: parseCodeEvidence(payload.codeEvidence),
    fullReport: typeof payload.fullReport === 'string' ? payload.fullReport : undefined,
    enrichmentStatus: parseEnrichmentStatus(payload.enrichmentStatus),
    enrichmentError: typeof payload.enrichmentError === 'string' ? payload.enrichmentError : undefined,
    contextSource: parseContextSource(payload.contextSource),
    confidence: parseValidationConfidence(payload.confidence),
    validationStatus: parseContextualValidationStatus(payload.validationStatus),
    warnings: toStringArray(payload.warnings),
    resolvedContext: parseResolvedValidationContext(payload.resolvedContext),
    developerTaskPlan: parseDeveloperTaskPlan(payload.developerTaskPlan),
    codebaseContext: parseCodebaseContext(payload.codebaseContext),
    jiraIssueKey: typeof payload.jiraIssueKey === 'string' ? payload.jiraIssueKey : undefined,
    repositoryId: typeof payload.repositoryId === 'string' ? payload.repositoryId : null,
    branchName: typeof payload.branchName === 'string' ? payload.branchName : undefined,
    changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.map(String) : undefined,
  };
}

function parsePmContext(value: unknown): TynePmContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const comments = Array.isArray(r.comments) ? r.comments.map(item => {
    if (!item || typeof item !== 'object') return null;
    const x = item as Record<string, unknown>;
    const content = typeof x.content === 'string' ? x.content.trim() : '';
    const importance: 'high' | 'medium' | 'low' = x.importance === 'high' || x.importance === 'low' ? x.importance : 'medium';
    return content ? {
      author: typeof x.author === 'string' ? x.author : 'Unknown',
      date: typeof x.date === 'string' ? x.date : '',
      content,
      importance,
    } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
  const attachments = Array.isArray(r.attachments) ? r.attachments.map(item => {
    if (!item || typeof item !== 'object') return null;
    const x = item as Record<string, unknown>;
    const name = typeof x.name === 'string' ? x.name.trim() : '';
    return name ? {
      name,
      summary: typeof x.summary === 'string' ? x.summary : '',
      mediaType: typeof x.mediaType === 'string' ? x.mediaType : undefined,
      url: typeof x.url === 'string' ? x.url : undefined,
    } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
  const linkedIssues = Array.isArray(r.linkedIssues) ? r.linkedIssues.map(item => {
    if (!item || typeof item !== 'object') return null;
    const x = item as Record<string, unknown>;
    const identifier = typeof x.identifier === 'string' ? x.identifier.trim() : '';
    return identifier ? {
      identifier,
      title: typeof x.title === 'string' ? x.title : '',
      relationship: typeof x.relationship === 'string' ? x.relationship : 'related',
      status: typeof x.status === 'string' ? x.status : undefined,
    } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
  return {
    summary: typeof r.summary === 'string' ? r.summary : '',
    requirements: toStringArray(r.requirements),
    acceptanceCriteria: toStringArray(r.acceptanceCriteria),
    decisions: toStringArray(r.decisions),
    constraints: toStringArray(r.constraints),
    blockers: toStringArray(r.blockers),
    openQuestions: toStringArray(r.openQuestions),
    attachments,
    comments,
    linkedIssues,
  };
}

function parseEnrichmentStatus(value: unknown): TyneEnrichmentStatus | undefined {
  return value === 'success' || value === 'partial' || value === 'failed' || value === 'skipped' ? value : undefined;
}

function parseContextSource(value: unknown): TyneValidationContextSource | undefined {
  return value === 'enriched_pm' || value === 'stored_pm' || value === 'raw_pm' || value === 'branch_only' || value === 'diff_only'
    ? value
    : undefined;
}

function parseValidationConfidence(value: unknown): TyneValidationConfidence | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

function parseContextualValidationStatus(value: unknown): TyneContextualValidationStatus | undefined {
  return value === 'passed' || value === 'needs_work' || value === 'blocked' || value === 'context_limited' ? value : undefined;
}

function parseResolvedValidationContext(value: unknown): TynePmTaskValidationResult['resolvedContext'] {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const enrichmentStatus = parseEnrichmentStatus(r.enrichmentStatus);
  const source = parseContextSource(r.source);
  const confidence = parseValidationConfidence(r.confidence);
  const goal = typeof r.goal === 'string' ? r.goal : '';
  if (!enrichmentStatus || !source || !confidence || !goal) return undefined;
  const subtasks = Array.isArray(r.subtasks)
    ? r.subtasks.map(item => {
      if (!item || typeof item !== 'object') return null;
      const x = item as Record<string, unknown>;
      const title = typeof x.title === 'string' ? x.title.trim() : '';
      const subtaskSource: 'pm_child' | 'developer_plan' | 'fallback_generated' = x.source === 'pm_child' || x.source === 'developer_plan' || x.source === 'fallback_generated'
        ? x.source
        : 'fallback_generated';
      return title ? {
        title,
        description: typeof x.description === 'string' ? x.description : undefined,
        status: typeof x.status === 'string' ? x.status : undefined,
        source: subtaskSource,
      } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];
  return {
    enrichmentStatus,
    enrichmentError: typeof r.enrichmentError === 'string' ? r.enrichmentError : undefined,
    source,
    goal,
    taskDescription: typeof r.taskDescription === 'string' ? r.taskDescription : undefined,
    subtasks,
    acceptanceCriteria: toStringArray(r.acceptanceCriteria),
    validationSteps: toStringArray(r.validationSteps),
    developerTaskPlan: parseDeveloperTaskPlan(r.developerTaskPlan),
    confidence,
  };
}

function parseDeveloperTaskPlan(value: unknown): TyneDeveloperTaskPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const implementationTasks: TyneDeveloperTaskPlan['implementationTasks'] = [];
  if (Array.isArray(r.implementationTasks)) {
    for (const item of r.implementationTasks) {
      if (!item || typeof item !== 'object') continue;
      const x = item as Record<string, unknown>;
      const title = typeof x.title === 'string' ? x.title.trim() : '';
      if (!title) continue;
      const status: TyneDeveloperTaskPlan['implementationTasks'][number]['status'] = x.status === 'completed' || x.status === 'in_progress' ? x.status : 'not_started';
      implementationTasks.push({
        title,
        description: typeof x.description === 'string' ? x.description : '',
        likelyFiles: toStringArray(x.likelyFiles),
        dependencies: toStringArray(x.dependencies),
        status,
      });
    }
  }
  const testingTasks: TyneDeveloperTaskPlan['testingTasks'] = [];
  if (Array.isArray(r.testingTasks)) {
    for (const item of r.testingTasks) {
      if (!item || typeof item !== 'object') continue;
      const x = item as Record<string, unknown>;
      const title = typeof x.title === 'string' ? x.title.trim() : '';
      if (!title) continue;
      const testType: TyneDeveloperTaskPlan['testingTasks'][number]['testType'] = x.testType === 'integration' || x.testType === 'e2e' || x.testType === 'manual' ? x.testType : 'unit';
      testingTasks.push({ title, testType, likelyFiles: toStringArray(x.likelyFiles) });
    }
  }
  return {
    issueKey: typeof r.issueKey === 'string' ? r.issueKey : '',
    title: typeof r.title === 'string' ? r.title : '',
    technicalSummary: typeof r.technicalSummary === 'string' ? r.technicalSummary : '',
    implementationTasks,
    testingTasks,
    riskNotes: toStringArray(r.riskNotes),
    questionsForPM: toStringArray(r.questionsForPM),
  };
}

function parseCodebaseContext(value: unknown): TyneCodebaseContextPack | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  return {
    repositoryName: typeof r.repositoryName === 'string' ? r.repositoryName : '',
    currentBranch: typeof r.currentBranch === 'string' ? r.currentBranch : '',
    workspaceRoot: typeof r.workspaceRoot === 'string' ? r.workspaceRoot : '',
    projectHints: r.projectHints && typeof r.projectHints === 'object' ? r.projectHints as TyneCodebaseContextPack['projectHints'] : {},
    fileTreeSummary: toStringArray(r.fileTreeSummary),
    relevantFiles: parsePathReasonList(r.relevantFiles, true),
    existingTests: parsePathReasonList(r.existingTests, false),
    changedFiles: toStringArray(r.changedFiles),
    diff: typeof r.diff === 'string' ? r.diff : undefined,
  };
}

function parsePathReasonList(value: unknown, includeSnippet: boolean): Array<{ path: string; reason: string; snippet?: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ path: string; reason: string; snippet?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const itemPath = typeof r.path === 'string' ? r.path.trim() : '';
    if (!itemPath) continue;
    result.push({
      path: itemPath,
      reason: typeof r.reason === 'string' ? r.reason : '',
      snippet: includeSnippet && typeof r.snippet === 'string' ? r.snippet : undefined,
    });
  }
  return result;
}

function parseCompletedGoals(value: unknown): TynePmTaskValidationResult['completedGoals'] {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<TynePmTaskValidationResult['completedGoals']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;
    result.push({ title, evidence: typeof r.evidence === 'string' ? r.evidence : undefined, relatedFiles: toStringArray(r.relatedFiles) });
  }
  return result.slice(0, 4);
}

function parsePendingGoals(value: unknown): TynePmTaskValidationResult['pendingGoals'] {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<TynePmTaskValidationResult['pendingGoals']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;
    const priority: NonNullable<TynePmTaskValidationResult['pendingGoals']>[number]['priority'] = r.priority === 'high' || r.priority === 'low' ? r.priority : 'medium';
    result.push({
      title,
      reason: typeof r.reason === 'string' ? r.reason : '',
      suggestedAction: typeof r.suggestedAction === 'string' ? r.suggestedAction : '',
      relatedFiles: toStringArray(r.relatedFiles),
      priority,
    });
  }
  return result.slice(0, 4);
}

function parseDeveloperActions(value: unknown): TynePmTaskValidationResult['developerActions'] {
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<TynePmTaskValidationResult['developerActions']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;
    result.push({ title, fileHint: typeof r.fileHint === 'string' ? r.fileHint : undefined, reason: typeof r.reason === 'string' ? r.reason : undefined });
  }
  return result.slice(0, 5);
}

function parseCodeEvidence(value: unknown): TynePmTaskValidationResult['codeEvidence'] {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    const file = typeof r.file === 'string' ? r.file.trim() : '';
    if (!file) return null;
    return { file, reason: typeof r.reason === 'string' ? r.reason : '' };
  }).filter((x): x is NonNullable<TynePmTaskValidationResult['codeEvidence']>[number] => Boolean(x)).slice(0, 6);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean);
}

function toFailedCriteriaArray(value: unknown): Array<{ criterion: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((v: unknown) => {
      if (!v || typeof v !== 'object') return null;
      const r = v as Record<string, unknown>;
      const criterion = typeof r.criterion === 'string' ? r.criterion.trim() : '';
      const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
      return criterion ? { criterion, reason } : null;
    })
    .filter((v): v is { criterion: string; reason: string } => Boolean(v));
}
