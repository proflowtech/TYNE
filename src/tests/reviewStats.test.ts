import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeLanguageBreakdown,
  contributionFromAuthorship,
  languageFromPath,
} from '../reviewStats';

test('languageFromPath maps common extensions', () => {
  assert.equal(languageFromPath('src/foo.ts'), 'TypeScript');
  assert.equal(languageFromPath('src/bar.cpp'), 'C++');
  assert.equal(languageFromPath('supabase/migrations/001.sql'), 'PL/pgSQL');
  assert.equal(languageFromPath('scripts/query.sql'), 'SQL');
});

test('computeLanguageBreakdown is line-weighted', () => {
  const rows = computeLanguageBreakdown([
    { path: 'a.ts', additions: 90 },
    { path: 'b.ts', additions: 10 },
    { path: 'c.sql', additions: 8 },
    { path: 'supabase/migrations/x.sql', additions: 8 },
  ]);
  assert.equal(rows[0].language, 'TypeScript');
  assert.equal(rows[0].percent, 86.2);
  const pl = rows.find(r => r.language === 'PL/pgSQL');
  const sql = rows.find(r => r.language === 'SQL');
  assert.ok(pl);
  assert.ok(sql);
  assert.equal(pl!.percent, 6.9);
  assert.equal(sql!.percent, 6.9);
});

test('contribution ignores product source mentioning Cursor/Claude', () => {
  const rows = contributionFromAuthorship({
    totalLines: 100,
    authorName: 'Dipanjan',
    authorEmail: 'dipanjan@example.com',
    // Would previously false-positive if this were the code diff.
    commitMessage: 'Tighten reviewStats. Does not mention AI tools.',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Dipanjan');
  assert.equal(rows[0].kind, 'human');
  assert.equal(rows[0].percent, 100);
});

test('contribution detects Co-authored-by Cursor trailer only', () => {
  const rows = contributionFromAuthorship({
    totalLines: 100,
    authorName: 'Dipanjan',
    commitMessage: 'Fix connect flow\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n',
  });
  assert.ok(rows.some(r => r.id === 'user' && r.kind === 'human'));
  assert.ok(rows.some(r => r.id === 'cursor' && r.kind === 'ai'));
  assert.ok(!rows.some(r => r.label === 'Claude'));
});

test('bare word cursor in commit subject alone is not enough without trailer/email', () => {
  // Avoid treating "cursor:" CSS or casual wording as authorship — only trailer/generated markers.
  const rows = contributionFromAuthorship({
    totalLines: 40,
    authorName: 'Alice',
    commitMessage: 'Move cursor to end of input',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Alice');
  assert.equal(rows[0].kind, 'human');
});
