import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import type { TynePmTaskIntelligence, TynePmTool } from '../taskTypes';
import { getPmTaskIntelligenceService } from '../pmTaskIntelligenceService';
import { getStoryDecompositionService, StoryDecompositionLimitError } from '../storyDecompositionService';
import {
  buildClarifyingQuestionsFromEnrichment,
  DecomposableStory,
  DecomposedTask,
  detectStoryCharacteristics,
  normalizeTaskDueDate,
  parseDecomposedTasks,
  recommendTaskOrder,
  StoryCharacteristics,
  subtaskLimitForTier,
  TaskDecompositionResult,
} from '../storyDecompositionHarness';
import { runEnrichment, hasActionableEnrichment } from '../taskEnrichmentService';
import { collectCodebaseContext } from '../codebaseContextService';
import { normalizeTier } from '../codeValidationService';
import { getCachedTaskDetailsSync, listCachedTasksSync, saveTasks } from '../taskCacheService';
import { getConnectedToolsSync, getAdapter } from '../taskProviderRegistry';
import { pullTasks, DEFAULT_PULL_INPUT, pullTaskDetails } from '../taskPullService';
import { buildPmSubtaskDescription } from './sidebarHtml';

const DECOMPOSED_TASKS_KEY = 'tyne.storyDecomposedTasks';

export interface StoredDecomposition {
  parentTaskId: string;
  tool: TynePmTool;
  createdAt: string;
  tasks: Array<DecomposedTask & { pmKey?: string; pmUrl?: string }>;
}

type StoryDecomposeSession = {
  story: DecomposableStory;
  tool: TynePmTool;
  characteristics: StoryCharacteristics;
  codebaseContext?: import('../taskTypes').TyneCodebaseContextPack;
  result?: TaskDecompositionResult;
};

type StoryDecomposeHost = Pick<
  SidebarHost,
  | 'context'
  | 'postMessage'
  | 'userProfile'
  | 'findCachedTask'
  | 'resolvePmTaskRequest'
  | 'storePmIntelligence'
  | 'getStoredPmIntelligence'
  | 'postThreadCreateTasksVisibility'
  | 'refreshTasksContext'
  | 'startThreadFromTask'
  | 'logJira'
  | 'jiraKeyFromTaskId'
>;

export class StoryDecompositionController {
  private readonly sessions = new Map<string, StoryDecomposeSession>();

  constructor(private readonly host: StoryDecomposeHost) {}

  cancel(taskId: string): void {
    this.sessions.delete(taskId);
  }

  // ── Story decomposition (Epic/Story → technical tasks) ────────────────────

  postStoryDecompose(message: Record<string, unknown>): void {
    this.host.postMessage(message);
  }

  resolveDecomposableStory(taskId: string): { story: DecomposableStory; tool: TynePmTool; sourceUrl?: string } | null {
    const cached = this.host.findCachedTask(taskId);
    if (!cached) { return null; }
    const details = getCachedTaskDetailsSync(this.host.context, cached.id) || getCachedTaskDetailsSync(this.host.context, taskId);
    return {
      story: {
        title: cached.title,
        description: details?.description || cached.description || '',
        acceptanceCriteria: [],
        issueType: cached.issueType || details?.issueType || 'story',
      },
      tool: (cached.sourceTool as TynePmTool) || 'jira',
      sourceUrl: cached.sourceUrl,
    };
  }

  getStoredDecomposition(taskId: string): StoredDecomposition | null {
    const all = this.host.context.workspaceState.get<Record<string, StoredDecomposition>>(
      DECOMPOSED_TASKS_KEY, {});
    const entry = all?.[taskId];
    return entry && Array.isArray(entry.tasks) && entry.tasks.length ? entry : null;
  }

  /**
   * A previously decomposed epic reopens on its generated tasks rather than
   * offering decomposition again — re-running is a deliberate secondary action.
   */
  postStoredDecompositionIfAny(taskId: string): void {
    const stored = this.getStoredDecomposition(taskId);
    if (!stored) { return; }
    this.postStoryDecompose({
      type: 'storyDecomposeExisting',
      taskId,
      tool: stored.tool,
      createdAt: stored.createdAt,
      tasks: recommendTaskOrder(stored.tasks),
    });
  }

