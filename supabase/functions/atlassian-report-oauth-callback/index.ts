import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type AtlassianProfile = {
  account_id?: string
  accountId?: string
  email?: string
  emailAddress?: string
  name?: string
  displayName?: string
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return htmlResponse('Atlassian authorization cancelled', 'No token was saved. You can close this tab and try again from Tyne settings.', 400)
  }

  if (!code || !state) {
    return htmlResponse('Missing authorization data', 'No token was saved because Atlassian did not return the expected callback parameters.', 400)
  }

  // Shared Atlassian OAuth client credentials (same app as Jira OAuth).
  const clientId = Deno.env.get('JIRA_CLIENT_ID')
  const clientSecret = Deno.env.get('JIRA_CLIENT_SECRET')
  // The token-exchange redirect_uri must exactly match the one used in the admin
  // reporting authorize step. Use only the dedicated reporting redirect URI.
  const redirectUri = Deno.env.get('ATLASSIAN_REPORTING_REDIRECT_URI')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !serviceRoleKey) {
    return htmlResponse('Server configuration missing', 'The reporting token was not saved because the backend is missing required OAuth configuration.', 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const stateHash = await sha256Hex(state)
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

  const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
    console.error('Atlassian report token exchange failed with status:', tokenRes.status)
    return htmlResponse('Token exchange failed', 'No token was saved. Please confirm the Atlassian app redirect URL and try again.', 502)
  }

  const tokenPayload = await tokenRes.json()
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
  const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : ''
  const expiresIn = Number(tokenPayload.expires_in || 0)
  const scope = typeof tokenPayload.scope === 'string' ? tokenPayload.scope : null

  if (!accessToken || !refreshToken || !expiresIn) {
    return htmlResponse('Incomplete token response', 'No token was saved because Atlassian did not return an offline refresh token.', 502)
  }

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
})
