import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterByLineOverlap,
  mergeCluster,
  mergeAndDeduplicateFindings,
  groupCrossFileByRule,
  throttleLowPriorityFindings,
  normalizeStructuredFix,
  postProcessReviewFindings,
  carryForwardUnresolvedMinors,
  dedupeSentences,
  dropSuppressedFindings,
} from '../services/findingsMerger';
import {
  toDisplaySeverity,
  verdictFromFindings,
  TyneValidateReviewFinding,
} from '../validateReviewTypes';

function finding(overrides: Partial<TyneValidateReviewFinding>): TyneValidateReviewFinding {
  return {
    id: overrides.id || `f_${Math.random().toString(36).slice(2, 8)}`,
    file: 'src/auth.ts',
    line: 10,
    severity: 'medium',
    category: 'correctness',
    title: 'A finding',
    explanation: 'Something is wrong.',
    confidence: 'medium',
    ...overrides,
  };
}

// ── Display severity mapping ─────────────────────────────────────────────────

test('toDisplaySeverity maps legacy and new scales', () => {
  assert.equal(toDisplaySeverity('critical'), 'critical');
  assert.equal(toDisplaySeverity('high'), 'major');
  assert.equal(toDisplaySeverity('major'), 'major');
  assert.equal(toDisplaySeverity('medium'), 'minor');
  assert.equal(toDisplaySeverity('low', 'style'), 'nit');
  assert.equal(toDisplaySeverity('low', 'correctness'), 'minor');
  assert.equal(toDisplaySeverity('info'), 'info');
  assert.equal(toDisplaySeverity('garbage'), 'minor');
});

test('verdictFromFindings escalates by worst severity', () => {
  assert.equal(verdictFromFindings([]), 'approve');
  assert.equal(verdictFromFindings([{ severity: 'low', category: 'style' }]), 'approve_with_suggestions');
  assert.equal(verdictFromFindings([{ severity: 'high' }]), 'changes_requested');
  assert.equal(
    verdictFromFindings([{ severity: 'critical', category: 'security' }, { severity: 'low', category: 'style' }]),
    'block',
  );
});

test('verdictFromFindings never blocks on pm_alignment/style criticals', () => {
  assert.equal(
    verdictFromFindings([{ severity: 'critical', category: 'pm_alignment', confidence: 'high' }]),
    'changes_requested',
  );
  assert.equal(
    verdictFromFindings([{ severity: 'critical', category: 'style' }]),
    'changes_requested',
  );
  assert.equal(
    verdictFromFindings([{ severity: 'critical', category: 'vibe_code' }]),
    'changes_requested',
  );
  assert.equal(
    verdictFromFindings([{ severity: 'critical', category: 'security', blocking: true, confidence: 'high' }]),
    'block',
  );
});

// ── Line-overlap clustering ──────────────────────────────────────────────────

test('clusterByLineOverlap groups findings within threshold lines', () => {
  const clusters = clusterByLineOverlap([
    finding({ id: 'a', line: 10, endLine: 12 }),
    finding({ id: 'b', line: 14 }),
    finding({ id: 'c', line: 40 }),
  ], 3);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].map(f => f.id), ['a', 'b']);
  assert.deepEqual(clusters[1].map(f => f.id), ['c']);
});

test('clusterByLineOverlap never clusters findings without line anchors', () => {
  const clusters = clusterByLineOverlap([
    finding({ id: 'a', line: undefined }),
    finding({ id: 'b', line: undefined }),
  ]);
  assert.equal(clusters.length, 2);
});

test('mergeCluster keeps the highest severity and prefers deterministic fixes', () => {
  const merged = mergeCluster([
    finding({ id: 'llm', severity: 'medium', source: 'llm', suggestedFix: 'llm fix', explanation: 'LLM view.' }),
    finding({ id: 'local', severity: 'high', source: 'local_engine', suggestedFix: 'local fix', explanation: 'Local view.' }),
  ]);
  assert.equal(merged.severity, 'high');
  assert.equal(merged.suggestedFix, 'local fix');
  assert.ok(merged.explanation.includes('Local view.'));
  assert.ok(merged.explanation.includes('LLM view.'));
});

// ── Dedup across engines ─────────────────────────────────────────────────────

test('mergeAndDeduplicateFindings collapses same issue reported by two engines on overlapping lines', () => {
  const merged = mergeAndDeduplicateFindings([
    finding({ id: 'a', line: 42, severity: 'critical', category: 'security', title: 'SQL injection risk', source: 'local_engine' }),
    finding({ id: 'b', line: 43, severity: 'high', category: 'security', title: 'Unsanitized query input', source: 'llm' }),
    finding({ id: 'c', line: 42, severity: 'medium', category: 'style', title: 'Naming nit', source: 'llm' }),
  ]);
  const security = merged.filter(f => f.category === 'security');
  assert.equal(security.length, 1, 'overlapping security findings must merge into one');
  assert.equal(security[0].severity, 'critical');
  // Different category on the same line stays separate.
  assert.equal(merged.filter(f => f.category === 'style').length, 1);
});

