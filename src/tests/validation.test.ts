import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import { parseValidationResponse } from '../aiProviders/validationPrompt';
import { ValidationDisplayService } from '../validationDisplayService';
import { TyneValidationResult } from '../validationTypes';

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
