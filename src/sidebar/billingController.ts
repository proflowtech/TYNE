import * as vscode from 'vscode';
import type { SidebarHost, SidebarUserProfile } from './sidebarHost';
import {
  clearDeviceAuthTokens,
  DEVICE_AUTH_ACCESS_TOKEN_KEY,
  getEffectiveAuthToken,
} from '../deviceAuth';
import { isInvalidGitHubTokenResponse } from '../githubAuth';

type BillingHost = Pick<
  SidebarHost,
  | 'context'
  | 'postMessage'
  | 'userProfile'
  | 'profileFetchedAt'
  | 'billingRefreshTimer'
  | 'isAuthenticated'
  | 'githubSessionInvalid'
  | 'getSupabaseUrl'
  | 'postSettings'
  | 'updateAuthenticationState'
  | 'handleInvalidGitHubToken'
>;

export class BillingController {
  constructor(private readonly host: BillingHost) {}

  async updateProfile(force = false): Promise<void> {
    if (!force && Date.now() - this.host.profileFetchedAt < 60_000) { return; }
    this.host.profileFetchedAt = Date.now();
    this.host.userProfile = await this.fetchUserProfile();
    if (this.host.userProfile.isBanned) {
      vscode.window.showErrorMessage('Your Tyne account is banned. Contact support if you believe this is a mistake.');
      await clearDeviceAuthTokens(this.host.context);
      await this.host.context.secrets.delete('tyne_github_token');
      await this.host.updateAuthenticationState(false);
      return;
    }
    this.host.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this.host.userProfile.tier,
        credits: this.host.userProfile.credits,
        githubUsername: this.host.userProfile.githubUsername || '',
        githubId: this.host.userProfile.githubId || '',
        email: this.host.userProfile.email || '',
        avatarUrl: this.host.userProfile.avatarUrl || '',
        isBanned: !!this.host.userProfile.isBanned,
      }
    });
    // Settings/usage often race ahead of profile load and briefly fall back to Core 5/5.
    // Re-post after the real tier is known so Max shows unlimited from the usage API.
    if (this.host.isAuthenticated && this.host.userProfile.tier !== 'UNKNOWN') {
      await this.host.postSettings();
    }
  }

  async handleBillingCheckout(plan: string): Promise<void> {
    if (plan !== 'pro' && plan !== 'max') {
      this.host.postMessage({ type: 'billingCheckoutError', message: 'Choose Pro or Max.' });
      return;
    }

    const token = await getEffectiveAuthToken(this.host.context);
    if (!token) {
      this.host.postMessage({ type: 'billingCheckoutError', message: 'Sign in before upgrading.' });
      return;
    }

    try {
      const response = await fetch(`${this.host.getSupabaseUrl()}/functions/v1/dodo-checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Machine-ID': vscode.env.machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan }),
      });
      const result = await response.json().catch(() => ({})) as { checkout_url?: string; error?: string };
      if (!response.ok || !result.checkout_url) {
        throw new Error(result.error || 'Could not start checkout.');
      }

      const opened = await vscode.env.openExternal(vscode.Uri.parse(result.checkout_url));
      if (!opened) throw new Error('Could not open checkout in your browser.')

      this.host.postMessage({ type: 'billingCheckoutOpened' });
      this.startBillingProfileRefresh(this.host.userProfile.tier);
    } catch (error) {
      this.host.postMessage({
        type: 'billingCheckoutError',
        message: error instanceof Error ? error.message : 'Could not start checkout.',
      });
    }
  }

  startBillingProfileRefresh(previousTier: string): void {
    if (this.host.billingRefreshTimer) clearTimeout(this.host.billingRefreshTimer);
    let attempts = 0;

    const check = async (): Promise<void> => {
      attempts += 1;
      await this.updateProfile(true);
      if (this.host.userProfile.tier !== previousTier && this.host.userProfile.tier !== 'UNKNOWN') {
        this.host.billingRefreshTimer = undefined;
        this.host.postMessage({ type: 'billingPlanUpdated', tier: this.host.userProfile.tier });
        vscode.window.showInformationMessage(`Tyne plan updated to ${this.host.userProfile.tier}.`);
        return;
      }
      if (attempts >= 36 || !this.host.isAuthenticated) {
        this.host.billingRefreshTimer = undefined;
        this.host.postMessage({ type: 'billingRefreshStopped' });
        return;
      }
      this.host.billingRefreshTimer = setTimeout(() => { void check(); }, 5_000);
    };

    this.host.billingRefreshTimer = setTimeout(() => { void check(); }, 5_000);
  }

  async fetchUserProfile(): Promise<SidebarUserProfile> {
    const empty: SidebarUserProfile = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '', isBanned: false };
    const token = await getEffectiveAuthToken(this.host.context);
    if (!token) {
      return empty;
    }

    const sessionToken = await this.host.context.secrets.get(DEVICE_AUTH_ACCESS_TOKEN_KEY);
    const machineId = vscode.env.machineId;

    // Device-auth session: live tier/credits/ban from usage (DB), not login-time cache.
    if (sessionToken) {
      try {
        const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/usage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Machine-ID': machineId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'check' }),
        });
        if (res.ok) {
          const data = await res.json() as {
            tier: string;
            credits: number;
            is_banned?: boolean;
            isBanned?: boolean;
          };
          return {
            tier: data.tier || 'UNKNOWN',
            credits: typeof data.credits === 'number' ? data.credits : 0,
            isBanned: !!(data.is_banned ?? data.isBanned),
          };
        }
        const text = await res.text().catch(() => '');
        this.host.postMessage({ type: 'profileLoadFailed', error: text || `Profile request failed (${res.status})` });
      } catch (e) {
        console.error('Error fetching device-auth user profile:', e);
        this.host.postMessage({ type: 'profileLoadFailed', error: e instanceof Error ? e.message : String(e) });
      }
      return empty;
    }

    // Legacy GitHub-token path (untouched coexistence).
    try {
      const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Machine-ID': machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ feature: 'profile' }),
      });
      if (res.ok) {
        this.host.githubSessionInvalid = false;
        const data = await res.json() as {
          tier: string;
          credits: number;
          githubUsername?: string;
          githubId?: string;
          email?: string;
          avatarUrl?: string;
          is_banned?: boolean;
          isBanned?: boolean;
        };
        return {
          ...data,
          isBanned: !!(data.is_banned ?? data.isBanned),
        };
      }
      const text = await res.text().catch(() => '');
      if (isInvalidGitHubTokenResponse(res.status, text)) {
        await this.host.handleInvalidGitHubToken('profile');
        return empty;
      }
      this.host.postMessage({ type: 'profileLoadFailed', error: text || `Profile request failed (${res.status})` });
    } catch (e) {
      console.error('Error fetching user profile:', e);
      this.host.postMessage({ type: 'profileLoadFailed', error: e instanceof Error ? e.message : String(e) });
    }
    return empty;
  }
}
