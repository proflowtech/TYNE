import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(__dirname, '../..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('hosted Core is the default without a BYOK key', () => {
  it('defaults aiAccessMode to hosted max, not byok', () => {
    const settings = read('src/sidebar/settingsByokController.ts');
    assert.match(settings, /'tyne\.aiAccessMode', 'max'/);
    assert.match(settings, /!byokOk \|\| \(storedAccess === 'byok' && !hasBYOKKey\) \? 'max'/);
    const webview = read('media/tyne.js');
    assert.match(webview, /aiAccessMode: 'max'/);
    assert.doesNotMatch(webview, /let aiSettings = \{ aiAccessMode: 'byok'/);
  });

  it('Free Settings has no BYOK form and names the Pro/Max gate', () => {
    const html = read('src/sidebar/sidebarHtml.ts');
    assert.match(html, /BYOK requires Pro or Max/);
    assert.match(html, /5 hosted Validate/);
    assert.doesNotMatch(html, /id="byokApiKey"/);
    assert.match(html, /id="byokApiKeyPremium"/);
    const settings = read('src/sidebar/settingsByokController.ts');
    assert.match(settings, /rejectByokIfBlocked/);
    assert.match(settings, /BYOK_REQUIRES_PAID_PLAN/);
  });

  it('Skip tour persists hosted mode and refreshes settings', () => {
    const onboarding = read('src/sidebar/onboardingController.ts');
    assert.match(onboarding, /skipTour[\s\S]*tyne\.aiAccessMode', 'max'/);
    const router = read('src/sidebar/messageRouter.ts');
    assert.match(router, /onboardingSkipTour['"][\s\S]*postSettings\(\)/);
  });

  it('weaving Thread primary is Run Review unless a BYOK key is actually in use', () => {
    const webview = read('media/tyne.js');
    assert.match(
      webview,
      /needsKey = aiSettings\.aiAccessMode === 'byok' && !aiSettings\.hasBYOKKey/,
    );
    const needsKey = (aiAccessMode: string, hasBYOKKey: boolean) =>
      aiAccessMode === 'byok' && !hasBYOKKey;
    assert.equal(needsKey('max', false) ? 'AI setup' : 'Run Review', 'Run Review');
    assert.equal(needsKey('byok', false) ? 'AI setup' : 'Run Review', 'AI setup');
    assert.equal(needsKey('byok', true) ? 'AI setup' : 'Run Review', 'Run Review');
  });

  it('premium BYOK key-test feedback uses the remaining status slot for all providers', () => {
    const webview = read('media/tyne.js');
    assert.match(webview, /const statusEl = \$\('byokStatusPremium'\) \|\| \$\('byokStatus'\)/);
    assert.doesNotMatch(webview, /msg\.provider === 'openai' \? \$\('byokStatusPremium'\) : \$\('byokStatus'\)/);
  });

  it('webview boot sends one ready signal and avoids duplicate profile refresh', () => {
    const webview = read('media/tyne.js');
    assert.doesNotMatch(webview, /WEBVIEW_READY/);
    assert.match(webview, /vscode\.postMessage\(\{ type: 'ready' \}\)/);
  });

  it('task list empty states provide direct recovery actions', () => {
    const webview = read('media/tyne.js');
    assert.match(webview, /data-task-empty-action="reconnect-jira"/);
    assert.match(webview, /data-task-empty-action="change-jira-project"/);
    assert.match(webview, /data-task-empty-action="clear-filters"/);
    assert.match(webview, /data-task-empty-action="connect-linear"/);
    assert.doesNotMatch(webview, /Open Output . Tyne: Jira for details, or use Change Project \/ Reconnect/);
  });

  it('keeps the sidebar UI compact and extension-native', () => {
    const css = read('media/tyne.css');
    assert.match(css, /Extension UX pass: keep Tyne feeling native to VS Code/);
    assert.match(css, /\.btn \{[\s\S]*?width: auto;[\s\S]*?min-height: 26px;[\s\S]*?letter-spacing: 0;/);
    assert.match(css, /\.card,[\s\S]*?\.analytics-card,[\s\S]*?#threadPage #proofSection,[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/);
    assert.match(css, /input:focus,[\s\S]*?#threadPage select:focus \{[\s\S]*?box-shadow: none;/);
  });

  it('keeps Validate & Review focused on the next decision', () => {
    const html = read('src/sidebar/sidebarHtml.ts');
    const webview = read('media/tyne.js');
    const css = read('media/tyne.css');
    assert.match(html, /class="vr-review-control-row"[\s\S]*?id="validateReviewScopeSelect"[\s\S]*?id="runValidateReviewBtn"/);
    assert.match(webview, /class="vr-summary-main"[\s\S]*?class="vr-summary-stats"/);
    assert.doesNotMatch(webview, /function renderScoreTicks\(/);
    assert.match(css, /Validate & Review: give the decision and the next action the first screen/);
    assert.match(css, /#validateReviewPage \.vr-review-control-row \{[\s\S]*?display: flex;/);
    assert.match(css, /\.vr-summary-card \{[\s\S]*?border-bottom: 1px solid var\(--border\);[\s\S]*?background: transparent;/);
  });
});
