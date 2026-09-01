import { TynePlanTier, TyneRiskLevel, TyneValidationHistoryFilters, TyneValidationResult, TyneValidationStatus } from './validationTypes';

const FREE_LIMIT = 5;
const PRO_LIMIT = 50;

export function getLimitForTier(tier: TynePlanTier, byokUnlimited = false): number | 'unlimited' {
  if (byokUnlimited) { return 'unlimited'; }
  switch (tier) {
    case 'free': return FREE_LIMIT;
    case 'pro': return PRO_LIMIT;
    case 'max': return 'unlimited'; // Default to unlimited for Max unless entitlement overrides.
  }
}

export function isLimited(value: number | 'unlimited'): value is number {
  return value !== 'unlimited';
}

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getResetAt(month: string): string {
  const [year, monthNum] = month.split('-').map(Number);
  const nextMonth = monthNum === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, monthNum, 1));
  return nextMonth.toISOString();
}

export function normalizeTier(tier: string): TynePlanTier {
  const raw = (tier || '').toLowerCase();
  if (raw === 'pro') { return 'pro'; }
  if (raw === 'max') { return 'max'; }
  return 'free';
}

/** BYOK is Pro/Max only. Core is 5 hosted managed reviews / month. */
export const BYOK_REQUIRES_PAID_PLAN = 'BYOK requires Pro or Max.';

export function byokAllowedForTier(tier: string): boolean {
  const plan = normalizeTier(tier);
  return plan === 'pro' || plan === 'max';
}

export function sanitizeDiff(diff: string): string {
  const lines = diff.split('\n');
  const allowed: string[] = [];
  let skipFile = false;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      skipFile = shouldSkipFile(line);
      if (!skipFile) {
        allowed.push(line);
      }
      continue;
    }
    if (!skipFile) {
      allowed.push(line);
    }
  }
  return allowed.join('\n');
}

