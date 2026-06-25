import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function recordValidationUsage(supabase: any, userId: string): Promise<{ allowed: boolean; used: number; limit: number | null; remaining: number | null }> {
  const { data, error } = await supabase.rpc('record_validation', {
    uid: userId,
    p_tokens: 0,
    p_cost: 0,
    p_metadata: {}
  })
  if (error) {
    console.error('record_validation error:', error)
    return { allowed: false, used: 0, limit: null, remaining: null }
  }
  return data as { allowed: boolean; used: number; limit: number | null; remaining: number | null }
}

function parseDeepReviewResponse(
  rawText: string,
  taskId: string,
  taskTitle: string,
  branchName: string,
  commitHash: string,
  userTier: string,
): Record<string, unknown> {
  const cleaned = rawText.replace(/```json\s*|\s*```/g, '').trim()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    // Fallback if LLM returns invalid JSON.
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
    const {
      gitDiff,
      goal,
      taskId,
      taskTitle,
      taskDescription,
      subtasks,
      acceptanceCriteria,
      branchName,
      commitHash,
      changedFiles,
      feature,
      byokKey,
      byokProvider,
    } = await req.json()

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
        if (!byokKey) {
          return new Response(JSON.stringify({ error: "Free Tier requires your own API Key (BYOK)." }), {
            status: 402,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      } else if (userTier === 'PRO') {
        // Managed deep-review is allowed for the first 50 validations each month.
        if (isManagedReview && profile?.id) {
          const usageRecord = await recordValidationUsage(supabase, profile.id)
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
    const provider = isDeepReview && byokKey ? (byokProvider || 'claude') : 'claude'
    const activeKey = isDeepReview && byokKey ? byokKey : Deno.env.get('ANTHROPIC_API_KEY')

    if (!activeKey) {
      return new Response(JSON.stringify({ error: "LLM configuration key is missing" }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

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
  "suggestions": ["string"] or omitted,
  "codeQualityNotes": ["string"] or omitted,
  "filesReviewed": ["string"] or omitted
}

Task: ${taskTitle || taskId || 'N/A'}
Task ID: ${taskId || 'N/A'}
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

    if (provider === 'openai') {
      const openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
        })
      })

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
      // Anthropic Claude
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': activeKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      })

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
