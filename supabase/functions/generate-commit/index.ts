import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
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

async function checkValidationUsage(supabase: any, userId: string, tier: string): Promise<{ allowed: boolean; used: number; limit: number | null; remaining: number | null }> {
  const { data: used, error: usageError } = await supabase.rpc('validation_usage', { uid: userId })
  if (usageError) {
    console.error('validation_usage error:', usageError)
    return { allowed: false, used: 0, limit: null, remaining: null }
  }

  const { data: limit, error: limitError } = await supabase.rpc('tier_validation_limit', { t: tier })
  if (limitError) {
    console.error('tier_validation_limit error:', limitError)
    return { allowed: false, used: Number(used || 0), limit: null, remaining: null }
  }

  const normalizedUsed = Number(used || 0)
  const remaining = limit === null ? null : Math.max(0, Number(limit) - normalizedUsed)
  const allowed = limit === null || normalizedUsed < Number(limit)
  return { allowed, used: normalizedUsed, limit, remaining }
}

type ManagedLlmConfig =
  | { provider: 'openai'; apiKey: string; baseUrl: string; model: string }
  | { provider: 'anthropic'; apiKey: string; model: string }

function readEnvSecret(name: string): string | null {
  const value = Deno.env.get(name)?.replace(/\s+/g, '')
  return value ? value : null
}

function normalizeManagedTier(rawTier: string): 'free' | 'pro' | 'max' {
  const tier = rawTier.toLowerCase()
  if (tier === 'pro') { return 'pro' }
  if (tier === 'max') { return 'max' }
  return 'free'
}

