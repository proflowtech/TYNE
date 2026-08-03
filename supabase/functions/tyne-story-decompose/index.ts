// Tyne Story Decomposition — turns a Jira/Linear Story or Epic into 3-5
// implementation-ready technical tasks using a Haiku-class model.
//
// The extension does the deterministic parts locally (characteristics
// detection, clarifying questions, split strategy); this function only runs
// the one step that needs an LLM: writing the actual task breakdown.

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

const LLM_TIMEOUT_MS = 60_000
const PROVIDER_TIMEOUT_MS = 30_000

type StoryPayload = {
  title: string
  description: string
  acceptanceCriteria: string[]
  issueType: string
  storyPoints?: number
}

type Characteristics = {
  hasFrontend: boolean
  hasBackend: boolean
  affectsDatabase: boolean
  needsAPI: boolean
  needsAuth: boolean
  needsIntegration: boolean
  complexity: 'low' | 'medium' | 'high'
}

type DecomposedTask = {
  title: string
  description: string
  acceptanceCriteria: string[]
  estimatedHours: number
  affectedFiles: string[]
  dependencies: string[]
  proofPoints: string[]
  developerContext: string
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

// deno-lint-ignore no-explicit-any
type AnySupabaseClient = any

async function requireProfile(req: Request, supabase: AnySupabaseClient): Promise<{ id: string; tier: string } | Response> {
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

  const { data: { user: sbUser }, error: sbErr } = await supabase.auth.getUser(token)
  if (sbUser && !sbErr) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, tier')
      .eq('id', sbUser.id)
      .maybeSingle()
    if (profile?.id) {
      return { id: profile.id, tier: profile.tier || 'CORE' }
    }
  }

  const ghUserRes = await fetchWithTimeout('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Tyne-Backend',
    },
  }, PROVIDER_TIMEOUT_MS)

  if (!ghUserRes.ok) {
    return jsonResponse({ error: 'Invalid token or session' }, 401)
  }

  const ghUser = await ghUserRes.json()
  const githubId = String(ghUser.id)

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, tier')
    .eq('github_id', githubId)
    .maybeSingle()

  if (error) {
    console.error('Story decomposition profile lookup failed:', error)
    return jsonResponse({ error: 'Profile lookup failed' }, 500)
  }
  if (!profile?.id) {
    return jsonResponse({ error: 'User profile not found' }, 404)
  }
  return { id: profile.id, tier: profile.tier || 'CORE' }
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean).slice(0, max)
}

function sanitizeStory(value: unknown): StoryPayload | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 300) : ''
  if (!title) return null
  const points = Number(r.storyPoints)
  return {
    title,
    description: typeof r.description === 'string' ? r.description.slice(0, 8000) : '',
    acceptanceCriteria: toStringArray(r.acceptanceCriteria, 10),
    issueType: typeof r.issueType === 'string' ? r.issueType.slice(0, 40) : 'story',
    storyPoints: Number.isFinite(points) ? points : undefined,
  }
}

function sanitizeCharacteristics(value: unknown): Characteristics {
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const complexity = r.complexity === 'high' || r.complexity === 'low' ? r.complexity : 'medium'
  return {
    hasFrontend: r.hasFrontend === true,
    hasBackend: r.hasBackend === true,
    affectsDatabase: r.affectsDatabase === true,
    needsAPI: r.needsAPI === true,
    needsAuth: r.needsAuth === true,
    needsIntegration: r.needsIntegration === true,
    complexity,
  }
}

function sanitizeAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && /^[a-z0-9_]{1,60}$/i.test(key)) {
      out[key] = val.slice(0, 500)
    }
  }
  return out
}

type CodebaseSummary = {
  architecture: string
  fileTree: string[]
  relevantFiles: string[]
}

