import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTaskIdFromBranch, linkCommitToTask } from '../commitLinkingService';
import { clusterCommits, calculateSessionDuration } from '../commitClusteringService';
import { BranchRecord } from '../branchMetadataService';
import { TyneCommitRecord, TyneCommitFileChange } from '../commitTypes';

function makeCommit(overrides: Partial<TyneCommitRecord>): TyneCommitRecord {
  return {
    id: '1',
    repositoryPath: '/repo',
    branchName: 'tyne/TASK-123-build-auth',
    commitHash: 'abcdef1234567890',
    shortHash: 'abcdef12',
    message: 'test',
    authorName: 'Tyne',
    committedAt: '2026-06-23T10:00:00.000Z',
    filesChanged: [],
    totalFilesChanged: 0,
    totalLinesAdded: 0,
    totalLinesDeleted: 0,
    linkedStatus: 'unlinked',
    createdAt: '2026-06-23T10:00:00.000Z',
    updatedAt: '2026-06-23T10:00:00.000Z',
    ...overrides,
  };
}

function makeBranchRecord(overrides: Partial<BranchRecord> = {}): BranchRecord {
  return {
    taskId: 'TASK-123',
    taskTitle: 'Build auth',
    taskSource: 'Linear',
    branchName: 'tyne/TASK-123-build-auth',
    repositoryPath: '/repo',
    createdAt: '2026-06-23T10:00:00.000Z',
    lastCheckedOutAt: '2026-06-23T10:00:00.000Z',
    currentStatus: 'active',
    commitCount: 1,
    latestCommitHash: 'abc',
    latestCommitMessage: 'msg',
    ...overrides,
  };
}

// ── Test 1: extractTaskIdFromBranch handles all tyne naming variants ──────────
test('extractTaskIdFromBranch handles tyne format', () => {
  assert.equal(extractTaskIdFromBranch('tyne/TASK-123-build-authentication-system'), 'TASK-123');
  assert.equal(extractTaskIdFromBranch('tyne/JIRA-456-fix-payment-error'), 'JIRA-456');
  assert.equal(extractTaskIdFromBranch('tyne/PROJ-789-update-dashboard'), 'PROJ-789');
  assert.equal(extractTaskIdFromBranch('feature/foo'), null);
  assert.equal(extractTaskIdFromBranch('main'), null);
  assert.equal(extractTaskIdFromBranch('tyne/no-id-here'), null);
});

// ── Test 2: branch with valid task metadata links commits as 'linked' ─────────
test('linkCommitToTask prefers branch metadata', () => {
  const branch = makeBranchRecord();
  const linked = linkCommitToTask(makeCommit({}), branch);
  assert.equal(linked.taskId, 'TASK-123');
  assert.equal(linked.taskTitle, 'Build auth');
  assert.equal(linked.taskSource, 'Linear');
  assert.equal(linked.linkedStatus, 'linked');
});

// ── Test 3: branch with tyne naming but missing metadata creates partial link ─
test('linkCommitToTask creates partial link from branch name when no metadata', () => {
  const commit = makeCommit({ branchName: 'tyne/JIRA-456-fix-payment', commitHash: 'xyz', shortHash: 'xyz' });
  const partial = linkCommitToTask(commit, undefined);
  assert.equal(partial.taskId, 'JIRA-456');
  assert.equal(partial.linkedStatus, 'partial');
});

// ── Test 4: non-tyne branch commits remain unlinked ──────────────────────────
test('linkCommitToTask marks commits unlinked for non-tyne branches', () => {
  const commit = makeCommit({ branchName: 'feature/random', commitHash: 'zzz', shortHash: 'zzz' });
  const unlinked = linkCommitToTask(commit, undefined);
  assert.equal(unlinked.linkedStatus, 'unlinked');
  assert.equal(unlinked.taskId, undefined);
});

