import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyWebhookSignature } from './verify.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const secret = Deno.env.get('DODO_WEBHOOK_SECRET')
    if (!secret) {
      throw new Error("Missing DODO_WEBHOOK_SECRET")
    }

    const isValid = await verifyWebhookSignature(req, secret)
    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid webhook signature" }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Re-create the request with the same body because we already consumed it for signature verification.
    const rawBody = await req.text()
    const payload = JSON.parse(rawBody)
    console.log("Received Dodo Webhook payload:", rawBody)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing Supabase configuration")
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const PRO_PRODUCT_ID = Deno.env.get('DODO_PRO_PRODUCT_ID')
    const MAX_PRODUCT_ID = Deno.env.get('DODO_MAX_PRODUCT_ID')
    if (!PRO_PRODUCT_ID || !MAX_PRODUCT_ID) {
      throw new Error("Missing DODO_PRO_PRODUCT_ID or DODO_MAX_PRODUCT_ID")
    }

    // Log the event in public.webhook_events
    const eventType = payload.event || payload.event_type || 'unknown'
    const { error: logErr } = await supabase
      .from('webhook_events')
      .insert({
        provider: 'dodo',
        event_type: eventType,
        payload: payload,
        processed: false
      })

    if (logErr) {
      console.error("Error logging webhook event:", logErr)
    }

    const data = payload.data || {}
    const productId = data.product_id
    const customerId = data.customer_id || data.customer?.id
    const metadata = data.metadata || {}
    const githubId = metadata.github_id ? String(metadata.github_id) : null

    if (eventType === 'subscription.active' || eventType === 'subscription.updated') {
      if (!githubId) {
        throw new Error("Missing github_id in metadata for active/updated subscription")
      }

      let tier = 'CORE'
      let credits = 0

      if (productId === PRO_PRODUCT_ID) {
        tier = 'PRO'
      } else if (productId === MAX_PRODUCT_ID) {
        tier = 'MAX'
        credits = 100
      }

      // Update the user's profile
      const { error: updateErr } = await supabase
        .from('user_profiles')
        .update({
          tier: tier,
          dodo_customer_id: customerId,
          api_credits_remaining: credits,
          updated_at: new Date().toISOString()
        })
        .eq('github_id', githubId)

      if (updateErr) {
        throw new Error(`Failed to update user profile tier: ${updateErr.message}`)
      }

      console.log(`Successfully updated user ${githubId} to tier ${tier} with ${credits} credits`)

    } else if (eventType === 'subscription.cancelled' || eventType === 'subscription.expired') {
      // Find the user by githubId or customerId
      let query = supabase.from('user_profiles').update({
        tier: 'CORE',
        api_credits_remaining: 0,
        updated_at: new Date().toISOString()
      })

      if (githubId) {
        query = query.eq('github_id', githubId)
      } else if (customerId) {
        query = query.eq('dodo_customer_id', customerId)
      } else {
        throw new Error("Cannot identify user to cancel subscription: missing github_id and customer_id")
      }

      const { error: cancelErr } = await query

      if (cancelErr) {
        throw new Error(`Failed to cancel user subscription: ${cancelErr.message}`)
      }

      console.log(`Successfully cancelled subscription for customer ${customerId} (github: ${githubId})`)
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err: unknown) {
    console.error('Dodo Webhook Error:', err)
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
