/**
 * Shared PM enrichment + create-task eligibility, keyed by taskId.
 *
 * Phase 1 of Task/Thread merge: enrichment is driven by task state, not by
 * which webview button was clicked. Call sites (Start Thread, Thread field
 * edits, story decompose) all go through here.
 */

import type { TynePmTaskIntelligence } from './taskTypes';
import { isDecomposableIssueType } from './storyDecompositionHarness';

export type EnrichmentRunStatus = 'idle' | 'running' | 'complete' | 'complete_empty' | 'error' | 'skipped';

export type TaskEnrichmentState = {
  taskId: string;
  status: EnrichmentRunStatus;
  intelligence: TynePmTaskIntelligence | null;
  error?: string;
  issueType?: string;
  updatedAt: number;
};

export type RunEnrichmentResult = {
  intelligence: TynePmTaskIntelligence | null;
  error?: string;
};

const states = new Map<string, TaskEnrichmentState>();

export function hasEnrichmentContent(intelligence: TynePmTaskIntelligence | null): boolean {
  return Boolean(intelligence && (
    intelligence.goal?.trim()
    || intelligence.subtasks?.length
    || intelligence.acceptanceCriteria?.length
    || intelligence.proofPointTemplates?.length
    || intelligence.validationSteps?.length
  ));
}

/** Enough to skip a re-extract — goal-only stubs must not block proof-point generation. */
export function hasActionableEnrichment(intelligence: TynePmTaskIntelligence | null): boolean {
  return Boolean(intelligence && (
    intelligence.proofPointTemplates?.length
    || intelligence.subtasks?.length
  ));
}

export type ProofChecklistItem = { id: string; text: string; done: boolean };

/** One checklist: implementation subtask titles ∪ proof templates, deduped by text. */
export function buildProofChecklist(
  subtasks: Array<{ title: string }> | undefined,
  proofPointTemplates: string[] | undefined,
  idPrefix = String(Date.now()),
): ProofChecklistItem[] {
  const seen = new Set<string>();
  const out: ProofChecklistItem[] = [];
  const add = (raw: string) => {
    const text = raw.trim();
    if (!text) { return; }
    const key = text.toLowerCase();
    if (seen.has(key)) { return; }
    seen.add(key);
    out.push({ id: `${idPrefix}-${out.length}`, text, done: false });
  };
  for (const s of subtasks || []) { add(s.title); }
  for (const p of proofPointTemplates || []) { add(p); }
  return out;
}

/** Mutates checklist done flags from a validation result. Returns true if anything changed. */
export function applyProofStrikeOff(
  subtasks: Array<{ text?: string; done: boolean }>,
  result: { status?: string; criteriaMet?: string[]; completedGoals?: Array<string | { title?: string }> },
): boolean {
  if (!Array.isArray(subtasks) || subtasks.length === 0) { return false; }
  const met = new Set<string>();
  for (const c of result.criteriaMet || []) {
    const t = String(c || '').toLowerCase().trim();
    if (t) met.add(t);
  }
  for (const g of result.completedGoals || []) {
    const title = typeof g === 'string' ? g : g?.title;
    const t = String(title || '').toLowerCase().trim();
    if (t) met.add(t);
  }
  const passAll = result.status === 'pass';
  let changed = false;
  for (const sub of subtasks) {
    if (sub.done) { continue; }
    const text = (sub.text || '').toLowerCase().trim();
    if (!text) { continue; }
    if (passAll || proofCriterionMatches(text, met)) {
      sub.done = true;
      changed = true;
    }
  }
  return changed;
}

/** Exact, substring (≥12 chars), or shared significant token overlap. */
export function proofCriterionMatches(proofText: string, metCriteria: Set<string> | Iterable<string>): boolean {
  const text = String(proofText || '').toLowerCase().trim();
  if (!text) return false;
  const met = metCriteria instanceof Set ? metCriteria : new Set(
    [...metCriteria].map(c => String(c || '').toLowerCase().trim()).filter(Boolean),
  );
  if (met.has(text)) return true;
  if (text.length >= 12 && [...met].some(m => m.length >= 12 && (m.includes(text) || text.includes(m)))) {
    return true;
  }
  const proofToks = tokenizeProof(text);
  if (!proofToks.size) return false;
  for (const m of met) {
    const mToks = tokenizeProof(m);
    if (!mToks.size) continue;
    let hit = 0;
    for (const t of proofToks) if (mToks.has(t)) hit += 1;
    if (hit >= 2 || (hit === 1 && proofToks.size <= 3 && mToks.has([...proofToks][0]!))) {
      return true;
    }
  }
  return false;
}

function tokenizeProof(s: string): Set<string> {
  const spaced = String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(spaced.split(/\s+/).filter(t => t.length > 2));
}

function emptyState(taskId: string): TaskEnrichmentState {
  return {
    taskId,
    status: 'idle',
    intelligence: null,
    updatedAt: 0,
  };
}

export function getEnrichmentState(taskId: string): TaskEnrichmentState {
  return states.get(taskId) || emptyState(taskId);
}

export function clearEnrichmentState(taskId?: string): void {
  if (taskId) {
    states.delete(taskId);
    return;
  }
  states.clear();
}

/**
 * Epic/Story: eligible to open "Create tasks from …" once enrichment completed
 * successfully (proof points / goal available). Non-decomposable tasks are never
 * create-task-eligible via this path (they Start Thread instead).
 */
export function isTaskCreationEligible(taskId: string): boolean {
  const s = getEnrichmentState(taskId);
  if (s.status !== 'complete' || !s.intelligence) { return false; }
  return isDecomposableIssueType(s.issueType);
}

export function setEnrichmentIssueType(taskId: string, issueType: string | undefined): void {
  const prev = getEnrichmentState(taskId);
  states.set(taskId, { ...prev, taskId, issueType: issueType || prev.issueType, updatedAt: Date.now() });
}

/**
 * Run enrichment for a task. `extract` is injected so the sidebar owns
 * resolve-request / PM service / codebase context (existing plumbing).
 */
export async function runEnrichment(
  taskId: string,
  opts: {
    issueType?: string;
    extract: () => Promise<RunEnrichmentResult>;
  },
): Promise<TaskEnrichmentState> {
  const running: TaskEnrichmentState = {
    taskId,
    status: 'running',
    intelligence: null,
    issueType: opts.issueType ?? getEnrichmentState(taskId).issueType,
    updatedAt: Date.now(),
  };
  states.set(taskId, running);

  try {
    const result = await opts.extract();
    const next: TaskEnrichmentState = {
      taskId,
      status: result.intelligence
        ? (hasEnrichmentContent(result.intelligence) ? 'complete' : 'complete_empty')
        : (result.error ? 'error' : 'skipped'),
      intelligence: result.intelligence,
      error: result.error,
      issueType: opts.issueType ?? running.issueType,
      updatedAt: Date.now(),
    };
    states.set(taskId, next);
    return next;
  } catch (err: unknown) {
    const next: TaskEnrichmentState = {
      taskId,
      status: 'error',
      intelligence: null,
      error: err instanceof Error ? err.message : String(err),
      issueType: opts.issueType ?? running.issueType,
      updatedAt: Date.now(),
    };
    states.set(taskId, next);
    return next;
  }
}

/** Fields on the Thread brief that should re-trigger enrichment when edited. */
export function isEnrichmentTriggerField(field: string): boolean {
  return field === 'goal' || field === 'taskId';
}
