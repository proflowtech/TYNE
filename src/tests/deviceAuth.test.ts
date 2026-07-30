/**
 * Device-auth Phase 2 prep — source invariants + mock transport self-check.
 * Does not hit real device-auth-* URLs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module from 'node:module';

const root = join(__dirname, '../..');
const deviceAuthSrc = readFileSync(join(root, 'src/deviceAuth.ts'), 'utf8');
const sidebarSrc = readFileSync(join(root, 'src/TyneSidebarProvider.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/authSessionController.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/billingController.ts'), 'utf8');
const githubOAuthSrc = readFileSync(join(root, 'src/githubOAuth.ts'), 'utf8');
const tyneJs = readFileSync(join(root, 'media/tyne.js'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const contractDoc = readFileSync(join(root, 'docs/device-auth-api-contract.md'), 'utf8');

describe('device auth — isolation from GitHub Device Flow', () => {
  it('stores session tokens under new SecretStorage keys, not tyne_github_token', () => {
    assert.match(deviceAuthSrc, /DEVICE_AUTH_ACCESS_TOKEN_KEY = 'tyne_session_access_token'/);
    assert.match(deviceAuthSrc, /DEVICE_AUTH_REFRESH_TOKEN_KEY = 'tyne_session_refresh_token'/);
    assert.ok(!deviceAuthSrc.includes("secrets.store('tyne_github_token'"));
    assert.ok(!deviceAuthSrc.includes('from \'./githubOAuth\''));
    assert.ok(!deviceAuthSrc.includes('from "./githubOAuth"'));
  });

  it('githubOAuth still owns tyne_github_token and is untouched by deviceAuth imports', () => {
    assert.ok(githubOAuthSrc.includes("secrets.store('tyne_github_token'"));
    assert.ok(!githubOAuthSrc.includes('deviceAuth'));
  });

  it('dogfood flag gates device path; GitHub flow body remains', () => {
    assert.ok(packageJson.includes('"tyne.deviceAuthDogfood"'));
    assert.ok(packageJson.includes('"tyne.deviceAuthMode"'));
    assert.ok(sidebarSrc.includes('isDeviceAuthDogfoodEnabled()'));
    assert.ok(sidebarSrc.includes('_continueWithDeviceAuth'));
    assert.ok(sidebarSrc.includes('startGitHubDeviceFlow'));
    assert.ok(sidebarSrc.includes('pollGitHubDeviceToken'));
  });
});

describe('device auth — UI failure states', () => {
  it('webview handles expired / denied / error / success / cancelled', () => {
    assert.ok(tyneJs.includes("msg.type === 'deviceAuthStatus'"));
    for (const status of ['expired', 'denied', 'error', 'success', 'cancelled', 'waiting']) {
      assert.ok(tyneJs.includes(`msg.status === '${status}'`), `missing UI for ${status}`);
    }
    assert.ok(tyneJs.includes('deviceAuthRetry'));
    assert.ok(tyneJs.includes('deviceAuthCancel'));
  });

  it('host posts deviceAuthStatus and tracks focus lost/regained without restart', () => {
    assert.ok(sidebarSrc.includes("type: 'deviceAuthStatus'"));
    assert.ok(sidebarSrc.includes('device_auth_focus_lost'));
    assert.ok(sidebarSrc.includes('device_auth_focus_regained'));
    assert.ok(sidebarSrc.includes('poll continues (no restart)'));
  });
});

describe('device auth — telemetry + contract doc', () => {
  it('emits the required funnel events', () => {
    for (const ev of [
      'device_auth_flow_started',
      'device_auth_browser_opened',
      'device_auth_waiting',
      'device_auth_success',
      'device_auth_expired',
      'device_auth_denied',
      'device_auth_error',
    ]) {
      assert.ok(deviceAuthSrc.includes(`'${ev}'`), `missing telemetry ${ev}`);
    }
  });

  it('documents assumed start/poll/approve contract for web', () => {
    assert.ok(contractDoc.includes('device-auth-start'));
    assert.ok(contractDoc.includes('device-auth-poll'));
    assert.ok(contractDoc.includes('device_code'));
    assert.ok(contractDoc.includes('authorization_pending'));
    assert.ok(contractDoc.includes('expired_token'));
    assert.ok(contractDoc.includes('access_denied'));
    assert.ok(contractDoc.includes('tyne_session_access_token'));
  });

  it('defaults to live mode with mock available for offline UI tests', () => {
    assert.ok(deviceAuthSrc.includes("mode: 'live'"));
    assert.ok(deviceAuthSrc.includes('createMockDeviceAuthTransport'));
    assert.ok(deviceAuthSrc.includes('createLiveDeviceAuthTransport'));
    assert.ok(deviceAuthSrc.includes('createDeviceAuthTransport'));
    assert.ok(packageJson.includes('"default": "live"') || /"tyne\.deviceAuthMode"[\s\S]*?"default": "live"/.test(packageJson));
  });
});

describe('device auth — mock state machine (runtime)', () => {
  const secrets = new Map<string, string>();
  const funnel: Record<string, number> = {};
  let vscodeStub: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let load: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalLoad: any;

  before(() => {
    vscodeStub = {
      workspace: {
        getConfiguration: () => ({
          get: (key: string, def: unknown) => {
            if (key === 'deviceAuthDogfood') return true;
            if (key === 'deviceAuthMode') return 'mock';
            if (key === 'deviceAuthMockScenario') return 'auto_approve';
            return def;
          },
        }),
      },
      window: {
        createOutputChannel: () => ({ appendLine: () => undefined }),
      },
    };
    // @ts-expect-error Node internal
    originalLoad = Module._load;
    // @ts-expect-error Node internal
    Module._load = function (request: string, parent: NodeModule, isMain: boolean) {
      if (request === 'vscode') return vscodeStub;
      return originalLoad(request, parent, isMain);
    };
    // Fresh require after stub
    delete require.cache[require.resolve('../deviceAuth')];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    load = require('../deviceAuth');
  });

  after(() => {
    // @ts-expect-error Node internal
    Module._load = originalLoad;
  });

  function fakeContext() {
    return {
      secrets: {
        store: async (k: string, v: string) => { secrets.set(k, v); },
        delete: async (k: string) => { secrets.delete(k); },
        get: async (k: string) => secrets.get(k),
      },
      globalState: {
        get: (k: string) => (k === 'tyne.deviceAuth.funnel' ? { ...funnel } : undefined),
        update: async (k: string, v: Record<string, number>) => {
          if (k === 'tyne.deviceAuth.funnel') Object.assign(funnel, v);
        },
      },
    };
  }

  it('auto_approve: polls → success, stores tyne_session_* tokens, fires funnel', async () => {
    secrets.clear();
    for (const k of Object.keys(funnel)) delete funnel[k];
    load.setDeviceAuthConfigForTests({
      mode: 'mock',
      mockScenario: 'auto_approve',
      mockApproveAfterMs: 50,
      mockExpiresInSec: 30,
      mockPollIntervalSec: 0.05,
    });
    load.resetMockDeviceAuthState();

    const ctx = fakeContext();
    const statuses: string[] = [];
    const handle = load.runDeviceAuthFlow(ctx, {
      onStatus: (m: { status: string }) => statuses.push(m.status),
      openBrowser: async () => undefined,
    });

    const result = await handle.done;
    assert.equal(result.ok, true);
    assert.ok(secrets.get('tyne_session_access_token')?.startsWith('mock_access_'));
    assert.ok(secrets.get('tyne_session_refresh_token')?.startsWith('mock_refresh_'));
    assert.equal(secrets.has('tyne_github_token'), false);
    assert.ok((funnel.device_auth_flow_started || 0) >= 1);
    assert.ok((funnel.device_auth_browser_opened || 0) >= 1);
    assert.ok((funnel.device_auth_waiting || 0) >= 1);
    assert.ok((funnel.device_auth_success || 0) >= 1);
    assert.ok(statuses.includes('waiting'));
    assert.ok(statuses.includes('success'));
  });

  it('expire scenario → expired telemetry + retryable UI status', async () => {
    for (const k of Object.keys(funnel)) delete funnel[k];
    load.setDeviceAuthConfigForTests({
      mode: 'mock',
      mockScenario: 'expire',
      mockApproveAfterMs: 10,
      mockExpiresInSec: 30,
      mockPollIntervalSec: 0.05,
    });
    load.resetMockDeviceAuthState();

    const handle = load.runDeviceAuthFlow(fakeContext(), {
      onStatus: () => undefined,
      openBrowser: async () => undefined,
    });
    const result = await handle.done;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'expired');
    assert.ok((funnel.device_auth_expired || 0) >= 1);
  });

  it('deny scenario → denied telemetry', async () => {
    for (const k of Object.keys(funnel)) delete funnel[k];
    load.setDeviceAuthConfigForTests({
      mode: 'mock',
      mockScenario: 'deny',
      mockApproveAfterMs: 30,
      mockExpiresInSec: 30,
      mockPollIntervalSec: 0.05,
    });
    load.resetMockDeviceAuthState();

    const handle = load.runDeviceAuthFlow(fakeContext(), {
      onStatus: () => undefined,
      openBrowser: async () => undefined,
    });
    const result = await handle.done;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.ok((funnel.device_auth_denied || 0) >= 1);
  });

  it('network_error scenario → error after retries', async () => {
    for (const k of Object.keys(funnel)) delete funnel[k];
    load.setDeviceAuthConfigForTests({
      mode: 'mock',
      mockScenario: 'network_error',
      mockApproveAfterMs: 10,
      mockExpiresInSec: 30,
      mockPollIntervalSec: 0.05,
    });
    load.resetMockDeviceAuthState();

    const handle = load.runDeviceAuthFlow(fakeContext(), {
      onStatus: () => undefined,
      openBrowser: async () => undefined,
    });
    const result = await handle.done;
    assert.equal(result.ok, false);
    assert.ok(result.status === 'error' || result.status === 'denied');
    assert.ok((funnel.device_auth_error || 0) + (funnel.device_auth_denied || 0) >= 1);
  });
});

describe('device auth — live endpoints (dogfood verification)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let load: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalLoad: any;
  const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12emNmcWp0bGVhc3Vhd3Z2bXRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5NjUzMDIsImV4cCI6MjA5NzU0MTMwMn0.cp-9zyJv_mVpzstAbVfvvMLuoncyvLHbCq89rW3E72Y';
  const BASE = 'https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1';

  before(() => {
    const vscodeStub = {
      workspace: {
        getConfiguration: () => ({
          get: (key: string, def: unknown) => {
            if (key === 'deviceAuthMode') return 'live';
            return def;
          },
        }),
      },
      window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
    };
    // @ts-expect-error Node internal
    originalLoad = Module._load;
    // @ts-expect-error Node internal
    Module._load = function (request: string, parent: NodeModule, isMain: boolean) {
      if (request === 'vscode') return vscodeStub;
      return originalLoad(request, parent, isMain);
    };
    delete require.cache[require.resolve('../deviceAuth')];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    load = require('../deviceAuth');
  });

  after(() => {
    // @ts-expect-error Node internal
    Module._load = originalLoad;
  });

  it('live start returns device_code + user_code and poll returns authorization_pending', async () => {
    load.setDeviceAuthConfigForTests({ mode: 'live' });
    const transport = load.createLiveDeviceAuthTransport(load.getDeviceAuthConfig());
    let start: { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
    try {
      start = await transport.start();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOTFOUND|fetch failed|network/i.test(msg)) { return; }
      throw err;
    }
    assert.ok(start.device_code);
    assert.ok(start.user_code);
    assert.ok(start.verification_uri);
    assert.ok(start.expires_in > 0);
    assert.ok(start.interval > 0);

    const pending = await transport.poll(start.device_code);
    assert.equal(pending.error, 'authorization_pending');
  });

  it('live poll unknown device_code → invalid_grant (client maps to error)', async () => {
    load.setDeviceAuthConfigForTests({ mode: 'live' });
    const transport = load.createLiveDeviceAuthTransport(load.getDeviceAuthConfig());
    let body: { error?: string };
    try {
      body = await transport.poll('not-a-real-device-code');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOTFOUND|fetch failed|network/i.test(msg)) { return; }
      throw err;
    }
    assert.equal(body.error, 'invalid_grant');
  });

  it('live network_error scenario: bad baseUrl surfaces error via state machine', async () => {
    const secrets = new Map<string, string>();
    const funnel: Record<string, number> = {};
    const ctx = {
      secrets: {
        store: async (k: string, v: string) => { secrets.set(k, v); },
        delete: async (k: string) => { secrets.delete(k); },
        get: async (k: string) => secrets.get(k),
      },
      globalState: {
        get: () => ({ ...funnel }),
        update: async (_k: string, v: Record<string, number>) => { Object.assign(funnel, v); },
      },
    };
    load.setDeviceAuthConfigForTests({
      mode: 'live',
      baseUrl: 'https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/does-not-exist',
      startPath: '/nope',
      pollPath: '/nope',
    });
    const handle = load.runDeviceAuthFlow(ctx, {
      onStatus: () => undefined,
      openBrowser: async () => undefined,
    }, {
      transport: load.createLiveDeviceAuthTransport(load.getDeviceAuthConfig()),
    });
    const result = await handle.done;
    assert.equal(result.ok, false);
    assert.equal(result.status, 'error');
    assert.ok((funnel.device_auth_error || 0) >= 1);
  });

  it('live expire: forced expired row → expired_token', async () => {
    // Requires agent/SQL to set status=expired, then TYNE_LIVE_FORCE_STATUS=1
    const code = process.env.TYNE_LIVE_EXPIRED_DEVICE_CODE;
    if (!code || process.env.TYNE_LIVE_FORCE_STATUS !== '1') { return; }
    const res = await fetch(`${BASE}/device-auth-poll`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({ device_code: code }),
    });
    const body = await res.json() as { error?: string };
    assert.equal(body.error, 'expired_token');
  });

  it('live deny: forced denied row → access_denied', async () => {
    const code = process.env.TYNE_LIVE_DENIED_DEVICE_CODE;
    if (!code || process.env.TYNE_LIVE_FORCE_STATUS !== '1') { return; }
    const res = await fetch(`${BASE}/device-auth-poll`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({ device_code: code }),
    });
    const body = await res.json() as { error?: string };
    assert.equal(body.error, 'access_denied');
  });
});

describe('device auth — profile path uses session token', () => {
  it('sidebar fetches profile via getEffectiveAuthToken / usage for session path', () => {
    assert.ok(sidebarSrc.includes('getEffectiveAuthToken'));
    assert.ok(sidebarSrc.includes('DEVICE_AUTH_ACCESS_TOKEN_KEY'));
    assert.ok(sidebarSrc.includes("functions/v1/usage"));
    assert.ok(sidebarSrc.includes('isBanned') || sidebarSrc.includes('is_banned'));
  });
});
