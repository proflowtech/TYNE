import { assertEquals } from 'jsr:@std/assert@1';
import {
  findStaleLearnings, MIN_EVALUATIONS, MIN_AGE_DAYS, MAX_REPORTED, type UsageRow,
} from './staleness.ts';

const NOW = Date.parse('2026-09-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function rows(
  kind: 'rule' | 'suppression',
  hash: string,
  count: number,
  opts: { fired?: number; spreadDays?: number; text?: string } = {},
): UsageRow[] {
  const spread = opts.spreadDays ?? 60;
  return Array.from({ length: count }, (_, i) => ({
    kind,
    rule_hash: hash,
    rule_text: opts.text ?? `${kind} ${hash}`,
    rule_scope: null,
    // Spread evenly across the window so the oldest row sets the age.
    findings_count: i === 0 ? (opts.fired ?? 0) : 0,
    created_at: daysAgo(spread - Math.floor((i * spread) / count)),
  }));
}

Deno.test('flags a suppression that has hidden nothing across many reviews', () => {
  const stale = findStaleLearnings(rows('suppression', 'a1', 8), NOW);
  assertEquals(stale.length, 1);
  assertEquals(stale[0].kind, 'suppression');
  assertEquals(stale[0].evaluations, 8);
});

Deno.test('flags a house rule that has never matched', () => {
  const stale = findStaleLearnings(rows('rule', 'r1', 12), NOW);
  assertEquals(stale.length, 1);
  assertEquals(stale[0].kind, 'rule');
});

Deno.test('a single hit anywhere in the window disqualifies an entry', () => {
  // "Did something once, a while ago" is not rot. One non-zero count is
  // enough to prove the entry still earns its place.
  const stale = findStaleLearnings(rows('suppression', 'a1', 20, { fired: 1 }), NOW);
  assertEquals(stale, []);
});

Deno.test('suppressions are held to a lower evidence bar than rules', () => {
  // A suppression that never matched is by definition not protecting anyone
  // from noise, so there is no cost to questioning it earlier.
  const supp = findStaleLearnings(rows('suppression', 'a1', MIN_EVALUATIONS.suppression), NOW);
  const rule = findStaleLearnings(rows('rule', 'r1', MIN_EVALUATIONS.suppression), NOW);
  assertEquals(supp.length, 1);
  assertEquals(rule.length, 0, 'the same evaluation count must not yet flag a rule');
});

Deno.test('does not flag an entry that has not been evaluated enough times', () => {
  assertEquals(findStaleLearnings(rows('suppression', 'a1', MIN_EVALUATIONS.suppression - 1), NOW), []);
  assertEquals(findStaleLearnings(rows('rule', 'r1', MIN_EVALUATIONS.rule - 1), NOW), []);
});

Deno.test('does not flag a young entry however many reviews it has seen', () => {
  // A rule added yesterday and checked 30 times today is not stale, it is new.
  const young = rows('suppression', 'a1', 30, { spreadDays: MIN_AGE_DAYS - 1 });
  assertEquals(findStaleLearnings(young, NOW), []);
});

Deno.test('reports suppressions before rules', () => {
  const stale = findStaleLearnings([
    ...rows('rule', 'r1', 15),
    ...rows('suppression', 's1', 6),
  ], NOW);
  assertEquals(stale[0].kind, 'suppression', 'the dangerous kind of rot leads');
});

Deno.test('groups rows by kind and hash, not by text', () => {
  // Same hash under both kinds must stay two distinct entries.
  const stale = findStaleLearnings([
    ...rows('rule', 'same', 12),
    ...rows('suppression', 'same', 8),
  ], NOW);
  assertEquals(stale.length, 2);
});

Deno.test('caps how many entries are reported', () => {
  const many: UsageRow[] = [];
  for (let i = 0; i < 20; i++) { many.push(...rows('suppression', `s${i}`, 8)); }
  assertEquals(findStaleLearnings(many, NOW).length, MAX_REPORTED);
});

Deno.test('explains why in reviewer-facing words, differently per kind', () => {
  const [supp] = findStaleLearnings(rows('suppression', 'a1', 8), NOW);
  const [rule] = findStaleLearnings(rows('rule', 'r1', 12), NOW);
  assertEquals(supp.reason.includes('Hidden nothing'), true);
  assertEquals(rule.reason.includes('without ever matching'), true);
});

Deno.test('carries text, scope and last-seen date for display', () => {
  const withScope: UsageRow[] = rows('suppression', 'a1', 8, { text: 'Console.log left in code' })
    .map(r => ({ ...r, rule_scope: 'src/workers/**' }));
  const [entry] = findStaleLearnings(withScope, NOW);
  assertEquals(entry.text, 'Console.log left in code');
  assertEquals(entry.scope, 'src/workers/**');
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(entry.lastSeen), true);
});

Deno.test('tolerates empty and malformed input', () => {
  assertEquals(findStaleLearnings([], NOW), []);
  assertEquals(findStaleLearnings(undefined as unknown as UsageRow[], NOW), []);
  assertEquals(findStaleLearnings([{ kind: 'rule', rule_hash: '', rule_text: '', findings_count: 0, created_at: '' }], NOW), []);
});

Deno.test('an unparseable date does not crash or falsely age an entry', () => {
  const bad = rows('suppression', 'a1', 8).map(r => ({ ...r, created_at: 'not-a-date' }));
  assertEquals(findStaleLearnings(bad, NOW), [], 'age 0 means it cannot pass the age gate');
});
