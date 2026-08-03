import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PROVIDER_TIMEOUT_MS = 15_000

type Reporter = {
  id: string
  email: string | null
  githubUsername: string | null
  githubId: string | null
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

function normalizeEmail(raw: unknown): string | null {
  const email = String(raw || '').trim().toLowerCase()
  if (!email || email.length > 320) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return email
}

async function requireReporter(req: Request, supabase: any, token: string): Promise<Reporter | Response> {
  const { data: { user: sbUser }, error: sbErr } = await supabase.auth.getUser(token)
  if (sbUser && !sbErr) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, github_username, github_id')
      .eq('id', sbUser.id)
      .maybeSingle()
    if (profile?.id) {
      return {
        id: profile.id as string,
        email: normalizeEmail(profile.email) || normalizeEmail(sbUser.email),
        githubUsername: typeof profile.github_username === 'string' ? profile.github_username : null,
        githubId: typeof profile.github_id === 'string' ? profile.github_id : null,
      }
    }
  }

  const ghUserRes = await fetchWithTimeout('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Tyne-Backend' },
  }, PROVIDER_TIMEOUT_MS)
  if (!ghUserRes.ok) return jsonResponse({ error: 'Invalid token or session' }, 401)
  const ghUser = await ghUserRes.json() as { id?: number | string; login?: string; email?: string }

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, email, github_username, github_id')
    .eq('github_id', String(ghUser.id))
    .maybeSingle()
  if (error) return jsonResponse({ error: 'Profile lookup failed' }, 500)
  if (!profile?.id) return jsonResponse({ error: 'User profile not found' }, 404)

  let email = normalizeEmail(profile.email) || normalizeEmail(ghUser.email)
  if (!email) {
    // Prefer primary/verified GitHub emails when profile email is empty.
    const emailsRes = await fetchWithTimeout('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Tyne-Backend' },
    }, PROVIDER_TIMEOUT_MS)
    if (emailsRes.ok) {
      const emails = await emailsRes.json().catch(() => []) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0]
      email = normalizeEmail(primary?.email)
    }
  }

  return {
    id: profile.id as string,
    email,
    githubUsername: (typeof profile.github_username === 'string' ? profile.github_username : null)
      || (typeof ghUser.login === 'string' ? ghUser.login : null),
    githubId: (typeof profile.github_id === 'string' ? profile.github_id : null) || String(ghUser.id || ''),
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) return jsonResponse({ error: 'Missing Supabase configuration' }, 500)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401)
    const token = authHeader.replace(/^bearer\s+/i, '').trim()

    const reporter = await requireReporter(req, supabase, token)
    if (reporter instanceof Response) return reporter

    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return jsonResponse({ error: 'Invalid body' }, 400)

    const message = String(body.message || '').trim()
    if (message.length < 3) return jsonResponse({ error: 'Message is too short' }, 400)
    if (message.length > 4000) return jsonResponse({ error: 'Message is too long' }, 400)

    const kindRaw = String(body.kind || 'bug')
    const kind = ['bug', 'confusing', 'idea'].includes(kindRaw) ? kindRaw : 'bug'
    const machineId = req.headers.get('X-Machine-ID') || (typeof body.machineId === 'string' ? body.machineId : null)

    const userEmail = normalizeEmail(body.email) || reporter.email
    if (!userEmail) {
      return jsonResponse({ error: 'Email is required so we can follow up on this report.' }, 400)
    }

    const githubUsername = (typeof body.githubUsername === 'string' && body.githubUsername.trim())
      ? body.githubUsername.trim().slice(0, 80)
      : reporter.githubUsername
    const githubId = (typeof body.githubId === 'string' && body.githubId.trim())
      ? body.githubId.trim().slice(0, 80)
      : reporter.githubId

    const insert = {
      user_id: reporter.id,
      user_email: userEmail,
      github_username: githubUsername,
      github_id: githubId,
      kind,
      message,
      page: typeof body.page === 'string' ? body.page.slice(0, 80) : null,
      task_id: typeof body.taskId === 'string' ? body.taskId.slice(0, 120) : null,
      task_title: typeof body.taskTitle === 'string' ? body.taskTitle.slice(0, 240) : null,
      extension_version: typeof body.extensionVersion === 'string' ? body.extensionVersion.slice(0, 40) : null,
      vscode_version: typeof body.vscodeVersion === 'string' ? body.vscodeVersion.slice(0, 40) : null,
      os: typeof body.os === 'string' ? body.os.slice(0, 80) : null,
      machine_id: machineId ? String(machineId).slice(0, 120) : null,
      client_meta: body.clientMeta && typeof body.clientMeta === 'object' ? body.clientMeta : {},
      status: 'new',
    }

    const { data, error } = await supabase.from('beta_bug_reports').insert(insert).select('id, created_at, user_email').single()
    if (error) {
      console.error('beta_bug_reports insert failed:', error)
      return jsonResponse({ error: 'Could not save bug report' }, 500)
    }

    return jsonResponse({ ok: true, id: data.id, createdAt: data.created_at, email: data.user_email })
  } catch (err: unknown) {
    console.error('tyne-beta-bug error:', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
