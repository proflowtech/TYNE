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
  // A rich Developer/QA/PM comment for every tier. (The previous free="" / pro=short
  // gating meant most completed tasks got no PM comment at all.)
  return formatRichFeedbackBody(params);
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Compose a structured "what was done / how it was validated / what's next"
// comment from the AI (Gemini/DeepSeek) validation findings, written from a
// Developer, QA, and PM point of view. Plain text (renders cleanly in Jira).
export function formatRichFeedbackBody(params: FeedbackBodyParams): string {
  const { taskId, taskTitle, branchName, commitHash, commitUrl, validationStatus, riskLevel, synced, validationResult } = params;

  const statusLabel = validationStatus.toUpperCase();
  const icon = validationStatus === 'pass' ? '✅' : validationStatus === 'partial' ? '⚠️' : validationStatus === 'fail' ? '❌' : '📝';
  const riskLabel = riskLevel === 'not_assessed' ? 'Not assessed' : cap(riskLevel);
  const model = formatModelName(validationResult);
  const matchPart = typeof validationResult?.matchPercent === 'number' ? ` · Match ${validationResult.matchPercent}%` : '';
  const commitDisplay = commitHash ? (commitUrl ? `${commitHash} (${commitUrl})` : commitHash) : '—';

  const files = validationResult?.filesReviewed ?? [];
  const criteriaMet = validationResult?.criteriaMet ?? [];
  const criteriaNotMet = validationResult?.criteriaNotMet ?? [];
  const missing = validationResult?.missingRequirements ?? [];
  const quality = validationResult?.codeQualityNotes ?? [];
  const suggestions = validationResult?.suggestions ?? [];
  const summary = (validationResult?.detailedExplanation || validationResult?.summary || '').trim();

  const L: string[] = [];
  L.push(`${icon} Work completed via Tyne — ${statusLabel}`);
  L.push('');
  L.push(`Task: ${taskTitle ? `${taskTitle} (${taskId})` : taskId}`);
  if (branchName) { L.push(`Branch: ${branchName}`); }
  if (commitHash) { L.push(`Commit: ${commitDisplay}`); }
  L.push(`Validated by: ${model}${matchPart} · ${synced}`);
  L.push('');

  // 🧑‍💻 Developer — what was built
  L.push('🧑‍💻 Developer — what was done');
  L.push(summary || 'Implementation completed on the linked branch.');
  if (files.length) {
    L.push(`Files changed (${files.length}):`);
    files.slice(0, 20).forEach(f => L.push(`  • ${f}`));
    if (files.length > 20) { L.push(`  • …and ${files.length - 20} more`); }
  }
  L.push('');

  // 🧪 QA — how much was validated
  L.push('🧪 QA — validation');
  L.push(`  • Result: ${statusLabel}${matchPart} · Risk ${riskLabel}`);
  if (criteriaMet.length) {
    L.push(`  • Acceptance criteria met (${criteriaMet.length}):`);
    criteriaMet.forEach(c => L.push(`      ✓ ${c}`));
  }
  if (criteriaNotMet.length) {
    L.push(`  • Not met (${criteriaNotMet.length}):`);
    criteriaNotMet.forEach(c => L.push(`      ✗ ${c.criterion}: ${c.reason}`));
  }
  if (missing.length) {
    L.push('  • Missing requirements:');
    missing.forEach(m => L.push(`      – ${m}`));
  }
  if (quality.length) {
    L.push('  • Code quality / security notes:');
    quality.forEach(n => L.push(`      – ${n}`));
  }
  L.push('');

  // 📋 PM — readiness & next steps
  L.push('📋 PM — status & next steps');
  if (validationStatus === 'pass') {
    L.push('  • Acceptance criteria satisfied — ready to ship.');
  } else if (validationStatus === 'partial') {
    L.push('  • Partially complete — some acceptance criteria still need work before closing.');
  } else if (validationStatus === 'fail') {
    L.push('  • Validation failed — the change does not yet meet the goal.');
  } else {
    L.push('  • Work submitted; goal validation was not run.');
  }
  if (suggestions.length) {
    L.push('  • Recommended next steps:');
    suggestions.forEach(s => L.push(`      – ${s}`));
  }
  L.push('');
  L.push('— Generated by Tyne from AI code validation.');

  return L.join('\n');
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
