import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumstat, mergeNumstat, normalizeNumstatPath } from '../numstat';
import { ChangedFileInfo } from '../validateReviewTypes';

/**
 * The previous implementation scraped `git --stat` for `/(\d+) insertion/` — a
 * pattern that only appears in git's trailing summary line, never on a per-file
 * row — then assigned the results to files by array index. These tests pin the
 * two properties that were broken: counts come from numstat, and they are
 * matched to files by path.
 */

const file = (path: string): ChangedFileInfo => ({
  path,
  status: 'modified',
  additions: 0,
  deletions: 0,
});

test('parseNumstat reads per-file additions and deletions', () => {
  const entries = parseNumstat('12\t4\tsrc/a.ts\n0\t9\tsrc/b.ts\n');
  assert.deepEqual(entries, [
    { path: 'src/a.ts', additions: 12, deletions: 4, binary: false },
    { path: 'src/b.ts', additions: 0, deletions: 9, binary: false },
  ]);
});

test('parseNumstat records binary files as 0/0 rather than NaN', () => {
  const [entry] = parseNumstat('-\t-\tmedia/logo.png\n');
  assert.equal(entry.binary, true);
  assert.equal(entry.additions, 0);
  assert.equal(entry.deletions, 0);
});

test('parseNumstat ignores the summary line the old scraper matched', () => {
  // This is the exact shape that made every per-file count wrong.
  const entries = parseNumstat('3 files changed, 45 insertions(+), 12 deletions(-)\n8\t2\tsrc/a.ts\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'src/a.ts');
  assert.equal(entries[0].additions, 8);
});

test('parseNumstat tolerates CRLF and blank lines', () => {
  const entries = parseNumstat('\r\n5\t1\tsrc/a.ts\r\n\r\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].additions, 5);
});

test('normalizeNumstatPath keeps the destination of both rename spellings', () => {
  assert.equal(normalizeNumstatPath('src/{old => new}/file.ts'), 'src/new/file.ts');
  assert.equal(normalizeNumstatPath('old.ts => new.ts'), 'new.ts');
  assert.equal(normalizeNumstatPath('src/{ => nested}/file.ts'), 'src/nested/file.ts');
});

test('normalizeNumstatPath collapses the slash left by an emptied segment', () => {
  assert.equal(normalizeNumstatPath('src/{old => }/file.ts'), 'src/file.ts');
});

test('mergeNumstat matches by path, not by array position', () => {
  // Deliberately mismatched ordering — index-based merging would swap these.
  const merged = mergeNumstat(
    [file('src/b.ts'), file('src/a.ts')],
    parseNumstat('12\t4\tsrc/a.ts\n0\t9\tsrc/b.ts\n'),
  );
  const byPath = Object.fromEntries(merged.map(f => [f.path, f]));
  assert.equal(byPath['src/a.ts'].additions, 12);
  assert.equal(byPath['src/a.ts'].deletions, 4);
  assert.equal(byPath['src/b.ts'].additions, 0);
  assert.equal(byPath['src/b.ts'].deletions, 9);
});

test('mergeNumstat leaves a file with no numstat row at 0/0', () => {
  const merged = mergeNumstat([file('src/a.ts'), file('src/untouched.ts')], parseNumstat('7\t1\tsrc/a.ts\n'));
  assert.equal(merged[1].additions, 0, 'must not inherit a neighbour count');
  assert.equal(merged[1].deletions, 0);
});

test('mergeNumstat preserves the file status', () => {
  const merged = mergeNumstat(
    [{ path: 'src/a.ts', status: 'added', additions: 0, deletions: 0 }],
    parseNumstat('7\t0\tsrc/a.ts\n'),
  );
  assert.equal(merged[0].status, 'added');
  assert.equal(merged[0].additions, 7);
});

test('mergeNumstat lines a renamed file up with its status entry', () => {
  const merged = mergeNumstat(
    [{ path: 'src/new/file.ts', status: 'renamed', additions: 0, deletions: 0 }],
    parseNumstat('3\t2\tsrc/{old => new}/file.ts\n'),
  );
  assert.equal(merged[0].additions, 3);
  assert.equal(merged[0].deletions, 2);
});
