/**
 * Pure billing decision for a Dodo subscription webhook.
 *
 * Split out of `index.ts` so the money-critical branch can be tested directly
 * rather than asserted against source text. Nothing here touches the network,
 * the database, or Deno globals.
 *
 * The rule this encodes: a paid tier is granted only when the event proves
 * money was collected. Anything unrecognised holds the current tier — it never
 * grants, and it never demotes a paying customer on ambiguity.
 */

export type BillingAction = 'grant' | 'downgrade' | 'hold' | 'ignore';

export interface BillingDecision {
  action: BillingAction;
  /** Value to persist in `subscription_status`, when the action writes one. */
  subscriptionStatus: string | null;
  /** Why this decision was reached — surfaced in the webhook response. */
  reason: string;
}

/** Events that can carry an active, paid subscription. */
export const ACTIVE_EVENTS = new Set([
  'subscription.active',
  'subscription.renewed',
  'subscription.updated',
  'subscription.plan_changed',
]);

/** Events whose name alone proves the subscription is no longer paid. */
export const INACTIVE_EVENTS: Record<string, string> = {
  'subscription.on_hold': 'past_due',
  'subscription.failed': 'unpaid',
  'subscription.cancelled': 'canceled',
  'subscription.expired': 'expired',
};

/** Statuses that prove the subscription is no longer paid. */
export const INACTIVE_STATUSES: Record<string, string> = {
  on_hold: 'past_due',
  failed: 'unpaid',
  cancelled: 'canceled',
  canceled: 'canceled',
  expired: 'expired',
};

/**
 * Statuses that represent money actually collected.
 *
 * An ALLOWLIST on purpose. The original code demoted only the four failure
 * statuses it knew about and granted everything else, so `pending`,
 * `trialing`, `incomplete` — or any status Dodo adds later — was treated as a
 * successful payment. Unknown must mean "no upgrade", never "upgrade".
 */
export const PAID_STATUSES = new Set(['active', 'succeeded', 'paid']);

/**
 * Events that assert payment in the event name itself, so a payload with no
 * `status` field is still trustworthy. `subscription.updated` and
 * `subscription.plan_changed` fire throughout a subscription's life —
 * including before the first payment clears — so they are excluded.
 */
export const SELF_ASSERTING_EVENTS = new Set([
  'subscription.active',
  'subscription.renewed',
]);

export function decideBillingOutcome(input: {
  eventType: string;
  status?: string | null;
}): BillingDecision {
  const eventType = String(input.eventType || '');
  const status = String(input.status || '').toLowerCase();

  const inactive = INACTIVE_EVENTS[eventType] || INACTIVE_STATUSES[status];
  if (inactive) {
    return { action: 'downgrade', subscriptionStatus: inactive, reason: `inactive:${inactive}` };
  }

  if (!ACTIVE_EVENTS.has(eventType)) {
    return { action: 'ignore', subscriptionStatus: null, reason: `unhandled-event:${eventType}` };
  }

  const paymentConfirmed = status
    ? PAID_STATUSES.has(status)
    : SELF_ASSERTING_EVENTS.has(eventType);

  if (paymentConfirmed) {
    return { action: 'grant', subscriptionStatus: 'active', reason: 'payment-confirmed' };
  }

  // Recognised event, payment not proven. Record what we saw without moving
  // tier in either direction: granting would be a revenue leak, demoting would
  // punish an existing subscriber mid plan-change.
  return {
    action: 'hold',
    subscriptionStatus: status || 'pending',
    reason: status ? `unconfirmed-status:${status}` : `unconfirmed-event:${eventType}`,
  };
}
