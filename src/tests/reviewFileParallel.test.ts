import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_SIZE,
  chunkArray,
  reviewFile,
  reviewFilesInParallel,
} from '../services/reviewFileParallel';
import { hashContent } from '../validateReviewPipeline';

test('chunkArray splits into batches of 5', () => {
  const batches = chunkArray([1, 2, 3, 4, 5, 6, 7], 5);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], [1, 2, 3, 4, 5]);
  assert.deepEqual(batches[1], [6, 7]);
  assert.equal(BATCH_SIZE, 5);
});

test('reviewFile uses cache when hash matches', () => {
  const content = 'export function ok() { return 1; }';
  const hash = hashContent(content);
  const cached = reviewFile('src/a.ts', content, {
    cache: { 'src/a.ts': { hash, findings: [{ id: 'x', title: 'Cached' }], updatedAt: 'now' } },
  });
  assert.equal(cached.cached, true);
  assert.equal(cached.findings.length, 1);
});

test('reviewFilesInParallel processes 15 files in 3 sequential batches', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [`src/f${i}.ts`, `export const v${i} = ${i};`]),
  );
  const start = Date.now();
  const { results } = await reviewFilesInParallel(files, { diffByFile: {} });
  const elapsed = Date.now() - start;
  assert.equal(results.length, 15);
  assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  assert.ok(results.every(r => r.file.startsWith('src/f')));
});

test('reviewFilesInParallel continues when one file throws', async () => {
  const badContent = 'export function bad() { debugger; }';
  const { results } = await reviewFilesInParallel(
    { 'src/good.ts': 'export function good() {}', 'src/bad.ts': badContent },
    { diffByFile: { 'src/bad.ts': '+debugger;' } },
  );
  assert.equal(results.length, 2);
  assert.ok(results.some(r => r.file === 'src/good.ts' && !r.error));
});
