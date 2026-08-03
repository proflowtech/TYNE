import type * as vscode from 'vscode';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const LINEAR_STATE_FUNCTION_PATH = '/functions/v1/linear-oauth-state';
const LINEAR_EXCHANGE_FUNCTION_PATH = '/functions/v1/complete-linear-oauth-exchange';
const HOSTED_OAUTH_TIMEOUT_MS = 180_000;

interface PendingHostedLinearOAuth {
  context: vscode.ExtensionContext;
  supabaseUrl: string;
  resolve: (value: LinearOAuthTokenResult) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

const pendingHostedAuth = new Map<string, PendingHostedLinearOAuth>();
let linearOutputChannel: import('vscode').OutputChannel | undefined;

function getVscode(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

function logLinear(message: string): void {
  try {
    linearOutputChannel ||= getVscode().window.createOutputChannel('Tyne: Linear');
    linearOutputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  } catch {
    console.info(`[Linear] ${message}`);
  }
}

export interface LinearOAuthTeam {
  id: string;
  key?: string;
  name: string;
}

export interface LinearOAuthTokenResult {
  expiresIn: number;
  workspaceId?: string;
  workspaceName?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  availableTeams?: LinearOAuthTeam[];
  serverManaged?: boolean;
}

export class LinearOAuthStateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly backendError: string,
  ) {
    super(message);
    this.name = 'LinearOAuthStateError';
  }
}

export function registerLinearOAuthUriHandler(extensionId: string): vscode.UriHandler {
  return {
    async handleUri(uri: vscode.Uri): Promise<void> {
      if (uri.authority !== extensionId) { return; }
      if (!uri.path.endsWith('/linear-auth-complete')) { return; }

      clearExpiredHostedOAuthAttempts();

      const params = new URLSearchParams(uri.query);
      const exchangeCode = params.get('code');
      const state = params.get('state');
      if (!state || !exchangeCode) { return; }
      logLinear('Linear URI received');

      const pending = pendingHostedAuth.get(state);
      if (!pending) { return; }

      pendingHostedAuth.delete(state);
      clearTimeout(pending.timeout);

      try {
        const result = await completeHostedLinearOAuth(pending.context, pending.supabaseUrl, exchangeCode);
        logLinear('Linear exchange completed');
        pending.resolve(result);
      } catch (err) {
        pending.reject(err);
      }
    },
  };
}

export async function startHostedLinearOAuth(
  context: vscode.ExtensionContext,
  supabaseUrl = DEFAULT_SUPABASE_URL,
): Promise<LinearOAuthTokenResult> {
  const normalizedSupabaseUrl = supabaseUrl.replace(/\/+$/, '');
  clearExpiredHostedOAuthAttempts();
  cancelActiveHostedOAuthAttempts('Linear OAuth restarted by a new Connect click.');

  const { state, authUrl } = await createHostedLinearOAuthStart(context, normalizedSupabaseUrl);
  const tokenPromise = new Promise<LinearOAuthTokenResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostedAuth.delete(state);
      reject(new Error('Linear OAuth timed out before the browser returned to VS Code.'));
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
    const opened = await getVscode().env.openExternal(getVscode().Uri.parse(authUrl));
    logLinear(opened ? 'Browser opened for Linear login' : 'openExternal returned false for Linear login');
    if (!opened) {
      void getVscode().window.showWarningMessage(
        'VS Code could not open the Linear login page. Allow external links for Tyne, then try Connect again.',
      );
    } else {
      void getVscode().window.showInformationMessage('Complete Linear login in your browser, then return to VS Code.');
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
    pending.reject(new Error('Linear OAuth timed out before the browser returned to VS Code.'));
  }
}

async function createHostedLinearOAuthStart(context: vscode.ExtensionContext, supabaseUrl: string): Promise<{ state: string; authUrl: string }> {
  const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
  const authToken = await getEffectiveAuthToken(context);
  if (!authToken) {
    throw new Error('Connect GitHub before connecting Linear through Tyne hosted OAuth.');
  }

  const response = await fetch(`${supabaseUrl}${LINEAR_STATE_FUNCTION_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Machine-ID': getVscode().env.machineId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ feature: 'profile' }),
  });

  const bodyText = await response.text().catch(() => '');
  let payload: Record<string, unknown> | null = null;
  try { payload = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null; } catch { payload = null; }

  if (!response.ok) {
    const backendError = (typeof payload?.error === 'string' && payload.error)
      ? payload.error
      : (bodyText.slice(0, 200) || 'Unknown error');
    throw new LinearOAuthStateError(
      `Could not create a secure Linear OAuth state (${response.status}): ${backendError}`,
      response.status,
      backendError,
    );
  }

  if (!payload || typeof payload.state !== 'string' || !payload.state || typeof payload.auth_url !== 'string' || !payload.auth_url) {
    throw new LinearOAuthStateError(
      `Could not create a secure Linear OAuth state (${response.status}): incomplete response`,
      response.status,
      'incomplete response',
    );
  }

  logLinear('Linear OAuth state created');
  return { state: payload.state, authUrl: payload.auth_url };
}

async function completeHostedLinearOAuth(
  context: vscode.ExtensionContext,
  supabaseUrl: string,
  exchangeCode: string,
): Promise<LinearOAuthTokenResult> {
  const { getEffectiveAuthToken } = require('./deviceAuth') as typeof import('./deviceAuth');
  const authToken = await getEffectiveAuthToken(context);
  if (!authToken) {
    throw new Error('Connect GitHub before completing Linear OAuth.');
  }

  const response = await fetch(`${supabaseUrl}${LINEAR_EXCHANGE_FUNCTION_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Machine-ID': getVscode().env.machineId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ code: exchangeCode }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new Error(`Failed to complete Linear OAuth exchange (${response.status}).`);
  }

  const expiresAt = typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : 0;
  const availableTeams = Array.isArray(payload.available_teams)
    ? payload.available_teams
        .map(team => normalizeTeam(team as Record<string, unknown>))
        .filter((team): team is LinearOAuthTeam => Boolean(team))
    : undefined;

  return {
    expiresIn: expiresAt ? Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)) : 3600,
    workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : undefined,
    workspaceName: typeof payload.workspace_name === 'string' ? payload.workspace_name : undefined,
    userId: typeof payload.linear_user_id === 'string' ? payload.linear_user_id : undefined,
    userEmail: typeof payload.linear_user_email === 'string' ? payload.linear_user_email : undefined,
    userName: typeof payload.linear_user_name === 'string' ? payload.linear_user_name : undefined,
    availableTeams,
    serverManaged: true,
  };
}

function normalizeTeam(team: Record<string, unknown>): LinearOAuthTeam | null {
  const id = typeof team.id === 'string' ? team.id : '';
  const name = typeof team.name === 'string' ? team.name : '';
  if (!id || !name) { return null; }
  return {
    id,
    key: typeof team.key === 'string' ? team.key : undefined,
    name,
  };
}
