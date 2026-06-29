import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
  TynePmTaskIntelligence,
  TynePmTaskValidationResult,
} from './taskTypes';

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
  jiraIssueKey: string;
  cloudId: string;
  tier: string;
  useGemini?: boolean;
}

export interface ValidatePmTaskInput {
  context: vscode.ExtensionContext;
  jiraIssueKey: string;
  cloudId: string;
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
}

export class PmTaskIntelligenceService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async extractIntelligence(input: ExtractPmTaskIntelligenceInput): Promise<TynePmTaskIntelligence> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('Connect GitHub before extracting PM task intelligence.');
    }
    const repo = getRepositoryIdentity();
    const supabaseUrl = getSupabaseUrl();
    const response = await fetch(`${supabaseUrl}${PM_INTELLIGENCE_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jiraIssueKey: input.jiraIssueKey,
        cloudId: input.cloudId,
        repositoryId: repo.repositoryId,
        tier: input.tier,
        useGemini: input.useGemini,
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const errorText = typeof payload?.error === 'string' ? payload.error : `PM intelligence failed (${response.status})`;
      throw new Error(errorText);
    }
    return parsePmTaskIntelligence(payload);
  }

  async validateTask(input: ValidatePmTaskInput): Promise<TynePmTaskValidationResult> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('Connect GitHub before validating PM task work.');
    }
    const sanitized = sanitizeDiff(input.diffText, input.changedFiles);
    const supabaseUrl = getSupabaseUrl();
    const response = await fetch(`${supabaseUrl}${PM_VALIDATION_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jiraIssueKey: input.jiraIssueKey,
        cloudId: input.cloudId,
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
      }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload) {
      const errorText = typeof payload?.error === 'string' ? payload.error : `PM validation failed (${response.status})`;
      throw new Error(errorText);
    }
    return parsePmTaskValidationResult(payload);
  }
}

export function getPmTaskIntelligenceService(context: vscode.ExtensionContext): PmTaskIntelligenceService {
  return new PmTaskIntelligenceService(context);
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
    issueKey: typeof payload.issueKey === 'string' ? payload.issueKey : '',
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
  };
}

function parsePmTaskValidationResult(payload: Record<string, unknown>): TynePmTaskValidationResult {
  const status = typeof payload.status === 'string' && ['pass', 'partial', 'fail'].includes(payload.status.toLowerCase())
    ? (payload.status.toLowerCase() as 'pass' | 'partial' | 'fail')
    : 'partial';
  const matchPercent = typeof payload.matchPercent === 'number' ? payload.matchPercent : undefined;
  return {
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
    jiraIssueKey: typeof payload.jiraIssueKey === 'string' ? payload.jiraIssueKey : undefined,
    repositoryId: typeof payload.repositoryId === 'string' ? payload.repositoryId : null,
    branchName: typeof payload.branchName === 'string' ? payload.branchName : undefined,
    changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.map(String) : undefined,
  };
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
