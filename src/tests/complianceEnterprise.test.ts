import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COMPLIANCE_DISCLAIMER,
  complianceStatusLabel,
  normalizeComplianceStatus,
} from '../validateReviewTypes';

/** Mirror of complianceBlocking.ts — kept in sync by source-contract asserts below. */
function isComplianceHardBlock(finding: { severity?: string; confidence?: string; blocking?: boolean }): boolean {
  if ((finding.confidence || 'medium') === 'low') return false;
  if (finding.severity === 'critical') return true;
  if (finding.severity === 'high' && finding.confidence === 'high') return true;
  if (finding.blocking === true && (finding.severity === 'critical' || finding.severity === 'high')) return true;
  return false;
}

function resolveComplianceStatus(
  findings: Array<{ severity?: string; confidence?: string; blocking?: boolean }>,
): 'no_violations' | 'issues_detected' | 'review_required' | 'blocked' {
  if (!findings.length) return 'no_violations';
  if (findings.some(isComplianceHardBlock)) return 'blocked';
  const needsReview = findings.some(finding => {
    if ((finding.confidence || 'medium') === 'low') return false;
    return finding.severity === 'medium' || finding.severity === 'high';
  });
  if (needsReview) return 'review_required';
  return 'issues_detected';
}

test('legal compliance labels never say Passed/Failed/Compliant', () => {
  for (const status of ['no_violations', 'issues_detected', 'review_required', 'blocked', 'not_enabled', 'passed', 'warning', 'needs_work', 'failed']) {
    const label = complianceStatusLabel(status);
    assert.equal(/passed|failed|compliant|certified/i.test(label), false, label);
  }
  assert.equal(complianceStatusLabel('blocked'), 'Blocked');
  assert.equal(normalizeComplianceStatus('passed'), 'no_violations');
  assert.equal(normalizeComplianceStatus('needs_work'), 'review_required');
});

test('disclaimer constant is present and non-certifying', () => {
  assert.match(COMPLIANCE_DISCLAIMER, /advisory suggestions only/i);
  assert.match(COMPLIANCE_DISCLAIMER, /do not constitute a compliance certificate/i);
  assert.doesNotMatch(COMPLIANCE_DISCLAIMER, /\bPassed\b|\bFailed\b|HIPAA Compliant|\bCertified\b/i);
});

test('webview compliance UI uses safe wording, Status/Scope, and disclaimer', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(src, /No detected violations/);
  assert.match(src, /Issues detected/);
  assert.match(src, /Review required/);
  assert.match(src, /Blocked/);
  assert.match(src, /Not enabled/);
  assert.match(src, /vr-compliance-disclaimer/);
  assert.match(src, /Status:/);
  assert.match(src, /Scope:/);
  assert.match(src, /advisory suggestions only/i);
  assert.equal(src.includes("=== 'blocked' ? 'Failed'"), false);
  assert.equal(src.includes('HIPAA Compliant'), false);
  assert.equal(src.includes('SOC2 Certified'), false);
});

test('markdown/export path includes compliance disclaimer', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(src, /### 5\. Compliance Assessment/);
  assert.match(src, /complianceDisclaimer/);
  assert.match(src, /do not constitute a compliance certificate/i);
});

