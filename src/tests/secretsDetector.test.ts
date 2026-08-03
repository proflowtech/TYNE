import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSecrets } from '../quality/secretsDetector';

const DIFF = (file: string, lines: string[]) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,0 +1,3 @@',
  ...lines.map(l => `+${l}`),
].join('\n');

test('detects AWS key with BLOCK verdict in config file', async () => {
  const diff = DIFF('config.js', [
    'export const aws = "AKIA1234567890ABCDEF";',
  ]);
  const result = await detectSecrets(diff, { 'config.js': 'export const aws = "AKIA1234567890ABCDEF";' });
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.severity, 'critical');
  assert.ok(result.secrets.some(s => s.type === 'aws_key' && s.line === 1));
  assert.match(result.secrets[0].value_preview, /AKIA.*\*\*\*\*/);
});

test('detects GitHub token in code (medium confidence → warn)', async () => {
  const token = 'ghp_' + 'a'.repeat(36);
  const diff = DIFF('src/api.ts', [`const t = "${token}";`]);
  const result = await detectSecrets(diff, {});
  assert.ok(result.secrets.some(s => s.type === 'github_token'));
  assert.equal(result.verdict, 'warn');
});

test('detects Stripe live key in .env (high confidence BLOCK)', async () => {
  const diff = DIFF('.env', ['STRIPE_KEY=sk_live_abcdefghijklmnopqrstuv']);
  const result = await detectSecrets(diff, { '.env': 'STRIPE_KEY=sk_live_abcdefghijklmnopqrstuv' });
  assert.equal(result.verdict, 'BLOCK');
  assert.ok(result.secrets.some(s => s.type === 'stripe_key' || s.pattern === 'env_assignment'));
});

test('detects private key multiline in changed file body', async () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEA1234567890',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const diff = DIFF('keys/server.pem', ['+-----BEGIN RSA PRIVATE KEY-----']);
  const result = await detectSecrets(diff, { 'keys/server.pem': pem });
  assert.ok(result.secrets.some(s => s.type === 'private_key'));
  assert.equal(result.verdict, 'BLOCK');
});

test('does not flag authorization_code placeholder', async () => {
  const diff = DIFF('auth.ts', ['const token = "authorization_code";']);
  const result = await detectSecrets(diff, {});
  assert.equal(result.secrets.length, 0);
  assert.equal(result.verdict, 'pass');
});

test('detects postgres URI', async () => {
  const diff = DIFF('db.ts', ['const url = "postgres://admin:SuperSecret123@db.example.com/mydb";']);
  const result = await detectSecrets(diff, {});
  assert.ok(result.secrets.some(s => s.type === 'postgres_uri'));
});

test('skips comment-only added lines', async () => {
  const diff = DIFF('notes.ts', ['// AKIA1234567890ABCDEF example only']);
  const result = await detectSecrets(diff, {});
  assert.equal(result.secrets.length, 0);
});

test('completes under 300ms on typical diff', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `+const x${i} = "line${i}";`);
  const diff = [
    'diff --git a/big.ts b/big.ts',
    '--- a/big.ts',
    '+++ b/big.ts',
    '@@ -1,0 +1,200 @@',
    ...lines,
    '+const bad = "AKIA1234567890ABCDEF";',
  ].join('\n');
  const start = Date.now();
  const result = await detectSecrets(diff, {});
  assert.ok(Date.now() - start < 300, `took ${Date.now() - start}ms`);
  assert.ok(result.secrets.some(s => s.type === 'aws_key'));
});

test('does not flag template and masked placeholder values (redaction-style fixes)', async () => {
  const diff = DIFF('src/config.ts', [
    'const apiKey = "<YOUR_API_KEY_HERE>";',
    'const password = "${DB_PASSWORD_FROM_ENV}";',
    'const oauthToken = "****************************************";',
  ]);
  const result = await detectSecrets(diff, {});
  assert.equal(result.secrets.length, 0, JSON.stringify(result.secrets));
  assert.equal(result.verdict, 'pass');
});

test('still flags a real-looking value after a fake fix', async () => {
  const diff = DIFF('src/config.ts', [
    'const password = "Hunter2Hunter2!";',
  ]);
  const result = await detectSecrets(diff, {});
  assert.ok(result.secrets.some(s => s.type === 'database_password'));
});