function shouldSkipFile(line: string): boolean {
  const match = line.match(/diff --git a\/(.*?) b\//);
  if (!match) { return false; }
  const file = match[1].toLowerCase();
  const skipPatterns = [
    'node_modules/', '.git/', 'dist/', 'build/', 'out/', 'coverage/',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.env', '.env.', '.log', '.tmp', '.temp',
  ];
  return skipPatterns.some(p => file.includes(p));
}

export function statusLabel(status: TyneValidationStatus): string {
  switch (status) {
    case 'pass': return 'Pass';
    case 'fail': return 'Fail';
    case 'partial': return 'Partial';
  }
}

export function statusClass(status: TyneValidationStatus): string {
  switch (status) {
    case 'pass': return 'good';
    case 'fail': return 'bad';
    case 'partial': return 'warn';
  }
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

export function formatHistoryLine(result: TyneValidationResult): string {
  const parts = [statusLabel(result.status).toUpperCase()];
  if (result.taskId) { parts.push(result.taskId); }
  if (result.branchName) { parts.push(result.branchName); }
  if (result.commitHash) { parts.push(result.commitHash.slice(0, 8)); }
  if (result.provider) { parts.push(result.provider); }
  parts.push(formatDate(result.createdAt));
  return parts.join(' · ');
}

export function exportCsv(results: TyneValidationResult[]): string {
  const headers = ['validationId', 'createdAt', 'status', 'riskLevel', 'matchPercent', 'taskId', 'taskTitle', 'branchName', 'commitHash', 'provider', 'summary', 'missingRequirementsCount', 'suggestionsCount', 'filesReviewed', 'durationMs'];
  const rows = results.map(r => [
    r.id,
    r.createdAt,
    r.status,
    r.riskLevel ?? '',
    r.matchPercent ?? '',
    r.taskId ?? '',
    r.taskTitle ?? '',
    r.branchName ?? '',
    r.commitHash ?? '',
    r.provider,
    escapeCsv(r.summary),
    r.missingRequirements?.length ?? 0,
    r.suggestions?.length ?? 0,
    (r.filesReviewed ?? []).join('; '),
    r.durationMs ?? '',
  ]);
  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
}

export function exportJson(results: TyneValidationResult[]): string {
  return JSON.stringify(results, null, 2);
}

export function buildExportFileName(format: 'csv' | 'json'): string {
  const date = new Date().toISOString().slice(0, 10);
  return `tyne-validation-history-${date}.${format}`;
}

function escapeCsv(value: string): string {
  const str = String(value ?? '').replace(/"/g, '""');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str}"`;
  }
  return str;
}

export function calculatePassRate(results: TyneValidationResult[]): number {
  if (results.length === 0) { return 0; }
  return Math.round((results.filter(r => r.status === 'pass').length / results.length) * 100);
}

export function calculateAverageMatch(results: TyneValidationResult[]): number | undefined {
  const withMatch = results.filter(r => typeof r.matchPercent === 'number');
  if (withMatch.length === 0) { return undefined; }
  const sum = withMatch.reduce((acc, r) => acc + (r.matchPercent || 0), 0);
  return Math.round(sum / withMatch.length);
}

export function calculateAverageRiskLevel(results: TyneValidationResult[]): TyneRiskLevel | undefined {
  const withRisk = results.filter(r => r.riskLevel && r.riskLevel !== 'not_assessed');
  if (withRisk.length === 0) { return undefined; }
  const order: TyneRiskLevel[] = ['low', 'medium', 'high'];
  const scores = withRisk.map(r => order.indexOf(r.riskLevel!)).filter(s => s >= 0);
  if (scores.length === 0) { return undefined; }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return order[Math.round(avg)];
}

export function calculateTrendDirection(results: TyneValidationResult[]): 'improving' | 'declining' | 'stable' | 'not_enough_data' {
  if (results.length < 3) { return 'not_enough_data'; }
  const sorted = [...results].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const first = scoreBatch(sorted.slice(0, Math.ceil(sorted.length / 2)));
  const second = scoreBatch(sorted.slice(-Math.ceil(sorted.length / 2)));
  const diff = second - first;
  if (diff > 5) { return 'improving'; }
  if (diff < -5) { return 'declining'; }
  return 'stable';
}

function scoreBatch(batch: TyneValidationResult[]): number {
  if (batch.length === 0) { return 0; }
  const statusScore = batch.reduce((acc, r) => {
    if (r.status === 'pass') { return acc + 100; }
    if (r.status === 'partial') { return acc + 50; }
    return acc;
  }, 0) / batch.length;
  const matchAvg = calculateAverageMatch(batch) ?? 0;
  return (statusScore + matchAvg) / 2;
}

const FREE_HISTORY_LIMIT = 10;

export function limitHistoryForTier(results: TyneValidationResult[], tier: TynePlanTier): TyneValidationResult[] {
  if (tier === 'free') { return results.slice(0, FREE_HISTORY_LIMIT); }
  return results;
}

export function matchesHistoryFilters(h: TyneValidationResult, filters: TyneValidationHistoryFilters): boolean {
  if (filters.dateRange && (h.createdAt < filters.dateRange.start || h.createdAt > filters.dateRange.end)) { return false; }
  if (filters.statuses?.length && !filters.statuses.includes(h.status)) { return false; }
  if (filters.taskIds?.length && (!h.taskId || !filters.taskIds.includes(h.taskId))) { return false; }
  if (filters.branches?.length && (!h.branchName || !filters.branches.includes(h.branchName))) { return false; }
  if (filters.riskLevels?.length && (!h.riskLevel || !filters.riskLevels.includes(h.riskLevel))) { return false; }
  if (filters.providers?.length && !filters.providers.includes(h.provider)) { return false; }
  if (filters.minMatchPercent !== undefined && (h.matchPercent === undefined || h.matchPercent < filters.minMatchPercent)) { return false; }
  if (filters.maxMatchPercent !== undefined && (h.matchPercent === undefined || h.matchPercent > filters.maxMatchPercent)) { return false; }
  if (filters.hasMissingRequirements === true && (!h.missingRequirements || h.missingRequirements.length === 0)) { return false; }
  if (filters.hasSuggestions === true && (!h.suggestions || h.suggestions.length === 0)) { return false; }
  if (filters.query) {
    const q = filters.query.toLowerCase();
    const haystack = [h.taskId, h.taskTitle, h.branchName, h.commitHash, h.summary, h.filesReviewed?.join(' ')].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(q)) { return false; }
  }
  // Legacy single-value filters
  if (filters.taskId && h.taskId !== filters.taskId) { return false; }
  if (filters.branchName && h.branchName !== filters.branchName) { return false; }
  if (filters.status && h.status !== filters.status) { return false; }
  if (filters.riskLevel && h.riskLevel !== filters.riskLevel) { return false; }
  if (filters.provider && h.provider !== filters.provider) { return false; }
  if (filters.since && h.createdAt < filters.since) { return false; }
  if (filters.until && h.createdAt > filters.until) { return false; }
  return true;
}
