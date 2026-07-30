import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const checkout = readFileSync(join(root, 'supabase/functions/dodo-checkout/index.ts'), 'utf8');
const webhook = readFileSync(join(root, 'supabase/functions/dodo-webhook/index.ts'), 'utf8');
const sidebar = readFileSync(join(root, 'src/TyneSidebarProvider.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/billingController.ts'), 'utf8');
const webview = readFileSync(join(root, 'media/tyne.js'), 'utf8');

describe('Dodo billing hardening', () => {
  it('creates checkout metadata from the authenticated profile', () => {
    assert.match(checkout, /metadata:\s*\{[\s\S]*user_id:\s*profile\.id[\s\S]*github_id:\s*profile\.github_id/);
    assert.match(checkout, /productId = plan === 'pro'/);
    assert.match(checkout, /DODO_API_KEY/);
    assert.doesNotMatch(checkout, /metadata:\s*body\.metadata/);
  });

  it('stores lifecycle fields and rejects unknown products', () => {
    for (const field of [
      'webhook_id',
      'dodo_subscription_id',
      'subscription_status',
      'current_period_end',
      'cancel_at_period_end',
      'billing_event_at',
    ]) {
      assert.ok(webhook.includes(field), `missing ${field}`);
    }
    assert.match(webhook, /Unknown Dodo product_id/);
    assert.match(webhook, /payload\.type \|\| payload\.event/);
  });

  it('starts authenticated checkout and refreshes the plan', () => {
    assert.match(sidebar, /case 'startBillingCheckout'/);
    assert.match(sidebar, /functions\/v1\/dodo-checkout/);
    assert.match(sidebar, /_startBillingProfileRefresh/);
    assert.match(webview, /startBillingCheckout\('pro'\)/);
    assert.match(webview, /startBillingCheckout\('max'\)/);
    assert.match(webview, /billingPlanUpdated/);
  });
});
