/**
 * Intelligent Task Decomposition Harness.
 *
 * Pure logic (no vscode imports) that decides HOW a Jira/Linear Story or Epic
 * should be split into implementation-ready technical tasks:
 *   1. detectStoryCharacteristics — classify the story from its text.
 *   2. buildClarifyingQuestionsFromEnrichment — AI-read justification Qs + heuristics.
 *   3. determineSplitStrategy     — map the user's answers to a split plan.
 *   4. generateHeuristicTasks     — deterministic decomposition used as the
 *      offline/LLM-failure fallback and as the skeleton the LLM enriches.
 *
 * The LLM (Haiku via the tyne-story-decompose edge function) produces the
 * final descriptions/estimates; everything here must stay deterministic so the
 * flow degrades gracefully and stays unit-testable.
 */

export interface DecomposableStory {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  issueType: string;
  storyPoints?: number;
}

export interface StoryCodebaseHints {
  architecture?: string;
  frontendStack?: string;
  backendStack?: string;
  testingStrategy?: string;
}

export type StoryComplexity = 'low' | 'medium' | 'high';

export interface StoryCharacteristics {
  hasFrontend: boolean;
  hasBackend: boolean;
  affectsDatabase: boolean;
  needsAPI: boolean;
  needsAuth: boolean;
  needsIntegration: boolean;
  complexity: StoryComplexity;
}

export interface ClarifyingQuestionOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  options: ClarifyingQuestionOption[];
  category: 'split' | 'strategy' | 'scope' | 'justification';
  /** Show a free-text field (alone, or with an "Other" radio). */
  allowCustom?: boolean;
  /** freeform = textarea only; choice = radios (default). */
  inputKind?: 'choice' | 'freeform';
}

/** Minimal enrichment slice used to turn AI reading into justification questions. */
export interface EnrichmentQuestionSource {
  goal?: string;
  subtasks?: Array<{ title: string; description?: string }>;
  acceptanceCriteria?: string[];
  pmContext?: { openQuestions?: string[]; summary?: string };
  developerTaskPlan?: {
    questionsForPM?: string[];
    implementationTasks?: Array<{ title: string }>;
  };
}

export interface StorySplitStrategy {
  splitFrontendBackend: boolean;
  separateMigration: boolean;
  includeTestTask: boolean;
  includeE2E: boolean;
  separateApiDesign: boolean;
}

export interface DecomposedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  estimatedHours: number;
  affectedFiles: string[];
  dependencies: string[];
  proofPoints: string[];
  developerContext: string;
}

export interface TaskDecompositionResult {
  tasks: DecomposedTask[];
  totalEstimatedHours: number;
  recommendedSprint: string;
  generatedBy: 'llm' | 'heuristic';
  modelProvider?: string;
  modelName?: string;
}

const DECOMPOSABLE_ISSUE_TYPES = /^(story|epic|user story|feature)$/i;

/** Stories and Epics get "Create Tasks from Story"; everything else keeps "Start Thread". */
export function isDecomposableIssueType(issueType?: string): boolean {
  return Boolean(issueType && DECOMPOSABLE_ISSUE_TYPES.test(issueType.trim()));
}

export function detectStoryCharacteristics(story: DecomposableStory): StoryCharacteristics {
  const text = `${story.title} ${story.description} ${story.acceptanceCriteria.join(' ')}`.toLowerCase();
  const points = typeof story.storyPoints === 'number' ? story.storyPoints : undefined;
  // Without story points, epics read as high complexity, stories as medium —
  // an epic with no estimate still deserves the testing-strategy question.
  const fallbackComplexity: StoryComplexity = /epic/i.test(story.issueType) ? 'high' : 'medium';
  return {
    hasFrontend: /frontend|front-end|\bui\b|ux|button|form|modal|dialog|page|component|screen|view|css|render/i.test(text),
    hasBackend: /backend|back-end|\bapi\b|endpoint|service|database|server|logic|handler|worker|queue|cron/i.test(text),
    affectsDatabase: /database|\btable\b|schema|migration|\bsql\b|postgres|supabase|store|persist|column/i.test(text),
    needsAPI: /\bapi\b|endpoint|rest|graphql|webhook|\brpc\b/i.test(text),
    needsAuth: /\bauth\b|oauth|login|permission|role|security|token|session/i.test(text),
    needsIntegration: /integrat|third.?party|external|webhook|\bsdk\b/i.test(text),
    complexity: points === undefined
      ? fallbackComplexity
      : points >= 8 ? 'high' : points >= 5 ? 'medium' : 'low',
  };
}

