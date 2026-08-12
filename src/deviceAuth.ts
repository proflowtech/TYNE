/**
 * Tyne device-authorization login (internal dogfood).
 *
 * Default transport is LIVE (`device-auth-start` / `device-auth-poll`).
 * Set `tyne.deviceAuthMode` to `mock` only for offline UI testing.
 * Gated by `tyne.deviceAuthDogfood` (still opt-in; GitHub Device Flow unchanged when false).
 *
 * Does NOT replace GitHub Device Flow (`githubOAuth.ts` / `tyne_github_token`) while dogfood is off.
 */

import * as vscode from 'vscode';

// ── SecretStorage keys (new — coexist with tyne_github_token) ─────────────────

export const DEVICE_AUTH_ACCESS_TOKEN_KEY = 'tyne_session_access_token';
export const DEVICE_AUTH_REFRESH_TOKEN_KEY = 'tyne_session_refresh_token';

// ── Config (single swap point for mock → live) ───────────────────────────────

export type DeviceAuthMode = 'mock' | 'live';
export type DeviceAuthMockScenario = 'auto_approve' | 'expire' | 'deny' | 'network_error';

export type DeviceAuthConfig = {
  mode: DeviceAuthMode;
  /** Base URL for live edge functions, e.g. https://….supabase.co/functions/v1 */
  baseUrl: string;
  /** Path segments relative to baseUrl */
  startPath: string;
  pollPath: string;
  /** Mock-only behaviour */
  mockScenario: DeviceAuthMockScenario;
  /** Mock: ms until auto-approve (auto_approve scenario) */
  mockApproveAfterMs: number;
  /** Mock: device code lifetime */
  mockExpiresInSec: number;
  /** Mock: suggested poll interval */
  mockPollIntervalSec: number;
};

const DEFAULT_CONFIG: DeviceAuthConfig = {
  mode: 'live',
  baseUrl: 'https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1',
  startPath: '/device-auth-start',
  pollPath: '/device-auth-poll',
  mockScenario: 'auto_approve',
  mockApproveAfterMs: 4000,
  mockExpiresInSec: 15,
  mockPollIntervalSec: 1,
};

let configOverride: Partial<DeviceAuthConfig> | undefined;

export function getDeviceAuthConfig(): DeviceAuthConfig {
  const cfg = vscode.workspace.getConfiguration('tyne');
  const fromSettings: Partial<DeviceAuthConfig> = {
    mode: cfg.get<DeviceAuthMode>('deviceAuthMode', DEFAULT_CONFIG.mode),
    mockScenario: cfg.get<DeviceAuthMockScenario>('deviceAuthMockScenario', DEFAULT_CONFIG.mockScenario),
  };
  return { ...DEFAULT_CONFIG, ...fromSettings, ...configOverride };
}

/** Test / dogfood helper — override without touching settings. */
export function setDeviceAuthConfigForTests(partial?: Partial<DeviceAuthConfig>): void {
  configOverride = partial;
}

export function isDeviceAuthDogfoodEnabled(): boolean {
  return vscode.workspace.getConfiguration('tyne').get<boolean>('deviceAuthDogfood', false) === true;
}

// ── API contract types (must match docs/device-auth-api-contract.md) ──────────

export type DeviceAuthStartResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

export type DeviceAuthPollPending = {
  status: 'authorization_pending' | 'slow_down';
  interval?: number;
};

export type DeviceAuthPollSuccess = {
  status: 'approved';
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
  user: {
    id: string;
    tier: string;
    credits: number;
    email?: string;
    githubUsername?: string;
  };
};

export type DeviceAuthPollErrorBody = {
  error: 'expired_token' | 'access_denied' | 'slow_down' | 'authorization_pending' | string;
  error_description?: string;
};

export type DeviceAuthPollResult = DeviceAuthPollPending | DeviceAuthPollSuccess | DeviceAuthPollErrorBody;

export type DeviceAuthFlowStatus =
  | 'idle'
  | 'started'
  | 'browser_opened'
  | 'waiting'
  | 'success'
  | 'expired'
  | 'denied'
  | 'error'
  | 'cancelled';

export type DeviceAuthTelemetryEvent =
  | 'device_auth_flow_started'
  | 'device_auth_browser_opened'
  | 'device_auth_waiting'
  | 'device_auth_success'
  | 'device_auth_expired'
  | 'device_auth_denied'
  | 'device_auth_error'
  | 'device_auth_focus_lost'
  | 'device_auth_focus_regained';

