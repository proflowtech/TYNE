// ── ValidationContextResolver ────────────────────────────────────────────────
// Resolves validation context with 5-level fallback:
// 1. Fresh enriched PM intelligence
// 2. Stored PM intelligence from state
// 3. Raw Jira/Linear task data
// 4. Branch name + changed files
// 5. Diff-only validation
//
// Never allows empty arrays or empty strings to wipe richer stored context.

import * as vscode from 'vscode';
import { getState, TyneState } from './stateManager';
import { getCurrentBranch } from './gitManager';
import { TynePmTaskIntelligence, TyneDeveloperTaskPlan, TyneTaskDetails } from './taskTypes';
import { pullTaskDetails } from './taskPullService';
import { extractAcceptanceCriteriaFromText } from './jiraTextUtils';
import { getAdapter } from './taskProviderRegistry';
import {
  ResolvedValidationContext,
  ResolvedValidationSubtask,
  EnrichmentStatus,
  ValidationContextSource,
  ValidationConfidence,
  confidenceFromSource,
  normalizeError,
} from './validationContextTypes';

export interface ResolveValidationContextInput {
  freshIntelligence?: TynePmTaskIntelligence | null;
  enrichmentError?: string;
  enrichmentStatus: EnrichmentStatus;
  changedFiles: string[];
  diffSummary?: string;
}

export async function resolveValidationContext(
  context: vscode.ExtensionContext,
  input: ResolveValidationContextInput,
): Promise<ResolvedValidationContext> {
  const state = getState(context);
  const branchName = await getCurrentBranch().catch(() => state.branchName || '');

  // Level 1: Fresh enriched PM intelligence
  if (input.freshIntelligence && hasUsableIntelligence(input.freshIntelligence)) {
    return buildFromEnriched(input.freshIntelligence, 'enriched_pm', input.enrichmentStatus, input.enrichmentError);
  }

  // Level 2: Stored PM intelligence from state
  if (state.pmTaskContext && hasUsableIntelligence(state.pmTaskContext)) {
    return buildFromEnriched(state.pmTaskContext, 'stored_pm', input.enrichmentStatus, input.enrichmentError);
  }

  // Level 3: Raw Jira/Linear task data
  const rawContext = await tryRawPmTask(state, context, input.enrichmentStatus, input.enrichmentError);
  if (rawContext) {
    return rawContext;
  }

  // Level 4: Branch name + changed files
  if (branchName || input.changedFiles.length > 0) {
    return buildBranchOnly(state, branchName, input.changedFiles, input.enrichmentStatus, input.enrichmentError);
  }

  // Level 5: Diff-only validation
  return buildDiffOnly(input.enrichmentStatus, input.enrichmentError);
}

function hasUsableIntelligence(intel: TynePmTaskIntelligence): boolean {
  return Boolean(
    intel.goal ||
    (intel.subtasks && intel.subtasks.length > 0) ||
    (intel.acceptanceCriteria && intel.acceptanceCriteria.length > 0) ||
    intel.developerTaskPlan
  );
}

function buildFromEnriched(
  intel: TynePmTaskIntelligence,
  source: ValidationContextSource,
  enrichmentStatus: EnrichmentStatus,
  enrichmentError?: string,
): ResolvedValidationContext {
  const subtasks: ResolvedValidationSubtask[] = (intel.subtasks || []).map(s => ({
    title: s.title,
    description: s.description,
    source: 'developer_plan',
  }));

  const acceptanceCriteria = intel.acceptanceCriteria && intel.acceptanceCriteria.length > 0
    ? intel.acceptanceCriteria
    : [];

  const validationSteps = intel.validationSteps && intel.validationSteps.length > 0
    ? intel.validationSteps
    : [];

  return {
    enrichmentStatus,
    enrichmentError,
    source,
    goal: intel.goal || intel.issueIdentifier || 'Task validation',
    taskDescription: intel.codebaseContext?.diff || undefined,
    subtasks,
    acceptanceCriteria,
    validationSteps,
    pmContext: intel.pmContext,
    developerTaskPlan: intel.developerTaskPlan,
    confidence: confidenceFromSource(source, enrichmentStatus),
  };
}