  /** Step 1: analyze the story locally + collect codebase context, then send clarifying questions. */
  async analyze(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    const tier = normalizeTier(this.host.userProfile.tier);
    if (subtaskLimitForTier(tier) <= 0) {
      this.postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: 'Creating tasks from a Story or Epic is available in Pro and Max.',
        upgradeRequired: true,
      });
      return;
    }
    const resolved = this.resolveDecomposableStory(taskId);
    if (!resolved) {
      this.postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'Task details unavailable. Refresh tasks and try again.' });
      return;
    }
    this.host.logJira(`Story decomposition started: ${taskId}`);

    const step = (id: string, status: 'active' | 'done') =>
      this.postStoryDecompose({ type: 'storyDecomposeProgress', taskId, phase: 'analyze', step: id, status });

    try {
      step('read_story', 'active');
      const { story } = resolved;
      step('read_story', 'done');

      step('scan_codebase', 'active');
      const codebaseContext = await collectCodebaseContext({
        issueTitle: story.title,
        issueDescription: story.description,
      }).catch(() => undefined);
      step('scan_codebase', 'done');

      // PM enrichment first: read the epic/story so questions are about this
      // issue's goal, open questions, and proposed split — not generic templates.
      step('parse_criteria', 'active');
      const enrichment = await this.enrichStoryForDecomposition(taskId, codebaseContext);
      if (enrichment) {
        if (enrichment.goal) { story.description = `${story.description}\n\n${enrichment.goal}`.trim(); }
        story.acceptanceCriteria = enrichment.acceptanceCriteria || [];
      }
      step('parse_criteria', 'done');

      step('find_modules', 'active');
      const characteristics = detectStoryCharacteristics(story);
      const questions = buildClarifyingQuestionsFromEnrichment(characteristics, enrichment, story.issueType);
      step('find_modules', 'done');

      this.sessions.set(taskId, { story, tool: resolved.tool, characteristics, codebaseContext });
      this.postStoryDecompose({
        type: 'storyDecomposeQuestions',
        taskId,
        questions,
        characteristics,
        goal: enrichment?.goal || (story.acceptanceCriteria.length ? undefined : 'No acceptance criteria found on this epic.'),
      });
    } catch (err: unknown) {
      this.postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: err instanceof Error ? err.message : 'Story analysis failed.',
      });
    }
  }

  /**
   * Run PM enrichment for a story/epic purely to feed decomposition. Failure is
   * non-fatal — decomposition falls back to the raw issue text — but the reason
   * is logged so a persistent enrichment outage stays visible.
   */
  async enrichStoryForDecomposition(
    taskId: string,
    codebaseContext: ReturnType<typeof collectCodebaseContext> extends Promise<infer T> ? T : never,
  ): Promise<TynePmTaskIntelligence | null> {
    const stored = this.host.getStoredPmIntelligence(taskId);
    if (hasActionableEnrichment(stored)) {
      this.host.postThreadCreateTasksVisibility(taskId);
      return stored;
    }
    const source = taskId.startsWith('linear:') ? 'linear' : 'jira';
    const cached = listCachedTasksSync(this.host.context).find(t => t.id === taskId);
    const state = await runEnrichment(taskId, {
      issueType: cached?.issueType,
      extract: async () => {
        const request = await this.host.resolvePmTaskRequest(taskId, source).catch(() => null);
        if (!request) { return { intelligence: null }; }
        try {
          const pmService = getPmTaskIntelligenceService(this.host.context);
          const intelligence = await pmService.extractIntelligence({
            context: this.host.context,
            source: request.source,
            issueId: request.issueId,
            issueIdentifier: request.issueIdentifier,
            cloudId: request.cloudId,
            linearWorkspaceId: request.linearWorkspaceId,
            tier: this.host.userProfile.tier,
            codebaseContext,
          });
          return { intelligence };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.host.logJira(`Story decomposition enrichment failed for ${taskId}: ${message}`);
          this.postStoryDecompose({ type: 'storyDecomposeEnrichmentWarning', taskId, message });
          return { intelligence: null, error: message };
        }
      },
    });
    if (state.intelligence) { await this.host.storePmIntelligence(taskId, state.intelligence); }
    this.host.postThreadCreateTasksVisibility(taskId);
    return state.intelligence;
  }

  /** Step 3: generate the technical task breakdown from the user's answers. */
  async generate(taskId: string, answers: Record<string, string>): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) {
      this.postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'Decomposition session expired. Re-run the analysis.' });
      return;
    }
    const tier = normalizeTier(this.host.userProfile.tier);
    const safeAnswers: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers || {})) {
      if (typeof value === 'string') { safeAnswers[key] = value; }
    }
    try {
      const service = getStoryDecompositionService(this.host.context);
      const result = await service.decompose({
        source: session.tool,
        issueIdentifier: taskId,
        story: session.story,
        answers: safeAnswers,
        tier,
        codebaseContext: session.codebaseContext,
      });
      session.result = result;
      this.postStoryDecompose({ type: 'storyDecomposeResult', taskId, result });
    } catch (err: unknown) {
      this.postStoryDecompose({
        type: 'storyDecomposeError',
        taskId,
        message: err instanceof Error ? err.message : 'Task generation failed.',
        upgradeRequired: err instanceof StoryDecompositionLimitError,
      });
    }
  }

  /** Step 4: create the generated tasks in Jira (as sub-tasks) and locally in Tyne. */
  async create(
    taskId: string, rawTasks: unknown, createInJira: boolean, rawDueDate?: unknown,
  ): Promise<void> {
    const session = this.sessions.get(taskId);
    const tier = normalizeTier(this.host.userProfile.tier);
    const limit = subtaskLimitForTier(tier);
    const tasks = parseDecomposedTasks(rawTasks, limit);
    if (!tasks.length) {
      this.postStoryDecompose({ type: 'storyDecomposeError', taskId, message: 'No tasks selected to create.' });
      return;
    }
    const tool = session?.tool || 'jira';
    const dueDate = normalizeTaskDueDate(rawDueDate);
    // When the PM tool is connected, always push — "Create in Tyne" alone is local-only offline.
    const connected = getConnectedToolsSync(this.host.context).includes(tool);
    const pushToPm = createInJira || connected;
    const createdInPm: Array<{ key: string; url?: string; title: string }> = [];
    let pmError: string | undefined;

    if (pushToPm) {
      try {
        const adapter = getAdapter(tool);
        if (!adapter.createSubtaskIssues) {
          throw new Error(`${tool} does not support creating sub-tasks from Tyne yet.`);
        }
        const created = await adapter.createSubtaskIssues(
          taskId,
          tasks.map(task => ({ title: task.title, description: buildPmSubtaskDescription(task), dueDate })),
        );
        created.forEach((issue, index) => {
          createdInPm.push({ key: issue.key, url: issue.url, title: tasks[index]?.title || issue.key });
        });
      } catch (err: unknown) {
        pmError = err instanceof Error ? err.message : String(err);
      }
    }

    // Always store locally so a thread can be started per generated task even
    // when PM creation was skipped or failed.
    const storedKey = DECOMPOSED_TASKS_KEY;
    const existing = this.host.context.workspaceState.get<Record<string, StoredDecomposition>>(storedKey, {});
    existing[taskId] = {
      parentTaskId: taskId,
      tool,
      createdAt: new Date().toISOString(),
      tasks: tasks.map((task, index) => ({
        ...task,
        pmKey: createdInPm[index]?.key,
        pmUrl: createdInPm[index]?.url,
      })),
    };
    await this.host.context.workspaceState.update(storedKey, existing);

    // Merge created Jira issues into the task cache so the Task page shows them
    // immediately (pull can miss unassigned issues until assignee settles).
    const mergeCreatedStubs = async () => {
      if (!createdInPm.length || tool !== 'jira') { return; }
      const parent = this.host.findCachedTask(taskId);
      const childType = /epic/i.test(session?.story?.issueType || parent?.issueType || '') ? 'Story' : 'Sub-task';
      const nowIso = new Date().toISOString();
      await saveTasks(this.host.context, createdInPm.map(issue => ({
        id: `jira:${issue.key}`,
        externalId: issue.key,
        title: issue.title,
        status: 'To Do',
        normalizedStatus: 'todo' as const,
        normalizedPriority: 'none' as const,
        sourceTool: 'jira' as const,
        sourceUrl: issue.url,
        sourceProject: parent?.sourceProject,
        parentKey: parent?.externalId || this.host.jiraKeyFromTaskId(taskId),
        issueType: childType,
        dueDate,
        lastSyncedAt: nowIso,
        cachedAt: nowIso,
        isCachedOnly: false,
      }))).catch(() => undefined);
    };
    await mergeCreatedStubs();
    // Saving to the cache is not enough — the Tasks tab renders from the last
    // payload posted to the webview, so without this the new children only
    // appear after the next sync.
    await this.host.refreshTasksContext(true);

    this.host.logJira(`Story decomposition created ${tasks.length} tasks for ${taskId}${createdInPm.length ? ` (${createdInPm.length} in ${tool})` : ''}`);
    this.postStoryDecompose({
      type: 'storyDecomposeCreated',
      taskId,
      createdInPm,
      pmError,
      tyneCount: tasks.length,
      tool,
      // The picker opens on the recommended order so the user starts with the
      // task that unblocks the rest. Reordering means the PM key must be looked
      // up by title, never by index.
      tasks: recommendTaskOrder(tasks).map(task => {
        const pm = createdInPm.find(issue => issue.title === task.title);
        return { ...task, pmKey: pm?.key, pmUrl: pm?.url };
      }),
    });
    this.sessions.delete(taskId);
    if (createdInPm.length) {
      // Force pull so Jira children show up, then re-merge stubs if pull filters them out.
      await pullTasks(this.host.context, tool, { ...DEFAULT_PULL_INPUT, forceRefresh: true }).catch(() => undefined);
      await mergeCreatedStubs();
      await this.host.refreshTasksContext(true).catch(() => undefined);
    } else if (pmError && pushToPm) {
      // Surface failure — do not pretend the Task list updated.
      this.host.postMessage({ type: 'error', message: `Could not create tasks in ${tool}: ${pmError}` });
    }
  }

  /**
   * Start a thread on one of the generated tasks. The remaining tasks stay
   * parked under the epic — nothing is discarded by picking one.
   */
  async startTask(
    parentTaskId: string, pmKey: string | undefined, title: string,
  ): Promise<void> {
    const stored = this.getStoredDecomposition(parentTaskId);
    const tool = stored?.tool || 'jira';
    if (!pmKey) {
      vscode.window.showWarningMessage(
        `"${title}" was not created in ${tool} yet, so it has no issue to start a thread on. Re-run creation with "Create in ${tool}".`,
      );
      return;
    }
    const childTaskId = tool === 'jira' ? pmKey : `linear:${pmKey}`;
    // The sub-task may not be in the cache yet — pull it so the thread has
    // real PM context rather than just a title.
    await pullTaskDetails(this.host.context, childTaskId, tool).catch(() => null);
    await this.host.startThreadFromTask(childTaskId, title, tool, undefined);
  }

  /** Explicit re-run of decomposition for an already-decomposed epic. */
  async regenerate(taskId: string, tool: TynePmTool): Promise<void> {
    const all = this.host.context.workspaceState.get<Record<string, StoredDecomposition>>(
      DECOMPOSED_TASKS_KEY, {});
    delete all[taskId];
    await this.host.context.workspaceState.update(DECOMPOSED_TASKS_KEY, all);
    await this.analyze(taskId, tool);
  }

}
