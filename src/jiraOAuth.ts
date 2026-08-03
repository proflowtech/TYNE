import * as vscode from 'vscode';
import { logJira } from './jiraLog';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const PROFILE_FUNCTION_PATH = '/functions/v1/jira-oauth-state';
const JIRA_EXCHANGE_FUNCTION_PATH = '/functions/v1/complete-jira-oauth-exchange';
const HOSTED_OAUTH_TIMEOUT_MS = 180_000;

interface PendingHostedJiraOAuth {
  context: vscode.ExtensionContext;
  supabaseUrl: string;
  resolve: (value: JiraOAuthTokenResult) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

const pendingHostedAuth = new Map<string, PendingHostedJiraOAuth>();

export interface JiraOAuthTokenResult {
  accessToken?: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  cloudId?: string;
  siteName?: string;
  siteUrl?: string;
  availableSites?: JiraOAuthSite[];
  accountEmail?: string;
  accountName?: string;
  serverManaged?: boolean;
}

export interface JiraOAuthSite {
  cloudId: string;
  siteName?: string;
  siteUrl?: string;
  scopes?: string[];
}

// Carries the safe HTTP status and backend error string from the jira-oauth-state
// function so callers can log structured diagnostics and classify the failure.
// Never holds tokens, OAuth codes, OAuth state values, or secrets.
export class JiraOAuthStateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly backendError: string,
  ) {
    super(message);
    this.name = 'JiraOAuthStateError';
  }
}

export function registerJiraOAuthUriHandler(extensionId: string): vscode.UriHandler {
  return {
    async handleUri(uri: vscode.Uri): Promise<void> {
      if (uri.authority !== extensionId) { return; }
      if (!uri.path.endsWith('/auth-complete')) { return; }

      logJira('VS Code URI received');
      logJira('URI accepted: auth-complete');
      clearExpiredHostedOAuthAttempts();

      const params = new URLSearchParams(uri.query);
      const exchangeCode = params.get('code');
      const state = params.get('state');
      // Strict state matching: an OAuth result must carry the state we issued, and we
      // only resolve the exact pending attempt keyed by that state. This prevents
      // retries, stale attempts, or multiple pending attempts from cross-resolving.
      if (!state) {
        logJira('Missing state in VS Code callback');
        return;
      }
      if (!exchangeCode) { return; }

      const pending = pendingHostedAuth.get(state);
      if (!pending) {
        logJira('Pending OAuth state not found');
        return;
      }
      logJira('Pending OAuth state found');
      pendingHostedAuth.delete(state);
      clearTimeout(pending.timeout);

      try {
        logJira('Exchange started');
        const result = await completeHostedJiraOAuth(pending.context, pending.supabaseUrl, exchangeCode);
        logJira('Exchange completed');
        pending.resolve(result);
      } catch (err) {
        pending.reject(err);
      }
    },
  };
}

export async function startHostedJiraOAuth(
  context: vscode.ExtensionContext,
  supabaseUrl = DEFAULT_SUPABASE_URL,
): Promise<JiraOAuthTokenResult> {
  const normalizedSupabaseUrl = supabaseUrl.replace(/\/+$/, '');
  clearExpiredHostedOAuthAttempts();
  // A stuck prior attempt blocked new Connect clicks from opening the browser.
  // Cancel any in-flight attempt so a fresh click always restarts OAuth.
  cancelActiveHostedOAuthAttempts('Jira OAuth restarted by a new Connect click.');

  const { state, authUrl } = await createHostedJiraOAuthStart(context, normalizedSupabaseUrl);
  logJira('OAuth state created');

  const tokenPromise = new Promise<JiraOAuthTokenResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostedAuth.delete(state);
      logJira('Jira OAuth timed out before the browser returned to VS Code.');
      reject(new Error('Jira OAuth timed out before the browser returned to VS Code.'));
    }, HOSTED_OAUTH_TIMEOUT_MS);
    pendingHostedAuth.set(state, {
      context,
      supabaseUrl: normalizedSupabaseUrl,
      resolve,
      reject,
      timeout,
      expiresAt: Date.now() + HOSTED_OAUTH_TIMEOUT_MS,
    });
  });

  try {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    logJira(opened ? 'Browser opened for Jira login' : 'openExternal returned false for Jira login');
    if (!opened) {
      void vscode.window.showWarningMessage(
        'VS Code could not open the Jira login page. Allow external links for Tyne, then try Connect again.',
      );
    } else {
      void vscode.window.showInformationMessage('Complete Jira login in your browser, then return to VS Code.');
    }
  } catch (err) {
    const pending = pendingHostedAuth.get(state);
    if (pending) {
      pendingHostedAuth.delete(state);
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    throw err;
  }
  return tokenPromise;
}

