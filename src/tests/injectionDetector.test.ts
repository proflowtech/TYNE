import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInjectionVulnerabilities,
  hasBlockingSqlInjection,
  injectionToReviewFindings,
} from '../quality/injectionDetector';

test('detects SQL injection via string concatenation', async () => {
  const files = {
    'src/api.js': [
      'async function getUser(id) {',
      '  return db.query("SELECT * FROM users WHERE id = " + id);',
      '}',
    ].join('\n'),
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.ok(vulns.some(v => v.type === 'sql' && v.cwe === 'CWE-89'));
  assert.equal(vulns[0].severity, 'critical');
  assert.match(vulns[0].fix_suggestion, /parameterized/i);
  assert.ok(hasBlockingSqlInjection(vulns));
});

test('detects NoSQL injection with req.params', async () => {
  const files = {
    'src/db.ts': 'db.collection.find({ _id: req.params.id });',
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.ok(vulns.some(v => v.type === 'nosql' && v.cwe === 'CWE-943'));
});

test('does not flag NoSQL with ObjectId wrapper', async () => {
  const files = {
    'src/db.ts': 'db.collection.find({ _id: new ObjectId(req.params.id) });',
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.equal(vulns.filter(v => v.type === 'nosql').length, 0);
});

test('detects command injection via exec concat', async () => {
  const files = {
    'src/run.ts': 'import { exec } from "child_process";\nexec("ls " + userInput);',
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.ok(vulns.some(v => v.type === 'command' && v.cwe === 'CWE-78'));
  assert.match(vulns.find(v => v.type === 'command')!.safe_pattern, /execFile/);
});

test('does not flag parameterized SQL', async () => {
  const files = {
    'src/db.ts': 'db.query("SELECT * FROM users WHERE id = ?", [id]);',
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.equal(vulns.length, 0);
});

test('does not flag comment-only SQL example', async () => {
  const files = {
    'src/db.ts': '// db.query("SELECT * FROM users WHERE id = " + id)',
  };
  const vulns = await detectInjectionVulnerabilities(files);
  assert.equal(vulns.length, 0);
});

test('injectionToReviewFindings blocks SQL only', () => {
  const vulns = [
    { type: 'sql' as const, pattern: 'x', line: 1, file: 'a.ts', cwe: 'CWE-89', severity: 'critical' as const,
      vulnerable_pattern: 'x', safe_pattern: 'y', fix_suggestion: 'fix' },
    { type: 'command' as const, pattern: 'x', line: 2, file: 'a.ts', cwe: 'CWE-78', severity: 'critical' as const,
      vulnerable_pattern: 'x', safe_pattern: 'y', fix_suggestion: 'fix' },
  ];
  const findings = injectionToReviewFindings(vulns);
  assert.equal(findings[0].blocking, true);
  assert.equal(findings[1].blocking, false);
});

test('completes under 500ms on typical file set', async () => {
  const body = Array.from({ length: 150 }, (_, i) =>
    `const x${i} = db.query("SELECT ${i} FROM t WHERE id = " + id);`,
  ).join('\n');
  const files = { 'src/big.ts': body };
  const start = Date.now();
  const vulns = await detectInjectionVulnerabilities(files);
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start}ms`);
  assert.ok(vulns.length >= 1);
});