test('mergeAndDeduplicateFindings sorts worst-first', () => {
  const merged = mergeAndDeduplicateFindings([
    finding({ id: 'a', file: 'x.ts', line: 1, severity: 'low', title: 'nit one' }),
    finding({ id: 'b', file: 'y.ts', line: 90, severity: 'critical', title: 'boom' }),
  ]);
  assert.equal(merged[0].id, 'b');
});

test('groupCrossFileByRule collapses 3+ occurrences into relatedLocations', () => {
  const grouped = groupCrossFileByRule([
    finding({ id: 'a', file: 'a.ts', line: 5, ruleId: 'secrets-aws-key', title: 'Hardcoded secret' }),
    finding({ id: 'b', file: 'b.ts', line: 9, ruleId: 'secrets-aws-key', title: 'Hardcoded secret' }),
    finding({ id: 'c', file: 'c.ts', line: 12, ruleId: 'secrets-aws-key', title: 'Hardcoded secret' }),
    finding({ id: 'd', file: 'd.ts', line: 1, ruleId: 'other-rule', title: 'Other' }),
  ]);
  assert.equal(grouped.length, 2);
  const combined = grouped.find(f => f.ruleId === 'secrets-aws-key')!;
  assert.ok(combined.title.includes('found in 3 places'));
  assert.equal(combined.relatedLocations?.length, 2);
});

// ── Throttling ───────────────────────────────────────────────────────────────

test('throttleLowPriorityFindings caps minor/nit per file and keeps critical/major', () => {
  const input = [
    finding({ id: 'crit', severity: 'critical', title: 'critical issue' }),
    ...[1, 2, 3, 4, 5].map(n => finding({ id: `m${n}`, line: n * 10, severity: 'low', category: 'style', title: `nit ${n}` })),
  ];
  const throttled = throttleLowPriorityFindings(input, 3);
  assert.ok(throttled.some(f => f.id === 'crit'));
  const nits = throttled.filter(f => f.id.startsWith('m'));
  assert.equal(nits.length, 3);
  const overflow = throttled.find(f => f.id.startsWith('throttled-'));
  assert.ok(overflow, 'overflow row must exist');
  assert.ok(overflow!.title.includes('2 more minor suggestion'));
});

test('throttleLowPriorityFindings never drops governance findings that feed section panels', () => {
  // Scope / Security / Compliance / Tests sections read these categories out of
  // r.findings — culling them would silently empty those panels.
  ['pm_alignment', 'compliance', 'security', 'test_coverage', 'breaking_change'].forEach(category => {
    const input = [1, 2, 3, 4, 5].map(n => finding({
      id: `${category}${n}`, line: n * 10, severity: 'medium', category: category as never, title: `${category} ${n}`,
    }));
    const throttled = throttleLowPriorityFindings(input, 3);
    assert.equal(
      throttled.filter(f => f.category === category).length,
      5,
      `${category} findings must survive throttling`,
    );
    assert.ok(!throttled.some(f => f.id.startsWith('throttled-')), 'no overflow row for governance categories');
  });
});

test('throttleLowPriorityFindings still caps cosmetic categories', () => {
  ['style', 'vibe_code', 'maintainability', 'performance'].forEach(category => {
    const input = [1, 2, 3, 4, 5].map(n => finding({
      id: `${category}${n}`, line: n * 10, severity: 'low', category: category as never, title: `${category} ${n}`,
    }));
    const throttled = throttleLowPriorityFindings(input, 3);
    // The synthetic overflow row is itself categorised 'style', so count only real findings.
    const real = throttled.filter(f => f.category === category && !f.id.startsWith('throttled-'));
    assert.equal(real.length, 3, `${category} must be capped`);
    assert.ok(throttled.some(f => f.id.startsWith('throttled-')), `${category} overflow must be summarised`);
  });
});

test('clusterByLineOverlap keeps findings with different rule ids apart', () => {
  const clusters = clusterByLineOverlap([
    finding({ id: 'a', line: 10, ruleId: 'injection-sql' }),
    finding({ id: 'b', line: 11, ruleId: 'secrets-aws-key' }),
  ], 3);
  assert.equal(clusters.length, 2, 'distinct rules on adjacent lines are distinct findings');
});

