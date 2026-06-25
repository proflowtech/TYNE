import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeLogFromSession } from '../timeTrackingService';
import { validateManualTimeEntry } from '../manualTimeEntryService';
import {
  getTaskTimeSummary,
  getBranchTimeSummary,
  getProjectTimeSummary,
  getDailyTimeSummary,
  getWeeklyTimeSummary,
  getMonthlyTimeSummary,
  getTimeBreakdown,
  formatDuration,
} from '../timeSummaryService';
import { TyneCommitSession } from '../commitTypes';
import { TyneTimeLog, TyneManualTimeEntry } from '../timeTypes';

function makeSession(overrides: Partial<TyneCommitSession> = {}): TyneCommitSession {
  return {
    id: 'branch:abc',
    repositoryPath: '/repo',
    branchName: 'tyne/TASK-1-auth',
    taskId: 'TASK-1',
    taskTitle: 'Build auth',
    taskSource: 'Linear',
    startTime: '2026-06-23T10:00:00.000Z',
    endTime: '2026-06-23T10:28:00.000Z',
    durationMinutes: 28,
    commitCount: 3,
    commitHashes: ['a', 'b', 'c'],
    totalFilesChanged: 3,
    totalLinesAdded: 60,
    totalLinesDeleted: 10,
    createdAt: '2026-06-23T10:00:00.000Z',
    updatedAt: '2026-06-23T10:28:00.000Z',
    ...overrides,
  };
}

function makeTimeLog(overrides: Partial<TyneTimeLog> = {}): TyneTimeLog {
  return {
    id: 'auto:branch:abc',
    repositoryPath: '/repo',
    branchName: 'tyne/TASK-1-auth',
    taskId: 'TASK-1',
    taskTitle: 'Build auth',
    source: 'automatic_git',
    startTime: '2026-06-23T10:00:00.000Z',
    endTime: '2026-06-23T10:28:00.000Z',
    durationMinutes: 28,
    originalDurationMinutes: 28,
    commitSessionId: 'branch:abc',
    commitHashes: ['a', 'b', 'c'],
    createdAt: '2026-06-23T10:00:00.000Z',
    updatedAt: '2026-06-23T10:28:00.000Z',
    ...overrides,
  };
}

function makeManualEntry(overrides: Partial<TyneManualTimeEntry> = {}): TyneManualTimeEntry {
  return {
    id: 'manual:1',
    repositoryPath: '/repo',
    taskId: 'TASK-1',
    taskTitle: 'Build auth',
    date: '2026-06-23',
    durationMinutes: 30,
    createdAt: '2026-06-23T11:00:00.000Z',
    updatedAt: '2026-06-23T11:00:00.000Z',
    ...overrides,
  };
}

function makeFakeContext(logs: TyneTimeLog[], manuals: TyneManualTimeEntry[]) {
  return {
    workspaceState: {
      get(key: string, def: unknown) {
        if (key === 'tyne.timeLogs') { return logs; }
        if (key === 'tyne.manualTimeEntries') { return manuals; }
        return def;
      },
      update() { return Promise.resolve(); },
    },
  } as unknown as import('vscode').ExtensionContext;
}

// ── Test 1: Three commits within 30 min → one time log, correct duration ──────
test('buildTimeLogFromSession: 3-commit session returns correct duration', () => {
  const session = makeSession();
  const log = buildTimeLogFromSession(session, '/repo', 'my-repo');
  assert.equal(log.source, 'automatic_git');
  assert.equal(log.durationMinutes, 28);
  assert.equal(log.commitHashes?.length, 3);
  assert.equal(log.branchName, 'tyne/TASK-1-auth');
  assert.equal(log.taskId, 'TASK-1');
});

// ── Test 2: Single commit session returns 0 minutes ───────────────────────────
test('buildTimeLogFromSession: single commit returns 0 minutes', () => {
  const session = makeSession({
    commitCount: 1,
    commitHashes: ['solo'],
    startTime: '2026-06-23T10:00:00.000Z',
    endTime: '2026-06-23T10:00:00.000Z',
    durationMinutes: 1,
  });
  const log = buildTimeLogFromSession(session, '/repo');
  assert.equal(log.durationMinutes, 0);
  assert.ok(log.note?.includes('Single commit'));
});

// ── Test 3: Manual entry validation — valid entry passes ──────────────────────
test('validateManualTimeEntry: valid entry has no errors', () => {
  const errors = validateManualTimeEntry({ repositoryPath: '/repo', date: '2026-06-23', durationMinutes: 45 });
  assert.equal(errors.length, 0);
});

// ── Test 4: Manual entry validation — missing date fails ─────────────────────
test('validateManualTimeEntry: missing date returns error', () => {
  const errors = validateManualTimeEntry({ repositoryPath: '/repo', date: '', durationMinutes: 30 });
  assert.ok(errors.some(e => e.field === 'date'));
});

// ── Test 5: Manual entry validation — zero duration fails ────────────────────
test('validateManualTimeEntry: zero duration returns error', () => {
  const errors = validateManualTimeEntry({ repositoryPath: '/repo', date: '2026-06-23', durationMinutes: 0 });
  assert.ok(errors.some(e => e.field === 'durationMinutes'));
});

// ── Test 6: Manual entry validation — end before start fails ─────────────────
test('validateManualTimeEntry: end before start returns error', () => {
  const errors = validateManualTimeEntry({
    repositoryPath: '/repo',
    date: '2026-06-23',
    durationMinutes: 30,
    startTime: '11:00',
    endTime: '10:00',
  });
  assert.ok(errors.some(e => e.field === 'endTime'));
});

