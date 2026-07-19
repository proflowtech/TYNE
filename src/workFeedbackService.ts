import * as vscode from 'vscode';
import { TyneValidationResult } from './validationTypes';
import { TyneCommitRecord } from './commitTypes';
import { listCommitRecords } from './commitMetadataService';
import {
  TyneWorkFeedback,
  TyneValidationStatus,
  TyneRiskLevel,
  TynePlanTier,
  TyneMaxFeedbackSection,
  ALL_MAX_FEEDBACK_SECTIONS,
} from './automationTypes';

function mapValidationStatus(status: TyneValidationResult['status']): TyneValidationStatus {
  if (status === 'pass') { return 'pass'; }
  if (status === 'partial') { return 'partial'; }
  if (status === 'fail') { return 'fail'; }
  return 'not_run';
}

function inferRiskLevel(validation: TyneValidationResult | null): TyneRiskLevel {
  if (!validation) { return 'not_assessed'; }
  if (validation.riskLevel) { return validation.riskLevel; }
  if (validation.status === 'pass') { return 'low'; }
  if (validation.status === 'partial') { return 'medium'; }
  return 'high';
}

export function getLatestValidationForTask(
  validationResult: TyneValidationResult | null,
): { status: TyneValidationStatus; riskLevel: TyneRiskLevel } {
  if (!validationResult) {
    return { status: 'not_run', riskLevel: 'not_assessed' };
  }
  return {
    status: mapValidationStatus(validationResult.status),
    riskLevel: inferRiskLevel(validationResult),
  };
}

export function getLatestCommitForTask(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
): TyneCommitRecord | null {
  const commits = listCommitRecords(context, repositoryPath)
    .filter(c => c.taskId === taskId)
    .sort((a, b) => new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime());
  return commits[0] ?? null;
}

export async function getCommitUrl(
  commitHash: string,
): Promise<string | null> {
  try {
    const { getGit } = await import('./gitManager');
    const git = getGit();
    if (!git) { return null; }
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) { return null; }
    let url = origin.refs.fetch;
    url = url.replace(/\.git$/, '');
    if (url.startsWith('git@')) {
      url = url.replace('git@github.com:', 'https://github.com/');
    }
    return `${url}/commit/${commitHash}`;
  } catch {
    return null;
  }
}

function formatModelName(validation: TyneValidationResult | null): string {
  if (!validation) { return 'Tyne'; }
  if (validation.provider === 'managed') {
    return `Tyne ${validation.tier === 'max' ? 'Max' : validation.tier === 'pro' ? 'Pro' : 'Core'}`;
  }
  return validation.provider === 'anthropic' ? 'Claude' : validation.provider === 'openai' ? 'OpenAI' : 'AXIOM';
}

export async function buildFeedback(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
  taskTitle: string | undefined,
  branchName: string | undefined,
  validationResult: TyneValidationResult | null,
  requireValidation: boolean,
  planTier: TynePlanTier = 'free',
  maxSections: TyneMaxFeedbackSection[] = ALL_MAX_FEEDBACK_SECTIONS,
): Promise<TyneWorkFeedback> {
  const { status: validationStatus, riskLevel } = getLatestValidationForTask(validationResult);
  const latestCommit = getLatestCommitForTask(context, repositoryPath, taskId);
  const commitHash = latestCommit?.shortHash ?? latestCommit?.commitHash?.slice(0, 8) ?? '';
  const commitUrl = commitHash ? await getCommitUrl(latestCommit?.commitHash ?? '') : null;
  const now = new Date();
  const synced = now.toISOString().replace('T', ' ').slice(0, 16);

  const body = formatFeedbackBody({
    taskId,
    taskTitle,
    branchName,
    commitHash,
    commitUrl: commitUrl ?? undefined,
    validationStatus,
    riskLevel,
    synced,
    requireValidation,
    planTier,
    maxSections,
    validationResult,
  });

  return {
    taskId,
    taskTitle,
    branchName,
    commitHash: commitHash || undefined,
    commitUrl: commitUrl ?? undefined,
    validationStatus,
    riskLevel,
    generatedAt: now.toISOString(),
    body,
  };
}

interface FeedbackBodyParams {
  taskId: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  validationStatus: TyneValidationStatus;
  riskLevel: TyneRiskLevel;
  synced: string;
  requireValidation: boolean;
  planTier: TynePlanTier;
  maxSections: TyneMaxFeedbackSection[];
  validationResult: TyneValidationResult | null;
}

