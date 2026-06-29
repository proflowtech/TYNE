import * as vscode from 'vscode';
import simpleGit from 'simple-git';
import {
  TyneAiProvider,
  TyneAiProviderAdapter,
  TynePlanTier,
  TyneValidationInput,
  TyneValidationLimitDecision,
  TyneValidationResult,
} from './validationTypes';
import { getByokKeyService, ByokKeyService } from './byokKeyService';
import { getValidationUsageService, ValidationUsageService } from './validationUsageService';
import { getValidationHistoryService, ValidationHistoryService } from './validationHistoryService';
import { createAnthropicProvider } from './aiProviders/anthropicProvider';
import { createOpenAiProvider } from './aiProviders/openAiProvider';
import { getCurrentBranch, getGit, getLatestCommit } from './gitManager';
import { getState, TyneState } from './stateManager';
import { pullTaskDetails } from './taskPullService';
import { extractAcceptanceCriteriaFromText } from './jiraTextUtils';
import { normalizeTier, sanitizeDiff } from './validationUtils';
import { getPmTaskIntelligenceService } from './pmTaskIntelligenceService';
import { TynePmTaskValidationResult } from './taskTypes';
import { getAdapter } from './taskProviderRegistry';

export function getCodeValidationService(context: vscode.ExtensionContext): CodeValidationService {
  return new CodeValidationService(
    context,
    getByokKeyService(context),
    getValidationUsageService(context),
    getValidationHistoryService(context),
  );
}

export { normalizeTier, sanitizeDiff } from './validationUtils';