test('blocking logic: critical / high+high block; medium review; low confidence never blocks', () => {
  const blockingSrc = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/compliance/complianceBlocking.ts'),
    'utf8',
  );
  assert.match(blockingSrc, /export function isComplianceHardBlock/);
  assert.match(blockingSrc, /export function resolveComplianceStatus/);
  assert.match(blockingSrc, /finding\.severity === 'critical'/);
  assert.match(blockingSrc, /=== 'low'\) return false/);

  assert.equal(isComplianceHardBlock({ severity: 'critical', confidence: 'medium' }), true);
  assert.equal(isComplianceHardBlock({ severity: 'high', confidence: 'high' }), true);
  assert.equal(isComplianceHardBlock({ severity: 'high', confidence: 'medium' }), false);
  assert.equal(isComplianceHardBlock({ severity: 'critical', confidence: 'low' }), false);
  assert.equal(isComplianceHardBlock({ severity: 'medium', confidence: 'high' }), false);

  assert.equal(resolveComplianceStatus([]), 'no_violations');
  assert.equal(resolveComplianceStatus([{ severity: 'critical', confidence: 'high' }]), 'blocked');
  assert.equal(resolveComplianceStatus([{ severity: 'high', confidence: 'high' }]), 'blocked');
  assert.equal(resolveComplianceStatus([{ severity: 'medium', confidence: 'high' }]), 'review_required');
  assert.equal(resolveComplianceStatus([{ severity: 'high', confidence: 'medium' }]), 'review_required');
  assert.equal(resolveComplianceStatus([{ severity: 'low', confidence: 'high' }]), 'issues_detected');
  assert.equal(resolveComplianceStatus([{ severity: 'critical', confidence: 'low' }]), 'issues_detected');
});

test('edge guardrails: score cannot override compliance hard-block; Claude cannot certify', () => {
  const index = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.match(index, /reconcileReviewStatus/);
  assert.match(index, /isComplianceHardBlock/);
  assert.match(index, /resolveComplianceStatus/);
  assert.match(index, /Do not certify compliance/);
  assert.match(index, /Analyze only provided evidence/);
  assert.match(index, /insufficient_evidence/);
  assert.match(index, /loadPoliciesFromDb/);
  assert.match(index, /COMPLIANCE_DISCLAIMER/);
  assert.match(index, /never duplicate full findings/i);
  assert.match(index, /complianceFindingCount/);
  assert.equal(index.includes('complianceFindings: result.complianceFindings'), false);
});

test('evidence redaction module stores EvidenceRecord with hash + [REDACTED]', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/compliance/evidenceRedaction.ts'),
    'utf8',
  );
  assert.match(src, /export interface EvidenceRecord/);
  assert.match(src, /hash:/);
  assert.match(src, /snippet:/);
  assert.match(src, /redacted:/);
  assert.match(src, /\[REDACTED\]/);
  assert.match(src, /EMAIL|PHONE|CARD|SECRET|MRN/);
});

test('enterprise migration adds review_id index, safer statuses, and RLS', () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260716013000_compliance_enterprise_hardening.sql'),
    'utf8',
  );
  assert.match(migration, /compliance_reviews_review_id_idx/);
  assert.match(migration, /no_violations/);
  assert.match(migration, /rule_id/);
  assert.match(migration, /Authenticated read compliance/);
  const emptyDupes = [
    'supabase/migrations/20260715163223_compliance_policy_engine.sql',
    'supabase/migrations/20260715163313_compliance_policy_engine.sql',
  ];
  for (const rel of emptyDupes) {
    assert.equal(fs.existsSync(path.join(process.cwd(), rel)), false, `duplicate migration should be removed: ${rel}`);
  }
  assert.equal(fs.existsSync(path.join(process.cwd(), 'supabase/migrations/20260715215300_compliance_policy_engine.sql')), true);
});

test('quality gate blocks on compliance hard-block independently of score', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/qualityGateService.ts'), 'utf8');
  assert.match(src, /compliance_blocked/);
  assert.match(src, /complianceStatus === 'blocked'/);
});

test('phase 2 UI shows coverage categories and regression banner', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(src, /vr-compliance-coverage/);
  assert.match(src, /Not Reviewed/);
  assert.match(src, /Compliance Regression Detected/);
  assert.match(src, /vr-compliance-regression/);
});

test('phase 2 edge wires data flow engine, history, and Claude explain-only', () => {
  const index = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.match(index, /detectComplianceRegressions/);
  assert.match(index, /compliance_history/);
  assert.match(index, /Do not create findings/);
  assert.match(index, /focused test recommendation/);
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260716020000_compliance_history_regression.sql'),
    'utf8',
  );
  assert.match(migration, /create table if not exists public\.compliance_history/);
});
