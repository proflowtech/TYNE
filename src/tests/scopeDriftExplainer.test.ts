import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjudicateScopeDrift,
  baselineAgentVerdicts,
  buildPrAnalysisFromReview,
  explainScopeDrift,
} from '../services/scopeDriftExplainer';

test('baseline verdicts reflect locked drift', () => {
  const matrix = {
    ticket_requirements: ['OAuth login'],
    developer_additions: ['OAuth login', 'Resend button', 'Email digest'],
    unmapped_additions: ['Resend button', 'Email digest'],
    drift_detected: true,
    lockedDrift: ['Resend button', 'Email digest'],
    overruled: [],
  };
  const v = baselineAgentVerdicts(matrix);
  assert.equal(v.staff, 'major_drift');
  assert.equal(v.pm, 'should_split');
});

test('adjudication picks PM when drift locked', () => {
  const matrix = {
    ticket_requirements: ['Login'],
    developer_additions: ['Login', 'Resend'],
    unmapped_additions: ['Resend'],
    drift_detected: true,
    lockedDrift: ['Resend'],
    overruled: [],
    verdicts: [{ addition: 'Resend', required_dependency: false, reason: 'Not needed for login' }],
  };
  const adj = adjudicateScopeDrift(matrix, 'partial_creep', 'should_split');
  assert.equal(adj.winner, 'pm_ghost_cop');
  assert.equal(adj.recommendation, 'request_clarification');
  assert.match(adj.explanation, /Staff Engineer/i);
});

test('adjudication picks Staff when PM concerns overruled', () => {
  const matrix = {
    ticket_requirements: ['OAuth login'],
    developer_additions: ['OAuth login', 'Token refresh'],
    unmapped_additions: [],
    drift_detected: false,
    lockedDrift: [],
    overruled: ['Token refresh'],
    verdicts: [{ addition: 'Token refresh', required_dependency: true, reason: 'Required for session continuity' }],
  };
  const adj = adjudicateScopeDrift(matrix, 'on_scope', 'on_scope');
  assert.equal(adj.winner, 'staff_engineer');
  assert.equal(adj.recommendation, 'merge_as_is');
});

test('explainScopeDrift returns deterministic explanation without LLM', async () => {
  const matrix = {
    ticket_requirements: ['User profile page'],
    developer_additions: ['User profile page', 'Dark mode toggle'],
    unmapped_additions: ['Dark mode toggle'],
    drift_detected: true,
    lockedDrift: ['Dark mode toggle'],
    overruled: [],
  };
  const pr = buildPrAnalysisFromReview({
    driftMatrix: matrix,
    diff: [
      '+++ b/src/profile.tsx',
      '@@ -1 +1,2 @@',
      '+export function DarkModeToggle() { return null; }',
    ].join('\n'),
  });
  const ex = await explainScopeDrift(
    { description: 'Build profile page', acceptance_criteria: ['Profile page renders'] },
    pr,
  );
  assert.equal(ex.recommendation, 'request_clarification');
  assert.equal(ex.agent_verdicts.pm_ghost_cop.verdict, 'should_split');
  assert.ok(ex.agent_verdicts.staff_engineer.evidence.length >= 1);
  assert.ok(ex.adjudication.explanation.length > 40);
});

test('buildPrAnalysisFromReview extracts evidence snippets from diff', () => {
  const pr = buildPrAnalysisFromReview({
    driftMatrix: {
      ticket_requirements: [],
      developer_additions: ['Resend email'],
      unmapped_additions: ['Resend email'],
      drift_detected: true,
      lockedDrift: ['Resend email'],
    },
    diff: [
      '+++ b/src/mail.ts',
      '@@ -0,0 +1,1 @@',
      '+async function resendEmail() {}',
    ].join('\n'),
  });
  assert.ok(pr.evidence_snippets?.some(s => /resend/i.test(s.snippet)));
});
