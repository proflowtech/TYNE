import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLearningsFile,
  parseLearningsDocument,
  parseHouseRules,
  appendHouseRule,
  rulesForFiles,
  MAX_HOUSE_RULES,
  learningsToTitleSet,
  formatLearningEntry,
  appendLearning,
  removeLearning,
  learningUsageHash,
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

// ── removeLearning ──────────────────────────────────────────────────────────

test('removeLearning deletes exactly one bullet and leaves the rest byte-identical', () => {
  const before = [
    '# Tyne Learnings',
    '',
    '<!-- a human comment -->',
    '- Keep me',
    '- Delete me',
    '- Keep me too',
  ].join('\n');
  const { content, removed } = removeLearning(before, 'Delete me');
  assert.equal(removed, true);
  assert.equal(content, [
    '# Tyne Learnings',
    '',
    '<!-- a human comment -->',
    '- Keep me',
    '- Keep me too',
  ].join('\n'), 'header, comment and sibling bullets must survive untouched');
});

test('removeLearning matches case/whitespace variants like the parser does', () => {
  const { removed } = removeLearning('- Console.log Left In Code', '  console.log   left in code  ');
  assert.equal(removed, true);
});

test('removeLearning will not delete a scoped learning when asked for the unscoped one', () => {
  const before = '- Procedural style (src/workers/**)';
  const { content, removed } = removeLearning(before, 'Procedural style');
  assert.equal(removed, false, 'scope must match too, or a narrower rule could be deleted by accident');
  assert.equal(content, before);
});

test('removeLearning targets the right entry when the same title exists at two scopes', () => {
  const before = [
    '- Procedural style (src/workers/**)',
    '- Procedural style (src/jobs/**)',
  ].join('\n');
  const { content, removed } = removeLearning(before, 'Procedural style', 'src/jobs/**');
  assert.equal(removed, true);
  assert.match(content, /src\/workers/, 'the other scope must remain');
  assert.doesNotMatch(content, /src\/jobs/);
});

test('removeLearning is a no-op for a title that is not present', () => {
  const before = '# Tyne Learnings\n\n- Something else';
  const { content, removed } = removeLearning(before, 'Never added');
  assert.equal(removed, false);
  assert.equal(content, before);
});

test('removeLearning is a no-op for a blank title or empty file', () => {
  assert.equal(removeLearning('- Anything', '  ').removed, false);
  assert.equal(removeLearning('', 'Anything').removed, false);
});

test('append then remove round-trips back to the original content', () => {
  const original = '# Tyne Learnings\n\n- Existing';
  const { content: withNew } = appendLearning(original, 'Temporary', 'because', 'src/**');
  const { content: after, removed } = removeLearning(withNew, 'Temporary', 'src/**');
  assert.equal(removed, true);
  assert.equal(after.trim(), original.trim());
});

// ── House rules: parsing ────────────────────────────────────────────────────

const DOC_WITH_RULES = [
  '# Tyne Learnings',
  '',
  'Some prose that is not a bullet.',
  '',
  '## Suppress',
  '- Console.log left in code (src/workers/**)',
  '',
  '## Require',
  '- Use Result<T,E> instead of throwing (src/core/**)',
  '- Every exported function needs a JSDoc block',
].join('\n');

test('parses suppressions and house rules into separate halves', () => {
  const doc = parseLearningsDocument(DOC_WITH_RULES);
  assert.equal(doc.suppressions.length, 1);
  assert.equal(doc.suppressions[0].title, 'console.log left in code');
  assert.equal(doc.rules.length, 2);
  assert.equal(doc.rules[0].text, 'Use Result<T,E> instead of throwing');
  assert.equal(doc.rules[0].scope, 'src/core/**');
});

test('house rules get sequential ids the model can echo back', () => {
  const rules = parseHouseRules(DOC_WITH_RULES);
  assert.deepEqual(rules.map(r => r.id), ['HR1', 'HR2']);
});

test('house rules record their source line for provenance', () => {
  const rules = parseHouseRules(DOC_WITH_RULES);
  assert.equal(rules[0].sourceLine, 9);
});

test('BACKWARD COMPAT: a file with no headings is still all suppressions', () => {
  // Files written before house rules existed must not suddenly have their
  // bullets reinterpreted as rules.
  const legacy = '- Alpha finding\n- Beta finding — because reasons';
  const doc = parseLearningsDocument(legacy);
  assert.equal(doc.suppressions.length, 2);
  assert.equal(doc.rules.length, 0);
});

test('a heading that is neither Suppress nor Require leaves the section alone', () => {
  const doc = parseLearningsDocument([
    '# Tyne Learnings',
    '## Notes for reviewers',
    '- Still a suppression',
  ].join('\n'));
  assert.equal(doc.suppressions.length, 1);
  assert.equal(doc.rules.length, 0);
});

test('switching back to Suppress after Require works', () => {
  const doc = parseLearningsDocument([
    '## Require',
    '- Prefer composition over inheritance here',
    '## Suppress',
    '- Missing jsdoc',
  ].join('\n'));
  assert.equal(doc.rules.length, 1);
  assert.equal(doc.suppressions.length, 1);
});

