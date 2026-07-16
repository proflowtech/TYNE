import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLanguageBreakdown, languageFromPath } from '../reviewStats';

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
