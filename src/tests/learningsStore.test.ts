import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLearningsFile,
  learningsToTitleSet,
  formatLearningEntry,
  appendLearning,
  matchLearning,
  matchesScope,
  conceptTokens,
  conceptContainment,
  FUZZY_THRESHOLD,
} from '../quality/learningsStore';

/**
 * Phase C: `.tyne/learnings.md` is a team-shared version of the suppression
 * that already exists per-user (`rememberDismissedFinding`). The contract
 * that matters most is parity with that existing mechanism: a hand-written
 * bullet must match findings exactly the same way clicking "Ignore" does —
 * same normalization, same exact-title semantics — so a team doesn't have to
 * learn a second, subtly different suppression rule.
 */

// ── parseLearningsFile ──────────────────────────────────────────────────────

test('parses a bullet with a title and a reason', () => {
  const learnings = parseLearningsFile('- Console.log left in code — worker scripts intentionally log to stdout');
  assert.equal(learnings.length, 1);
  assert.equal(learnings[0].title, 'console.log left in code');
  assert.equal(learnings[0].note, 'worker scripts intentionally log to stdout');
});

test('parses a bullet with no reason', () => {
  const learnings = parseLearningsFile('- Missing JSDoc on internal helpers');
  assert.equal(learnings.length, 1);
  assert.equal(learnings[0].title, 'missing jsdoc on internal helpers');
  assert.equal(learnings[0].note, undefined);
});

test('ignores prose, headers, and blank lines — only bullets are entries', () => {
  const content = [
    '# Tyne Learnings',
    '',
    'Team-maintained suppressions. This line is not a bullet and must be ignored.',
    '',
    '- Real entry one',
    '',
    '## A markdown subheading, also not a bullet',
    '- Real entry two',
  ].join('\n');
  const learnings = parseLearningsFile(content);
  assert.equal(learnings.length, 2);
  assert.deepEqual(learnings.map(l => l.title), ['real entry one', 'real entry two']);
});

test('accepts both "-" and "*" bullet markers, and tolerates indentation', () => {
  const content = '  - dash entry\n* star entry\n    - indented dash entry';
  const learnings = parseLearningsFile(content);
  assert.deepEqual(learnings.map(l => l.title), ['dash entry', 'star entry', 'indented dash entry']);
});

test('normalization matches the existing per-user Ignore mechanism: case and whitespace insensitive', () => {
  const learnings = parseLearningsFile('-   Console.log   Left  IN   Code');
  assert.equal(learnings[0].title, 'console.log left in code');
});

test('records the 1-based source line for each entry', () => {
  const content = '# Header\n\n- first\n- second';
  const learnings = parseLearningsFile(content);
  assert.equal(learnings[0].sourceLine, 3);
  assert.equal(learnings[1].sourceLine, 4);
});

test('a bullet that is only whitespace after the marker is skipped, not a crash', () => {
  const parsed = parseLearningsFile('-    \n-\t\n- real');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'real');
  assert.equal(parsed[0].sourceLine, 3);
});

test('handles an empty or missing file', () => {
  assert.deepEqual(parseLearningsFile(''), []);
  assert.deepEqual(parseLearningsFile(undefined as unknown as string), []);
});

test('an em dash inside the title itself does not get mistaken for the note separator without surrounding spaces', () => {
  // The separator is specifically " — " (spaces both sides); a bare em dash
  // glued to adjacent characters is just part of the title text.
  const learnings = parseLearningsFile('- Uses non—breaking hyphen in variable name');
  assert.equal(learnings[0].title, 'uses non—breaking hyphen in variable name');
  assert.equal(learnings[0].note, undefined);
});

// ── learningsToTitleSet ──────────────────────────────────────────────────────

test('learningsToTitleSet extracts just the normalized match keys', () => {
  const learnings = parseLearningsFile('- Alpha finding\n- Beta finding — because reasons');
  const set = learningsToTitleSet(learnings);
  assert.equal(set.size, 2);
  assert.ok(set.has('alpha finding'));
  assert.ok(set.has('beta finding'));
});

// ── formatLearningEntry ──────────────────────────────────────────────────────

test('formats a bullet with a reason', () => {
  assert.equal(formatLearningEntry('Missing tests', 'covered by e2e suite'), '- Missing tests — covered by e2e suite');
});

test('formats a bullet with no reason', () => {
  assert.equal(formatLearningEntry('Missing tests'), '- Missing tests');
});

test('preserves the original casing in the written bullet — only matching is case-insensitive', () => {
  const line = formatLearningEntry('Console.log Left In Code');
  assert.equal(line, '- Console.log Left In Code');
});

// ── appendLearning ───────────────────────────────────────────────────────────

