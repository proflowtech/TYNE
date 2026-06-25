import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSynthesizedCommit, callManagedCommitSynthesis } from '../commitSynthesisUtils';

const EXAMPLE_SUBTASKS = ['Add auth middleware', 'Wire up login route'];

test('parseSynthesizedCommit parses valid JSON response', () => {
  const raw = JSON.stringify({ type: 'feat', subject: 'add user login', body: '- Added auth middleware\n- Wired login route' });
  const result = parseSynthesizedCommit(raw, 'Add user login', 'AUTH-42', EXAMPLE_SUBTASKS);
  assert.equal(result.type, 'feat');
  assert.equal(result.subject, 'feat(auth-42): add user login');
  assert.equal(result.body, '- Added auth middleware\n- Wired login route');
});

test('parseSynthesizedCommit strips existing prefix from subject', () => {
  const raw = JSON.stringify({ type: 'fix', subject: 'fix(auth-42): patch token expiry', body: '' });
  const result = parseSynthesizedCommit(raw, 'Patch token expiry', 'AUTH-42', EXAMPLE_SUBTASKS);
  assert.equal(result.type, 'fix');
  assert.equal(result.subject, 'fix(auth-42): patch token expiry');
});

test('parseSynthesizedCommit falls back to goal on invalid JSON', () => {
  const result = parseSynthesizedCommit('not json', 'Add user login', 'AUTH-42', EXAMPLE_SUBTASKS);
  assert.equal(result.type, 'feat');
  assert.equal(result.subject, 'feat(auth-42): add user login');
  assert.ok(result.body.includes('Add auth middleware'));
});

test('callManagedCommitSynthesis never sends BYOK key to backend', async () => {
  const captured: { url?: string; body?: string } = {};
  const originalFetch = global.fetch;
  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = init?.body as string;
    return new Response(JSON.stringify({ responseText: JSON.stringify({ type: 'feat', subject: 'commit', body: '' }) }), { status: 200 });
  };

  try {
    await callManagedCommitSynthesis('gh_token', 'machine_123', 'Goal', 'TASK-1', EXAMPLE_SUBTASKS.map(t => ({ text: t, done: true })), 'diff');
    assert.equal(captured.url, 'https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit');
    const body = JSON.parse(captured.body || '{}');
    assert.equal(body.feature, 'commit');
    assert.equal(body.byokKey, undefined);
    assert.equal(body.byokProvider, undefined);
    assert.equal(body.gitDiff, 'diff');
  } finally {
    global.fetch = originalFetch;
  }
});
