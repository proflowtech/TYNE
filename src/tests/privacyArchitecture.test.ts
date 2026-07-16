import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { redactSensitiveText } from '../privacy/localRedactionEngine';
import { scanSensitiveData, countSensitiveByClass } from '../privacy/sensitiveDataScanner';
import {
  sanitizeValidateReviewPayload,
  buildLocalComplianceSummary,
  toEvidenceReference,
} from '../privacy/payloadSanitizer';
import { allowsByokRelayToBackend, resolvePrivacySettings } from '../privacy/privacyModeService';

test('redaction removes API keys, JWT, emails, phone, PHI, PCI', () => {
  const sample = [
    'const key = "sk-abc1234567890123"',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIifQ.sig',
    'email patient@hospital.org phone 555-123-4567',
    'mrn: ABC12345 diagnosis flu',
    'card 4111111111111111',
  ].join('\n');
  const { text, redacted } = redactSensitiveText(sample);
  assert.equal(redacted, true);
  assert.doesNotMatch(text, /sk-abc1234567890123/);
  assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(text, /patient@hospital\.org/);
  assert.doesNotMatch(text, /555-123-4567/);
  assert.doesNotMatch(text, /4111111111111111/);
  assert.match(text, /REDACTED/);
  assert.ok(scanSensitiveData(sample).length > 0);
});

test('cloud mode keeps source payload but never relays BYOK key', () => {
  assert.equal(allowsByokRelayToBackend('cloud'), false);
  const { request, privacy } = sanitizeValidateReviewPayload({
    editedCode: { diff: 'const x = 1', changedFiles: [{ path: 'a.ts' }] },
    byokKey: 'sk-test-key-must-not-egress',
    byokProvider: 'openai',
  }, { privacyMode: 'cloud', dataResidency: 'us' });
  assert.equal(request.byokKey, undefined);
  assert.equal(privacy.privacyMode, 'cloud');
  assert.match(request.editedCode.diff, /const x = 1/);
});

test('privacy enhanced redacts sensitive values and strips BYOK key', () => {
  assert.equal(allowsByokRelayToBackend('privacy_enhanced'), false);
  const { request, privacy } = sanitizeValidateReviewPayload({
    editedCode: { diff: 'const email = "alice@example.com"\n', changedFiles: [] },
    byokKey: 'sk-secret-must-not-egress',
    byokProvider: 'anthropic',
    codebaseContext: { nearbyFiles: [{ path: 'a.ts', snippet: 'alice@example.com' }] },
  }, { privacyMode: 'privacy_enhanced', dataResidency: 'eu' });
  assert.equal(request.byokKey, undefined);
  assert.match(request.editedCode.diff, /REDACTED_EMAIL/);
  assert.doesNotMatch(request.editedCode.diff, /alice@example.com/);
  assert.equal(privacy.evidenceRedacted, true);
  assert.equal(privacy.dataResidency, 'eu');
});

test('local compliance removes source code and returns aggregated summary', () => {
  const { request, privacy, localSummary } = sanitizeValidateReviewPayload({
    editedCode: {
      diff: '+const patientEmail="john@test.com"\n+logger.info(patientEmail)\n',
      changedFiles: [{ path: 'patientService.ts', status: 'modified', additions: 2, deletions: 0 }],
    },
    codebaseContext: {
      changedFileContents: [{ path: 'patientService.ts', content: 'secret body' }],
      nearbyFiles: [{ path: 'x.ts', snippet: 'code' }],
    },
    byokKey: 'sk-nope',
    complianceFrameworks: ['HIPAA'],
  }, { privacyMode: 'local_compliance', dataResidency: 'local_only' });
  assert.equal(request.editedCode.diff, '');
  assert.equal(request.codebaseContext.changedFileContents.length, 0);
  assert.equal(request.byokKey, undefined);
  assert.ok(localSummary);
  assert.equal(privacy.dataSent, 'Aggregated findings only');
  assert.equal(privacy.evidenceStorage, 'disabled');
  assert.ok(request.localComplianceSummary);
});

test('evidence reference never stores raw email', () => {
  const ref = toEvidenceReference({
    file: 'a.ts',
    line: 3,
    text: 'const email = "phi@hospital.org"',
    classification: 'PHI',
  });
  assert.equal(ref.redacted, true);
  assert.ok(ref.hash);
  assert.equal('snippet' in ref, false);
});

test('local compliance summary counts sensitive classes', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,0 +1,2 @@',
    '+const email = "patient@x.com";',
    '+const key = "sk-abc1234567890123";',
  ].join('\n');
  const summary = buildLocalComplianceSummary({ diff, frameworks: ['HIPAA'] });
  assert.equal(summary.framework, 'HIPAA');
  assert.ok(
    summary.criticalFindings >= 1
    || summary.highFindings >= 1
    || summary.securityStatus === 'blocked'
    || (summary.sensitiveCounts && (summary.sensitiveCounts.EMAIL || summary.sensitiveCounts.SECRET)),
  );
  assert.ok(countSensitiveByClass('a@b.com').EMAIL >= 1);
});

test('settings defaults include privacyMode cloud', () => {
  const settings = resolvePrivacySettings({});
  assert.equal(settings.privacyMode, 'cloud');
  assert.equal(resolvePrivacySettings({ privacyMode: 'local_compliance' }).evidencePersistenceDisabled, true);
});

test('UI and edge wire privacy mode + privacy info section', () => {
  const host = fs.readFileSync(path.join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
  assert.match(host, /name="privacyMode"/);
  assert.match(host, /Local Compliance Mode/);
  assert.match(host, /dataResidency/);
  const js = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(js, /vr-privacy-info/);
  assert.match(js, /Privacy Information/);
  const service = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(service, /sanitizeValidateReviewPayload/);
  assert.match(service, /resolvePrivacySettings/);
  assert.match(service, /runDirectByokReview/);
  assert.match(host, /Local Compliance Mode/);
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.match(edge, /local_compliance/);
  assert.match(edge, /privacy_mode/);
  assert.match(edge, /BYOK keys must not be sent to Tyne cloud/);
  assert.match(edge, /Local on-device assessment/);
  const localEngine = fs.readFileSync(path.join(process.cwd(), 'src/privacy/localIntelligence/localReviewEngine.ts'), 'utf8');
  assert.match(localEngine, /runLocalIntelligence/);
  assert.match(localEngine, /egressSummary/);
});

test('migration adds privacy columns', () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260716210000_privacy_architecture.sql'),
    'utf8',
  );
  assert.match(migration, /privacy_mode/);
  assert.match(migration, /evidence_redacted/);
  assert.match(migration, /data_residency/);
  assert.match(migration, /source_processing_type/);
});
