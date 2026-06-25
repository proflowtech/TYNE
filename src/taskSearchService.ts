import {
  TyneTask,
  TyneTaskFilters,
  TyneTaskSort,
  TyneNormalizedTaskPriority,
  PRIORITY_RANK,
  DEFAULT_TASK_SORT,
} from './taskTypes';

const STATUS_RANK: Record<string, number> = {
  in_progress: 0, in_review: 1, todo: 2, blocked: 3, done: 4, canceled: 5, unknown: 6,
};

// ── Search ────────────────────────────────────────────────────────────────────

export function searchTasks(tasks: TyneTask[], query: string): TyneTask[] {
  if (!query.trim()) { return tasks; }
  const q = query.toLowerCase().trim();
  return tasks.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.externalId.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q) ||
    (t.assigneeName ?? '').toLowerCase().includes(q) ||
    (t.normalizedStatus ?? '').toLowerCase().includes(q) ||
    (t.status ?? '').toLowerCase().includes(q) ||
    (t.sourceProject ?? '').toLowerCase().includes(q) ||
    (t.description ?? '').toLowerCase().includes(q),
  );
}

// ── Filter ────────────────────────────────────────────────────────────────────

export function filterTasks(tasks: TyneTask[], filters: TyneTaskFilters): TyneTask[] {
  let result = tasks;

  if (filters.statuses?.length) {
    result = result.filter(t => filters.statuses!.includes(t.normalizedStatus));
  }
  if (filters.assignees?.length) {
    result = result.filter(t => {
      const a = (t.assigneeName ?? '').toLowerCase();
      return filters.assignees!.some(f => a.includes(f.toLowerCase()));
    });
  }
  if (filters.priorities?.length) {
    result = result.filter(t => filters.priorities!.includes(t.normalizedPriority));
  }
  if (filters.sourceTools?.length) {
    result = result.filter(t => filters.sourceTools!.includes(t.sourceTool));
  }
  if (filters.projects?.length) {
    result = result.filter(t => {
      const p = (t.sourceProject ?? '').toLowerCase();
      return filters.projects!.some(f => p.includes(f.toLowerCase()));
    });
  }
  if (filters.dueDatePreset) {
    result = applyDueDateFilter(result, filters.dueDatePreset);
  }
  if (filters.updatedPreset) {
    result = applyUpdatedFilter(result, filters.updatedPreset);
  }
  return result;
}

function applyDueDateFilter(
  tasks: TyneTask[],
  preset: NonNullable<TyneTaskFilters['dueDatePreset']>,
): TyneTask[] {
  const todayStr = new Date().toDateString();
  const todayMs = new Date(todayStr).getTime();
  const weekMs = todayMs + 7 * 86400000;
  return tasks.filter(t => {
    if (!t.dueDate) { return false; }
    const d = new Date(t.dueDate).getTime();
    if (preset === 'today') { return new Date(t.dueDate).toDateString() === todayStr; }
    if (preset === 'this_week') { return d >= todayMs && d <= weekMs; }
    if (preset === 'overdue') { return d < todayMs; }
    return true;
  });
}

function applyUpdatedFilter(
  tasks: TyneTask[],
  preset: NonNullable<TyneTaskFilters['updatedPreset']>,
): TyneTask[] {
  const days = preset === 'last_7_days' ? 7 : 30;
  const cutoff = Date.now() - days * 86400000;
  return tasks.filter(t => {
    const d = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
    return d >= cutoff;
  });
}

// ── Sort ──────────────────────────────────────────────────────────────────────

export function sortTasks(tasks: TyneTask[], sort: TyneTaskSort = DEFAULT_TASK_SORT): TyneTask[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    switch (sort.key) {
      case 'updatedAt':
        return dir * strCmp(a.updatedAt ?? '', b.updatedAt ?? '');
      case 'createdAt':
        return dir * strCmp(a.createdAt ?? '', b.createdAt ?? '');
      case 'dueDate':
        return dir * strCmp(a.dueDate ?? '', b.dueDate ?? '');
      case 'priority': {
        const ra = PRIORITY_RANK[a.normalizedPriority as TyneNormalizedTaskPriority] ?? 5;
        const rb = PRIORITY_RANK[b.normalizedPriority as TyneNormalizedTaskPriority] ?? 5;
        return dir * (ra - rb);
      }
      case 'title':
        return dir * a.title.localeCompare(b.title);
      case 'status': {
        const ra = STATUS_RANK[a.normalizedStatus] ?? 6;
        const rb = STATUS_RANK[b.normalizedStatus] ?? 6;
        return dir * (ra - rb);
      }
      default:
        return 0;
    }
  });
}

// ── Combined query ────────────────────────────────────────────────────────────

export function queryTasks(
  tasks: TyneTask[],
  query: string,
  filters: TyneTaskFilters,
  sort: TyneTaskSort,
): TyneTask[] {
  return sortTasks(filterTasks(searchTasks(tasks, query), filters), sort);
}

function strCmp(a: string, b: string): number {
  if (a < b) { return -1; }
  if (a > b) { return 1; }
  return 0;
}