test('appendLearning adds a bullet to an existing file', () => {
  const before = '# Tyne Learnings\n\n- Existing entry';
  const { content, added } = appendLearning(before, 'New entry', 'because X');
  assert.equal(added, true);
  assert.match(content, /- New entry — because X$/m);
  assert.match(content, /- Existing entry/, 'must not drop the existing bullet');
});

test('appendLearning starts a fresh file with a real header, not a bare bullet', () => {
  const { content, added } = appendLearning('', 'First learning');
  assert.equal(added, true);
  assert.match(content, /^# Tyne Learnings/);
  assert.match(content, /- First learning$/m);
});

test('appendLearning is idempotent: adding the same title twice is a no-op the second time', () => {
  const first = appendLearning('', 'Duplicate finding title');
  assert.equal(first.added, true);
  const second = appendLearning(first.content, 'Duplicate finding title');
  assert.equal(second.added, false);
  assert.equal(second.content, first.content, 'content must be unchanged, not silently duplicated');
});

test('appendLearning treats case/whitespace variants as the same entry for idempotency', () => {
  const first = appendLearning('', 'Console.log left in code');
  const second = appendLearning(first.content, '  console.log   LEFT in code  ');
  assert.equal(second.added, false, 'a case/whitespace variant of an existing title must not duplicate');
});

test('appendLearning round-trips through parseLearningsFile: what is written is what is matched', () => {
  const { content } = appendLearning('', 'Some Finding Title', 'a reason');
  const parsed = parseLearningsFile(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'some finding title');
  assert.equal(parsed[0].note, 'a reason');
});

test('appendLearning does nothing for a blank title', () => {
  const { content, added } = appendLearning('# Tyne Learnings\n\n- Existing', '   ');
  assert.equal(added, false);
  assert.equal(content, '# Tyne Learnings\n\n- Existing');
});

test('appendLearning preserves manually written entries untouched by the parser round trip', () => {
  // A human editing the file directly (removing an entry, adding a comment)
  // must not have their edits clobbered by a later programmatic append.
  const humanEdited = '# Tyne Learnings\n\n<!-- keep this comment -->\n- Human entry one\n- Human entry two';
  const { content } = appendLearning(humanEdited, 'Programmatic entry');
  assert.match(content, /<!-- keep this comment -->/);
  assert.match(content, /- Human entry one/);
  assert.match(content, /- Human entry two/);
  assert.match(content, /- Programmatic entry$/m);
});

// ── Scope parsing & glob matching ───────────────────────────────────────────

test('parses a trailing path glob as scope, keeping it out of title and note', () => {
  const [l] = parseLearningsFile('- Console.log left in code — workers log to stdout (src/workers/**)');
  assert.equal(l.title, 'console.log left in code', 'the glob must not leak into the match key');
  assert.equal(l.note, 'workers log to stdout');
  assert.equal(l.scope, 'src/workers/**');
});

test('a scope with no note still parses', () => {
  const [l] = parseLearningsFile('- Procedural style (src/workers/**)');
  assert.equal(l.title, 'procedural style');
  assert.equal(l.scope, 'src/workers/**');
});

test('ordinary parentheses that are not a path are left in the title', () => {
  // Only parens containing a path separator or wildcard are treated as scope.
  const [l] = parseLearningsFile('- Uses eval() unnecessarily');
  assert.equal(l.scope, undefined);
  assert.match(l.title, /eval/);
});

test('matchesScope handles ** across segments and * within one', () => {
  assert.equal(matchesScope('src/workers/job.ts', 'src/workers/**'), true);
  assert.equal(matchesScope('src/workers/deep/nested/job.ts', 'src/workers/**'), true);
  assert.equal(matchesScope('src/api/route.ts', 'src/workers/**'), false);
  assert.equal(matchesScope('src/a.test.ts', 'src/*.test.ts'), true);
  assert.equal(matchesScope('src/deep/a.test.ts', 'src/*.test.ts'), false, '* must not cross a path separator');
});

test('matchesScope is case-insensitive and normalizes Windows separators', () => {
  assert.equal(matchesScope('SRC\\Workers\\Job.ts', 'src/workers/**'), true);
});

// ── Concept tokens & containment ────────────────────────────────────────────

test('conceptTokens drops stopwords and keeps domain terms', () => {
  const tokens = conceptTokens('the missing console.log in this function');
  assert.ok(tokens.includes('console'));
  assert.ok(tokens.includes('log'));
  assert.ok(!tokens.includes('the'), 'stopwords must be dropped');
  assert.ok(!tokens.includes('function'), 'generic code words must be dropped');
});

test('conceptContainment is one-directional, unlike Jaccard', () => {
  const learning = conceptTokens('unhandled promise rejection in async handler');
  const rephrased = conceptTokens('async handler has an unhandled promise rejection today');
  // Every learning concept survives the rephrasing, even though the finding
  // added words. Jaccard would penalise that; containment must not.
  assert.equal(conceptContainment(learning, rephrased), 1);
});

test('conceptContainment is zero for unrelated titles', () => {
  assert.equal(conceptContainment(conceptTokens('sql injection in query'), conceptTokens('missing jsdoc comment')), 0);
});

// ── matchLearning: the four tiers ───────────────────────────────────────────

const TIERED = parseLearningsFile([
  '- Unhandled promise rejection in async handler — we catch at the boundary',
  '- Console.log left in code (src/workers/**)',
  '- Missing test',
  '- VIBE_CONSOLE',
].join('\n'));

test('exact tier: identical normalized title', () => {
  const m = matchLearning({ title: 'Missing test', file: 'src/a.ts' }, TIERED);
  assert.equal(m?.kind, 'exact');
  assert.equal(m?.score, 1);
});

test('scoped tier: exact title inside the glob only', () => {
  const inside = matchLearning({ title: 'Console.log left in code', file: 'src/workers/job.ts' }, TIERED);
  assert.equal(inside?.kind, 'scoped');

  const outside = matchLearning({ title: 'Console.log left in code', file: 'src/api/route.ts' }, TIERED);
  assert.equal(outside, null, 'a scoped learning must not suppress outside its glob');
});

test('rule tier: ruleId match survives any title rewording', () => {
  const m = matchLearning({ title: 'Some completely different wording', ruleId: 'VIBE_CONSOLE', file: 'src/a.ts' }, TIERED);
  assert.equal(m?.kind, 'rule');
});

test('fuzzy tier: a specific learning survives the model rephrasing the finding', () => {
  const m = matchLearning({ title: 'Async handler has an unhandled promise rejection', file: 'src/a.ts' }, TIERED);
  assert.equal(m?.kind, 'fuzzy');
  assert.ok((m?.score || 0) >= FUZZY_THRESHOLD);
});

// ── matchLearning: the safety envelope ──────────────────────────────────────

test('SAFETY: a short generic learning never fuzzy-swallows a specific finding', () => {
  // "Missing test" has too few concepts to generalise. Without this guard it
  // would be contained in — and therefore hide — the security finding below.
  const m = matchLearning({ title: 'Missing test for authentication bypass', file: 'src/a.ts' }, TIERED);
  assert.equal(m, null);
});

test('SAFETY: security, compliance, breaking-change and scope findings are never fuzzy-suppressed', () => {
  for (const category of ['security', 'compliance', 'breaking_change', 'pm_alignment']) {
    const m = matchLearning(
      { title: 'Async handler has an unhandled promise rejection', file: 'src/a.ts', category },
      TIERED,
    );
    assert.equal(m, null, `${category} must require an exact title, never a fuzzy match`);
  }
});

test('SAFETY: an exact title still suppresses even in a never-fuzzy category', () => {
  // The guard limits the *fuzzy* tier only — an explicit exact-title learning
  // is a deliberate human decision and must still be honoured.
  const m = matchLearning({ title: 'Missing test', file: 'src/a.ts', category: 'security' }, TIERED);
  assert.equal(m?.kind, 'exact');
});

test('SAFETY: unrelated findings match nothing', () => {
  assert.equal(matchLearning({ title: 'SQL injection in user query', file: 'src/a.ts' }, TIERED), null);
});

test('matchLearning returns null for an empty learnings list or a titleless finding', () => {
  assert.equal(matchLearning({ title: 'anything', file: 'a.ts' }, []), null);
  assert.equal(matchLearning({ title: '', file: 'a.ts' }, TIERED), null);
});

test('the strongest tier wins when several learnings could apply', () => {
  const learnings = parseLearningsFile([
    '- Unhandled promise rejection in async handler',
    '- Async handler has an unhandled promise rejection',
  ].join('\n'));
  const m = matchLearning({ title: 'Async handler has an unhandled promise rejection', file: 'src/a.ts' }, learnings);
  assert.equal(m?.kind, 'exact', 'an exact match must beat a fuzzy one');
});

// ── appendLearning with scope ───────────────────────────────────────────────

test('appendLearning writes a scope that round-trips through the parser', () => {
  const { content } = appendLearning('', 'Procedural style', 'workers are procedural', 'src/workers/**');
  const [parsed] = parseLearningsFile(content);
  assert.equal(parsed.title, 'procedural style');
  assert.equal(parsed.note, 'workers are procedural');
  assert.equal(parsed.scope, 'src/workers/**');
});

test('the same title at a different scope is a distinct entry, not a duplicate', () => {
  const first = appendLearning('', 'Procedural style', undefined, 'src/workers/**');
  const second = appendLearning(first.content, 'Procedural style', undefined, 'src/jobs/**');
  assert.equal(second.added, true, 'scoping the same rule to another path is a new decision');
});