function sanitizeCodebase(value: unknown): CodebaseSummary {
  const r = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const hints = (r.projectHints && typeof r.projectHints === 'object' ? r.projectHints : {}) as Record<string, unknown>
  const architecture = ['framework', 'language', 'packageManager', 'testFramework']
    .map(key => typeof hints[key] === 'string' ? String(hints[key]) : '')
    .filter(Boolean)
    .join(', ')
  const relevantFiles = Array.isArray(r.relevantFiles)
    ? r.relevantFiles
      .map(item => item && typeof item === 'object' ? String((item as Record<string, unknown>).path || '') : '')
      .filter(Boolean)
      .slice(0, 15)
    : []
  return {
    architecture,
    fileTree: toStringArray(r.fileTreeSummary, 20),
    relevantFiles,
  }
}

function buildDecompositionPrompt(
  story: StoryPayload,
  characteristics: Characteristics,
  answers: Record<string, string>,
  codebase: CodebaseSummary,
  maxTasks: number,
): string {
  const answerLines = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n') || 'none provided'
  return `You are decomposing a PM Story/Epic into ${maxTasks} or fewer implementation tasks for developers.

STORY:
Title: ${story.title}
Type: ${story.issueType}
${story.storyPoints !== undefined ? `Story points: ${story.storyPoints}` : ''}
Description:
${story.description || '(no description)'}

Acceptance criteria:
${story.acceptanceCriteria.map(ac => `- ${ac}`).join('\n') || '- (none listed)'}

DETECTED CHARACTERISTICS:
frontend: ${characteristics.hasFrontend}, backend: ${characteristics.hasBackend}, database: ${characteristics.affectsDatabase}, api: ${characteristics.needsAPI}, auth: ${characteristics.needsAuth}, integrations: ${characteristics.needsIntegration}, complexity: ${characteristics.complexity}

USER PREFERENCES (answers to clarifying / justification questions):
${answerLines}

Treat free-text answers as hard requirements for the split (scope, ordering, must-haves, out-of-scope). Do not invent work the user ruled out.

CODEBASE CONTEXT:
Architecture: ${codebase.architecture || 'unknown'}
${codebase.fileTree.length ? `File tree summary:\n${codebase.fileTree.map(f => `- ${f}`).join('\n')}` : ''}
${codebase.relevantFiles.length ? `Relevant files:\n${codebase.relevantFiles.map(f => `- ${f}`).join('\n')}` : ''}

Generate the task breakdown as strict JSON:
{
  "tasks": [
    {
      "title": "string (specific, action-oriented, prefixed with area e.g. 'Backend - ...')",
      "description": "string (what to build, 1-3 sentences)",
      "acceptanceCriteria": ["3-4 concrete, verifiable criteria"],
      "estimatedHours": 8,
      "affectedFiles": ["paths or patterns; ONLY paths from the codebase context, or directory patterns; empty if unknown"],
      "dependencies": ["titles of tasks in this list that must complete first"],
      "proofPoints": ["measurable outcomes proving it works"],
      "developerContext": "string (architecture notes, patterns to follow)"
    }
  ]
}

Rules:
- Maximum ${maxTasks} tasks. Respect the user's split preferences exactly (e.g. if they chose to split frontend/backend, produce separate tasks; if they chose a separate migration task, include one).
- Do not invent file paths; only use paths that appear in the codebase context, or generic directory patterns.
- Be realistic with hour estimates (2h-16h per task).
- dependencies must reference exact titles of other tasks in the same list.
- Return only the JSON object, no markdown fences, no commentary.`
}

type LlmConfig = { provider: string; apiKey: string; baseUrl: string; model: string }

async function callLlm(config: LlmConfig, prompt: string): Promise<string> {
  const res = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  }, LLM_TIMEOUT_MS)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content || ''
}

function cleanJsonText(raw: string): string {
  return raw.replace(/```(?:json)?\s*|\s*```/g, '').trim()
}

