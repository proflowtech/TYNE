import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBlamePorcelain,
  collectPriorContext,
  formatPriorContext,
  type PriorLineCommit,
  type PriorChangeEntry,
} from '../quality/priorContext';

/**
 * Phase B: "why was this code written this way" — prior commits that
 * touched the exact lines the current diff touches, not "this file was
 * edited recently" noise.
 *
 * `parseBlamePorcelain` is tested against real `git blame --porcelain`
 * output shape rather than a simplified stand-in, since the parser's whole
 * job is surviving that format's quirks (compact repeats, the all-zero
 * uncommitted hash, embedded tabs in content lines).
 */

// ── Fixtures: real `git blame HEAD -L x,y --porcelain` shape ───────────────

const HASH_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
const HASH_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5';
const ZERO_HASH = '0'.repeat(40);

// Guard the fixtures themselves — a malformed hash would make every test
// below fail for a reason that has nothing to do with the parser.
assert.equal(HASH_A.length, 40);
assert.equal(HASH_B.length, 40);
assert.notEqual(HASH_A, HASH_B);

function porcelainBlock(hash: string, origLine: number, finalLine: number, opts: {
  author: string; time: number; summary: string; content: string;
}): string {
  return [
    `${hash} ${origLine} ${finalLine} 1`,
    `author ${opts.author}`,
    `author-mail <${opts.author}@example.com>`,
    `author-time ${opts.time}`,
    `author-tz +0000`,
    `committer ${opts.author}`,
    `committer-mail <${opts.author}@example.com>`,
    `committer-time ${opts.time}`,
    `committer-tz +0000`,
    `summary ${opts.summary}`,
    `filename src/example.ts`,
    `\t${opts.content}`,
  ].join('\n');
}

/** Later lines from an already-seen commit are compact: hash line + content only. */
function compactLine(hash: string, origLine: number, finalLine: number, content: string): string {
  return `${hash} ${origLine} ${finalLine}\n\t${content}`;
}

test('parseBlamePorcelain extracts one commit per hash from a full block', () => {
  const raw = porcelainBlock(HASH_A, 10, 10, {
    author: 'Priya', time: 1700000000, summary: 'Add retry guard for flaky uploads', content: 'if (!attempt) return;',
  });
  const commits = parseBlamePorcelain(raw);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].hash, HASH_A.slice(0, 7));
  assert.equal(commits[0].author, 'Priya');
  assert.equal(commits[0].subject, 'Add retry guard for flaky uploads');
  assert.equal(commits[0].date, '2023-11-14');
});

test('parseBlamePorcelain dedupes a commit spanning multiple blamed lines', () => {
  const raw = [
    porcelainBlock(HASH_A, 10, 10, { author: 'Priya', time: 1700000000, summary: 'Add retry guard', content: 'line one' }),
    compactLine(HASH_A, 11, 11, 'line two'),
    compactLine(HASH_A, 12, 12, 'line three'),
  ].join('\n');
  const commits = parseBlamePorcelain(raw);
  assert.equal(commits.length, 1, 'three lines from one commit must collapse to one entry');
});

test('parseBlamePorcelain returns multiple commits in first-seen order', () => {
  const raw = [
    porcelainBlock(HASH_A, 10, 10, { author: 'Priya', time: 1700000000, summary: 'First commit', content: 'a' }),
    porcelainBlock(HASH_B, 11, 11, { author: 'Devon', time: 1710000000, summary: 'Second commit', content: 'b' }),
    compactLine(HASH_A, 12, 12, 'c'),
  ].join('\n');
  const commits = parseBlamePorcelain(raw);
  assert.deepEqual(commits.map(c => c.subject), ['First commit', 'Second commit']);
});

test('parseBlamePorcelain drops the all-zero uncommitted-line hash', () => {
  const raw = [
    `${ZERO_HASH} 1 1 1`,
    'author Not Committed Yet',
    'author-time 1700000000',
    'summary ',
    '\tuncommitted line',
  ].join('\n');
  assert.deepEqual(parseBlamePorcelain(raw), []);
});

test('parseBlamePorcelain tolerates empty and garbage input', () => {
  assert.deepEqual(parseBlamePorcelain(''), []);
  assert.deepEqual(parseBlamePorcelain('not blame output at all\njust noise'), []);
});