function cancelActiveHostedOAuthAttempts(reason: string): void {
  for (const [state, pending] of pendingHostedAuth.entries()) {
    pendingHostedAuth.delete(state);
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
}

function clearExpiredHostedOAuthAttempts(now = Date.now()): void {
  for (const [state, pending] of pendingHostedAuth.entries()) {
    if (pending.expiresAt > now) { continue; }
    pendingHostedAuth.delete(state);
    clearTimeout(pending.timeout);
    pending.reject(new Error('Jira OAuth timed out before the browser returned to VS Code.'));
  }
}

async function createHostedJiraOAuthStart(context: vscode.ExtensionContext, supabaseUrl: string): Promise<{ state: string; authUrl: string }> {
  const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
  const authToken = await getEffectiveAuthToken(context);
  if (!authToken) {
    throw new Error('Connect GitHub before connecting Jira through Tyne hosted OAuth.');
  }
  const callbackUri = `${vscode.env.uriScheme}://${context.extension.id}/auth-complete`;

  const response = await fetch(`${supabaseUrl}${PROFILE_FUNCTION_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Machine-ID': vscode.env.machineId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ feature: 'profile', callback_uri: callbackUri }),
  });

  // Read the body once as text, then attempt JSON. jira-oauth-state error responses are
  // shaped as { error: string } and never contain tokens/secrets, so the error field is
  // safe to surface. (On the success path the body holds state/auth_url, which we only
  // read after confirming response.ok and never echo on the failure branches.)
  const bodyText = await response.text().catch(() => '');
  let payload: Record<string, unknown> | null = null;
  try { payload = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null; } catch { payload = null; }

  if (!response.ok) {
    const backendError = (typeof payload?.error === 'string' && payload.error)
      ? payload.error
      : (bodyText.slice(0, 200) || 'Unknown error');
    throw new JiraOAuthStateError(
      `Could not create a secure Jira OAuth state (${response.status}): ${backendError}`,
      response.status,
      backendError,
    );
  }

  if (!payload || typeof payload.state !== 'string' || !payload.state || typeof payload.auth_url !== 'string' || !payload.auth_url) {
    // Do not echo the body here — a 2xx response can contain the OAuth state / auth_url.
    throw new JiraOAuthStateError(
      `Could not create a secure Jira OAuth state (${response.status}): incomplete response`,
      response.status,
      'incomplete response',
    );
  }
  return { state: payload.state, authUrl: payload.auth_url };
}

async function completeHostedJiraOAuth(
  context: vscode.ExtensionContext,
  supabaseUrl: string,
  exchangeCode: string,
): Promise<JiraOAuthTokenResult> {
  const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
  const authToken = await getEffectiveAuthToken(context);
  if (!authToken) {
    throw new Error('Connect GitHub before completing Jira OAuth.');
  }

  const response = await fetch(`${supabaseUrl}${JIRA_EXCHANGE_FUNCTION_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Machine-ID': vscode.env.machineId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ code: exchangeCode }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new Error(`Failed to complete Jira OAuth exchange (${response.status}).`);
  }

  const expiresAt = typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : 0;
  if (!expiresAt) {
    throw new Error('Tyne returned an incomplete Jira OAuth exchange response.');
  }

  return {
    expiresIn: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    cloudId: typeof payload.cloud_id === 'string' ? payload.cloud_id : undefined,
    siteName: typeof payload.site_name === 'string' ? payload.site_name : undefined,
    siteUrl: typeof payload.site_url === 'string' ? payload.site_url : undefined,
    availableSites: Array.isArray(payload.available_sites)
      ? payload.available_sites
          .map(site => normalizeOAuthSite(site as Record<string, unknown>))
          .filter((site): site is JiraOAuthSite => Boolean(site))
      : undefined,
    accountEmail: typeof payload.account_email === 'string' ? payload.account_email : undefined,
    accountName: typeof payload.account_name === 'string' ? payload.account_name : undefined,
    serverManaged: true,
  };
}

function normalizeOAuthSite(site: Record<string, unknown>): JiraOAuthSite | null {
  const cloudId = typeof site.cloud_id === 'string' ? site.cloud_id : typeof site.cloudId === 'string' ? site.cloudId : '';
  if (!cloudId) { return null; }
  return {
    cloudId,
    siteName: typeof site.site_name === 'string' ? site.site_name : typeof site.siteName === 'string' ? site.siteName : undefined,
    siteUrl: typeof site.site_url === 'string' ? site.site_url : typeof site.siteUrl === 'string' ? site.siteUrl : undefined,
    scopes: Array.isArray(site.scopes) ? site.scopes.map(scope => String(scope)) : undefined,
  };
}
