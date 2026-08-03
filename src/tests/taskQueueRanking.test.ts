import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTaskQueue, applyRankMetadata, TyneRankedTask } from '../taskQueueRanking';
import { TyneTask, TyneTaskProFields, TyneNormalizedTaskPriority, TyneNormalizedTaskStatus } from '../taskTypes';

const NOW = new Date('2026-07-25T12:00:00.000Z');

function iso(daysFromNow: number): string {
  return new Date(NOW.getTime() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

let seq = 0;

function task(
  over: Partial<TyneTask & TyneTaskProFields> & { id?: string } = {},
): TyneTask & TyneTaskProFields {
  seq += 1;
  return {
    id: over.id ?? `t${seq}`,
    externalId: over.externalId ?? `PRO-${seq}`,
    title: over.title ?? `Task ${seq}`,
    status: over.status ?? 'To Do',
    normalizedStatus: (over.normalizedStatus ?? 'todo') as TyneNormalizedTaskStatus,
    normalizedPriority: (over.normalizedPriority ?? 'medium') as TyneNormalizedTaskPriority,
    sourceTool: over.sourceTool ?? 'jira',
    lastSyncedAt: NOW.toISOString(),
    cachedAt: NOW.toISOString(),
    ...over,
  };
}

const byId = (ranked: TyneRankedTask[], id: string) => ranked.find(t => t.id === id)!;

describe('rankTaskQueue ordering', () => {
  test('urgent outranks medium at equal readiness', () => {
    const ranked = rankTaskQueue(
      [task({ id: 'med', normalizedPriority: 'medium' }), task({ id: 'urgent', normalizedPriority: 'urgent' })],
      { now: NOW },
    );
    assert.equal(ranked[0].id, 'urgent');
    assert.equal(byId(ranked, 'urgent').queueRank, 1);
  });

  test('overdue medium outranks a not-yet-due urgent', () => {
    const ranked = rankTaskQueue([
      task({ id: 'urgent', normalizedPriority: 'urgent' }),
      task({ id: 'overdue', normalizedPriority: 'medium', dueDate: iso(-3) }),
    ], { now: NOW });
    // medium 40 + overdue 60 = 100 vs urgent 100 — tie broken by due date.
    assert.equal(ranked[0].id, 'overdue');
    assert.ok(byId(ranked, 'overdue').queueReasons.includes('Overdue by 3 days'));
  });

  test('in-flight work with a branch outranks an unstarted urgent task', () => {
    const ranked = rankTaskQueue([
      task({ id: 'fresh', normalizedPriority: 'urgent' }),
      task({
        id: 'inflight',
        normalizedPriority: 'high',
        normalizedStatus: 'in_progress',
        linkedBranchName: 'feat/inflight',
      }),
    ], { now: NOW, briefReadyTaskIds: ['inflight'] });
    assert.equal(ranked[0].id, 'inflight');
    const reasons = byId(ranked, 'inflight').queueReasons;
    assert.ok(reasons.includes('In progress'));
  });

  test('readiness never flips priority on its own', () => {
    // Urgent with no brief (100 - 12 = 88) still beats briefed high (70 + 15 = 85).
    const ranked = rankTaskQueue([
      task({ id: 'briefed_high', normalizedPriority: 'high' }),
      task({ id: 'raw_urgent', normalizedPriority: 'urgent' }),
    ], { now: NOW, briefReadyTaskIds: ['briefed_high'] });
    assert.equal(ranked[0].id, 'raw_urgent');
  });

  test('due-today beats due-this-week at equal priority', () => {
    const ranked = rankTaskQueue([
      task({ id: 'week', dueDate: iso(6) }),
      task({ id: 'today', dueDate: iso(0) }),
    ], { now: NOW });
    assert.equal(ranked[0].id, 'today');
    assert.ok(byId(ranked, 'today').queueReasons.includes('Due today'));
    assert.ok(byId(ranked, 'week').queueReasons.includes('Due this week'));
  });

  test('due date late in the day still reads as due today, not overdue', () => {
    // Built in local time on purpose: "today" is the developer's calendar day,
    // so the comparison must not flip to overdue late in the evening.
    const dueEarly = new Date(2026, 6, 25, 1, 0, 0);
    const lateEvening = new Date(2026, 6, 25, 23, 30, 0);
    const ranked = rankTaskQueue(
      [task({ id: 'edge', dueDate: dueEarly.toISOString() })],
      { now: lateEvening },
    );
    assert.ok(byId(ranked, 'edge').queueReasons.includes('Due today'));
  });

  test('ordering is stable for identical tasks', () => {
    const a = task({ id: 'a', title: 'Same' });
    const b = task({ id: 'b', title: 'Same' });
    const first = rankTaskQueue([a, b], { now: NOW }).map(t => t.id);
    const second = rankTaskQueue([a, b], { now: NOW }).map(t => t.id);
    assert.deepEqual(first, ['a', 'b']);
    assert.deepEqual(second, ['a', 'b']);
  });
});

describe('rankTaskQueue bands', () => {
  test('exactly one task lands in the now band', () => {
    const ranked = rankTaskQueue(
      [task({ normalizedPriority: 'urgent' }), task({ normalizedPriority: 'high' }), task()],
      { now: NOW },
    );
    assert.equal(ranked.filter(t => t.queueBand === 'now').length, 1);
    assert.equal(ranked[0].queueBand, 'now');
  });

  test('next band holds the following three startable tasks', () => {
    const ranked = rankTaskQueue(Array.from({ length: 6 }, () => task()), { now: NOW });
    assert.equal(ranked.filter(t => t.queueBand === 'next').length, 3);
    assert.equal(ranked.filter(t => t.queueBand === 'later').length, 2);
  });

  test('blocked tasks are banded, never dropped, and do not consume the now slot', () => {
    const ranked = rankTaskQueue([
      task({ id: 'blocked', normalizedPriority: 'urgent', normalizedStatus: 'blocked' }),
      task({ id: 'open', normalizedPriority: 'low' }),
    ], { now: NOW });
    assert.equal(ranked.length, 2);
    assert.equal(byId(ranked, 'blocked').queueBand, 'blocked');
    assert.equal(byId(ranked, 'open').queueBand, 'now');
  });

  test('done work sinks to the bottom and is never recommended', () => {
    const ranked = rankTaskQueue([
      task({ id: 'done', normalizedPriority: 'urgent', normalizedStatus: 'done' }),
      task({ id: 'open', normalizedPriority: 'low' }),
    ], { now: NOW });
    assert.equal(ranked[0].id, 'open');
    assert.equal(byId(ranked, 'done').queueBand, 'later');
    assert.deepEqual(byId(ranked, 'done').queueReasons, []);
  });

  test('the active thread task leads regardless of score', () => {
    const ranked = rankTaskQueue([
      task({ id: 'urgent', normalizedPriority: 'urgent', dueDate: iso(-5) }),
      task({ id: 'active', normalizedPriority: 'low' }),
    ], { now: NOW, activeTaskId: 'active' });
    assert.equal(ranked[0].id, 'active');
    assert.equal(ranked[0].queueBand, 'now');
    assert.equal(ranked[0].queueReasons[0], 'Active thread');
  });

  test('band sizes are configurable', () => {
    const ranked = rankTaskQueue(Array.from({ length: 5 }, () => task()), {
      now: NOW, startNowLimit: 2, upNextLimit: 1,
    });
    assert.equal(ranked.filter(t => t.queueBand === 'now').length, 2);
    assert.equal(ranked.filter(t => t.queueBand === 'next').length, 1);
  });
});

describe('rankTaskQueue reasons', () => {
  test('every startable task explains itself', () => {
    const ranked = rankTaskQueue([task({ normalizedPriority: 'urgent' })], { now: NOW });
    assert.ok(ranked[0].queueReasons.length > 0);
    assert.ok(ranked[0].queueReasons.length <= 3);
  });

  test('an unbriefed task says so', () => {
    const ranked = rankTaskQueue([task({ id: 'raw' })], { now: NOW });
    assert.ok(byId(ranked, 'raw').queueReasons.includes('Needs brief'));
  });

  test('malformed dates are ignored rather than throwing', () => {
    const ranked = rankTaskQueue(
      [task({ id: 'bad', dueDate: 'not-a-date', latestCommitDate: 'nope' })],
      { now: NOW },
    );
    assert.equal(ranked.length, 1);
    assert.ok(Number.isFinite(byId(ranked, 'bad').queueScore));
  });
});

describe('applyRankMetadata', () => {
  test('keeps the caller order but carries the queue fields across', () => {
    const tasks = [task({ id: 'a', normalizedPriority: 'low' }), task({ id: 'b', normalizedPriority: 'urgent' })];
    const ranked = rankTaskQueue(tasks, { now: NOW });
    const merged = applyRankMetadata(tasks, ranked);
    assert.deepEqual(merged.map(t => t.id), ['a', 'b']);
    assert.equal(byId(merged, 'b').queueBand, 'now');
    assert.equal(byId(merged, 'b').queueRank, 1);
  });

  test('tasks missing from the ranked set degrade to unranked', () => {
    const merged = applyRankMetadata([task({ id: 'ghost' })], []);
    assert.equal(merged[0].queueRank, 0);
    assert.deepEqual(merged[0].queueReasons, []);
  });
});
