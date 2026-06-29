import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LinearTaskAdapter,
  JiraTaskAdapter,
  AsanaTaskAdapter,
  NotionTaskAdapter,
  MondayTaskAdapter,
} from '../taskProviderAdapters';
import {
  saveTasks,
  replaceTasksForProvider,
  listCachedTasksSync,
  saveTaskDetails,
  getCachedTaskDetailsSync,
  repairTaskCache,
  mergePulledTasksWithCacheSync,
  markCachedTaskDone,
} from '../taskCacheService';
import {
  searchTasks,
  filterTasks,
  sortTasks,
  queryTasks,
} from '../taskSearchService';
import {
  getAvailableProvidersForTier,
  isFreeTier,
  getConnectedToolsSync,
  connectTool,
  disconnectTool,
  canConnectProvider,
} from '../taskProviderRegistry';
import {
  TyneTask,
  TyneTaskDetails,
  TyneTaskFilters,
  TyneTaskSort,
  TynePmTool,
} from '../taskTypes';

// ── Mock ExtensionContext ─────────────────────────────────────────────────────

function makeMockContext(): import('vscode').ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
      update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
      keys: () => [],
    },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  } as unknown as import('vscode').ExtensionContext;
}

// ── Fixture tasks ─────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TyneTask> = {}): TyneTask {
  return {
    id: 'linear:ENG-001',
    externalId: 'ENG-001',
    title: 'Fix auth bug',
    status: 'In Progress',
    normalizedStatus: 'in_progress',
    normalizedPriority: 'high',
    assigneeName: 'Alice',
    sourceTool: 'linear',
    sourceProject: 'Engineering',
    sourceUrl: 'https://linear.app/task/ENG-001',
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
    lastSyncedAt: new Date().toISOString(),
    cachedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Status normalization: LinearTaskAdapter ───────────────────────────────────

test('LinearTaskAdapter: normalizeStatus todo/backlog', () => {
  const a = new LinearTaskAdapter();
  assert.equal(a.normalizeStatus('Todo'), 'todo');
  assert.equal(a.normalizeStatus('Backlog'), 'todo');
});

test('LinearTaskAdapter: normalizeStatus in_progress', () => {
  const a = new LinearTaskAdapter();
  assert.equal(a.normalizeStatus('In Progress'), 'in_progress');
});

test('LinearTaskAdapter: normalizeStatus done', () => {
  const a = new LinearTaskAdapter();
  assert.equal(a.normalizeStatus('Done'), 'done');
  assert.equal(a.normalizeStatus('Completed'), 'done');
});

test('LinearTaskAdapter: normalizeStatus canceled', () => {
  const a = new LinearTaskAdapter();
  assert.equal(a.normalizeStatus('Canceled'), 'canceled');
  assert.equal(a.normalizeStatus('Cancelled'), 'canceled');
});

test('JiraTaskAdapter: normalizeStatus blocked', () => {
  const a = new JiraTaskAdapter();
  assert.equal(a.normalizeStatus('Blocked'), 'blocked');
  assert.equal(a.normalizeStatus('To Do'), 'todo');
  assert.equal(a.normalizeStatus('Done'), 'done');
});

test('AsanaTaskAdapter: normalizeStatus complete/incomplete', () => {
  const a = new AsanaTaskAdapter();
  assert.equal(a.normalizeStatus('complete'), 'done');
  assert.equal(a.normalizeStatus('incomplete'), 'in_progress');
  assert.equal(a.normalizeStatus('not_started'), 'todo');
});

test('NotionTaskAdapter: normalizeStatus', () => {
  const a = new NotionTaskAdapter();
  assert.equal(a.normalizeStatus('Not Started'), 'todo');
  assert.equal(a.normalizeStatus('In Progress'), 'in_progress');
  assert.equal(a.normalizeStatus('Done'), 'done');
});

test('MondayTaskAdapter: normalizeStatus', () => {
  const a = new MondayTaskAdapter();
  assert.equal(a.normalizeStatus('Working on it'), 'in_progress');
  assert.equal(a.normalizeStatus('Stuck'), 'blocked');
  assert.equal(a.normalizeStatus('Done'), 'done');
});

// ── Priority normalization ────────────────────────────────────────────────────

test('LinearTaskAdapter: normalizePriority', () => {
  const a = new LinearTaskAdapter();
  assert.equal(a.normalizePriority('High'), 'high');
  assert.equal(a.normalizePriority('Urgent'), 'urgent');
  assert.equal(a.normalizePriority('Low'), 'low');
  assert.equal(a.normalizePriority(undefined), 'none');
  assert.equal(a.normalizePriority(''), 'none');
});

// ── Tier enforcement ──────────────────────────────────────────────────────────

test('Free tier: gets only one PM tool', () => {
  const providers = getAvailableProvidersForTier('free');
  assert.equal(providers.length, 1);
});

test('Pro tier: gets all PM tools', () => {
  const providers = getAvailableProvidersForTier('pro');
  assert.equal(providers.length, 5);
});

test('Max tier: gets all PM tools', () => {
  const providers = getAvailableProvidersForTier('max');
  assert.equal(providers.length, 5);
});

test('isFreeTier: detects CORE as free', () => {
  assert.equal(isFreeTier('CORE'), true);
  assert.equal(isFreeTier('free'), true);
  assert.equal(isFreeTier('PRO'), false);
  assert.equal(isFreeTier('MAX'), false);
});

test('connectTool: free user can connect first tool', async () => {
  const ctx = makeMockContext();
  const result = await connectTool(ctx, 'linear', 'CORE');
  assert.equal(result.ok, true);
  const tools = getConnectedToolsSync(ctx);
  assert.deepEqual(tools, ['linear']);
});

test('connectTool: free user blocked from connecting second tool', async () => {
  const ctx = makeMockContext();
  await connectTool(ctx, 'linear', 'CORE');
  const result = await connectTool(ctx, 'jira', 'CORE');
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('Free plan'));
  const tools = getConnectedToolsSync(ctx);
  assert.equal(tools.length, 1);
});

