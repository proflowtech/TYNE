import { assertEquals } from 'jsr:@std/assert@1';
import { decideBillingOutcome } from './decide.ts';

/**
 * These tests exist because the original webhook granted a paid tier on any
 * status it did not explicitly recognise as a failure. The regression they
 * guard is a revenue leak, so they are deliberately exhaustive about the
 * statuses that must NOT grant.
 */

Deno.test('grants only when payment is confirmed', () => {
  assertEquals(decideBillingOutcome({ eventType: 'subscription.active', status: 'active' }).action, 'grant');
  assertEquals(decideBillingOutcome({ eventType: 'subscription.renewed', status: 'active' }).action, 'grant');
  assertEquals(decideBillingOutcome({ eventType: 'subscription.updated', status: 'active' }).action, 'grant');
  assertEquals(decideBillingOutcome({ eventType: 'subscription.plan_changed', status: 'active' }).action, 'grant');
});

Deno.test('self-asserting events may omit status; ambiguous events may not', () => {
  // The event name itself proves payment for these two.
  assertEquals(decideBillingOutcome({ eventType: 'subscription.active' }).action, 'grant');
  assertEquals(decideBillingOutcome({ eventType: 'subscription.renewed' }).action, 'grant');
  // These fire throughout a subscription's life, including pre-payment.
  assertEquals(decideBillingOutcome({ eventType: 'subscription.updated' }).action, 'hold');
  assertEquals(decideBillingOutcome({ eventType: 'subscription.plan_changed' }).action, 'hold');
});

Deno.test('THE LEAK: unconfirmed statuses must never grant a paid tier', () => {
  // Every one of these previously fell through the denylist and granted MAX.
  for (const status of ['pending', 'trialing', 'incomplete', 'past_due', 'processing', 'requires_action', '']) {
    for (const eventType of ['subscription.updated', 'subscription.plan_changed']) {
      const decision = decideBillingOutcome({ eventType, status });
      assertEquals(
        decision.action,
        'hold',
        `${eventType} with status "${status}" must not grant (got ${decision.action})`,
      );
    }
  }
});

Deno.test('a status Dodo has not invented yet still does not grant', () => {
  const decision = decideBillingOutcome({ eventType: 'subscription.updated', status: 'some_future_status' });
  assertEquals(decision.action, 'hold');
});

Deno.test('failed and cancelled payments downgrade to CORE', () => {
  const cases: Array<[string, string, string]> = [
    ['subscription.failed', '', 'unpaid'],
    ['subscription.cancelled', '', 'canceled'],
    ['subscription.on_hold', '', 'past_due'],
    ['subscription.expired', '', 'expired'],
    // Status-carried failures on an otherwise "active" event name.
    ['subscription.updated', 'failed', 'unpaid'],
    ['subscription.updated', 'cancelled', 'canceled'],
    ['subscription.updated', 'expired', 'expired'],
  ];
  for (const [eventType, status, expectedStatus] of cases) {
    const decision = decideBillingOutcome({ eventType, status });
    assertEquals(decision.action, 'downgrade', `${eventType}/${status} should downgrade`);
    assertEquals(decision.subscriptionStatus, expectedStatus);
  }
});

Deno.test('a failure status outranks an active-looking event name', () => {
  // Ordering matters: the denylist is consulted before the allowlist, so a
  // cancelled subscription cannot be resurrected by a stray `active` event.
  assertEquals(decideBillingOutcome({ eventType: 'subscription.active', status: 'cancelled' }).action, 'downgrade');
});

Deno.test('hold never clears tier or credits', () => {
  // The caller keys off `action`; hold must be distinguishable from downgrade
  // so an existing subscriber is not demoted mid plan-change.
  const held = decideBillingOutcome({ eventType: 'subscription.updated', status: 'pending' });
  assertEquals(held.action, 'hold');
  assertEquals(held.subscriptionStatus, 'pending');
});

Deno.test('unrelated events are ignored entirely', () => {
  assertEquals(decideBillingOutcome({ eventType: 'payment.succeeded', status: 'active' }).action, 'ignore');
  assertEquals(decideBillingOutcome({ eventType: '', status: '' }).action, 'ignore');
});