export class CodeValidationService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly byokService: ByokKeyService,
    private readonly usageService: ValidationUsageService,
    private readonly historyService: ValidationHistoryService,
  ) {}

  async canValidate(tier: string): Promise<TyneValidationLimitDecision> {
    const normalizedTier = normalizeTier(tier);
    const hasByok = await this.byokService.hasApiKey();
    const decision = await this.usageService.canRunValidation(normalizedTier, hasByok);
    return decision;
  }

  async validateGoal(tier: string): Promise<TyneValidationResult> {
    return this.validateActiveTask(tier);
  }

  async validateTask(taskId: string, tier: string): Promise<TyneValidationResult> {
    const state = getState(this.context);
    if (state.taskId !== taskId) {
      throw new ValidationError('missing_task', 'Select or link a task before running validation.');
    }
    return this.validateActiveTask(tier);
  }

  async validateActiveTask(tier: string): Promise<TyneValidationResult> {
    const normalizedTier = normalizeTier(tier);
    const state = getState(this.context);

    const git = getGit();
    if (!git) {
      throw new ValidationError('no_git_repo', 'No Git repository found in the current workspace.');
    }
    if (!state.taskId && !state.goal) {
      throw new ValidationError('missing_task', 'Select or link a task before running validation.');
    }

    const hasByok = await this.byokService.hasApiKey();
    const decision = await this.usageService.canRunValidation(normalizedTier, hasByok);
    if (!decision.allowed) {
      throw new ValidationError(decision.reason || 'provider_error', decision.message || 'Validation is not allowed.');
    }

    const input = await this._buildValidationInput(state, normalizedTier);
    if (!input.diffText.trim() && input.changedFiles.length === 0) {
      throw new ValidationError('missing_diff', 'No code changes found to validate.');
    }

    const provider = await this._selectProvider(normalizedTier, hasByok);
    const apiKey = provider.provider === 'managed'
      ? undefined
      : await this._getApiKeyForProvider(provider.provider);
    if (provider.provider !== 'managed' && !apiKey) {
      throw new ValidationError('missing_byok', 'Connect your own AXIOM key to validate code.');
    }

    const start = Date.now();
    const result = await provider.validateCode(input, apiKey || undefined);
    const durationMs = Date.now() - start;
    const enriched: TyneValidationResult = { ...result, durationMs, taskId: state.taskId || result.taskId, taskTitle: state.taskTitle || result.taskTitle };
    await this.usageService.recordValidationRun(enriched);
    await this.historyService.saveValidationResult(enriched);
    return enriched;
  }

  async validateJiraTask(tier: string): Promise<TynePmTaskValidationResult> {
    const normalizedTier = normalizeTier(tier);
    const state = getState(this.context);
    const git = getGit();
    if (!git) {
      throw new ValidationError('no_git_repo', 'No Git repository found in the current workspace.');
    }
    if (!state.taskId) {
      throw new ValidationError('missing_task', 'Select or link a Jira task before running validation.');
    }
    const branchName = await getCurrentBranch();
    const diffData = await this._collectDiff(git);
    if (!diffData.diffText.trim() && diffData.changedFiles.length === 0) {
      throw new ValidationError('missing_diff', 'No code changes found to validate.');
    }

    const jiraAdapter = getAdapter('jira') as { getCloudId?: () => Promise<string> } | null;
    const cloudId = jiraAdapter?.getCloudId ? await jiraAdapter.getCloudId() : '';
    if (!cloudId) {
      throw new ValidationError('provider_error', 'Could not determine Jira cloud ID for validation.');
    }

    const issueKey = state.taskId.startsWith('jira:') ? state.taskId.slice(5) : state.taskId;
    const pmService = getPmTaskIntelligenceService(this.context);
    return pmService.validateTask({
      context: this.context,
      jiraIssueKey: issueKey,
      cloudId,
      tier: normalizedTier,
      currentBranch: branchName,
      diffText: diffData.diffText,
      changedFiles: diffData.changedFiles,
      goal: state.goal,
      subtasks: state.subtasks.map(s => ({ title: s.text, description: '' })),
      acceptanceCriteria: state.acceptanceCriteria,
      proofPointTemplates: state.proofPointTemplates,
      validationSteps: state.validationSteps,
    });
  }

  async buildValidationInput(taskId?: string): Promise<TyneValidationInput> {
    const state = getState(this.context);
    if (taskId && state.taskId !== taskId) {
      throw new ValidationError('missing_task', 'Select or link a task before running validation.');
    }
    return this._buildValidationInput(state, 'free');
  }

  async shouldBlockValidation(tier: string): Promise<{ blocked: boolean; reason?: string }> {
    try {
      const decision = await this.canValidate(tier);
      return { blocked: !decision.allowed, reason: decision.message };
    } catch (err: unknown) {
      return { blocked: true, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async selectValidationProvider(tier: TynePlanTier): Promise<TyneAiProviderAdapter> {
    const hasByok = await this.byokService.hasApiKey();
    return this._selectProvider(tier, hasByok);
  }

  private async _buildValidationInput(state: TyneState, tier: TynePlanTier): Promise<TyneValidationInput> {
    const git = getGit();
    const branchName = git ? await getCurrentBranch() : state.branchName || '';
    const commitInfo = branchName && git ? await getLatestCommit(branchName).catch(() => ({ hash: '', message: '' })) : { hash: '', message: '' };
    const diffData = git ? await this._collectDiff(git) : { diffText: '', changedFiles: [], added: 0, deleted: 0 };
    const taskContext = await this._resolveTaskValidationContext(state);

    return {
      taskId: state.taskId || undefined,
      taskTitle: taskContext.taskTitle,
      taskDescription: taskContext.taskDescription,
      provider: taskContext.provider,
      goal: state.goal || undefined,
      subtasks: state.subtasks.map(s => s.text),
      acceptanceCriteria: taskContext.acceptanceCriteria,
      branchName: branchName || undefined,
      commitHash: commitInfo.hash || undefined,
      changedFiles: diffData.changedFiles,
      diffText: diffData.diffText,
      linesAdded: diffData.added,
      linesDeleted: diffData.deleted,
      tier,
    };
  }

  private async _resolveTaskValidationContext(state: TyneState): Promise<{
    provider?: string;
    taskTitle?: string;
    taskDescription?: string;
    acceptanceCriteria: string[];
  }> {
    const provider = state.taskSource?.trim().toLowerCase() || undefined;
    let taskTitle = state.taskTitle || undefined;
    let taskDescription = state.goal || undefined;
    let acceptanceCriteria: string[] = [];

    if (provider === 'jira' && state.taskId) {
      try {
        const details = await pullTaskDetails(this.context, state.taskId, 'jira');
        taskTitle = details.title || taskTitle;
        taskDescription = details.description?.trim() || taskDescription;
        acceptanceCriteria = extractAcceptanceCriteriaFromText(details.description).criteria;
      } catch {
        // Fall back to the cached state so validation still runs if Jira is temporarily unavailable.
      }
    }

    return { provider, taskTitle, taskDescription, acceptanceCriteria };
  }

  private async _collectDiff(git: ReturnType<typeof simpleGit>): Promise<{ diffText: string; changedFiles: string[]; added: number; deleted: number }> {
    const STITCH_SIGNATURE = '🔗 Tyne stitch:';
    let diffText = '';
    try {
      const status = await git.status();
      if (status.files.length > 0) {
        const [unstagedDiff, stagedDiff] = await Promise.all([
          git.diff(),
          git.diff(['--cached']),
        ]);
        diffText = [unstagedDiff, stagedDiff].filter(Boolean).join('\n');
      }
      if (!diffText) {
        const log = await git.log({ maxCount: 20 });
        const stitchCount = log.all.filter(c => c.message.startsWith(STITCH_SIGNATURE)).length;
        diffText = stitchCount > 0
          ? await git.diff([`HEAD~${stitchCount}`, 'HEAD'])
          : await git.diff(['HEAD~1', 'HEAD']);
      }
      if (!diffText) {
        diffText = await git.diff();
      }
    } catch {
      diffText = await git.diff();
    }

    const changedFiles = diffText
      .split('\n')
      .filter(line => line.startsWith('diff --git'))
      .map(line => {
        const match = line.match(/diff --git a\/(.*?) b\//);
        return match ? match[1] : '';
      })
      .filter(Boolean);

    const added = (diffText.match(/^\+[^+]/gm) || []).length;
    const deleted = (diffText.match(/^-[^-]/gm) || []).length;

    return { diffText: sanitizeDiff(diffText), changedFiles, added, deleted };
  }

  private async _selectProvider(tier: TynePlanTier, hasByok: boolean): Promise<TyneAiProviderAdapter> {
    const configProvider = await this.byokService.getSelectedProvider();
    if (tier === 'free') {
      const usage = await this.usageService.getUsage(tier);
      if (usage.byokUnlimitedActive || (usage.limit !== 'unlimited' && usage.used >= usage.limit)) {
        if (!configProvider) { throw new ValidationError('missing_byok', 'Connect your own AXIOM key to continue with unlimited BYOK validation.'); }
        return this._providerFor(configProvider);
      }
      return new ManagedProviderAdapter(this.context);
    }
    if (tier === 'pro' || tier === 'max') {
      const usage = await this.usageService.getUsage(tier);
      if (usage.byokUnlimitedActive || (usage.limit !== 'unlimited' && usage.used >= usage.limit)) {
        if (!configProvider) { throw new ValidationError('missing_byok', 'Connect your own AXIOM key to continue with unlimited BYOK validation.'); }
        return this._providerFor(configProvider);
      }
      // Managed provider for plan allowance.
      return new ManagedProviderAdapter(this.context);
    }
    throw new ValidationError('provider_error', 'Unsupported tier.');
  }

  private _providerFor(provider: TyneAiProvider): TyneAiProviderAdapter {
    if (provider === 'anthropic') { return createAnthropicProvider(); }
    if (provider === 'openai') { return createOpenAiProvider(); }
    throw new ValidationError('provider_error', 'Unsupported provider.');
  }

  private async _getApiKeyForProvider(provider: TyneAiProvider): Promise<string | null> {
    if (provider !== 'anthropic' && provider !== 'openai') { return null; }
    return this.byokService.getApiKey(provider);
  }
}

export class ValidationError extends Error {
  constructor(
    public readonly reason: TyneValidationLimitDecision['reason'] | 'provider_error' | 'missing_task' | 'missing_diff' | 'no_git_repo',
    message: string,
  ) {
    super(message);
  }
}

class ManagedProviderAdapter implements TyneAiProviderAdapter {
  readonly provider: TyneAiProvider = 'managed';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async validateCode(input: TyneValidationInput): Promise<TyneValidationResult> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new ValidationError('missing_byok', 'GitHub connection is required for managed validation.');
    }

    const model = vscode.workspace.getConfiguration('tyne').get<string>('managedValidationModel') || 'anthropic/claude-3-haiku';
    const response = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...input,
        diff: input.diffText,
        gitDiff: input.diffText,
        task_title: input.taskTitle,
        task_description: input.taskDescription,
        acceptance_criteria: input.acceptanceCriteria,
        feature: 'deep-review',
        model,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `Edge Function failed (${response.status})` })) as { error?: string };
      if ((errorData.error || '').includes('LLM configuration key is missing')) {
        throw new ValidationError('provider_error', 'Managed validation is temporarily unavailable. Add your own AXIOM key in Tyne settings to keep validating.');
      }
      if ((errorData.error || '').includes('Invalid API Key')) {
        throw new ValidationError('provider_error', 'Managed validation backend key is invalid. Update the Supabase secret for the server-side AXIOM key or use your own AXIOM key in Tyne settings.');
      }
      throw new ValidationError('provider_error', errorData.error || `Managed validation failed: HTTP ${response.status}`);
    }

    const result = await response.json() as TyneValidationResult;
    return result;
  }
}