export function buildClarifyingQuestions(characteristics: StoryCharacteristics): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];

  if (characteristics.hasFrontend && characteristics.hasBackend) {
    questions.push({
      id: 'frontend_backend_split',
      question: 'Should we split Frontend and Backend into separate tasks?',
      options: [
        { id: 'split', label: 'Split into Frontend + Backend', recommended: true },
        { id: 'keep_together', label: 'Keep as one task (single dev)' },
        { id: 'frontend_first', label: 'Frontend first, then Backend' },
      ],
      category: 'split',
    });
  }

  if (characteristics.affectsDatabase) {
    questions.push({
      id: 'database_strategy',
      question: 'How should database changes be handled?',
      options: [
        { id: 'separate_migration', label: 'Create separate migration task', recommended: true },
        { id: 'include_backend', label: 'Include with backend task' },
        { id: 'rolling_change', label: 'Zero-downtime migration (separate task)' },
      ],
      category: 'split',
    });
  }

  if (characteristics.complexity === 'high') {
    questions.push({
      id: 'testing_strategy',
      question: 'What testing coverage is needed?',
      options: [
        { id: 'unit_integration', label: 'Unit + Integration tests', recommended: true },
        { id: 'e2e_included', label: 'Include E2E tests (separate task)' },
        { id: 'manual_qa', label: 'Manual QA only' },
      ],
      category: 'strategy',
    });
  }

  if (characteristics.needsAPI) {
    questions.push({
      id: 'api_design',
      question: 'Is the API contract already designed?',
      options: [
        { id: 'designed', label: 'Yes, ready to implement', recommended: true },
        { id: 'design_task', label: 'No, create separate API design task' },
      ],
      category: 'scope',
    });
  }

  return questions.slice(0, 4);
}

function dedupeQuestions(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const text = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length < 8) { continue; }
    const key = text.toLowerCase();
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(text.slice(0, 280));
  }
  return out;
}

/**
 * Build justification questions from what PM enrichment actually read.
 * Falls back to heuristic split questions when enrichment is empty, and always
 * returns at least one freeform question so Create Tasks never skips Q&A.
 */
