import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyWebhookSignature } from './verify.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let eventLogId: string | null = null
  let supabase: any
  try {
    const secret = Deno.env.get('DODO_WEBHOOK_SECRET')
    if (!secret) throw new Error('Missing DODO_WEBHOOK_SECRET')

    if (!await verifyWebhookSignature(req, secret)) {
      return json({ error: 'Invalid webhook signature' }, 401)
    }

    const rawBody = await req.text()
    const payload = JSON.parse(rawBody) as Record<string, any>
    const webhookId = req.headers.get('webhook-id')!
    const eventType = String(payload.type || payload.event || payload.event_type || 'unknown')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseServiceKey) throw new Error('Missing Supabase configuration')
    supabase = createClient(supabaseUrl, supabaseServiceKey)

    const PRO_PRODUCT_ID = Deno.env.get('DODO_PRO_PRODUCT_ID')
    const MAX_PRODUCT_ID = Deno.env.get('DODO_MAX_PRODUCT_ID')
    if (!PRO_PRODUCT_ID || !MAX_PRODUCT_ID) throw new Error('Missing Dodo product configuration')

    const { data: prior } = await supabase
      .from('webhook_events')
      .select('id, processed')
      .eq('provider', 'dodo')
      .eq('webhook_id', webhookId)
      .maybeSingle()
    if (prior?.processed) return json({ success: true, duplicate: true })

    if (prior?.id) {
      eventLogId = prior.id
    } else {
      const { data: logged, error } = await supabase
        .from('webhook_events')
        .insert({
          provider: 'dodo',
          webhook_id: webhookId,
          event_type: eventType,
          payload,
          processed: false,
        })
        .select('id')
        .single()
      if (error) {
        // A concurrent delivery may have won the unique webhook-id insert.
        if (error.code === '23505') return json({ success: true, duplicate: true })
        throw error
      }
      eventLogId = logged.id
    }
    if (!eventLogId) throw new Error('Failed to create webhook event log')

    const data = payload.data || {}
    const productId = String(data.product_id || data.product?.product_id || '')
    const subscriptionId = String(data.subscription_id || data.id || '')
    const customerId = String(data.customer_id || data.customer?.customer_id || data.customer?.id || '')
    const metadata = data.metadata || {}
    const userId = typeof metadata.user_id === 'string' ? metadata.user_id : ''
    const githubId = metadata.github_id == null ? '' : String(metadata.github_id)
    const eventAt = validDate(payload.timestamp || data.updated_at || data.created_at) || new Date().toISOString()

    const activeEvents = new Set([
      'subscription.active',
      'subscription.renewed',
      'subscription.updated',
      'subscription.plan_changed',
    ])
    const inactiveStatus: Record<string, string> = {
      'subscription.on_hold': 'past_due',
      'subscription.failed': 'unpaid',
      'subscription.cancelled': 'canceled',
      'subscription.expired': 'expired',
    }
    const statusFallback: Record<string, string> = {
      on_hold: 'past_due',
      failed: 'unpaid',
      cancelled: 'canceled',
      canceled: 'canceled',
      expired: 'expired',
    }
    const inactive = inactiveStatus[eventType] || statusFallback[String(data.status || '').toLowerCase()]

    if (activeEvents.has(eventType) || inactive) {
      if (!userId && !githubId && !customerId) {
        throw new Error('Cannot identify subscription owner')
      }

      let profileQuery = supabase
        .from('user_profiles')
        .select('id, tier, billing_event_at')
      if (userId) profileQuery = profileQuery.eq('id', userId)
      else if (githubId) profileQuery = profileQuery.eq('github_id', githubId)
      else profileQuery = profileQuery.eq('dodo_customer_id', customerId)

      const { data: profile, error: profileError } = await profileQuery.maybeSingle()
      if (profileError) throw profileError
      if (!profile) throw new Error('User profile not found for subscription')

      if (profile.billing_event_at && Date.parse(profile.billing_event_at) > Date.parse(eventAt)) {
        await markProcessed(supabase, eventLogId)
        return json({ success: true, stale: true })
      }

      const update: Record<string, unknown> = {
        dodo_customer_id: customerId || null,
        dodo_subscription_id: subscriptionId || null,
        billing_event_at: eventAt,
        updated_at: new Date().toISOString(),
      }

      if (activeEvents.has(eventType) && !inactive) {
        const tier = productId === PRO_PRODUCT_ID
          ? 'PRO'
          : productId === MAX_PRODUCT_ID
            ? 'MAX'
            : null
        if (!tier) throw new Error(`Unknown Dodo product_id: ${productId || '(missing)'}`)

        update.tier = tier
        update.subscription_status = 'active'
        update.pending_tier = null
        update.cancel_at_period_end = Boolean(data.cancel_at_next_billing_date ?? data.cancel_at_period_end)
        const periodEnd = validDate(data.next_billing_date || data.current_period_end)
        const startedAt = validDate(data.created_at || data.subscription_start)
        if (periodEnd) update.current_period_end = periodEnd
        if (startedAt) update.subscription_start = startedAt

        if (tier === 'PRO') update.api_credits_remaining = 0
        if (tier === 'MAX' && (profile.tier !== 'MAX' || eventType === 'subscription.renewed')) {
          update.api_credits_remaining = 100
        }
      } else {
        update.tier = 'CORE'
        update.api_credits_remaining = 0
        update.subscription_status = inactive
        update.pending_tier = null
        update.cancel_at_period_end = inactive === 'canceled'
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update(update)
        .eq('id', profile.id)
      if (updateError) throw updateError
    }

    await markProcessed(supabase, eventLogId)
    return json({ success: true })
  } catch (err: unknown) {
    console.error('Dodo Webhook Error:', err)
    const message = err instanceof Error ? err.message : String(err)
    if (supabase && eventLogId) {
      await supabase.from('webhook_events').update({ error: message }).eq('id', eventLogId)
    }
    return json({ error: message }, 400)
  }
})

function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

async function markProcessed(supabase: any, id: string): Promise<void> {
  const { error } = await supabase
    .from('webhook_events')
    .update({ processed: true, processed_at: new Date().toISOString(), error: null })
    .eq('id', id)
  if (error) throw error
}