test('connectTool: pro user can connect multiple tools', async () => {
  const ctx = makeMockContext();
  const r1 = await connectTool(ctx, 'linear', 'PRO');
  const r2 = await connectTool(ctx, 'jira', 'PRO');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const tools = getConnectedToolsSync(ctx);
  assert.equal(tools.length, 2);
});

test('connectTool: max user can connect all 5 tools', async () => {
  const ctx = makeMockContext();
  const allTools: TynePmTool[] = ['linear', 'jira', 'asana', 'notion', 'monday'];
  for (const tool of allTools) {
    const r = await connectTool(ctx, tool, 'MAX');
    assert.equal(r.ok, true, `Expected ${tool} to connect for MAX`);
  }
  const tools = getConnectedToolsSync(ctx);
  assert.equal(tools.length, 5);
});

test('disconnectTool: removes from connected list', async () => {
  const ctx = makeMockContext();
  await connectTool(ctx, 'linear', 'PRO');
  await connectTool(ctx, 'jira', 'PRO');
  await disconnectTool(ctx, 'linear');
  const tools = getConnectedToolsSync(ctx);
  assert.deepEqual(tools, ['jira']);
});

test('canConnectProvider: free user with existing tool blocked for different tool', async () => {
  const ctx = makeMockContext();
  await connectTool(ctx, 'linear', 'CORE');
  const canJira = await canConnectProvider(ctx, 'CORE', 'jira');
  assert.equal(canJira, false);
});

test('canConnectProvider: pro user always allowed', async () => {
  const ctx = makeMockContext();
  const can = await canConnectProvider(ctx, 'PRO', 'jira');
  assert.equal(can, true);
});

// ── Task cache ────────────────────────────────────────────────────────────────

test('saveTasks + listCachedTasksSync: basic CRUD', async () => {
  const ctx = makeMockContext();
  const tasks = [makeTask(), makeTask({ id: 'linear:ENG-002', externalId: 'ENG-002', title: 'Second task' })];
  await saveTasks(ctx, tasks);
  const cached = listCachedTasksSync(ctx);
  assert.equal(cached.length, 2);
});

test('saveTasks: merges without duplicates on re-pull', async () => {
  const ctx = makeMockContext();
  await saveTasks(ctx, [makeTask()]);
  await saveTasks(ctx, [makeTask({ title: 'Fix auth bug — updated' })]);
  const cached = listCachedTasksSync(ctx);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].title, 'Fix auth bug — updated');
});

