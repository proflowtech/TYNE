import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') { return new Response('ok', { headers: corsHeaders }) }
  if (req.method !== 'POST') { return jsonResponse({ error: 'Method not allowed' }, 405) }

  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) { return jsonResponse({ error: 'Missing Authorization header' }, 401) }

  const body = await req.json().catch(() => null) as { code?: unknown } | null
  const exchangeCode = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!exchangeCode) { return jsonResponse({ error: 'Missing exchange code' }, 400) }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) { return jsonResponse({ error: 'Missing Supabase function environment' }, 500) }
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const profile = await requireUserProfileId(supabase, authHeader, machineId)
  if ('error' in profile) {
    return jsonResponse({ error: profile.error }, profile.status)
  }

  const exchangeCodeHash = await sha256Hex(exchangeCode)
  const { data: exchange, error: exchangeError } = await supabase
    .from('linear_oauth_exchanges')
    .select('id, user_id, linear_connection_id, available_teams, expires_at, consumed_at')
    .eq('exchange_code_hash', exchangeCodeHash)
    .maybeSingle()
  if (exchangeError) {
    console.error('Linear OAuth exchange lookup failed:', exchangeError)
    return jsonResponse({ error: 'Exchange lookup failed' }, 500)
  }
  if (!exchange || exchange.user_id !== profile.id || exchange.consumed_at || new Date(exchange.expires_at).getTime() <= Date.now()) {
    return jsonResponse({ error: 'Invalid or expired exchange code' }, 400)
  }

  const { data: consumedExchange, error: consumeError } = await supabase
    .from('linear_oauth_exchanges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', exchange.id)
    .eq('user_id', profile.id)
    .is('consumed_at', null)
    .select('id, linear_connection_id')
    .maybeSingle()
  if (consumeError || !consumedExchange) {
    console.error('Linear OAuth exchange consume failed:', consumeError)
    return jsonResponse({ error: 'Exchange code already consumed' }, 400)
  }

  const { data: connection, error: connectionError } = await supabase
    .from('linear_connections')
    .select('expires_at, linear_workspace_id, linear_workspace_name, linear_user_id, linear_user_email, linear_user_name, created_at')
    .eq('id', consumedExchange.linear_connection_id)
    .eq('user_id', profile.id)
    .maybeSingle()
  if (connectionError) {
    console.error('Linear connection lookup failed:', connectionError)
    return jsonResponse({ error: 'Connection lookup failed' }, 500)
  }
  if (!connection) { return jsonResponse({ error: 'Linear connection not found' }, 404) }

  return jsonResponse({
    connected: true,
    expires_at: connection.expires_at,
    workspace_id: connection.linear_workspace_id,
    workspace_name: connection.linear_workspace_name,
    linear_user_id: connection.linear_user_id,
    linear_user_email: connection.linear_user_email,
    linear_user_name: connection.linear_user_name,
    available_teams: Array.isArray(exchange.available_teams) ? exchange.available_teams : [],
    connected_at: connection.created_at,
  })
})
