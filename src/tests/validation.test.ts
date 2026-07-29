import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCurrentMonth,
  getLimitForTier,
  getResetAt,
  isLimited,
  normalizeTier,
  sanitizeDiff,
  statusClass,
  statusLabel,
  capitalize,
  formatDate,
  formatHistoryLine,
  exportCsv,
  exportJson,
  buildExportFileName,
  calculatePassRate,
  calculateAverageMatch,
  calculateAverageRiskLevel,
  calculateTrendDirection,
  limitHistoryForTier,
  matchesHistoryFilters,
} from '../validationUtils';
import { isInvalidGitHubTokenResponse, GitHubTokenInvalidError } from '../githubAuthUtils';
import { parseValidationResponse } from '../aiProviders/validationPrompt';
import { extractAcceptanceCriteriaFromText, jiraDocToPlainText } from '../jiraTextUtils';
import { ValidationDisplayService } from '../validationDisplayService';
import { TyneValidationResult } from '../validationTypes';
import { getValidationTraceService } from '../validationTraceService';
import {
  canUseOneTimeOAuthRecord,
  chunkAtlassianAccountReports,
  hashOAuthSecret,
  inferJiraProjectKey,
  shouldEraseAtlassianPersonalData,
  sortJiraProjectsForSuggestion,
} from '../jiraOAuthSecurity';

function createResult(overrides: Partial<TyneValidationResult> = {}): TyneValidationResult {
  return {
    id: 'r1',
    provider: 'anthropic',
    tier: 'free',
    status: 'pass',
    summary: 'Code matches the goal.',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Validation usage limit helpers', () => {
  it('returns free tier limit of 5', () => {
    assert.equal(getLimitForTier('free'), 5);
  });

  it('returns pro tier limit of 50', () => {
    assert.equal(getLimitForTier('pro'), 50);
  });

  it('returns unlimited for max and byok unlimited', () => {
    assert.equal(getLimitForTier('max'), 'unlimited');
    assert.equal(getLimitForTier('free', true), 'unlimited');
  });

  it('isLimited narrows correctly', () => {
    assert.equal(isLimited(5), true);
    assert.equal(isLimited('unlimited'), false);
  });

  it('computes current month as YYYY-MM', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    assert.equal(getCurrentMonth(), expected);
  });

  it('computes reset date as first day of next month', () => {
    const reset = getResetAt('2026-06');
    assert.ok(reset.startsWith('2026-07-01'));
  });
});

describe('Validation display helpers', () => {
  it('free view hides enhanced fields', () => {
    const svc = new ValidationDisplayService();
    const result = createResult({
      status: 'partial',
      matchPercent: 72,
      riskLevel: 'medium',
      detailedExplanation: 'Detailed',
      missingRequirements: ['Missing'],
    });
    const view = svc.toFreeValidationView(result);
    assert.equal(view.status, 'partial');
    assert.equal(view.summary, 'Code matches the goal.');
    assert.equal('matchPercent' in view, false);
    assert.equal('riskLevel' in view, false);
  });

  it('enhanced view includes all fields', () => {
    const svc = new ValidationDisplayService();
    const result = createResult({
      status: 'partial',
      matchPercent: 72,
      riskLevel: 'medium',
      detailedExplanation: 'Detailed',
      missingRequirements: ['Missing'],
    });
    const view = svc.toEnhancedValidationView(result);
    assert.equal(view.matchPercent, 72);
    assert.equal(view.riskLevel, 'medium');
    assert.equal(view.detailedExplanation, 'Detailed');
  });

  it('formats usage summary', () => {
    const svc = new ValidationDisplayService();
    assert.equal(svc.formatUsageSummary({ used: 3, limit: 5, remaining: 2, isWarning: false, isBlocked: false, byokUnlimitedActive: false }), 'Validations: 3/5');
    assert.equal(svc.formatUsageSummary({ used: 0, limit: 'unlimited', remaining: 'unlimited', isWarning: false, isBlocked: false, byokUnlimitedActive: true }), 'Validations: Unlimited');
  });

  it('thread validation counter uses live Max usage instead of sticky Core 5/5', () => {
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    const host = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
    const usage = readFileSync(join(process.cwd(), 'src/validationUsageService.ts'), 'utf8');
    assert.ok(webview.includes('function applyValidationUsageCounts'), 'must apply usage counts from host payload');
    assert.ok(!webview.includes('s.validationUsage && valCountRemaining === null'), 'must not freeze the first Core fallback forever');
    assert.ok(webview.includes("userTier === 'MAX' || userTier === 'max'"), 'Max tier must render unlimited validations');
    assert.ok(webview.includes('Validations: \\u221E (unlimited)'), 'must show unlimited for Max');
    assert.ok(host.includes('Re-post after the real tier is known'), 'profile hydrate must refresh usage settings');
    assert.ok(usage.includes('data.limit == null ? \'unlimited\''), 'null server limit must map to unlimited');
  });

  it('labels statuses', () => {
    assert.equal(statusLabel('pass'), 'Pass');
    assert.equal(statusLabel('fail'), 'Fail');
    assert.equal(statusLabel('partial'), 'Partial');
  });

  it('classes statuses', () => {
    assert.equal(statusClass('pass'), 'good');
    assert.equal(statusClass('fail'), 'bad');
    assert.equal(statusClass('partial'), 'warn');
  });

  it('capitalizes values', () => {
    assert.equal(capitalize('low'), 'Low');
    assert.equal(capitalize('Medium'), 'Medium');
  });

  it('formats dates', () => {
    const iso = '2026-06-15T10:30:00.000Z';
    assert.equal(formatDate(iso), '2026-06-15');
    assert.equal(formatDate('invalid'), 'invalid');
  });
});

describe('Validation response parser', () => {
  it('parses valid enhanced response', () => {
    const result = parseValidationResponse(
      JSON.stringify({
        status: 'partial',
        matchPercent: 72,
        riskLevel: 'medium',
        summary: 'Partial match.',
        detailedExplanation: 'Missing reset email.',
        missingRequirements: ['Reset email'],
        criteriaMet: ['User can request a reset link'],
        criteriaNotMet: [{ criterion: 'Reset email is sent', reason: 'No mailer change is present.' }],
        suggestions: ['Add expiry'],
        codeQualityNotes: ['Clean'],
        filesReviewed: ['src/auth.ts'],
      }),
      { tier: 'pro', changedFiles: ['src/auth.ts'], diffText: '' },
      'anthropic',
    );
    assert.equal(result.status, 'partial');
    assert.equal(result.matchPercent, 72);
    assert.equal(result.riskLevel, 'medium');
    assert.equal(result.missingRequirements?.[0], 'Reset email');
    assert.equal(result.criteriaMet?.[0], 'User can request a reset link');
    assert.equal(result.criteriaNotMet?.[0]?.criterion, 'Reset email is sent');
  });

  it('parses valid free response', () => {
    const result = parseValidationResponse(
      JSON.stringify({ status: 'pass', summary: 'Good.' }),
      { tier: 'free', changedFiles: [], diffText: '' },
      'anthropic',
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.summary, 'Good.');
    assert.equal(result.detailedExplanation, undefined);
  });

  it('throws on malformed JSON', () => {
    assert.throws(
      () => parseValidationResponse('not json', { tier: 'free', changedFiles: [], diffText: '' }, 'anthropic'),
      /invalid response/,
    );
  });

  it('defaults missing status to partial', () => {
    const result = parseValidationResponse(
      JSON.stringify({ summary: 'Ok.' }),
      { tier: 'free', changedFiles: [], diffText: '' },
      'anthropic',
    );
    assert.equal(result.status, 'partial');
  });
});