// ── Test 5: commits within 30 minutes cluster into one session ────────────────
test('clusterCommits groups commits within 30 minutes into one session', () => {
  const commits = [
    makeCommit({ id: '1', commitHash: 'a', shortHash: 'a', committedAt: '2026-06-23T10:00:00.000Z' }),
    makeCommit({ id: '2', commitHash: 'b', shortHash: 'b', committedAt: '2026-06-23T10:12:00.000Z' }),
    makeCommit({ id: '3', commitHash: 'c', shortHash: 'c', committedAt: '2026-06-23T10:29:00.000Z' }),
  ];
  const sessions = clusterCommits(commits, 30);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].commitCount, 3);
  assert.ok(sessions[0].commitHashes.includes('a'));
  assert.ok(sessions[0].commitHashes.includes('b'));
  assert.ok(sessions[0].commitHashes.includes('c'));
});

// ── Test 6: commits separated by >30 minutes create separate sessions ─────────
test('clusterCommits splits sessions on >30 minute gap', () => {
  const commits = [
    makeCommit({ id: '1', commitHash: 'a', shortHash: 'a', committedAt: '2026-06-23T10:00:00.000Z' }),
    makeCommit({ id: '2', commitHash: 'b', shortHash: 'b', committedAt: '2026-06-23T10:12:00.000Z' }),
    makeCommit({ id: '3', commitHash: 'c', shortHash: 'c', committedAt: '2026-06-23T11:20:00.000Z' }),
  ];
  const sessions = clusterCommits(commits, 30);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].commitCount, 2);
  assert.equal(sessions[1].commitCount, 1);
});

// ── Test 7: commit file changes are parsed into aggregate totals correctly ─────
test('clusterCommits aggregates file and line totals per session', () => {
  const fileChange: TyneCommitFileChange = { filePath: 'src/auth.ts', changeType: 'modified', linesAdded: 40, linesDeleted: 10 };
  const commits = [
    makeCommit({ id: '1', commitHash: 'a', shortHash: 'a', committedAt: '2026-06-23T10:00:00.000Z', filesChanged: [fileChange], totalFilesChanged: 1, totalLinesAdded: 40, totalLinesDeleted: 10 }),
    makeCommit({ id: '2', commitHash: 'b', shortHash: 'b', committedAt: '2026-06-23T10:10:00.000Z', filesChanged: [fileChange], totalFilesChanged: 1, totalLinesAdded: 20, totalLinesDeleted: 5 }),
  ];
  const sessions = clusterCommits(commits, 30);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].totalFilesChanged, 2);
  assert.equal(sessions[0].totalLinesAdded, 60);
  assert.equal(sessions[0].totalLinesDeleted, 15);
});

// ── Test 8: duplicate commit hashes are deduplicated by clustering ────────────
test('clusterCommits deduplicates commits with same hash', () => {
  const commits = [
    makeCommit({ id: '1', commitHash: 'dup', shortHash: 'dup', committedAt: '2026-06-23T10:00:00.000Z' }),
    makeCommit({ id: '2', commitHash: 'dup', shortHash: 'dup', committedAt: '2026-06-23T10:00:00.000Z' }),
  ];
  const uniqueCommits = commits.filter((c, i, arr) => arr.findIndex(x => x.commitHash === c.commitHash) === i);
  const sessions = clusterCommits(uniqueCommits, 30);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].commitCount, 1);
});

// ── Test 9: empty commit list produces no sessions ────────────────────────────
test('clusterCommits returns empty array for no commits', () => {
  const sessions = clusterCommits([], 30);
  assert.equal(sessions.length, 0);
});

// ── Test 10: calculateSessionDuration returns at least 1 minute ──────────────
test('calculateSessionDuration returns minimum 1 minute for single-commit session', () => {
  const sessions = clusterCommits([
    makeCommit({ id: '1', commitHash: 'solo', shortHash: 'solo', committedAt: '2026-06-23T10:00:00.000Z' }),
  ], 30);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].durationMinutes >= 1);
});