test('parseBlamePorcelain truncates an overlong subject rather than blowing up the prompt', () => {
  const raw = porcelainBlock(HASH_A, 1, 1, {
    author: 'Priya', time: 1700000000, summary: 'x'.repeat(500), content: 'line',
  });
  const commits = parseBlamePorcelain(raw);
  assert.ok(commits[0].subject.length <= 200);
});

// ── collectPriorContext: orchestration over an injected fetcher ────────────

const DIFF_TWO_FILES = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -8,0 +9,2 @@',
  '+line nine',
  '+line ten',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -0,0 +20,1 @@',
  '+line twenty',
].join('\n');

function fakeCommit(subject: string, hash = 'abc1234'): PriorLineCommit {
  return { hash, date: '2024-01-01', author: 'Someone', subject };
}

test('collectPriorContext queries only files the diff actually touched', async () => {
  const calls: Array<{ file: string; start: number; end: number }> = [];
  await collectPriorContext(['src/a.ts', 'src/b.ts', 'src/untouched.ts'], DIFF_TWO_FILES, async (file, start, end) => {
    calls.push({ file, start, end });
    return [];
  });
  assert.ok(calls.every(c => c.file !== 'src/untouched.ts'), 'a file absent from the diff must never be blamed');
  assert.ok(calls.some(c => c.file === 'src/a.ts'));
  assert.ok(calls.some(c => c.file === 'src/b.ts'));
});

test('collectPriorContext passes the exact changed line range through', async () => {
  const calls: Array<{ file: string; start: number; end: number }> = [];
  await collectPriorContext(['src/a.ts'], DIFF_TWO_FILES, async (file, start, end) => {
    calls.push({ file, start, end });
    return [];
  });
  assert.deepEqual(calls[0], { file: 'src/a.ts', start: 9, end: 10 });
});

test('collectPriorContext dedupes the same commit across multiple ranges in one file', async () => {
  const dupeCommit = fakeCommit('Shared refactor', 'dupe111');
  const result = await collectPriorContext(['src/a.ts'], DIFF_TWO_FILES, async () => [dupeCommit]);
  const hashes = result.map(r => r.hash);
  assert.equal(new Set(hashes).size, hashes.length, 'the same commit must not appear twice for one file');
});

test('collectPriorContext caps commits per file so one hunk cannot dominate', async () => {
  const many = [fakeCommit('one', 'h0000001'), fakeCommit('two', 'h0000002'), fakeCommit('three', 'h0000003')];
  const result = await collectPriorContext(['src/a.ts'], DIFF_TWO_FILES, async () => many);
  const forA = result.filter(r => r.file === 'src/a.ts');
  assert.ok(forA.length <= 2, `expected the per-file cap to hold, got ${forA.length}`);
});

test('collectPriorContext degrades to empty when a file has no prior history', async () => {
  const result = await collectPriorContext(['src/a.ts'], DIFF_TWO_FILES, async () => []);
  assert.deepEqual(result, []);
});

test('collectPriorContext never fails the caller when the fetcher throws', async () => {
  const result = await collectPriorContext(['src/a.ts'], DIFF_TWO_FILES, async () => {
    throw new Error('git blame failed');
  });
  assert.deepEqual(result, [], 'one failing range must degrade silently, not throw');
});

test('collectPriorContext returns nothing for a file the diff never touched at all', async () => {
  const result = await collectPriorContext(['src/nowhere.ts'], DIFF_TWO_FILES, async () => [fakeCommit('should not appear')]);
  assert.deepEqual(result, []);
});

// ── formatPriorContext ──────────────────────────────────────────────────────

test('formatPriorContext renders one bullet per entry with file, subject, author, date, hash', () => {
  const entries: PriorChangeEntry[] = [
    { file: 'src/a.ts', hash: 'abc1234', date: '2024-03-01', author: 'Priya', subject: 'Add retry guard' },
  ];
  const text = formatPriorContext(entries);
  assert.equal(text, '- src/a.ts: "Add retry guard" (Priya, 2024-03-01, abc1234)');
});

test('formatPriorContext returns empty string for no entries, not "None" or a header', () => {
  // The caller (edge function) supplies its own "None" fallback — this
  // function's job is just formatting, so it must not bake in presentation.
  assert.equal(formatPriorContext([]), '');
});