export type DeviceAuthStatusMessage = {
  type: 'deviceAuthStatus';
  status: DeviceAuthFlowStatus;
  userCode?: string;
  verificationUri?: string;
  message?: string;
  /** When true, UI should show Try again (clears stale poll). */
  canRetry?: boolean;
};

// ── Telemetry ────────────────────────────────────────────────────────────────

const FUNNEL_STATE_KEY = 'tyne.deviceAuth.funnel';

type FunnelCounters = Record<DeviceAuthTelemetryEvent, number>;

function emptyFunnel(): FunnelCounters {
  return {
    device_auth_flow_started: 0,
    device_auth_browser_opened: 0,
    device_auth_waiting: 0,
    device_auth_success: 0,
    device_auth_expired: 0,
    device_auth_denied: 0,
    device_auth_error: 0,
    device_auth_focus_lost: 0,
    device_auth_focus_regained: 0,
  };
}

let deviceAuthChannel: vscode.OutputChannel | undefined;

function getDeviceAuthChannel(): vscode.OutputChannel {
  if (!deviceAuthChannel) {
    deviceAuthChannel = vscode.window.createOutputChannel('Tyne: Device Auth');
  }
  return deviceAuthChannel;
}

/** Safe logger — never pass tokens or secrets. */
export function logDeviceAuth(message: string): void {
  getDeviceAuthChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function trackDeviceAuthEvent(
  context: vscode.ExtensionContext,
  event: DeviceAuthTelemetryEvent,
  detail?: Record<string, string | number | boolean | undefined>,
): void {
  const safe = detail
    ? Object.fromEntries(
      Object.entries(detail).filter(([k]) => !/token|secret|authorization|password/i.test(k)),
    )
    : undefined;
  // Structured line for OutputChannel (existing extension logging pattern).
  logDeviceAuth(JSON.stringify({ event, ...safe }));
  const prev = context.globalState.get<FunnelCounters>(FUNNEL_STATE_KEY) || emptyFunnel();
  const next = { ...emptyFunnel(), ...prev, [event]: (prev[event] || 0) + 1 };
  void context.globalState.update(FUNNEL_STATE_KEY, next);
}

export function getDeviceAuthFunnelSnapshot(context: vscode.ExtensionContext): FunnelCounters {
  return { ...emptyFunnel(), ...(context.globalState.get<FunnelCounters>(FUNNEL_STATE_KEY) || {}) };
}

// ── Transport (mock | live) ──────────────────────────────────────────────────

export type DeviceAuthTransport = {
  start(): Promise<DeviceAuthStartResponse>;
  poll(deviceCode: string): Promise<DeviceAuthPollResult>;
};

type MockState = {
  deviceCode: string;
  userCode: string;
  createdAt: number;
  expiresAt: number;
  scenario: DeviceAuthMockScenario;
  approveAfterMs: number;
  pollCount: number;
};

let mockState: MockState | undefined;

function randomCode(len: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function createMockDeviceAuthTransport(cfg: DeviceAuthConfig = getDeviceAuthConfig()): DeviceAuthTransport {
  return {
    async start(): Promise<DeviceAuthStartResponse> {
      const deviceCode = `mock_${randomCode(32)}`;
      const userCode = `TYNE-${randomCode(4)}-${randomCode(4)}`;
      const now = Date.now();
      mockState = {
        deviceCode,
        userCode,
        createdAt: now,
        expiresAt: now + cfg.mockExpiresInSec * 1000,
        scenario: cfg.mockScenario,
        approveAfterMs: cfg.mockApproveAfterMs,
        pollCount: 0,
      };
      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: 'https://tyne.proflowtech.io/device',
        verification_uri_complete: `https://tyne.proflowtech.io/device?code=${encodeURIComponent(userCode)}`,
        expires_in: cfg.mockExpiresInSec,
        interval: cfg.mockPollIntervalSec,
      };
    },

    async poll(deviceCode: string): Promise<DeviceAuthPollResult> {
      if (!mockState || mockState.deviceCode !== deviceCode) {
        return { error: 'expired_token', error_description: 'Unknown or stale device_code' };
      }
      mockState.pollCount += 1;
      const now = Date.now();

      if (mockState.scenario === 'network_error') {
        // Fail first two polls with throw (transport error); then deny so UI can settle.
        if (mockState.pollCount <= 2) {
          throw new Error('Mock network failure');
        }
        return { error: 'access_denied', error_description: 'Mock network scenario ended in denial' };
      }

      if (mockState.scenario === 'expire' || now >= mockState.expiresAt) {
        mockState = undefined;
        return { error: 'expired_token', error_description: 'Device code expired' };
      }

      if (mockState.scenario === 'deny' && now - mockState.createdAt >= mockState.approveAfterMs) {
        mockState = undefined;
        return { error: 'access_denied', error_description: 'User denied the request' };
      }

      if (mockState.scenario === 'auto_approve' && now - mockState.createdAt >= mockState.approveAfterMs) {
        const approved = mockState;
        mockState = undefined;
        return {
          status: 'approved',
          access_token: `mock_access_${approved.deviceCode.slice(-8)}`,
          refresh_token: `mock_refresh_${approved.userCode.replace(/[^A-Z0-9]/gi, '')}`,
          expires_in: 3600,
          token_type: 'Bearer',
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            tier: 'MAX',
            credits: 100,
            email: 'dogfood@tyne.local',
            githubUsername: 'dogfood-user',
          },
        };
      }

      return { status: 'authorization_pending' };
    },
  };
}

