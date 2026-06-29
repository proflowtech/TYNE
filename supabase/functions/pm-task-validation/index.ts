import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secret/i,
  /token/i,
  /password/i,
  /private/i,
  /supabase_service_role/i,
  /anthropic_key/i,
  /openai_key/i,
]

const IGNORED_FILE_PATTERNS = [
  /node_modules\//i,
  /\.git\//i,
  /\.vscode\//i,
  /dist\//i,
  /out\//i,
  /build\//i,
  /\.DS_Store$/i,
  /\.log$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
]

type ValidationResult = {
  status: 'pass' | 'partial' | 'fail'
  matchPercent?: number
  summary: string
  passedCriteria: string[]
  failedCriteria: Array<{ criterion: string; reason: string }>
  missingWork: string[]
  generatedProofPoints: string[]
  recommendedNextActions: string[]
  modelProvider: string
  modelName: string
}

type JiraConnection = {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  cloud_id: string
}

type PmTaskContext = {
  jira_cloud_id: string
  jira_issue_key: string
  repository_id: string | null
  goal: string | null
  subtasks: Array<{ title: string; description: string }>
  acceptance_criteria: string[]
  proof_point_templates: string[]
  validation_steps: string[]
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
    console.error('PM task validation profile lookup failed:', error)
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

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(p => p.test(path))
}

function isIgnoredPath(path: string): boolean {
  return IGNORED_FILE_PATTERNS.some(p => p.test(path))
}

function sanitizeDiff(diff: string, changedFiles: string[]): { diffText: string; changedFiles: string[] } {
  const safeFiles = changedFiles.filter(p => !isSensitivePath(p) && !isIgnoredPath(p))
  const lines = diff.split('\n')
  let currentFile: string | null = null
  let keepFile = true
  const output: string[] = []

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.*?) b\/(.*?)$/)
    if (fileMatch) {
      currentFile = fileMatch[1]
      keepFile = !isSensitivePath(currentFile) && !isIgnoredPath(currentFile)
      if (keepFile) {
        output.push(line)
      }
      continue
    }
    if (keepFile) {
      output.push(line)
    }
  }

  return { diffText: output.join('\n'), changedFiles: safeFiles }
}

function readEnvSecret(name: string): string | null {
  const value = Deno.env.get(name)?.replace(/\s+/g, '')
  return value ? value : null
}

function normalizeTier(rawTier: string): 'free' | 'pro' | 'max' {
  const tier = rawTier.toLowerCase()
  if (tier === 'pro') return 'pro'
  if (tier === 'max') return 'max'
  return 'free'
}

type ManagedLlmConfig =
  | { provider: 'openai'; apiKey: string; baseUrl: string; model: string }
  | { provider: 'anthropic'; apiKey: string; model: string }

// Prioritized model chain per tier. The gateway has a custom catalog, so any slug
// can be unavailable (404 "No endpoints found"). We try stronger models first and
// fall through to proven ones, so an unavailable slug never hard-fails validation.
// The last entry of every chain MUST be a slug already proven on the gateway.
function selectValidationModels(tier: string): string[] {
  switch (normalizeTier(tier)) {
    case 'pro':
    case 'max':
      return [
        'anthropic/claude-haiku-4.5',   // primary (Claude Haiku 4.5)
        'anthropic/claude-sonnet-4.5',  // Claude Sonnet fallback (more capable)
        'google/gemini-2.5-pro',        // Gemini Pro
        'mistralai/mistral-large',      // Mistral
        'moonshotai/kimi-k2',           // Kimi (Moonshot)
        'google/gemini-2.5-flash',      // proven fallback
        'deepseek/deepseek-v4-pro',     // proven final fallback
      ]
    case 'free':
    default:
      return [
        'deepseek/deepseek-v4-pro',   // proven
        'google/gemini-2.5-flash',    // proven fallback
      ]
  }
}

// Extract the HTTP status from a "LLM request failed (NNN): ..." error message.
function statusFromLlmError(message: string): number {
  const match = message.match(/\((\d{3})\)/)
  return match ? Number(match[1]) : 0
}

