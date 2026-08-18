import * as vscode from 'vscode';
import * as path from 'path';
import {
  ReviewTier,
  ReviewTierPolicy,
  ReviewCustomGuardrails,
  SafeCodebaseContext,
} from './validateReviewTypes';

// ── ReviewGuardrailEngine ────────────────────────────────────────────────────
// Determines tier policy, truncates diff/context, loads custom guardrails.

export function getTierPolicy(tier: ReviewTier): ReviewTierPolicy {
  switch (tier) {
    case 'free':
      return {
        tier: 'free',
        monthlyLimit: 5,
        // Pro-parity review quality for Core's 5 managed runs (Gemini-routed on edge).
        maxDiffChars: 120_000,
        maxRelevantFiles: 12,
        models: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
        basicChecksEnabled: true,
        vibeCodeDetectorEnabled: true,
        pmAlignmentEnabled: true,
        missingTestReviewEnabled: true,
        customGuardrailsEnabled: false,
        fullReportEnabled: true,
        compactReportOnly: false,
      };
    case 'pro':
      return {
        tier: 'pro',
        monthlyLimit: 50,
        maxDiffChars: 120_000,
        maxRelevantFiles: 12,
        models: ['google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
        basicChecksEnabled: true,
        vibeCodeDetectorEnabled: true,
        pmAlignmentEnabled: true,
        missingTestReviewEnabled: true,
        customGuardrailsEnabled: false,
        fullReportEnabled: true,
        compactReportOnly: false,
      };
    case 'max':
      return {
        tier: 'max',
        monthlyLimit: null,
        maxDiffChars: 200_000,
        maxRelevantFiles: 20,
        models: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-pro'],
        basicChecksEnabled: true,
        vibeCodeDetectorEnabled: true,
        pmAlignmentEnabled: true,
        missingTestReviewEnabled: true,
        customGuardrailsEnabled: true,
        fullReportEnabled: true,
        compactReportOnly: false,
      };
  }
}

export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) { return diff; }
  return diff.slice(0, maxChars) + '\n\n... [diff truncated at tier limit] ...';
}

export function truncateContext(context: SafeCodebaseContext, maxFiles: number): SafeCodebaseContext {
  return {
    ...context,
    nearbyFiles: (context.nearbyFiles || []).slice(0, maxFiles),
    nearbyTests: (context.nearbyTests || []).slice(0, Math.min(10, maxFiles)),
    changedFileContents: (context.changedFileContents || []).slice(0, Math.min(8, maxFiles)),
    impactedFiles: (context.impactedFiles || []).slice(0, maxFiles),
    pmTaskRelevantFiles: (context.pmTaskRelevantFiles || []).slice(0, maxFiles),
    codegraphNeighborhood: context.codegraphNeighborhood
      ? {
          ...context.codegraphNeighborhood,
          importers: (context.codegraphNeighborhood.importers || []).slice(0, maxFiles),
          importees: (context.codegraphNeighborhood.importees || []).slice(0, maxFiles),
          similar: (context.codegraphNeighborhood.similar || []).slice(0, 5),
          text: String(context.codegraphNeighborhood.text || '').slice(0, 8_000),
        }
      : undefined,
  };
}

export async function loadCustomGuardrails(
  workspaceRoot: string,
  context: vscode.ExtensionContext,
  tier: ReviewTier,
): Promise<ReviewCustomGuardrails | undefined> {
  if (tier !== 'max') { return undefined; }

  const requireTests = vscode.workspace.getConfiguration('tyne').get<boolean>('codeReview.requireTests', false);
  const allowedCommitTypes = vscode.workspace.getConfiguration('tyne').get<string[]>('codeReview.allowedCommitTypes', ['feat', 'fix', 'refactor', 'chore', 'docs', 'test']);
  const customRules: string[] = [];

  const rulesPath = path.join(workspaceRoot, '.tyne', 'review-rules.md');
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(rulesPath))).toString('utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    customRules.push(...lines.slice(0, 10));
  } catch { /* no custom rules file */ }

  return {
    requireTests,
    allowedCommitTypes,
    customRules: customRules.length ? customRules : undefined,
  };
}
