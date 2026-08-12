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
    const authHeader = req.headers.get('Authorization')
    const machineId = req.headers.get('X-Machine-ID')

    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.replace(/^bearer\s+/i, '').trim()
    const { action, tokens, cost, metadata } = await req.json()

    if (!action || (action !== 'check' && action !== 'record')) {
      return new Response(JSON.stringify({ error: "Invalid action. Use 'check' or 'record'." }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: "Missing Supabase configuration" }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

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

    let userId: string | null = null
    let tier = 'CORE'
    let profileData: { id: string; tier?: string | null; api_credits_remaining?: number | null; is_banned?: boolean | null } | null = null
    let authType: 'supabase_jwt' | 'github_token' = 'supabase_jwt'

    const { data: { user: sbUser }, error: sbUserErr } = await supabase.auth.getUser(token)
    if (sbUser && !sbUserErr) {
      userId = sbUser.id
      authType = 'supabase_jwt'
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id, tier, api_credits_remaining, is_banned')
        .eq('id', userId)
        .maybeSingle()
      profileData = profile
    } else if (token.split('.').length === 3) {
      // Expired/invalid session JWT — never probe GitHub with it.
      return new Response(JSON.stringify({ error: "Session expired. Sign in again." }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    } else {
      const ghUserRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'Tyne-Backend'
        }
      })

      if (!ghUserRes.ok) {
        return new Response(JSON.stringify({ error: "Invalid token or session" }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      authType = 'github_token'
      const ghUser = await ghUserRes.json()
      const githubId = String(ghUser.id)
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id, tier, api_credits_remaining, is_banned')
        .eq('github_id', githubId)
        .maybeSingle()
      profileData = profile
      if (profileData) userId = profileData.id
    }

    if (!userId || !profileData) {
      return new Response(JSON.stringify({ error: "User profile not found" }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    tier = profileData.tier || 'CORE'
    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'X-Tyne-Auth-Type': authType,
    }

    if (action === 'check') {
      const { data: usedCount, error: usageErr } = await supabase
        .rpc('validation_usage', { uid: userId })

      if (usageErr) {
        console.error('validation_usage error:', usageErr)
        return new Response(JSON.stringify({ error: "Failed to check usage" }), {
          status: 500,
          headers: responseHeaders
        })
      }

      const { data: limitData } = await supabase.rpc('tier_validation_limit', { t: tier })
      const limit = limitData
      const used = Number(usedCount) || 0

      return new Response(JSON.stringify({
        used,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used),
        tier,
        credits: profileData.api_credits_remaining,
        is_banned: !!profileData.is_banned,
        authType,
      }), {
        status: 200,
        headers: responseHeaders
      })
    }

    const { data: recordResult, error: recordErr } = await supabase
      .rpc('record_validation', {
        uid: userId,
        p_tokens: tokens || 0,
        p_cost: cost || 0,
        p_metadata: { ...(metadata || {}), auth_type: authType }
      })

    if (recordErr) {
      console.error('record_validation error:', recordErr)
      return new Response(JSON.stringify({ error: "Failed to record validation" }), {
        status: 500,
        headers: responseHeaders
      })
    }

    return new Response(JSON.stringify({ ...recordResult, authType, is_banned: !!profileData.is_banned }), {
      status: 200,
      headers: responseHeaders
    })

  } catch (err: unknown) {
    console.error('Usage Edge Function Error:', err)
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
