/**
 * Stale-learning detection.
 *
 * Suppression lists rot silently. A learning added for a subsystem that has
 * since been rewritten keeps hiding findings nobody has looked at in a year,
 * and nothing in a normal workflow ever prompts a team to re-read it. That is
 * the failure mode this exists to make visible.
 *
 * The two halves rot differently, and the asymmetry matters:
 *
 *   suppression — a stale one silently hides real bugs. Dangerous.
 *   rule        — a stale one merely never fires. Untidy.
 *
 * So suppressions are reported first and at a lower evidence bar.
 *
 * Pure: callers pass rows in, this decides. No database, no Deno globals.
 */

export type LearningKind = 'rule' | 'suppression';

export interface UsageRow {
  kind: string;
  rule_hash: string;
  rule_text: string;
  rule_scope?: string | null;
  findings_count: number;
  created_at: string;
}

export interface StaleLearning {
  kind: LearningKind;
  hash: string;
  text: string;
  scope?: string;
  /** Reviews this entry was evaluated in during the window. */
  evaluations: number;
  /** ISO date it was last evaluated. */
  lastSeen: string;
  /** Why it is being surfaced, in reviewer-facing words. */
  reason: string;
}

/**
 * How many reviews an entry must have sat through doing nothing before it is
 * worth interrupting anyone about.
 *
 * Suppressions get the lower bar because their failure mode is dangerous, and
 * because a suppression that never matched is *by definition* not protecting
 * anyone from noise — there is no cost to questioning it.
 */
export const MIN_EVALUATIONS = { suppression: 5, rule: 10 } as const;

/** Nothing is called stale until it has had time to be relevant. */
export const MIN_AGE_DAYS = 14;

/** Cap so the notice stays a nudge rather than a chore list. */
export const MAX_REPORTED = 5;

function daysBetween(from: string, to: number): number {
  const start = Date.parse(from);
  if (!Number.isFinite(start)) { return 0; }
  return Math.floor((to - start) / 86_400_000);
}

/**
 * Group usage rows per entry and return the ones that have been evaluated
 * repeatedly, over a long enough span, and never once acted on.
 *
 * A single non-zero `findings_count` anywhere in the window disqualifies an
 * entry entirely — it has demonstrably done something, and "did something
 * once, a while ago" is not evidence of rot.
 */
export function findStaleLearnings(rows: UsageRow[], now: number = Date.now()): StaleLearning[] {
  const grouped = new Map<string, {
    kind: LearningKind;
    text: string;
    scope?: string;
    evaluations: number;
    fired: number;
    firstSeen: string;
    lastSeen: string;
  }>();

  for (const row of rows || []) {
    const kind: LearningKind = row?.kind === 'suppression' ? 'suppression' : 'rule';
    const hash = String(row?.rule_hash || '');
    if (!hash) { continue; }
    const key = `${kind}:${hash}`;
    const createdAt = String(row?.created_at || '');

    const entry = grouped.get(key);
    if (!entry) {
      grouped.set(key, {
        kind,
        text: String(row?.rule_text || ''),
        scope: row?.rule_scope || undefined,
        evaluations: 1,
        fired: Number(row?.findings_count) || 0,
        firstSeen: createdAt,
        lastSeen: createdAt,
      });
      continue;
    }
    entry.evaluations += 1;
    entry.fired += Number(row?.findings_count) || 0;
    if (createdAt && createdAt < entry.firstSeen) { entry.firstSeen = createdAt; }
    if (createdAt && createdAt > entry.lastSeen) { entry.lastSeen = createdAt; }
  }

  const stale: StaleLearning[] = [];
  for (const [key, entry] of grouped) {
    if (entry.fired > 0) { continue; }
    if (entry.evaluations < MIN_EVALUATIONS[entry.kind]) { continue; }
    const ageDays = daysBetween(entry.firstSeen, now);
    if (ageDays < MIN_AGE_DAYS) { continue; }

    stale.push({
      kind: entry.kind,
      hash: key.slice(key.indexOf(':') + 1),
      text: entry.text,
      scope: entry.scope,
      evaluations: entry.evaluations,
      lastSeen: entry.lastSeen.slice(0, 10),
      reason: entry.kind === 'suppression'
        ? `Hidden nothing in ${entry.evaluations} reviews over ${ageDays} days — it may be protecting you from a finding that no longer occurs.`
        : `Checked in ${entry.evaluations} reviews over ${ageDays} days without ever matching — the code may already follow it, or it may be unenforceable.`,
    });
  }

  // Suppressions first (dangerous rot), then by how long they have been idle.
  return stale
    .sort((a, b) =>
      (a.kind === b.kind ? b.evaluations - a.evaluations : a.kind === 'suppression' ? -1 : 1))
    .slice(0, MAX_REPORTED);
}
