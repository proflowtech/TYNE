import test from 'node:test';
import assert from 'node:assert/strict';
import { remapFindingsThroughDiff, buildOldToNewLineMaps } from '../services/findingLineRemap';
import { assessScopeBlowout, buildTouchSnapshot } from '../services/scopeBlowout';
import { findingCanHardBlock, verdictFromFindings } from '../validateReviewTypes';

test('findingCanHardBlock: security critical blocks, pm_alignment never', () => {
  assert.equal(findingCanHardBlock({ severity: 'critical', category: 'security' }), true);
  assert.equal(findingCanHardBlock({ severity: 'critical', category: 'pm_alignment', confidence: 'high' }), false);
  assert.equal(findingCanHardBlock({ severity: 'high', category: 'security', blocking: true }), true);
});

test('buildOldToNewLineMaps shifts lines past insertions', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,5 @@',
    ' line1',
    '+inserted',
    '+inserted2',
    ' line2',
    ' line3',
  ].join('\n');
  const maps = buildOldToNewLineMaps(diff);
  const m = maps.get('src/a.ts');
  assert.ok(m);
  assert.equal(m!.get(1), 1);
  assert.equal(m!.get(2), 4);
  assert.equal(m!.get(3), 5);
});

test('remapFindingsThroughDiff updates finding line and clears agentPrompt', () => {
  const diff = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,2 +10,3 @@',
    ' keep',
    '+new',
    ' below',
  ].join('\n');
  const { findings, remappedCount } = remapFindingsThroughDiff(
    [{ id: '1', file: 'src/a.ts', line: 11, endLine: 11, agentPrompt: 'old' }],
    diff,
  );
  assert.ok(remappedCount >= 1);
  assert.equal(findings[0].line, 12);
  assert.equal(findings[0].agentPrompt, undefined);
});

test('assessScopeBlowout flags unexpected files and large line growth', () => {
  const before = buildTouchSnapshot({
    paths: ['src/a.ts'],
    additionsDeletions: [{ additions: 2, deletions: 1 }],
    findingFiles: ['src/a.ts'],
  });
  const afterOk = buildTouchSnapshot({
    paths: ['src/a.ts'],
    additionsDeletions: [{ additions: 10, deletions: 2 }],
    findingFiles: ['src/a.ts'],
  });
  assert.equal(assessScopeBlowout(before, afterOk).blowout, false);

  const afterBlow = buildTouchSnapshot({
    paths: ['src/a.ts', 'package.json', 'README.md'],
    additionsDeletions: [{ additions: 100, deletions: 50 }],
    findingFiles: ['src/a.ts'],
  });
  const hit = assessScopeBlowout(before, afterBlow);
  assert.equal(hit.blowout, true);
  assert.ok(hit.extraPaths.includes('package.json'));
});

test('verdictFromFindings: critical without category is not a hard block', () => {
  assert.equal(verdictFromFindings([{ severity: 'critical' }]), 'changes_requested');
});