export function createLiveDeviceAuthTransport(cfg: DeviceAuthConfig = getDeviceAuthConfig()): DeviceAuthTransport {
  const startUrl = `${cfg.baseUrl.replace(/\/+$/, '')}${cfg.startPath}`;
  const pollUrl = `${cfg.baseUrl.replace(/\/+$/, '')}${cfg.pollPath}`;
  return {
    async start(): Promise<DeviceAuthStartResponse> {
      const res = await fetch(startUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          apikey: DEFAULT_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${DEFAULT_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`device-auth-start failed (${res.status}): ${text.slice(0, 200)}`);
      }
      return JSON.parse(text) as DeviceAuthStartResponse;
    },
    async poll(deviceCode: string): Promise<DeviceAuthPollResult> {
      const res = await fetch(pollUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          apikey: DEFAULT_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${DEFAULT_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ device_code: deviceCode }),
      });
      const text = await res.text();
      let body: DeviceAuthPollResult;
      try {
        body = JSON.parse(text) as DeviceAuthPollResult;
      } catch {
        throw new Error(`device-auth-poll invalid JSON (${res.status})`);
      }
      return body;
    },
  };
}

export function createDeviceAuthTransport(cfg: DeviceAuthConfig = getDeviceAuthConfig()): DeviceAuthTransport {
  return cfg.mode === 'live' ? createLiveDeviceAuthTransport(cfg) : createMockDeviceAuthTransport(cfg);
}

/** Clear in-memory mock device code (tests / cancel). */
export function resetMockDeviceAuthState(): void {
  mockState = undefined;
}

// ── Token storage ────────────────────────────────────────────────────────────

export async function storeDeviceAuthTokens(
  context: vscode.ExtensionContext,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  // Never log token values.
  await context.secrets.store(DEVICE_AUTH_ACCESS_TOKEN_KEY, accessToken);
  await context.secrets.store(DEVICE_AUTH_REFRESH_TOKEN_KEY, refreshToken);
  logDeviceAuth('Session tokens stored in SecretStorage');
}

export async function clearDeviceAuthTokens(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(DEVICE_AUTH_ACCESS_TOKEN_KEY);
  await context.secrets.delete(DEVICE_AUTH_REFRESH_TOKEN_KEY);
  logDeviceAuth('Session tokens cleared');
}

export async function getDeviceAuthAccessToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(DEVICE_AUTH_ACCESS_TOKEN_KEY);
}

const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12emNmcWp0bGVhc3Vhd3Z2bXRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NjUzMDIsImV4cCI6MjA5NzU0MTMwMn0.cp-9zyJv_mVpzstAbVfvvMLuoncyvLHbCq89rW3E72Y';