async function callOpenAiCompatible(config: ManagedLlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  if (config.provider !== 'openai') {
    throw new Error('OpenAI-compatible config expected')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`AICredits API failed (${res.status}): ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  } finally {
    clearTimeout(timer)
  }
}

async function callAicreditsFallbacks(configs: ManagedLlmConfig[], systemPrompt: string, userPrompt: string): Promise<{ text: string; config: ManagedLlmConfig }> {
  let lastError: unknown = null
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]
    try {
      return { text: await callOpenAiCompatible(config, systemPrompt, userPrompt), config }
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const isLast = i === configs.length - 1
      if (isLast || !shouldTryNextAicreditsModel(err)) throw err
      console.warn(`Generate commit: model "${config.model}" unavailable (${message.slice(0, 120)}); trying "${configs[i + 1].model}"`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All AICredits generate-commit models failed')
}

function parseDeepReviewResponse(
  rawText: string,
  taskId: string,
  taskTitle: string,
  branchName: string,
  commitHash: string,
  userTier: string,
): Record<string, unknown> {
  const cleaned = rawText.replace(/```(?:json)?\s*|\s*```/g, '').trim()
  let parsed: Record<string, unknown> = {}
  let parseFailed = false
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    parseFailed = true
  }

  if (parseFailed || !parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('LLM returned invalid JSON. The validation could not be parsed. Please try again.')
  }

  const status = parseStatus(parsed.status)
  const matchPercent = parseNumber(parsed.matchPercent)
  const riskLevel = parseRiskLevel(parsed.riskLevel)
  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : defaultSummary(status)

  const result: Record<string, unknown> = {
    id: generateId(),
    taskId: taskId || parsed.taskId || null,
    taskTitle: taskTitle || parsed.taskTitle || null,
    branchName: branchName || parsed.branchName || null,
    commitHash: commitHash || parsed.commitHash || null,
    provider: 'managed',
    tier: userTier.toLowerCase(),
    status,
    matchPercent,
    riskLevel,
    summary,
    createdAt: new Date().toISOString(),
  }

  if (typeof parsed.detailedExplanation === 'string' && parsed.detailedExplanation.trim()) {
    result.detailedExplanation = parsed.detailedExplanation.trim()
  }
  if (Array.isArray(parsed.missingRequirements)) {
    result.missingRequirements = parsed.missingRequirements.filter((s): s is string => typeof s === 'string')
  }
  if (Array.isArray(parsed.criteriaMet)) {
    result.criteriaMet = parsed.criteriaMet.filter((s): s is string => typeof s === 'string')
  }
  if (Array.isArray(parsed.criteriaNotMet)) {
    result.criteriaNotMet = parsed.criteriaNotMet
      .map((item) => {
        if (!item || typeof item !== 'object') { return null }
        const row = item as Record<string, unknown>
        const criterion = typeof row.criterion === 'string' ? row.criterion.trim() : ''
        const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
        if (!criterion) { return null }
        return { criterion, reason: reason || 'Not satisfied by the diff.' }
      })
      .filter(Boolean)
  }
  if (Array.isArray(parsed.suggestions)) {
    result.suggestions = parsed.suggestions.filter((s): s is string => typeof s === 'string')
  }
  if (Array.isArray(parsed.codeQualityNotes)) {
    result.codeQualityNotes = parsed.codeQualityNotes.filter((s): s is string => typeof s === 'string')
  }
  if (Array.isArray(parsed.filesReviewed)) {
    result.filesReviewed = parsed.filesReviewed.filter((s): s is string => typeof s === 'string')
  }

  return result
}

function parseStatus(value: unknown): 'pass' | 'partial' | 'fail' {
  const s = typeof value === 'string' ? value.toLowerCase() : ''
  if (s === 'pass' || s === 'partial' || s === 'fail') { return s }
  return 'partial'
}

function parseRiskLevel(value: unknown): string | undefined {
  const r = typeof value === 'string' ? value.toLowerCase() : ''
  if (r === 'low' || r === 'medium' || r === 'high') { return r }
  return 'not_assessed'
}

function parseNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(n)) { return undefined }
  return Math.max(0, Math.min(100, Math.round(n)))
}

function defaultSummary(status: 'pass' | 'partial' | 'fail'): string {
  switch (status) {
    case 'pass': return 'Code matches the goal.'
    case 'fail': return 'Code does not match the goal.'
    default: return 'Code partially matches the goal.'
  }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
}

function normalizeCriteriaInput(value: unknown): string[] {
  if (!Array.isArray(value)) { return [] }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Parse authentication and machine headers
    const authHeader = req.headers.get('Authorization')
    const machineId = req.headers.get('X-Machine-ID')
    
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const githubToken = authHeader.replace(/^bearer\s+/i, '').trim()
    const payload = await req.json()
    const gitDiff = payload.gitDiff ?? payload.diff ?? payload.diffText ?? ''
    const goal = payload.goal
    const taskId = payload.taskId ?? payload.task_id
    const taskTitle = payload.taskTitle ?? payload.task_title
    const taskDescription = payload.taskDescription ?? payload.task_description
    const subtasks = payload.subtasks
    const acceptanceCriteria = normalizeCriteriaInput(payload.acceptanceCriteria ?? payload.acceptance_criteria)
    const branchName = payload.branchName ?? payload.branch_name
    const commitHash = payload.commitHash ?? payload.commit_hash
    const changedFiles = payload.changedFiles ?? payload.changed_files
    const feature = payload.feature
    const byokKey = payload.byokKey ?? payload.byok_key
    const byokProvider = payload.byokProvider ?? payload.byok_provider
    const taskProvider = typeof payload.provider === 'string' ? payload.provider : 'unknown'

    const requestFeature = feature || 'commit' // default to commit

    // 2. Authenticate user via GitHub API
    const ghUserRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'Tyne-Backend'
      }
    })

    if (!ghUserRes.ok) {
      return new Response(JSON.stringify({ error: "Invalid GitHub token" }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const ghUser = await ghUserRes.json()
    const githubId = String(ghUser.id)
    const githubUsername = ghUser.login
    let email = ghUser.email

    // Fallback to fetch emails if email is private
    if (!email) {
      const ghEmailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'Tyne-Backend'
        }
      })
      if (ghEmailsRes.ok) {
        const emails = await ghEmailsRes.json()
        const primaryEmail = emails.find((e: any) => e.primary && e.verified) || emails[0]
        if (primaryEmail) {
          email = primaryEmail.email
        }
      }
    }
    if (!email) {
      email = `${githubUsername}@users.noreply.github.com`
    }

    // 3. Initialize Supabase Admin Client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 4. Check hardware blocklist
    if (machineId) {
      const { data: blocked } = await supabase
        .from('hardware_blocklist')
        .select('machine_id')
        .eq('machine_id', machineId)
        .maybeSingle()

      if (blocked) {
        return new Response(JSON.stringify({ error: "Hardware ID is blocked" }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // 5. Query user profile for tier verification
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, tier, api_credits_remaining, github_username, email, avatar_url')
      .eq('github_id', githubId)
      .maybeSingle()

    const userTier = profile?.tier || 'CORE'
    const creditsRemaining = profile?.api_credits_remaining || 0

    // Handle Profile Fetch Request
    if (requestFeature === 'profile') {
      return new Response(JSON.stringify({
        id: profile?.id || null,
        tier: userTier,
        credits: creditsRemaining,
        githubId,
        githubUsername: profile?.github_username || githubUsername,
        email: profile?.email || email,
        avatarUrl: profile?.avatar_url || null,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 6. ENFORCE MULTI-TIER SECURITY RULES & USAGE
    const isCommit = requestFeature === 'commit'
    const isDeepReview = requestFeature === 'deep-review'
    const isManagedReview = isDeepReview && !byokKey

    if (isDeepReview) {
      if (userTier === 'CORE') {
        if (isManagedReview && profile?.id) {
          const usageRecord = await checkValidationUsage(supabase, profile.id, userTier)
          if (!usageRecord.allowed) {
            return new Response(JSON.stringify({ error: "Core validation limit reached. Use BYOK or wait until next month." }), {
              status: 402,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
        }
      } else if (userTier === 'PRO') {
        // Managed deep-review is allowed for the first 50 validations each month.
        if (isManagedReview && profile?.id) {
          const usageRecord = await checkValidationUsage(supabase, profile.id, userTier)
          if (!usageRecord.allowed) {
            return new Response(JSON.stringify({ error: "Pro validation limit reached. Use BYOK or wait until next month." }), {
              status: 402,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
        }
      } else if (userTier === 'MAX') {
        if (isManagedReview) {
          if (creditsRemaining <= 0) {
            return new Response(JSON.stringify({ error: "MAX API credits exhausted. Use BYOK or wait until next month." }), {
              status: 402,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
          // Decrement credit atomically
          const { error: decErr } = await supabase.rpc('decrement_user_credits', { p_github_id: githubId })
          if (decErr) {
            console.error("Error decrementing credits:", decErr)
            return new Response(JSON.stringify({ error: "Failed to process credits decrement" }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
        }
      }
    }

    // 7. Route LLM Call
    // Commit synthesis is always managed by the backend. BYOK is only honored for deep-review.
    let responseText = ''

    let systemPrompt = ''
    let userPrompt = ''

    if (isDeepReview) {
      const subtaskList = (subtasks || [])
        .map((s: any, i: number) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`)
        .join('\n')
      const criteriaList = (acceptanceCriteria || [])
        .map((c: any, i: number) => `${i + 1}. ${c}`)
        .join('\n')
      const fileList = (changedFiles || [])
        .map((f: string, i: number) => `${i + 1}. ${f}`)
        .join('\n')

      systemPrompt = "You are a senior code reviewer. Validate whether the code changes below satisfy the task goal and requirements."
      userPrompt = `Return strictly JSON with this shape:
{
  "status": "pass" | "partial" | "fail",
  "matchPercent": 0-100 number,
  "riskLevel": "low" | "medium" | "high" | "not_assessed",
  "summary": "one sentence result",
  "detailedExplanation": "string or omitted",
  "missingRequirements": ["string"] or omitted,
  "criteriaMet": ["criterion text"] or omitted,
  "criteriaNotMet": [{ "criterion": "criterion text", "reason": "why it is not met" }] or omitted,
  "suggestions": ["string"] or omitted,
  "codeQualityNotes": ["string"] or omitted,
  "filesReviewed": ["string"] or omitted
}

Task: ${taskTitle || taskId || 'N/A'}
Task ID: ${taskId || 'N/A'}
Provider: ${taskProvider}
Branch: ${branchName || 'N/A'}
Commit: ${commitHash || 'N/A'}

Description:
${taskDescription || goal || 'No task description provided.'}

Goal:
${goal || 'No goal provided.'}

Subtasks:
${subtaskList || 'None'}

Acceptance Criteria:
${criteriaList || 'None'}

Instructions:
${criteriaList ? '- Acceptance criteria are the ground truth. Evaluate each criterion explicitly and populate criteriaMet / criteriaNotMet.\n- Use criteriaNotMet.reason to explain what is missing in the diff.' : '- Validate against the task description and goal.'}

Changed Files:
${fileList || 'None'}

Git Diff:
\`\`\`
${gitDiff || '(no changes)'}
\`\`\`

Respond with only the JSON object. Do not wrap it in markdown code fences.`
    } else {
      const completedSubtasks = (subtasks || []).filter((s: any) => s.done).map((s: any) => s.text)
      systemPrompt = "You are a Conventional Commit message generator."
      userPrompt = `Generate a conventional commit message for these code changes.

Goal: ${goal || 'Implement requested tasks'}
Task ID: ${taskId || 'none'}
Completed subtasks:
${completedSubtasks.map((s: string) => `- ${s}`).join('\n') || '- none marked complete'}

File changes summary (git diff):
${gitDiff || '(no diff available)'}

Respond ONLY with JSON in this exact format:
{
  "type": "feat" | "fix" | "refactor" | "chore" | "docs" | "test",
  "subject": "concise imperative subject line, max 72 chars",
  "body": "2-4 bullet points summarizing what changed and why"
}

Rules:
- Subject should be the text after the conventional commit prefix only.
- Subject must be specific, not generic.
- Body bullets must reflect actual changes.`
    }

    if (isDeepReview && byokKey) {
      const provider = byokProvider || 'claude'
      const activeKey = byokKey.replace(/\s+/g, '')
      if (!activeKey) {
        return new Response(JSON.stringify({ error: "LLM configuration key is missing" }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      if (provider === 'openai') {
      const controller1 = new AbortController()
      const timer1 = setTimeout(() => controller1.abort(), 60_000)
      let openAiRes: Response
      try {
        openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${activeKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' }
          }),
          signal: controller1.signal,
        })
      } catch (err) {
        clearTimeout(timer1)
        throw err
      }
      clearTimeout(timer1)

      if (!openAiRes.ok) {
        const errText = await openAiRes.text()
        console.error('OpenAI API failed:', errText)
        return new Response(JSON.stringify({ error: `OpenAI API failed: ${errText}` }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const openAiData = await openAiRes.json()
      responseText = openAiData.choices?.[0]?.message?.content || ''
    } else {
      // Anthropic BYOK
      const controller2 = new AbortController()
      const timer2 = setTimeout(() => controller2.abort(), 60_000)
      let anthropicRes: Response
      try {
        anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': activeKey,
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }]
          }),
          signal: controller2.signal,
        })
      } catch (err) {
        clearTimeout(timer2)
        throw err
      }
      clearTimeout(timer2)

      if (!anthropicRes.ok) {
        const errorText = await anthropicRes.text()
        console.error('Anthropic API failed:', errorText)
        return new Response(JSON.stringify({ error: `Anthropic API failed: ${errorText}` }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const llmData = await anthropicRes.json()
      responseText = llmData.content?.[0]?.text || ''
    }
    } else {
      const feature = isDeepReview ? 'generate_commit_deep_review' : 'generate_commit'
      const configs = await resolveAicreditsLlmConfig(feature, userTier, typeof payload.model === 'string' ? payload.model : undefined)
      if (!configs.length) {
        return new Response(JSON.stringify({ error: "LLM configuration key is missing" }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const attempt = await callAicreditsFallbacks(configs, systemPrompt, userPrompt)
      responseText = attempt.text
    }

    if (isDeepReview) {
      const result = parseDeepReviewResponse(
        responseText,
        taskId,
        taskTitle,
        branchName,
        commitHash,
        userTier,
      )
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ responseText }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err: unknown) {
    console.error('Edge Function Error:', err)
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
