import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildValidateReviewPdfFileName,
  buildValidateReviewPdfHtml,
} from '../validateReviewPdfExport';
import { COMPLIANCE_DISCLAIMER } from '../validateReviewTypes';
import { TYNE_LOGO_WORDMARK_DATA_URI } from '../tyneLogoDataUri';
import type { TyneValidateReviewResult } from '../validateReviewTypes';

const sample: TyneValidateReviewResult = {
  id: 'vr-test-1',
  repositoryName: 'TYNE',
  branchName: 'main',
  commitSha: 'abcdef1234567890',
  scope: 'staged_changes',
  status: 'needs_work',
  score: 72,
  riskLevel: 'medium',
  vibeCodeRisk: 'low',
  summary: 'Mostly aligned with the linked task; a few findings remain.',
  walkthrough: 'This change tightens Jira task pull auth and report export.',
  topConcerns: ['Hosted auth still needs JWT on one path'],
  overallVerdict: 'changes_requested',
  completedGoals: ['Connect Jira OAuth'],
  pendingGoals: [{ title: 'Show assigned tasks', reason: 'auth', suggestedAction: 'retry pull' }],
  findings: [{
    id: 'f1',
    file: 'src/jiraProvider.ts',
    line: 10,
    severity: 'medium',
    category: 'correctness',
    title: 'Auth token fallback',
    explanation: 'Hosted requests should use getEffectiveAuthToken.',
    confidence: 'high',
    remediation: 'Use session JWT or GitHub token.',
  }],
  missingTests: [{ title: 'PDF export self-check', testType: 'unit' }],
  nextActions: [{ title: 'Re-run Validate & Review after install', reason: 'verify export' }],
  visualDiff: [{ file: 'src/validateReviewPdfExport.ts', status: 'added', additions: 120, deletions: 0 }],
  sectionScores: [{ id: 'correctness', title: 'Correctness', score: 70, status: 'warn', summary: 'Auth edge cases' }],
  languageBreakdown: [{ language: 'TypeScript', percent: 92, lines: 120 }],
  contributionBreakdown: [
    { id: 'user', label: 'Dipanjan', kind: 'human', percent: 100, lines: 120 },
  ],
  qualityScore: 78,
  qualityScorecard: {
    correctness: 70,
    maintainability: 80,
    vibe: 85,
    architecture: 75,
    overall: 78,
  },
  modelInfo: { primaryModel: 'gemini', tier: 'free' },
  tokenUsage: { inputTokens: 1000, outputTokens: 400, costUsd: 0.01 },
  complianceStatus: 'review_required',
  createdAt: '2026-07-28T12:00:00.000Z',
};

test('buildValidateReviewPdfHtml matches Tyne report design system', () => {
  const html = buildValidateReviewPdfHtml(sample, {
    generatedBy: '@dipanjan',
    generatedByEmail: 'dipanjan@example.com',
  });
  assert.match(html, /Validate &amp; Review Assessment/);
  assert.match(html, /JetBrains Mono/);
  assert.match(html, /#0025CC/);
  assert.match(html, /#0A0E1A/);
  assert.match(html, /Composite Score/);
  assert.match(html, /Requires Remediation/);
  assert.match(html, /CONFIDENTIAL — INTERNAL USE ONLY/);
  assert.match(html, /01 &nbsp;Executive Summary/);
  assert.match(html, /06 &nbsp;Findings/);
  assert.match(html, /Legal disclaimer — not a certificate/);
  assert.ok(html.includes(TYNE_LOGO_WORDMARK_DATA_URI.slice(0, 40)));
  assert.match(html, /@dipanjan/);
  assert.match(html, /Dipanjan/);
  assert.match(html, /jiraProvider\.ts/);
  assert.match(html, /Print \/ Save as PDF/);
  assert.ok(html.includes('not a compliance certificate') || html.includes(COMPLIANCE_DISCLAIMER.slice(0, 40)));
  assert.doesNotMatch(html, /Technical Appendix/);
  assert.doesNotMatch(html, /Primary model|gemini|deepseek/i);
  assert.doesNotMatch(html, /<pre>/);
});

test('buildValidateReviewPdfFileName uses html extension for print workflow', () => {
  assert.match(buildValidateReviewPdfFileName(1), /^tyne-validate-review-1\.html$/);
});

test('COMPLIANCE_DISCLAIMER states advisory only and not a certificate', () => {
  assert.match(COMPLIANCE_DISCLAIMER, /advisory suggestions only/i);
  assert.match(COMPLIANCE_DISCLAIMER, /do not constitute a compliance certificate/i);
  assert.match(COMPLIANCE_DISCLAIMER, /HIPAA/);
});