function parseTasks(raw: string, maxTasks: number): DecomposedTask[] {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(cleanJsonText(raw))
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).tasks
      : null
  if (!Array.isArray(list)) return []
  const tasks: DecomposedTask[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 180) : ''
    if (!title) continue
    const hours = Number(r.estimatedHours)
    tasks.push({
      title,
      description: typeof r.description === 'string' ? r.description.trim().slice(0, 2000) : '',
      acceptanceCriteria: toStringArray(r.acceptanceCriteria, 6),
      estimatedHours: Number.isFinite(hours) && hours > 0 ? Math.min(Math.round(hours), 80) : 4,
      affectedFiles: toStringArray(r.affectedFiles, 10),
      dependencies: toStringArray(r.dependencies, 5),
      proofPoints: toStringArray(r.proofPoints, 5),
      developerContext: typeof r.developerContext === 'string' ? r.developerContext.trim().slice(0, 1000) : '',
    })
  }
  // Clamp to the tier limit and drop dependency references to removed tasks.
  const kept = tasks.slice(0, maxTasks)
  const keptTitles = new Set(kept.map(t => t.title))
  return kept.map(t => ({ ...t, dependencies: t.dependencies.filter(dep => keptTitles.has(dep)) }))
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
  const story = sanitizeStory(body?.story)
  if (!story) {
    return jsonResponse({ error: 'Missing or invalid story' }, 400)
  }
  const tier = (() => {
    const raw = (profile.tier || '').toLowerCase()
    if (raw === 'pro') return 'pro'
    if (raw === 'max') return 'max'
    return 'free'
  })()
  if (tier !== 'pro' && tier !== 'max') {
    return jsonResponse({ error: 'Story decomposition is available in Pro and Max.' }, 403)
  }
  const tierCap = tier === 'max' ? 5 : 3
  const requested = Number(body?.maxTasks)
  const maxTasks = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.round(requested), tierCap) : tierCap
  const characteristics = sanitizeCharacteristics(body?.characteristics)
  const answers = sanitizeAnswers(body?.answers)
  const codebase = sanitizeCodebase(body?.codebaseContext)
  const issueIdentifier = typeof body?.issueIdentifier === 'string' ? body.issueIdentifier.slice(0, 60) : ''
  const source = typeof body?.source === 'string' ? body.source.slice(0, 20) : 'jira'

  // Metering: Pro is capped monthly; the RPC enforces the actual quota.
  const { data: usageCheck, error: usageErr } = await supabase.rpc('record_usage_atomic', {
    uid: profile.id,
    p_event: 'story_decomposition',
    p_tokens: 0,
    p_cost: 0,
    p_metadata: { source, issueIdentifier, tier } as unknown as never,
  })
  if (usageErr) {
    console.error('record_usage_atomic error:', usageErr)
    return jsonResponse({ error: 'Failed to check usage' }, 500)
  }
  if (!usageCheck || usageCheck.allowed !== true) {
    return jsonResponse({ error: 'Story decomposition limit reached for this month. Upgrade to Max for unlimited decompositions.' }, 402)
  }

  try {
    const configs = await resolveAicreditsLlmConfig('story_decomposition', tier)
    if (!configs.length) {
      return jsonResponse({ error: 'LLM configuration key is missing' }, 500)
    }
    const prompt = buildDecompositionPrompt(story, characteristics, answers, codebase, maxTasks)

    let lastError: unknown = null
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i]
      try {
        const raw = await callLlm(config, prompt)
        const tasks = parseTasks(raw, maxTasks)
        if (!tasks.length) {
          throw new Error('LLM returned no parseable tasks')
        }
        return jsonResponse({
          tasks,
          modelProvider: 'aicredits',
          modelName: config.model,
        })
      } catch (err) {
        lastError = err
        const isLast = i === configs.length - 1
        const parseFailure = err instanceof Error && /no parseable tasks/.test(err.message)
        if (isLast || (!parseFailure && !shouldTryNextAicreditsModel(err))) { throw err }
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`Story decomposition: model "${config.model}" failed (${message.slice(0, 120)}); trying "${configs[i + 1].model}"`)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Story decomposition: all models failed')
  } catch (err) {
    // Full detail is logged server-side; do not echo raw internal error text to the client.
    console.error('Story decomposition failed:', err)
    return jsonResponse({ error: 'Failed to decompose story. Please try again.' }, 502)
  }
})
