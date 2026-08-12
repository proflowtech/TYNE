import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  resolveAicreditsLlmConfig,
  shouldTryNextAicreditsModel,
} from '../_shared/aicreditsModelPolicy.ts'

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

type PmTaskSource = 'jira' | 'linear'
type EnrichmentStatus = 'success' | 'partial' | 'failed' | 'skipped'
type ValidationStatus = 'passed' | 'needs_work' | 'blocked' | 'context_limited'
type ValidationContextSource = 'enriched_pm' | 'stored_pm' | 'raw_pm' | 'branch_only' | 'diff_only'
type ValidationConfidence = 'high' | 'medium' | 'low'

type ValidationResult = {
  status: 'pass' | 'partial' | 'fail'
  matchPercent?: number
  summary: string
  passedCriteria: string[]
  failedCriteria: Array<{ criterion: string; reason: string }>
  missingWork: string[]
  generatedProofPoints: string[]
  recommendedNextActions: string[]
  completedGoals: Array<{ title: string; evidence?: string; relatedFiles?: string[] }>
  pendingGoals: Array<{ title: string; reason: string; suggestedAction: string; relatedFiles?: string[]; priority: 'high' | 'medium' | 'low' }>
  developerActions: Array<{ title: string; fileHint?: string; reason?: string }>
  codeEvidence: Array<{ file: string; reason: string }>
  fullReport?: string
  developerTaskPlan?: DeveloperTaskPlan
  codebaseContext?: CodebaseContextPack
  enrichmentStatus?: EnrichmentStatus
  enrichmentError?: string
  contextSource?: ValidationContextSource
  confidence?: ValidationConfidence
  validationStatus?: ValidationStatus
  warnings?: string[]
  resolvedContext?: ResolvedValidationContext
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

type LinearConnection = {
  id: string
  user_id: string
  access_token_encrypted: string
  refresh_token_encrypted?: string | null
  expires_at?: string | null
  linear_workspace_id?: string | null
}

type LinearIssue = {
  id: string
  identifier: string
  title: string
  description?: string | null
  parent?: { id?: string; identifier?: string; title?: string; description?: string | null } | null
  children?: { nodes?: Array<{ id?: string; identifier?: string; title?: string; description?: string | null; state?: { name?: string } | null }> } | null
}

type CodebaseContextPack = {
  repositoryName?: string
  currentBranch?: string
  workspaceRoot?: string
  projectHints?: Record<string, unknown>
  fileTreeSummary?: string[]
  relevantFiles?: Array<{ path: string; reason: string; snippet?: string }>
  existingTests?: Array<{ path: string; reason: string }>
  changedFiles?: string[]
  diff?: string
}

type DeveloperTaskPlan = {
  issueKey: string
  title: string
  technicalSummary: string
  implementationTasks: Array<{ title: string; description: string; likelyFiles: string[]; dependencies?: string[]; status: 'not_started' | 'in_progress' | 'completed' }>
  testingTasks: Array<{ title: string; testType: 'unit' | 'integration' | 'e2e' | 'manual'; likelyFiles?: string[] }>
  riskNotes: string[]
  questionsForPM?: string[]
}

type PmContext = {
  summary?: string
  requirements?: string[]
  acceptanceCriteria?: string[]
  decisions?: string[]
  constraints?: string[]
  blockers?: string[]
  openQuestions?: string[]
  attachments?: Array<{ name?: string; summary?: string }>
  comments?: Array<{ author?: string; date?: string; content?: string; importance?: string }>
  linkedIssues?: Array<{ identifier?: string; title?: string; relationship?: string; status?: string }>
}

type PmTaskContext = {
  source: PmTaskSource
  issueId: string
  issueIdentifier: string
  repositoryId: string | null
  title: string
  description: string
  parentIdentifier?: string
  parentTitle?: string
  parentDescription?: string
  children: Array<{ identifier: string; title: string; description: string; status: string }>
  goal: string | null
  subtasks: Array<{ title: string; description: string; status?: string; source?: 'pm_child' | 'developer_plan' | 'fallback_generated' }>
  acceptanceCriteria: string[]
  proofPointTemplates: string[]
  validationSteps: string[]
  pmContext?: PmContext
  developerTaskPlan?: DeveloperTaskPlan
  codebaseContext?: CodebaseContextPack
}

type ResolvedValidationContext = {
  enrichmentStatus: EnrichmentStatus
  enrichmentError?: string
  source: ValidationContextSource
  goal: string
  taskDescription?: string
  subtasks: Array<{ title: string; description?: string; status?: string; source: 'pm_child' | 'developer_plan' | 'fallback_generated' }>
  acceptanceCriteria: string[]
  validationSteps: string[]
  developerTaskPlan?: DeveloperTaskPlan
  confidence: ValidationConfidence
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function requireProfile(req: Request, supabase: ReturnType<typeof createClient>): Promise<{ id: string; tier: string } | Response> {
  const authHeader = req.headers.get('Authorization')
  const machineId = req.headers.get('X-Machine-ID')
  if (!authHeader) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401)
  }

  const token = authHeader.replace(/^bearer\s+/i, '').trim()

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

  if (token.split('.').length === 3) {
    const { data: authData, error: authError } = await supabase.auth.getUser(token)
    if (!authError && authData.user?.id) {
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('id, tier')
        .eq('id', authData.user.id)
        .maybeSingle()
      if (error) {
        console.error('PM task validation profile lookup failed:', error)
        return jsonResponse({ error: 'Profile lookup failed' }, 500)
      }
      if (profile?.id) {
        return { id: profile.id, tier: profile.tier || 'CORE' }
      }
      return jsonResponse({ error: 'User profile not found' }, 404)
    }
    return jsonResponse({ error: 'Session expired. Sign in again.' }, 401)
  }

  const ghUserRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Tyne-Backend',
    },
  })

  if (!ghUserRes.ok) {
    return jsonResponse({ error: 'Invalid auth token' }, 401)
  }

  const ghUser = await ghUserRes.json()
  const githubId = String(ghUser.id)

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, tier')
    .eq('github_id', githubId)
    .maybeSingle()

  if (error) {
    console.error('PM task validation profile lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }

  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
  }

  return { id: profile.id, tier: profile.tier || 'CORE' }
}

