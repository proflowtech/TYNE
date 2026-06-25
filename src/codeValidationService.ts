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
import { normalizeTier, sanitizeDiff } from './validationUtils';

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
      throw new ValidationError('missing_byok', 'Connect your own Claude or OpenAI key to validate code.');
    }

    const start = Date.now();
    const result = await provider.validateCode(input, apiKey || undefined);
    const durationMs = Date.now() - start;
    const enriched: TyneValidationResult = { ...result, durationMs, taskId: state.taskId || result.taskId, taskTitle: state.taskTitle || result.taskTitle };
    await this.usageService.recordValidationRun(enriched);
    await this.historyService.saveValidationResult(enriched);
    return enriched;
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

    return {
      taskId: state.taskId || undefined,
      taskTitle: state.taskTitle || undefined,
      taskDescription: state.goal || undefined,
      goal: state.goal || undefined,
      subtasks: state.subtasks.map(s => s.text),
      acceptanceCriteria: [],
      branchName: branchName || undefined,
      commitHash: commitInfo.hash || undefined,
      changedFiles: diffData.changedFiles,
      diffText: diffData.diffText,
      linesAdded: diffData.added,
      linesDeleted: diffData.deleted,
      tier,
    };
  }

  private async _collectDiff(git: ReturnType<typeof simpleGit>): Promise<{ diffText: string; changedFiles: string[]; added: number; deleted: number }> {
    const STITCH_SIGNATURE = '🔗 Tyne stitch:';
    let diffText = '';
    try {
      const status = await git.status();
      if (status.files.length > 0) {
        diffText = await git.diff();
      }
      if (!diffText) {
        const log = await git.log({ maxCount: 20 });
        const stitchCount = log.all.filter(c => c.message.startsWith(STITCH_SIGNATURE)).length;
        diffText = stitchCount > 0
          ? await git.diff([`HEAD~${stitchCount}`, 'HEAD'])
          : await git.diff();
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
      if (!configProvider) { throw new ValidationError('missing_byok', 'Connect your own Claude or OpenAI key to validate code.'); }
      return this._providerFor(configProvider);
    }
    if (tier === 'pro' || tier === 'max') {
      const usage = await this.usageService.getUsage(tier);
      if (usage.byokUnlimitedActive || (usage.limit !== 'unlimited' && usage.used >= usage.limit)) {
        if (!configProvider) { throw new ValidationError('missing_byok', 'Connect your own Claude or OpenAI key to continue with unlimited BYOK validation.'); }
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

    const response = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...input,
        feature: 'deep-review',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `Edge Function failed (${response.status})` })) as { error?: string };
      throw new ValidationError('provider_error', errorData.error || `Managed validation failed: HTTP ${response.status}`);
    }

    const result = await response.json() as TyneValidationResult;
    return result;
  }
}

