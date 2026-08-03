import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'

const STATE_TTL_MS = 5 * 60 * 1000
const LINEAR_AUTH_URL = 'https://linear.app/oauth/authorize'
const FLOW_NORMAL = 'normal_user_linear_connect'
const LINEAR_SCOPES = ['read', 'write']
const EXPECTED_REDIRECT_SUFFIX = '/functions/v1/linear-oauth-callback'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401)
  }

  const clientId = Deno.env.get('LINEAR_CLIENT_ID')
  const redirectUri = Deno.env.get('LINEAR_REDIRECT_URI')
  const clientSecret = Deno.env.get('LINEAR_CLIENT_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  // Safe config diagnostics — host/path/prefix and presence flags only. Never log
  // the full client id, client secret, developer token, OAuth state/code, or tokens.
  let redirectUriHost = ''
  let redirectUriPath = ''
  try {
    if (redirectUri) {
      const parsed = new URL(redirectUri)
      redirectUriHost = parsed.host
      redirectUriPath = parsed.pathname
    }
  } catch {
    // malformed redirect uri — flagged by the suffix warning below
  }
  console.log(
    `Linear OAuth config: clientIdPrefix=${clientId ? clientId.slice(0, 6) : ''} ` +
    `redirectUriHost=${redirectUriHost} redirectUriPath=${redirectUriPath} ` +
    `hasLinearClientId=${Boolean(clientId)} hasLinearRedirectUri=${Boolean(redirectUri)} ` +
    `hasLinearClientSecret=${Boolean(clientSecret)}`,
  )
  if (redirectUri && !redirectUri.endsWith(EXPECTED_REDIRECT_SUFFIX)) {
    console.warn(`Linear OAuth warning: LINEAR_REDIRECT_URI does not end with ${EXPECTED_REDIRECT_SUFFIX}`)
  }

  if (!clientId || !redirectUri || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Supabase function environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const profile = await requireUserProfileId(supabase, authHeader, machineId)
  if ('error' in profile) {
    return jsonResponse({ error: profile.error }, profile.status)
  }

  const state = `${FLOW_NORMAL}:${randomUrlToken()}`
  const stateHash = await sha256Hex(state)
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString()
  const { error: insertError } = await supabase.from('linear_oauth_states').insert({
    user_id: profile.id,
    state_hash: stateHash,
    expires_at: expiresAt,
  })
  if (insertError) {
    console.error('Linear OAuth state insert failed:', insertError)
    return jsonResponse({ error: 'State creation failed' }, 500)
  }

  const authUrl = new URL(LINEAR_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', LINEAR_SCOPES.join(','))
  authUrl.searchParams.set('state', state)
  // actor=user: each user authenticates with their own Linear account (per
  // Linear OAuth docs), rather than acting as the application/workspace.
  authUrl.searchParams.set('actor', 'user')

  return jsonResponse({ state, auth_url: authUrl.toString(), expires_at: expiresAt })
})
