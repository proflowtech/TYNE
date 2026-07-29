import type { SidebarHost, SidebarPmTaskRequest } from './sidebarHost';
import { saveState } from '../stateManager';
import {
  TynePmTool,
  TynePmTaskIntelligence,
} from '../taskTypes';
import { getPmTaskIntelligenceService } from '../pmTaskIntelligenceService';
import {
  hasActionableEnrichment,
  hasEnrichmentContent,
  runEnrichment,
} from '../taskEnrichmentService';
import { collectCodebaseContext } from '../codebaseContextService';
import { normalizeError } from '../validationContextTypes';
import {
  listCachedTasksSync,
  getCachedTaskDetailsSync,
  saveTaskDetails,
} from '../taskCacheService';
import { getAdapter } from '../taskProviderRegistry';
import { pullTaskDetails } from '../taskPullService';

type PmIntelligenceHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'userProfile'
  | 'findCachedTask'
  | 'taskShellForId'
  | 'postThreadCreateTasksVisibility'
  | 'logJira'
>;

export class PmIntelligenceController {
  private enrichmentDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: PmIntelligenceHost) {}

  getStoredPmIntelligence(taskId: string): TynePmTaskIntelligence | null {
    const id = this.host.findCachedTask(taskId)?.id || taskId;
    return (getCachedTaskDetailsSync(this.host.context, id)
      || getCachedTaskDetailsSync(this.host.context, taskId))?.pmIntelligence || null;
  }

  async storePmIntelligence(taskId: string, intelligence: TynePmTaskIntelligence): Promise<void> {
    const cached = this.host.findCachedTask(taskId);
    const id = cached?.id || taskId;
    const details = getCachedTaskDetailsSync(this.host.context, id)
      || getCachedTaskDetailsSync(this.host.context, taskId);
    if (details) {
      await saveTaskDetails(this.host.context, { ...details, pmIntelligence: intelligence });
      return;
    }
    const base = cached ?? this.host.taskShellForId(taskId);
    if (!base) { return; }
    await saveTaskDetails(this.host.context, {
      ...base,
      subtasks: [],
      comments: [],
      notes: [],
      historyLast30Days: [],
      pmIntelligence: intelligence,
    });
  }

  scheduleEnrichmentFromThreadEdit(): void {
    if (this.enrichmentDebounceTimer) { clearTimeout(this.enrichmentDebounceTimer); }
    this.enrichmentDebounceTimer = setTimeout(() => {
      void this.runEnrichmentForActiveThreadTask('thread_field_edit');
    }, 600);
  }

  async runEnrichmentForActiveThreadTask(reason: string): Promise<void> {
    const taskId = this.host.state.taskId?.trim();
    const tool = this.host.state.taskSource as TynePmTool;
    if (!taskId || (tool !== 'jira' && tool !== 'linear')) { return; }
    const cached = listCachedTasksSync(this.host.context).find(t => t.id === taskId);
    const issueType = cached?.issueType;
    this.host.logJira(`Enrichment (${reason}) for ${taskId}`);
    const enrichment = await this.extractIntelligenceForStartThread(taskId, tool, this.host.state.taskTitle || this.host.state.goal, issueType);
    if (enrichment.intelligence) {
      const intelligence = enrichment.intelligence;
      this.host.state.pmTaskContext = intelligence;
      this.host.state.pmEnrichmentStatus = hasEnrichmentContent(intelligence) ? 'success' : 'partial';
      this.host.state.pmEnrichmentError = '';
      if (intelligence.goal) { this.host.state.goal = intelligence.goal; }
      this.host.state.acceptanceCriteria = intelligence.acceptanceCriteria || [];
      this.host.state.proofPointTemplates = intelligence.proofPointTemplates || [];
      this.host.state.validationSteps = intelligence.validationSteps || [];
      this.host.state.subtasks = (intelligence.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    } else {
      this.host.state.pmEnrichmentStatus = enrichment.error ? 'failed' : 'skipped';
      this.host.state.pmEnrichmentError = enrichment.error || '';
    }
    await saveState(this.host.context, this.host.state);
    this.postEnrichmentToWebview(taskId);
  }

  postEnrichmentToWebview(taskId: string): void {
    this.host.postMessage({
      type: 'pmEnrichmentUpdated',
      taskId,
      pmEnrichmentStatus: this.host.state.pmEnrichmentStatus,
      pmEnrichmentError: this.host.state.pmEnrichmentError,
      acceptanceCriteria: this.host.state.acceptanceCriteria,
      proofPointTemplates: this.host.state.proofPointTemplates,
      validationSteps: this.host.state.validationSteps,
      goal: this.host.state.goal,
      subtasks: this.host.state.subtasks,
      pmTaskContext: this.host.state.pmTaskContext,
    });
    this.host.postThreadCreateTasksVisibility(taskId);
  }

  async ensurePmIntelligencePosted(
    taskId: string,
    fromDetails?: TynePmTaskIntelligence | null,
  ): Promise<void> {
    const stored = fromDetails || this.getStoredPmIntelligence(taskId);
    if (hasActionableEnrichment(stored)) {
      this.host.postMessage({
        type: 'pmTaskIntelligenceLoaded',
        taskId,
        intelligence: stored,
        forceRefresh: false,
      });
      return;
    }
    await this.fetchAndPostPmTaskIntelligence(taskId, false);
  }

  async fetchAndPostPmTaskIntelligence(taskId: string, forceRefresh: boolean): Promise<void> {
    if (!taskId) { return; }
    const source = taskId.startsWith('linear:') ? 'linear' : 'jira';
    const request = await this.resolvePmTaskRequest(taskId, source);
    if (!request) { return; }
    try {
      this.host.postMessage({ type: 'pmTaskIntelligenceLoading', taskId });
      this.postPmEnrichmentLoading(taskId);
      // Gather codebase context so likelyFiles are populated in the task detail view.
      const codebaseContext = await collectCodebaseContext({
        issueTitle: undefined,
        issueDescription: undefined,
        changedFiles: [],
        diffText: undefined,
      });
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
      await this.storePmIntelligence(taskId, intelligence);
      this.host.postMessage({
        type: 'pmTaskIntelligenceLoaded',
        taskId,
        intelligence,
        forceRefresh,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'pmTaskIntelligenceError', taskId, message: msg });
    } finally {
      this.postPmEnrichmentDone();
    }
  }

  async resolvePmTaskRequest(
    taskId: string,
    tool: 'jira' | 'linear',
  ): Promise<SidebarPmTaskRequest | null> {
    if (tool === 'jira') {
      const jiraAdapter = getAdapter('jira') as { getCloudId?: () => Promise<string> } | null;
      const cloudId = jiraAdapter?.getCloudId ? await jiraAdapter.getCloudId() : '';
      if (!cloudId) { return null; }
      const issueKey = taskId.startsWith('jira:') ? taskId.slice(5) : taskId;
      return {
        source: 'jira',
        issueId: issueKey,
        issueIdentifier: issueKey,
        cloudId,
      };
    }

    const linearAdapter = getAdapter('linear') as { getWorkspaceId?: () => Promise<string> } | null;
    const linearWorkspaceId = linearAdapter?.getWorkspaceId ? await linearAdapter.getWorkspaceId() : '';
    const issueId = taskId.replace(/^linear:/, '');
    const details = await pullTaskDetails(this.host.context, taskId, 'linear').catch(() => null);
    const issueIdentifier = details?.externalId || issueId;
    return {
      source: 'linear',
      issueId,
      issueIdentifier,
      linearWorkspaceId,
    };
  }

  postPmEnrichmentLoading(taskId: string, title?: string): void {
    this.host.postMessage({
      type: 'pmEnrichmentLoading',
      taskId,
      title: title || this.host.state.taskTitle || taskId,
    });
  }

  postPmEnrichmentDone(): void {
    this.host.postMessage({ type: 'pmEnrichmentDone' });
  }

  async extractIntelligenceForStartThread(
    taskId: string,
    tool: TynePmTool,
    title?: string,
    issueType?: string,
  ): Promise<{ intelligence: TynePmTaskIntelligence | null; error?: string }> {
    if (tool !== 'jira' && tool !== 'linear') { return { intelligence: null }; }
    const cached = listCachedTasksSync(this.host.context).find(t => t.id === taskId);
    const resolvedType = issueType || cached?.issueType;
    const state = await runEnrichment(taskId, {
      issueType: resolvedType,
      extract: async () => {
        const request = await this.resolvePmTaskRequest(taskId, tool);
        if (!request) { return { intelligence: null, error: `Could not resolve ${tool} task request.` }; }
        this.postPmEnrichmentLoading(taskId, title);
        try {
          const pmService = getPmTaskIntelligenceService(this.host.context);
          const codebaseContext = await collectCodebaseContext({
            issueTitle: title || this.host.state.taskTitle || this.host.state.goal,
            issueDescription: this.host.state.goal,
            acceptanceCriteria: this.host.state.acceptanceCriteria,
            subtasks: this.host.state.subtasks.map(s => ({ title: s.text })),
            validationSteps: this.host.state.validationSteps,
          });
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
        } catch (err) {
          console.warn('PM task intelligence extraction failed during enrichment:', err);
          return { intelligence: null, error: normalizeError(err) };
        } finally {
          this.postPmEnrichmentDone();
        }
      },
    });
    if (state.intelligence) { await this.storePmIntelligence(taskId, state.intelligence); }
    this.host.postThreadCreateTasksVisibility(taskId);
    return { intelligence: state.intelligence, error: state.error };
  }

  async handleRetryPmEnrichment(): Promise<void> {
    const taskId = this.host.state.taskId;
    const tool = this.host.state.taskSource as TynePmTool;
    if (!taskId || (tool !== 'jira' && tool !== 'linear')) {
      this.host.postMessage({ type: 'error', message: 'Select a Jira or Linear task before retrying PM enrichment.' });
      return;
    }
    const enrichment = await this.extractIntelligenceForStartThread(taskId, tool, this.host.state.taskTitle);
    if (!enrichment.intelligence) {
      this.host.state.pmEnrichmentStatus = 'failed';
      this.host.state.pmEnrichmentError = enrichment.error || 'PM enrichment failed.';
      await saveState(this.host.context, this.host.state);
      this.host.postMessage({
        type: 'pmEnrichmentUpdated',
        pmEnrichmentStatus: this.host.state.pmEnrichmentStatus,
        pmEnrichmentError: this.host.state.pmEnrichmentError,
      });
      return;
    }
    const intelligence = enrichment.intelligence;
    this.host.state.pmTaskContext = intelligence;
    this.host.state.pmEnrichmentStatus = hasEnrichmentContent(intelligence) ? 'success' : 'partial';
    this.host.state.pmEnrichmentError = '';
    if (intelligence.goal) { this.host.state.goal = intelligence.goal; }
    this.host.state.acceptanceCriteria = intelligence.acceptanceCriteria || [];
    this.host.state.proofPointTemplates = intelligence.proofPointTemplates || [];
    this.host.state.validationSteps = intelligence.validationSteps || [];
    this.host.state.subtasks = (intelligence.subtasks || []).map(s => ({ id: `${Date.now()}-${s.title}`, text: s.title, done: false }));
    await saveState(this.host.context, this.host.state);
    this.host.postMessage({
      type: 'prefillThread',
      taskId,
      taskTitle: this.host.state.taskTitle,
      taskSource: tool,
      taskUrl: this.host.state.taskUrl,
      goal: this.host.state.goal,
      subtasks: this.host.state.subtasks,
      acceptanceCriteria: this.host.state.acceptanceCriteria,
      proofPointTemplates: this.host.state.proofPointTemplates,
      validationSteps: this.host.state.validationSteps,
      pmTaskContext: intelligence,
      pmEnrichmentStatus: this.host.state.pmEnrichmentStatus,
      pmEnrichmentError: this.host.state.pmEnrichmentError,
    });
  }
}
