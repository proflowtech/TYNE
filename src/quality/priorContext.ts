/**
 * Prior-decision context: which earlier commits touched the same lines the
 * current diff touches, and why (their commit subject).
 *
 * The point is not "this file changed recently" — that's nearly always true
 * and tells the reviewer nothing. The point is "a prior commit deliberately
 * touched *this exact region*", which is the closest a deterministic signal
 * can get to answering "why was it written this way" without asking anyone.
 *
 * Orchestration here is pure and injection-based (`fetchHistory` is passed
 * in) so it is fully testable without git or vscode — `gitManager.ts` is the
 * only place that touches either.
 */

import { changedLineRanges } from './semantic/semanticCloneDetector';

export interface PriorLineCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export interface PriorChangeEntry extends PriorLineCommit {
  file: string;
}

const ZERO_HASH = '0'.repeat(40);
const BLAME_HASH_LINE = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/;

/**
 * Parse `git blame --porcelain` output into unique prior commits, in the
 * order they first appear.
 *
 * Porcelain repeats full metadata (author/summary/etc.) only the first time a
 * commit is seen within the blamed range — later lines from the same commit
 * are compact, hash-line only. This walks the stream once, keeping the first
 * full record per hash rather than re-parsing per line.
 *
 * Deliberately kept here rather than in `gitManager.ts`: this is pure text
 * parsing with no git or vscode dependency, so it can be unit tested against
 * fixture porcelain text directly, without a real repo or the vscode module.
 */
export function parseBlamePorcelain(raw: string): PriorLineCommit[] {
  const order: string[] = [];
  const meta = new Map<string, { author?: string; time?: string; summary?: string }>();
  let current: string | null = null;

  for (const line of raw.split('\n')) {
    const hashMatch = line.match(BLAME_HASH_LINE);
    if (hashMatch) {
      current = hashMatch[1];
      if (!meta.has(current)) {
        meta.set(current, {});
        order.push(current);
      }
      continue;
    }
    if (!current) { continue; }
    if (line.startsWith('author ')) { meta.get(current)!.author = line.slice(7); }
    else if (line.startsWith('author-time ')) { meta.get(current)!.time = line.slice(12); }
    else if (line.startsWith('summary ')) { meta.get(current)!.summary = line.slice(8); }
  }

  const out: PriorLineCommit[] = [];
  for (const hash of order) {
    if (hash === ZERO_HASH) { continue; } // uncommitted lines — nothing prior to report
    const record = meta.get(hash);
    if (!record?.summary) { continue; } // defensive: malformed/truncated porcelain block
    const date = record.time ? new Date(Number(record.time) * 1000).toISOString().slice(0, 10) : '';
    out.push({
      hash: hash.slice(0, 7),
      date,
      author: (record.author || 'unknown').slice(0, 80),
      subject: record.summary.slice(0, 200),
    });
  }
  return out;
}

export type LineHistoryFetcher = (file: string, startLine: number, endLine: number) => Promise<PriorLineCommit[]>;

/** Don't blame every changed file — most touched files in a diff are boilerplate. */
const MAX_FILES = 6;
/** A large diff can have many hunks; only the first few are worth a blame call each. */
const MAX_RANGES_PER_FILE = 3;
/** Cap noise per file — one or two prior commits is a lead, ten is a wall of text. */
const MAX_COMMITS_PER_FILE = 2;
const MAX_TOTAL_ENTRIES = 8;

export async function collectPriorContext(
  changedFiles: string[],
  diff: string,
  fetchHistory: LineHistoryFetcher,
): Promise<PriorChangeEntry[]> {
  const ranges = changedLineRanges(diff);
  const out: PriorChangeEntry[] = [];

  for (const file of changedFiles.slice(0, MAX_FILES)) {
    if (out.length >= MAX_TOTAL_ENTRIES) { break; }
    const fileRanges = (ranges.get(file) || []).slice(0, MAX_RANGES_PER_FILE);
    if (!fileRanges.length) { continue; }

    const seen = new Set<string>();
    let forFile = 0;
    for (const [start, end] of fileRanges) {
      if (forFile >= MAX_COMMITS_PER_FILE || out.length >= MAX_TOTAL_ENTRIES) { break; }
      let commits: PriorLineCommit[];
      try {
        commits = await fetchHistory(file, start, end);
      } catch {
        continue; // one bad range must never fail the whole review
      }
      for (const commit of commits) {
        if (seen.has(commit.hash)) { continue; }
        seen.add(commit.hash);
        out.push({ file, ...commit });
        forFile++;
        if (forFile >= MAX_COMMITS_PER_FILE || out.length >= MAX_TOTAL_ENTRIES) { break; }
      }
    }
  }

  return out;
}

/** One line per prior commit, matching the plain-bullet style of the other prompt sections. */
export function formatPriorContext(entries: PriorChangeEntry[]): string {
  if (!entries.length) { return ''; }
  return entries
    .map(e => `- ${e.file}: "${e.subject}" (${e.author}, ${e.date}, ${e.hash})`)
    .join('\n');
}