async function refreshJiraConnectionIfNeeded(
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

async function linearGraphQL<T>(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  })
  const payload = await res.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null
  if (!res.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Linear API request failed (${res.status})`)
  }
  return payload.data as T
}

async function refreshLinearConnectionIfNeeded(
  supabase: ReturnType<typeof createClient>,
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
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

function sanitizeCodebaseContext(value: unknown): CodebaseContextPack | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const relevantFiles = Array.isArray(r.relevantFiles)
    ? r.relevantFiles.map(item => {
      if (!item || typeof item !== 'object') return null
      const x = item as Record<string, unknown>
      const path = typeof x.path === 'string' ? x.path.trim() : ''
      if (!path) return null
      return {
        path,
        reason: typeof x.reason === 'string' ? x.reason.slice(0, 240) : '',
        snippet: typeof x.snippet === 'string' ? x.snippet.slice(0, 2000) : undefined,
      }
    }).filter((x): x is { path: string; reason: string; snippet?: string } => Boolean(x)).slice(0, 15)
    : []
  const existingTests = Array.isArray(r.existingTests)
    ? r.existingTests.map(item => {
      if (!item || typeof item !== 'object') return null
      const x = item as Record<string, unknown>
      const path = typeof x.path === 'string' ? x.path.trim() : ''
      if (!path) return null
      return { path, reason: typeof x.reason === 'string' ? x.reason.slice(0, 240) : '' }
    }).filter((x): x is { path: string; reason: string } => Boolean(x)).slice(0, 10)
    : []
  return {
    repositoryName: typeof r.repositoryName === 'string' ? r.repositoryName : '',
    currentBranch: typeof r.currentBranch === 'string' ? r.currentBranch : '',
    workspaceRoot: typeof r.workspaceRoot === 'string' ? r.workspaceRoot : '',
    projectHints: r.projectHints && typeof r.projectHints === 'object' ? r.projectHints as Record<string, unknown> : {},
    fileTreeSummary: toStringArray(r.fileTreeSummary).slice(0, 20),
    relevantFiles,
    existingTests,
    changedFiles: toStringArray(r.changedFiles).slice(0, 30),
    diff: typeof r.diff === 'string' ? r.diff.slice(0, 20_000) : undefined,
  }
}

function sanitizeDeveloperTaskPlan(value: unknown, codebaseContext?: CodebaseContextPack): DeveloperTaskPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const allowedFiles = new Set([
    ...(codebaseContext?.relevantFiles || []).map(f => f.path),
    ...(codebaseContext?.existingTests || []).map(f => f.path),
    ...(codebaseContext?.changedFiles || []),
  ])
  const cleanFiles = (value: unknown) => toStringArray(value).filter(file => allowedFiles.size === 0 || allowedFiles.has(file)).slice(0, 6)
  return {
    issueKey: typeof r.issueKey === 'string' ? r.issueKey : '',
    title: typeof r.title === 'string' ? r.title : '',
    technicalSummary: typeof r.technicalSummary === 'string' ? r.technicalSummary : '',
    implementationTasks: Array.isArray(r.implementationTasks) ? r.implementationTasks.map(item => {
      if (!item || typeof item !== 'object') return null
      const x = item as Record<string, unknown>
      const title = typeof x.title === 'string' ? x.title.trim() : ''
      if (!title) return null
      const status = x.status === 'completed' || x.status === 'in_progress' ? x.status : 'not_started'
      return {
        title,
        description: typeof x.description === 'string' ? x.description.slice(0, 280) : '',
        likelyFiles: cleanFiles(x.likelyFiles),
        dependencies: toStringArray(x.dependencies).slice(0, 5),
        status,
      }
    }).filter((x): x is DeveloperTaskPlan['implementationTasks'][number] => Boolean(x)).slice(0, 8) : [],
    testingTasks: Array.isArray(r.testingTasks) ? r.testingTasks.map(item => {
      if (!item || typeof item !== 'object') return null
      const x = item as Record<string, unknown>
      const title = typeof x.title === 'string' ? x.title.trim() : ''
      if (!title) return null
      const testType = x.testType === 'integration' || x.testType === 'e2e' || x.testType === 'manual' ? x.testType : 'unit'
      return { title, testType, likelyFiles: cleanFiles(x.likelyFiles) }
    }).filter((x): x is DeveloperTaskPlan['testingTasks'][number] => Boolean(x)).slice(0, 6) : [],
    riskNotes: toStringArray(r.riskNotes).slice(0, 5),
    questionsForPM: toStringArray(r.questionsForPM).slice(0, 5),
  }
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = nonEmptyString(value)
    if (text) return text
  }
  return ''
}

function toSubtasks(value: unknown): Array<{ title: string; description: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const r = item as Record<string, unknown>
      const title = firstNonEmpty(r.title, r.summary, r.identifier, r.key)
      if (!title) return null
      return { title, description: nonEmptyString(r.description) }
    })
    .filter((item): item is { title: string; description: string } => Boolean(item))
}

function preferStoredArray<T>(stored: T[], override: T[] | null): T[] {
  return stored.length ? stored : (override?.length ? override : [])
}

function preferStoredString(stored: unknown, override: unknown): string {
  return firstNonEmpty(stored, override)
}

function normalizeEnrichmentStatus(value: unknown): EnrichmentStatus {
  return value === 'success' || value === 'partial' || value === 'failed' || value === 'skipped' ? value : 'skipped'
}

function normalizeContextSource(value: unknown): ValidationContextSource {
  return value === 'enriched_pm' || value === 'stored_pm' || value === 'raw_pm' || value === 'branch_only' || value === 'diff_only'
    ? value
    : 'raw_pm'
}

function confidenceFromContext(source: ValidationContextSource, enrichmentStatus: EnrichmentStatus): ValidationConfidence {
  if (source === 'branch_only' || source === 'diff_only' || enrichmentStatus === 'failed') return 'low'
  if (source === 'raw_pm' || enrichmentStatus === 'partial') return 'medium'
  return 'high'
}

function buildContextWarnings(enrichmentStatus: EnrichmentStatus, source: ValidationContextSource, enrichmentError?: string): string[] {
  const warnings: string[] = []
  if (enrichmentStatus === 'failed') {
    warnings.push(`PM enrichment failed; validation continued with fallback context${enrichmentError ? `: ${enrichmentError}` : '.'}`)
  } else if (enrichmentStatus === 'partial') {
    warnings.push('PM enrichment was partial; validation used available task context.')
  }
  if (source === 'raw_pm') warnings.push('Used raw PM task data because enriched task intelligence was unavailable.')
  if (source === 'branch_only') warnings.push('Limited task context. Validation is based on branch name and changed files.')
  if (source === 'diff_only') warnings.push('Limited task context. Validation is based on the code diff only.')
  return warnings
}

function sanitizePmContext(value: unknown): PmContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const r = value as Record<string, unknown>
  const objectArray = (input: unknown, map: (x: Record<string, unknown>) => Record<string, string>): Array<Record<string, string>> =>
    Array.isArray(input)
      ? input.filter(item => item && typeof item === 'object').slice(0, 20).map(item => map(item as Record<string, unknown>))
      : []
  return {
    summary: shortText(r.summary, 2_000),
    requirements: toStringArray(r.requirements).slice(0, 20),
    acceptanceCriteria: toStringArray(r.acceptanceCriteria).slice(0, 20),
    decisions: toStringArray(r.decisions).slice(0, 20),
    constraints: toStringArray(r.constraints).slice(0, 20),
    blockers: toStringArray(r.blockers).slice(0, 20),
    openQuestions: toStringArray(r.openQuestions).slice(0, 20),
    attachments: objectArray(r.attachments, x => ({ name: shortText(x.name, 200), summary: shortText(x.summary, 2_000) })),
    comments: objectArray(r.comments, x => ({
      author: shortText(x.author, 100),
      date: shortText(x.date, 100),
      content: shortText(x.content, 4_000),
      importance: ['high', 'medium', 'low'].includes(String(x.importance)) ? String(x.importance) : 'medium',
    })),
    linkedIssues: objectArray(r.linkedIssues, x => ({
      identifier: shortText(x.identifier, 100),
      title: shortText(x.title, 300),
      relationship: shortText(x.relationship, 100),
      status: shortText(x.status, 100),
    })),
  }
}

function fallbackSubtasks(title: string, acceptanceCriteria: string[], currentBranch: string, changedFiles: string[]): PmTaskContext['subtasks'] {
  const subtasks: PmTaskContext['subtasks'] = []
  if (title.trim()) {
    subtasks.push({ title: `Implement: ${title.trim().slice(0, 100)}`, description: 'Fallback work item derived from the task title.', source: 'fallback_generated' })
  }
  for (const criterion of acceptanceCriteria.slice(0, 3)) {
    subtasks.push({ title: `Satisfy: ${criterion.slice(0, 100)}`, description: 'Fallback work item derived from acceptance criteria.', source: 'fallback_generated' })
  }
  for (const file of changedFiles.slice(0, 3)) {
    subtasks.push({ title: `Review changes in ${file.split('/').pop() || file}`, description: `Fallback work item derived from changed file ${file}.`, source: 'fallback_generated' })
  }
  if (currentBranch.trim()) {
    subtasks.push({ title: `Validate branch ${currentBranch.trim().slice(0, 100)}`, description: 'Fallback work item derived from the current branch.', source: 'fallback_generated' })
  }
  subtasks.push({ title: 'Verify test coverage', description: 'Fallback work item requiring tests or a clear reason tests were not needed.', source: 'fallback_generated' })
  const seen = new Set<string>()
  return subtasks.filter(item => {
    const key = item.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

function buildResolvedContext(
  taskContext: PmTaskContext,
  enrichmentStatus: EnrichmentStatus,
  enrichmentError: string | undefined,
  source: ValidationContextSource,
  confidence: ValidationConfidence,
): ResolvedValidationContext {
  return {
    enrichmentStatus,
    enrichmentError,
    source,
    goal: taskContext.goal || taskContext.title || taskContext.issueIdentifier,
    taskDescription: taskContext.description || undefined,
    subtasks: taskContext.subtasks.map(task => ({
      title: task.title,
      description: task.description || undefined,
      status: task.status,
      source: task.source || 'developer_plan',
    })),
    acceptanceCriteria: taskContext.acceptanceCriteria,
    validationSteps: taskContext.validationSteps,
    developerTaskPlan: taskContext.developerTaskPlan,
    confidence,
  }
}

function mapValidationStatus(result: ValidationResult, source: ValidationContextSource, confidence: ValidationConfidence): ValidationStatus {
  if (source === 'branch_only' || source === 'diff_only' || confidence === 'low') {
    return result.status === 'fail' ? 'needs_work' : 'context_limited'
  }
  if (result.status === 'pass') return 'passed'
  if (result.status === 'fail') {
    const score = result.matchPercent
    if (typeof score === 'number' && score >= 55) return 'needs_work'
    return 'blocked'
  }
  return 'needs_work'
}

type JiraDocNode = {
  type?: string
  text?: string
  content?: JiraDocNode[]
}

function jiraDocToPlainText(node: JiraDocNode | string | undefined): string {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node.type === 'text') return node.text || ''
  const rendered = (node.content || []).map(jiraDocToPlainText).filter(Boolean).join(node.type === 'paragraph' ? ' ' : '\n')
  return rendered.trim()
}

function toChildren(value: unknown): Array<{ identifier: string; title: string; description: string; status: string }> {
  if (!Array.isArray(value)) return []
  return value
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const r = item as Record<string, unknown>
      const fields = r.fields && typeof r.fields === 'object' ? r.fields as Record<string, unknown> : null
      const state = r.state && typeof r.state === 'object' ? r.state as Record<string, unknown> : null
      const statusObj = fields?.status && typeof fields.status === 'object' ? fields.status as Record<string, unknown> : null
      const identifier = firstNonEmpty(r.identifier, r.key, r.id)
      const title = firstNonEmpty(r.title, r.summary, fields?.summary)
      if (!identifier && !title) return null
      return {
        identifier,
        title,
        description: firstNonEmpty(r.description, fields ? jiraDocToPlainText(fields.description as JiraDocNode | string | undefined) : ''),
        status: firstNonEmpty(state?.name, statusObj?.name),
      }
    })
    .filter((item): item is { identifier: string; title: string; description: string; status: string } => Boolean(item))
}

function contextFromSnapshot(source: PmTaskSource, snapshot: unknown): Partial<PmTaskContext> {
  if (!snapshot || typeof snapshot !== 'object') return {}
  const s = snapshot as Record<string, unknown>
  if (source === 'jira') {
    const selected = s.selected && typeof s.selected === 'object' ? s.selected as Record<string, unknown> : {}
    const fields = selected.fields && typeof selected.fields === 'object' ? selected.fields as Record<string, unknown> : {}
    const parent = s.parent && typeof s.parent === 'object' ? s.parent as Record<string, unknown> : null
    const parentFields = parent?.fields && typeof parent.fields === 'object' ? parent.fields as Record<string, unknown> : {}
    return {
      title: firstNonEmpty(fields.summary),
      description: firstNonEmpty(fields.description),
      parentIdentifier: firstNonEmpty(parent?.key),
      parentTitle: firstNonEmpty(parentFields.summary),
      parentDescription: firstNonEmpty(parentFields.description),
      children: toChildren(s.subtasks),
    }
  }
  const parent = s.parent && typeof s.parent === 'object' ? s.parent as Record<string, unknown> : null
  const childrenEnvelope = s.children && typeof s.children === 'object' ? s.children as Record<string, unknown> : null
  const childNodes = Array.isArray(childrenEnvelope?.nodes) ? childrenEnvelope.nodes : []
  return {
    title: firstNonEmpty(s.title),
    description: firstNonEmpty(s.description),
    parentIdentifier: firstNonEmpty(parent?.identifier, parent?.id),
    parentTitle: firstNonEmpty(parent?.title),
    parentDescription: firstNonEmpty(parent?.description),
    children: toChildren(childNodes),
  }
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

function shortText(value: unknown, max = 180): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text
}

function completedGoalsArray(value: unknown): ValidationResult['completedGoals'] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    const title = shortText(r.title, 90)
    if (!title) return null
    return { title, evidence: shortText(r.evidence, 120) || undefined, relatedFiles: toStringArray(r.relatedFiles).slice(0, 3) }
  }).filter((x): x is ValidationResult['completedGoals'][number] => Boolean(x)).slice(0, 4)
}

function pendingGoalsArray(value: unknown): ValidationResult['pendingGoals'] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    const title = shortText(r.title, 90)
    if (!title) return null
    const priority = r.priority === 'high' || r.priority === 'low' ? r.priority : 'medium'
    return {
      title,
      reason: shortText(r.reason, 120) || 'Evidence is missing from the current diff.',
      suggestedAction: shortText(r.suggestedAction, 120) || 'Add code or tests that satisfy this requirement.',
      relatedFiles: toStringArray(r.relatedFiles).slice(0, 3),
      priority,
    }
  }).filter((x): x is ValidationResult['pendingGoals'][number] => Boolean(x)).slice(0, 4)
}

function developerActionsArray(value: unknown): ValidationResult['developerActions'] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    const title = shortText(r.title, 100)
    if (!title) return null
    return { title, fileHint: shortText(r.fileHint, 120) || undefined, reason: shortText(r.reason, 120) || undefined }
  }).filter((x): x is ValidationResult['developerActions'][number] => Boolean(x)).slice(0, 5)
}

function codeEvidenceArray(value: unknown): ValidationResult['codeEvidence'] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!item || typeof item !== 'object') return null
    const r = item as Record<string, unknown>
    const file = shortText(r.file, 160)
    if (!file) return null
    return { file, reason: shortText(r.reason, 140) || 'Changed in the current diff.' }
  }).filter((x): x is ValidationResult['codeEvidence'][number] => Boolean(x)).slice(0, 6)
}

function buildValidationPrompt(
  taskContext: PmTaskContext,
  branchName: string,
  changedFiles: string[],
  diffText: string,
  tier: string,
  resolvedContext: ResolvedValidationContext,
  warnings: string[],
): string {
  const isMax = normalizeTier(tier) === 'max'
  const depthNote = isMax
    ? 'Perform a deep validation using the task context, code diff, and project conventions. Look for edge cases, security issues, and test coverage.'
    : 'Validate the implementation against the acceptance criteria and goal.'
  const codebase = taskContext.codebaseContext
  const plan = taskContext.developerTaskPlan
  const relevantFiles = codebase?.relevantFiles || []
  const existingTests = codebase?.existingTests || []
  const implementationTasks = plan?.implementationTasks || []
  const testingTasks = plan?.testingTasks || []
  const pmContext = taskContext.pmContext || {}

  return `You are a senior code reviewer. Validate whether the code changes below satisfy the ${taskContext.source === 'jira' ? 'Jira' : 'Linear'} task.
You are also Tyne, a technical AI Scrum Master inside VS Code. Keep the default validation card short and actionable.

${depthNote}

Validation Context:
Source: ${resolvedContext.source}
Enrichment Status: ${resolvedContext.enrichmentStatus}
Confidence: ${resolvedContext.confidence}
Warnings:
${warnings.map(w => `- ${w}`).join('\n') || 'None'}

Task: ${taskContext.issueIdentifier}
Title: ${taskContext.title || taskContext.issueIdentifier}
Description:
${taskContext.description || 'Not provided'}

Parent / Epic / Story Context:
${taskContext.parentIdentifier || taskContext.parentTitle
  ? `${taskContext.parentIdentifier || 'parent'}: ${taskContext.parentTitle || ''}
${taskContext.parentDescription || ''}`.trim()
  : 'None'}

Child Issues / Subtasks From PM Tool:
${taskContext.children.map(child => `- ${child.identifier || 'child'}: ${child.title}${child.status ? ` (${child.status})` : ''}${child.description ? ` — ${child.description}` : ''}`).join('\n') || 'None'}

Goal: ${taskContext.goal || 'Not provided'}

Execution Subtasks / Derived Work Items:
${taskContext.subtasks.map(s => `- ${s.title}: ${s.description}`).join('\n') || 'None'}

Acceptance Criteria:
${taskContext.acceptanceCriteria.map(c => `- ${c}`).join('\n') || 'None'}

Latest PM Decisions:
${(pmContext.decisions || []).map(item => `- ${item}`).join('\n') || 'None'}
Constraints:
${(pmContext.constraints || []).map(item => `- ${item}`).join('\n') || 'None'}
Blockers:
${(pmContext.blockers || []).map(item => `- ${item}`).join('\n') || 'None'}
Open Questions:
${(pmContext.openQuestions || []).map(item => `- ${item}`).join('\n') || 'None'}
Attachments:
${(pmContext.attachments || []).map(item => `- ${item.name || 'attachment'}: ${item.summary || ''}`).join('\n') || 'None'}
Linked Issues:
${(pmContext.linkedIssues || []).map(item => `- ${item.relationship || 'related'}: ${item.identifier || ''} ${item.title || ''}`).join('\n') || 'None'}
Latest Comments:
${(pmContext.comments || []).slice(0, 10).map(item => `- ${item.date || ''} ${item.author || ''}: ${item.content || ''}`).join('\n') || 'None'}

Proof Point Templates:
${taskContext.proofPointTemplates.map(p => `- ${p}`).join('\n') || 'None'}

Validation Steps:
${taskContext.validationSteps.map(v => `- ${v}`).join('\n') || 'None'}

Developer Task Plan:
Technical Summary: ${plan?.technicalSummary || 'No developer task plan provided.'}
Implementation Tasks:
${implementationTasks.map((task, index) => `${index + 1}. ${task.title} — ${task.description}${task.likelyFiles?.length ? `\n   Files: ${task.likelyFiles.join(', ')}` : '\n   Files: exact file unknown'}`).join('\n') || 'None'}
Testing Tasks:
${testingTasks.map((task, index) => `${index + 1}. ${task.title} (${task.testType})${task.likelyFiles?.length ? ` — ${task.likelyFiles.join(', ')}` : ''}`).join('\n') || 'None'}
Risks:
${(plan?.riskNotes || []).map(r => `- ${r}`).join('\n') || 'None'}

Codebase Context:
Repository: ${codebase?.repositoryName || 'unknown'}
Framework Hints: ${codebase?.projectHints ? Object.entries(codebase.projectHints).filter(([, v]) => Boolean(v)).map(([k, v]) => `${k}=${String(v)}`).join(', ') : 'none'}
Relevant Files:
${relevantFiles.map(file => `- ${file.path}: ${file.reason}${file.snippet ? `\n  Snippet:\n${file.snippet}` : ''}`).join('\n') || 'None'}
Existing Tests:
${existingTests.map(file => `- ${file.path}: ${file.reason}`).join('\n') || 'None'}

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
  "summary": "one sentence result under 28 words",
  "completedGoals": [
    { "title": "short completed goal", "evidence": "specific code evidence", "relatedFiles": ["file from context or diff"] }
  ],
  "pendingGoals": [
    { "title": "short pending goal", "reason": "why pending", "suggestedAction": "specific next action", "relatedFiles": ["file from context or diff"], "priority": "high" | "medium" | "low" }
  ],
  "developerActions": [
    { "title": "specific next developer action", "fileHint": "file from context or diff", "reason": "why this is needed" }
  ],
  "codeEvidence": [
    { "file": "file from changed/relevant files", "reason": "what evidence was found" }
  ],
  "passedCriteria": ["criterion text"],
  "failedCriteria": [{ "criterion": "criterion text", "reason": "why it failed" }],
  "missingWork": ["what is missing"],
  "generatedProofPoints": ["evidence that acceptance criteria were satisfied"],
  "recommendedNextActions": ["recommended next step"],
  "fullReport": "optional detailed report with reasoning, risk areas, missing tests, files, and suggested implementation sequence"
}

