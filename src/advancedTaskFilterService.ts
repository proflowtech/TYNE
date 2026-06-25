import {
  TyneTask,
  TyneAdvancedTaskFilters,
  TyneAdvancedTaskSort,
  TyneSortRule,
  TyneParsedTaskQuery,
  TyneNormalizedTaskPriority,
  TyneNormalizedTaskStatus,
  TynePmTool,
  PRIORITY_RANK,
  DEFAULT_ADVANCED_SORT,
} from './taskTypes';

// ── Status rank for sorting ───────────────────────────────────────────────────

const STATUS_RANK: Record<string, number> = {
  in_progress: 0, in_review: 1, todo: 2, blocked: 3, done: 4, canceled: 5, unknown: 6,
};

const VALIDATION_RANK: Record<string, number> = { pass: 0, partial: 1, fail: 2, not_run: 3 };

// ── Custom query parser ───────────────────────────────────────────────────────

const OPERATOR_RE = /(\w+):(\S+)/g;

export function parseCustomQuery(query: string): TyneParsedTaskQuery {
  const filters: TyneAdvancedTaskFilters = {};
  let sort: TyneAdvancedTaskSort | undefined;
  const parseErrors: string[] = [];
  let textQuery = query;

  const matches = [...query.matchAll(OPERATOR_RE)];
  for (const m of matches) {
    const op = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    textQuery = textQuery.replace(m[0], '').trim();

    try {
      switch (op) {
        case 'status':
          filters.statuses = [...(filters.statuses ?? []), val as TyneNormalizedTaskStatus];
          break;
        case 'priority':
          filters.priorities = [...(filters.priorities ?? []), val as TyneNormalizedTaskPriority];
          break;
        case 'source':
          filters.sourceTools = [...(filters.sourceTools ?? []), val as TynePmTool];
          break;
        case 'assignee':
          filters.assignees = [...(filters.assignees ?? []), val];
          break;
        case 'project':
          filters.projects = [...(filters.projects ?? []), val];
          break;
        case 'label':
          filters.labels = [...(filters.labels ?? []), val];
          break;
        case 'due':
          if (['today', 'this_week', 'overdue'].includes(val)) {
            filters.dueDatePreset = val as TyneAdvancedTaskFilters['dueDatePreset'];
          } else {
            parseErrors.push(`Unknown due preset "${val}". Use: today, this_week, overdue`);
          }
          break;
        case 'updated':
          if (['last_7_days', 'last_30_days'].includes(val)) {
            filters.updatedPreset = val as TyneAdvancedTaskFilters['updatedPreset'];
          } else {
            parseErrors.push(`Unknown updated preset "${val}". Use: last_7_days, last_30_days`);
          }
          break;
        case 'created':
          if (['last_7_days', 'last_30_days'].includes(val)) {
            filters.createdPreset = val as TyneAdvancedTaskFilters['createdPreset'];
          } else {
            parseErrors.push(`Unknown created preset "${val}". Use: last_7_days, last_30_days`);
          }
          break;
        case 'has':
          if (val === 'branch') { filters.hasBranch = true; }
          else if (val === 'commits') { filters.hasCommits = true; }
          else if (val === 'time') { filters.hasTimeTracked = true; }
          else { parseErrors.push(`Unknown has: operator value "${val}". Use: branch, commits, time`); }
          break;
        case 'validation':
          if (['pass', 'partial', 'fail', 'not_run'].includes(val)) {
            filters.validationStatuses = [...(filters.validationStatuses ?? []),
              val as 'pass' | 'partial' | 'fail' | 'not_run'];
          } else {
            parseErrors.push(`Unknown validation value "${val}". Use: pass, partial, fail, not_run`);
          }
          break;
        case 'local_status':
          filters.localStatuses = [...(filters.localStatuses ?? []), val];
          break;
        case 'sort': {
          const [key, dir] = val.split(':');
          const direction = dir === 'asc' ? 'asc' : 'desc';
          sort = { rules: [{ key: key as TyneSortRule['key'], direction }] };
          break;
        }
        default:
          parseErrors.push(`Unknown operator "${op}:"`);
      }
    } catch {
      parseErrors.push(`Invalid query near "${m[0]}"`);
    }
  }

  return { textQuery: textQuery.trim(), filters, sort, parseErrors };
}

// ── Full-text search ──────────────────────────────────────────────────────────

export function advancedSearchTasks(tasks: TyneTask[], query: string): TyneTask[] {
  if (!query.trim()) { return tasks; }
  const q = query.toLowerCase().trim();
  return tasks.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.externalId.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q) ||
    (t.assigneeName ?? '').toLowerCase().includes(q) ||
    (t.normalizedStatus ?? '').toLowerCase().includes(q) ||
    (t.sourceProject ?? '').toLowerCase().includes(q) ||
    (t.description ?? '').toLowerCase().includes(q),
  );
}