export function buildClarifyingQuestionsFromEnrichment(
  characteristics: StoryCharacteristics,
  enrichment?: EnrichmentQuestionSource | null,
  issueType?: string,
): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];
  const label = /epic/i.test(issueType || '') ? 'epic' : 'story';
  const draftTitles = dedupeQuestions([
    ...(enrichment?.subtasks || []).map(s => s.title),
    ...(enrichment?.developerTaskPlan?.implementationTasks || []).map(t => t.title),
  ]).slice(0, 6);

  if (draftTitles.length) {
    questions.push({
      id: 'proposed_split',
      question: `After reading this ${label}, the AI suggests these implementation tasks:\n• ${draftTitles.join('\n• ')}\nHow should we create the final task list?`,
      options: [
        { id: 'accept_proposed', label: 'Use this split', recommended: true },
        { id: 'fewer_tasks', label: 'Fewer, broader tasks' },
        { id: 'more_tasks', label: 'More, finer-grained tasks' },
        { id: 'custom', label: 'Different split — describe below' },
      ],
      category: 'justification',
      allowCustom: true,
    });
  } else if (enrichment?.goal) {
    const goal = enrichment.goal.trim().slice(0, 160);
    questions.push({
      id: 'split_approach',
      question: `AI read the ${label} goal as: “${goal}${enrichment.goal.trim().length > 160 ? '…' : ''}”. How should we break it into tasks?`,
      options: [
        { id: 'by_layer', label: 'By layer (frontend / backend / data)', recommended: true },
        { id: 'by_user_flow', label: 'By user flow / feature slice' },
        { id: 'single_task', label: 'One implementation task + tests' },
        { id: 'custom', label: 'Custom approach — describe below' },
      ],
      category: 'justification',
      allowCustom: true,
    });
  }

  const openQs = dedupeQuestions([
    ...(enrichment?.pmContext?.openQuestions || []),
    ...(enrichment?.developerTaskPlan?.questionsForPM || []),
  ]).slice(0, 3);

  openQs.forEach((text, index) => {
    questions.push({
      id: `ai_q_${index}`,
      question: text,
      options: [],
      category: 'justification',
      allowCustom: true,
      inputKind: 'freeform',
    });
  });

  // Keep useful split heuristics when there is room — they still shape the harness.
  for (const heuristic of buildClarifyingQuestions(characteristics)) {
    if (questions.length >= 5) { break; }
    if (questions.some(q => q.id === heuristic.id)) { continue; }
    questions.push({ ...heuristic, allowCustom: true });
  }

  if (!questions.length) {
    questions.push({
      id: 'custom_split',
      question: `How should we create implementation tasks from this ${label}? Call out must-haves, out of scope, and ordering.`,
      options: [],
      category: 'justification',
      allowCustom: true,
      inputKind: 'freeform',
    });
  }

  return questions.slice(0, 5);
}

export function determineSplitStrategy(answers: Record<string, string>): StorySplitStrategy {
  return {
    splitFrontendBackend: answers.frontend_backend_split === 'split' || answers.frontend_backend_split === 'frontend_first',
    separateMigration: answers.database_strategy === 'separate_migration' || answers.database_strategy === 'rolling_change',
    includeTestTask: answers.testing_strategy !== 'manual_qa',
    includeE2E: answers.testing_strategy === 'e2e_included',
    separateApiDesign: answers.api_design === 'design_task',
  };
}

/** Pro caps generated subtasks at 3, Max at 5; Free cannot decompose. */
export function subtaskLimitForTier(tier: string): number {
  const normalized = tier.toLowerCase();
  if (normalized === 'max') { return 5; }
  if (normalized === 'pro') { return 3; }
  return 0;
}

/**
 * Accept only a bare calendar date (YYYY-MM-DD) — what the date input emits and
 * what Jira's `duedate` field takes. Anything else is dropped rather than
 * guessed at, so a malformed value never fails the whole creation call.
 */
export function normalizeTaskDueDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') { return undefined; }
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { return undefined; }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) { return undefined; }
  // Round-trip guards against real-looking but invalid dates like 2026-02-31,
  // which Date silently rolls forward into March.
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

export function recommendSprint(totalHours: number): string {
  if (totalHours <= 16) { return 'Current sprint (1 dev)'; }
  if (totalHours <= 40) { return 'Next sprint (2 devs)'; }
  return 'Next 2 sprints (3 devs)';
}