Rules:
- PM enrichment failure is not a code validation failure. Do not fail the code only because enrichment failed or PM context is limited.
- If task context is limited, validate against the available goal, branch, changed files, and diff. Prefer partial/context-limited reasoning over false failure.
- Default card fields must fit in 120-160 words total.
- completedGoals max 4, pendingGoals max 4, developerActions max 5, codeEvidence max 6.
- Each item must be one short sentence.
- Avoid generic statements like "improve implementation".
- Every pending goal must be actionable.
- If evidence is missing, say exactly what evidence is missing.
- Compare the git diff against the Developer Task Plan and acceptance criteria.
- Check whether expected tests were added or updated.
- Check whether changed files match expected code areas.
- Scoring: PM goal coverage 40%, acceptance criteria 25%, test coverage 20%, code relevance 10%, risk/compliance 5%.
- 80-100 is pass, 65-79 is partial/mostly complete, 40-64 is partial/needs work, 0-39 is fail/blocked.
- Mention file paths only when they appear in Changed Files, Relevant Files, or Existing Tests.
- Respond with only the JSON object. Do not wrap it in markdown code fences.`
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
      completedGoals: [],
      pendingGoals: [],
      developerActions: [{ title: 'Re-run validation.', reason: 'The model response could not be parsed.' }],
      codeEvidence: [],
      modelProvider: provider,
      modelName: model,
    }
  }
  const r = raw as Record<string, unknown>
  const matchPercentRaw = typeof r.matchPercent === 'number' ? r.matchPercent : Number(r.matchPercent)
  const matchPercent = Number.isNaN(matchPercentRaw) ? undefined : Math.max(0, Math.min(100, Math.round(matchPercentRaw)))
  const statusFromScore = matchPercent === undefined ? 'partial' : matchPercent >= 80 ? 'pass' : matchPercent < 35 ? 'fail' : 'partial'
  const status = typeof r.status === 'string' && ['pass', 'partial', 'fail'].includes(r.status.toLowerCase())
    ? (r.status.toLowerCase() as 'pass' | 'partial' | 'fail')
    : statusFromScore
  const completedGoals = completedGoalsArray(r.completedGoals)
  const pendingGoals = pendingGoalsArray(r.pendingGoals)
  const developerActions = developerActionsArray(r.developerActions)
  const codeEvidence = codeEvidenceArray(r.codeEvidence)
  return {
    status,
    matchPercent,
    summary: shortText(r.summary, 180) || 'Validation completed.',
    passedCriteria: toStringArray(r.passedCriteria),
    failedCriteria: toFailedCriteriaArray(r.failedCriteria),
    missingWork: toStringArray(r.missingWork),
    generatedProofPoints: toStringArray(r.generatedProofPoints),
    recommendedNextActions: toStringArray(r.recommendedNextActions),
    completedGoals,
    pendingGoals,
    developerActions,
    codeEvidence,
    fullReport: typeof r.fullReport === 'string' ? r.fullReport.trim().slice(0, 8000) : undefined,
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
  resolvedContext: ResolvedValidationContext,
  warnings: string[],
): Promise<ValidationResult> {
  if (!readEnvSecret('AICREDITS_API_KEY')) {
    throw new Error('LLM configuration key is missing')
  }

  const prompt = buildValidationPrompt(taskContext, branchName, changedFiles, diffText, tier, resolvedContext, warnings)
  const configs = await resolveAicreditsLlmConfig('pm_task_validation', tier)
  if (!configs.length) { throw new Error('LLM configuration key is missing') }
  let lastError: unknown = null

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]
    try {
      const rawText = cleanJsonText(await callLlm(config, prompt, 0.2))
      const parsed = safeJsonParse<Record<string, unknown>>(rawText)
      const result = sanitizeValidationResult(parsed || rawText, config.provider, config.model)
      result.developerTaskPlan = taskContext.developerTaskPlan
      result.codebaseContext = taskContext.codebaseContext
      result.enrichmentStatus = resolvedContext.enrichmentStatus
      result.enrichmentError = resolvedContext.enrichmentError
      result.contextSource = resolvedContext.source
      result.confidence = resolvedContext.confidence
      result.warnings = warnings
      result.resolvedContext = resolvedContext
      result.validationStatus = mapValidationStatus(result, resolvedContext.source, resolvedContext.confidence)
      return result
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const isLast = i === configs.length - 1
      if (isLast || !shouldTryNextAicreditsModel(err)) { throw err }
      console.warn(`PM task validation: model "${config.model}" unavailable (${message.slice(0, 120)}); trying "${configs[i + 1].model}"`)
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All validation models failed')
}

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
  const source = body?.source === 'linear' ? 'linear' : 'jira'
  const issueId = typeof body?.issueId === 'string' ? body.issueId.trim() : ''
  const issueIdentifier = typeof body?.issueIdentifier === 'string'
    ? source === 'jira'
      ? body.issueIdentifier.trim().toUpperCase()
      : body.issueIdentifier.trim()
    : ''
  const cloudId = typeof body?.cloudId === 'string' ? body.cloudId.trim() : ''
  const linearWorkspaceId = typeof body?.linearWorkspaceId === 'string' ? body.linearWorkspaceId.trim() : ''
  const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : null
  const tier = profile.tier || 'CORE'
  const currentBranch = typeof body?.currentBranch === 'string' ? body.currentBranch : ''
  const rawDiff = typeof body?.diff === 'string' ? body.diff : ''
  const rawChangedFiles = Array.isArray(body?.changedFiles) ? body.changedFiles : []
  const goalOverride = typeof body?.goal === 'string' ? body.goal : null
  const acceptanceCriteriaOverride = Array.isArray(body?.acceptanceCriteria) ? toStringArray(body.acceptanceCriteria) : null
  const subtasksOverride = Array.isArray(body?.subtasks) ? toSubtasks(body.subtasks) : null
  const proofPointTemplatesOverride = Array.isArray(body?.proofPointTemplates) ? toStringArray(body.proofPointTemplates) : null
  const validationStepsOverride = Array.isArray(body?.validationSteps) ? toStringArray(body.validationSteps) : null
  const codebaseContext = sanitizeCodebaseContext(body?.codebaseContext)
  const developerTaskPlan = sanitizeDeveloperTaskPlan(body?.developerTaskPlan, codebaseContext)
  const pmContextOverride = sanitizePmContext(body?.pmContext)
  const enrichmentStatus = normalizeEnrichmentStatus(body?.enrichmentStatus)
  const enrichmentError = typeof body?.enrichmentError === 'string' ? body.enrichmentError : undefined
  let validationContextSource = normalizeContextSource(body?.contextSource)
  const { diffText, changedFiles } = sanitizeDiff(rawDiff, rawChangedFiles.map(String))

  if (source === 'jira' && (!issueIdentifier || !cloudId)) {
    return jsonResponse({ error: 'Missing issueIdentifier or cloudId for Jira' }, 400)
  }
  if (source === 'linear' && (!issueId || !issueIdentifier)) {
    return jsonResponse({ error: 'Missing issueId or issueIdentifier for Linear' }, 400)
  }

  let taskContext: PmTaskContext | null = null
  if (enrichmentStatus === 'failed') {
    console.warn(JSON.stringify({
      event: 'pm_enrichment_failed',
      source,
      issueIdentifier,
      issueId,
      reason: enrichmentError,
      validationContinued: true,
    }))
  }

  if (source === 'jira') {
    const { data: storedContext } = await supabase
      .from('tyne_pm_task_contexts')
      .select('jira_issue_key, repository_id, goal, subtasks, acceptance_criteria, proof_point_templates, validation_steps, pm_context, developer_task_plan, source_jira_snapshot')
      .eq('user_id', profile.id)
      .eq('jira_cloud_id', cloudId)
      .eq('jira_issue_key', issueIdentifier)
      .eq('repository_id', repositoryId)
      .maybeSingle()

    if (storedContext) {
      const snapshotContext = contextFromSnapshot(source, storedContext.source_jira_snapshot)
      const storedSubtasks = toSubtasks(storedContext.subtasks)
      const storedAcceptanceCriteria = toStringArray(storedContext.acceptance_criteria)
      const storedProofPointTemplates = toStringArray(storedContext.proof_point_templates)
      const storedValidationSteps = toStringArray(storedContext.validation_steps)
      taskContext = {
        source,
        issueId: issueId || issueIdentifier,
        issueIdentifier: storedContext.jira_issue_key,
        repositoryId: storedContext.repository_id,
        title: snapshotContext.title || String(storedContext.jira_issue_key || issueIdentifier),
        description: snapshotContext.description || '',
        parentIdentifier: snapshotContext.parentIdentifier,
        parentTitle: snapshotContext.parentTitle,
        parentDescription: snapshotContext.parentDescription,
        children: snapshotContext.children || [],
        goal: preferStoredString(storedContext.goal, goalOverride),
        subtasks: preferStoredArray(storedSubtasks, subtasksOverride),
        acceptanceCriteria: preferStoredArray(storedAcceptanceCriteria, acceptanceCriteriaOverride),
        proofPointTemplates: preferStoredArray(storedProofPointTemplates, proofPointTemplatesOverride),
        validationSteps: preferStoredArray(storedValidationSteps, validationStepsOverride),
        pmContext: storedContext.pm_context as PmContext | undefined,
        developerTaskPlan: developerTaskPlan || sanitizeDeveloperTaskPlan(storedContext.developer_task_plan, codebaseContext),
        codebaseContext,
      }
      validationContextSource = validationContextSource === 'enriched_pm' ? 'enriched_pm' : 'stored_pm'
    }
  } else {
    let contextQuery = supabase
      .from('linear_issue_contexts')
      .select('linear_issue_id, linear_issue_identifier, repository_id, goal, subtasks, acceptance_criteria, proof_point_templates, validation_steps, pm_context, developer_task_plan, source_linear_snapshot')
      .eq('user_id', profile.id)
      .eq('linear_issue_id', issueId)
      .eq('repository_id', repositoryId)

    if (linearWorkspaceId) {
      contextQuery = contextQuery.eq('linear_workspace_id', linearWorkspaceId)
    }

    const { data: storedContext } = await contextQuery
      .maybeSingle()

    if (storedContext) {
      const snapshotContext = contextFromSnapshot(source, storedContext.source_linear_snapshot)
      const storedSubtasks = toSubtasks(storedContext.subtasks)
      const storedAcceptanceCriteria = toStringArray(storedContext.acceptance_criteria)
      const storedProofPointTemplates = toStringArray(storedContext.proof_point_templates)
      const storedValidationSteps = toStringArray(storedContext.validation_steps)
      taskContext = {
        source,
        issueId: storedContext.linear_issue_id,
        issueIdentifier: storedContext.linear_issue_identifier,
        repositoryId: storedContext.repository_id,
        title: snapshotContext.title || String(storedContext.linear_issue_identifier || storedContext.linear_issue_id),
        description: snapshotContext.description || '',
        parentIdentifier: snapshotContext.parentIdentifier,
        parentTitle: snapshotContext.parentTitle,
        parentDescription: snapshotContext.parentDescription,
        children: snapshotContext.children || [],
        goal: preferStoredString(storedContext.goal, goalOverride),
        subtasks: preferStoredArray(storedSubtasks, subtasksOverride),
        acceptanceCriteria: preferStoredArray(storedAcceptanceCriteria, acceptanceCriteriaOverride),
        proofPointTemplates: preferStoredArray(storedProofPointTemplates, proofPointTemplatesOverride),
        validationSteps: preferStoredArray(storedValidationSteps, validationStepsOverride),
        pmContext: storedContext.pm_context as PmContext | undefined,
        developerTaskPlan: developerTaskPlan || sanitizeDeveloperTaskPlan(storedContext.developer_task_plan, codebaseContext),
        codebaseContext,
      }
      validationContextSource = validationContextSource === 'enriched_pm' ? 'enriched_pm' : 'stored_pm'
    }
  }

  if (!taskContext && source === 'jira' && validationContextSource !== 'branch_only' && validationContextSource !== 'diff_only') {
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
      freshConnection = await refreshJiraConnectionIfNeeded(supabase, connection as JiraConnection)
    } catch (err) {
      console.error('PM task validation token refresh failed:', err)
      return jsonResponse({ error: 'Reconnect Jira to continue' }, 401)
    }

    const selectedFields = 'summary,description,status,parent,subtasks'
    const issueRes = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueIdentifier)}?fields=${selectedFields}`, {
      headers: {
        Authorization: `Bearer ${freshConnection.access_token}`,
        Accept: 'application/json',
      },
    })
    if (!issueRes.ok) {
      return jsonResponse({ error: 'Could not load Jira issue for validation' }, 502)
    }
    const issue = await issueRes.json() as Record<string, unknown>
    const fields = issue.fields as Record<string, unknown>
    const descriptionNode = fields?.description as { content?: unknown[] } | string | undefined
    const descriptionText = jiraDocToPlainText(descriptionNode as JiraDocNode | string | undefined)
    const parentRef = fields?.parent && typeof fields.parent === 'object' ? fields.parent as Record<string, unknown> : null
    const parentKey = firstNonEmpty(parentRef?.key)
    let parentIssue: Record<string, unknown> | null = null
    if (parentKey) {
      const parentRes = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=summary,description,status`, {
        headers: {
          Authorization: `Bearer ${freshConnection.access_token}`,
          Accept: 'application/json',
        },
      }).catch(() => null)
      parentIssue = parentRes?.ok ? await parentRes.json().catch(() => null) as Record<string, unknown> | null : null
    }
    const subtaskRefs = Array.isArray(fields?.subtasks) ? fields.subtasks as Array<Record<string, unknown>> : []
    const subtaskIssues: Record<string, unknown>[] = []
    for (const subtask of subtaskRefs) {
      const key = firstNonEmpty(subtask.key)
      if (!key) continue
      const subtaskRes = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status`, {
        headers: {
          Authorization: `Bearer ${freshConnection.access_token}`,
          Accept: 'application/json',
        },
      }).catch(() => null)
      const subtaskIssue = subtaskRes?.ok ? await subtaskRes.json().catch(() => null) as Record<string, unknown> | null : null
      if (subtaskIssue) subtaskIssues.push(subtaskIssue)
    }
    const parentFields = parentIssue?.fields && typeof parentIssue.fields === 'object' ? parentIssue.fields as Record<string, unknown> : null
    const children = toChildren(subtaskIssues.length ? subtaskIssues : subtaskRefs)
    const fetchedCriteria = extractAcceptanceCriteria(descriptionText)

    taskContext = {
      source,
      issueId: issueId || issueIdentifier,
      issueIdentifier,
      repositoryId,
      title: firstNonEmpty(fields?.summary, issueIdentifier),
      description: descriptionText,
      parentIdentifier: parentKey || undefined,
      parentTitle: firstNonEmpty(parentFields?.summary, parentRef?.fields && typeof parentRef.fields === 'object' ? (parentRef.fields as Record<string, unknown>).summary : ''),
      parentDescription: parentFields ? jiraDocToPlainText(parentFields.description as JiraDocNode | string | undefined) : undefined,
      children,
      goal: preferStoredString(fields?.summary, goalOverride),
      subtasks: preferStoredArray(children.map(child => ({ title: `${child.identifier}: ${child.title}`.trim(), description: child.description, status: child.status, source: 'pm_child' as const })), subtasksOverride),
      acceptanceCriteria: preferStoredArray(fetchedCriteria, acceptanceCriteriaOverride),
      proofPointTemplates: proofPointTemplatesOverride ?? [],
      validationSteps: validationStepsOverride ?? ['Check changed files', 'Check implementation against acceptance criteria', 'Run tests if available'],
      developerTaskPlan,
      codebaseContext,
    }
    validationContextSource = 'raw_pm'
  }

  if (!taskContext && source === 'linear' && validationContextSource !== 'branch_only' && validationContextSource !== 'diff_only') {
    let connectionQuery = supabase
      .from('linear_connections')
      .select('id, user_id, access_token_encrypted, refresh_token_encrypted, expires_at, linear_workspace_id')
      .eq('user_id', profile.id)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (linearWorkspaceId) {
      connectionQuery = connectionQuery.eq('linear_workspace_id', linearWorkspaceId)
    }

    const { data: connection, error } = await connectionQuery
      .maybeSingle()

    if (error) {
      console.error('PM task validation Linear connection lookup failed:', error)
      return jsonResponse({ error: 'Linear connection lookup failed' }, 500)
    }
    if (!connection) {
      return jsonResponse({ error: 'Linear connection not found' }, 404)
    }

    let freshConnection: LinearConnection
    try {
      freshConnection = await refreshLinearConnectionIfNeeded(supabase, connection as LinearConnection)
    } catch (err) {
      console.error('PM task validation Linear token refresh failed:', err)
      return jsonResponse({ error: 'Reconnect Linear to continue' }, 401)
    }

    const data = await linearGraphQL<{ issue: LinearIssue | null }>(
      freshConnection.access_token_encrypted,
      `query TyneLinearIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          parent { id identifier title description }
          children {
            nodes {
              id
              identifier
              title
              description
              state { name }
            }
          }
        }
      }`,
      { id: issueId },
    ).catch(err => {
      console.error('PM task validation Linear fetch failed:', err)
      return null
    })
    if (!data?.issue?.id || !data.issue.identifier) {
      return jsonResponse({ error: 'Could not load Linear issue for validation' }, 502)
    }
    const linearChildren = toChildren(data.issue.children?.nodes || [])
    const fetchedCriteria = extractAcceptanceCriteria(String(data.issue.description || ''))

    taskContext = {
      source,
      issueId: data.issue.id,
      issueIdentifier: data.issue.identifier,
      repositoryId,
      title: data.issue.title || data.issue.identifier,
      description: String(data.issue.description || ''),
      parentIdentifier: firstNonEmpty(data.issue.parent?.identifier, data.issue.parent?.id) || undefined,
      parentTitle: firstNonEmpty(data.issue.parent?.title) || undefined,
      parentDescription: firstNonEmpty(data.issue.parent?.description) || undefined,
      children: linearChildren,
      goal: preferStoredString(data.issue.title, goalOverride),
      subtasks: preferStoredArray(linearChildren.map(child => ({ title: `${child.identifier}: ${child.title}`.trim(), description: child.description, status: child.status, source: 'pm_child' as const })), subtasksOverride),
      acceptanceCriteria: preferStoredArray(fetchedCriteria, acceptanceCriteriaOverride),
      proofPointTemplates: proofPointTemplatesOverride ?? [],
      validationSteps: validationStepsOverride ?? ['Check changed files', 'Check implementation against acceptance criteria', 'Run tests if available'],
      developerTaskPlan,
      codebaseContext,
    }
    validationContextSource = 'raw_pm'
  }

  if (!taskContext) {
    validationContextSource = currentBranch || changedFiles.length ? 'branch_only' : 'diff_only'
    const fallbackTitle = firstNonEmpty(goalOverride, issueIdentifier, issueId, currentBranch, 'Code changes')
    taskContext = {
      source,
      issueId: issueId || issueIdentifier || currentBranch || 'diff-only',
      issueIdentifier: issueIdentifier || issueId || currentBranch || 'diff-only',
      repositoryId,
      title: fallbackTitle,
      description: 'Limited task context. PM enrichment and PM task fetch were unavailable; validation is based on local code changes.',
      children: [],
      goal: fallbackTitle,
      subtasks: fallbackSubtasks(fallbackTitle, acceptanceCriteriaOverride || [], currentBranch, changedFiles),
      acceptanceCriteria: acceptanceCriteriaOverride || [],
      proofPointTemplates: proofPointTemplatesOverride || [],
      validationSteps: validationStepsOverride?.length
        ? validationStepsOverride
        : ['Review changed files', 'Compare diff to available task/branch context', 'Check tests or explain why tests are not needed'],
      developerTaskPlan,
      codebaseContext,
    }
  }

  if (pmContextOverride) {
    taskContext.pmContext = pmContextOverride
  }

  try {
    if (!diffText.trim() && changedFiles.length === 0) {
      return jsonResponse({ error: 'No code changes found to validate' }, 400)
    }
    const validationConfidence = confidenceFromContext(validationContextSource, enrichmentStatus)
    const warnings = buildContextWarnings(enrichmentStatus, validationContextSource, enrichmentError)
    const resolvedContext = buildResolvedContext(taskContext, enrichmentStatus, enrichmentError, validationContextSource, validationConfidence)
    const result = await validateTask(taskContext, currentBranch, changedFiles, diffText, tier, resolvedContext, warnings)
    console.info(JSON.stringify({
      event: 'validation_completed',
      source,
      issueIdentifier: taskContext.issueIdentifier,
      contextSource: validationContextSource,
      enrichmentStatus,
      validationStatus: result.validationStatus,
      score: result.matchPercent ?? null,
    }))
    return jsonResponse({
      ...result,
      source,
      issueId: taskContext.issueId,
      issueIdentifier: taskContext.issueIdentifier,
      jiraIssueKey: source === 'jira' ? taskContext.issueIdentifier : undefined,
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