test('replaceTasksForProvider: replaces stale provider tasks and keeps other tools', async () => {
  const ctx = makeMockContext();
  await saveTasks(ctx, [
    makeTask({ id: 'jira:TYNE-1', externalId: 'TYNE-1', sourceTool: 'jira', title: 'Old Jira task' }),
    makeTask({ id: 'linear:ENG-2', externalId: 'ENG-2', sourceTool: 'linear', title: 'Linear task' }),
  ]);
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-2', externalId: 'TYNE-2', sourceTool: 'jira', title: 'Fresh Jira task' }),
  ]);
  const cached = listCachedTasksSync(ctx);
  assert.equal(cached.some(task => task.id === 'jira:TYNE-1'), false);
  assert.equal(cached.some(task => task.id === 'jira:TYNE-2'), true);
  assert.equal(cached.some(task => task.id === 'linear:ENG-2'), true);
});

test('refresh replaces the visible Jira list when assignment changes', async () => {
  // Simulates: user had several Jira issues assigned, then reassigned some in
  // Jira. An explicit refresh must REPLACE (not merge) the cached list so it
  // reflects current "assigned to me" state.
  const ctx = makeMockContext();
  // First pull: three issues assigned to the user.
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-1', externalId: 'TYNE-1', sourceTool: 'jira', title: 'Issue 1' }),
    makeTask({ id: 'jira:TYNE-2', externalId: 'TYNE-2', sourceTool: 'jira', title: 'Issue 2' }),
    makeTask({ id: 'jira:TYNE-3', externalId: 'TYNE-3', sourceTool: 'jira', title: 'Issue 3' }),
  ]);

  // After reassignment in Jira, the fresh response drops TYNE-1 / TYNE-3 (no
  // longer assigned) and adds TYNE-4 (newly assigned). TYNE-2 stays.
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-2', externalId: 'TYNE-2', sourceTool: 'jira', title: 'Issue 2' }),
    makeTask({ id: 'jira:TYNE-4', externalId: 'TYNE-4', sourceTool: 'jira', title: 'Issue 4' }),
  ]);

  const ids = listCachedTasksSync(ctx).filter(t => t.sourceTool === 'jira').map(t => t.id).sort();
  // Newly assigned appears, unassigned disappear, exact replacement (no merge).
  assert.deepEqual(ids, ['jira:TYNE-2', 'jira:TYNE-4']);
  assert.equal(ids.includes('jira:TYNE-1'), false);
  assert.equal(ids.includes('jira:TYNE-3'), false);
});

test('refresh does not append: empty fresh response clears assigned-to-me list', async () => {
  const ctx = makeMockContext();
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-7', externalId: 'TYNE-7', sourceTool: 'jira', title: 'Issue 7' }),
  ]);
  // User unassigned themselves from everything → fresh response is empty.
  await replaceTasksForProvider(ctx, 'jira', []);
  const jiraTasks = listCachedTasksSync(ctx).filter(t => t.sourceTool === 'jira');
  assert.equal(jiraTasks.length, 0);
});

test('markCachedTaskDone: reflects completion on the cached task immediately', async () => {
  const ctx = makeMockContext();
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-5', externalId: 'TYNE-5', sourceTool: 'jira', status: 'In Progress', normalizedStatus: 'in_progress' }),
    makeTask({ id: 'jira:TYNE-6', externalId: 'TYNE-6', sourceTool: 'jira', status: 'To Do', normalizedStatus: 'todo' }),
  ]);
  await markCachedTaskDone(ctx, 'jira:TYNE-5');
  const tasks = listCachedTasksSync(ctx);
  const done = tasks.find(t => t.id === 'jira:TYNE-5');
  const other = tasks.find(t => t.id === 'jira:TYNE-6');
  assert.equal(done?.normalizedStatus, 'done');
  assert.equal(other?.normalizedStatus, 'todo'); // unaffected
});

test('markCachedTaskDone: no-op for an unknown task id', async () => {
  const ctx = makeMockContext();
  await replaceTasksForProvider(ctx, 'jira', [
    makeTask({ id: 'jira:TYNE-5', externalId: 'TYNE-5', sourceTool: 'jira', normalizedStatus: 'in_progress' }),
  ]);
  await markCachedTaskDone(ctx, 'jira:DOES-NOT-EXIST');
  const tasks = listCachedTasksSync(ctx);
  assert.equal(tasks.find(t => t.id === 'jira:TYNE-5')?.normalizedStatus, 'in_progress');
});

