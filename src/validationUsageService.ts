import * as vscode from 'vscode';
import { TynePlanTier, TyneValidationLimitDecision, TyneValidationResult, TyneValidationUsage, TyneValidationUsageSummary } from './validationTypes';
import { getCurrentMonth, getLimitForTier, getResetAt, isLimited } from './validationUtils';

const USAGE_FUNCTION_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/usage';

export function getValidationUsageService(context: vscode.ExtensionContext): ValidationUsageService {
  return new ValidationUsageService(context);
}

export class ValidationUsageService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getUsage(tier?: TynePlanTier): Promise<TyneValidationUsage> {
    const currentTier = tier || (await this._getTier());
    const currentMonth = getCurrentMonth();
    const byokUnlimitedActive = await this._getByokUnlimitedActive();
    try {
      const response = await this._callUsageFunction({ action: 'check' });
      const data = await response.json() as { used: number; limit: number | null; remaining: number | null; tier: string; credits: number };
      const limit = data.limit === null ? 'unlimited' : data.limit;
      return {
        tier: this._normalizeTier(data.tier, currentTier),
        month: currentMonth,
        used: data.used || 0,
        limit,
        byokUnlimitedActive,
        resetAt: getResetAt(currentMonth),
        updatedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to fetch validation usage from Supabase:', message);
      // Fallback to free tier defaults so the extension remains usable offline.
      return {
        tier: currentTier,
        month: currentMonth,
        used: 0,
        limit: getLimitForTier(currentTier, byokUnlimitedActive),
        byokUnlimitedActive,
        resetAt: getResetAt(currentMonth),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async getUsageSummary(tier?: TynePlanTier): Promise<TyneValidationUsageSummary> {
    const usage = await this.getUsage(tier);
    const limit = usage.limit;
    const remaining = limit === 'unlimited' ? 'unlimited' : Math.max(0, limit - usage.used);
    const isWarning = isLimited(limit) && isLimited(remaining) && remaining <= Math.max(1, limit * 0.1);
    const isBlocked = isLimited(limit) && isLimited(remaining) && remaining === 0;
    return {
      used: usage.used,
      limit: usage.limit,
      remaining,
      isWarning,
      isBlocked,
      byokUnlimitedActive: usage.byokUnlimitedActive,
      message: isBlocked ? this._blockMessage(usage) : isWarning ? this._warningMessage(usage) : undefined,
    };
  }

  async canRunValidation(tier: TynePlanTier, hasByok: boolean): Promise<TyneValidationLimitDecision> {
    const usage = await this.getUsage(tier);
    const warnings: string[] = [];

    if (tier === 'free') {
      if (usage.byokUnlimitedActive) {
        return { allowed: true, reason: 'ok', usage, warnings: ['Using your own API key for unlimited BYOK validation.'] };
      }
      const limit = usage.limit;
      if (limit !== 'unlimited' && usage.used >= limit) {
        if (hasByok) {
          const updated = { ...usage, byokUnlimitedActive: true };
          await this._setByokUnlimitedActive(true);
          return { allowed: true, reason: 'ok', usage: updated, warnings: ['Using your own API key for unlimited BYOK validation.'] };
        }
        return { allowed: false, reason: 'free_limit_reached', message: 'You reached your monthly Core validation limit. Connect your own AXIOM key to continue with unlimited BYOK validation.', usage };
      }
      if (limit !== 'unlimited' && usage.used >= Math.max(1, limit - 1)) {
        const remaining = Math.max(0, limit - usage.used);
        warnings.push(`You have ${remaining} validation${remaining === 1 ? '' : 's'} left this month.`);
      }
      return { allowed: true, reason: 'ok', usage, warnings };
    }

    if (tier === 'pro') {
      if (usage.byokUnlimitedActive) {
        return { allowed: true, reason: 'ok', usage, warnings: ['Using your own API key for unlimited BYOK validation.'] };
      }
      const limit = usage.limit;
      if (limit !== 'unlimited' && usage.used >= limit) {
        if (hasByok) {
          const updated = { ...usage, byokUnlimitedActive: true };
          await this._setByokUnlimitedActive(true);
          return { allowed: true, reason: 'ok', usage: updated, warnings: ['Using your own API key for unlimited BYOK validation.'] };
        }
        return { allowed: false, reason: 'pro_limit_reached_no_byok', message: 'You reached 50 Pro validations this month. Connect your own AXIOM key to continue with unlimited BYOK validation.', usage };
      }
      if (limit !== 'unlimited' && usage.used >= Math.max(1, limit - 5)) {
        warnings.push('You are near your monthly Pro validation limit.');
      }
      return { allowed: true, reason: 'ok', usage, warnings };
    }

    // Max tier
    if (usage.byokUnlimitedActive) {
      return { allowed: true, reason: 'ok', usage, warnings: ['Using your own API key for unlimited BYOK validation.'] };
    }
    const maxLimit = usage.limit;
    if (maxLimit !== 'unlimited' && usage.used >= maxLimit) {
      if (hasByok) {
        const updated = { ...usage, byokUnlimitedActive: true };
        await this._setByokUnlimitedActive(true);
        return { allowed: true, reason: 'ok', usage: updated };
      }
      return { allowed: false, reason: 'pro_limit_reached_no_byok', message: 'You reached your monthly Max validation limit. Connect your own AXIOM key to continue with unlimited BYOK validation.', usage };
    }
    if (maxLimit !== 'unlimited' && usage.used >= Math.max(1, maxLimit - 5)) {
      warnings.push('You are near your monthly Max validation limit.');
    }
    return { allowed: true, reason: 'ok', usage, warnings };
  }

  async recordValidationRun(result: TyneValidationResult): Promise<void> {
    try {
      await this._callUsageFunction({
        action: 'record',
        tokens: 0,
        cost: 0,
        metadata: { tier: result.tier, provider: result.provider, status: result.status },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to record validation usage in Supabase:', message);
    }
  }

  async resetIfNewMonth(): Promise<void> {
    // getUsage already returns current-month data from Supabase.
    await this.getUsage();
  }

  async setByokUnlimitedActive(active: boolean): Promise<void> {
    await this._setByokUnlimitedActive(active);
  }

  private async _setByokUnlimitedActive(active: boolean): Promise<void> {
    // This state is local-only because BYOK unlimited mode is a client-side choice.
    // Supabase usage already tracks the real quota; the flag only controls which provider is selected.
    await this.context.workspaceState.update('tyne.byokUnlimitedActive', active);
  }

  private async _getByokUnlimitedActive(): Promise<boolean> {
    return Boolean(this.context.workspaceState.get('tyne.byokUnlimitedActive'));
  }

  getLimitForTier(tier: TynePlanTier): number | 'unlimited' {
    return getLimitForTier(tier);
  }

  private async _getTier(): Promise<TynePlanTier> {
    // Default to free if no profile is available. Callers should pass tier when possible.
    return 'free';
  }

  private async _callUsageFunction(body: Record<string, unknown>): Promise<Response> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new Error('GitHub token is required to check validation usage.');
    }

    const response = await fetch(USAGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new Error(`Usage function failed (${response.status}): ${text}`);
    }
    return response;
  }

  private _normalizeTier(backendTier: string, fallback: TynePlanTier): TynePlanTier {
    const raw = (backendTier || '').toLowerCase();
    if (raw === 'pro' || raw === 'max') { return raw; }
    if (raw === 'core' || raw === 'free') { return 'free'; }
    return fallback;
  }

  private _warningMessage(usage: TyneValidationUsage): string {
    if (usage.limit === 'unlimited') { return ''; }
    const remaining = usage.limit - usage.used;
    if (usage.tier === 'free') { return `You have ${remaining} validation${remaining === 1 ? '' : 's'} left this month.`; }
    return 'You are near your monthly Pro validation limit.';
  }

  private _blockMessage(usage: TyneValidationUsage): string {
    if (usage.limit === 'unlimited') { return ''; }
    if (usage.tier === 'free') { return 'You reached your monthly Core validation limit. Connect your own AXIOM key to continue with unlimited BYOK validation.'; }
    return 'You reached 50 Pro validations this month. Connect your own AXIOM key to continue with unlimited BYOK validation.';
  }
}

export { getCurrentMonth, getLimitForTier, getResetAt, isLimited } from './validationUtils';
