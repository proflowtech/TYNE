import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  resolveAicreditsLlmConfig,
  shouldTryNextAicreditsModel,
} from '../_shared/aicreditsModelPolicy.ts'
import { requireUserProfileId } from '../_shared/requireUserProfileId.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type ManagedLlmConfig = { provider: 'openai'; apiKey: string; baseUrl: string; model: string }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeTier(raw: unknown): 'free' | 'pro' | 'max' {
  const t = String(raw || '').toLowerCase()
  if (t === 'pro') return 'pro'
  if (t === 'max') return 'max'
  return 'free'
}

async function callOpenAiCompatible(config: ManagedLlmConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.4,
        max_tokens: 700,
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

async function callFallbacks(configs: ManagedLlmConfig[], systemPrompt: string, userPrompt: string): Promise<{ text: string; model: string }> {
  let lastError: unknown = null
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i]
    try {
      const text = await callOpenAiCompatible(config, systemPrompt, userPrompt)
      return { text, model: config.model }
    } catch (err) {
      lastError = err
      if (i === configs.length - 1 || !shouldTryNextAicreditsModel(err)) throw err
      console.warn(`pm-ship-comment: model "${config.model}" failed; trying next`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All ship-comment models failed')
}

const SYSTEM = `You write a concise Jira/Linear task update in the natural voice of a senior engineer speaking to teammates.
Return strict JSON: { "pmSummary": string, "techLeadNotes": string[], "statusLine": string }.
Rules:
- Sound like a real teammate posting a useful update: direct, calm, specific, and easy to scan.
- Avoid report language such as "close-out", "delivery summary", "residual risk", "ready for close", or "is delivered".
- No "we finished", excitement, AI references, marketing language, or claims about who did the work.
- pmSummary: 1-3 short sentences covering what changed, the acceptance outcome, and any known open item.
- techLeadNotes: 2-6 short bullets with only useful evidence. Prefix facts with labels such as "Branch:", "Commit:", "Review:", "Acceptance met:", or "Open:".
- statusLine: one of "Passed" / "Shipped with follow-ups" / "Shipped with validation incomplete" / "Shipped (validation not run)".
- Only use provided facts. Do not invent files, PRs, owners, or metrics.
- Keep total under 150 words across all fields.`

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const authHeader = req.headers.get('Authorization') || ''
    const machineId = req.headers.get('X-Machine-ID')
    const profile = await requireUserProfileId(supabase, authHeader, machineId)
    if ('error' in profile) return jsonResponse({ error: profile.error }, profile.status)

    const payload = await req.json().catch(() => ({})) as Record<string, unknown>
    const facts = (payload.facts && typeof payload.facts === 'object') ? payload.facts as Record<string, unknown> : {}
    const tier = normalizeTier(payload.tier)

    const configs = await resolveAicreditsLlmConfig('pm_ship_comment', tier, undefined, { maxCandidates: 3 })
    if (!configs.length) return jsonResponse({ error: 'LLM configuration missing' }, 500)

    const userPrompt = `Facts (JSON):\n${JSON.stringify(facts).slice(0, 6000)}\n\nWrite the close-out comment fields.`
    const { text, model } = await callFallbacks(configs as ManagedLlmConfig[], SYSTEM, userPrompt)
    const cleaned = text.replace(/```(?:json)?\s*|\s*```/g, '').trim()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>
    } catch {
      return jsonResponse({ error: 'Model returned invalid JSON', raw: cleaned.slice(0, 400) }, 502)
    }

    const pmSummary = typeof parsed.pmSummary === 'string' ? parsed.pmSummary.trim() : ''
    const statusLine = typeof parsed.statusLine === 'string' ? parsed.statusLine.trim() : ''
    const techLeadNotes = Array.isArray(parsed.techLeadNotes)
      ? parsed.techLeadNotes.map(n => String(n || '').trim()).filter(Boolean).slice(0, 6)
      : []

    if (!pmSummary) return jsonResponse({ error: 'Empty pmSummary from model' }, 502)

    return jsonResponse({
      pmSummary,
      techLeadNotes,
      statusLine,
      model,
    })
  } catch (err) {
    console.error('pm-ship-comment error:', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
