import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStaticSecurityHeuristics, changedFilesFromDiff } from '../quality/staticSecurityHeuristics';

test('detectStaticSecurityHeuristics catches MD5, XSS, PHI log, N+1', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,6 @@',
    "+crypto.createHash('md5').update(x)",
    '+return <div dangerouslySetInnerHTML={{ __html: t }} />',
    "+console.log('patient ssn', ssn)",
    "+for (const u of users) { db.query('SELECT * FROM posts WHERE id = ' + u.id) }",
  ].join('\n');
  const findings = detectStaticSecurityHeuristics(diff);
  const ids = new Set(findings.map(f => f.id));
  assert.ok(ids.has('weak_crypto_md5'), 'md5');
  assert.ok(ids.has('xss_dangerously_set_inner_html'), 'xss');
  assert.ok(ids.has('sensitive_data_logged'), 'phi');
  assert.ok(ids.has('n_plus_one_query'), 'n+1');
});

test('changedFilesFromDiff extracts added bodies', () => {
  const files = changedFilesFromDiff(
    'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+line1\n+line2\n',
  );
  assert.equal(files['x.ts'], 'line1\nline2');
});
