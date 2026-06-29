import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STATE_TTL_MS = 5 * 60 * 1000
const LINEAR_AUTH_URL = 'https://linear.app/oauth/authorize'
const FLOW_NORMAL = 'normal_user_linear_connect'
const LINEAR_SCOPES = ['read', 'write']

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
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!clientId || !redirectUri || !supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Supabase function environment' }, 500)
  }

  const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': 'Tyne-Backend',
    },
  })
  if (!ghUserRes.ok) {
    return jsonResponse({ error: 'Invalid GitHub token' }, 401)
  }

  const ghUser = await ghUserRes.json()
  const githubId = String(ghUser.id)
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  if (machineId) {
    const { data: blocked } = await supabase.from('hardware_blocklist').select('machine_id').eq('machine_id', machineId).maybeSingle()
    if (blocked) { return jsonResponse({ error: 'Hardware ID is blocked' }, 403) }
  }

  const { data: profile, error } = await supabase.from('user_profiles').select('id').eq('github_id', githubId).maybeSingle()
  if (error) {
    console.error('Linear OAuth state lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }
  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
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
  authUrl.searchParams.set('scope', LINEAR_SCOPES.join(' '))
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('response_type', 'code')

  return jsonResponse({ state, auth_url: authUrl.toString(), expires_at: expiresAt })
})
