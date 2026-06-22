import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    const { gitDiff, goal, taskId, subtasks, feature, byokKey, byokProvider } = await req.json()

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
      .select('*')
      .eq('github_id', githubId)
      .maybeSingle()

    const userTier = profile?.tier || 'CORE'
    const creditsRemaining = profile?.api_credits_remaining || 0

    // Handle Profile Fetch Request
    if (requestFeature === 'profile') {
      return new Response(JSON.stringify({ tier: userTier, credits: creditsRemaining, githubId, githubUsername }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 6. ENFORCE MULTI-TIER SECURITY RULES
    if (userTier === 'CORE') {
      if (!byokKey) {
        return new Response(JSON.stringify({ error: "Free Tier requires your own API Key (BYOK)." }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    } else if (userTier === 'PRO') {
      if (requestFeature === 'deep-review') {
        return new Response(JSON.stringify({ error: "Deep Goal Tracking & Code Review requires the MAX plan." }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    } else if (userTier === 'MAX') {
      if (requestFeature === 'deep-review' && !byokKey) {
        if (creditsRemaining <= 0) {
          return new Response(JSON.stringify({ error: "MAX API credits exhausted. Use BYOK or wait until next month." }), {
            status: 402,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
        
        // Decrement credit atomically
        const { error: decErr } = await supabase
          .rpc('decrement_user_credits', { p_github_id: githubId })
        
        if (decErr) {
          console.error("Error decrementing credits:", decErr)
          return new Response(JSON.stringify({ error: "Failed to process credits decrement" }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }
    }

    // 7. Route LLM Call
    let responseText = ''
    const useBYOK = Boolean(byokKey)
    const provider = useBYOK ? (byokProvider || 'claude') : 'claude'
    const activeKey = useBYOK ? byokKey : Deno.env.get('ANTHROPIC_API_KEY')

    if (!activeKey) {
      return new Response(JSON.stringify({ error: "LLM configuration key is missing" }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let systemPrompt = ''
    let userPrompt = ''

    if (requestFeature === 'deep-review') {
      const subtaskList = (subtasks || [])
        .map((s: any, i: number) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`)
        .join('\n')
      
      systemPrompt = "You are a code review assistant. Analyze if the code changes complete the stated goal and subtasks."
      userPrompt = `GOAL: ${goal || 'Verify tasks'}

SUBTASKS:
${subtaskList || '- none'}

CODE CHANGES (git diff):
\`\`\`
${gitDiff || '(no changes)'}
\`\`\`

Respond ONLY with valid JSON in this exact format:
{
  "overall": "pass" | "fail" | "partial",
  "summary": "one sentence summary",
  "results": [
    { "subtask": "exact subtask text", "passed": true/false, "reason": "brief reason" }
  ]
}`
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
          model: "claude-3-haiku-20240307",
          max_tokens: 1024,
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