// ── Structured fix bridging ──────────────────────────────────────────────────

test('normalizeStructuredFix derives suggestedFix and codeSnippet from a unified diff', () => {
  const f = normalizeStructuredFix(finding({
    suggestedFix: undefined,
    fix: {
      description: 'Use parameterized query',
      diff: '- db.query("SELECT * FROM users WHERE id = " + id)\n+ db.query("SELECT * FROM users WHERE id = ?", [id])',
      applyable: true,
      applyConfidence: 'high',
    },
  }));
  assert.equal(f.suggestedFix, ' db.query("SELECT * FROM users WHERE id = ?", [id])');
  assert.equal(f.codeSnippet, ' db.query("SELECT * FROM users WHERE id = " + id)');
  assert.equal(f.evidence, f.codeSnippet);
});

test('normalizeStructuredFix never derives an applyable patch from low-confidence fixes', () => {
  const f = normalizeStructuredFix(finding({
    suggestedFix: undefined,
    fix: { description: 'Consider refactor', diff: '- a\n+ b', applyable: true, applyConfidence: 'low' },
  }));
  assert.equal(f.suggestedFix, undefined);
});

test('dedupeSentences drops repeated sentences', () => {
  assert.equal(
    dedupeSentences('Input is unsafe. Input is unsafe. It reaches the query.'),
    'Input is unsafe. It reaches the query.',
  );
});

// ── Full pipeline pass ───────────────────────────────────────────────────────

test('postProcessReviewFindings runs normalize → merge → throttle end to end', () => {
  const result = postProcessReviewFindings([
    finding({ id: 'a', line: 42, severity: 'critical', category: 'security', title: 'SQL injection', source: 'local_engine' }),
    finding({ id: 'b', line: 42, severity: 'high', category: 'security', title: 'SQL injection', source: 'llm' }),
    ...[1, 2, 3, 4, 5, 6].map(n => finding({ id: `nit${n}`, line: n * 7, severity: 'low', category: 'style', title: `style nit ${n}` })),
  ], { maxMinorPerFile: 2 });
  assert.equal(result.filter(f => f.category === 'security').length, 1);
  assert.equal(result.filter(f => f.id.startsWith('nit')).length, 2);
  assert.ok(result.some(f => f.id.startsWith('throttled-')));
});

test('carryForwardUnresolvedMinors keeps prior minors the new run dropped', () => {
  const prior = [
    finding({ id: 'maj', severity: 'high', category: 'correctness', title: 'Null deref' }),
    finding({ id: 'min1', severity: 'medium', category: 'maintainability', title: 'Rename helper', file: 'src/auth.ts' }),
    finding({ id: 'min2', severity: 'low', category: 'style', title: 'Trailing whitespace', file: 'src/other.ts' }),
  ];
  const next = [
    finding({ id: 'new', severity: 'low', category: 'style', title: 'Prefer const', file: 'src/auth.ts' }),
  ];
  const merged = carryForwardUnresolvedMinors(next, prior, {
    changedFiles: ['src/auth.ts'],
  });
  assert.ok(merged.some(f => /rename helper/i.test(f.title)), 'minor in still-changed file must carry');
  assert.ok(!merged.some(f => /trailing whitespace/i.test(f.title)), 'minor in untouched file must drop');
  assert.ok(!merged.some(f => /null deref/i.test(f.title)), 'fixed major must not carry');
});

// Local-only fallback must use the same merge (empty local findings + prior minors).
test('carryForwardUnresolvedMinors works when current findings are empty (local-only path)', () => {
  const prior = [
    finding({ id: 'min1', severity: 'medium', category: 'maintainability', title: 'Rename helper', file: 'src/auth.ts' }),
  ];
  const merged = carryForwardUnresolvedMinors([], prior, { changedFiles: ['src/auth.ts'] });
  assert.equal(merged.length, 1);
  assert.ok(merged[0].id.startsWith('carried-'));
});

// ── Hard FP suppression ──────────────────────────────────────────────────────

test('dropSuppressedFindings removes matching titles and ruleIds', () => {
  const input = [
    finding({ id: '1', title: 'Missing null check on user', ruleId: 'null-check' }),
    finding({ id: '2', title: 'Prefer const over let', ruleId: 'prefer-const' }),
    finding({ id: '3', title: 'SQL injection risk', ruleId: 'sql-inject' }),
  ];
  const { findings, suppressedCount } = dropSuppressedFindings(input, [
    { title: 'Missing null check on user' },
    { ruleId: 'prefer-const' },
  ]);
  assert.equal(suppressedCount, 2);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, '3');
});

