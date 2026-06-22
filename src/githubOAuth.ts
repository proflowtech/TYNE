import * as vscode from 'vscode';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_SCOPES = 'repo';

export interface DeviceFlowStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface GitHubTokenResult {
  accessToken: string;
  scope: string;
}

export async function startGitHubDeviceFlow(clientId: string): Promise<DeviceFlowStartResult> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: DEFAULT_SCOPES,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub device flow failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`GitHub device flow error: ${data.error_description || data.error}`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval,
    expiresIn: data.expires_in,
  };
}

export async function pollGitHubDeviceToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  context: vscode.ExtensionContext,
  signal?: AbortSignal,
): Promise<GitHubTokenResult> {
  let intervalMs = Math.max(intervalSeconds * 1000, 5000);

  return new Promise((resolve, reject) => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      active = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const tick = async (): Promise<void> => {
      if (!active) { return; }
      if (signal?.aborted) {
        cleanup();
        reject(new Error('GitHub connection cancelled'));
        return;
      }

      try {
        const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });

        const raw = await res.text();
        let data: Record<string, string>;

        try {
          data = JSON.parse(raw) as Record<string, string>;
        } catch {
          data = Object.fromEntries(new URLSearchParams(raw));
        }

        if (data.error) {
          switch (data.error) {
            case 'authorization_pending':
              timer = setTimeout(tick, intervalMs);
              return;
            case 'slow_down':
              intervalMs = Math.max(
                (parseInt(data.interval, 10) || intervalSeconds) * 1000,
                intervalMs + 5000,
              );
              timer = setTimeout(tick, intervalMs);
              return;
            case 'expired_token':
            case 'access_denied':
              cleanup();
              reject(new Error(`GitHub OAuth error: ${data.error_description || data.error}`));
              return;
            default:
              cleanup();
              reject(new Error(`GitHub OAuth error: ${data.error_description || data.error}`));
              return;
          }
        }

        if (data.access_token) {
          cleanup();
          await context.secrets.store('tyne_github_token', data.access_token);
          resolve({
            accessToken: data.access_token,
            scope: data.scope || DEFAULT_SCOPES,
          });
          return;
        }

        if (!res.ok) {
          cleanup();
          reject(new Error(`GitHub token exchange failed (${res.status}): ${raw}`));
          return;
        }

        timer = setTimeout(tick, intervalMs);
      } catch (err: unknown) {
        cleanup();
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`GitHub token polling failed: ${message}`));
      }
    };

    timer = setTimeout(tick, intervalMs);
  });
}

export function openGitHubDeviceUri(uri: string): void {
  vscode.env.openExternal(vscode.Uri.parse(uri));
}
