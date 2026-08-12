/**
 * Review mode + large-PR performance helpers (shared by ValidateReviewService).
 *
 * PART 0 diagnosis (from code audit — instrument timings confirm in runReview):
 * Bottlenecks that grow with PR size (priority order):
 * 1. edge_function_call / LLM chunks — sequential or low-concurrency LLM on every
 *    file pack; ~4–15s per pack → 15+ packs easily exceeds 60–90s (PRIMARY).
 * 2. collect_context — findFiles(500) + full-content reads for changed files scales
 *    with changed-file count and nearby graph, not "diff only".
 * 3. static_analysis — runTsc() runs full `tsc --noEmit` on the whole project
 *    (10s timeout) then filters to changed files (SECONDARY on large repos).
 * 4. clone detection — O(changed × nearby) Jaccard; nearby capped but still
 *    quadratic in that product (TERTIARY vs LLM).
 * 5. Payload size — unbounded changedFileContents + diff inflate upload + prompt.
 * Local quality / parallel vibe are relatively cheap vs LLM.
 */

export type ReviewMode = 'full' | 'quick' | 'triage';

export interface ReviewModeConfig {
  runLocalQualityEngine: boolean;
  runPevAgents: boolean;
  runComplianceEngine: boolean;
  maxFilesDeepReview: number;
  maxFilesQuickReview: number;
}

export const MODE_CONFIGS: Record<ReviewMode, ReviewModeConfig> = {
  full: {
    runLocalQualityEngine: true,
    runPevAgents: true,
    runComplianceEngine: true,
    maxFilesDeepReview: 40,
    maxFilesQuickReview: 200,
  },
  quick: {
    runLocalQualityEngine: true,
    runPevAgents: false,
    runComplianceEngine: false,
    maxFilesDeepReview: 15,
    maxFilesQuickReview: 100,
  },
  triage: {
    runLocalQualityEngine: true,
    runPevAgents: false,
    runComplianceEngine: false,
    maxFilesDeepReview: 0,
    maxFilesQuickReview: 300,
  },
};

export interface StageTiming {
  stage: string;
  durationMs: number;
  inputSize: number;
}

export async function timeStage<T>(
  timings: StageTiming[],
  stage: string,
  inputSize: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ stage, durationMs: Date.now() - start, inputSize });
  }
}

export interface PrSizeClass {
  fileCount: number;
  totalLinesChanged: number;
  totalDiffBytes: number;
  classification: 'small' | 'medium' | 'large' | 'huge';
}

export function classifyPrSize(
  diff: string,
  changedFileCount: number,
): PrSizeClass {
  const totalLinesChanged = String(diff || '')
    .split('\n')
    .filter(l => l.startsWith('+') || l.startsWith('-'))
    .filter(l => !l.startsWith('+++') && !l.startsWith('---'))
    .length;
  const totalDiffBytes = String(diff || '').length;
  let classification: PrSizeClass['classification'] = 'small';
  if (changedFileCount > 100 || totalLinesChanged > 5000) classification = 'huge';
  else if (changedFileCount > 40 || totalLinesChanged > 1500) classification = 'large';
  else if (changedFileCount > 10 || totalLinesChanged > 400) classification = 'medium';
  return { fileCount: changedFileCount, totalLinesChanged, totalDiffBytes, classification };
}

/** Never silently upgrade — only downgrade to protect against timeout. */
export function autoSelectMode(requested: ReviewMode, size: PrSizeClass): ReviewMode {
  if (size.classification === 'huge' && (requested === 'full' || requested === 'quick')) return 'triage';
  if (size.classification === 'large' && requested === 'full') return 'quick';
  return requested;
}

/**
 * Incomplete / shallow reviews must never claim a full pass.
 * Call after pack stats / mode / warnings are known.
 */
