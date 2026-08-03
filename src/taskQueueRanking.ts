import {
  TyneTask,
  TyneTaskProFields,
  TyneNormalizedTaskPriority,
  TyneNormalizedTaskStatus,
} from './taskTypes';

/**
 * Queue ranking answers one question the plain task list never did: of the
 * tasks assigned to me, which one do I open first?
 *
 * Sorting by priority alone is not enough — an "urgent" ticket with no brief
 * and no branch is not actually startable, while a "high" one that already has
 * a branch and half a day of work behind it is. So the score blends importance
 * (priority, due date) with readiness and momentum (brief, branch, commits),
 * and every contribution is reported as a short reason string. Nothing is ever
 * hidden or filtered by ranking: bands reorder the list, they never remove
 * work, which mirrors how recommendTaskOrder treats dependency cycles.
 */

// ── Bands ─────────────────────────────────────────────────────────────────────

/**
 * `now` is deliberately a single task. The question being answered is "what do
 * I start first", and three co-equal recommendations do not answer it.
 */
export type TyneTaskRankBand = 'now' | 'next' | 'later' | 'blocked';

export interface TyneRankedTask extends TyneTask {
  /** 1-based position in the recommended order, across every ranked task. */
  queueRank: number;
  queueBand: TyneTaskRankBand;
  queueScore: number;
  /** Human-readable "why" fragments, most significant first. */
  queueReasons: string[];
}

export interface TyneTaskRankOptions {
  /** Injected so ranking is deterministic under test. */
  now?: Date;
  /** Task backing the active thread — always surfaces as rank 1. */
  activeTaskId?: string;
  /** Ids whose PM brief is stored and usable. */
  briefReadyTaskIds?: Iterable<string>;
  /** Size of the `now` band. */
  startNowLimit?: number;
  /** Size of the `next` band, counted after the `now` band. */
  upNextLimit?: number;
}

// ── Weights ───────────────────────────────────────────────────────────────────

const PRIORITY_SCORE: Record<TyneNormalizedTaskPriority, number> = {
  urgent: 100, high: 70, medium: 40, low: 15, none: 10, unknown: 10,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_COMMIT_DAYS = 3;

/** Terminal work is scored below everything so it sinks under real work. */
const TERMINAL_SCORE = -1;

function isTerminal(status: TyneNormalizedTaskStatus): boolean {
  return status === 'done' || status === 'canceled';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Whole-day difference between a due date and today, so "due today" does not
 * flip to "overdue" purely because of the time of day.
 */
function daysUntil(dueDate: string, now: Date): number | null {
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) { return null; }
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
}

function daysSince(iso: string, now: Date): number | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) { return null; }
  return (now.getTime() - then.getTime()) / DAY_MS;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

interface ScoreResult {
  score: number;
  reasons: string[];
  blocked: boolean;
}

function scoreTask(task: TyneTask, now: Date, briefReady: boolean): ScoreResult {
  // Pro enrichment fields ride along on the cached task when available; absence
  // just means those signals contribute nothing.
  const pro = task as TyneTask & TyneTaskProFields;
  const reasons: string[] = [];

  if (isTerminal(task.normalizedStatus)) {
    return { score: TERMINAL_SCORE, reasons: [], blocked: false };
  }

  let score = PRIORITY_SCORE[task.normalizedPriority] ?? PRIORITY_SCORE.unknown;
  if (task.normalizedPriority === 'urgent' || task.normalizedPriority === 'high') {
    reasons.push(task.normalizedPriority === 'urgent' ? 'Urgent' : 'High priority');
  }

  if (task.dueDate) {
    const days = daysUntil(task.dueDate, now);
    if (days !== null) {
      if (days < 0) { score += 60; reasons.push(days === -1 ? 'Overdue by 1 day' : `Overdue by ${-days} days`); }
      else if (days === 0) { score += 45; reasons.push('Due today'); }
      else if (days <= 2) { score += 30; reasons.push(days === 1 ? 'Due tomorrow' : 'Due in 2 days'); }
      else if (days <= 7) { score += 12; reasons.push('Due this week'); }
    }
  }

  if (task.normalizedStatus === 'in_progress') { score += 50; reasons.push('In progress'); }
  else if (task.normalizedStatus === 'in_review') { score += 20; reasons.push('In review'); }

  // Momentum: work already underway is cheaper to finish than to restart.
  if (pro.linkedBranchName) { score += 25; reasons.push('Branch ready'); }
  const commitDays = pro.latestCommitDate ? daysSince(pro.latestCommitDate, now) : null;
  if (commitDays !== null && commitDays <= RECENT_COMMIT_DAYS) { score += 20; reasons.push('Recent commits'); }
  else if ((pro.commitCount ?? 0) > 0) { score += 10; reasons.push('Has commits'); }
  if ((pro.timeTrackedMinutes ?? 0) > 0) { score += 10; reasons.push('Time logged'); }

  // Readiness is a tie-breaker, not an override: the penalty is small enough
  // that an urgent unbriefed task still outranks a briefed medium one.
  if (briefReady) { score += 15; reasons.push('Brief ready'); }
  else { score -= 12; reasons.push('Needs brief'); }

  return { score, reasons, blocked: task.normalizedStatus === 'blocked' };
}

