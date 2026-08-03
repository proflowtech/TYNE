import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  autoSelectMode,
  classifyPrSize,
  rankFilesByRisk,
  selectFilesForMode,
  MODE_CONFIGS,
  reviewFilesConcurrently,
  timeStage,
} from '../reviewPerformance';
import { detectClones } from '../quality/cloneDetector';

test('classifyPrSize marks huge PRs', () => {
  const lines = Array.from({ length: 6000 }, () => '+x').join('\n');
  const s = classifyPrSize(lines, 120);
  assert.equal(s.classification, 'huge');
  assert.equal(autoSelectMode('full', s), 'triage');
});

test('classifyPrSize downgrades large full→quick', () => {
  const lines = Array.from({ length: 1600 }, () => '+x').join('\n');
  const s = classifyPrSize(lines, 45);
  assert.equal(s.classification, 'large');
  assert.equal(autoSelectMode('full', s), 'quick');
  assert.equal(autoSelectMode('quick', s), 'quick');
});

test('rankFilesByRisk prioritizes auth over tests', () => {
  const ranked = rankFilesByRisk([
    'src/foo.test.ts',
    'src/auth/login.ts',
    'README.md',
  ]);
  assert.equal(ranked[0].file, 'src/auth/login.ts');
  assert.ok(ranked[ranked.length - 1].file === 'README.md' || ranked.some(r => r.file === 'README.md' && r.score < 0));
});

test('selectFilesForMode caps and warns', () => {
  const ranked = Array.from({ length: 250 }, (_, i) => ({ file: `f${i}.ts`, score: 250 - i, reasons: [] }));
  const plan = selectFilesForMode(ranked, MODE_CONFIGS.quick);
  assert.equal(plan.deepReviewed.length, 15);
  assert.ok(plan.warnings.some(w => w.type === 'files_not_reviewed'));
});

test('reviewFilesConcurrently isolates failures', async () => {
  const results = await reviewFilesConcurrently(
    ['a', 'b', 'c'],
    async (file) => {
      if (file === 'b') throw new Error('boom');
      return { file, ok: true };
    },
    2,
    1000,
  );
  assert.equal(results.length, 3);
  assert.ok(results.some(r => 'error' in r && (r as any).file === 'b'));
});

test('timeStage records duration', async () => {
  const timings: Array<{ stage: string; durationMs: number; inputSize: number }> = [];
  await timeStage(timings, 'demo', 3, async () => {
    await new Promise(r => setTimeout(r, 5));
    return 1;
  });
  assert.equal(timings[0].stage, 'demo');
  assert.ok(timings[0].durationMs >= 0);
});

test('clone detection on 100 synthetic files completes under 3s', () => {
  const nearby = Array.from({ length: 40 }, (_, i) => ({
    path: `src/near${i}.ts`,
    content: `export function near${i}() {\n  const x = ${i};\n  return x + 1;\n}\n`.repeat(20),
  }));
  const shared = 'const sharedBlock = alpha beta gamma delta epsilon zeta eta theta iota kappa;\n'.repeat(8);
  const diff = Array.from({ length: 50 }, (_, i) =>
    `diff --git a/src/c${i}.ts b/src/c${i}.ts\n+++ b/src/c${i}.ts\n@@ -0,0 +1,10 @@\n+${shared}`).join('\n');
  nearby[0] = { path: 'src/near0.ts', content: shared + nearby[0].content };
  const start = Date.now();
  const findings = detectClones({ diff, nearbyContents: nearby });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  assert.ok(Array.isArray(findings));
});

test('review UI shows stage-aware elapsed time and ETA', () => {
  const ui = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(ui, /reviewEtaRange/);
  assert.match(ui, /elapsed/);
  assert.match(ui, /remaining/);
  assert.match(ui, /setInterval\(updateValidateReviewStatus, 1000\)/);
  assert.match(ui, /clearInterval\(validateReviewEtaTimer\)/);
});