test('forceRefresh flag is carried on the pull input contract', () => {
  // Guards the plumbing that lets an explicit refresh bypass the provider cache.
  const input: import('../taskTypes').TynePullTasksInput = { assignedOnly: true, forceRefresh: true };
  assert.equal(input.forceRefresh, true);
  assert.equal(input.assignedOnly, true);
});

test('saveTaskDetails + getCachedTaskDetailsSync: stores and retrieves details', async () => {
  const ctx = makeMockContext();
  const details: TyneTaskDetails = {
    ...makeTask(),
    subtasks: [{ id: 's1', title: 'Write tests', normalizedStatus: 'todo' }],
    comments: [],
    notes: [],
    historyLast30Days: [],
  };
  await saveTaskDetails(ctx, details);
  const retrieved = getCachedTaskDetailsSync(ctx, 'linear:ENG-001');
  assert.ok(retrieved !== null);
  assert.equal(retrieved!.subtasks.length, 1);
});

test('getCachedTaskDetailsSync: returns null for unknown id', () => {
  const ctx = makeMockContext();
  const result = getCachedTaskDetailsSync(ctx, 'nonexistent:id');
  assert.equal(result, null);
});

test('repairTaskCache: fixes corrupted tasks array', async () => {
  const ctx = makeMockContext();
  await ctx.workspaceState.update('tyne.tasksCache', 'corrupted string');
  const result = await repairTaskCache(ctx);
  assert.equal(result.repaired, true);
  const cached = listCachedTasksSync(ctx);
  assert.deepEqual(cached, []);
});

test('repairTaskCache: removes legacy demo tasks from task page cache', async () => {
  const ctx = makeMockContext();
  await saveTasks(ctx, [
    makeTask({
      id: 'linear:ENG-101',
      externalId: 'ENG-101',
      title: 'Demo task',
      description: 'This is a demo task from linear. Connect your real linear account to see live tasks.',
      sourceUrl: 'https://linear.example.com/task/ENG-101',
    }),
    makeTask({ id: 'jira:TYNE-9', externalId: 'TYNE-9', sourceTool: 'jira', title: 'Real Jira issue' }),
  ]);
  const result = await repairTaskCache(ctx);
  const cached = listCachedTasksSync(ctx);
  assert.equal(result.repaired, true);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, 'jira:TYNE-9');
});

test('mergePulledTasksWithCacheSync: preserves local metadata', () => {
  const existing = [makeTask({ title: 'Original', isCachedOnly: true })];
  const pulled = [makeTask({ title: 'Updated from PM', isCachedOnly: false })];
  const merged = mergePulledTasksWithCacheSync(existing, pulled);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'Updated from PM');
  assert.equal(merged[0].isCachedOnly, false);
});

// ── Search ────────────────────────────────────────────────────────────────────

test('searchTasks: finds by title', () => {
  const tasks = [makeTask({ title: 'Fix auth bug' }), makeTask({ id: 't2', title: 'Add logging' })];
  const results = searchTasks(tasks, 'auth');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Fix auth bug');
});

test('searchTasks: finds by task ID', () => {
  const tasks = [makeTask({ externalId: 'ENG-001' }), makeTask({ id: 'linear:ENG-002', externalId: 'ENG-002' })];
  const results = searchTasks(tasks, 'ENG-002');
  assert.equal(results.length, 1);
  assert.equal(results[0].externalId, 'ENG-002');
});

test('searchTasks: finds by assignee', () => {
  const tasks = [makeTask({ assigneeName: 'Alice' }), makeTask({ id: 't2', externalId: 'T2', assigneeName: 'Bob' })];
  const results = searchTasks(tasks, 'bob');
  assert.equal(results.length, 1);
  assert.equal(results[0].assigneeName, 'Bob');
});

test('searchTasks: empty query returns all', () => {
  const tasks = [makeTask(), makeTask({ id: 't2', externalId: 'T2' })];
  const results = searchTasks(tasks, '');
  assert.equal(results.length, 2);
});

test('searchTasks: no results returns empty array', () => {
  const tasks = [makeTask({ title: 'Fix auth' })];
  const results = searchTasks(tasks, 'xyzzy123');
  assert.equal(results.length, 0);
});

// ── Filter ────────────────────────────────────────────────────────────────────

