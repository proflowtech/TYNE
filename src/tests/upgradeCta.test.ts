import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(__dirname, '../..');
const webview = readFileSync(join(root, 'media/tyne.js'), 'utf8');
const html = readFileSync(join(root, 'src/TyneSidebarProvider.ts'), 'utf8');

function extractFn(name: string): string {
  const start = webview.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let i = webview.indexOf('{', start);
  let depth = 0;
  for (; i < webview.length; i++) {
    const ch = webview[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return webview.slice(start, i);
}

function loadHelpers() {
  const src = [
    extractFn('normalizedPlanTier'),
    extractFn('planTierLabel'),
    extractFn('freeTierUpgradeCopy'),
  ].join('\n');
  const sandbox: Record<string, unknown> = {
    userTier: 'UNKNOWN',
    state: { validateReviewResult: null, taskId: '', taskSource: 'Solo Mode' },
  };
  vm.runInNewContext(src + '\nthis.normalizedPlanTier=normalizedPlanTier;this.planTierLabel=planTierLabel;this.freeTierUpgradeCopy=freeTierUpgradeCopy;', sandbox);
  return sandbox as {
    userTier: string;
    state: { validateReviewResult: unknown; taskId: string; taskSource: string };
    normalizedPlanTier: () => string;
    planTierLabel: (t: string) => string;
    freeTierUpgradeCopy: (r: { tier?: string } | null) => string;
  };
}

describe('upgrade CTAs', () => {
  it('thread banner appears only for free-tier users on a gated result', () => {
    const h = loadHelpers();
    h.userTier = 'CORE';
    h.state.validateReviewResult = { id: 'r1' };
    assert.match(h.freeTierUpgradeCopy({ tier: 'free' }), /Upgrade to Pro/);
    h.state.validateReviewResult = null;
    assert.equal(h.freeTierUpgradeCopy({ status: 'pass' } as { tier?: string }), '');
    assert.match(h.freeTierUpgradeCopy({ tier: 'free' }), /Upgrade to Pro/);
  });

  it('banner does not appear for pro/max users', () => {
    const h = loadHelpers();
    h.state.validateReviewResult = { id: 'r1' };
    for (const tier of ['PRO', 'pro', 'MAX', 'max']) {
      h.userTier = tier;
      assert.equal(h.freeTierUpgradeCopy({ tier: 'free' }), '', tier);
      assert.equal(h.freeTierUpgradeCopy({ tier: String(tier).toLowerCase() }), '', tier);
    }
  });

  it('settings page shows correct tier label for all three tiers', () => {
    const h = loadHelpers();
    const cases: Array<[string, string, string]> = [
      ['CORE', 'free', 'Free'],
      ['free', 'free', 'Free'],
      ['PRO', 'pro', 'Pro'],
      ['MAX', 'max', 'Max'],
    ];
    for (const [raw, norm, label] of cases) {
      h.userTier = raw;
      assert.equal(h.normalizedPlanTier(), norm, raw);
      assert.equal(h.planTierLabel(norm), label, raw);
    }
    assert.match(html, /id="upgradePlanBtn"/);
    assert.match(html, /id="planMaxNote"/);
    assert.match(html, /You're on the Max plan/);
    assert.match(webview, /setShown\('upgradePlanBtn'/);
    assert.match(webview, /setShown\('manageBillingBtn', plan === 'max'\)/);
  });

  it('both upgrade buttons open the correct URL via openExternal', () => {
    assert.match(webview, /function openUpgradePage\(\)/);
    assert.match(webview, /openExternal',\s*url:\s*'https:\/\/tyne\.proflowtech\.io\/upgrade'/);
    assert.match(webview, /openExternal',\s*url:\s*'https:\/\/tyne\.proflowtech\.io\/account\/billing'/);
    assert.match(webview, /valUpgradeCtaBtn[\s\S]*openUpgradePage/);
    assert.match(webview, /upgradePlanBtn[\s\S]*openUpgradePage/);
    assert.doesNotMatch(
      extractFn('openUpgradePage') + extractFn('openBillingPage'),
      /fetch\(|dodo-checkout|startBillingCheckout/,
    );
  });

  it('adds no new network calls beyond existing profile fetch', () => {
    assert.match(webview, /scorecard-upgrade-cta/);
    assert.doesNotMatch(webview, /functions\/v1\/.*upgrade/);
    assert.doesNotMatch(extractFn('freeTierUpgradeCopy'), /fetch\(/);
  });
});