export function formatFeedbackBody(params: FeedbackBodyParams): string {
  const { validationStatus, requireValidation } = params;
  if (validationStatus === 'not_run' && requireValidation) {
    return 'Tyne feedback blocked: validation has not been run. Run goal validation before posting feedback.';
  }
  return enforcePmCommentPolicy(formatRichFeedbackBody(params));
}

const PM_COMMENT_WORD_LIMIT = 120;
const AI_PHRASE_RE = /\b(?:AI analysis|the AI found|the system determined|based on analysis|the model suggests|I analyzed)\b/gi;

export function enforcePmCommentPolicy(body: string): string {
  const cleaned = body
    .replace(AI_PHRASE_RE, '')
    .split('\n')
    .map(line => line.replace(/\s{2,}/g, ' ').trimEnd())
    .filter(line => line.trim())
    .join('\n')
    .trim();
  const words = cleaned.split(/\s+/);
  return words.length <= PM_COMMENT_WORD_LIMIT
    ? cleaned
    : `${words.slice(0, PM_COMMENT_WORD_LIMIT - 1).join(' ')}…`;
}

function shortItem(value: string, maxWords = 12): string {
  const clean = value.replace(AI_PHRASE_RE, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  return words.length <= maxWords ? clean : `${words.slice(0, maxWords).join(' ')}…`;
}

// Kept as the public formatter name for compatibility; output is intentionally
// a concise teammate update, while the full validation report stays in Tyne.
export function formatRichFeedbackBody(params: FeedbackBodyParams): string {
  const { taskTitle, commitHash, commitUrl, validationStatus, validationResult } = params;
  const criteriaMet = validationResult?.criteriaMet ?? [];
  const criteriaNotMet = validationResult?.criteriaNotMet ?? [];
  const missing = validationResult?.missingRequirements ?? [];
  const quality = validationResult?.codeQualityNotes ?? [];
  const suggestions = validationResult?.suggestions ?? [];
  const summary = shortItem(validationResult?.summary || taskTitle || 'Implementation update');
  const completed = criteriaMet.length
    ? criteriaMet.slice(0, 3)
    : quality.slice(0, 2);
  const pending = [
    ...criteriaNotMet.map(item => `${item.criterion}: ${item.reason}`),
    ...missing,
    ...suggestions,
  ].slice(0, 2);
  const lines: string[] = [];

  if (validationStatus === 'fail') {
    lines.push('Validation incomplete.', '', 'Issues found:');
    (pending.length ? pending : ['Implementation does not yet meet the task requirements.'])
      .forEach(item => lines.push(`- ${shortItem(item)}`));
    lines.push('', 'Next:', 'Please address the above before merging.');
  } else {
    lines.push(`Implemented:`, `- ${summary}`);
    if (completed.length) {
      lines.push('', 'Completed:');
      completed.forEach(item => lines.push(`✓ ${shortItem(item)}`));
    }
    lines.push('', 'Validation:');
    lines.push(validationStatus === 'pass' ? '✓ Validation passed' : validationStatus === 'partial' ? '⚠ Validation needs follow-up' : '• Validation not run');
    if (pending.length) {
      lines.push('', 'Pending:');
      pending.forEach(item => lines.push(`- ${shortItem(item)}`));
    }
  }
  if (commitHash) {
    lines.push('', `PR: ${commitUrl || commitHash}`);
  }
  return lines.join('\n');
}

interface MaxFeedbackBodyParams {
  taskId: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  validationStatus: TyneValidationStatus;
  riskLevel: TyneRiskLevel;
  synced: string;
  validationResult: TyneValidationResult | null;
  maxSections: TyneMaxFeedbackSection[];
}

export function formatMaxFeedbackBody(params: MaxFeedbackBodyParams): string {
  const {
    taskId, taskTitle, branchName, commitHash, commitUrl,
    validationStatus, riskLevel, synced, validationResult, maxSections,
  } = params;

  const sections = new Set(maxSections);
  const statusLabel = validationStatus.toUpperCase();
  const riskLabel = riskLevel === 'not_assessed' ? 'Not assessed' : riskLevel.charAt(0).toUpperCase() + riskLevel.slice(1);
  const commitDisplay = commitHash
    ? (commitUrl ? `[${commitHash}](${commitUrl})` : commitHash)
    : '—';
  const model = formatModelName(validationResult);

  const lines: (string | null)[] = [
    `## Validation report — ${statusLabel}`,
    '',
    taskTitle ? `**Task:** ${taskTitle} (${taskId})` : `**Task:** ${taskId}`,
    `**Status:** ${statusLabel}`,
    `**Risk:** ${riskLabel}`,
    `**Model:** ${model}`,
    branchName ? `**Branch:** ${branchName}` : null,
    commitHash ? `**Commit:** ${commitDisplay}` : null,
    `**Synced:** ${synced}`,
    '',
  ];

  if (sections.has('validation_stages') && validationResult?.trace?.steps?.length) {
    lines.push('## Validation stages', '');
    for (const step of validationResult.trace.steps) {
      const statusIcon = step.status === 'success' ? '✅' : step.status === 'warning' ? '⚠️' : step.status === 'failed' ? '❌' : '⏳';
      lines.push(`${statusIcon} **${step.title}**${step.model ? ` — ${step.model}` : ''}`);
      if (step.summary) {
        lines.push(`  ${step.summary}`);
      }
    }
    lines.push('');
  }

  if (sections.has('risk_assessment') && (riskLevel !== 'not_assessed' || validationResult?.missingRequirements?.length || validationResult?.criteriaNotMet?.length)) {
    lines.push('## Risk assessment', '');
    lines.push(`**Overall risk:** ${riskLabel}`);
    if (validationResult?.missingRequirements?.length) {
      lines.push('', '**Missing requirements:**');
      for (const item of validationResult.missingRequirements) {
        lines.push(`- ${item}`);
      }
    }
    if (validationResult?.criteriaNotMet?.length) {
      lines.push('', '**Criteria not met:**');
      for (const item of validationResult.criteriaNotMet) {
        lines.push(`- ${item.criterion}: ${item.reason}`);
      }
    }
    lines.push('');
  }

  if (sections.has('performance_metrics') && validationResult) {
    lines.push('## Performance metrics', '');
    if (typeof validationResult.matchPercent === 'number') {
      lines.push(`- **Match:** ${validationResult.matchPercent}%`);
    }
    if (typeof validationResult.durationMs === 'number') {
      lines.push(`- **Duration:** ${(validationResult.durationMs / 1000).toFixed(1)}s`);
    }
    if (validationResult.filesReviewed?.length) {
      lines.push(`- **Files reviewed:** ${validationResult.filesReviewed.length}`);
    }
    lines.push('');
  }

  if (sections.has('security_check') && validationResult) {
    lines.push('## Security check', '');
    const securityNotes = (validationResult.codeQualityNotes || []).filter(n => /security|secure|vuln|inject|escape|sanitize|auth|permission/i.test(n));
    if (securityNotes.length) {
      lines.push('**Security-related notes:**');
      for (const note of securityNotes) {
        lines.push(`- ${note}`);
      }
    } else {
      lines.push('No explicit security issues flagged in this validation.');
    }
    lines.push('');
  }

  if (sections.has('code_quality') && (validationResult?.codeQualityNotes?.length || validationResult?.filesReviewed?.length)) {
    lines.push('## Code quality', '');
    if (validationResult.codeQualityNotes?.length) {
      for (const note of validationResult.codeQualityNotes) {
        lines.push(`- ${note}`);
      }
    }
    if (validationResult.filesReviewed?.length) {
      lines.push('', '**Files reviewed:**');
      for (const file of validationResult.filesReviewed) {
        lines.push(`- \`${file}\``);
      }
    }
    lines.push('');
  }

  if (sections.has('recommendations') && validationResult?.suggestions?.length) {
    lines.push('## Recommendations', '');
    for (const suggestion of validationResult.suggestions) {
      lines.push(`- ${suggestion}`);
    }
    lines.push('');
  }

  lines.push('Generated by Tyne.');
  return lines.filter(l => l !== null).join('\n');
}

export async function previewFeedback(
  context: vscode.ExtensionContext,
  repositoryPath: string,
  taskId: string,
  taskTitle: string | undefined,
  branchName: string | undefined,
  validationResult: TyneValidationResult | null,
  requireValidation: boolean,
  planTier: TynePlanTier = 'free',
  maxSections: TyneMaxFeedbackSection[] = ALL_MAX_FEEDBACK_SECTIONS,
): Promise<string> {
  const feedback = await buildFeedback(
    context, repositoryPath, taskId, taskTitle, branchName, validationResult, requireValidation, planTier, maxSections,
  );
  return feedback.body;
}