// ── Advanced filter ───────────────────────────────────────────────────────────

export function applyAdvancedFilters(tasks: TyneTask[], filters: TyneAdvancedTaskFilters): TyneTask[] {
  let r = tasks;

  if (filters.statuses?.length) {
    r = r.filter(t => filters.statuses!.includes(t.normalizedStatus));
  }
  if (filters.assignees?.length) {
    r = r.filter(t => {
      const a = (t.assigneeName ?? '').toLowerCase();
      return filters.assignees!.some(f => f === 'me' || a.includes(f.toLowerCase()));
    });
  }
  if (filters.priorities?.length) {
    r = r.filter(t => filters.priorities!.includes(t.normalizedPriority));
  }
  if (filters.sourceTools?.length) {
    r = r.filter(t => filters.sourceTools!.includes(t.sourceTool));
  }
  if (filters.projects?.length) {
    r = r.filter(t => {
      const p = (t.sourceProject ?? '').toLowerCase();
      return filters.projects!.some(f => p.includes(f.toLowerCase()));
    });
  }
  if (filters.labels?.length) {
    r = r.filter(t => {
      const tl = (t as unknown as { labels?: string[] }).labels ?? [];
      return filters.labels!.some(l => tl.map(x => x.toLowerCase()).includes(l.toLowerCase()));
    });
  }
  if (filters.dueDatePreset && filters.dueDatePreset !== 'none') {
    r = applyDueDateFilter(r, filters.dueDatePreset);
  }
  if (filters.updatedPreset && filters.updatedPreset !== 'none') {
    r = applyUpdatedFilter(r, filters.updatedPreset);
  }
  if (filters.createdPreset && filters.createdPreset !== 'none') {
    r = applyCreatedFilter(r, filters.createdPreset);
  }
  if (filters.hasBranch !== undefined) {
    r = r.filter(t => {
      const has = Boolean((t as unknown as { linkedBranchName?: string }).linkedBranchName);
      return filters.hasBranch ? has : !has;
    });
  }
  if (filters.hasCommits !== undefined) {
    r = r.filter(t => {
      const count = (t as unknown as { commitCount?: number }).commitCount ?? 0;
      return filters.hasCommits ? count > 0 : count === 0;
    });
  }
  if (filters.hasTimeTracked !== undefined) {
    r = r.filter(t => {
      const mins = (t as unknown as { timeTrackedMinutes?: number }).timeTrackedMinutes ?? 0;
      return filters.hasTimeTracked ? mins > 0 : mins === 0;
    });
  }
  if (filters.validationStatuses?.length) {
    r = r.filter(t => {
      const vs = (t as unknown as { validationStatus?: string }).validationStatus ?? 'not_run';
      return filters.validationStatuses!.includes(vs as 'pass' | 'partial' | 'fail' | 'not_run');
    });
  }
  if (filters.localStatuses?.length) {
    r = r.filter(t => {
      const ls = (t as unknown as { localTyneStatus?: string }).localTyneStatus ?? '';
      return filters.localStatuses!.some(s => ls.toLowerCase() === s.toLowerCase());
    });
  }

  return r;
}

