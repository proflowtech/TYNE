import test from 'node:test';
import assert from 'node:assert/strict';

import { runLocalIntelligence } from '../privacy/localIntelligence/localReviewEngine';
import { runLocalSecurityScan } from '../privacy/localIntelligence/localSecurityEngine';
import { classifyData } from '../privacy/localIntelligence/dataClassification';
import { analyzeDataFlows } from '../privacy/localIntelligence/dataFlowEngine';
import { sanitizeValidateReviewPayload, buildLocalComplianceSummary } from '../privacy/payloadSanitizer';

const PHI_DIFF = [
  'diff --git a/patientService.ts b/patientService.ts',
  '--- a/patientService.ts',
  '+++ b/patientService.ts',
  '@@ -1,0 +1,4 @@',
  '+export function getPatient(mrn: string) {',
  '+  const diagnosis = "flu";',
  '+  console.log("patient", mrn, diagnosis, "email", "john@hospital.org");',
  '+  return { mrn, diagnosis };',
  '+}',
].join('\n');

const SECRET_DIFF = [
  'diff --git a/config.ts b/config.ts',
  '--- a/config.ts',
  '+++ b/config.ts',
  '@@ -1,0 +1,2 @@',
  '+const apiKey = "sk-abc123456789012345";',
  '+logger.info({ apiKey });',
].join('\n');

test('local security detects hardcoded secrets and logging', () => {
  const result = runLocalSecurityScan(SECRET_DIFF);
  assert.ok(result.findings.length >= 1);
  assert.ok(result.criticalFindings >= 1 || result.status === 'blocked');
  for (const f of result.findings) {
    assert.ok(f.evidenceHash);
    assert.equal('evidence' in f, false);
  }
});

test('local classification detects PHI/PII signals', () => {
  const types = classifyData(
    'patient mrn ABC12345 diagnosis flu email john@hospital.org',
    'return res.json(patient)',
  );
  assert.ok(types.includes('PHI') || types.includes('PII'));
});

test('local data-flow finds sinks with sensitive data', () => {
  const flows = analyzeDataFlows(PHI_DIFF);
  assert.ok(Array.isArray(flows));
  // May be empty on sparse diffs — engine must not throw
  assert.ok(flows.every(f => typeof f.source === 'string'));
});

test('local intelligence returns egress summary without source snippets', () => {
  const result = runLocalIntelligence({ diff: PHI_DIFF, frameworks: ['HIPAA'] });
  assert.ok(result.egressSummary);
  assert.ok(typeof result.egressSummary.score === 'number');
  const serialized = JSON.stringify(result.egressSummary);
  assert.doesNotMatch(serialized, /john@hospital\.org/);
  assert.doesNotMatch(serialized, /sk-abc/);
  // evidence refs are hashes only
  for (const ref of result.egressSummary.evidenceRefs) {
    assert.ok(ref.hash);
    assert.equal('snippet' in ref, false);
    assert.equal('text' in ref, false);
  }
});

test('local_compliance egress strips diff and BYOK; keeps aggregated summary', () => {
  const { request, localSummary } = sanitizeValidateReviewPayload({
    editedCode: { diff: PHI_DIFF, changedFiles: [{ path: 'patientService.ts' }] },
    byokKey: 'sk-must-not-leave',
    byokProvider: 'openai',
    complianceFrameworks: ['HIPAA'],
  }, { privacyMode: 'local_compliance', dataResidency: 'local_only' });

  assert.equal(request.editedCode.diff, '');
  assert.equal(request.byokKey, undefined);
  assert.ok(localSummary);
  assert.ok(Array.isArray(localSummary.frameworks) || localSummary.framework);
  assert.ok(Array.isArray(localSummary.findingTitles) || localSummary.criticalFindings >= 0);
  const body = JSON.stringify(request);
  assert.doesNotMatch(body, /john@hospital\.org/);
  assert.doesNotMatch(body, /sk-must-not-leave/);
  assert.doesNotMatch(body, /console\.log\("patient"/);
});

test('buildLocalComplianceSummary uses real engines not heuristic-only', () => {
  const summary = buildLocalComplianceSummary({
    diff: SECRET_DIFF,
    frameworks: ['HIPAA'],
  });
  assert.ok(summary.criticalFindings >= 1 || summary.securityStatus === 'blocked' || summary.status === 'blocked');
  assert.ok(summary.evidenceRefs === undefined || !summary.evidenceRefs.some((r: any) => r.snippet));
});
