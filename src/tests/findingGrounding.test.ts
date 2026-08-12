import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimsMassDeletion,
  groundReviewFindings,
  isAllowedSyntheticPath,
  isLocatableFindingPath,
  isSyntheticFindingPath,
} from '../services/findingGrounding';
import { buildAgentPrompt, classifyFindingAction } from '../actionEngine';
import { postProcessReviewFindings } from '../services/findingsMerger';
import type { TyneValidateReviewFinding } from '../validateReviewTypes';

test('synthetic paths: (project root) rejected, (scope) allowed', () => {
  assert.equal(isSyntheticFindingPath('(project root)'), true);
  assert.equal(isLocatableFindingPath('(project root)'), false);
  assert.equal(isAllowedSyntheticPath('(project root)'), false);
  assert.equal(isAllowedSyntheticPath('(scope)'), true);
  assert.equal(isLocatableFindingPath('src/a.ts'), true);
});

test('claimsMassDeletion detects infrastructure wipe narratives', () => {
  assert.equal(claimsMassDeletion({
    title: 'Complete removal of project infrastructure without replacement',
    explanation: 'All essential project files have been deleted: .gitignore, README.md, bun.lockb, eslint.config.js, index.html, and package-lock.json.',
  }), true);
  assert.equal(claimsMassDeletion({
    title: 'Missing null check',
    explanation: 'Handle undefined user id.',
  }), false);
});

test('groundReviewFindings drops (project root) and ungrounded deletion claims', () => {
  const changed = [{ path: 'src/auth.ts', status: 'modified' }];
  const out = groundReviewFindings([
    {
      file: '(project root)',
      title: 'Complete removal of project infrastructure without replacement',
      explanation: 'Deleted .gitignore, README.md, bun.lockb, eslint.config.js, index.html, package-lock.json.',
      source: 'llm',
      severity: 'critical',
    },
    {
      file: 'README.md',
      title: 'README deleted without replacement',
      explanation: 'README.md was deleted from the repo.',
      source: 'llm',
      severity: 'critical',
    },
    {
      file: 'src/auth.ts',
      title: 'Null check',
      explanation: 'Handle undefined.',
      source: 'llm',
      severity: 'medium',
    },
    {
      file: '(scope)',
      title: 'Scope drift: extra setting',
      explanation: 'Out of ticket scope.',
      source: 'llm',
      severity: 'high',
    },
  ], changed);

  assert.equal(out.some(f => f.file === '(project root)'), false);
  assert.equal(out.some(f => /infrastructure|README deleted/i.test(f.title || '')), false);
  assert.equal(out.some(f => f.file === 'src/auth.ts'), true);
  assert.equal(out.some(f => f.file === '(scope)'), true);
});

test('groundReviewFindings keeps deletion claim only when path is deleted in diff', () => {
  const out = groundReviewFindings([{
    file: 'README.md',
    title: 'README deleted without replacement',
    explanation: 'README.md was deleted from the repo.',
    source: 'llm',
  }], [{ path: 'README.md', status: 'deleted' }]);
  assert.equal(out.length, 1);
});

test('buildAgentPrompt never emits :? or Open (project root) at line ?', () => {
  const prompt = buildAgentPrompt({
    file: '(project root)',
    title: 'Complete removal of project infrastructure without replacement',
    explanation: 'Files deleted.',
    category: 'pm_alignment',
    remediation: 'Do not merge.',
  });
  assert.doesNotMatch(prompt, /:\?/);
  assert.doesNotMatch(prompt, /Open `\(?project root\)?` at line \?/);
  assert.doesNotMatch(prompt, /File: `\(project root\):\?`/);
  assert.match(prompt, /not pinned to a concrete file/i);
  assert.match(prompt, /do not invent paths|Do not create or delete project infrastructure/i);

  const classified = classifyFindingAction({
    file: '(project root)',
    title: 'Infra wipe',
    category: 'pm_alignment',
  });
  assert.equal(classified.actionClass, 'guidance');
});

test('groundReviewFindings keeps local secret blocking confidence off-path', () => {
  const out = groundReviewFindings([{
    file: 'vendor/leaked.ts',
    title: 'Hardcoded secret',
    explanation: 'API key',
    severity: 'critical',
    category: 'security',
    confidence: 'high',
    blocking: true,
    source: 'local_engine',
    detectedBy: 'secret_scanner',
  }], [{ path: 'src/app.ts', status: 'modified' }]);
  assert.equal(out.length, 1);
  assert.notEqual(out[0].confidence, 'low');
});

test('postProcessReviewFindings grounds against changedFiles', () => {
  const findings: TyneValidateReviewFinding[] = [{
    id: 'bad',
    file: '(project root)',
    severity: 'critical',
    category: 'pm_alignment',
    title: 'Complete removal of project infrastructure without replacement',
    explanation: 'Deleted .gitignore, README.md, bun.lockb, eslint.config.js, index.html, package-lock.json.',
    confidence: 'high',
    source: 'llm',
  }, {
    id: 'ok',
    file: 'src/a.ts',
    line: 2,
    severity: 'medium',
    category: 'correctness',
    title: 'Null check',
    explanation: 'Handle undefined.',
    confidence: 'medium',
    source: 'llm',
  }];
  const out = postProcessReviewFindings(findings, {
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
  });
  assert.equal(out.some(f => f.id === 'bad'), false);
  assert.equal(out.some(f => f.id === 'ok'), true);
});