describe('Diff sanitization', () => {
  it('excludes lockfiles and node_modules', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '+code',
      'diff --git a/package-lock.json b/package-lock.json',
      '+lock',
      'diff --git a/node_modules/foo/bar.js b/node_modules/foo/bar.js',
      '+mod',
    ].join('\n');
    const sanitized = sanitizeDiff(diff);
    assert.ok(sanitized.includes('src/index.ts'));
    assert.ok(!sanitized.includes('package-lock.json'));
    assert.ok(!sanitized.includes('node_modules/foo'));
  });

  it('keeps regular source files', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '+export const app = 1;',
      'diff --git a/README.md b/README.md',
      '+docs',
    ].join('\n');
    const sanitized = sanitizeDiff(diff);
    assert.ok(sanitized.includes('src/app.ts'));
    assert.ok(sanitized.includes('README.md'));
  });
});

describe('Jira text helpers', () => {
  it('converts Atlassian document format into readable plain text', () => {
    const text = jiraDocToPlainText({
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Acceptance Criteria' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Show the validation card' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Include a score badge' }] }] },
          ],
        },
      ],
    });
    assert.ok(text.includes('Acceptance Criteria'));
    assert.ok(text.includes('- Show the validation card'));
    assert.ok(text.includes('- Include a score badge'));
  });

  it('extracts acceptance criteria from plain text', () => {
    const parsed = extractAcceptanceCriteriaFromText([
      'Implement validation results in the sidebar.',
      '',
      'Acceptance Criteria',
      '- Show criteria met',
      '- Show criteria not met',
      '',
      'Notes',
      'Keep the card compact.',
    ].join('\n'));
    assert.deepEqual(parsed.criteria, ['Show criteria met', 'Show criteria not met']);
  });
});

describe('Jira OAuth security helpers', () => {
  it('hashes OAuth state and exchange codes instead of storing raw values', () => {
    const raw = 'state-secret';
    const hashed = hashOAuthSecret(raw);
    assert.notEqual(hashed, raw);
    assert.equal(hashed.length, 64);
    assert.equal(hashOAuthSecret(raw), hashed);
  });

  it('rejects consumed and expired one-time OAuth records', () => {
    const now = Date.parse('2026-06-27T00:00:00.000Z');
    assert.equal(canUseOneTimeOAuthRecord({ expiresAt: '2026-06-27T00:05:00.000Z' }, now), true);
    assert.equal(canUseOneTimeOAuthRecord({ expiresAt: '2026-06-27T00:05:00.000Z', consumedAt: '2026-06-27T00:01:00.000Z' }, now), false);
    assert.equal(canUseOneTimeOAuthRecord({ expiresAt: '2026-06-26T23:59:00.000Z' }, now), false);
  });

  it('limits Atlassian personal data report batches to 90 accounts', () => {
    const accounts = Array.from({ length: 181 }, (_, index) => ({
      accountId: `account-${index}`,
      updatedAt: '2026-06-27T00:00:00.000Z',
    }));
    const chunks = chunkAtlassianAccountReports(accounts);
    assert.deepEqual(chunks.map(chunk => chunk.length), [90, 90, 1]);
    assert.throws(() => chunkAtlassianAccountReports(accounts, 91), /1 to 90/);
  });

  it('detects closed Atlassian accounts for personal data erasure', () => {
    assert.equal(shouldEraseAtlassianPersonalData('closed'), true);
    assert.equal(shouldEraseAtlassianPersonalData(' CLOSED '), true);
    assert.equal(shouldEraseAtlassianPersonalData('updated'), false);
  });

  it('migration includes personal data reporting columns and OAuth replay tables', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260626202345_harden_jira_oauth_privacy.sql'), 'utf8');
    assert.match(sql, /atlassian_account_id text/i);
    assert.match(sql, /personal_data_last_reported_at timestamptz/i);
    assert.match(sql, /create table if not exists public\.jira_oauth_states/i);
    assert.match(sql, /create table if not exists public\.jira_oauth_exchanges/i);
  });

  it('legacy token endpoint does not return refresh tokens', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/get-jira-tokens/index.ts'), 'utf8');
    assert.doesNotMatch(source, /refresh_token/);
    assert.match(source, /Deprecated endpoint/);
  });

  it('completion endpoint requires an exchange code and never returns Jira tokens', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/complete-jira-oauth-exchange/index.ts'), 'utf8');
    assert.match(source, /Missing exchange code/);
    assert.match(source, /consumed_at/);
    assert.doesNotMatch(source, /access_token/);
    assert.doesNotMatch(source, /refresh_token/);
  });

  it('Jira hosted OAuth start returns the Atlassian auth URL from Supabase', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/jira-oauth-state/index.ts'), 'utf8');
    assert.match(source, /JIRA_CLIENT_ID/);
    assert.match(source, /auth_url/);
    assert.match(source, /offline_access/);
    assert.match(source, /state_hash/);
  });

  it('VS Code Jira connection no longer requires a contributed Jira client ID', () => {
    const manifest = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.doesNotMatch(manifest, /tyne\.jira\.clientId/);
    assert.doesNotMatch(provider, /Set `tyne\.jira\.clientId`/);
    assert.doesNotMatch(webview, /Set `tyne\.jira\.clientId`/);
    assert.doesNotMatch(webview, /Set Jira client ID/);
  });

  it('infers Jira project key from branch name before repository name', () => {
    assert.equal(inferJiraProjectKey(['feature/TYNE-123-auto-discovery', 'backend']), 'TYNE');
    assert.equal(inferJiraProjectKey(['main', 'proflow']), 'PROFLOW');
  });

  it('sorts suggested Jira project first', () => {
    const projects = [
      { id: '2', key: 'BE', name: 'Backend', cloudId: 'cloud' },
      { id: '1', key: 'TYNE', name: 'Tyne', cloudId: 'cloud' },
    ];
    assert.equal(sortJiraProjectsForSuggestion(projects, 'TYNE')[0].key, 'TYNE');
  });

  it('project mapping migration creates repo-to-project table and indexes', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260627063010_add_jira_site_project_mapping.sql'), 'utf8');
    assert.match(sql, /create table if not exists public\.jira_project_mappings/i);
    assert.match(sql, /unique\(user_id, repository_id, cloud_id, project_id\)/i);
    assert.match(sql, /idx_jira_project_mappings_repository_id/i);
  });

  it('list-jira-projects implements server-side Jira project pagination', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/list-jira-projects/index.ts'), 'utf8');
    assert.match(source, /project\/search/);
    assert.match(source, /while \(projects\.length < total/);
    assert.match(source, /refreshConnectionIfNeeded/);
  });

  it('save-jira-project-mapping validates selected project before saving', () => {
    const source = readFileSync(join(process.cwd(), 'supabase/functions/save-jira-project-mapping/index.ts'), 'utf8');
    assert.match(source, /projectRes\.ok/);
    assert.match(source, /Selected Jira project does not match Jira response/);
    assert.doesNotMatch(source, /refresh_token/);
  });

  it('Atlassian report OAuth migration stores credentials behind service-role RLS', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260627070704_add_atlassian_report_oauth_credentials.sql'), 'utf8');
    assert.match(sql, /create table if not exists public\.atlassian_report_credentials/i);
    assert.match(sql, /refresh_token text not null/i);
    assert.match(sql, /alter table public\.atlassian_report_credentials enable row level security/i);
    assert.match(sql, /to service_role/i);
    assert.match(sql, /revoke all on table public\.atlassian_report_credentials from anon, authenticated/i);
  });

  it('Atlassian report OAuth uses a service secret and offline access, never returns tokens to the UI', () => {
    const start = readFileSync(join(process.cwd(), 'supabase/functions/atlassian-report-oauth-start/index.ts'), 'utf8');
    const callback = readFileSync(join(process.cwd(), 'supabase/functions/atlassian-report-oauth-callback/index.ts'), 'utf8');
    assert.match(start, /offline_access/);
    // Admin reporting start now authorizes via an internal service secret, not a GitHub admin profile.
    assert.match(start, /x-internal-secret/);
    assert.match(start, /ATLASSIAN_REPORTING_SETUP_SECRET/);
    assert.match(start, /ATLASSIAN_REPORTING_REDIRECT_URI/);
    assert.doesNotMatch(start, /api\.github\.com/);
    assert.doesNotMatch(start, /Invalid GitHub token/);
    assert.doesNotMatch(start, /access_token:/);
    assert.match(callback, /access_token: accessToken/);
    assert.match(callback, /refresh_token: refreshToken/);
    assert.doesNotMatch(callback, /console\.error\([^)]*accessToken/);
    assert.doesNotMatch(callback, /console\.error\([^)]*refreshToken/);
    assert.doesNotMatch(callback, /jsonResponse\([^)]*access_token/);
    assert.doesNotMatch(callback, /jsonResponse\([^)]*refresh_token/);
  });
});