export async function getEffectiveAuthToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const accessToken = await context.secrets.get(DEVICE_AUTH_ACCESS_TOKEN_KEY);
  const refreshToken = await context.secrets.get(DEVICE_AUTH_REFRESH_TOKEN_KEY);

  if (accessToken) {
    try {
      const parts = accessToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (typeof payload.exp === 'number' && Date.now() >= (payload.exp - 60) * 1000) {
          if (refreshToken) {
            logDeviceAuth('Session access token expired or expiring soon. Attempting refresh...');
            const cfg = getDeviceAuthConfig();
            const baseUrl = cfg.baseUrl.replace(/\/functions\/v1\/?$/, '');
            const refreshRes = await fetch(`${baseUrl}/auth/v1/token?grant_type=refresh_token`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': DEFAULT_SUPABASE_ANON_KEY,
              },
              body: JSON.stringify({ refresh_token: refreshToken }),
            });

            if (refreshRes.ok) {
              const data = await refreshRes.json() as { access_token?: string; refresh_token?: string };
              if (data.access_token && data.refresh_token) {
                await storeDeviceAuthTokens(context, data.access_token, data.refresh_token);
                return data.access_token;
              }
            } else {
              logDeviceAuth(`Token refresh failed (${refreshRes.status}). Clearing dead session.`);
              await clearDeviceAuthTokens(context);
              // Fall through to GitHub PAT only if present — do not keep serving a dead JWT.
            }
          } else {
            logDeviceAuth('Session expired with no refresh token. Clearing.');
            await clearDeviceAuthTokens(context);
          }
        } else {
          return accessToken;
        }
      } else {
        return accessToken;
      }
    } catch (err: unknown) {
      // If parsing fails or not a JWT, return accessToken as is
      return accessToken;
    }
  }

  // Fallback to GitHub token during rollout or if device auth hasn't run yet
  return context.secrets.get('tyne_github_token');
}

// ── Flow / state machine ─────────────────────────────────────────────────────

export type DeviceAuthFlowHandlers = {
  onStatus(msg: Omit<DeviceAuthStatusMessage, 'type'>): void;
  /** Open verification URL (stubbed to openExternal; mock URI is fine). */
  openBrowser(uri: string): void | Promise<void>;
};

export type DeviceAuthFlowHandle = {
  cancel(): void;
  /** Promise settles when flow reaches a terminal state. */
  done: Promise<{ ok: true; user: DeviceAuthPollSuccess['user'] } | { ok: false; status: DeviceAuthFlowStatus; message: string }>;
};

/**
 * Run the device-auth login state machine end-to-end.
 * Network failures mid-poll retry with backoff, then surface error (no silent fail).
 * Focus loss does not cancel or restart — caller may notify focus regain via trackDeviceAuthEvent.
 */