// ── Ordering ──────────────────────────────────────────────────────────────────

function compareRanked(
  a: { score: number; task: TyneTask; index: number },
  b: { score: number; task: TyneTask; index: number },
): number {
  if (a.score !== b.score) { return b.score - a.score; }
  // Earlier due date first, tasks without a due date last.
  const ad = a.task.dueDate || '￿';
  const bd = b.task.dueDate || '￿';
  if (ad !== bd) { return ad < bd ? -1 : 1; }
  const au = a.task.updatedAt || '';
  const bu = b.task.updatedAt || '';
  if (au !== bu) { return au < bu ? 1 : -1; }
  // Original position last, so equal tasks never reshuffle between renders.
  return a.index - b.index;
}

/**
 * Rank a task list into recommended execution order.
 *
 * Returns every input task — blocked and completed work is banded, not dropped,
 * so the list stays a complete view of what is assigned. The returned order is
 * the recommendation; callers that honour an explicit user sort should keep
 * their own order and read only the attached queue metadata.
 */
export function rankTaskQueue(
  tasks: TyneTask[],
  options: TyneTaskRankOptions = {},
): TyneRankedTask[] {
  const now = options.now ?? new Date();
  const briefReady = new Set(options.briefReadyTaskIds ?? []);
  const startNowLimit = options.startNowLimit ?? 1;
  const upNextLimit = options.upNextLimit ?? 3;

  const scored = tasks.map((task, index) => {
    const { score, reasons, blocked } = scoreTask(task, now, briefReady.has(task.id));
    return { task, index, score, reasons, blocked };
  });

  // The thread's own task is what the developer is working on right now, so it
  // leads regardless of score — the list should agree with the Thread tab.
  const activeId = options.activeTaskId;
  const isActive = (id: string) => Boolean(activeId) && id === activeId;

  const ordered = [...scored].sort((a, b) => {
    const aActive = isActive(a.task.id);
    const bActive = isActive(b.task.id);
    if (aActive !== bActive) { return aActive ? -1 : 1; }
    return compareRanked(a, b);
  });

  let openRank = 0;
  return ordered.map((entry, index) => {
    const active = isActive(entry.task.id);
    const terminal = isTerminal(entry.task.normalizedStatus);
    let band: TyneTaskRankBand;
    if (terminal) {
      band = 'later';
    } else if (entry.blocked) {
      band = 'blocked';
    } else {
      // Bands count only startable work, so a blocked task never consumes the
      // single "start here" slot.
      openRank += 1;
      if (openRank <= startNowLimit) { band = 'now'; }
      else if (openRank <= startNowLimit + upNextLimit) { band = 'next'; }
      else { band = 'later'; }
    }
    const reasons = active ? ['Active thread', ...entry.reasons] : entry.reasons;
    return {
      ...entry.task,
      queueRank: index + 1,
      queueBand: band,
      queueScore: entry.score,
      queueReasons: reasons.slice(0, 3),
    };
  });
}

/**
 * Re-attach queue metadata to a caller-supplied order. Used when the developer
 * picked an explicit sort — they keep their ordering, but still see the
 * priority chip and the "start here" marker.
 */
export function applyRankMetadata(
  ordered: TyneTask[],
  ranked: TyneRankedTask[],
): TyneRankedTask[] {
  const byId = new Map(ranked.map(t => [t.id, t]));
  return ordered.map(t => {
    const match = byId.get(t.id);
    return match ? { ...t, ...pickQueueFields(match) } : withoutRank(t);
  });
}

function pickQueueFields(t: TyneRankedTask) {
  return {
    queueRank: t.queueRank,
    queueBand: t.queueBand,
    queueScore: t.queueScore,
    queueReasons: t.queueReasons,
  };
}

function withoutRank(t: TyneTask): TyneRankedTask {
  return { ...t, queueRank: 0, queueBand: 'later', queueScore: 0, queueReasons: [] };
}
