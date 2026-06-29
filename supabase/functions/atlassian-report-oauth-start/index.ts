import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STATE_TTL_MS = 5 * 60 * 1000
const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize'
const ATLASSIAN_AUDIENCE = 'api.atlassian.com'
const FLOW_ADMIN = 'admin_personal_data_report_token_setup'
const ATLASSIAN_REPORT_SCOPES = ['offline_access', 'read:me']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-internal-secret',
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
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomUrlToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// Constant-time comparison so the internal secret check does not leak length/content via timing.
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) { return false }
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i]
  }
  return diff === 0
}

// Authorize the service-to-service caller (e.g. the tyne.web Vercel route) via a
// shared internal secret. No GitHub token or user profile is involved.
function isAuthorized(req: Request): boolean {
  const provided = req.headers.get('x-internal-secret')
  const expected = Deno.env.get('ATLASSIAN_REPORTING_SETUP_SECRET')
  if (!provided || !expected) { return false }
  return timingSafeEqual(provided, expected)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  // Shared Atlassian OAuth client credentials (same app as Jira OAuth).
  const clientId = Deno.env.get('JIRA_CLIENT_ID')
  // Admin reporting flow uses its own dedicated redirect URI. Never the Jira one,
  // and never a hard-coded fallback — a missing value is a configuration error.
  const redirectUri = Deno.env.get('ATLASSIAN_REPORTING_REDIRECT_URI')

  if (!supabaseUrl || !serviceRoleKey || !clientId || !redirectUri) {
    return jsonResponse({ error: 'Missing Atlassian report OAuth environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Persist a hashed, single-use, time-limited state for CSRF protection. The raw
  // state is only ever returned inside the authorization URL; only its hash is stored.
  const state = `${FLOW_ADMIN}:${randomUrlToken()}`
  const stateHash = await sha256Hex(state)
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString()
  const { error } = await supabase
    .from('atlassian_report_oauth_states')
    .insert({
      state_hash: stateHash,
      expires_at: expiresAt,
    })

  if (error) {
    // Log without the state hash, URL, or any secret material.
    console.error('Atlassian report OAuth state insert failed', {
      operation: 'insert_oauth_state',
      table: 'atlassian_report_oauth_states',
      code: error.code,
      message: error.message,
    })
    return jsonResponse({ error: 'State creation failed' }, 500)
  }

  const authUrl = new URL(ATLASSIAN_AUTH_URL)
  authUrl.searchParams.set('audience', ATLASSIAN_AUDIENCE)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('scope', ATLASSIAN_REPORT_SCOPES.join(' '))
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('prompt', 'consent')

  return jsonResponse({ url: authUrl.toString() })
})
