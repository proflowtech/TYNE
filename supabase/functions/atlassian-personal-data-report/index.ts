import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type JiraConnectionReportRow = {
  id: string
  atlassian_account_id: string
  atlassian_personal_data_updated_at: string | null
}

type AtlassianReportAccount = {
  accountId?: string
  account_id?: string
  status?: string
}

type AtlassianReportCredential = {
  id: string
  access_token: string
  refresh_token: string
  expires_at: string
}

type SupabaseAdminClient = ReturnType<typeof createClient<any>>

const MAX_BATCH_SIZE = 90

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

function isAuthorized(req: Request): boolean {
  const provided = req.headers.get('x-internal-secret')
  const expected = Deno.env.get('ATLASSIAN_REPORTING_SETUP_SECRET')
  if (!provided || !expected) { return false }
  return timingSafeEqual(provided, expected)
}

function nextReportAtFromHeaders(headers: Headers): string {
  const retryAfter = Number(headers.get('Retry-After') || 0)
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString()
  }

  const cyclePeriod = Number(headers.get('Cycle-Period') || 0)
  if (Number.isFinite(cyclePeriod) && cyclePeriod > 0) {
    return new Date(Date.now() + cyclePeriod * 1000).toISOString()
  }

  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}

async function erasePersonalData(supabase: SupabaseAdminClient, accountId: string): Promise<void> {
  const { error } = await supabase
    .from('jira_connections')
    .update({
      access_token: '',
      refresh_token: '',
      account_email: null,
      account_name: null,
      personal_data_reporting_status: 'closed',
      personal_data_erased_at: new Date().toISOString(),
      personal_data_report_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('atlassian_account_id', accountId)

  if (error) {
    throw error
  }
}

async function refreshReportCredentialIfNeeded(
  supabase: SupabaseAdminClient,
  credential: AtlassianReportCredential,
): Promise<AtlassianReportCredential> {
  if (new Date(credential.expires_at).getTime() > Date.now() + 60_000) {
    return credential
  }

  const clientId = Deno.env.get('JIRA_CLIENT_ID')
  const clientSecret = Deno.env.get('JIRA_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('Missing Atlassian report refresh environment')
  }

  const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: credential.refresh_token,
    }),
  })

  if (!tokenRes.ok) {
    throw new Error('Atlassian report token refresh failed')
  }

  const payload = await tokenRes.json()
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : credential.refresh_token
  const expiresIn = Number(payload.expires_in || 0)
  if (!accessToken || !expiresIn) {
    throw new Error('Incomplete Atlassian report refresh response')
  }

  const next = {
    ...credential,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }

  const { error } = await supabase
    .from('atlassian_report_credentials')
    .update({
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', credential.id)

  if (error) {
    throw error
  }

  return next
}

async function getReportAccessToken(supabase: SupabaseAdminClient): Promise<string> {
  const { data: credential, error } = await supabase
    .from('atlassian_report_credentials')
    .select('id, access_token, refresh_token, expires_at')
    .eq('provider', 'atlassian_personal_data_reporting')
    .maybeSingle()

  if (error) {
    throw error
  }

  if (credential) {
    const fresh = await refreshReportCredentialIfNeeded(supabase, credential as AtlassianReportCredential)
    return fresh.access_token
  }

  const fallback = Deno.env.get('ATLASSIAN_PERSONAL_DATA_REPORT_TOKEN')
  if (fallback) {
    return fallback
  }

  throw new Error('Missing Atlassian personal data report token')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  if (!Deno.env.get('ATLASSIAN_REPORTING_SETUP_SECRET')) {
    return jsonResponse({ error: 'Missing Atlassian personal data report auth environment' }, 500)
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const url = new URL(req.url)
  const dryRun = body.dry_run === true
    || body.dryRun === true
    || body.dry_run === 'true'
    || body.dryRun === 'true'
    || url.searchParams.get('dry_run') === 'true'
    || url.searchParams.get('dryRun') === 'true'

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'Missing Atlassian personal data report environment' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const now = new Date().toISOString()
  const { data: rows, error } = await supabase
    .from('jira_connections')
    .select('id, atlassian_account_id, atlassian_personal_data_updated_at')
    .not('atlassian_account_id', 'is', null)
    .or(`personal_data_next_report_at.is.null,personal_data_next_report_at.lte.${now}`)
    .limit(MAX_BATCH_SIZE)

  if (error) {
    console.error('Atlassian personal data report lookup failed:', error)
    return jsonResponse({ error: 'Report lookup failed' }, 500)
  }

  const batch = (rows || []) as JiraConnectionReportRow[]
  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      eligible_accounts: batch.length,
      max_batch_size: MAX_BATCH_SIZE,
      would_report: batch.length,
      token_source: 'server-side',
    })
  }

  if (batch.length === 0) {
    return jsonResponse({ reported: 0, closed: 0, updated: 0 })
  }

  let reportToken = ''
  try {
    reportToken = await getReportAccessToken(supabase)
  } catch (err) {
    console.error('Atlassian personal data report credential unavailable:', err)
    return jsonResponse({ error: 'Missing Atlassian personal data report token' }, 500)
  }

  const response = await fetch('https://api.atlassian.com/app/report-accounts/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${reportToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accounts: batch.map((row) => ({
        accountId: row.atlassian_account_id,
        updatedAt: row.atlassian_personal_data_updated_at || now,
      })),
    }),
  })

  const nextReportAt = nextReportAtFromHeaders(response.headers)
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    await supabase
      .from('jira_connections')
      .update({
        personal_data_reporting_status: response.status === 429 ? 'rate_limited' : 'error',
        personal_data_next_report_at: nextReportAt,
        personal_data_report_error: message.slice(0, 500) || `HTTP ${response.status}`,
      })
      .in('id', batch.map((row) => row.id))

    return jsonResponse({ error: 'Atlassian report failed', retry_at: nextReportAt }, response.status === 429 ? 429 : 502)
  }

  const payload = await response.json().catch(() => ({})) as { accounts?: AtlassianReportAccount[] }
  const accountStatuses = Array.isArray(payload.accounts) ? payload.accounts : []
  let closed = 0
  let updated = 0

  for (const result of accountStatuses) {
    const accountId = result.accountId || result.account_id
    const status = String(result.status || '').toLowerCase()
    if (!accountId) { continue }

    if (status === 'closed') {
      await erasePersonalData(supabase, accountId)
      closed += 1
      continue
    }

    if (status === 'updated') {
      const { error: updateError } = await supabase
        .from('jira_connections')
        .update({
          personal_data_reporting_status: 'updated',
          personal_data_next_report_at: nextReportAt,
          personal_data_report_error: null,
        })
        .eq('atlassian_account_id', accountId)

      if (updateError) {
        throw updateError
      }
      updated += 1
    }
  }

  await supabase
    .from('jira_connections')
    .update({
      personal_data_last_reported_at: now,
      personal_data_next_report_at: nextReportAt,
      personal_data_reporting_status: 'reported',
      personal_data_report_error: null,
    })
    .in('id', batch.map((row) => row.id))
    .is('personal_data_erased_at', null)

  return jsonResponse({ reported: batch.length, closed, updated, next_report_at: nextReportAt })
})
