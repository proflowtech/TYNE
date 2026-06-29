import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

async function linearGraphQL<T>(accessToken: string, query: string): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': accessToken },
    body: JSON.stringify({ query }),
  })
  const payload = await res.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null
  if (!res.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Linear request failed (${res.status})`)
  }
  return payload.data as T
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') { return new Response('ok', { headers: corsHeaders }) }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) { return jsonResponse({ error: 'Missing Authorization header' }, 401) }
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) { return jsonResponse({ error: 'Missing Supabase function environment' }, 500) }

  const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/json', 'User-Agent': 'Tyne-Backend' },
  })
  if (!ghUserRes.ok) { return jsonResponse({ error: 'Invalid GitHub token' }, 401) }
  const ghUser = await ghUserRes.json()
  const { data: profile } = await supabase.from('user_profiles').select('id').eq('github_id', String(ghUser.id)).maybeSingle()
  if (!profile?.id) { return jsonResponse({ error: 'User profile not found' }, 404) }

  const { data: connection } = await supabase
    .from('linear_connections')
    .select('access_token_encrypted, linear_workspace_id, linear_workspace_name')
    .eq('user_id', profile.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!connection) { return jsonResponse({ error: 'Linear connection not found' }, 404) }

  try {
    const payload = await linearGraphQL<{ teams: { nodes: Array<{ id: string; key?: string; name: string }> } }>(
      String(connection.access_token_encrypted),
      `query TyneTeams { teams { nodes { id key name } } }`,
    )
    return jsonResponse({
      workspace_id: connection.linear_workspace_id,
      workspace_name: connection.linear_workspace_name,
      teams: payload.teams?.nodes || [],
    })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Failed to list teams' }, 502)
  }
})
