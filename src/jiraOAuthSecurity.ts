import { createHash } from 'crypto';

export interface OAuthOneTimeRecord {
  expiresAt: string;
  consumedAt?: string | null;
}

export interface AtlassianReportAccount {
  accountId: string;
  updatedAt: string;
}

export interface JiraProjectSuggestionOption {
  key: string;
}

export function hashOAuthSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canUseOneTimeOAuthRecord(record: OAuthOneTimeRecord, now = Date.now()): boolean {
  return !record.consumedAt && Date.parse(record.expiresAt) > now;
}

export function chunkAtlassianAccountReports<T extends AtlassianReportAccount>(accounts: T[], maxBatchSize = 90): T[][] {
  if (maxBatchSize <= 0 || maxBatchSize > 90) {
    throw new Error('Atlassian personal data reporting batches must contain 1 to 90 accounts.');
  }

  const chunks: T[][] = [];
  for (let index = 0; index < accounts.length; index += maxBatchSize) {
    chunks.push(accounts.slice(index, index + maxBatchSize));
  }
  return chunks;
}

export function shouldEraseAtlassianPersonalData(status: string): boolean {
  return status.trim().toLowerCase() === 'closed';
}

export function inferJiraProjectKey(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const match = candidate.match(/\b([A-Z][A-Z0-9]{1,9})-\d+\b/i);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  const repoName = candidates[candidates.length - 1] || '';
  return repoName.match(/^[a-z][a-z0-9]{1,9}$/i)?.[0]?.toUpperCase();
}

export function sortJiraProjectsForSuggestion<T extends JiraProjectSuggestionOption>(projects: T[], suggestedKey?: string): T[] {
  return [...projects].sort((a, b) => {
    const aSuggested = suggestedKey && a.key.toUpperCase() === suggestedKey ? 0 : 1;
    const bSuggested = suggestedKey && b.key.toUpperCase() === suggestedKey ? 0 : 1;
    if (aSuggested !== bSuggested) { return aSuggested - bSuggested; }
    return a.key.localeCompare(b.key);
  });
}