export function runDeviceAuthFlow(
  context: vscode.ExtensionContext,
  handlers: DeviceAuthFlowHandlers,
  options?: { transport?: DeviceAuthTransport; signal?: AbortSignal },
): DeviceAuthFlowHandle {
  const transport = options?.transport || createDeviceAuthTransport();
  const external = options?.signal;
  const controller = new AbortController();
  const signal = controller.signal;

  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let deviceCode: string | undefined;
  let intervalMs = 1000;
  let networkFailures = 0;
  const MAX_NETWORK_FAILURES = 3;

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    deviceCode = undefined;
    resetMockDeviceAuthState();
  };

  const done = (async () => {
    try {
      trackDeviceAuthEvent(context, 'device_auth_flow_started', { mode: getDeviceAuthConfig().mode });
      handlers.onStatus({ status: 'started', message: 'Starting device login…' });

      const start = await transport.start();
      if (signal.aborted) {
        cleanup();
        handlers.onStatus({ status: 'cancelled', message: 'Login cancelled.', canRetry: true });
        return { ok: false as const, status: 'cancelled' as const, message: 'cancelled' };
      }

      deviceCode = start.device_code;
      intervalMs = Math.max(1000, (start.interval || 5) * 1000);
      const verificationUri = start.verification_uri_complete || start.verification_uri;

      trackDeviceAuthEvent(context, 'device_auth_browser_opened');
      handlers.onStatus({
        status: 'browser_opened',
        userCode: start.user_code,
        verificationUri,
        message: 'Open the browser and confirm this code.',
      });
      await handlers.openBrowser(verificationUri);

      trackDeviceAuthEvent(context, 'device_auth_waiting');
      handlers.onStatus({
        status: 'waiting',
        userCode: start.user_code,
        verificationUri,
        message: 'Waiting for confirmation in browser…',
      });

      const deadline = Date.now() + Math.max(5, start.expires_in || 900) * 1000;

      while (!signal.aborted) {
        if (Date.now() >= deadline) {
          cleanup();
          trackDeviceAuthEvent(context, 'device_auth_expired');
          handlers.onStatus({
            status: 'expired',
            message: 'Device code expired. Try again to get a new code.',
            canRetry: true,
          });
          return { ok: false as const, status: 'expired' as const, message: 'expired' };
        }

        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, intervalMs);
        });
        timer = null;
        if (signal.aborted) { break; }

        let result: DeviceAuthPollResult;
        try {
          result = await transport.poll(deviceCode!);
          networkFailures = 0;
        } catch (err: unknown) {
          networkFailures += 1;
          const message = err instanceof Error ? err.message : String(err);
          logDeviceAuth(`Poll network error (${networkFailures}/${MAX_NETWORK_FAILURES}): ${message}`);
          if (networkFailures >= MAX_NETWORK_FAILURES) {
            cleanup();
            trackDeviceAuthEvent(context, 'device_auth_error', { reason: 'network' });
            handlers.onStatus({
              status: 'error',
              message: 'Network error while waiting for confirmation. Check your connection and try again.',
              canRetry: true,
            });
            return { ok: false as const, status: 'error' as const, message };
          }
          // Back off and keep the same device_code.
          intervalMs = Math.min(intervalMs * 2, 15000);
          continue;
        }

        if ('error' in result && result.error) {
          if (result.error === 'authorization_pending') {
            continue;
          }
          if (result.error === 'slow_down') {
            intervalMs = Math.min(intervalMs + 5000, 20000);
            continue;
          }
          if (result.error === 'expired_token') {
            cleanup();
            trackDeviceAuthEvent(context, 'device_auth_expired');
            handlers.onStatus({
              status: 'expired',
              message: result.error_description || 'Device code expired. Try again.',
              canRetry: true,
            });
            return { ok: false as const, status: 'expired' as const, message: result.error };
          }
          if (result.error === 'access_denied') {
            cleanup();
            trackDeviceAuthEvent(context, 'device_auth_denied');
            handlers.onStatus({
              status: 'denied',
              message: result.error_description || 'Authorization denied in browser.',
              canRetry: true,
            });
            return { ok: false as const, status: 'denied' as const, message: result.error };
          }
          cleanup();
          trackDeviceAuthEvent(context, 'device_auth_error', { reason: result.error });
          handlers.onStatus({
            status: 'error',
            message: result.error_description || `Login error: ${result.error}`,
            canRetry: true,
          });
          return { ok: false as const, status: 'error' as const, message: result.error };
        }

        // Live + mock success: tokens present (live includes status:'approved' + user).
        const maybeTokens = result as Partial<DeviceAuthPollSuccess> & { user_id?: string };
        if (maybeTokens.access_token && maybeTokens.refresh_token) {
          await storeDeviceAuthTokens(context, maybeTokens.access_token, maybeTokens.refresh_token);
          cleanup();
          const user = maybeTokens.user || {
            id: maybeTokens.user_id || 'unknown',
            tier: 'UNKNOWN',
            credits: 0,
          };
          trackDeviceAuthEvent(context, 'device_auth_success', { tier: user.tier });
          handlers.onStatus({
            status: 'success',
            message: 'Device authorization succeeded. Session token stored.',
            userCode: start.user_code,
          });
          return { ok: true as const, user };
        }

        if ('status' in result) {
          if (result.status === 'authorization_pending' || result.status === 'slow_down') {
            if (result.status === 'slow_down' && result.interval) {
              intervalMs = Math.max(intervalMs, result.interval * 1000);
            }
            continue;
          }
        }
      }

      cleanup();
      handlers.onStatus({ status: 'cancelled', message: 'Login cancelled.', canRetry: true });
      return { ok: false as const, status: 'cancelled' as const, message: 'cancelled' };
    } catch (err: unknown) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      trackDeviceAuthEvent(context, 'device_auth_error', { reason: 'start_or_fatal' });
      handlers.onStatus({
        status: 'error',
        message: message.slice(0, 240),
        canRetry: true,
      });
      return { ok: false as const, status: 'error' as const, message };
    }
  })();

  return {
    cancel(): void {
      controller.abort();
      cleanup();
    },
    done,
  };
}
