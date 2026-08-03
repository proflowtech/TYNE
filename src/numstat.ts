import { ChangedFileInfo } from './validateReviewTypes';

// Pure `git --numstat` parsing. Deliberately free of any `vscode` import so it
// can be unit-tested directly from `out/` without a VS Code host.

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * Normalizes the two rename spellings `--numstat` emits, keeping the
 * destination path so entries match what `--name-only` and git status report.
 *   `src/{old => new}/file.ts` -> `src/new/file.ts`
 *   `old.ts => new.ts`         -> `new.ts`
 */
export function normalizeNumstatPath(raw: string): string {
  let filePath = String(raw || '').trim().replace(/\\/g, '/');
  filePath = filePath.replace(/\{[^{}]*?\s=>\s*([^{}]*?)\}/g, '$1');
  const arrow = filePath.split(' => ');
  if (arrow.length === 2) { filePath = arrow[1].trim(); }
  // A collapsed brace segment (`src/{old => }/f.ts`) leaves a doubled slash.
  return filePath.replace(/\/{2,}/g, '/').replace(/^\//, '');
}

/**
 * Parses `git ... --numstat` output: `<additions>\t<deletions>\t<path>`, with
 * `-` in both count columns for binary files.
 *
 * This replaces a previous `--stat` scraper that matched `/(\d+) insertion/` —
 * a pattern that only ever appears in git's trailing summary line, never on a
 * per-file row — and then assigned those counts to files by array index. Every
 * per-file count it produced was zero or belonged to a different file.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!match) { continue; }
    const filePath = normalizeNumstatPath(match[3]);
    if (!filePath) { continue; }
    const binary = match[1] === '-' || match[2] === '-';
    entries.push({
      path: filePath,
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return entries;
}

/** Merges counts onto the changed-file list by path. Files with no numstat row keep 0/0. */
export function mergeNumstat(files: ChangedFileInfo[], entries: NumstatEntry[]): ChangedFileInfo[] {
  const byPath = new Map<string, NumstatEntry>();
  entries.forEach(entry => byPath.set(entry.path, entry));
  return files.map(file => {
    const match = byPath.get(file.path);
    if (!match) { return file; }
    return { ...file, additions: match.additions, deletions: match.deletions };
  });
}
