/**
 * Parallel per-file local review — batches of 5, cache-aware.
 */
import { extractFileFacts } from '../quality/astFacts';
import { scanVibeCode } from '../quality/vibeCodeScanner';
import {
  hashContent,
  splitDiffByFile,
  type FileReviewCache,
  type FileReviewCacheEntry,
} from '../validateReviewPipeline';
import type { QualityFinding } from '../quality/qualityTypes';

export const BATCH_SIZE = 5;

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    chunks.push(arr.slice(i, i + n));
  }
  return chunks;
}

export interface FileReviewConfig {
  diffByFile?: Record<string, string>;
  cache?: FileReviewCache;
}

export interface FileReviewResult {
  file: string;
  hash: string;
  findings: QualityFinding[];
  cached: boolean;
  error?: string;
  severity?: 'warn';
}

function cacheHit(
  file: string,
  hash: string,
  cache?: FileReviewCache,
): FileReviewCacheEntry | null {
  const entry = cache?.[file];
  if (!entry || entry.hash !== hash || !Array.isArray(entry.findings)) return null;
  return entry;
}

/** Review one changed file (sync work; cache short-circuit). */
export function reviewFile(
  file: string,
  content: string,
  config: FileReviewConfig = {},
): FileReviewResult {
  const hash = hashContent(content);
  const hit = cacheHit(file, hash, config.cache);
  if (hit) {
    return {
      file,
      hash,
      findings: hit.findings as QualityFinding[],
      cached: true,
    };
  }

  const fileDiff = config.diffByFile?.[file] || '';
  const facts = extractFileFacts(file, content);
  const findings = scanVibeCode({ diff: fileDiff, fileFacts: [facts] });

  return { file, hash, findings, cached: false };
}

/** Process files in parallel batches; one failure does not block the batch. */
export async function reviewFilesInParallel(
  changedFiles: Record<string, string>,
  config: FileReviewConfig = {},
): Promise<{ results: FileReviewResult[]; cache: FileReviewCache }> {
  const diffByFile = config.diffByFile || {};
  const entries = Object.entries(changedFiles).filter(([, c]) => String(c || '').length > 0);
  const batches = chunkArray(entries, BATCH_SIZE);
  const results: FileReviewResult[] = [];
  const cache: FileReviewCache = { ...(config.cache || {}) };
  const now = new Date().toISOString();

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(([file, content]) =>
        Promise.resolve().then(() => reviewFile(file, content, { ...config, diffByFile }))
          .catch((err: unknown) => ({
            file,
            hash: hashContent(content),
            findings: [] as QualityFinding[],
            cached: false,
            error: err instanceof Error ? err.message : String(err),
            severity: 'warn' as const,
          })),
      ),
    );
    for (const r of batchResults) {
      results.push(r);
      if (!r.error) {
        cache[r.file] = {
          hash: r.hash,
          findings: r.findings,
          updatedAt: now,
        };
      }
    }
  }

  return { results, cache };
}

export function buildFileReviewConfig(diff: string, cache?: FileReviewCache): FileReviewConfig {
  return {
    diffByFile: splitDiffByFile(diff),
    cache,
  };
}

export function mergeFileReviewFindings(results: FileReviewResult[]): QualityFinding[] {
  const seen = new Set<string>();
  const out: QualityFinding[] = [];
  for (const r of results) {
    for (const f of r.findings) {
      const key = `${f.ruleId}:${f.file}:${f.line || 0}:${f.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out.slice(0, 40);
}