function applyDueDateFilter(tasks: TyneTask[], preset: 'today' | 'this_week' | 'overdue'): TyneTask[] {
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

function applyUpdatedFilter(tasks: TyneTask[], preset: 'last_7_days' | 'last_30_days'): TyneTask[] {
  const days = preset === 'last_7_days' ? 7 : 30;
  const cutoff = Date.now() - days * 86400000;
  return tasks.filter(t => (t.updatedAt ? new Date(t.updatedAt).getTime() : 0) >= cutoff);
}

function applyCreatedFilter(tasks: TyneTask[], preset: 'last_7_days' | 'last_30_days'): TyneTask[] {
  const days = preset === 'last_7_days' ? 7 : 30;
  const cutoff = Date.now() - days * 86400000;
  return tasks.filter(t => (t.createdAt ? new Date(t.createdAt).getTime() : 0) >= cutoff);
}

// ── Advanced multi-sort ───────────────────────────────────────────────────────

export function applyAdvancedSort(tasks: TyneTask[], sort: TyneAdvancedTaskSort = DEFAULT_ADVANCED_SORT): TyneTask[] {
  if (!sort.rules.length) { return tasks; }
  return [...tasks].sort((a, b) => {
    for (const rule of sort.rules) {
      const cmp = compareByRule(a, b, rule);
      if (cmp !== 0) { return cmp; }
    }
    return 0;
  });
}

function compareByRule(a: TyneTask, b: TyneTask, rule: TyneSortRule): number {
  const dir = rule.direction === 'asc' ? 1 : -1;
  switch (rule.key) {
    case 'updatedAt': return dir * strCmp(a.updatedAt ?? '', b.updatedAt ?? '');
    case 'createdAt': return dir * strCmp(a.createdAt ?? '', b.createdAt ?? '');
    case 'dueDate':   return dir * strCmp(a.dueDate ?? '', b.dueDate ?? '');
    case 'priority': {
      const ra = PRIORITY_RANK[a.normalizedPriority as TyneNormalizedTaskPriority] ?? 5;
      const rb = PRIORITY_RANK[b.normalizedPriority as TyneNormalizedTaskPriority] ?? 5;
      return dir * (ra - rb);
    }
    case 'title': return dir * a.title.localeCompare(b.title);
    case 'status': {
      const ra = STATUS_RANK[a.normalizedStatus] ?? 6;
      const rb = STATUS_RANK[b.normalizedStatus] ?? 6;
      return dir * (ra - rb);
    }
    case 'sourceTool': return dir * strCmp(a.sourceTool, b.sourceTool);
    case 'project':    return dir * strCmp(a.sourceProject ?? '', b.sourceProject ?? '');
    case 'assignee':   return dir * strCmp(a.assigneeName ?? '', b.assigneeName ?? '');
    case 'timeTracked': {
      const ra = (a as unknown as { timeTrackedMinutes?: number }).timeTrackedMinutes ?? 0;
      const rb = (b as unknown as { timeTrackedMinutes?: number }).timeTrackedMinutes ?? 0;
      return dir * (ra - rb);
    }
    case 'latestCommitDate': {
      const ra = (a as unknown as { latestCommitDate?: string }).latestCommitDate ?? '';
      const rb = (b as unknown as { latestCommitDate?: string }).latestCommitDate ?? '';
      return dir * strCmp(ra, rb);
    }
    case 'localActivity': {
      const ra = (a as unknown as { latestCommitDate?: string }).latestCommitDate ?? a.updatedAt ?? '';
      const rb = (b as unknown as { latestCommitDate?: string }).latestCommitDate ?? b.updatedAt ?? '';
      return dir * strCmp(ra, rb);
    }
    case 'validationStatus': {
      const ra = VALIDATION_RANK[(a as unknown as { validationStatus?: string }).validationStatus ?? 'not_run'] ?? 3;
      const rb = VALIDATION_RANK[(b as unknown as { validationStatus?: string }).validationStatus ?? 'not_run'] ?? 3;
      return dir * (ra - rb);
    }
    default: return 0;
  }
}

// ── Combined entry point ──────────────────────────────────────────────────────

export function queryTasksAdvanced(
  tasks: TyneTask[],
  query: string,
  filters: TyneAdvancedTaskFilters,
  sort: TyneAdvancedTaskSort,
): { tasks: TyneTask[]; parseErrors: string[] } {
  const parsed = parseCustomQuery(query);
  const mergedFilters: TyneAdvancedTaskFilters = mergeFilters(parsed.filters, filters);
  const mergedSort: TyneAdvancedTaskSort = parsed.sort ?? sort;
  const searched = advancedSearchTasks(tasks, parsed.textQuery);
  const filtered = applyAdvancedFilters(searched, mergedFilters);
  const sorted = applyAdvancedSort(filtered, mergedSort);
  return { tasks: sorted, parseErrors: parsed.parseErrors };
}

function mergeFilters(
  parsed: TyneAdvancedTaskFilters,
  explicit: TyneAdvancedTaskFilters,
): TyneAdvancedTaskFilters {
  return {
    statuses: [...(explicit.statuses ?? []), ...(parsed.statuses ?? [])],
    assignees: [...(explicit.assignees ?? []), ...(parsed.assignees ?? [])],
    priorities: [...(explicit.priorities ?? []), ...(parsed.priorities ?? [])],
    sourceTools: [...(explicit.sourceTools ?? []), ...(parsed.sourceTools ?? [])],
    projects: [...(explicit.projects ?? []), ...(parsed.projects ?? [])],
    labels: [...(explicit.labels ?? []), ...(parsed.labels ?? [])],
    dueDatePreset: explicit.dueDatePreset ?? parsed.dueDatePreset,
    updatedPreset: explicit.updatedPreset ?? parsed.updatedPreset,
    createdPreset: explicit.createdPreset ?? parsed.createdPreset,
    hasBranch: explicit.hasBranch ?? parsed.hasBranch,
    hasCommits: explicit.hasCommits ?? parsed.hasCommits,
    hasTimeTracked: explicit.hasTimeTracked ?? parsed.hasTimeTracked,
    validationStatuses: [...(explicit.validationStatuses ?? []), ...(parsed.validationStatuses ?? [])],
    localStatuses: [...(explicit.localStatuses ?? []), ...(parsed.localStatuses ?? [])],
  };
}

function strCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
