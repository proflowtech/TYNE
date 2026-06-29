import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type JiraConnection = {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  cloud_id: string
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function requireProfile(req: Request, supabase: ReturnType<typeof createClient<any>>): Promise<{ id: string } | Response> {
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
    console.error('Hosted Jira API profile lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }

  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
  }

  return { id: profile.id }
}

function normalizePath(path: unknown): string {
  if (typeof path !== 'string') { return '' }
  const trimmed = path.trim()
  if (!trimmed.startsWith('/rest/api/3/')) { return '' }
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes('..')) { return '' }
  return trimmed
}

function isAllowedJiraPath(method: string, path: string): boolean {
  const url = new URL(`https://tyne.local${path}`)
  const pathname = url.pathname
  if (method === 'GET') {
    return pathname === '/rest/api/3/search/jql'
      || /^\/rest\/api\/3\/issue\/[^/]+$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(pathname)
  }
  if (method === 'POST') {
    return /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/worklog$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(pathname)
  }
  return false
}

function getBlockedRequestReason(method: string, path: string, cloudId: string): string {
  if (!cloudId) { return 'missing cloud_id' }
  if (!path) { return 'invalid path' }
  if (!method) { return 'missing method' }
  return 'path or method is not allowlisted'
}

async function refreshConnectionIfNeeded(
  supabase: ReturnType<typeof createClient<any>>,
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

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Supabase function environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const profile = await requireProfile(req, supabase)
  if (profile instanceof Response) { return profile }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  const method = typeof body?.method === 'string' ? body.method.toUpperCase() : ''
  const path = normalizePath(body?.path)
  const cloudId = typeof body?.cloud_id === 'string' ? body.cloud_id.trim() : ''
  const expectJson = body?.expect_json !== false

  if (!cloudId || !path || !isAllowedJiraPath(method, path)) {
    console.warn('Hosted Jira API request blocked:', {
      method: method || 'missing',
      path: path || 'invalid',
      reason: getBlockedRequestReason(method, path, cloudId),
    })
    return jsonResponse({ error: 'Jira request is not allowed' }, 400)
  }

  const { data: connection, error } = await supabase
    .from('jira_connections')
    .select('id, user_id, access_token, refresh_token, expires_at, cloud_id')
    .eq('user_id', profile.id)
    .eq('cloud_id', cloudId)
    .maybeSingle()

  if (error) {
    console.error('Hosted Jira API connection lookup failed:', error)
    return jsonResponse({ error: 'Jira connection lookup failed' }, 500)
  }

  if (!connection) {
    return jsonResponse({ error: 'Jira connection not found' }, 404)
  }

  let freshConnection: JiraConnection
  try {
    freshConnection = await refreshConnectionIfNeeded(supabase, connection as JiraConnection)
  } catch (err) {
    console.error('Hosted Jira API token refresh failed:', err)
    return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
  }

  const jiraRes = await fetch(`https://api.atlassian.com/ex/jira/${freshConnection.cloud_id}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${freshConnection.access_token}`,
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' && body?.body !== undefined ? JSON.stringify(body.body) : undefined,
  })

  if (!jiraRes.ok) {
    const message = await jiraRes.text().catch(() => '')
    return jsonResponse({ error: 'Jira API request failed', detail: message.slice(0, 200) }, jiraRes.status)
  }

  if (!expectJson || jiraRes.status === 204) {
    return jsonResponse({ ok: true })
  }

  const payload = await jiraRes.json().catch(() => null)
  return jsonResponse((payload && typeof payload === 'object' ? payload : { ok: true }) as Record<string, unknown>)
})
