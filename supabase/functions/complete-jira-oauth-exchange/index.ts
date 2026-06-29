import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401)
  }

  const body = await req.json().catch(() => null) as { code?: unknown } | null
  const exchangeCode = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!exchangeCode) {
    return jsonResponse({ error: 'Missing exchange code' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
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
    const { data: blocked } = await supabase
      .from('hardware_blocklist')
      .select('machine_id')
      .eq('machine_id', machineId)
      .maybeSingle()

    if (blocked) {
      return jsonResponse({ error: 'Hardware ID is blocked' }, 403)
    }
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('github_id', githubId)
    .maybeSingle()

  if (profileError) {
    console.error('Jira OAuth exchange profile lookup failed:', profileError)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }

  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
  }

  const exchangeCodeHash = await sha256Hex(exchangeCode)
  const { data: exchange, error: exchangeError } = await supabase
    .from('jira_oauth_exchanges')
    .select('id, user_id, jira_connection_id, available_sites, expires_at, consumed_at')
    .eq('exchange_code_hash', exchangeCodeHash)
    .maybeSingle()

  if (exchangeError) {
    console.error('Jira OAuth exchange lookup failed:', exchangeError)
    return jsonResponse({ error: 'Exchange lookup failed' }, 500)
  }

  if (!exchange || exchange.user_id !== profile.id || exchange.consumed_at || new Date(exchange.expires_at).getTime() <= Date.now()) {
    return jsonResponse({ error: 'Invalid or expired exchange code' }, 400)
  }

  const { data: consumedExchange, error: consumeError } = await supabase
    .from('jira_oauth_exchanges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', exchange.id)
    .eq('user_id', profile.id)
    .is('consumed_at', null)
    .select('id, jira_connection_id')
    .maybeSingle()

  if (consumeError) {
    console.error('Jira OAuth exchange consume failed:', consumeError)
    return jsonResponse({ error: 'Exchange consume failed' }, 500)
  }

  if (!consumedExchange) {
    return jsonResponse({ error: 'Exchange code already consumed' }, 400)
  }

  const { data: connection, error: connectionError } = await supabase
    .from('jira_connections')
    .select('expires_at, cloud_id, site_name, site_url, account_email, account_name, created_at')
    .eq('id', consumedExchange.jira_connection_id)
    .eq('user_id', profile.id)
    .maybeSingle()

  if (connectionError) {
    console.error('Jira OAuth connection lookup failed:', connectionError)
    return jsonResponse({ error: 'Connection lookup failed' }, 500)
  }

  if (!connection) {
    return jsonResponse({ error: 'Jira connection not found' }, 404)
  }

  return jsonResponse({
    connected: true,
    expires_at: connection.expires_at,
    cloud_id: connection.cloud_id,
    site_name: connection.site_name,
    site_url: connection.site_url,
    available_sites: Array.isArray(exchange.available_sites) ? exchange.available_sites : [],
    account_email: connection.account_email,
    account_name: connection.account_name,
    connected_at: connection.created_at,
  })
})
