import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';

import {
  packDiffByFiles,
  partitionPacksByCache,
  hashContent,
  buildFileReviewCache,
  groupFindingsByFile,
  rotateConfigsForPack,
} from '../validateReviewPipeline';

function expandPreferenceHintsLocal(hints: string[], catalog: string[]): string[] {
  const matched: string[] = [];
  for (const hint of hints) {
    const exact = catalog.find(id => id === hint);
    if (exact) {
      matched.push(exact);
      continue;
    }
    const needle = hint.toLowerCase();
    for (const id of catalog) {
      if (id.toLowerCase().includes(needle)) matched.push(id);
    }
  }
  return [...new Set(matched)];
}

function buildCatalogAwareCandidatesNode(
  feature: 'validate_review_chunk' | 'validate_review_final',
  tier: 'free' | 'pro' | 'max',
  catalog: string[],
): string[] {
  const hints =
    feature === 'validate_review_chunk'
      ? (tier === 'free'
        ? ['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash']
        : ['deepseek/deepseek-v4-pro', 'kimi/kimi-code', 'google/gemini-2.5-flash'])
      : (tier === 'max'
        ? ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro']
        : []);
  const preferred = expandPreferenceHintsLocal(hints, catalog);
  const rest = catalog.slice().sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...preferred, ...rest]) {
    if (!catalog.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (feature === 'validate_review_final' && tier !== 'max') return [];
  return out;
}

test('packDiffByFiles covers all files instead of prefix truncation', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-oldA',
    '+newA',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-oldB',
    '+newB',
    'diff --git a/src/c.ts b/src/c.ts',
    '--- a/src/c.ts',
    '+++ b/src/c.ts',
    '@@ -1 +1 @@',
    '-oldC',
    '+newC',
    'diff --git a/src/d.ts b/src/d.ts',
    '--- a/src/d.ts',
    '+++ b/src/d.ts',
    '@@ -1 +1 @@',
    '-oldD',
    '+newD',
  ].join('\n');

  const packs = packDiffByFiles(diff, { maxFilesPerPack: 2, maxCharsPerPack: 50_000 });
  assert.ok(packs.length >= 2, 'must create multiple packs');
  const files = packs.flatMap(p => p.files).sort();
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
});

test('partitionPacksByCache skips unchanged file packs', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '+a',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '+b',
  ].join('\n');
  const packs = packDiffByFiles(diff, { maxFilesPerPack: 1 });
  assert.equal(packs.length, 2);
  const aHash = packs[0].contentHashes['src/a.ts'];
  const cache = {
    'src/a.ts': { hash: aHash, findings: [{ id: 'cached', file: 'src/a.ts', title: 'Cached' }] },
  };
  const { cachedFindings, freshPacks } = partitionPacksByCache(packs, cache);
  assert.equal(cachedFindings.length, 1);
  assert.equal(freshPacks.length, 1);
  assert.deepEqual(freshPacks[0].files, ['src/b.ts']);
});

test('buildFileReviewCache stores hashes for re-review', () => {
  const packs = packDiffByFiles('diff --git a/f.ts b/f.ts\n+++ b/f.ts\n+x\n', { maxFilesPerPack: 1 });
  const cache = buildFileReviewCache(packs, groupFindingsByFile([{ file: 'f.ts', title: 't' }]));
  assert.equal(cache['f.ts'].hash, packs[0].contentHashes['f.ts']);
  assert.equal(cache['f.ts'].findings.length, 1);
  assert.equal(hashContent(packs[0].diff), packs[0].contentHashes['f.ts']);
});

test('catalog-aware candidates include full live catalog after preferences', () => {
  const catalog = [
    'google/gemini-2.5-pro',
    'deepseek/deepseek-v4-pro',
    'kimi/kimi-code',
    'mistralai/mistral-large',
    'nvidia/llama-3.1',
    'z-ai/glm-4',
    'some-new/frontier-model',
  ];
  const chunk = buildCatalogAwareCandidatesNode('validate_review_chunk', 'pro', catalog);
  assert.ok(chunk.includes('deepseek/deepseek-v4-pro'));
  assert.ok(chunk.includes('some-new/frontier-model'), 'new catalog models must be eligible');
  const finalPro = buildCatalogAwareCandidatesNode('validate_review_final', 'pro', catalog);
  assert.deepEqual(finalPro, []);
  const finalMax = buildCatalogAwareCandidatesNode('validate_review_final', 'max', catalog);
  assert.ok(finalMax.includes('google/gemini-2.5-pro'));
});

test('rotateConfigsForPack round-robins models', () => {
  const configs = [{ model: 'a' }, { model: 'b' }, { model: 'c' }];
  assert.deepEqual(rotateConfigsForPack(configs, 0, 2).map(c => c.model), ['a', 'b']);
  assert.deepEqual(rotateConfigsForPack(configs, 1, 2).map(c => c.model), ['b', 'c']);
  assert.deepEqual(rotateConfigsForPack(configs, 2, 2).map(c => c.model), ['c', 'a']);
});

test('shared policy and pipeline files are wired', () => {
  const policy = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/_shared/aicreditsModelPolicy.ts'), 'utf8');
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.ok(policy.includes('validate_review_chunk') && policy.includes('buildCatalogAwareCandidates'));
  assert.ok(edge.includes('runChunkedManagedReview') && edge.includes('fileCache'));
  assert.ok(edge.includes('loadPriorFileCache'));
});