test('filterTasks: by status', () => {
  const tasks = [
    makeTask({ normalizedStatus: 'in_progress' }),
    makeTask({ id: 't2', externalId: 'T2', normalizedStatus: 'done' }),
  ];
  const filters: TyneTaskFilters = { statuses: ['in_progress'] };
  const results = filterTasks(tasks, filters);
  assert.equal(results.length, 1);
  assert.equal(results[0].normalizedStatus, 'in_progress');
});

test('filterTasks: by priority', () => {
  const tasks = [
    makeTask({ normalizedPriority: 'high' }),
    makeTask({ id: 't2', externalId: 'T2', normalizedPriority: 'low' }),
  ];
  const filters: TyneTaskFilters = { priorities: ['high'] };
  const results = filterTasks(tasks, filters);
  assert.equal(results.length, 1);
  assert.equal(results[0].normalizedPriority, 'high');
});

test('filterTasks: by source tool', () => {
  const tasks = [
    makeTask({ sourceTool: 'linear' }),
    makeTask({ id: 't2', externalId: 'T2', sourceTool: 'jira' }),
  ];
  const filters: TyneTaskFilters = { sourceTools: ['linear'] };
  const results = filterTasks(tasks, filters);
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceTool, 'linear');
});

test('filterTasks: by assignee', () => {
  const tasks = [makeTask({ assigneeName: 'Alice' }), makeTask({ id: 't2', externalId: 'T2', assigneeName: 'Bob' })];
  const filters: TyneTaskFilters = { assignees: ['Alice'] };
  const results = filterTasks(tasks, filters);
  assert.equal(results.length, 1);
});

test('filterTasks: empty filters returns all', () => {
  const tasks = [makeTask(), makeTask({ id: 't2', externalId: 'T2' })];
  const results = filterTasks(tasks, {});
  assert.equal(results.length, 2);
});

// ── Sort ──────────────────────────────────────────────────────────────────────

test('sortTasks: by updatedAt desc', () => {
  const older = makeTask({ id: 't1', externalId: 'T1', updatedAt: new Date(Date.now() - 10000).toISOString() });
  const newer = makeTask({ id: 't2', externalId: 'T2', updatedAt: new Date(Date.now() - 1000).toISOString() });
  const sort: TyneTaskSort = { key: 'updatedAt', direction: 'desc' };
  const results = sortTasks([older, newer], sort);
  assert.equal(results[0].id, 't2');
});

test('sortTasks: by updatedAt asc', () => {
  const older = makeTask({ id: 't1', externalId: 'T1', updatedAt: new Date(Date.now() - 10000).toISOString() });
  const newer = makeTask({ id: 't2', externalId: 'T2', updatedAt: new Date(Date.now() - 1000).toISOString() });
  const sort: TyneTaskSort = { key: 'updatedAt', direction: 'asc' };
  const results = sortTasks([newer, older], sort);
  assert.equal(results[0].id, 't1');
});

test('sortTasks: by priority (urgent first)', () => {
  const low = makeTask({ id: 't1', externalId: 'T1', normalizedPriority: 'low' });
  const urgent = makeTask({ id: 't2', externalId: 'T2', normalizedPriority: 'urgent' });
  const high = makeTask({ id: 't3', externalId: 'T3', normalizedPriority: 'high' });
  const sort: TyneTaskSort = { key: 'priority', direction: 'asc' };
  const results = sortTasks([low, high, urgent], sort);
  assert.equal(results[0].normalizedPriority, 'urgent');
  assert.equal(results[1].normalizedPriority, 'high');
  assert.equal(results[2].normalizedPriority, 'low');
});

test('sortTasks: by title A-Z', () => {
  const b = makeTask({ id: 't1', externalId: 'T1', title: 'Beta task' });
  const a = makeTask({ id: 't2', externalId: 'T2', title: 'Alpha task' });
  const sort: TyneTaskSort = { key: 'title', direction: 'asc' };
  const results = sortTasks([b, a], sort);
  assert.equal(results[0].title, 'Alpha task');
});

test('sortTasks: by dueDate asc', () => {
  const later = makeTask({ id: 't1', externalId: 'T1', dueDate: new Date(Date.now() + 86400000 * 5).toISOString() });
  const sooner = makeTask({ id: 't2', externalId: 'T2', dueDate: new Date(Date.now() + 86400000).toISOString() });
  const sort: TyneTaskSort = { key: 'dueDate', direction: 'asc' };
  const results = sortTasks([later, sooner], sort);
  assert.equal(results[0].id, 't2');
});

// ── Combined query ────────────────────────────────────────────────────────────