test('rule headings are recognised case-insensitively and by synonym', () => {
  for (const heading of ['## Require', '## RULES', '## House Rules', '## Conventions', '## enforce']) {
    const doc = parseLearningsDocument(`${heading}\n- Prefer explicit return types everywhere`);
    assert.equal(doc.rules.length, 1, `"${heading}" should open the rules section`);
  }
});

test('SAFETY: a rule too short to be checkable is dropped', () => {
  // "Be good" cannot be evaluated without guessing, and a vague rule is the
  // main false-positive risk for this feature.
  const doc = parseLearningsDocument('## Require\n- Be good\n- Use dependency injection in handlers');
  assert.equal(doc.rules.length, 1);
  assert.match(doc.rules[0].text, /dependency injection/);
});

test('SAFETY: the number of rules is capped', () => {
  const many = ['## Require', ...Array.from({ length: 40 }, (_, i) => `- Rule number ${i} must always be followed here`)];
  assert.equal(parseHouseRules(many.join('\n')).length, MAX_HOUSE_RULES);
});

// ── House rules: scoping ────────────────────────────────────────────────────

test('rulesForFiles keeps unscoped rules and drops out-of-scope ones', () => {
  const rules = parseHouseRules([
    '## Require',
    '- Applies everywhere in this repository',
    '- Only for core code here (src/core/**)',
  ].join('\n'));

  const inCore = rulesForFiles(rules, ['src/core/engine.ts']);
  assert.equal(inCore.length, 2, 'both the global and the scoped rule apply');

  const inApi = rulesForFiles(rules, ['src/api/route.ts']);
  assert.equal(inApi.length, 1, 'the scoped rule must not apply outside its glob');
  assert.match(inApi[0].text, /everywhere/);
});

test('rulesForFiles matches when any changed file is in scope', () => {
  const rules = parseHouseRules('## Require\n- Core rule applies to this area (src/core/**)');
  assert.equal(rulesForFiles(rules, ['src/api/a.ts', 'src/core/b.ts']).length, 1);
  assert.equal(rulesForFiles(rules, ['src/api/a.ts']).length, 0);
});

// ── House rules: writing ────────────────────────────────────────────────────

test('appendHouseRule creates a Require section when none exists', () => {
  const { content, added } = appendHouseRule('# Tyne Learnings\n\n- An existing suppression', 'Always validate input at the boundary');
  assert.equal(added, true);
  assert.match(content, /## Require/);
  const doc = parseLearningsDocument(content);
  assert.equal(doc.suppressions.length, 1, 'the existing suppression must survive');
  assert.equal(doc.rules.length, 1);
});

test('appendHouseRule adds into an existing Require section rather than making a second one', () => {
  const { content } = appendHouseRule(DOC_WITH_RULES, 'Prefer named exports over default exports');
  assert.equal((content.match(/## Require/g) || []).length, 1);
  assert.equal(parseHouseRules(content).length, 3);
});

test('appendHouseRule is idempotent and scope-aware', () => {
  const first = appendHouseRule('', 'Always validate input at the boundary', 'src/api/**');
  assert.equal(first.added, true);
  assert.equal(appendHouseRule(first.content, 'Always validate input at the boundary', 'src/api/**').added, false);
  assert.equal(
    appendHouseRule(first.content, 'Always validate input at the boundary', 'src/core/**').added,
    true,
    'the same rule at a different scope is a distinct decision',
  );
});

test('appendHouseRule refuses a rule too short to be checkable', () => {
  const { added } = appendHouseRule('', 'Be nice');
  assert.equal(added, false);
});

test('suppressions and rules do not interfere: adding a rule leaves matching intact', () => {
  const { content } = appendHouseRule(DOC_WITH_RULES, 'Prefer async/await over raw promise chains');
  const doc = parseLearningsDocument(content);
  const hit = matchLearning({ title: 'Console.log left in code', file: 'src/workers/job.ts' }, doc.suppressions);
  assert.equal(hit?.kind, 'scoped', 'suppression matching must be unaffected by the rules section');
});

// ── Usage hash ──────────────────────────────────────────────────────────────

/**
 * Replica of `ruleHash` in supabase/functions/tyne-validate-review/houseRules.ts.
 * Rule rows and suppression rows land in one telemetry table and are grouped
 * by this value, so a drift between the two implementations would silently
 * split one entry's history and reset its staleness clock.
 */
function edgeRuleHash(text: string): string {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

test('DRIFT GUARD: client usage hash matches the edge function implementation', () => {
  for (const sample of [
    'Console.log left in code',
    'Use Result<T,E> instead of throwing',
    '  MIXED   Case   And   Spacing  ',
    'unicode — em dash and ünïcödé',
    '',
    'x',
  ]) {
    assert.equal(
      learningUsageHash(sample),
      edgeRuleHash(sample),
      `hash drift on ${JSON.stringify(sample)} would split this entry's telemetry history`,
    );
  }
});

test('usage hash ignores case and whitespace so reformatting keeps identity', () => {
  assert.equal(
    learningUsageHash('Console.log left in code'),
    learningUsageHash('  console.log   LEFT in code '),
  );
});

test('usage hash separates genuinely different learnings', () => {
  assert.notEqual(learningUsageHash('Missing tests'), learningUsageHash('Missing jsdoc'));
});