export function generateHeuristicTasks(
  story: DecomposableStory,
  characteristics: StoryCharacteristics,
  strategy: StorySplitStrategy,
  limit: number,
  hints?: StoryCodebaseHints,
): DecomposedTask[] {
  const tasks: DecomposedTask[] = [];
  const frontendStack = hints?.frontendStack || 'the existing frontend stack';
  const backendStack = hints?.backendStack || 'the existing backend stack';
  const testingStack = hints?.testingStrategy || 'the existing test setup';

  if (strategy.separateApiDesign && characteristics.needsAPI) {
    tasks.push({
      title: `API Design - ${story.title}`,
      description: `Design and document the API contract for: ${story.title}. Agree request/response shapes and error cases before implementation starts.`,
      acceptanceCriteria: ['API contract documented and reviewed', 'Error cases and status codes defined'],
      estimatedHours: 3,
      affectedFiles: [],
      dependencies: [],
      proofPoints: ['Contract doc linked on the story', 'Backend and frontend owners signed off'],
      developerContext: 'Produce the contract first so frontend and backend tasks can proceed in parallel.',
    });
  }

  if (characteristics.affectsDatabase && strategy.separateMigration) {
    tasks.push({
      title: `Database - Migration for ${story.title}`,
      description: `Create the database migration required by: ${story.title}.`,
      acceptanceCriteria: ['Migration runs successfully', 'Rollback works', 'No data loss'],
      estimatedHours: 2,
      affectedFiles: ['migrations/'],
      dependencies: [],
      proofPoints: ['Migration applies cleanly', 'Rollback reverses changes'],
      developerContext: 'Create a reversible migration. Include data seeding if needed.',
    });
  }

  const backendDeps = tasks.filter(t => t.title.startsWith('Database -') || t.title.startsWith('API Design -')).map(t => t.title);
  if (characteristics.hasBackend && (strategy.splitFrontendBackend || !characteristics.hasFrontend)) {
    tasks.push({
      title: `Backend - ${story.title}`,
      description: `Implement the backend logic for: ${story.title}.`,
      acceptanceCriteria: ['Endpoints return correct data', 'Error cases handled properly', 'Performance acceptable'],
      estimatedHours: 12,
      affectedFiles: [],
      dependencies: backendDeps,
      proofPoints: ['API responds to requests', 'All edge cases handled'],
      developerContext: `Use ${backendStack}. Follow existing API patterns.`,
    });
  }

  if (characteristics.hasFrontend && (strategy.splitFrontendBackend || !characteristics.hasBackend)) {
    tasks.push({
      title: `Frontend - ${story.title}`,
      description: `Implement the user interface for: ${story.title}.`,
      acceptanceCriteria: ['Components render correctly', 'All user interactions work', 'Responsive on mobile and desktop'],
      estimatedHours: 8,
      affectedFiles: [],
      dependencies: tasks.filter(t => t.title.startsWith('Backend -')).map(t => t.title),
      proofPoints: ['Clickable UI', 'No console errors'],
      developerContext: `Use ${frontendStack}. Follow existing component patterns.`,
    });
  }

  // Combined implementation task when the user chose not to split (or the
  // story is neither clearly frontend nor backend).
  if (!tasks.some(t => t.title.startsWith('Backend -') || t.title.startsWith('Frontend -'))) {
    tasks.push({
      title: `Implementation - ${story.title}`,
      description: `Implement end-to-end: ${story.title}.`,
      acceptanceCriteria: story.acceptanceCriteria.length
        ? story.acceptanceCriteria.slice(0, 4)
        : ['Feature works as described in the story'],
      estimatedHours: characteristics.complexity === 'high' ? 16 : characteristics.complexity === 'medium' ? 10 : 6,
      affectedFiles: [],
      dependencies: backendDeps,
      proofPoints: ['Feature demoed against acceptance criteria'],
      developerContext: `Single-dev task covering frontend and backend. Use ${frontendStack} and ${backendStack}.`,
    });
  }

  if (strategy.includeTestTask) {
    const implTitles = tasks
      .filter(t => /^(Backend|Frontend|Implementation) -/.test(t.title))
      .map(t => t.title);
    tasks.push({
      title: `Tests - ${story.title}`,
      description: `Write ${strategy.includeE2E ? 'unit, integration, and E2E' : 'unit and integration'} tests for: ${story.title}.`,
      acceptanceCriteria: ['All acceptance criteria covered by tests', 'Edge cases tested', 'CI passes'],
      estimatedHours: strategy.includeE2E ? 8 : 6,
      affectedFiles: [],
      dependencies: implTitles,
      proofPoints: ['Test run output shows new coverage', 'CI green'],
      developerContext: `Use ${testingStack}. Test happy path plus error cases.`,
    });
  }

  return clampTasks(tasks, limit);
}

