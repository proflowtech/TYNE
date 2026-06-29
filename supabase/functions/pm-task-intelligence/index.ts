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
  site_name?: string
  site_url?: string
}

type JiraIssue = {
  id: string
  key: string
  fields: Record<string, unknown>
}

type JiraDocNode = {
  type?: string
  text?: string
  content?: JiraDocNode[]
}

type PmTaskIntelligence = {
  issueKey: string
  goal: string
  subtasks: Array<{ title: string; description: string }>
  acceptanceCriteria: string[]
  proofPointTemplates: string[]
  validationSteps: string[]
  suggestedBranchName: string
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
    console.error('PM task intelligence profile lookup failed:', error)
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

async function jiraGet<T>(cloudId: string, accessToken: string, path: string): Promise<T> {
  const url = `https://api.atlassian.com/ex/jira/${cloudId}${path.startsWith('/') ? path : `/${path}`}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jira request failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

function jiraDocToPlainText(doc?: JiraDocNode): string {
  if (!doc) return ''
  return renderNode(doc).trim().replace(/\n{3,}/g, '\n\n')
}

function renderNode(node: JiraDocNode): string {
  if (!node) return ''
  if (typeof node.text === 'string') {
    return node.text
  }
  const children = Array.isArray(node.content) ? node.content : []
  const rendered = children.map(renderNode).join('')
  switch (node.type) {
    case 'paragraph':
      return `${rendered}\n\n`
    case 'heading':
      return `${rendered}\n`
    case 'bulletList':
      return `${children.map(c => `- ${renderNode(c).trim()}`).join('\n')}\n\n`
    case 'orderedList':
      return `${children.map((c, i) => `${i + 1}. ${renderNode(c).trim()}`).join('\n')}\n\n`
    case 'listItem':
      return rendered.trim()
    case 'hardBreak':
      return '\n'
    case 'codeBlock':
      return `${rendered}\n\n`
    default:
      return rendered
  }
}

function getIssueTextFields(issue: JiraIssue): { summary: string; description: string; issueType: string; status: string; priority: string; assignee: string; labels: string[] } {
  const fields = issue.fields || {}
  const summary = String(fields.summary || '')
  const description = jiraDocToPlainText(fields.description as JiraDocNode | undefined)
  const issueType = String((fields.issuetype as Record<string, unknown>)?.name || '')
  const status = String((fields.status as Record<string, unknown>)?.name || '')
  const priority = String((fields.priority as Record<string, unknown>)?.name || '')
  const assigneeObj = fields.assignee as Record<string, unknown> | undefined
  const assignee = assigneeObj?.displayName ? String(assigneeObj.displayName) : ''
  const labels = Array.isArray(fields.labels) ? fields.labels.map(String) : []
  return { summary, description, issueType, status, priority, assignee, labels }
}

function getParentKey(issue: JiraIssue): string | undefined {
  const parent = issue.fields?.parent as Record<string, unknown> | undefined
  return parent?.key ? String(parent.key) : undefined
}

function getSubtaskKeys(issue: JiraIssue): string[] {
  const subtasks = issue.fields?.subtasks as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(subtasks)) return []
  return subtasks.map(st => String(st.key || '')).filter(Boolean)
}

function buildBranchNameSuggestion(issueKey: string, title: string): string {
  const clean = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  const key = issueKey.toLowerCase()
  return `tyne/${key}-${clean}`
}

function readEnvSecret(name: string): string | null {
  const value = Deno.env.get(name)?.replace(/\s+/g, '')
  return value ? value : null
}

type ManagedLlmConfig =
  | { provider: 'openai'; apiKey: string; baseUrl: string; model: string }
  | { provider: 'anthropic'; apiKey: string; model: string }

function normalizeTier(rawTier: string): 'free' | 'pro' | 'max' {
  const tier = rawTier.toLowerCase()
  if (tier === 'pro') return 'pro'
  if (tier === 'max') return 'max'
  return 'free'
}

function selectExtractionModel(tier: string): string {
  // All tiers use DeepSeek for extraction.
  switch (normalizeTier(tier)) {
    case 'free':
    case 'pro':
    case 'max':
    default:
      return 'deepseek/deepseek-v4-pro'
  }
}

function selectNormalizationModel(): string {
  // Gemini is used for field filling/normalization when available.
  return 'google/gemini-2.5-flash'
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

function toSubtaskArray(value: unknown): Array<{ title: string; description: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map(v => {
      if (!v || typeof v !== 'object') return null
      const r = v as Record<string, unknown>
      const title = typeof r.title === 'string' ? r.title.trim() : ''
      const description = typeof r.description === 'string' ? r.description.trim() : ''
      if (!title) return null
      return { title, description }
    })
    .filter((v): v is { title: string; description: string } => Boolean(v))
}

function sanitizeIntelligence(raw: unknown): PmTaskIntelligence {
  if (!raw || typeof raw !== 'object') {
    return {
      issueKey: '',
      goal: '',
      subtasks: [],
      acceptanceCriteria: [],
      proofPointTemplates: [],
      validationSteps: [],
      suggestedBranchName: '',
    }
  }
  const r = raw as Record<string, unknown>
  return {
    issueKey: typeof r.issueKey === 'string' ? r.issueKey : '',
    goal: typeof r.goal === 'string' ? r.goal : '',
    subtasks: toSubtaskArray(r.subtasks),
    acceptanceCriteria: toStringArray(r.acceptanceCriteria),
    proofPointTemplates: toStringArray(r.proofPointTemplates),
    validationSteps: toStringArray(r.validationSteps),
    suggestedBranchName: typeof r.suggestedBranchName === 'string' ? r.suggestedBranchName : '',
  }
}

function buildExtractionPrompt(issueKey: string, selected: JiraIssue, parent: JiraIssue | null, subtasks: JiraIssue[]): string {
  const selectedFields = getIssueTextFields(selected)
  const parentFields = parent ? getIssueTextFields(parent) : null
  const subtaskSummaries = subtasks.map(st => {
    const f = getIssueTextFields(st)
    return `- ${st.key}: ${f.summary}${f.status ? ` (${f.status})` : ''}`
  }).join('\n')

  return `You are a senior product manager. Analyze the Jira issue context below and produce a structured developer execution plan.

Definitions:
- Goal: the main outcome of the task, derived from the Jira description plus story/epic context.
- Subtasks: concrete implementation steps the developer should perform.
- Acceptance Criteria: pass/fail conditions the implementation must satisfy.
- Proof Points: validation evidence that acceptance criteria were satisfied (e.g., test passed, file created, branch created, commit generated, PR description created, manual validation completed). Proof Points are NOT subtasks.

Issue: ${issueKey}
Summary: ${selectedFields.summary}
Description:
${selectedFields.description || '(no description)'}
Issue type: ${selectedFields.issueType}
Status: ${selectedFields.status}
Priority: ${selectedFields.priority}
Assignee: ${selectedFields.assignee}
Labels: ${selectedFields.labels.join(', ') || 'none'}

${parent && parentFields ? `Parent issue: ${parent.key}
Summary: ${parentFields.summary}
Description: ${parentFields.description || '(no description)'}
Issue type: ${parentFields.issueType}` : 'No parent issue available.'}

Jira subtasks:
${subtasks.length ? subtaskSummaries : 'No Jira subtasks available.'}

Return strictly JSON matching this schema:
{
  "issueKey": "${issueKey}",
  "goal": "Clear one-sentence goal derived from the description and parent context",
  "subtasks": [
    { "title": "Short subtask title", "description": "What the developer should do" }
  ],
  "acceptanceCriteria": [
    "Pass/fail condition the implementation must satisfy"
  ],
  "proofPointTemplates": [
    "Evidence that acceptance criteria were satisfied (e.g., src/foo.js exists, test passes, commit message references task)"
  ],
  "validationSteps": [
    "Step to validate the implementation"
  ],
  "suggestedBranchName": "tyne/PROJECT-123-short-kebab-case-description"
}

Do not include any explanation outside the JSON object. Do not wrap the JSON in markdown code fences.`
}

function buildNormalizationPrompt(extracted: string, issueKey: string): string {
  return `Convert the following extracted Jira intelligence into clean, normalized JSON fields for the Tyne UI.

Input:
${extracted}

Return strictly JSON with this schema:
{
  "issueKey": "${issueKey}",
  "goal": "string",
  "subtasks": [{ "title": "string", "description": "string" }],
  "acceptanceCriteria": ["string"],
  "proofPointTemplates": ["string"],
  "validationSteps": ["string"],
  "suggestedBranchName": "tyne/PROJECT-123-short-kebab-case-description"
}

Rules:
- Deduplicate subtasks and acceptance criteria.
- Keep language concise and actionable.
- Ensure proofPointTemplates are validation evidence, not implementation steps.
- Ensure suggestedBranchName is lowercase, kebab-case, and under 80 characters.
- Return only the JSON object, no markdown fences.`
}

async function extractIntelligence(
  issueKey: string,
  selected: JiraIssue,
  parent: JiraIssue | null,
  subtasks: JiraIssue[],
  tier: string,
  preferGemini: boolean,
): Promise<{ result: PmTaskIntelligence; provider: string; model: string }> {
  const extractionModel = selectExtractionModel(tier)
  const extractionConfig = resolveManagedLlmConfig(extractionModel)
  if (!extractionConfig) {
    throw new Error('LLM configuration key is missing')
  }

  const extractionPrompt = buildExtractionPrompt(issueKey, selected, parent, subtasks)
  const extractedText = cleanJsonText(await callLlm(extractionConfig, extractionPrompt, 0.2))

  if (preferGemini) {
    const normModel = selectNormalizationModel()
    const normConfig = resolveManagedLlmConfig(normModel)
    if (normConfig) {
      const normPrompt = buildNormalizationPrompt(extractedText, issueKey)
      const normalizedText = cleanJsonText(await callLlm(normConfig, normPrompt, 0.1))
      const parsed = safeJsonParse<Partial<PmTaskIntelligence>>(normalizedText)
      if (parsed) {
        return { result: sanitizeIntelligence(parsed), provider: normConfig.provider, model: normConfig.model }
      }
    }
  }

  const parsed = safeJsonParse<Partial<PmTaskIntelligence>>(extractedText)
  return { result: sanitizeIntelligence(parsed || extractedText), provider: extractionConfig.provider, model: extractionConfig.model }
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
  const issueKey = typeof body?.jiraIssueKey === 'string' ? body.jiraIssueKey.trim().toUpperCase() : ''
  const cloudId = typeof body?.cloudId === 'string' ? body.cloudId.trim() : ''
  const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : null
  const tier = typeof body?.tier === 'string' ? body.tier : 'free'
  const preferGemini = body?.useGemini === true

  if (!issueKey || !cloudId) {
    return jsonResponse({ error: 'Missing jiraIssueKey or cloudId' }, 400)
  }

  const { data: connection, error } = await supabase
    .from('jira_connections')
    .select('id, user_id, access_token, refresh_token, expires_at, cloud_id, site_name, site_url')
    .eq('user_id', profile.id)
    .eq('cloud_id', cloudId)
    .maybeSingle()

  if (error) {
    console.error('PM task intelligence Jira connection lookup failed:', error)
    return jsonResponse({ error: 'Jira connection lookup failed' }, 500)
  }

  if (!connection) {
    return jsonResponse({ error: 'Jira connection not found' }, 404)
  }

  let freshConnection: JiraConnection
  try {
    freshConnection = await refreshConnectionIfNeeded(supabase, connection as JiraConnection)
  } catch (err) {
    console.error('PM task intelligence token refresh failed:', err)
    return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
  }

  try {
    const selectedFields = 'summary,description,status,issuetype,priority,assignee,project,labels,parent,created,updated,duedate,subtasks'
    const selected = await jiraGet<JiraIssue>(cloudId, freshConnection.access_token, `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${selectedFields}`)

    let parent: JiraIssue | null = null
    const parentKey = getParentKey(selected)
    if (parentKey) {
      parent = await jiraGet<JiraIssue>(cloudId, freshConnection.access_token, `/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=${selectedFields}`).catch(() => null)
    }

    const subtaskKeys = getSubtaskKeys(selected)
    const subtasks: JiraIssue[] = []
    for (const key of subtaskKeys) {
      const st = await jiraGet<JiraIssue>(cloudId, freshConnection.access_token, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${selectedFields}`).catch(() => null)
      if (st) subtasks.push(st)
    }

    const { result: intelligence, provider, model } = await extractIntelligence(issueKey, selected, parent, subtasks, tier, preferGemini)
    if (!intelligence.goal && !intelligence.subtasks.length && !intelligence.acceptanceCriteria.length) {
      return jsonResponse({ error: 'Could not extract structured intelligence from Jira issue' }, 502)
    }

    // Store snapshot safely (no tokens, no secrets).
    const snapshot = {
      selected: {
        key: selected.key,
        fields: {
          summary: getIssueTextFields(selected).summary,
          description: getIssueTextFields(selected).description,
          issueType: getIssueTextFields(selected).issueType,
          status: getIssueTextFields(selected).status,
          priority: getIssueTextFields(selected).priority,
          assignee: getIssueTextFields(selected).assignee,
          labels: getIssueTextFields(selected).labels,
          parentKey,
        },
      },
      parent: parent ? { key: parent.key, fields: { summary: parent ? getIssueTextFields(parent).summary : '', description: parent ? getIssueTextFields(parent).description : '' } } : null,
      subtasks: subtasks.map(st => ({ key: st.key, summary: getIssueTextFields(st).summary })),
    }

    const now = new Date().toISOString()
    const { data: stored, error: upsertError } = await supabase
      .from('tyne_pm_task_contexts')
      .upsert({
        user_id: profile.id,
        jira_cloud_id: cloudId,
        jira_issue_key: issueKey,
        repository_id: repositoryId,
        goal: intelligence.goal,
        subtasks: intelligence.subtasks,
        acceptance_criteria: intelligence.acceptanceCriteria,
        proof_point_templates: intelligence.proofPointTemplates,
        validation_steps: intelligence.validationSteps,
        source_jira_snapshot: snapshot,
        model_provider: provider,
        model_name: model,
        updated_at: now,
      }, { onConflict: 'user_id,jira_cloud_id,jira_issue_key,repository_id' })
      .select()
      .single()

    if (upsertError) {
      console.error('PM task intelligence upsert failed:', upsertError)
      // Do not fail the request; return the extracted intelligence anyway.
    }

    return jsonResponse({
      ...intelligence,
      repositoryId,
      storedAt: stored?.updated_at || now,
      modelProvider: provider,
      modelName: model,
    })
  } catch (err) {
    console.error('PM task intelligence processing failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse({ error: 'Failed to extract PM intelligence', detail: message.slice(0, 200) }, 502)
  }
})
