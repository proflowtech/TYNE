import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyReviewPrecisionGate,
  dependencyManifestHasPackageDelta,
  scopeAdditionDisposition,
} from '../reviewPrecisionHarness';

test('package script edits are not treated as dependency vulnerabilities', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -8,3 +8,4 @@',
    '   "scripts": {',
    '-    "test": "vitest"',
    '+    "test": "npm run build",',
    '+    "lint": "eslint ."',
    '   }',
  ].join('\n');
  assert.equal(dependencyManifestHasPackageDelta(diff, 'package.json'), false);
});

test('real package and lockfile deltas remain visible to dependency scanners', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -10,3 +10,3 @@',
    '   "dependencies": {',
    '-    "zod": "3.22.0"',
    '+    "zod": "3.23.0"',
    '   }',
  ].join('\n');
  assert.equal(dependencyManifestHasPackageDelta(diff, 'package.json'), true);
  assert.equal(dependencyManifestHasPackageDelta('+lockfileVersion: 9\n+packages:\n+  zod: 3.23.0', 'pnpm-lock.yaml'), true);
});

test('scope disposition rejects benign docs and requirement gaps but keeps material features', () => {
  assert.equal(scopeAdditionDisposition('Added information about npm run lint to README.md'), 'benign_adjacent');
  assert.equal(
    scopeAdditionDisposition('README description does not explain the required dummy validation purpose'),
    'requirement_gap',
  );
  assert.equal(scopeAdditionDisposition('Added a public newsletter signup endpoint and subscriber table'), 'candidate');
});

test('Tyne README regression collapses duplicates and removes review-only dependency noise', () => {
  const findings = [
    {
      id: 'logic-1', file: 'package.json', line: 11, category: 'correctness', severity: 'high',
      title: 'Test script runs build instead of tests, giving false CI success',
    },
    {
      id: 'logic-2', file: 'package.json', line: 11, category: 'correctness', severity: 'high',
      title: 'Test script runs build instead of tests, giving false CI success',
    },
    {
      id: 'drift', file: '(scope)', category: 'pm_alignment', severity: 'high',
      title: "Scope drift: Added project purpose description for Healistry to README.md but does not explain dummy project purpose for Tyne workflow validation",
    },
    {
      id: 'ac', file: 'README.md', category: 'pm_alignment', severity: 'high', confidence: 'high',
      title: 'README presents project as production app without clarifying dummy validation purpose',
    },
    {
      id: 'dep', ruleId: 'SEC_DEPENDENCY_DELTA_REVIEW', file: 'package.json', category: 'dependency', severity: 'medium',
      title: 'Dependency manifest changed and needs supply-chain review',
    },
  ];
  const result = applyReviewPrecisionGate(findings);
  assert.deepEqual(result.findings.map(f => f.id).sort(), ['ac', 'logic-1']);
  assert.equal(result.stats.exactDuplicatesRemoved, 1);
  assert.equal(result.stats.semanticDuplicatesRemoved, 1);
  assert.equal(result.stats.nonActionableRemoved, 1);
});

test('precision gate preserves distinct enterprise security findings', () => {
  const result = applyReviewPrecisionGate([
    { id: 's1', file: 'api.ts', line: 10, category: 'security', title: 'SQL injection reaches query sink' },
    { id: 's2', file: 'api.ts', line: 12, category: 'security', title: 'Authorization check missing for tenant record' },
  ]);
  assert.equal(result.findings.length, 2);
});

test('same finding from different analyzers is merged without weakening severity', () => {
  const result = applyReviewPrecisionGate([
    {
      id: 'llm', ruleId: 'LLM_AUTH', file: 'api.ts', line: 10, category: 'security', severity: 'medium',
      title: 'Authorization check missing for tenant record', explanation: 'Model explanation',
    },
    {
      id: 'ast', ruleId: 'AST_TENANT_AUTH', file: 'api.ts', line: 10, category: 'security', severity: 'high',
      title: 'Authorization check missing for tenant record', detectedBy: 'ast_rule', blocking: true, evidence: 'route reaches tenant lookup',
    },
  ]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, 'ast');
  assert.equal(result.findings[0].severity, 'high');
  assert.equal(result.findings[0].blocking, true);
  assert.equal(result.stats.exactDuplicatesRemoved, 1);
});

test('production edge imports the same precision harness and exposes precision telemetry', () => {
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  const localHarness = fs.readFileSync(path.join(process.cwd(), 'src/reviewPrecisionHarness.ts'), 'utf8')
    .replace("from './reviewPrecisionHarness';", "from './reviewPrecisionHarness.ts';");
  const edgeHarness = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/_shared/reviewPrecisionHarness.ts'), 'utf8');
  assert.equal(edgeHarness, localHarness, 'local and edge precision policies must stay byte-for-byte aligned');
  assert.match(edge, /applyReviewPrecisionGate/);
  assert.match(edge, /precisionGate: precision\.stats/);
  assert.match(edge, /result\.securityFindings = result\.findings\.filter/);
  assert.match(edge, /result\.securityStatus = survivingSecurityBlock/);
  assert.match(edge, /result\.complianceStatus = complianceChecksEnabled/);
  assert.doesNotMatch(edge, /title: 'Dependency manifest changed and needs supply-chain review'/);
});