describe('GitHub token invalidation detection', () => {
  it('detects the explicit Invalid GitHub token 401 from the usage/profile backend', () => {
    assert.equal(isInvalidGitHubTokenResponse(401, '{"error":"Invalid GitHub token"}'), true);
  });

  it('treats any 401 on an authed Tyne call as an invalid session', () => {
    assert.equal(isInvalidGitHubTokenResponse(401, ''), true);
    assert.equal(isInvalidGitHubTokenResponse(401), true);
    assert.equal(isInvalidGitHubTokenResponse(401, 'Unauthorized'), true);
  });

  it('does not flag non-401 failures as token problems', () => {
    assert.equal(isInvalidGitHubTokenResponse(500, 'Internal Server Error'), false);
    assert.equal(isInvalidGitHubTokenResponse(429, 'Rate limited'), false);
    assert.equal(isInvalidGitHubTokenResponse(200, 'ok'), false);
  });

  it('GitHubTokenInvalidError carries a non-secret message', () => {
    const err = new GitHubTokenInvalidError();
    assert.equal(err.name, 'GitHubTokenInvalidError');
    assert.match(err.message, /invalid github token/i);
  });
});

describe('Jira connect UX, deep link, and refresh (Stages 1-7)', () => {
  it('Stage 1: Jira connect errors are visible via a dedicated output channel', () => {
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/pmToolsController.ts'), 'utf8');
    const log = readFileSync(join(process.cwd(), 'src/jiraLog.ts'), 'utf8');
    assert.match(log, /createOutputChannel\('Tyne: Jira'\)/);
    assert.match(provider, /getJiraOutputChannel/);
    assert.match(provider, /Connect GitHub first to use Jira\./);
    assert.match(provider, /Could not start Jira connection\. Open Tyne logs\./);
    assert.match(provider, /Jira login timed out before returning to VS Code\./);
    assert.match(provider, /Jira connection expired\. Reconnect Jira\./);
    // The connect path must be wrapped so thrown OAuth errors are not swallowed.
    assert.match(provider, /catch \(err: unknown\)[\s\S]*classifyJiraConnectError/);
  });

  it('Stage 1b: jira-oauth-state real status/error is surfaced, not swallowed', () => {
    const oauth = readFileSync(join(process.cwd(), 'src/jiraOAuth.ts'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/pmToolsController.ts'), 'utf8');
    // The start helper throws a typed error carrying the HTTP status + backend message.
    assert.match(oauth, /class JiraOAuthStateError/);
    assert.match(oauth, /Could not create a secure Jira OAuth state \(\$\{response\.status\}\): \$\{backendError\}/);
    // Structured, secret-free diagnostic line in the output channel.
    assert.match(provider, /Jira OAuth state failed: status=\$\{err\.status\} error=\$\{err\.backendError\}/);
    // Actionable, status-specific user messages.
    assert.match(provider, /Your GitHub session expired\. Reconnect GitHub, then connect Jira\./);
    assert.match(provider, /Your Tyne profile is not initialized yet\./);
    assert.match(provider, /Admin must set JIRA_CLIENT_ID and JIRA_REDIRECT_URI in Supabase\./);
    assert.match(provider, /Jira backend could not create the OAuth state\./);
  });

  it('Stage 2: GitHub prerequisite is shown before Jira connect', () => {
    const html = readFileSync(join(process.cwd(), 'src/sidebar/sidebarHtml.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(html, /jiraConnectGithubBtn/);
    assert.match(webview, /Connect GitHub first to connect Jira\./);
    assert.match(webview, /jiraConnectGithubBtn/);
    // Snapshot exposes whether GitHub is connected so the UI can gate the Jira button.
    const jp = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    assert.match(jp, /githubConnected/);
  });

  it('Stage 3: OAuth deep link carries state and is matched strictly', () => {
    const callback = readFileSync(join(process.cwd(), 'supabase/functions/jira-oauth-callback/index.ts'), 'utf8');
    const stateFunction = readFileSync(join(process.cwd(), 'supabase/functions/jira-oauth-state/index.ts'), 'utf8');
    const oauth = readFileSync(join(process.cwd(), 'src/jiraOAuth.ts'), 'utf8');
    assert.match(callback, /searchParams\.set\('state', rawState\)/);
    assert.match(oauth, /pendingHostedAuth\.get\(state\)/);
    assert.match(oauth, /if \(!state\)/);
    assert.match(oauth, /if \(!exchangeCode\)/);
    assert.match(oauth, /Missing state in VS Code callback/);
    assert.match(oauth, /Pending OAuth state found/);
    assert.match(oauth, /Pending OAuth state not found/);
    assert.match(oauth, /Exchange started/);
    assert.match(oauth, /Exchange completed/);
    assert.match(oauth, /Jira OAuth restarted by a new Connect click/);
    assert.match(oauth, /cancelActiveHostedOAuthAttempts/);
    assert.doesNotMatch(oauth, /Jira OAuth already in progress/);
    assert.match(callback, /status: 200/);
    assert.match(callback, /'Refresh': `0; url=\$\{callbackUrl\}`/);
    assert.match(callback, /Jira connected to Tyne\./);
    assert.match(oauth, /vscode\.env\.uriScheme/);
    assert.match(oauth, /callback_uri: callbackUri/);
    assert.match(stateFunction, /normalizeCallbackUri/);
    assert.match(stateFunction, /base64UrlEncode\(callbackUri\)/);
    assert.match(callback, /base64UrlDecode/);
    assert.match(callback, /callbackUri \|\| Deno\.env\.get\('JIRA_VSCODE_CALLBACK_URI'\)/);
    assert.match(callback, /cursor/);
    // No loose "single pending attempt" fallback any more.
    assert.doesNotMatch(oauth, /pendingHostedAuth\.size/);
  });

  it('Stage 3b: Jira connected UI is not overridden by non-auth task sync errors', () => {
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'media/tyne.css'), 'utf8');
    assert.match(webview, /function isReconnectSyncError/);
    assert.match(webview, /setStateBtn\(stateBtn, 'Connected', 'btn compact conn-badge-good', true\)/);
    assert.match(webview, /Connected\. Task refresh needs attention:/);
    assert.match(webview, /status = 'warning'/);
    assert.match(webview, /Connected · sync issue/);
    assert.match(webview, /no open jira issues assigned/i);
    assert.match(webview, /_tasksConnectingTools = _tasksConnectingTools\.filter\(tool => !_tasksConnectedTools\.includes\(tool\)\)/);
    assert.match(webview, /conn-badge-neutral is-loading/);
    assert.match(webview, /function renderPmConnectButtons/);
    assert.match(webview, /btn\.classList\.toggle\('is-loading', connecting\)/);
    assert.match(webview, /btn\.textContent = connecting \? 'Connecting…' : connected \? 'Connected'/);
    assert.match(css, /\.sync-dot\.warning/);
    assert.match(css, /\.btn\.is-loading::before/);
    assert.match(css, /\.pm-pill\.is-loading::before/);
    assert.match(css, /\.pm-pill\.connected/);
    const jiraProvider = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    assert.doesNotMatch(jiraProvider, /const mapping = await this\.chooseAndSaveProject\(\)/);
    assert.match(jiraProvider, /Jira connected\. Use "Change Project" to pick a Jira project/);
    assert.match(jiraProvider, /async function recoverHostedJiraConnection/);
    assert.match(jiraProvider, /USER_DISCONNECTED_KEY/);
    assert.match(jiraProvider, /LIST_PROJECTS_FUNCTION_PATH/);
    assert.match(jiraProvider, /serverManaged: true/);
    assert.match(jiraProvider, /await context\.secrets\.store\(SECRET_KEY, JSON\.stringify\(bundle\)\)/);
    assert.match(jiraProvider, /return Boolean\(await recoverHostedJiraConnection\(context, this\._getConfig\(\)\)\)/);
    assert.match(jiraProvider, /const recovered = await recoverHostedJiraConnection\(context, this\._getConfig\(\)\)/);
    assert.match(jiraProvider, /function readJiraTokenBundle/);
    assert.match(jiraProvider, /await recoverHostedJiraConnection\(context, config\)/);
    const sidebar = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/pmToolsController.ts'), 'utf8');
    const registry = readFileSync(join(process.cwd(), 'src/taskProviderRegistry.ts'), 'utf8');
    assert.match(registry, /export async function markToolConnected/);
    assert.match(registry, /export async function markToolDisconnected/);
    assert.match(sidebar, /await markToolConnected\(this\.host\.context, tool\)/);
    assert.match(sidebar, /await markToolDisconnected\(this\.host\.context, tool\)/);
  });

  it('Stage 4: refresh uses /rest/api/3/search/jql, not the removed /rest/api/3/search', () => {
    const jp = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    const api = readFileSync(join(process.cwd(), 'supabase/functions/jira-api-request/index.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(jp, /\/rest\/api\/3\/search\/jql/);
    assert.doesNotMatch(jp, /\/rest\/api\/3\/search\?/);
    assert.match(jp, /fields: 'summary,description,status,issuetype,priority,assignee,project,labels,parent,created,updated,duedate'/);
    assert.match(jp, /issueType: fields\.issuetype\?\.name/);
    assert.match(jp, /labels: Array\.isArray\(fields\.labels\)/);
    assert.match(webview, /d\.parentKey/);
    assert.match(api, /'\/rest\/api\/3\/search\/jql'/);
    assert.doesNotMatch(api, /pathname === '\/rest\/api\/3\/search'/);
    assert.match(api, /method === 'GET'/);
    assert.match(api, /Hosted Jira API request blocked/);
    assert.match(api, /path or method is not allowlisted/);
    assert.match(jp, /Tyne blocked an unsupported Jira API request\. Update the Jira API allowlist\./);
  });

  it('Stage 5: project mapping is saved via backend and persisted locally', () => {
    const jp = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
    assert.match(jp, /save-jira-project-mapping/);
    assert.match(jp, /tyne\.jira\.projectMapping/);
    assert.match(jp, /Choose Jira project for this repository/);
    assert.doesNotMatch(jp, /update\('jira\.cloudId'/);
    assert.doesNotMatch(jp, /update\('jira\.projectKeys'/);
    assert.doesNotMatch(jp, /get<string>\('jira\.cloudId'/);
    assert.doesNotMatch(provider, /update\('jira\.cloudId'/);
    assert.doesNotMatch(provider, /update\('jira\.projectKeys'/);
  });

  it('Stage 6: 401/403/410 produce reconnect/error states', () => {
    const jp = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(jp, /Jira session expired\. Reconnect Jira\./);
    assert.match(jp, /Tyne does not have access to this Jira project\./);
    assert.match(jp, /Jira API endpoint changed\. Please update Tyne\./);
    assert.match(jp, /reconnectRequired/);
    assert.match(webview, /Reconnect/);
    assert.match(webview, /jiraReconnectBtn/);
  });

  it('Stage 7: dead local PKCE OAuth code is removed', () => {
    const oauth = readFileSync(join(process.cwd(), 'src/jiraOAuth.ts'), 'utf8');
    assert.doesNotMatch(oauth, /startJiraOAuth/);
    assert.doesNotMatch(oauth, /exchangeJiraCodeForToken/);
    assert.doesNotMatch(oauth, /code_challenge/);
    assert.doesNotMatch(oauth, /auth\.atlassian\.com\/authorize/);
  });
});

describe('Linear PM intelligence and validation', () => {
  it('supports source-aware PM intelligence and validation contracts for Jira and Linear', () => {
    const service = readFileSync(join(process.cwd(), 'src/pmTaskIntelligenceService.ts'), 'utf8');
    const types = readFileSync(join(process.cwd(), 'src/taskTypes.ts'), 'utf8');
    const backend = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    const validation = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');

    assert.match(types, /source: 'jira' \| 'linear'/);
    assert.match(types, /issueIdentifier: string/);
    assert.match(service, /source: 'jira' \| 'linear'/);
    assert.match(service, /linearWorkspaceId/);
    assert.match(backend, /const source = body\?\.source === 'linear' \? 'linear' : 'jira'/);
    assert.match(backend, /from\('linear_issue_contexts'\)/);
    assert.match(validation, /const source = body\?\.source === 'linear' \? 'linear' : 'jira'/);
    assert.match(validation, /from\('linear_issue_contexts'\)/);
    assert.match(validation, /Validate whether the code changes below satisfy the \$\{taskContext\.source === 'jira' \? 'Jira' : 'Linear'\} task/);
  });

  it('loads Linear PM intelligence in the sidebar and validates active Linear tasks', () => {
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/validateReviewController.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/pmToolsController.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/pmIntelligenceController.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/threadWorkflowController.ts'), 'utf8');
    const validationService = readFileSync(join(process.cwd(), 'src/codeValidationService.ts'), 'utf8');

    // Match the jira/linear branch condition regardless of surrounding guards
    // (production wraps it with a GitHub-connected check: `if ((tool === 'jira' || tool === 'linear') && ...)`).
    assert.match(provider, /tool === 'jira' \|\| tool === 'linear'/);
    assert.match(provider, /_resolvePmTaskRequest/);
    assert.match(provider, /Linear validation started/);
    assert.match(provider, /Linear validation completed/);
    assert.match(provider, /Linear thread started:/);
    assert.match(validationService, /async validatePmTask\(tier: string\)/);
    assert.match(validationService, /source !== 'jira' && source !== 'linear'/);
    assert.match(validationService, /linearWorkspaceId/);
    assert.match(readFileSync(join(process.cwd(), 'src/linearProvider.ts'), 'utf8'), /mapping\?\.workspaceId/);
  });

  it('validates PM tasks against stored task descriptions, parent context, and child subtasks', () => {
    const validationService = readFileSync(join(process.cwd(), 'src/codeValidationService.ts'), 'utf8');
    const pmValidation = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');

    assert.match(validationService, /acceptanceCriteria: resolvedContext\.acceptanceCriteria\.length \? resolvedContext\.acceptanceCriteria : undefined/);
    assert.match(validationService, /subtasks: subtaskOverrides\.length \? subtaskOverrides : undefined/);
    assert.match(pmValidation, /source_jira_snapshot/);
    assert.match(pmValidation, /source_linear_snapshot/);
    assert.match(pmValidation, /function contextFromSnapshot/);
    assert.match(pmValidation, /Parent \/ Epic \/ Story Context:/);
    assert.match(pmValidation, /Child Issues \/ Subtasks From PM Tool:/);
    assert.match(pmValidation, /preferStoredArray\(storedSubtasks, subtasksOverride\)/);
    assert.match(pmValidation, /preferStoredString\(storedContext\.goal, goalOverride\)/);
    assert.match(pmValidation, /children \{\s+nodes \{\s+id\s+identifier\s+title\s+description/s);
    assert.match(pmValidation, /const selectedFields = 'summary,description,status,parent,subtasks'/);
  });

  it('separates PM enrichment failure from code validation failure', () => {
    const validationService = readFileSync(join(process.cwd(), 'src/codeValidationService.ts'), 'utf8');
    const pmValidation = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');

    assert.match(validationService, /const enrichmentStatus: EnrichmentStatus = state\.pmEnrichmentStatus/);
    assert.match(validationService, /resolveValidationContext/);
    assert.match(validationService, /event: 'pm_enrichment_failed'/);
    assert.match(validationService, /event: 'validation_completed'/);
    assert.match(pmValidation, /PM enrichment failure is not a code validation failure/);
    assert.match(pmValidation, /validationContextSource = currentBranch \|\| changedFiles\.length \? 'branch_only' : 'diff_only'/);
    assert.match(pmValidation, /fallbackSubtasks/);
    assert.match(pmValidation, /validationStatus/);
    assert.match(webview, /Limited task context/);
    assert.match(webview, /Retry PM Enrichment/);
    assert.match(webview, /retryPmEnrichment/);
  });

  it('normalizes PM validation into a compact scorecard with capped goal/action fields', () => {
    const service = readFileSync(join(process.cwd(), 'src/pmTaskIntelligenceService.ts'), 'utf8');
    const backend = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');

    assert.match(backend, /completedGoalsArray/);
    assert.match(backend, /pendingGoalsArray/);
    assert.match(backend, /developerActionsArray/);
    assert.match(backend, /codeEvidenceArray/);
    assert.match(backend, /slice\(0, 4\)/);
    assert.match(backend, /slice\(0, 5\)/);
    assert.match(backend, /Default card fields must fit in 120-160 words total/);
    assert.match(service, /parseCompletedGoals/);
    assert.match(service, /parsePendingGoals/);
    assert.match(service, /parseDeveloperActions/);
    assert.match(webview, /Completed/);
    assert.match(webview, /Pending/);
    assert.match(webview, /Next Developer Actions/);
    assert.match(webview, /Code Evidence/);
  });

  it('generates developer task plans from PM issue plus compact codebase context only', () => {
    const collector = readFileSync(join(process.cwd(), 'src/codebaseContextService.ts'), 'utf8');
    const service = readFileSync(join(process.cwd(), 'src/pmTaskIntelligenceService.ts'), 'utf8');
    const intelligence = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    const validation = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');

    assert.match(collector, /const IGNORE_GLOB = '\*\*\/\{node_modules,dist,build,out,\.next,coverage,\.git\}\/\*\*'/);
    assert.match(collector, /Return the top 8|slice\(0, 15\)/);
    assert.match(collector, /PREFERRED_DIRS/);
    assert.match(collector, /TEST_FILE/);
    assert.match(collector, /GENERATED_FILE/);
    assert.match(service, /codebaseContext: input\.codebaseContext/);
    assert.match(intelligence, /You are Tyne, a technical AI Scrum Master inside VS Code/);
    assert.match(intelligence, /You must use the codebase context\. Do not invent files/);
    assert.match(intelligence, /Mention file paths only when they appear in Relevant files, Existing tests, or Changed files/);
    assert.match(intelligence, /sanitizeDeveloperTaskPlan/);
    assert.match(validation, /Compare the git diff against the Developer Task Plan and acceptance criteria/);
    assert.match(validation, /Mention file paths only when they appear in Changed Files, Relevant Files, or Existing Tests/);
  });

  it('uses DeepSeek developer plans to backfill technical subtasks when PM issue has no subtasks', () => {
    const intelligence = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    const policy = readFileSync(join(process.cwd(), 'supabase/functions/_shared/aicreditsModelPolicy.ts'), 'utf8');

    assert.match(intelligence, /resolveAicreditsLlmConfig\('pm_task_intelligence'/);
    assert.match(policy, /pm_task_intelligence:[\s\S]*'deepseek\/deepseek-v4-pro'/);
    assert.match(intelligence, /function developerPlanToTechnicalSubtasks/);
    assert.match(intelligence, /function applyDeepSeekTechnicalSubtaskFallback/);
    assert.match(intelligence, /if \(context\.children\.length > 0\) return/);
    assert.match(intelligence, /result\.subtasks = technicalSubtasks/);
    assert.match(intelligence, /applyDeepSeekTechnicalSubtaskFallback\(result, context\)/);
    assert.match(intelligence, /If the PM issue has no child issues\/subtasks, you must generate full technical subtasks/);
    assert.match(intelligence, /Likely files: \$\{task\.likelyFiles\.join\(', '\)\}/);
    assert.match(intelligence, /Exact file unknown from current codebase context/);
  });

  it('keeps full validation details collapsed behind the report action', () => {
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(webview, /valFullReportBtn/);
    assert.match(webview, /Full validation report/);
    assert.match(webview, /Developer Task Plan/);
    assert.match(webview, /Relevant files/);
    assert.match(webview, /valDetailsExpanded/);
    // Open Full Report navigates to the shared Validate & Review document.
    assert.match(webview, /openValidateReviewReport\(id, 'full'\)/);
    assert.match(webview, /Prefer the full Validate & Review document/);
  });

  it('keeps Linear API access server-side and never returns raw OAuth tokens', () => {
    const oauth = readFileSync(join(process.cwd(), 'src/linearOAuth.ts'), 'utf8');
    const callback = readFileSync(join(process.cwd(), 'supabase/functions/complete-linear-oauth-exchange/index.ts'), 'utf8');
    const api = readFileSync(join(process.cwd(), 'supabase/functions/linear-api-request/index.ts'), 'utf8');
    const callbackFn = readFileSync(join(process.cwd(), 'supabase/functions/linear-oauth-callback/index.ts'), 'utf8');
    const listTeams = readFileSync(join(process.cwd(), 'supabase/functions/list-linear-teams/index.ts'), 'utf8');
    const pmIntelligence = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    const pmValidation = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');
    const config = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8');

    assert.match(oauth, /Linear OAuth state created/);
    assert.match(oauth, /Browser opened for Linear login/);
    assert.match(oauth, /Linear URI received/);
    assert.match(oauth, /Linear exchange completed/);
    assert.match(oauth, /createOutputChannel\('Tyne: Linear'\)/);
    assert.match(oauth, /Linear OAuth restarted by a new Connect click/);
    assert.match(oauth, /cancelActiveHostedOAuthAttempts/);
    assert.doesNotMatch(oauth, /Linear OAuth already in progress/);
    assert.match(oauth, /pendingHostedAuth\.get\(state\)/);
    assert.match(callback, /workspace_id/);
    assert.doesNotMatch(callback, /jsonResponse\([^)]*access_token/);
    assert.doesNotMatch(callback, /jsonResponse\([^)]*refresh_token/);
    assert.match(api, /const OPERATIONS: Record<string/);
    assert.match(api, /Authorization': `Bearer \$\{accessToken\}`/);
    assert.match(callbackFn, /Authorization': `Bearer \$\{accessToken\}`/);
    assert.match(listTeams, /Authorization': `Bearer \$\{accessToken\}`/);
    assert.match(pmIntelligence, /Authorization: `Bearer \$\{accessToken\}`/);
    assert.match(pmValidation, /Authorization: `Bearer \$\{accessToken\}`/);
    assert.match(callbackFn, /application\/x-www-form-urlencoded/);
    assert.match(api, /grant_type: 'refresh_token'/);
    assert.match(listTeams, /grant_type: 'refresh_token'/);
    assert.match(pmIntelligence, /grant_type: 'refresh_token'/);
    assert.match(pmValidation, /grant_type: 'refresh_token'/);
    assert.match(config, /\[functions\.linear-oauth-state\][\s\S]*verify_jwt = false/);
    assert.match(config, /\[functions\.linear-oauth-callback\][\s\S]*verify_jwt = false/);
    assert.match(config, /\[functions\.complete-linear-oauth-exchange\][\s\S]*verify_jwt = false/);
    assert.match(config, /\[functions\.linear-api-request\][\s\S]*verify_jwt = false/);
    assert.match(config, /\[functions\.list-linear-teams\][\s\S]*verify_jwt = false/);
    assert.match(config, /\[functions\.save-linear-team-mapping\][\s\S]*verify_jwt = false/);
    assert.doesNotMatch(api, /query:\s*body\?\.query/);
  });

  it('shows an explicit Open in Linear action on the detail card', () => {
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(webview, /tdOpenPmBtn\.textContent = `Open in \$\{TOOL_LABEL\[d\.sourceTool\] \|\| 'PM'\} ↗`/);
  });

  it('renders Validate & Review, Generate Commit, and a validation summary in the task detail drawer', () => {
    const provider = readFileSync(join(process.cwd(), 'src/sidebar/sidebarHtml.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');

    assert.match(provider, /id="taskDetailValidateBtn"[^>]*>Validate &amp; Review</);
    assert.match(provider, /id="taskDetailGenerateCommitBtn"[^>]*>Generate Commit</);
    assert.match(provider, /id="pmValidationResultSection"/);
    assert.match(provider, /id="pmValidationResultText"/);
    assert.match(webview, /renderTaskDetailValidation\(\)/);
    assert.match(webview, /runFlowAction\('validateReview'\)/);
    assert.match(webview, /runFlowAction\('generateCommitPreview'\)/);
  });

  it('filters the Linear refresh list to assigned issues server-side by team and assignee', () => {
    const api = readFileSync(join(process.cwd(), 'supabase/functions/linear-api-request/index.ts'), 'utf8');
    // Filtering must happen inside the GraphQL query, not in memory after a
    // first-N page, so assigned issues are never silently dropped on large teams.
    assert.match(api, /query TyneListAssignedIssues\(\$filter: IssueFilter, \$first: Int\)/);
    assert.match(api, /issues\(filter: \$filter, first: \$first, orderBy: updatedAt\)/);
    assert.match(api, /const assignedOnly = variables\.assignedOnly !== false/);
    assert.match(api, /filter\.team = \{ id: \{ eq: teamId \} \}/);
    assert.match(api, /filter\.assignee = \{ isMe: \{ eq: true \} \}/);
    assert.match(api, /filter\.state = \{ type: \{ nin: \['completed', 'canceled'\] \} \}/);
    // The limit is clamped to a safe range.
    assert.match(api, /Math\.min\(Math\.max\(Math\.floor\(rawFirst\), 1\), 100\)/);
    // The viewer { id } probe and in-memory assigned filtering are gone; the
    // response is flattened into the flat { issues: [...] } array the provider reads.
    assert.doesNotMatch(api, /viewer \{\s*id\s*\}/);
    assert.doesNotMatch(api, /function filterAssignedIssues/);
    assert.match(api, /function extractIssueNodes/);
  });

  it('reports honest Linear capabilities and never fabricates tasks for connected users', () => {
    const providerAdapters = readFileSync(join(process.cwd(), 'src/taskProviderAdapters.ts'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/linearProvider.ts'), 'utf8');
    // The provider advertises only what it implements: status close + comments.
    assert.match(provider, /canCreateTask: false/);
    assert.match(provider, /canEditStatus: true/);
    assert.match(provider, /canAddSubtask: false/);
    assert.match(provider, /canAddComment: true/);
    // When connected, the adapter delegates capabilities to the provider rather
    // than advertising the permissive demo defaults.
    assert.match(providerAdapters, /if \(hasTaskProviderRuntimeContext\(\)\) \{\s*return new LinearProvider\(\)\.getCapabilities\(\);/);
    // Connected create/update/subtask paths must not return demo data.
    assert.match(providerAdapters, /Creating Linear issues from Tyne is not available yet\./);
    assert.match(providerAdapters, /Editing Linear issues from Tyne is not available yet\./);
    assert.match(providerAdapters, /Adding Linear sub-issues from Tyne is not available yet\./);
  });

  it('uses current Linear OAuth parameter formatting for scopes and token exchange', () => {
    const stateFn = readFileSync(join(process.cwd(), 'supabase/functions/linear-oauth-state/index.ts'), 'utf8');
    const callbackFn = readFileSync(join(process.cwd(), 'supabase/functions/linear-oauth-callback/index.ts'), 'utf8');

    assert.match(stateFn, /LINEAR_SCOPES = \['read', 'write'\]/);
    assert.match(stateFn, /searchParams\.set\('scope', LINEAR_SCOPES\.join\(','\)\)/);
    assert.match(callbackFn, /new URLSearchParams\(\{/);
    assert.match(callbackFn, /grant_type: 'authorization_code'/);

    // Authorize URL must carry all required params, including actor=user.
    assert.match(stateFn, /searchParams\.set\('client_id', clientId\)/);
    assert.match(stateFn, /searchParams\.set\('redirect_uri', redirectUri\)/);
    assert.match(stateFn, /searchParams\.set\('response_type', 'code'\)/);
    assert.match(stateFn, /searchParams\.set\('state', state\)/);
    assert.match(stateFn, /searchParams\.set\('actor', 'user'\)/);
  });

  it('logs safe Linear OAuth config diagnostics without exposing secrets', () => {
    const stateFn = readFileSync(join(process.cwd(), 'supabase/functions/linear-oauth-state/index.ts'), 'utf8');

    // Safe presence/host/path/prefix diagnostics only.
    assert.match(stateFn, /clientIdPrefix=\$\{clientId \? clientId\.slice\(0, 6\) : ''\}/);
    assert.match(stateFn, /redirectUriHost=\$\{redirectUriHost\}/);
    assert.match(stateFn, /redirectUriPath=\$\{redirectUriPath\}/);
    assert.match(stateFn, /hasLinearClientId=\$\{Boolean\(clientId\)\}/);
    assert.match(stateFn, /hasLinearRedirectUri=\$\{Boolean\(redirectUri\)\}/);
    assert.match(stateFn, /hasLinearClientSecret=\$\{Boolean\(clientSecret\)\}/);

    // One clear warning when the redirect URI is misconfigured.
    assert.match(stateFn, /EXPECTED_REDIRECT_SUFFIX = '\/functions\/v1\/linear-oauth-callback'/);
    assert.match(stateFn, /does not end with \$\{EXPECTED_REDIRECT_SUFFIX\}/);

    // Never interpolate full secrets / tokens / state / redirect uri into any string.
    assert.doesNotMatch(stateFn, /clientIdPrefix=\$\{clientId\}/);
    assert.doesNotMatch(stateFn, /\$\{clientSecret\}/);
    assert.doesNotMatch(stateFn, /\$\{redirectUri\}/);
    assert.doesNotMatch(stateFn, /\$\{state\}/);
  });

  it('supports posting validation feedback back to Linear through the shared PM automation path', () => {
    const automation = readFileSync(join(process.cwd(), 'src/taskAutomationService.ts'), 'utf8');
    const adapters = readFileSync(join(process.cwd(), 'src/pmAdapterInterface.ts'), 'utf8');
    const providerAdapters = readFileSync(join(process.cwd(), 'src/taskProviderAdapters.ts'), 'utf8');
    const sidebar = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/validateReviewController.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/automationController.ts'), 'utf8')
      + '\n' + readFileSync(join(process.cwd(), 'src/sidebar/threadWorkflowController.ts'), 'utf8');
    const linearApi = readFileSync(join(process.cwd(), 'supabase/functions/linear-api-request/index.ts'), 'utf8');

    assert.match(automation, /const result = await adapter\.postTaskComment\(taskId, body\)/);
    assert.match(adapters, /readonly toolName = 'Linear'/);
    assert.match(adapters, /const comment = await provider\.addComment\(issue\.id, body\)/);
    assert.match(providerAdapters, /await new LinearProvider\(\)\.addComment\(_taskId, body\)/);
    assert.match(sidebar, /async generateCommitPreview\(\)/);
    assert.match(sidebar, /Commit preview copied:/);
    assert.match(linearApi, /mutation TyneCreateComment\(\$input: CommentCreateInput!\)/);
    assert.match(linearApi, /commentCreate\(input: \$input\)/);
    assert.match(linearApi, /input: \{\s+issueId: typeof variables\.issueId === 'string'/);
    assert.doesNotMatch(linearApi, /commentCreate\(issueId:/);
    assert.match(sidebar, /Post work-summary comment on tie-the-knot even when auto-close is manual/);
    assert.match(sidebar, /shouldPostFeedback = settings\.autoPostFeedbackAfterClose/);
    assert.match(sidebar, /saveValidationResult\(this\.host\.state\.validationResult\)/);
  });
});

describe('Tier normalization', () => {
  it('maps core/free to free', () => {
    assert.equal(normalizeTier('CORE'), 'free');
    assert.equal(normalizeTier('free'), 'free');
  });

  it('maps pro and max', () => {
    assert.equal(normalizeTier('PRO'), 'pro');
    assert.equal(normalizeTier('MAX'), 'max');
  });

  it('defaults unknown tier to free', () => {
    assert.equal(normalizeTier('UNKNOWN'), 'free');
    assert.equal(normalizeTier(''), 'free');
  });
});

describe('Validation history filtering and limits', () => {
  it('limits free history to last 10', () => {
    const results = Array.from({ length: 15 }, (_, i) => createResult({ id: 'r' + i, createdAt: new Date(Date.now() - i * 1000).toISOString() }));
    const limited = limitHistoryForTier(results, 'free');
    assert.equal(limited.length, 10);
    assert.equal(limited[0].id, 'r0');
  });

  it('does not limit pro/max history', () => {
    const results = Array.from({ length: 15 }, (_, i) => createResult({ id: 'r' + i }));
    assert.equal(limitHistoryForTier(results, 'pro').length, 15);
    assert.equal(limitHistoryForTier(results, 'max').length, 15);
  });

  it('filters by status and provider', () => {
    const results = [
      createResult({ id: 'a', status: 'pass', provider: 'anthropic' }),
      createResult({ id: 'b', status: 'fail', provider: 'openai' }),
      createResult({ id: 'c', status: 'pass', provider: 'openai' }),
    ];
    const pass = results.filter(r => matchesHistoryFilters(r, { statuses: ['pass'] }));
    assert.equal(pass.length, 2);
    const anthropic = results.filter(r => matchesHistoryFilters(r, { providers: ['anthropic'] }));
    assert.equal(anthropic.length, 1);
    assert.equal(anthropic[0].id, 'a');
  });

  it('filters by query', () => {
    const results = [
      createResult({ id: 'a', taskId: 'TASK-123', summary: 'Auth work' }),
      createResult({ id: 'b', taskId: 'TASK-456', summary: 'Billing work' }),
    ];
    const filtered = results.filter(r => matchesHistoryFilters(r, { query: 'auth' }));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'a');
  });
});

describe('Validation history export helpers', () => {
  it('formats history line for free view', () => {
    const result = createResult({ status: 'pass', taskId: 'TASK-123', branchName: 'tyne/TASK-123-auth', commitHash: 'a1b2c3d4e5f6', createdAt: '2026-06-24T14:30:00.000Z' });
    const line = formatHistoryLine(result);
    assert.equal(line, 'PASS · TASK-123 · tyne/TASK-123-auth · a1b2c3d4 · anthropic · 2026-06-24');
  });

  it('exports CSV without raw diffs or secrets', () => {
    const results = [createResult({ id: 'v1', status: 'pass', matchPercent: 96, riskLevel: 'low', taskId: 'TASK-123', taskTitle: 'Build auth', branchName: 'tyne/TASK-123-auth', commitHash: 'a1b2c3d4', createdAt: '2026-06-24T14:30:00.000Z', missingRequirements: [], suggestions: [], filesReviewed: ['src/auth.ts'], durationMs: 1200, summary: 'Good.' })];
    const csv = exportCsv(results);
    assert.ok(csv.includes('v1'));
    assert.ok(csv.includes('pass'));
    assert.ok(csv.includes('96'));
    assert.ok(!csv.includes('diffText'));
    assert.ok(!csv.includes('rawDiff'));
  });

  it('exports JSON', () => {
    const results = [createResult({ id: 'v1', status: 'partial' })];
    const json = exportJson(results);
    const parsed = JSON.parse(json) as TyneValidationResult[];
    assert.equal(parsed[0].id, 'v1');
    assert.equal(parsed[0].status, 'partial');
  });

  it('builds export filename with current date', () => {
    const name = buildExportFileName('csv');
    assert.ok(name.startsWith('tyne-validation-history-'));
    assert.ok(name.endsWith('.csv'));
  });
});

describe('Validation trend calculation helpers', () => {
  it('calculates pass rate', () => {
    const results = [createResult({ status: 'pass' }), createResult({ status: 'pass' }), createResult({ status: 'fail' })];
    assert.equal(calculatePassRate(results), 67);
  });

  it('returns undefined average match when no matches', () => {
    assert.equal(calculateAverageMatch([createResult()]), undefined);
  });

  it('calculates average match', () => {
    const results = [createResult({ matchPercent: 80 }), createResult({ matchPercent: 90 })];
    assert.equal(calculateAverageMatch(results), 85);
  });

  it('calculates average risk level', () => {
    const results = [createResult({ riskLevel: 'low' }), createResult({ riskLevel: 'high' })];
    assert.equal(calculateAverageRiskLevel(results), 'medium');
  });

  it('detects improving trend', () => {
    const results = [
      createResult({ status: 'fail', matchPercent: 30, createdAt: '2026-06-01T10:00:00.000Z' }),
      createResult({ status: 'partial', matchPercent: 60, createdAt: '2026-06-15T10:00:00.000Z' }),
      createResult({ status: 'pass', matchPercent: 95, createdAt: '2026-06-30T10:00:00.000Z' }),
    ];
    assert.equal(calculateTrendDirection(results), 'improving');
  });

  it('returns not enough data for fewer than 3 results', () => {
    assert.equal(calculateTrendDirection([createResult(), createResult()]), 'not_enough_data');
  });
});

describe('Validation trace service', () => {
  it('builds a running trace for core tier', () => {
    const svc = getValidationTraceService();
    const trace = svc.buildValidationTraceRunning('free', { taskId: 'TASK-1', goal: 'Ship validation timeline' });
    assert.equal(trace.planTier, 'core');
    assert.equal(trace.overallStatus, 'running');
    assert.equal(trace.steps[0]?.status, 'running');
    assert.equal(trace.steps[0]?.key, 'request_received');
  });

  it('builds a staged max execution plan', () => {
    const svc = getValidationTraceService();
    const plan = svc.getValidationExecutionPlan('max');
    assert.equal(plan.executionMode, 'staged');
    assert.ok(plan.steps.some(step => step.key === 'context_distilled'));
    assert.ok(plan.steps.some(step => step.key === 'axiom_synthesis'));
  });

  it('builds a completed trace with warning status for partial result', () => {
    const svc = getValidationTraceService();
    const result = createResult({
      tier: 'pro',
      status: 'partial',
      matchPercent: 71,
      riskLevel: 'medium',
      summary: 'Partial match.',
      detailedExplanation: 'Some work remains.',
      missingRequirements: ['Add retry handling'],
      filesReviewed: ['src/validation.ts'],
      durationMs: 2400,
      createdAt: '2026-06-26T10:00:00.000Z',
    });
    const trace = svc.buildValidationTraceComplete('pro', result, { goal: 'Validate code' });
    assert.equal(trace.overallStatus, 'warning');
    assert.equal(trace.steps.some(step => step.status === 'warning'), true);
    const axiomStep = trace.steps.find(step => step.key === 'axiom_review');
    assert.equal(axiomStep?.provider, 'axiom');
    assert.equal(axiomStep?.summary, 'Partial match.');
  });
});

describe('Enriched PM context', () => {
  it('collects comments, attachments, and linked issues for Jira and Linear', () => {
    const edge = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    assert.match(edge, /comment,attachment,issuelinks/);
    assert.match(edge, /comment\?maxResults=50&orderBy=-created/);
    assert.match(edge, /comments\(first: 50\)/);
    assert.match(edge, /attachments\(first: 20\)/);
    assert.match(edge, /relations\(first: 20\)/);
    assert.match(edge, /inverseRelations\(first: 20\)/);
    assert.match(edge, /later comments override older issue text/);
    assert.match(edge, /decisions: toStringArray\(r\.decisions\)/);
  });

  it('persists enriched PM context and developer plans for both providers', () => {
    const edge = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-intelligence/index.ts'), 'utf8');
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20260715011827_enrich_pm_task_context.sql'), 'utf8');
    assert.match(edge, /pm_context: intelligence\.pmContext/);
    assert.match(edge, /developer_task_plan: intelligence\.developerTaskPlan/);
    assert.match(migration, /alter table public\.tyne_pm_task_contexts/);
    assert.match(migration, /alter table public\.linear_issue_contexts/);
    assert.match(migration, /pm_context jsonb/);
    assert.match(migration, /developer_task_plan jsonb/);
  });

  it('uses enriched decisions in PM validation and Validate & Review', () => {
    const validationEdge = readFileSync(join(process.cwd(), 'supabase/functions/pm-task-validation/index.ts'), 'utf8');
    const reviewEdge = readFileSync(join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
    const service = readFileSync(join(process.cwd(), 'src/pmTaskIntelligenceService.ts'), 'utf8');
    assert.match(validationEdge, /Latest PM Decisions:/);
    assert.match(validationEdge, /pmContextOverride/);
    assert.match(reviewEdge, /Latest decisions \(higher priority than the description\)/);
    assert.match(service, /pmContext: parsePmContext\(payload\.pmContext\)/);
  });
});
