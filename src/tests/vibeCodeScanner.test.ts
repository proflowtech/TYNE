import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scanForAiSlop, scanForAiSlopSync, scanVibeCode } from '../quality/vibeCodeScanner';

const SLOP_TS = `
export function processUser(email: string) {
  // TODO: refactor this later
  console.log('debugging');
  debugger;
  try { work(); } catch (e) {}
  throw new Error("error");
  fetchData();
  setTimeout(work, 86400);
  return "placeholder";
}
async function fetchData() { return 1; }
function orphanHelper() { return 2; }
`;

test('scanForAiSlop detects multiple signal categories', async () => {
  const result = await scanForAiSlop({ 'src/api.ts': SLOP_TS });
  assert.ok(result.todos.length >= 1);
  assert.ok(result.console_logs.length >= 1);
  assert.ok(result.debugger_statements.length >= 1);
  assert.ok(result.empty_catches.length >= 1);
  assert.ok(result.generic_errors.length >= 1);
  assert.ok(result.magic_numbers.some(m => m.value === 86400));
  assert.ok(result.async_issues.some(a => a.type === 'missing_await'));
  assert.ok(result.slop_score > 25);
  assert.match(result.verdict, /slop|risk|review/i);
});

test('slop_score > 50 flags high AI risk', () => {
  const heavy = SLOP_TS + SLOP_TS.replace(/processUser/g, 'processUser2');
  const r = scanForAiSlopSync({ 'src/a.ts': heavy, 'src/b.ts': heavy });
  assert.ok(r.slop_score > 50, `score=${r.slop_score}`);
  assert.equal(r.verdict, 'High AI generation risk - review manually');
});

test('scanVibeCode still works with diff-only input', () => {
  const diff = [
    'diff --git a/src/service.ts b/src/service.ts',
    '--- a/src/service.ts',
    '+++ b/src/service.ts',
    '@@ -1,0 +1,4 @@',
    '+  // TODO: implement',
    '+  try { x(); } catch (e) {}',
    '+  console.log("debug");',
    '+  debugger;',
  ].join('\n');
  const findings = scanVibeCode({ diff, fileFacts: [] });
  assert.ok(findings.some(f => f.category === 'vibe_code'));
  assert.ok(findings.some(f => f.ruleId === 'VIBE_DEBUGGER' || f.ruleId === 'VIBE_EMPTY_CATCH'));
});

test('scanForAiSlop completes under 800ms', async () => {
  const big = Array.from({ length: 80 }, (_, i) =>
    `export function fn${i}() { console.log(${i}); /* TODO fix */ const x = ${1000 + i}; }`,
  ).join('\n');
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, big]));
  const start = Date.now();
  await scanForAiSlop(files);
  assert.ok(Date.now() - start < 800, `took ${Date.now() - start}ms`);
});

test('parameterized clean code stays low slop', async () => {
  const clean = `
export async function getUser(id: string) {
  if (!id) throw new Error('id is required');
  return await db.query('SELECT * FROM users WHERE id = ?', [id]);
}
`;
  const r = await scanForAiSlop({ 'src/user.ts': clean });
  assert.ok(r.slop_score < 25, `score=${r.slop_score}`);
});