// ── Test 7: Task time summary combines auto + manual ─────────────────────────
test('getTaskTimeSummary: combines automatic and manual minutes', () => {
  const log = makeTimeLog();
  const manual = makeManualEntry();
  const ctx = makeFakeContext([log], [manual]);
  const summary = getTaskTimeSummary(ctx, '/repo', 'TASK-1');
  assert.equal(summary.automaticMinutes, 28);
  assert.equal(summary.manualMinutes, 30);
  assert.equal(summary.totalMinutes, 58);
});

// ── Test 8: Branch time summary is branch-scoped ─────────────────────────────
test('getBranchTimeSummary: only counts logs for the specified branch', () => {
  const log1 = makeTimeLog({ branchName: 'tyne/TASK-1-auth' });
  const log2 = makeTimeLog({ id: 'auto:other', branchName: 'tyne/TASK-2-other', durationMinutes: 10 });
  const ctx = makeFakeContext([log1, log2], []);
  const summary = getBranchTimeSummary(ctx, '/repo', 'tyne/TASK-1-auth');
  assert.equal(summary.automaticMinutes, 28);
  assert.equal(summary.totalMinutes, 28);
});

// ── Test 9: Project summary aggregates all branches ──────────────────────────
test('getProjectTimeSummary: aggregates all logs for the repository', () => {
  const log1 = makeTimeLog({ durationMinutes: 28 });
  const log2 = makeTimeLog({ id: 'auto:branch2', branchName: 'tyne/TASK-2-dash', durationMinutes: 15 });
  const manual = makeManualEntry({ durationMinutes: 20 });
  const ctx = makeFakeContext([log1, log2], [manual]);
  const summary = getProjectTimeSummary(ctx, '/repo');
  assert.equal(summary.automaticMinutes, 43);
  assert.equal(summary.manualMinutes, 20);
  assert.equal(summary.totalMinutes, 63);
});

// ── Test 10: Daily summary is scoped to correct day ──────────────────────────
test('getDailyTimeSummary: only counts logs on the given date', () => {
  const todayLog = makeTimeLog({ startTime: '2026-06-23T10:00:00.000Z', durationMinutes: 28 });
  const otherLog = makeTimeLog({ id: 'auto:yesterday', startTime: '2026-06-22T10:00:00.000Z', durationMinutes: 60 });
  const ctx = makeFakeContext([todayLog, otherLog], []);
  const summary = getDailyTimeSummary(ctx, '/repo', '2026-06-23');
  assert.equal(summary.automaticMinutes, 28);
  assert.equal(summary.totalMinutes, 28);
});

// ── Test 11: Weekly summary is scoped to the week ────────────────────────────
test('getWeeklyTimeSummary: sums logs within the week, excludes outside', () => {
  const inWeek = makeTimeLog({ startTime: '2026-06-23T10:00:00.000Z', durationMinutes: 28 });
  const outWeek = makeTimeLog({ id: 'auto:out', startTime: '2026-06-01T10:00:00.000Z', durationMinutes: 999 });
  const ctx = makeFakeContext([inWeek, outWeek], []);
  const summary = getWeeklyTimeSummary(ctx, '/repo', '2026-06-23');
  assert.equal(summary.automaticMinutes, 28);
});

// ── Test 12: Monthly summary is scoped to the month ──────────────────────────
test('getMonthlyTimeSummary: sums all logs in June 2026', () => {
  const juneLog = makeTimeLog({ startTime: '2026-06-23T10:00:00.000Z', durationMinutes: 28 });
  const mayLog = makeTimeLog({ id: 'auto:may', startTime: '2026-05-15T10:00:00.000Z', durationMinutes: 999 });
  const ctx = makeFakeContext([juneLog, mayLog], []);
  const summary = getMonthlyTimeSummary(ctx, '/repo', '2026-06-01');
  assert.equal(summary.automaticMinutes, 28);
});

// ── Test 13: Breakdown by source ─────────────────────────────────────────────
test('getTimeBreakdown source: returns correct source buckets', () => {
  const log = makeTimeLog();
  const manual = makeManualEntry();
  const ctx = makeFakeContext([log], [manual]);
  const items = getTimeBreakdown(ctx, '/repo', 'source');
  const gitItem = items.find(i => i.label === 'Automatic Git');
  const manualItem = items.find(i => i.label === 'Manual');
  assert.ok(gitItem);
  assert.equal(gitItem!.automaticMinutes, 28);
  assert.ok(manualItem);
  assert.equal(manualItem!.manualMinutes, 30);
});

// ── Test 14: formatDuration formats correctly ─────────────────────────────────
test('formatDuration: formats 0, minutes, hours correctly', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(90), '1h 30m');
  assert.equal(formatDuration(125), '2h 5m');
});

// ── Test 15: Free/Pro/Max — no tier gate, all types produce output ────────────
test('buildTimeLogFromSession: works regardless of tier (no gate)', () => {
  const session = makeSession();
  const log = buildTimeLogFromSession(session, '/repo');
  assert.equal(log.source, 'automatic_git');
  assert.ok(log.id.startsWith('auto:'));
});

// ── Test 16: Breakdown by task groups correctly ───────────────────────────────
test('getTimeBreakdown task: groups by taskId', () => {
  const log1 = makeTimeLog({ taskId: 'TASK-1', durationMinutes: 20 });
  const log2 = makeTimeLog({ id: 'auto:t2', taskId: 'TASK-2', durationMinutes: 15 });
  const ctx = makeFakeContext([log1, log2], []);
  const items = getTimeBreakdown(ctx, '/repo', 'task');
  assert.equal(items.length, 2);
  const t1 = items.find(i => i.label === 'Build auth' || i.label === 'TASK-1');
  assert.ok(t1);
  assert.equal(t1!.automaticMinutes, 20);
});
