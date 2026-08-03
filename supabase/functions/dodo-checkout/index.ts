import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-machine-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    // Accept either env name — dashboard historically used DODO_API_KEY.
    const apiKey = Deno.env.get('DODO_PAYMENTS_API_KEY') || Deno.env.get('DODO_API_KEY')
    const proProductId = Deno.env.get('DODO_PRO_PRODUCT_ID')
    const maxProductId = Deno.env.get('DODO_MAX_PRODUCT_ID')
    if (!supabaseUrl || !serviceRoleKey || !apiKey || !proProductId || !maxProductId) {
      return json({ error: 'Billing is not configured' }, 503)
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const token = authHeader.replace(/^bearer\s+/i, '').trim()
    const profile = await requireProfile(token, supabase)
    if (profile instanceof Response) return profile

    const body = await req.json().catch(() => ({})) as { plan?: unknown }
    const plan = String(body.plan || '').toLowerCase()
    const productId = plan === 'pro' ? proProductId : plan === 'max' ? maxProductId : null
    if (!productId) return json({ error: 'Plan must be pro or max' }, 400)

    // Existing subscribers must change plans through billing management to avoid
    // accidentally creating a second subscription.
    if (profile.dodo_subscription_id && profile.subscription_status === 'active') {
      return json({ checkout_url: 'https://tyne.proflowtech.io/account/billing', existing: true })
    }

    const environment = Deno.env.get('DODO_PAYMENTS_ENVIRONMENT') === 'test_mode'
      ? 'test'
      : 'live'
    const dodoResponse = await fetch(`https://${environment}.dodopayments.com/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: {
          email: profile.email,
          name: profile.github_username || profile.email,
        },
        metadata: {
          user_id: profile.id,
          github_id: profile.github_id,
        },
        return_url: Deno.env.get('DODO_RETURN_URL') || 'https://tyne.proflowtech.io/account/billing?checkout=success',
        cancel_url: Deno.env.get('DODO_CANCEL_URL') || 'https://tyne.proflowtech.io/upgrade?checkout=cancelled',
        feature_flags: { allow_discount_code: true },
      }),
    })

    const result = await dodoResponse.json().catch(() => ({})) as { checkout_url?: unknown; message?: unknown }
    if (!dodoResponse.ok) {
      console.error('Dodo checkout error:', dodoResponse.status, result)
      return json({ error: 'Could not start checkout' }, 502)
    }
    if (typeof result.checkout_url !== 'string' || !result.checkout_url.startsWith('https://')) {
      return json({ error: 'Dodo did not return a checkout URL' }, 502)
    }

    return json({ checkout_url: result.checkout_url })
  } catch (error) {
    console.error('Dodo checkout error:', error)
    return json({ error: 'Could not start checkout' }, 500)
  }
})

async function requireProfile(token: string, supabase: any): Promise<any | Response> {
  const { data: authData } = await supabase.auth.getUser(token)
  let query = supabase
    .from('user_profiles')
    .select('id, github_id, github_username, email, tier, dodo_subscription_id, subscription_status')

  if (authData.user?.id) {
    query = query.eq('id', authData.user.id)
  } else {
    const githubResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'Tyne-Backend',
      },
    })
    if (!githubResponse.ok) return json({ error: 'Invalid token or session' }, 401)
    const githubUser = await githubResponse.json() as { id?: string | number }
    query = query.eq('github_id', String(githubUser.id || ''))
  }

  const { data: profile, error } = await query.maybeSingle()
  if (error) throw error
  if (!profile?.id) return json({ error: 'User profile not found' }, 404)
  if (!profile.email) return json({ error: 'An account email is required for checkout' }, 400)
  return profile
}
