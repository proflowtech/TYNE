import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

type JiraConnection = {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  cloud_id: string
  site_name?: string | null
  site_url?: string | null
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function requireProfile(req: Request, supabase: ReturnType<typeof createClient>): Promise<{ id: string } | Response> {
  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401)
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

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('github_id', githubId)
    .maybeSingle()

  if (error) {
    console.error('Jira project profile lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }

  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
  }

  return { id: profile.id }
}

async function refreshConnectionIfNeeded(
  supabase: ReturnType<typeof createClient>,
  connection: JiraConnection,
): Promise<JiraConnection> {
  if (new Date(connection.expires_at).getTime() > Date.now() + 60_000) {
    return connection
  }

  const clientId = Deno.env.get('JIRA_CLIENT_ID')
  const clientSecret = Deno.env.get('JIRA_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('Missing Jira refresh environment')
  }

  const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
    }),
  })

  if (!tokenRes.ok) {
    throw new Error('Jira token refresh failed')
  }

  const payload = await tokenRes.json()
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : connection.refresh_token
  const expiresIn = Number(payload.expires_in || 0)
  if (!accessToken || !expiresIn) {
    throw new Error('Incomplete Jira refresh response')
  }

  const next = {
    ...connection,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }

  const { error } = await supabase
    .from('jira_connections')
    .update({
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)
    .eq('user_id', connection.user_id)

  if (error) {
    throw error
  }

  return next
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Supabase function environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const profile = await requireProfile(req, supabase)
  if (profile instanceof Response) { return profile }

  const url = new URL(req.url)
  const requestedCloudId = url.searchParams.get('cloud_id')?.trim()
  let connectionQuery = supabase
    .from('jira_connections')
    .select('id, user_id, access_token, refresh_token, expires_at, cloud_id, site_name, site_url')
    .eq('user_id', profile.id)
  if (requestedCloudId) {
    connectionQuery = connectionQuery.eq('cloud_id', requestedCloudId)
  }
  const { data: connection, error } = await connectionQuery.maybeSingle()

  if (error) {
    console.error('Jira connection lookup failed:', error)
    return jsonResponse({ error: 'Jira connection lookup failed' }, 500)
  }

  if (!connection) {
    return jsonResponse({ error: 'Jira connection not found' }, 404)
  }

  let freshConnection: JiraConnection
  try {
    freshConnection = await refreshConnectionIfNeeded(supabase, connection as JiraConnection)
  } catch (err) {
    console.error('Jira project token refresh failed:', err)
    return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
  }

  const projects: unknown[] = []
  let startAt = 0
  let total = 0
  do {
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: '50',
      orderBy: 'key',
    })
    const res = await fetch(`https://api.atlassian.com/ex/jira/${freshConnection.cloud_id}/rest/api/3/project/search?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${freshConnection.access_token}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const message = await res.text().catch(() => '')
      return jsonResponse({ error: 'Jira project search failed', detail: message.slice(0, 200) }, 502)
    }

    const payload = await res.json()
    const values = Array.isArray(payload.values) ? payload.values : []
    total = Number(payload.total || values.length)
    startAt = Number(payload.startAt || startAt) + values.length
    projects.push(...values.map((project: Record<string, unknown>) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      avatarUrls: project.avatarUrls,
      style: project.style,
      simplified: project.simplified,
      cloud_id: freshConnection.cloud_id,
      site_name: freshConnection.site_name,
      site_url: freshConnection.site_url,
    })))
  } while (projects.length < total && startAt < total)

  return jsonResponse({
    cloud_id: freshConnection.cloud_id,
    site_name: freshConnection.site_name,
    site_url: freshConnection.site_url,
    projects,
  })
})
