/**
 * Pure helpers for multi-stage Validate & Review (chunk packs + file-hash cache).
 * Keep in sync with supabase/functions/_shared/validateReviewPipeline.ts
 */

export interface DiffFilePack {
  files: string[];
  diff: string;
  contentHashes: Record<string, string>;
}

export interface FileReviewCacheEntry {
  hash: string;
  findings: unknown[];
  updatedAt?: string;
}

export type FileReviewCache = Record<string, FileReviewCacheEntry>;

export const REVIEW_FILE_BATCH_SIZE = 5;

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    chunks.push(arr.slice(i, i + n));
  }
  return chunks;
}

export function hashContent(text: string): string {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function splitDiffByFile(diff: string): Record<string, string> {
  const raw = String(diff || '');
  const byFile: Record<string, string> = {};
  if (!raw.trim()) return byFile;

  const parts = raw.split(/(?=^diff --git )/m).filter(Boolean);
  for (const part of parts) {
    const gitHeader = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    let path = '';
    if (gitHeader) {
      path = gitHeader[2] || gitHeader[1] || '';
    } else {
      const plus = part.match(/^\+\+\+ (?:b\/)?(.+)$/m);
      path = plus?.[1] && plus[1] !== '/dev/null' ? plus[1] : '';
    }
    path = path.replace(/\\/g, '/').trim();
    if (!path || path === '/dev/null') continue;
    byFile[path] = (byFile[path] || '') + part;
  }

  if (!Object.keys(byFile).length && raw.trim()) {
    byFile['(diff)'] = raw;
  }
  return byFile;
}

export function packDiffByFiles(
  diff: string,
  options?: { maxFilesPerPack?: number; maxCharsPerPack?: number },
): DiffFilePack[] {
  const maxFiles = options?.maxFilesPerPack ?? 3;
  const maxChars = options?.maxCharsPerPack ?? 28_000;
  const byFile = splitDiffByFile(diff);
  const paths = Object.keys(byFile).sort((a, b) => a.localeCompare(b));
  const packs: DiffFilePack[] = [];

  let files: string[] = [];
  let chunk = '';
  let hashes: Record<string, string> = {};

  const flush = () => {
    if (!files.length && !chunk) return;
    packs.push({ files: files.slice(), diff: chunk, contentHashes: { ...hashes } });
    files = [];
    chunk = '';
    hashes = {};
  };

  for (const path of paths) {
    const fileDiff = byFile[path];
    const fileHash = hashContent(fileDiff);
    const nextLen = chunk.length + fileDiff.length + 1;
    if ((files.length >= maxFiles || nextLen > maxChars) && files.length > 0) {
      flush();
    }
    if (!files.length && fileDiff.length > maxChars) {
      packs.push({
        files: [path],
        diff: fileDiff.slice(0, maxChars) + '\n... [pack truncated] ...',
        contentHashes: { [path]: fileHash },
      });
      continue;
    }
    files.push(path);
    chunk += (chunk ? '\n' : '') + fileDiff;
    hashes[path] = fileHash;
  }
  flush();
  return packs;
}

export function partitionPacksByCache(
  packs: DiffFilePack[],
  cache: FileReviewCache | null | undefined,
): { cachedFindings: unknown[]; freshPacks: DiffFilePack[] } {
  const cachedFindings: unknown[] = [];
  const freshPacks: DiffFilePack[] = [];
  const safeCache = cache && typeof cache === 'object' ? cache : {};

  for (const pack of packs) {
    const allCached = pack.files.length > 0 && pack.files.every(file => {
      const entry = safeCache[file];
      return entry && entry.hash === pack.contentHashes[file] && Array.isArray(entry.findings);
    });
    if (allCached) {
      for (const file of pack.files) {
        const entry = safeCache[file];
        if (entry?.findings?.length) cachedFindings.push(...entry.findings);
      }
    } else {
      freshPacks.push(pack);
    }
  }
  return { cachedFindings, freshPacks };
}

export function buildFileReviewCache(
  packs: DiffFilePack[],
  findingsByFile: Record<string, unknown[]>,
  prior?: FileReviewCache | null,
): FileReviewCache {
  const next: FileReviewCache = { ...(prior || {}) };
  const now = new Date().toISOString();
  for (const pack of packs) {
    for (const file of pack.files) {
      next[file] = {
        hash: pack.contentHashes[file] || hashContent(pack.diff),
        findings: findingsByFile[file] || [],
        updatedAt: now,
      };
    }
  }
  const keys = Object.keys(next);
  if (keys.length > 80) {
    keys
      .sort((a, b) => String(next[a].updatedAt || '').localeCompare(String(next[b].updatedAt || '')))
      .slice(0, keys.length - 80)
      .forEach(k => { delete next[k]; });
  }
  return next;
}

export function groupFindingsByFile(findings: unknown[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as { file?: string };
    const file = typeof f.file === 'string' ? f.file : '';
    if (!file) continue;
    if (!out[file]) out[file] = [];
    out[file].push(raw);
  }
  return out;
}

/** Round-robin starting model for a pack index, then up to maxFallbacks configs. */
export function rotateConfigsForPack<T extends { model: string }>(
  configs: T[],
  packIndex: number,
  maxFallbacks = 2,
): T[] {
  if (!configs.length) return [];
  const start = ((packIndex % configs.length) + configs.length) % configs.length;
  const rotated = [...configs.slice(start), ...configs.slice(0, start)];
  return rotated.slice(0, Math.max(1, maxFallbacks));
}
