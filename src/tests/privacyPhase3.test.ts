import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { allowsByokRelayToBackend } from '../privacy/privacyModeService';
import {
  effectivePrivacyMode,
  resolveValidateReviewFunctionUrl,
} from '../privacy/residencyRouter';
import { sanitizeValidateReviewPayload } from '../privacy/payloadSanitizer';

test('BYOK is never relayed to backend', () => {
  assert.equal(allowsByokRelayToBackend('cloud'), false);
  assert.equal(allowsByokRelayToBackend('privacy_enhanced'), false);
  assert.equal(allowsByokRelayToBackend('local_compliance'), false);
});

test('local_only residency forces local_compliance effective mode', () => {
  assert.equal(effectivePrivacyMode('cloud', 'local_only'), 'local_compliance');
  assert.equal(effectivePrivacyMode('privacy_enhanced', 'us'), 'privacy_enhanced');
});

test('residency router picks EU and enterprise endpoints', () => {
  const us = resolveValidateReviewFunctionUrl('us', {
    supabaseUrl: 'https://us.example.supabase.co',
  });
  assert.equal(us, 'https://us.example.supabase.co/functions/v1/tyne-validate-review');

  const eu = resolveValidateReviewFunctionUrl('eu', {
    supabaseUrl: 'https://us.example.supabase.co',
    supabaseUrlEu: 'https://eu.example.supabase.co',
  });
  assert.equal(eu, 'https://eu.example.supabase.co/functions/v1/tyne-validate-review');

  const ent = resolveValidateReviewFunctionUrl('enterprise_managed', {
    supabaseUrl: 'https://us.example.supabase.co',
    enterpriseEndpoint: 'https://tyne.corp.example/functions/v1',
  });
  assert.equal(ent, 'https://tyne.corp.example/functions/v1/tyne-validate-review');
});

test('direct BYOK attaches clientAiReview and strips keys', () => {
  const { request, privacy } = sanitizeValidateReviewPayload({
    editedCode: { diff: 'const x = 1', changedFiles: [] },
    byokKey: 'sk-should-never-egress',
    byokProvider: 'openai',
  }, {
    privacyMode: 'cloud',
    dataResidency: 'us',
    clientAiReview: { status: 'passed', score: 90, summary: 'ok', findings: [], completedGoals: [], pendingGoals: [], missingTests: [], nextActions: [], riskLevel: 'low', vibeCodeRisk: 'low' },
    llmExecutionPath: 'direct_byok',
    byokModel: 'gpt-4o-mini',
    byokProviderName: 'openai',
  });
  assert.equal(request.byokKey, undefined);
  assert.ok(request.clientAiReview);
  assert.equal(privacy.llmExecutionPath, 'direct_byok');
  assert.equal(privacy.byokDirect, true);
  assert.doesNotMatch(JSON.stringify(request), /sk-should-never-egress/);
});

test('edge rejects BYOK keys and accepts clientAiReview path', () => {
  const edge = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'),
    'utf8',
  );
  assert.match(edge, /BYOK keys must not be sent to Tyne cloud/);
  assert.match(edge, /clientAiReview/);
  assert.match(edge, /llm_execution_path/);
  assert.match(edge, /direct_byok/);
});

test('phase 3 migration adds llm_execution_path', () => {
  const migration = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260716220000_privacy_phase3_direct_byok.sql'),
    'utf8',
  );
  assert.match(migration, /llm_execution_path/);
  assert.match(migration, /byok_direct/);
});

test('extension wires direct BYOK + residency router', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(service, /runDirectByokReview/);
  assert.match(service, /resolveValidateReviewFunctionUrl/);
  assert.match(service, /effectivePrivacyMode/);
  const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
  assert.match(pkg, /supabaseUrlEu/);
  assert.match(pkg, /enterpriseValidateReviewUrl/);
});
