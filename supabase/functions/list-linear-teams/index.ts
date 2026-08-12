import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

type LinearConnection = {
  access_token_encrypted: string
  refresh_token_encrypted?: string | null
  expires_at?: string | null
  linear_workspace_id?: string | null
  linear_workspace_name?: string | null
}

async function linearGraphQL<T>(accessToken: string, query: string): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ query }),
  })
  const payload = await res.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null
  if (!res.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Linear request failed (${res.status})`)
  }
  return payload.data as T
}

async function refreshLinearConnectionIfNeeded(
  supabase: ReturnType<typeof createClient>,
  profileId: string,
  connection: LinearConnection,
): Promise<LinearConnection> {
  const expiresAt = connection.expires_at ? Date.parse(connection.expires_at) : 0
  if (!expiresAt || expiresAt > Date.now() + 60_000 || !connection.refresh_token_encrypted) {
    return connection
  }

  const clientId = Deno.env.get('LINEAR_CLIENT_ID')
  const clientSecret = Deno.env.get('LINEAR_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('Missing Linear refresh environment')
  }

  const tokenRes = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token_encrypted,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })
  if (!tokenRes.ok) {
    throw new Error('Linear token refresh failed')
  }

  const tokenPayload = await tokenRes.json() as Record<string, unknown>
  const accessToken = typeof tokenPayload.access_token === 'string' ? tokenPayload.access_token : ''
  const refreshToken = typeof tokenPayload.refresh_token === 'string' ? tokenPayload.refresh_token : connection.refresh_token_encrypted
  const expiresIn = Number(tokenPayload.expires_in || 0)
  if (!accessToken) {
    throw new Error('Incomplete Linear refresh response')
  }

  const next: LinearConnection = {
    ...connection,
    access_token_encrypted: accessToken,
    refresh_token_encrypted: refreshToken,
    expires_at: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : connection.expires_at,
  }

  const { error } = await supabase
    .from('linear_connections')
    .update({
      access_token_encrypted: next.access_token_encrypted,
      refresh_token_encrypted: next.refresh_token_encrypted,
      expires_at: next.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', profileId)
    .eq('linear_workspace_id', connection.linear_workspace_id ?? null)

  if (error) {
    throw error
  }

  return next
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') { return new Response('ok', { headers: corsHeaders }) }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) { return jsonResponse({ error: 'Missing Authorization header' }, 401) }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) { return jsonResponse({ error: 'Missing Supabase function environment' }, 500) }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const machineId = req.headers.get('X-Machine-ID')
  const resolved = await requireUserProfileId(supabase, authHeader, machineId)
  if ('error' in resolved) { return jsonResponse({ error: resolved.error }, resolved.status) }
  const profile = { id: resolved.id }

  const { data: connection } = await supabase
    .from('linear_connections')
    .select('access_token_encrypted, refresh_token_encrypted, expires_at, linear_workspace_id, linear_workspace_name')
    .eq('user_id', profile.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!connection) { return jsonResponse({ error: 'Linear connection not found' }, 404) }

  try {
    const freshConnection = await refreshLinearConnectionIfNeeded(supabase, profile.id, connection as LinearConnection)
    const payload = await linearGraphQL<{ teams: { nodes: Array<{ id: string; key?: string; name: string }> } }>(
      String(freshConnection.access_token_encrypted),
      `query TyneTeams { teams { nodes { id key name } } }`,
    )
    return jsonResponse({
      workspace_id: freshConnection.linear_workspace_id,
      workspace_name: freshConnection.linear_workspace_name,
      teams: payload.teams?.nodes || [],
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Failed to list teams' }, 502)
  }
})
