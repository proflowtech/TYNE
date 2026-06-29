import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type AtlassianResource = {
  id?: string
  url?: string
  name?: string
  scopes?: string[]
}

type AtlassianProfile = {
  account_id?: string
  accountId?: string
  email?: string
  emailAddress?: string
  name?: string
  displayName?: string
  picture?: string
}

const EXCHANGE_TTL_MS = 5 * 60 * 1000
const FLOW_NORMAL = 'normal_user_jira_connect'
const FLOW_ADMIN = 'admin_personal_data_report_token_setup'

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function htmlResponse(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#101214; color:#f4f1e8; display:grid; min-height:100vh; place-items:center; margin:0; }
      main { width:min(560px, calc(100vw - 40px)); border:1px solid rgba(244,241,232,.18); border-radius:24px; padding:32px; background:linear-gradient(145deg, rgba(255,255,255,.09), rgba(255,255,255,.03)); box-shadow:0 24px 80px rgba(0,0,0,.34); }
      h1 { margin:0 0 12px; font-size:24px; }
      p { margin:0; color:#cfc7b6; line-height:1.55; }
    </style>
  </head>
  <body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function oauthHandoffResponse(callbackUrl: string): Response {
  const safeCallbackUrl = escapeHtml(callbackUrl)
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jira connected to Tyne</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #101214;
        color: #f4f1e8;
        display: grid;
        min-height: 100vh;
        place-items: center;
        margin: 0;
      }
      main {
        width: min(620px, calc(100vw - 40px));
        border: 1px solid rgba(244,241,232,.18);
        border-radius: 24px;
        padding: 32px;
        background: linear-gradient(145deg, rgba(255,255,255,.09), rgba(255,255,255,.03));
        box-shadow: 0 24px 80px rgba(0,0,0,.34);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 12px 0 0;
        color: #cfc7b6;
        line-height: 1.55;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 24px;
      }
      .btn {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        background: #f4f1e8;
        color: #101214;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
      }
      .btn.secondary {
        background: transparent;
        color: #f4f1e8;
        border: 1px solid rgba(244,241,232,.24);
      }
      .note {
        font-size: 14px;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Jira connected to Tyne</h1>
      <p id="status">Opening VS Code to finish the connection…</p>
      <p>If Jira already shows as connected in the Tyne extension, you are done and can close this tab.</p>
      <div class="actions">
        <a class="btn" id="open-link" href="${safeCallbackUrl}">Open VS Code</a>
        <button class="btn secondary" id="retry-btn" type="button">Try again</button>
      </div>
      <p class="note">If your browser asks for permission to open VS Code, allow it. This handoff uses a single-use secure callback.</p>
    </main>
    <script>
      const callbackUrl = ${JSON.stringify(callbackUrl)};
      const status = document.getElementById('status');
      const openLink = document.getElementById('open-link');
      const retryBtn = document.getElementById('retry-btn');

      function launchVsCode() {
        if (status) {
          status.textContent = 'Opening VS Code to finish the connection…';
        }
        window.location.href = callbackUrl;
      }

      retryBtn?.addEventListener('click', launchVsCode);
      openLink?.addEventListener('click', () => {
        if (status) {
          status.textContent = 'Opening VS Code to finish the connection…';
        }
      });

      setTimeout(launchVsCode, 50);
      setTimeout(() => {
        if (status) {
          status.textContent = 'If VS Code did not open automatically, click "Open VS Code" above. If Tyne already shows Jira connected, you can close this tab.';
        }
      }, 1800);
    </script>
  </body>
</html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomUrlToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function parseFlow(rawState: string): { flow: string; token: string } {
  if (rawState.startsWith(`${FLOW_ADMIN}:`)) {
    return { flow: FLOW_ADMIN, token: rawState.slice(FLOW_ADMIN.length + 1) }
  }
  if (rawState.startsWith(`${FLOW_NORMAL}:`)) {
    return { flow: FLOW_NORMAL, token: rawState.slice(FLOW_NORMAL.length + 1) }
  }
  // Backwards compatibility for states issued before the flow prefix was introduced.
  return { flow: FLOW_NORMAL, token: rawState }
}

async function exchangeAtlassianCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string | null } | null> {
  const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => '')
    console.error('Atlassian token exchange failed:', err)
    return null
  }

  const tokenPayload = await tokenRes.json()
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
  const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : ''
  const expiresIn = Number(tokenPayload.expires_in || 0)
  const scope = typeof tokenPayload.scope === 'string' ? tokenPayload.scope : null

  if (!accessToken || !refreshToken || !expiresIn) {
    return null
  }

  return { accessToken, refreshToken, expiresIn, scope }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const rawState = url.searchParams.get('state')
  const atlassianError = url.searchParams.get('error')
  const { flow } = parseFlow(rawState || '')

  if (atlassianError) {
    if (flow === FLOW_ADMIN) {
      return htmlResponse('Atlassian authorization cancelled', 'No token was saved. You can close this tab and try again from Tyne settings.', 400)
    }
    return jsonResponse({ error: 'Atlassian authorization error' }, 400)
  }

  if (!code || !rawState) {
    if (flow === FLOW_ADMIN) {
      return htmlResponse('Missing authorization data', 'No token was saved because Atlassian did not return the expected callback parameters.', 400)
    }
    return jsonResponse({ error: 'Missing code or state' }, 400)
  }

  const clientId = Deno.env.get('JIRA_CLIENT_ID')
  const clientSecret = Deno.env.get('JIRA_CLIENT_SECRET')
  const redirectUri = Deno.env.get('JIRA_REDIRECT_URI')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const vscodeCallbackUri = Deno.env.get('JIRA_VSCODE_CALLBACK_URI') || 'vscode://tyne.tyne/auth-complete'

  if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !serviceRoleKey) {
    if (flow === FLOW_ADMIN) {
      return htmlResponse('Server configuration missing', 'The reporting token was not saved because the backend is missing required OAuth configuration.', 500)
    }
    return jsonResponse({ error: 'Missing Jira OAuth function environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const stateHash = await sha256Hex(rawState)

  if (flow === FLOW_ADMIN) {
    const { data: stateRow, error: stateLookupError } = await supabase
      .from('atlassian_report_oauth_states')
      .select('id, admin_user_id, expires_at, consumed_at')
      .eq('state_hash', stateHash)
      .maybeSingle()

    if (stateLookupError) {
      console.error('Atlassian report OAuth state lookup failed:', stateLookupError)
      return htmlResponse('Authorization state lookup failed', 'No token was saved. Please try again from Tyne settings.', 500)
    }

    if (!stateRow || stateRow.consumed_at || new Date(stateRow.expires_at).getTime() <= Date.now()) {
      return htmlResponse('Authorization expired', 'No token was saved because the secure authorization state was invalid or expired.', 400)
    }

    const { data: consumedState, error: consumeError } = await supabase
      .from('atlassian_report_oauth_states')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', stateRow.id)
      .is('consumed_at', null)
      .select('id, admin_user_id')
      .maybeSingle()

    if (consumeError) {
      console.error('Atlassian report OAuth state consume failed:', consumeError)
      return htmlResponse('Authorization state consume failed', 'No token was saved. Please try again from Tyne settings.', 500)
    }

    if (!consumedState) {
      return htmlResponse('Authorization already used', 'No token was saved because this authorization link was already consumed.', 400)
    }

    const tokenResult = await exchangeAtlassianCode(code, redirectUri, clientId, clientSecret)
    if (!tokenResult) {
      return htmlResponse('Token exchange failed', 'No token was saved. Please confirm the Atlassian app redirect URL and try again.', 502)
    }

    const { accessToken, refreshToken, expiresIn, scope } = tokenResult

    const profileRes = await fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
    const profile = profileRes.ok ? await profileRes.json() as AtlassianProfile : null
    const now = new Date().toISOString()
    const { error: upsertError } = await supabase
      .from('atlassian_report_credentials')
      .upsert({
        provider: 'atlassian_personal_data_reporting',
        admin_user_id: consumedState.admin_user_id,
        atlassian_account_id: profile?.account_id ?? profile?.accountId ?? null,
        account_email: profile?.email ?? profile?.emailAddress ?? null,
        account_name: profile?.displayName ?? profile?.name ?? null,
        access_token: accessToken,
        refresh_token: refreshToken,
        scope,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        last_refreshed_at: null,
        updated_at: now,
      }, { onConflict: 'provider' })

    if (upsertError) {
      console.error('Atlassian report credential save failed:', upsertError)
      return htmlResponse('Token save failed', 'The token exchange succeeded, but Tyne could not save the reporting credential.', 500)
    }

    return htmlResponse(
      'Atlassian reporting token saved',
      'The reporting credential was stored securely in Supabase. The token was not displayed. You can close this tab and return to Tyne.',
    )
  }

  const { data: stateRow, error: stateLookupError } = await supabase
    .from('jira_oauth_states')
    .select('id, user_id, state_hash, expires_at, consumed_at')
    .eq('state_hash', stateHash)
    .maybeSingle()

  if (stateLookupError) {
    console.error('Jira OAuth state lookup failed:', stateLookupError)
    return jsonResponse({ error: 'State lookup failed' }, 500)
  }

  if (!stateRow || stateRow.consumed_at || new Date(stateRow.expires_at).getTime() <= Date.now()) {
    return jsonResponse({ error: 'Invalid or expired state' }, 400)
  }

  const consumedAt = new Date().toISOString()
  const { data: consumedState, error: consumeError } = await supabase
    .from('jira_oauth_states')
    .update({ consumed_at: consumedAt })
    .eq('id', stateRow.id)
    .is('consumed_at', null)
    .select('id, user_id, state_hash')
    .maybeSingle()

  if (consumeError) {
    console.error('Jira OAuth state consume failed:', consumeError)
    return jsonResponse({ error: 'State consume failed' }, 500)
  }

  if (!consumedState) {
    return jsonResponse({ error: 'State already consumed' }, 400)
  }

  const tokenResult = await exchangeAtlassianCode(code, redirectUri, clientId, clientSecret)
  if (!tokenResult) {
    return jsonResponse({ error: 'Token exchange failed' }, 502)
  }

  const { accessToken, refreshToken, expiresIn } = tokenResult

  const [resourcesRes, profileRes] = await Promise.all([
    fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }),
    fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }),
  ])

  const resources = resourcesRes.ok ? await resourcesRes.json() as AtlassianResource[] : []
  const profile = profileRes.ok ? await profileRes.json() as AtlassianProfile : null
  const jiraResources = Array.isArray(resources)
    ? resources.filter((resource) => Boolean(resource?.id && resource?.url))
    : []
  const firstResource = jiraResources[0]
  const accountId = profile?.account_id ?? profile?.accountId ?? null
  const profileUpdatedAt = new Date().toISOString()

  if (!firstResource?.id) {
    return jsonResponse({ error: 'No Jira sites available for this Atlassian account' }, 400)
  }

  const { data: connection, error } = await supabase
    .from('jira_connections')
    .upsert({
      user_id: consumedState.user_id,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      cloud_id: firstResource.id,
      site_name: firstResource.name ?? null,
      site_url: firstResource.url ?? null,
      account_email: profile?.email ?? profile?.emailAddress ?? null,
      account_name: profile?.displayName ?? profile?.name ?? null,
      atlassian_account_id: accountId,
      atlassian_personal_data_updated_at: accountId ? profileUpdatedAt : null,
      personal_data_reporting_status: accountId ? 'pending' : null,
      updated_at: profileUpdatedAt,
    }, { onConflict: 'user_id' })
    .select('id')
    .single()

  if (error) {
    console.error('Jira connection upsert failed:', error)
    return jsonResponse({ error: 'DB error' }, 500)
  }

  const exchangeCode = randomUrlToken()
  const exchangeCodeHash = await sha256Hex(exchangeCode)
  const { error: exchangeError } = await supabase
    .from('jira_oauth_exchanges')
    .insert({
      user_id: consumedState.user_id,
      exchange_code_hash: exchangeCodeHash,
      jira_connection_id: connection?.id ?? null,
      state_hash: consumedState.state_hash,
      available_sites: jiraResources.map((resource) => ({
        cloud_id: resource.id,
        site_name: resource.name ?? null,
        site_url: resource.url ?? null,
        scopes: Array.isArray(resource.scopes) ? resource.scopes : [],
      })),
      expires_at: new Date(Date.now() + EXCHANGE_TTL_MS).toISOString(),
    })

  if (exchangeError) {
    console.error('Jira OAuth exchange insert failed:', exchangeError)
    return jsonResponse({ error: 'Exchange creation failed' }, 500)
  }

  const callback = new URL(vscodeCallbackUri)
  callback.searchParams.set('code', exchangeCode)
  // Echo the original OAuth state so the extension can strictly match this result
  // to the exact pending attempt it started (prevents stale/duplicate attempts).
  callback.searchParams.set('state', rawState)

  return oauthHandoffResponse(callback.toString())
})