/**
 * Enforce the tier's subtask limit while keeping dependency references valid:
 * dropped tasks are removed from surviving tasks' dependency lists.
 */
export function clampTasks(tasks: DecomposedTask[], limit: number): DecomposedTask[] {
  if (limit <= 0) { return []; }
  const kept = tasks.slice(0, limit);
  const keptTitles = new Set(kept.map(t => t.title));
  return kept.map(t => ({ ...t, dependencies: t.dependencies.filter(dep => keptTitles.has(dep)) }));
}

export interface OrderedTask extends DecomposedTask {
  /** 1-based position in the recommended execution order. */
  order: number;
  /** Titles this task waits on that are not yet done — empty means startable now. */
  blockedBy: string[];
}

/**
 * Recommended execution order: dependencies first (topological), ties broken by
 * the order the generator emitted. Cycles or references to unknown tasks never
 * drop a task — it is appended and its unresolved deps are reported as
 * blockedBy, so the picker can still offer it rather than hiding work.
 */
export function recommendTaskOrder(tasks: DecomposedTask[]): OrderedTask[] {
  const byTitle = new Map(tasks.map(t => [t.title, t]));
  const emitted = new Set<string>();
  const ordered: DecomposedTask[] = [];

  // Repeatedly take the first task whose in-list dependencies are all emitted.
  let progress = true;
  while (ordered.length < tasks.length && progress) {
    progress = false;
    for (const task of tasks) {
      if (emitted.has(task.title)) { continue; }
      const pending = task.dependencies.filter(dep => byTitle.has(dep) && !emitted.has(dep));
      if (pending.length) { continue; }
      emitted.add(task.title);
      ordered.push(task);
      progress = true;
    }
  }
  // Anything left is part of a dependency cycle — keep it, flagged.
  for (const task of tasks) {
    if (!emitted.has(task.title)) { ordered.push(task); }
  }

  // Nothing has been started yet, so every in-list dependency still blocks.
  // Dependencies on titles outside this plan are dropped rather than blocking
  // a task forever on work Tyne cannot track.
  return ordered.map((task, index) => ({
    ...task,
    order: index + 1,
    blockedBy: task.dependencies.filter(dep => byTitle.has(dep)),
  }));
}

export function buildDecompositionResult(
  tasks: DecomposedTask[],
  generatedBy: 'llm' | 'heuristic',
  modelProvider?: string,
  modelName?: string,
): TaskDecompositionResult {
  const totalEstimatedHours = tasks.reduce((sum, t) => sum + t.estimatedHours, 0);
  return {
    tasks,
    totalEstimatedHours,
    recommendedSprint: recommendSprint(totalEstimatedHours),
    generatedBy,
    modelProvider,
    modelName,
  };
}

/** Sanitize the edge function's (LLM-produced) JSON into typed tasks. */
export function parseDecomposedTasks(value: unknown, limit: number): DecomposedTask[] {
  if (!Array.isArray(value)) { return []; }
  const tasks: DecomposedTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') { continue; }
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) { continue; }
    const hours = Number(r.estimatedHours);
    tasks.push({
      title: title.slice(0, 180),
      description: typeof r.description === 'string' ? r.description.trim().slice(0, 2000) : '',
      acceptanceCriteria: toTrimmedStrings(r.acceptanceCriteria).slice(0, 6),
      estimatedHours: Number.isFinite(hours) && hours > 0 ? Math.min(Math.round(hours), 80) : 4,
      affectedFiles: toTrimmedStrings(r.affectedFiles).slice(0, 10),
      dependencies: toTrimmedStrings(r.dependencies).slice(0, 5),
      proofPoints: toTrimmedStrings(r.proofPoints).slice(0, 5),
      developerContext: typeof r.developerContext === 'string' ? r.developerContext.trim().slice(0, 1000) : '',
    });
  }
  return clampTasks(tasks, limit);
}

function toTrimmedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean);
}
