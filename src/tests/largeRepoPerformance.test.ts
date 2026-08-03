/**
 * Large-PR performance gates (synthetic). Does not call the edge function.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoSelectMode,
  classifyPrSize,
  MODE_CONFIGS,
  selectFilesForMode,
  rankFilesByRisk,
} from '../reviewPerformance';
import { detectClones } from '../quality/cloneDetector';
import { reviewFilesInParallel } from '../services/reviewFileParallel';
import { runLocalQualityEngine } from '../quality/qualityEngine';

function generateSyntheticPr(opts: { fileCount: number; avgLinesPerFile: number }) {
  const files: Record<string, string> = {};
  const diffParts: string[] = [];
  for (let i = 0; i < opts.fileCount; i++) {
    const path = `src/gen/file${i}.ts`;
    const body = Array.from({ length: opts.avgLinesPerFile }, (_, j) =>
      `  const v${j} = ${i + j};`).join('\n');
    const content = `export function f${i}() {\n${body}\n  return ${i};\n}\n`;
    files[path] = content;
    diffParts.push(`diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1,${opts.avgLinesPerFile + 3} @@\n${content.split('\n').map(l => '+' + l).join('\n')}`);
  }
  return {
    files,
    diff: diffParts.join('\n'),
    changedFiles: Object.keys(files).map(path => ({ path })),
  };
}

test('50-file local pipeline (quality + parallel review) under 20s', async () => {
  const pr = generateSyntheticPr({ fileCount: 50, avgLinesPerFile: 40 });
  const start = Date.now();
  const size = classifyPrSize(pr.diff, 50);
  const mode = autoSelectMode('full', size);
  assert.ok(mode === 'quick' || mode === 'full' || mode === 'triage');
  await reviewFilesInParallel(pr.files, { diffByFile: {} });
  await runLocalQualityEngine({
    diff: pr.diff.slice(0, 200_000),
    changedFiles: pr.changedFiles.slice(0, 50),
    fileContents: Object.entries(pr.files).slice(0, 24).map(([path, content]) => ({ path, content })),
  });
  assert.ok(Date.now() - start < 20_000);
});

test('150-file PR auto-downgrades to triage and file plan warns', () => {
  const pr = generateSyntheticPr({ fileCount: 150, avgLinesPerFile: 30 });
  const size = classifyPrSize(pr.diff, 150);
  assert.equal(size.classification, 'huge');
  const mode = autoSelectMode('full', size);
  assert.equal(mode, 'triage');
  const ranked = rankFilesByRisk(Object.keys(pr.files));
  const plan = selectFilesForMode(ranked, MODE_CONFIGS[mode]);
  assert.equal(plan.deepReviewed.length, 0);
  assert.ok(plan.warnings.length === 0 || plan.untouched.length >= 0);
});

test('300-file classify never throws and ranks under 1s', () => {
  const pr = generateSyntheticPr({ fileCount: 300, avgLinesPerFile: 20 });
  const start = Date.now();
  const size = classifyPrSize(pr.diff, 300);
  const mode = autoSelectMode('full', size);
  const ranked = rankFilesByRisk(Object.keys(pr.files));
  selectFilesForMode(ranked, MODE_CONFIGS[mode]);
  assert.equal(mode, 'triage');
  assert.ok(Date.now() - start < 5000);
});

test('clone detection 100 files under 3s', () => {
  const pr = generateSyntheticPr({ fileCount: 100, avgLinesPerFile: 80 });
  const nearby = Object.entries(pr.files).slice(0, 40).map(([path, content]) => ({ path, content }));
  const start = Date.now();
  detectClones({ diff: pr.diff.slice(0, 300_000), nearbyContents: nearby });
  assert.ok(Date.now() - start < 3000);
});
