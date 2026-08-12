import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { startGitHubDeviceFlow, pollGitHubDeviceToken, openGitHubDeviceUri } from '../githubOAuth';
import {
  clearDeviceAuthTokens,
  getDeviceAuthFunnelSnapshot,
  isDeviceAuthDogfoodEnabled,
  logDeviceAuth,
  runDeviceAuthFlow,
  trackDeviceAuthEvent,
  type DeviceAuthFlowHandle,
} from '../deviceAuth';
import { logGitHub } from '../githubAuth';
import { stopDriftDetection } from '../driftDetector';

type AuthSessionHost = Pick<
  SidebarHost,
  | 'context'
  | 'postMessage'
  | 'isAuthenticated'
  | 'userProfile'
  | 'profileFetchedAt'
  | 'githubSessionInvalid'
  | 'postAuthState'
  | 'postState'
  | 'updateAuthenticationState'
  | 'updateProfile'
  | 'postSettings'
  | 'refreshTasksContext'
  | 'isGithubConnected'
>;

export class AuthSessionController {
  private deviceAuthFlow: DeviceAuthFlowHandle | undefined;
  private deviceAuthFocusDisposable: vscode.Disposable | undefined;

  constructor(private readonly host: AuthSessionHost) {}

  async continueWithGitHub(): Promise<void> {
    // Dogfood flag only — existing GitHub Device Flow body below is untouched.
    if (isDeviceAuthDogfoodEnabled()) {
      await this.continueWithDeviceAuth();
      return;
    }
    const clientId = vscode.workspace.getConfiguration('tyne').get<string>('githubClientId', '');
    if (!clientId) {
      vscode.window.showErrorMessage('No GitHub Client ID configured. Set tyne.githubClientId in settings.');
      return;
    }
    this.host.postMessage({ type: 'githubConnectStatus', status: 'starting' });
    try {
      const flow = await startGitHubDeviceFlow(clientId);
      openGitHubDeviceUri(flow.verificationUri);
      this.host.postMessage({ type: 'githubConnectStatus', status: 'pending', userCode: flow.userCode, verificationUri: flow.verificationUri });
      const progressOptions = { location: vscode.ProgressLocation.Notification, title: `GitHub: enter code ${flow.userCode}`, cancellable: true };
      const token = await vscode.window.withProgress(progressOptions, async (progress, tokenSource) => {
        progress.report({ message: 'Waiting for authorization...' });
        const controller = new AbortController();
        tokenSource.onCancellationRequested(() => controller.abort());
        const result = await pollGitHubDeviceToken(clientId, flow.deviceCode, flow.interval, this.host.context, controller.signal);
        return result.accessToken;
      });
      if (token) { vscode.window.showInformationMessage('GitHub connected ✓'); await this.host.updateAuthenticationState(true); }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('GitHub connection failed: ' + message);
      this.host.postMessage({ type: 'githubConnectStatus', status: 'error', error: message });
    }
  }

  async continueWithDeviceAuth(): Promise<void> {
    logDeviceAuth(`Starting device-auth (mode=${vscode.workspace.getConfiguration('tyne').get('deviceAuthMode', 'live')})`);
    this.cancelDeviceAuth('restart');
    this.deviceAuthFocusDisposable?.dispose();
    this.deviceAuthFocusDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!this.deviceAuthFlow) { return; }
      if (state.focused) {
        trackDeviceAuthEvent(this.host.context, 'device_auth_focus_regained');
        logDeviceAuth('Window focus regained — poll continues (no restart)');
      } else {
        trackDeviceAuthEvent(this.host.context, 'device_auth_focus_lost');
        logDeviceAuth('Window focus lost mid-poll — poll continues (no restart)');
      }
    });

    this.deviceAuthFlow = runDeviceAuthFlow(this.host.context, {
      onStatus: (msg) => {
        this.host.postMessage({ type: 'deviceAuthStatus', ...msg });
      },
      openBrowser: async (uri) => {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(uri));
        if (!opened) {
          logDeviceAuth(`openExternal returned false for ${uri}`);
          const pick = await vscode.window.showWarningMessage(
            `Couldn't open the browser automatically. Open this URL and approve the code: ${uri}`,
            'Copy URL',
          );
          if (pick === 'Copy URL') {
            await vscode.env.clipboard.writeText(uri);
          }
        } else {
          logDeviceAuth(`Opened browser: ${uri}`);
        }
      },
    });

    const result = await this.deviceAuthFlow.done;
    this.deviceAuthFlow = undefined;
    this.deviceAuthFocusDisposable?.dispose();
    this.deviceAuthFocusDisposable = undefined;

    if (result.ok) {
      vscode.window.showInformationMessage(
        `Tyne connected (${result.user.tier}) ✓`,
      );
      logDeviceAuth(`Success for user ${result.user.id} tier=${result.user.tier}; funnel=${JSON.stringify(getDeviceAuthFunnelSnapshot(this.host.context))}`);
      await this.host.updateAuthenticationState(true);
    }
  }

  cancelDeviceAuth(reason: string): void {
    if (!this.deviceAuthFlow) { return; }
    logDeviceAuth(`Device auth cancelled (${reason})`);
    this.deviceAuthFlow.cancel();
    this.deviceAuthFlow = undefined;
    void clearDeviceAuthTokens(this.host.context);
  }

  async logout(): Promise<void> {
    await this.host.context.secrets.delete('tyne_github_token');
    await clearDeviceAuthTokens(this.host.context);
    stopDriftDetection();
    await this.host.updateAuthenticationState(false);
  }

  async handleInvalidGitHubToken(source: string): Promise<void> {
    const expiredMessage = 'Your Tyne session expired. Sign in again to continue.';
    if (this.host.githubSessionInvalid) {
      // Already handled — keep the webview banner visible but avoid repeat popups/logs.
      this.host.postMessage({ type: 'githubSessionExpired', message: expiredMessage });
      return;
    }
    this.host.githubSessionInvalid = true;
    await this.host.context.secrets.delete('tyne_github_token');
    await clearDeviceAuthTokens(this.host.context);
    this.host.isAuthenticated = false;
    this.host.userProfile = { tier: 'UNKNOWN', credits: 0, githubUsername: '', githubId: '', email: '', avatarUrl: '' };
    this.host.profileFetchedAt = 0;
    stopDriftDetection();
    // Safe logs only — never the token, headers, or any secret. `source` is a fixed label.
    logGitHub('Auth session invalid; cleared local session');
    logGitHub('Sign in required');
    logGitHub(`Trigger: ${source}`);
    this.host.postAuthState();
    this.host.postState();
    this.host.postMessage({ type: 'githubSessionExpired', message: expiredMessage });
    void vscode.window.showWarningMessage(expiredMessage, 'Sign in').then(choice => {
      if (choice === 'Sign in') { void this.reconnectGitHub(); }
    });
  }

  async reconnectGitHub(): Promise<void> {
    // Start from a clean slate so the device flow never reuses the rejected token.
    await this.host.context.secrets.delete('tyne_github_token');
    logGitHub('Reconnect GitHub requested');
    await this.continueWithGitHub();
    if (await this.host.isGithubConnected()) {
      this.host.githubSessionInvalid = false;
      logGitHub('GitHub reconnected; session restored');
      this.host.postMessage({ type: 'githubSessionRestored' });
      // Retry the profile + usage loads that failed under the stale token.
      await this.host.updateProfile(true);
      await this.host.postSettings();
      await this.host.refreshTasksContext(true);
    }
  }
}