export function enforceIncompleteReviewHonesty(input: {
  status?: string;
  score?: number;
  actualMode?: ReviewMode | string;
  failedPacks?: number;
  reviewWarnings?: Array<{ type?: string }>;
}): { status: string; score?: number; demoted: boolean } {
  const failed = Number(input.failedPacks || 0);
  const mode = String(input.actualMode || '');
  const warnings = input.reviewWarnings || [];
  const incompleteWarn = warnings.some(w =>
    w?.type === 'llm_review_incomplete' || w?.type === 'auto_downgraded');
  const shallow = mode === 'triage' || failed > 0 || incompleteWarn;
  if (!shallow || input.status !== 'passed') {
    return { status: String(input.status || 'needs_work'), score: input.score, demoted: false };
  }
  const status = failed > 0 || mode === 'triage' ? 'context_limited' : 'needs_work';
  const score = typeof input.score === 'number'
    ? Math.min(input.score, failed > 0 || mode === 'triage' ? 75 : 89)
    : input.score;
  return { status, score, demoted: true };
}

export interface FileRiskScore {
  file: string;
  score: number;
  reasons: string[];
}

export function rankFilesByRisk(
  files: string[],
  hints?: { secretFiles?: Set<string>; injectionFiles?: Set<string> },
): FileRiskScore[] {
  return files.map(file => {
    let score = 0;
    const reasons: string[] = [];
    if (hints?.secretFiles?.has(file)) { score += 100; reasons.push('secret_detected'); }
    if (hints?.injectionFiles?.has(file)) { score += 90; reasons.push('injection_risk'); }
    if (/auth|permission|security|payment|billing/i.test(file)) { score += 50; reasons.push('sensitive_path'); }
    if (/\.test\.|\.spec\./i.test(file)) { score -= 30; reasons.push('test_file'); }
    if (/\.md$|\.txt$|package-lock\.json|yarn\.lock$/i.test(file)) { score -= 50; reasons.push('non_code_file'); }
    return { file, score, reasons };
  }).sort((a, b) => b.score - a.score);
}

export interface ReviewWarning {
  type: string;
  count?: number;
  files?: string[];
  reason?: string;
  message?: string;
}

export function selectFilesForMode(
  ranked: FileRiskScore[],
  config: ReviewModeConfig,
): { deepReviewed: string[]; skippedButSummarized: string[]; untouched: string[]; warnings: ReviewWarning[] } {
  const deep = ranked.slice(0, config.maxFilesDeepReview).map(f => f.file);
  const summarized = ranked.slice(config.maxFilesDeepReview, config.maxFilesQuickReview).map(f => f.file);
  const untouched = ranked.slice(config.maxFilesQuickReview).map(f => f.file);
  const warnings: ReviewWarning[] = [];
  if (untouched.length) {
    warnings.push({
      type: 'files_not_reviewed',
      count: untouched.length,
      files: untouched.slice(0, 20),
      reason: `PR exceeds ${config.maxFilesQuickReview} file cap for this mode`,
    });
  }
  return { deepReviewed: deep, skippedButSummarized: summarized, untouched, warnings };
}

// Must stay under client fetch abort (300s) but leave room for edge LLM on large PRs.
export const GLOBAL_REVIEW_BUDGET_MS = 240_000;
export const TIMEOUT_SENTINEL = Symbol('timeout');

export function timeoutAfter(ms: number): Promise<typeof TIMEOUT_SENTINEL> {
  return new Promise(resolve => setTimeout(() => resolve(TIMEOUT_SENTINEL), Math.max(0, ms)));
}

export async function reviewFilesConcurrently<T>(
  files: string[],
  reviewFn: (file: string) => Promise<T>,
  concurrency = 6,
  perFileTimeoutMs = 15_000,
): Promise<Array<T | { file: string; error: string }>> {
  const results: Array<T | { file: string; error: string }> = [];
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;
      try {
        const result = await Promise.race([
          reviewFn(file),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('per_file_timeout')), perFileTimeoutMs)),
        ]);
        results.push(result);
      } catch (err) {
        results.push({ file, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, files.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export type ReviewProgressEvent =
  | { type: 'review_progress'; stage: string; status: 'started' | 'done'; filesRemaining?: number }
  | { type: 'review_partial_result'; stage: string; findings?: unknown[]; message?: string }
  | {
      type: 'proof_strike_progress';
      items: Array<{ text: string; status: 'implemented' | 'partial' | 'missing' }>;
    };

export type ReviewProgressFn = (event: ReviewProgressEvent) => void;
