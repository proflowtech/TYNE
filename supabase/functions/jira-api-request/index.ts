import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'
import { sealToken, openToken } from '../_shared/oauthTokens.ts'
import { isEncrypted } from '../_shared/crypto.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type JiraConnection = {
  id: string
  user_id: string
  access_token: string | null
  refresh_token: string | null
  access_token_enc?: string | null
  refresh_token_enc?: string | null
  expires_at: string
  cloud_id: string
  // Decrypted working values, populated after loadTokens().
  _accessToken?: string
  _refreshToken?: string
}

// Reads the credential, preferring the sealed columns and tolerating legacy
// plaintext. Lazily seals any row not yet migrated, so the encrypted columns
// backfill themselves on first use.
async function loadTokens(
  supabase: ReturnType<typeof createClient<any>>,
  connection: JiraConnection,
): Promise<JiraConnection> {
  const accessToken = await openToken(connection.access_token_enc, connection.access_token)
  const refreshToken = await openToken(connection.refresh_token_enc, connection.refresh_token)
  // Seal whenever the encrypted column isn't already our ciphertext — covers a
  // null column (never sealed) and a legacy plaintext value alike.
  const unsealed = (accessToken && !isEncrypted(connection.access_token_enc)) ||
    (refreshToken && !isEncrypted(connection.refresh_token_enc))
  if (unsealed) {
    await supabase
      .from('jira_connections')
      .update({ access_token_enc: await sealToken(accessToken), refresh_token_enc: await sealToken(refreshToken) })
      .eq('id', connection.id)
      .eq('user_id', connection.user_id)
  }
  return { ...connection, _accessToken: accessToken, _refreshToken: refreshToken }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
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
      || pathname === '/rest/api/3/myself'
      || /^\/rest\/api\/3\/issue\/createmeta/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(pathname)
  }
  if (method === 'POST') {
    return pathname === '/rest/api/3/issue'
      || /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/worklog$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/transitions$/.test(pathname)
      || /^\/rest\/api\/3\/issue\/[^/]+\/attachments$/.test(pathname)
  }
  if (method === 'PUT') {
    return /^\/rest\/api\/3\/issue\/[^/]+$/.test(pathname)
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
      refresh_token: connection._refreshToken || '',
    }),
  })

  if (!tokenRes.ok) {
    throw new Error('Jira token refresh failed')
  }

  const payload = await tokenRes.json()
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : (connection._refreshToken || '')
  const expiresIn = Number(payload.expires_in || 0)
  if (!accessToken || !expiresIn) {
    throw new Error('Incomplete Jira refresh response')
  }

  const next: JiraConnection = {
    ...connection,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    _accessToken: accessToken,
    _refreshToken: refreshToken,
  }

  // Dual-write during the migration window: the sealed columns are
  // authoritative, but plaintext is kept populated until every reader is on the
  // sealed path and the plaintext columns are dropped.
  const { error } = await supabase
    .from('jira_connections')
    .update({
      access_token: accessToken,
      refresh_token: refreshToken,
      access_token_enc: await sealToken(accessToken),
      refresh_token_enc: await sealToken(refreshToken),
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
  const authHeader = req.headers.get('Authorization') || ''
  const machineId = req.headers.get('X-Machine-ID')
  const profile = await requireUserProfileId(supabase, authHeader, machineId)
  if ('error' in profile) {
    return jsonResponse({ error: profile.error }, profile.status)
  }

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
    .select('id, user_id, access_token, refresh_token, access_token_enc, refresh_token_enc, expires_at, cloud_id')
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
    const loaded = await loadTokens(supabase, connection as JiraConnection)
    freshConnection = await refreshConnectionIfNeeded(supabase, loaded)
  } catch (err) {
    console.error('Hosted Jira API token refresh failed:', err)
    return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
  }

  const attachment = body?.attachment && typeof body.attachment === 'object'
    ? body.attachment as Record<string, unknown>
    : null
  const attachName = typeof attachment?.filename === 'string' ? attachment.filename.replace(/[^\w.-]+/g, '_') : ''
  const attachB64 = typeof attachment?.contentBase64 === 'string' ? attachment.contentBase64 : ''
  const attachMime = typeof attachment?.mimeType === 'string' && attachment.mimeType.trim()
    ? attachment.mimeType.trim()
    : 'text/html'

  let jiraRes: Response
  if (attachName && attachB64 && method === 'POST' && path.endsWith('/attachments')) {
    if (attachB64.length > 1_400_000) {
      return jsonResponse({ error: 'Attachment too large' }, 413)
    }
    let bytes: Uint8Array
    try {
      const bin = atob(attachB64)
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    } catch {
      return jsonResponse({ error: 'Invalid attachment encoding' }, 400)
    }
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: attachMime }), attachName)
    jiraRes = await fetch(`https://api.atlassian.com/ex/jira/${freshConnection.cloud_id}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${freshConnection._accessToken || ''}`,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
    })
  } else {
    jiraRes = await fetch(`https://api.atlassian.com/ex/jira/${freshConnection.cloud_id}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${freshConnection._accessToken || ''}`,
        Accept: 'application/json',
        ...(method === 'POST' || method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: (method === 'POST' || method === 'PUT') && body?.body !== undefined ? JSON.stringify(body.body) : undefined,
    })
  }

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