// Only fall through to the next model for "this model is unavailable / transient"
// failures. Auth/quota (401/403/429) and bad-request (400) errors will repeat on
// every model, so fail fast on those instead of burning the whole chain.
function shouldTryNextModel(message: string): boolean {
  const status = statusFromLlmError(message)
  if (status === 404 || status === 502 || status === 503) { return true }
  if (status >= 500) { return true }
  if (status === 0 && /No endpoints found|not found|model/i.test(message)) { return true }
  return false
}

function resolveManagedLlmConfig(model: string): ManagedLlmConfig | null {
  const aiCreditsKey = readEnvSecret('AICREDITS_API_KEY')
  if (!aiCreditsKey) {
    return null
  }
  return {
    provider: 'openai',
    apiKey: aiCreditsKey,
    baseUrl: Deno.env.get('AICREDITS_BASE_URL') || 'https://api.aicredits.in/v1',
    model,
  }
}

async function callLlm(config: ManagedLlmConfig, prompt: string, temperature = 0.2): Promise<string> {
  if (config.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { content: Array<{ type: string; text: string }> }
    return data.content?.find(c => c.type === 'text')?.text || ''
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content || ''
}

function cleanJsonText(raw: string): string {
  return raw.replace(/```json\s*|\s*```/g, '').trim()
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
}

function toFailedCriteriaArray(value: unknown): Array<{ criterion: string; reason: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map(v => {
      if (!v || typeof v !== 'object') return null
      const r = v as Record<string, unknown>
      const criterion = typeof r.criterion === 'string' ? r.criterion.trim() : ''
      const reason = typeof r.reason === 'string' ? r.reason.trim() : ''
      if (!criterion) return null
      return { criterion, reason }
    })
    .filter((v): v is { criterion: string; reason: string } => Boolean(v))
}

function buildValidationPrompt(
  taskContext: PmTaskContext,
  branchName: string,
  changedFiles: string[],
  diffText: string,
  tier: string,
): string {
  const isMax = normalizeTier(tier) === 'max'
  const depthNote = isMax
    ? 'Perform a deep validation using the task context, code diff, and project conventions. Look for edge cases, security issues, and test coverage.'
    : 'Validate the implementation against the acceptance criteria and goal.'

  return `You are a senior code reviewer. Validate whether the code changes below satisfy the Jira task.

${depthNote}

Task: ${taskContext.jira_issue_key}
Goal: ${taskContext.goal || 'Not provided'}

Subtasks:
${taskContext.subtasks.map(s => `- ${s.title}: ${s.description}`).join('\n') || 'None'}

Acceptance Criteria:
${taskContext.acceptance_criteria.map(c => `- ${c}`).join('\n') || 'None'}

Proof Point Templates:
${taskContext.proof_point_templates.map(p => `- ${p}`).join('\n') || 'None'}

Validation Steps:
${taskContext.validation_steps.map(v => `- ${v}`).join('\n') || 'None'}

Branch: ${branchName}
Changed Files:
${changedFiles.join('\n') || 'None'}

Git Diff:
\`\`\`
${diffText}
\`\`\`

Return strictly JSON with this schema:
{
  "status": "pass" | "partial" | "fail",
  "matchPercent": 0-100,
  "summary": "one sentence result",
  "passedCriteria": ["criterion text"],
  "failedCriteria": [{ "criterion": "criterion text", "reason": "why it failed" }],
  "missingWork": ["what is missing"],
  "generatedProofPoints": ["evidence that acceptance criteria were satisfied"],
  "recommendedNextActions": ["recommended next step"]
}

Respond with only the JSON object. Do not wrap it in markdown code fences.`
}

function sanitizeValidationResult(raw: unknown, provider: string, model: string): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'partial',
      summary: 'Validation returned an unparseable response.',
      passedCriteria: [],
      failedCriteria: [],
      missingWork: [],
      generatedProofPoints: [],
      recommendedNextActions: ['Re-run validation.'],
      modelProvider: provider,
      modelName: model,
    }
  }
  const r = raw as Record<string, unknown>
  const status = typeof r.status === 'string' && ['pass', 'partial', 'fail'].includes(r.status.toLowerCase())
    ? (r.status.toLowerCase() as 'pass' | 'partial' | 'fail')
    : 'partial'
  const matchPercentRaw = typeof r.matchPercent === 'number' ? r.matchPercent : Number(r.matchPercent)
  const matchPercent = Number.isNaN(matchPercentRaw) ? undefined : Math.max(0, Math.min(100, Math.round(matchPercentRaw)))
  return {
    status,
    matchPercent,
    summary: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : 'Validation completed.',
    passedCriteria: toStringArray(r.passedCriteria),
    failedCriteria: toFailedCriteriaArray(r.failedCriteria),
    missingWork: toStringArray(r.missingWork),
    generatedProofPoints: toStringArray(r.generatedProofPoints),
    recommendedNextActions: toStringArray(r.recommendedNextActions),
    modelProvider: provider,
    modelName: model,
  }
}