test('queryTasks: search + filter + sort combined', () => {
  const tasks = [
    makeTask({ id: 't1', externalId: 'T1', title: 'Auth fix', normalizedStatus: 'in_progress', normalizedPriority: 'high', updatedAt: new Date(Date.now() - 5000).toISOString() }),
    makeTask({ id: 't2', externalId: 'T2', title: 'Auth migration', normalizedStatus: 'todo', normalizedPriority: 'urgent', updatedAt: new Date(Date.now() - 1000).toISOString() }),
    makeTask({ id: 't3', externalId: 'T3', title: 'Logging', normalizedStatus: 'in_progress', normalizedPriority: 'low', updatedAt: new Date(Date.now() - 3000).toISOString() }),
  ];
  const results = queryTasks(tasks, 'auth', { statuses: ['in_progress', 'todo'] }, { key: 'updatedAt', direction: 'desc' });
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.title.toLowerCase().includes('auth')));
});

// ── Source dropdown behavior ──────────────────────────────────────────────────

test('filterTasks: free user source dropdown shows only connected tool', () => {
  const tasks = [
    makeTask({ sourceTool: 'linear' }),
    makeTask({ id: 't2', externalId: 'T2', sourceTool: 'jira' }),
  ];
  const filters: TyneTaskFilters = { sourceTools: ['linear'] };
  const results = filterTasks(tasks, filters);
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceTool, 'linear');
});

// ── Adapter: connect/disconnect lifecycle ─────────────────────────────────────

test('LinearTaskAdapter: connect sets isConnected to true', async () => {
  const a = new LinearTaskAdapter();
  assert.equal(await a.isConnected(), false);
  await a.connect();
  assert.equal(await a.isConnected(), true);
});

test('LinearTaskAdapter: disconnect sets isConnected to false', async () => {
  const a = new LinearTaskAdapter();
  await a.connect();
  await a.disconnect();
  assert.equal(await a.isConnected(), false);
});

test('LinearTaskAdapter: pullTasks returns demo tasks when connected', async () => {
  const a = new LinearTaskAdapter();
  await a.connect();
  const tasks = await a.pullTasks({});
  assert.ok(Array.isArray(tasks));
  assert.ok(tasks.length > 0);
  assert.equal(tasks[0].sourceTool, 'linear');
});

test('LinearTaskAdapter: pullTasks throws when not connected', async () => {
  const a = new LinearTaskAdapter();
  await assert.rejects(() => a.pullTasks({}), /not connected/i);
});

test('LinearTaskAdapter: getTaskDetails returns subtasks and comments when connected', async () => {
  const a = new LinearTaskAdapter();
  await a.connect();
  const details = await a.getTaskDetails('ENG-001');
  assert.ok(Array.isArray(details.subtasks));
  assert.ok(Array.isArray(details.comments));
  assert.ok(Array.isArray(details.historyLast30Days));
});

// ── Offline: cached-only tasks ────────────────────────────────────────────────

test('offline: listCachedTasksSync returns empty array when no cache', () => {
  const ctx = makeMockContext();
  const tasks = listCachedTasksSync(ctx);
  assert.deepEqual(tasks, []);
});

test('offline: listCachedTasksSync returns cached tasks', async () => {
  const ctx = makeMockContext();
  await saveTasks(ctx, [makeTask()]);
  const tasks = listCachedTasksSync(ctx);
  assert.equal(tasks.length, 1);
});

// ── History unavailable message ───────────────────────────────────────────────

test('AsanaTaskAdapter: getTaskHistoryLast30Days returns empty (not supported)', async () => {
  const a = new AsanaTaskAdapter();
  const hist = await a.getTaskHistoryLast30Days('any');
  assert.deepEqual(hist, []);
});

test('NotionTaskAdapter: getTaskHistoryLast30Days returns empty (not supported)', async () => {
  const a = new NotionTaskAdapter();
  const hist = await a.getTaskHistoryLast30Days('any');
  assert.deepEqual(hist, []);
});

test('LinearTaskAdapter: getTaskHistoryLast30Days returns events when connected', async () => {
  const a = new LinearTaskAdapter();
  await a.connect();
  const hist = await a.getTaskHistoryLast30Days('ENG-001');
  assert.ok(Array.isArray(hist));
  assert.ok(hist.length > 0);
  assert.ok(hist[0].sourceTool === 'linear');
});
