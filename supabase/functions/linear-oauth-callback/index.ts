import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EXCHANGE_TTL_MS = 5 * 60 * 1000
const FLOW_NORMAL = 'normal_user_linear_connect'

function htmlResponse(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function oauthHandoffResponse(callbackUrl: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Linear connected to Tyne</title></head><body><main><h1>Linear connected to Tyne</h1><p id="status">Opening VS Code to finish the connection…</p><p>If Linear already shows as connected in Tyne, you can close this tab.</p><p><a id="open-link" href="${callbackUrl}">Open VS Code</a></p></main><script>const callbackUrl=${JSON.stringify(callbackUrl)};setTimeout(()=>{window.location.href=callbackUrl},50);setTimeout(()=>{const status=document.getElementById('status');if(status){status.textContent='If VS Code did not open automatically, click "Open VS Code" above.'}},1800);</script></body></html>`, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomUrlToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function linearGraphQL<T>(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await res.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null
  if (!res.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Linear request failed (${res.status})`)
  }
  return payload.data as T
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const rawState = url.searchParams.get('state')
  const linearError = url.searchParams.get('error')
  if (linearError) {
    return htmlResponse('Linear authorization cancelled', 'No connection was saved. You can close this tab and try again from Tyne.', 400)
  }
  if (!code || !rawState) {
    return htmlResponse('Missing authorization data', 'Linear did not return the expected callback parameters.', 400)
  }

  const clientId = Deno.env.get('LINEAR_CLIENT_ID')
  const clientSecret = Deno.env.get('LINEAR_CLIENT_SECRET')
  const redirectUri = Deno.env.get('LINEAR_REDIRECT_URI')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const vscodeCallbackUri = Deno.env.get('LINEAR_VSCODE_CALLBACK_URI') || 'vscode://tyne.tyne/linear-auth-complete'
  if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !serviceRoleKey) {
    return htmlResponse('Server configuration missing', 'The backend is missing required Linear OAuth configuration.', 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const stateHash = await sha256Hex(rawState)
  const { data: stateRow, error: stateLookupError } = await supabase
    .from('linear_oauth_states')
    .select('id, user_id, expires_at, consumed_at')
    .eq('state_hash', stateHash)
    .maybeSingle()
  if (stateLookupError) {
    console.error('Linear OAuth state lookup failed:', stateLookupError)
    return htmlResponse('Authorization state lookup failed', 'Please try again from Tyne.', 500)
  }
  if (!stateRow || stateRow.consumed_at || new Date(stateRow.expires_at).getTime() <= Date.now()) {
    return htmlResponse('Authorization expired', 'The secure authorization state was invalid or expired.', 400)
  }

  const { data: consumedState, error: consumeError } = await supabase
    .from('linear_oauth_states')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', stateRow.id)
    .eq('user_id', stateRow.user_id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle()
  if (consumeError || !consumedState) {
    console.error('Linear OAuth state consume failed:', consumeError)
    return htmlResponse('Authorization already used', 'This connection link has already been used.', 400)
  }

  const tokenRes = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
    console.error('Linear token exchange failed:', err)
    return htmlResponse('Linear token exchange failed', 'Tyne could not complete the Linear OAuth exchange.', 502)
  }

  const tokenPayload = await tokenRes.json() as Record<string, unknown>
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
  const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : null
  const expiresIn = Number(tokenPayload.expires_in || 0)
  if (!accessToken) {
    return htmlResponse('Incomplete token response', 'Linear did not return an access token.', 502)
  }

  const viewerData = await linearGraphQL<{
    viewer: { id: string; name?: string; email?: string; organization?: { id: string; name: string } | null }
    teams: { nodes: Array<{ id: string; key?: string; name: string }> }
  }>(accessToken, `
    query TyneLinearOAuthBootstrap {
      viewer {
        id
        name
        email
        organization { id name }
      }
      teams {
        nodes { id key name }
      }
    }
  `).catch(err => {
    console.error('Linear bootstrap query failed:', err)
    return null
  })
  if (!viewerData?.viewer?.id) {
    return htmlResponse('Linear profile lookup failed', 'Tyne could not load your Linear profile after authorization.', 502)
  }

  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
  const now = new Date().toISOString()
  const workspaceId = viewerData.viewer.organization?.id || null
  const workspaceName = viewerData.viewer.organization?.name || null

  const { data: connection, error: upsertError } = await supabase
    .from('linear_connections')
    .upsert({
      user_id: stateRow.user_id,
      linear_workspace_id: workspaceId,
      linear_workspace_name: workspaceName,
      linear_user_id: viewerData.viewer.id,
      linear_user_email: viewerData.viewer.email || null,
      linear_user_name: viewerData.viewer.name || null,
      access_token_encrypted: accessToken,
      refresh_token_encrypted: refreshToken,
      expires_at: expiresAt,
      updated_at: now,
    }, { onConflict: 'user_id,linear_workspace_id' })
    .select('id')
    .single()
  if (upsertError || !connection?.id) {
    console.error('Linear connection upsert failed:', upsertError)
    return htmlResponse('Linear connection failed', 'Tyne could not save the Linear connection.', 500)
  }

  const exchangeCode = randomUrlToken()
  const exchangeCodeHash = await sha256Hex(exchangeCode)
  const teams = viewerData.teams?.nodes || []
  const { error: exchangeError } = await supabase.from('linear_oauth_exchanges').insert({
    user_id: stateRow.user_id,
    exchange_code_hash: exchangeCodeHash,
    linear_connection_id: connection.id,
    available_teams: teams,
    expires_at: new Date(Date.now() + EXCHANGE_TTL_MS).toISOString(),
  })
  if (exchangeError) {
    console.error('Linear OAuth exchange insert failed:', exchangeError)
    return htmlResponse('Linear handoff failed', 'Tyne could not create the secure VS Code handoff.', 500)
  }

  const callbackUrl = `${vscodeCallbackUri}?code=${encodeURIComponent(exchangeCode)}&state=${encodeURIComponent(rawState)}`
  return oauthHandoffResponse(callbackUrl)
})
