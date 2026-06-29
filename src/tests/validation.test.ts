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
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
    const log = readFileSync(join(process.cwd(), 'src/jiraLog.ts'), 'utf8');
    assert.match(log, /createOutputChannel\('Tyne: Jira'\)/);
    assert.match(provider, /getJiraOutputChannel/);
    assert.match(provider, /Connect GitHub first to use Jira\./);
    assert.match(provider, /Could not start Jira connection\. Open Tyne logs\./);
    assert.match(provider, /Jira login timed out before returning to VS Code\./);
    assert.match(provider, /Jira connection expired\. Reconnect Jira\./);
    // The connect path must be wrapped so thrown OAuth errors are not swallowed.
    assert.match(provider, /catch \(err: unknown\)[\s\S]*_classifyJiraConnectError/);
  });

  it('Stage 1b: jira-oauth-state real status/error is surfaced, not swallowed', () => {
    const oauth = readFileSync(join(process.cwd(), 'src/jiraOAuth.ts'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
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
    const provider = readFileSync(join(process.cwd(), 'src/TyneSidebarProvider.ts'), 'utf8');
    const webview = readFileSync(join(process.cwd(), 'media/tyne.js'), 'utf8');
    assert.match(provider, /jiraConnectGithubBtn/);
    assert.match(webview, /Connect GitHub first to connect Jira\./);
    assert.match(webview, /jiraConnectGithubBtn/);
    // Snapshot exposes whether GitHub is connected so the UI can gate the Jira button.
    const jp = readFileSync(join(process.cwd(), 'src/jiraProvider.ts'), 'utf8');
    assert.match(jp, /githubConnected/);
  });

  it('Stage 3: OAuth deep link carries state and is matched strictly', () => {
    const callback = readFileSync(join(process.cwd(), 'supabase/functions/jira-oauth-callback/index.ts'), 'utf8');
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
    assert.match(oauth, /Jira OAuth already in progress/);
    // No loose "single pending attempt" fallback any more.
    assert.doesNotMatch(oauth, /pendingHostedAuth\.size/);
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
    assert.match(webview, /t\.issueType/);
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
    assert.match(webview, /Reconnect required/);
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
