import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeveloperAnalytics,
  calculateProductivityScore,
  listAnalyticsTasks,
} from '../developerAnalytics';
import { TyneCommitSession } from '../commitTypes';
import { TyneManualTimeEntry, TyneTimeLog } from '../timeTypes';

function makeLog(overrides: Partial<TyneTimeLog> = {}): TyneTimeLog {
  return {
    id: 'auto:1',
    repositoryPath: '/repo',
    branchName: 'tyne/feat',
    taskId: 'T-1',
    source: 'automatic_git',
    startTime: '2026-07-21T09:00:00.000Z',
    endTime: '2026-07-21T09:50:00.000Z',
    durationMinutes: 50,
    commitHashes: ['a', 'b'],
    createdAt: '2026-07-21T09:00:00.000Z',
    updatedAt: '2026-07-21T09:50:00.000Z',
    ...overrides,
  };
}

function makeManual(overrides: Partial<TyneManualTimeEntry> = {}): TyneManualTimeEntry {
  return {
    id: 'm1',
    repositoryPath: '/repo',
    date: '2026-07-21',
    durationMinutes: 10,
    note: 'debugging type error',
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

function makeSession(overrides: Partial<TyneCommitSession> = {}): TyneCommitSession {
  return {
    id: 's1',
    repositoryPath: '/repo',
    branchName: 'tyne/feat',
    taskId: 'T-1',
    startTime: '2026-07-21T09:00:00.000Z',
    endTime: '2026-07-21T09:50:00.000Z',
    durationMinutes: 50,
    commitCount: 2,
    commitHashes: ['a', 'b'],
    totalFilesChanged: 4,
    totalLinesAdded: 200,
    totalLinesDeleted: 20,
    createdAt: '2026-07-21T09:00:00.000Z',
    updatedAt: '2026-07-21T09:50:00.000Z',
    ...overrides,
  };
}

test('buildDeveloperAnalytics aggregates time, code, and AI', () => {
  const a = buildDeveloperAnalytics({
    taskTitle: 'Add OAuth',
    branchName: 'tyne/feat',
    logs: [makeLog()],
    manuals: [makeManual(), makeManual({ id: 'm2', durationMinutes: 14, note: 'running unit tests' })],
    sessions: [makeSession()],
    validationRuns: 3,
    recentModels: ['gpt-4o-mini', 'gpt-4o-mini', 'claude-sonnet-4-20250514'],
    qualityScore: 82,
    taskSummary: {
      id: 'sum',
      repositoryPath: '/repo',
      dateRange: { start: '2026-07-21', end: '2026-07-21' },
      totalMinutes: 74,
      automaticMinutes: 50,
      manualMinutes: 24,
      overrideMinutes: 0,
      sessionCount: 1,
      commitCount: 2,
      updatedAt: '2026-07-21T10:00:00.000Z',
    },
  });

  assert.equal(a.timeBreakdown.coding, 50);
  assert.equal(a.timeBreakdown.debugging, 10);
  assert.equal(a.timeBreakdown.testing, 14);
  assert.equal(a.codeMetrics.linesAdded, 200);
  assert.equal(a.codeMetrics.commitCount, 2);
  assert.ok(a.codeMetrics.locPerHour > 0);
  assert.equal(a.aiUsed.primaryModel, 'gpt-4o-mini');
  assert.equal(a.aiUsed.models.length, 2);
  assert.ok(a.productivityScore >= 50);
  assert.ok(a.timeline.length >= 2);
  assert.equal(a.trackingAccuracy, 'hybrid');
});

test('calculateProductivityScore rewards fast clean work', () => {
  const high = calculateProductivityScore({
    locPerHour: 180,
    qualityScore: 90,
    debuggingPercent: 3,
    aiAssistanceRatio: 40,
    commitCount: 4,
  });
  const low = calculateProductivityScore({
    locPerHour: 20,
    qualityScore: 40,
    debuggingPercent: 40,
    aiAssistanceRatio: 95,
    commitCount: 0,
  });
  assert.ok(high > low);
  assert.ok(high >= 80);
});

test('listAnalyticsTasks groups by task with totals', () => {
  const tasks = listAnalyticsTasks(
    [makeLog({ taskId: 'T-1', taskTitle: 'OAuth', durationMinutes: 50 }), makeLog({ id: 'auto:2', taskId: 'T-2', taskTitle: 'Other', durationMinutes: 20 })],
    [makeManual({ taskId: 'T-1', taskTitle: 'OAuth', durationMinutes: 10 })],
    [],
  );
  assert.equal(tasks[0].taskId, 'T-1');
  assert.equal(tasks[0].totalMinutes, 60);
  assert.equal(tasks.length, 2);
});

test('waiting gaps appear between distant sessions', () => {
  const a = buildDeveloperAnalytics({
    taskId: 'T-1',
    taskTitle: 'Add OAuth',
    logs: [
      makeLog({ startTime: '2026-07-21T09:00:00.000Z', endTime: '2026-07-21T09:50:00.000Z', durationMinutes: 50 }),
      makeLog({
        id: 'auto:2',
        startTime: '2026-07-21T11:30:00.000Z',
        endTime: '2026-07-21T11:40:00.000Z',
        durationMinutes: 10,
      }),
    ],
    manuals: [],
    sessions: [makeSession()],
  });
  assert.ok(a.timeBreakdown.waiting >= 30);
  assert.ok(a.timeline.some(t => t.activity === 'waiting'));
  assert.equal(a.taskId, 'T-1');
});
