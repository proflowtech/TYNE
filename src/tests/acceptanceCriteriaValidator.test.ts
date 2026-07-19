import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptanceCriteria,
  validateAcceptanceCriteria,
  validateAcceptanceCriteriaSync,
} from '../quality/acceptanceCriteriaValidator';

const TASK = `
Implement login flow

AC1: User can log in with email
AC2: Password is hashed before storage
- AC3: Session persists for 24 hours
`;

const FILES = {
  'src/auth/login.ts': [
    'export async function loginWithEmail(email: string, password: string) {',
    '  const hash = await bcrypt.hash(password, 10);',
    '  await db.users.upsert({ email, passwordHash: hash });',
    '  const session = createSession(email, 86400);',
    '  return session;',
    '}',
  ].join('\n'),
};

test('parseAcceptanceCriteria extracts numbered AC from description', () => {
  const ac = parseAcceptanceCriteria(TASK, []);
  assert.equal(ac.length, 3);
  assert.equal(ac[0].id, 'AC1');
  assert.match(ac[1].text, /hash/i);
});

test('validateAcceptanceCriteriaSync marks implemented AC with evidence', () => {
  const v = validateAcceptanceCriteriaSync(TASK, [], '', FILES);
  assert.equal(v.criteria.length, 3);
  assert.ok(v.criteria.filter(c => c.status === 'implemented').length >= 2);
  assert.ok(v.coverage_score >= 0.66);
  const login = v.criteria.find(c => c.id === 'AC1');
  assert.ok((login?.evidence.lines.length ?? 0) >= 1);
  assert.equal(login?.evidence.file, 'src/auth/login.ts');
});

test('validateAcceptanceCriteriaSync detects missing AC', () => {
  const v = validateAcceptanceCriteriaSync(
    'AC1: Export audit log to S3',
    [],
    '',
    { 'src/ui/button.tsx': 'export function SaveButton() { return null; }' },
  );
  assert.equal(v.criteria[0].status, 'missing');
  assert.equal(v.verdict, 'partial_ac_met');
  assert.ok(v.missing_criteria.length >= 1);
});

test('validateAcceptanceCriteria merges explicit array', async () => {
  const v = await validateAcceptanceCriteria(
    '',
    ['AC1: User can log in with email'],
    '',
    FILES,
  );
  assert.equal(v.criteria.length, 1);
  assert.equal(v.criteria[0].status, 'implemented');
  assert.equal(v.verdict, 'all_ac_met');
});

test('validateAcceptanceCriteria completes under 5s', async () => {
  const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
    `src/f${i}.ts`,
    Array.from({ length: 200 }, () => 'const x = 1;').join('\n'),
  ]));
  const start = Date.now();
  await validateAcceptanceCriteria(TASK, [], '+added', { ...FILES, ...big });
  assert.ok(Date.now() - start < 5000);
});

test('extra deliverables detected when unrelated symbols added', () => {
  const v = validateAcceptanceCriteriaSync(
    'AC1: Login with email',
    [],
    '+export function DarkModeWidget() {}',
    { 'src/theme.ts': 'export function DarkModeWidget() { return null; }' },
  );
  assert.ok(v.extra_deliverables.some(x => /DarkMode/i.test(x)));
});