async function validateTask(
  taskContext: PmTaskContext,
  branchName: string,
  changedFiles: string[],
  diffText: string,
  tier: string,
): Promise<ValidationResult> {
  if (!readEnvSecret('AICREDITS_API_KEY')) {
    throw new Error('LLM configuration key is missing')
  }

  const prompt = buildValidationPrompt(taskContext, branchName, changedFiles, diffText, tier)
  const models = selectValidationModels(tier)
  let lastError: unknown = null

  for (let i = 0; i < models.length; i++) {
    const config = resolveManagedLlmConfig(models[i])
    if (!config) { throw new Error('LLM configuration key is missing') }
    try {
      const rawText = cleanJsonText(await callLlm(config, prompt, 0.2))
      const parsed = safeJsonParse<Record<string, unknown>>(rawText)
      return sanitizeValidationResult(parsed || rawText, config.provider, config.model)
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const isLast = i === models.length - 1
      // Fall through to the next model only for availability/transient failures.
      if (isLast || !shouldTryNextModel(message)) { throw err }
      console.warn(`PM task validation: model "${models[i]}" unavailable (${message.slice(0, 120)}); trying "${models[i + 1]}"`)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All validation models failed')
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
  const jiraIssueKey = typeof body?.jiraIssueKey === 'string' ? body.jiraIssueKey.trim().toUpperCase() : ''
  const cloudId = typeof body?.cloudId === 'string' ? body.cloudId.trim() : ''
  const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : null
  const tier = typeof body?.tier === 'string' ? body.tier : 'free'
  const currentBranch = typeof body?.currentBranch === 'string' ? body.currentBranch : ''
  const rawDiff = typeof body?.diff === 'string' ? body.diff : ''
  const rawChangedFiles = Array.isArray(body?.changedFiles) ? body.changedFiles : []
  const goalOverride = typeof body?.goal === 'string' ? body.goal : null
  const acceptanceCriteriaOverride = Array.isArray(body?.acceptanceCriteria) ? body.acceptanceCriteria : null
  const subtasksOverride = Array.isArray(body?.subtasks) ? body.subtasks : null
  const proofPointTemplatesOverride = Array.isArray(body?.proofPointTemplates) ? body.proofPointTemplates : null
  const validationStepsOverride = Array.isArray(body?.validationSteps) ? body.validationSteps : null

  if (!jiraIssueKey || !cloudId) {
    return jsonResponse({ error: 'Missing jiraIssueKey or cloudId' }, 400)
  }

  let taskContext: PmTaskContext | null = null

  // Try to load stored PM task context.
  const { data: storedContext } = await supabase
    .from('tyne_pm_task_contexts')
    .select('jira_cloud_id, jira_issue_key, repository_id, goal, subtasks, acceptance_criteria, proof_point_templates, validation_steps')
    .eq('user_id', profile.id)
    .eq('jira_cloud_id', cloudId)
    .eq('jira_issue_key', jiraIssueKey)
    .eq('repository_id', repositoryId)
    .maybeSingle()

  if (storedContext) {
    taskContext = {
      jira_cloud_id: storedContext.jira_cloud_id,
      jira_issue_key: storedContext.jira_issue_key,
      repository_id: storedContext.repository_id,
      goal: goalOverride ?? storedContext.goal,
      subtasks: Array.isArray(storedContext.subtasks)
        ? storedContext.subtasks.map((s: any) => ({ title: String(s.title || ''), description: String(s.description || '') })).filter((s: any) => s.title)
        : [],
      acceptance_criteria: acceptanceCriteriaOverride ?? toStringArray(storedContext.acceptance_criteria),
      proof_point_templates: proofPointTemplatesOverride ?? toStringArray(storedContext.proof_point_templates),
      validation_steps: validationStepsOverride ?? toStringArray(storedContext.validation_steps),
    }
  }

  // Fallback: fetch the Jira issue directly and build minimal context.
  if (!taskContext) {
    const { data: connection, error } = await supabase
      .from('jira_connections')
      .select('id, user_id, access_token, refresh_token, expires_at, cloud_id')
      .eq('user_id', profile.id)
      .eq('cloud_id', cloudId)
      .maybeSingle()

    if (error) {
      console.error('PM task validation Jira connection lookup failed:', error)
      return jsonResponse({ error: 'Jira connection lookup failed' }, 500)
    }

    if (!connection) {
      return jsonResponse({ error: 'Jira connection not found' }, 404)
    }

    let freshConnection: JiraConnection
    try {
      freshConnection = await refreshConnectionIfNeeded(supabase, connection as JiraConnection)
    } catch (err) {
      console.error('PM task validation token refresh failed:', err)
      return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
    }

    const issue = await (await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(jiraIssueKey)}?fields=summary,description,status,issuetype,priority,assignee,project,labels,parent,subtasks`, {
      headers: {
        Authorization: `Bearer ${freshConnection.access_token}`,
        Accept: 'application/json',
      },
    })).json() as Record<string, unknown>
    const fields = issue.fields as Record<string, unknown>
    const description = fields?.description as any
    const descriptionText = description ? (typeof description === 'string' ? description : '') : ''
    const acceptanceCriteria = extractAcceptanceCriteria(descriptionText)

    taskContext = {
      jira_cloud_id: cloudId,
      jira_issue_key: jiraIssueKey,
      repository_id: repositoryId,
      goal: goalOverride ?? String(fields?.summary || ''),
      subtasks: subtasksOverride ?? [],
      acceptance_criteria: acceptanceCriteriaOverride ?? acceptanceCriteria,
      proof_point_templates: proofPointTemplatesOverride ?? [],
      validation_steps: validationStepsOverride ?? ['Check changed files', 'Check implementation against acceptance criteria', 'Run tests if available'],
    }
  }

  const { diffText, changedFiles } = sanitizeDiff(rawDiff, rawChangedFiles.map(String))
  if (!diffText.trim() && changedFiles.length === 0) {
    return jsonResponse({ error: 'No code changes found to validate' }, 400)
  }

  try {
    const result = await validateTask(taskContext, currentBranch, changedFiles, diffText, tier)
    return jsonResponse({
      ...result,
      jiraIssueKey,
      repositoryId,
      branchName: currentBranch,
      changedFiles,
    })
  } catch (err) {
    console.error('PM task validation failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('LLM configuration key is missing')) {
      return jsonResponse({ error: 'Managed validation is temporarily unavailable. Add your own AXIOM key or configure a backend LLM provider.' }, 503)
    }
    return jsonResponse({ error: `Validation failed: ${message.slice(0, 300)}` }, 502)
  }
})

function extractAcceptanceCriteria(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?Acceptance Criteria(?:\*\*|__)?\s*:?\s*/i.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return []
  const section: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (/^#{1,6}\s+/.test(line)) break
    if (/^[A-Z][A-Za-z0-9 /&()_-]{2,60}:?$/.test(line.replace(/[*_`]/g, ''))) break
    section.push(line)
  }
  const criteria: string[] = []
  let current = ''
  const push = () => {
    const normalized = current.replace(/\s+/g, ' ').trim()
    if (normalized) criteria.push(normalized)
    current = ''
  }
  for (const line of section) {
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      push()
      current = bullet[1]
    } else {
      current = current ? `${current} ${line}` : line
    }
  }
  push()
  return criteria
}