test('dropSuppressedFindings does not substring-match related titles', () => {
  const input = [
    finding({ id: '1', title: 'Hardcoded API key in config helper' }),
    finding({ id: '2', title: 'Hardcoded API key in payment webhook' }),
  ];
  const { findings, suppressedCount } = dropSuppressedFindings(input, [
    { title: 'Hardcoded API key in config helper' },
  ]);
  assert.equal(suppressedCount, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, '2');
});

test('dropSuppressedFindings honors session dismissed titles', () => {
  const input = [
    finding({ id: '1', title: 'Nit: trailing whitespace' }),
    finding({ id: '2', title: 'Keep me' }),
  ];
  const { findings, suppressedCount } = dropSuppressedFindings(
    input,
    [],
    ['Nit: trailing whitespace'],
  );
  assert.equal(suppressedCount, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, '2');
});

test('dropSuppressedFindings with file scopes to that file only', () => {
  const input = [
    finding({ id: '1', title: 'Same title', file: 'a.ts' }),
    finding({ id: '2', title: 'Same title', file: 'b.ts' }),
  ];
  const { findings, suppressedCount } = dropSuppressedFindings(input, [
    { title: 'Same title', file: 'a.ts' },
  ]);
  assert.equal(suppressedCount, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, '2');
});

test('postProcessReviewFindings hard-drops suppressed after merge', () => {
  const out = postProcessReviewFindings(
    [
      finding({ id: 'a', title: 'Known false positive nit', severity: 'low', category: 'style' }),
      finding({ id: 'b', title: 'Real bug', severity: 'high', category: 'correctness' }),
    ],
    {
      suppressed: [{ title: 'Known false positive nit' }],
      suppressionStats: { suppressedCount: 0 },
    },
  );
  assert.ok(!out.some(f => /false positive/i.test(f.title)));
  assert.ok(out.some(f => /real bug/i.test(f.title)));
});

// ── Suppression records ─────────────────────────────────────────────────────
const suppressible = (over: Record<string, unknown> = {}) => ({
  id: 'f1', title: 'Console.log left in code', file: 'src/a.ts',
  severity: 'low', category: 'vibe_code', ...over,
}) as never;

test('suppression records: records why a finding was hidden by a prior dismissal', () => {
  const out = dropSuppressedFindings([suppressible()], [], ['console.log left in code']);
  assert.equal(out.findings.length, 0);
  assert.equal(out.suppressedCount, 1);
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].source, 'dismissed');
});

test('suppression records: records the learning that hid a finding, with clickable provenance', () => {
  const out = dropSuppressedFindings([suppressible()], [], undefined, () => ({
    kind: 'scoped',
    score: 1,
    learning: { title: 'console.log left in code', note: 'workers log to stdout', sourceLine: 12 },
  }));
  assert.equal(out.findings.length, 0);
  const record = out.records[0];
  assert.equal(record.source, 'learning');
  assert.equal(record.learningTitle, 'console.log left in code');
  assert.equal(record.learningNote, 'workers log to stdout');
  assert.equal(record.learningSource, '.tyne/learnings.md:12');
  assert.equal(record.matchKind, 'scoped');
});

test('suppression records: attributes an explicit personal dismissal to the person, not the file', () => {
  // Both would match; the per-user list is checked first so the reviewer
  // sees "you dismissed this", not a team learning they never wrote.
  const out = dropSuppressedFindings([suppressible()], [], ['console.log left in code'], () => ({
    kind: 'exact', score: 1, learning: { title: 'console.log left in code', sourceLine: 3 },
  }));
  assert.equal(out.records[0].source, 'dismissed');
});

test('suppression records: keeps findings no learning matches, and records nothing for them', () => {
  const out = dropSuppressedFindings([suppressible()], [], undefined, () => null);
  assert.equal(out.findings.length, 1);
  assert.equal(out.suppressedCount, 0);
  assert.deepEqual(out.records, []);
});

test('suppression records: returns an empty record list when there is nothing to suppress with', () => {
  const out = dropSuppressedFindings([suppressible()], [], undefined, undefined);
  assert.equal(out.findings.length, 1);
  assert.deepEqual(out.records, []);
});

test('suppression records: surfaces records through postProcessReviewFindings for the UI panel', () => {
  const records: Array<Record<string, unknown>> = [];
  const kept = postProcessReviewFindings([suppressible()] as never, {
    changedFiles: [{ path: 'src/a.ts' }],
    suppressionRecords: records as never,
    matchLearning: () => ({ kind: 'exact', score: 1, learning: { title: 'console.log left in code', sourceLine: 5 } }),
  });
  assert.equal(kept.length, 0);
  assert.equal(records.length, 1, 'the pipeline must hand the UI a reason for every hidden finding');
});