async function tryRawPmTask(
  state: TyneState,
  context: vscode.ExtensionContext,
  enrichmentStatus: EnrichmentStatus,
  enrichmentError?: string,
): Promise<ResolvedValidationContext | null> {
  if (!state.taskId) { return null; }

  const source = state.taskSource.trim().toLowerCase();
  if (source !== 'jira' && source !== 'linear') { return null; }

  try {
    const details = await pullTaskDetails(context, state.taskId, source as 'jira' | 'linear');
    if (!details) { return null; }

    const description = details.description?.trim() || '';
    const criteriaResult = extractAcceptanceCriteriaFromText(description);
    const acceptanceCriteria = criteriaResult.criteria.length > 0
      ? criteriaResult.criteria
      : state.acceptanceCriteria.length > 0
        ? state.acceptanceCriteria
        : [];

    // Generate fallback subtasks from raw task data
    const fallbackSubtasks = generateFallbackSubtasks(
      details.title || state.taskTitle || state.goal || '',
      description,
      acceptanceCriteria,
      '',
      [],
      '',
    );

    return {
      enrichmentStatus,
      enrichmentError,
      source: 'raw_pm',
      goal: details.title || state.taskTitle || state.goal || 'Task validation',
      taskDescription: description || undefined,
      subtasks: fallbackSubtasks,
      acceptanceCriteria,
      validationSteps: state.validationSteps.length > 0 ? state.validationSteps : [],
      confidence: confidenceFromSource('raw_pm', enrichmentStatus),
    };
  } catch {
    return null;
  }
}

function buildBranchOnly(
  state: TyneState,
  branchName: string,
  changedFiles: string[],
  enrichmentStatus: EnrichmentStatus,
  enrichmentError?: string,
): ResolvedValidationContext {
  const fallbackSubtasks = generateFallbackSubtasks(
    state.taskTitle || state.goal || '',
    state.goal || '',
    state.acceptanceCriteria,
    branchName,
    changedFiles,
    '',
  );

  return {
    enrichmentStatus,
    enrichmentError,
    source: 'branch_only',
    goal: state.goal || state.taskTitle || `Review changes on ${branchName || 'current branch'}`,
    taskDescription: state.goal || undefined,
    subtasks: fallbackSubtasks,
    acceptanceCriteria: state.acceptanceCriteria,
    validationSteps: state.validationSteps,
    confidence: confidenceFromSource('branch_only', enrichmentStatus),
  };
}

function buildDiffOnly(
  enrichmentStatus: EnrichmentStatus,
  enrichmentError?: string,
): ResolvedValidationContext {
  return {
    enrichmentStatus: enrichmentStatus === 'success' ? 'skipped' : enrichmentStatus,
    enrichmentError,
    source: 'diff_only',
    goal: 'Review code changes',
    subtasks: [],
    acceptanceCriteria: [],
    validationSteps: [],
    confidence: 'low',
  };
}

// ── Fallback subtask generation ──────────────────────────────────────────────
// Generates temporary fallback subtasks from available data.
// These are marked with source: 'fallback_generated'.

export function generateFallbackSubtasks(
  taskTitle: string,
  taskDescription: string,
  acceptanceCriteria: string[],
  branchName: string,
  changedFiles: string[],
  diffSummary: string,
): ResolvedValidationSubtask[] {
  const subtasks: ResolvedValidationSubtask[] = [];

  // From task title
  if (taskTitle) {
    subtasks.push({
      title: `Implement: ${taskTitle.slice(0, 100)}`,
      description: 'Derived from task title. Verify the implementation matches the task requirement.',
      source: 'fallback_generated',
    });
  }

  // From acceptance criteria
  for (const criterion of acceptanceCriteria.slice(0, 3)) {
    subtasks.push({
      title: `Satisfy: ${criterion.slice(0, 100)}`,
      description: 'Derived from acceptance criteria. Verify the code diff addresses this criterion.',
      source: 'fallback_generated',
    });
  }

  // From changed files
  for (const file of changedFiles.slice(0, 3)) {
    const fileName = file.split('/').pop() || file;
    subtasks.push({
      title: `Review changes in ${fileName}`,
      description: `File ${file} was changed. Verify the change is correct and necessary.`,
      source: 'fallback_generated',
    });
  }

  // From branch name heuristic
  if (branchName && branchName.startsWith('tyne/')) {
    const branchGoal = branchName.replace(/^tyne\/[^-]+-/, '').replace(/-/g, ' ');
    if (branchGoal && branchGoal !== branchName) {
      subtasks.push({
        title: `Complete: ${branchGoal.slice(0, 100)}`,
        description: 'Derived from branch name. Verify the implementation completes the branch goal.',
        source: 'fallback_generated',
      });
    }
  }

  // Always add a test coverage check
  subtasks.push({
    title: 'Verify test coverage',
    description: 'Check whether tests were added or updated for the changed code.',
    source: 'fallback_generated',
  });

  // Deduplicate by title
  const seen = new Set<string>();
  return subtasks.filter(s => {
    const key = s.title.toLowerCase();
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  }).slice(0, 8);
}

// ── Non-empty array preservation ─────────────────────────────────────────────
// Never allow empty arrays or empty strings to wipe richer stored context.

export function preferStoredArray<T>(stored: T[], override: T[] | null | undefined): T[] {
  if (stored && stored.length > 0) { return stored; }
  if (override && override.length > 0) { return override; }
  return [];
}

export function preferStoredString(stored: string | undefined, override: string | undefined): string {
  if (stored && stored.trim()) { return stored; }
  if (override && override.trim()) { return override; }
  return '';
}
