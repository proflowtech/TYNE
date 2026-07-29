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

test('direct BYOK user prompt includes Golden Contract AC and goal', async () => {
  const { buildDirectByokUserPromptForTest } = await import('../privacy/directByokReview');
  const prompt = buildDirectByokUserPromptForTest({
    provider: 'openai',
    apiKey: 'sk-test',
    diff: '+console.log("hi")',
    changedFiles: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
    pmTask: {
      source: 'jira',
      issueIdentifier: 'PROJ-42',
      title: 'Add login rate limit',
      goal: 'Throttle failed logins',
      description: 'Users must be locked out after 5 failures',
      acceptanceCriteria: ['Lock after 5 failures', 'Show retry-after header'],
      constraints: ['Do not change auth provider'],
    },
  });
  assert.match(prompt, /Golden Contract/);
  assert.match(prompt, /Lock after 5 failures/);
  assert.match(prompt, /Show retry-after header/);
  assert.match(prompt, /Throttle failed logins/);
  assert.match(prompt, /Do not change auth provider/);
  assert.match(prompt, /PROJ-42/);
  assert.doesNotMatch(prompt, /^PM task: Add login rate limit$/m);
});

test('Core skips Direct BYOK so managed Gemini runs the Pro-parity pipeline', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(service, /normalizedTier !== 'free'/);
  assert.match(service, /Core's 5 managed validations must use Tyne Gemini/);
});

test('Validate & Review optionally binds Jira/Linear task', () => {
  const sidebar = fs.readFileSync(path.join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
    + '\n' + fs.readFileSync(path.join(process.cwd(), 'src/sidebar/validateReviewController.ts'), 'utf8');
  assert.doesNotMatch(sidebar, /Select a Jira or Linear task before Validate & Review/);
  assert.doesNotMatch(sidebar, /Enrich the task \(or add AC on Jira\/Linear\) before Validate & Review/);
  assert.match(sidebar, /const isPmTask/);
  assert.match(sidebar, /pmCtx\?\.summary/);
  const service = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(service, /pmTask:\s*pmTask/);
  assert.doesNotMatch(service, /pmTitle:\s*pmTask\?\.title/);
});

test('edge always binds PM Golden Contract and runs scope drift after Direct BYOK', () => {
  const edge = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'),
    'utf8',
  );
  assert.match(edge, /Always bind the Golden Contract when a PM task is present/);
  assert.match(edge, /BYOK scope drift failed/);
  assert.doesNotMatch(edge, /if \(pmTask && policy\.pmAlignmentEnabled\)/);
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
