/**
 * Remap finding line numbers through a unified diff (agent edits).
 * Prefer git hunk math over a third-party diff library.
 */

export interface RemappableFinding {
  file?: string;
  line?: number;
  endLine?: number;
  lineVerified?: boolean;
  agentPrompt?: string;
}

export interface LineRemapResult<T extends RemappableFinding> {
  findings: T[];
  remappedCount: number;
}

function normalizePath(file: unknown): string {
  return String(file || '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
}

/**
 * Parse unified diff into per-file old→new line maps for surviving (ctx/del→new) lines.
 * Deleted lines map to undefined (caller marks low confidence).
 */
export function buildOldToNewLineMaps(diff: string): Map<string, Map<number, number | undefined>> {
  const byFile = new Map<string, Map<number, number | undefined>>();
  if (!diff) { return byFile; }

  let currentFile = '';
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const ensure = (file: string) => {
    if (!byFile.has(file)) { byFile.set(file, new Map()); }
    return byFile.get(file)!;
  };

  for (const raw of String(diff).replace(/\r/g, '').split('\n')) {
    const fileMatch = raw.match(/^\+\+\+ [ab]\/(.+)$/) || raw.match(/^\+\+\+ (.+)$/);
    if (fileMatch) {
      const p = normalizePath(fileMatch[1]);
      currentFile = p === '/dev/null' ? '' : p;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) { continue; }

    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = Boolean(currentFile);
      continue;
    }
    if (!inHunk || !currentFile) { continue; }

    const map = ensure(currentFile);
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      map.set(oldLine, undefined);
      oldLine += 1;
      continue;
    }
    if (raw.startsWith('\\')) { continue; }
    // context or empty marker
    if (raw.startsWith(' ') || raw === '') {
      map.set(oldLine, newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return byFile;
}

function remapOneLine(
  map: Map<number, number | undefined> | undefined,
  line: number | undefined,
): { line?: number; verified: boolean } {
  if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) {
    return { line, verified: false };
  }
  if (!map || !map.size) {
    // No hunks for this file — try net shift from nearest mapped neighbors.
    return { line, verified: true };
  }
  if (map.has(line)) {
    const next = map.get(line);
    if (typeof next !== 'number') { return { line: undefined, verified: false }; }
    return { line: next, verified: true };
  }
  // Interpolate: find nearest mapped old line below and apply delta.
  let bestOld = -1;
  let bestNew: number | undefined;
  for (const [old, neu] of map) {
    if (old <= line && old > bestOld && typeof neu === 'number') {
      bestOld = old;
      bestNew = neu;
    }
  }
  if (bestOld >= 0 && typeof bestNew === 'number') {
    return { line: bestNew + (line - bestOld), verified: false };
  }
  return { line, verified: false };
}

/** Remap finding anchors through an agent/working-tree unified diff. */
export function remapFindingsThroughDiff<T extends RemappableFinding>(
  findings: T[],
  diff: string,
): LineRemapResult<T> {
  const maps = buildOldToNewLineMaps(diff);
  let remappedCount = 0;
  const out = (findings || []).map((f) => {
    const file = normalizePath(f.file);
    if (!file || isNaN(Number(f.line))) { return f; }
    const map = maps.get(file);
    if (!map) {
      // Try basename match (git sometimes omits dirs in odd renames).
      let matched: Map<number, number | undefined> | undefined;
      for (const [p, m] of maps) {
        if (p === file || p.endsWith('/' + file) || file.endsWith('/' + p)) {
          matched = m;
          break;
        }
      }
      if (!matched) { return f; }
      return remapFinding(f, matched, () => { remappedCount += 1; });
    }
    return remapFinding(f, map, () => { remappedCount += 1; });
  });
  return { findings: out, remappedCount };
}

function remapFinding<T extends RemappableFinding>(
  f: T,
  map: Map<number, number | undefined>,
  onRemap: () => void,
): T {
  const start = remapOneLine(map, typeof f.line === 'number' ? f.line : Number(f.line) || undefined);
  const endSrc = typeof f.endLine === 'number' ? f.endLine : Number(f.endLine) || undefined;
  const end = remapOneLine(map, endSrc);
  if (start.line === f.line && end.line === f.endLine && start.verified) { return f; }
  onRemap();
  const next: T = {
    ...f,
    line: start.line,
    endLine: end.line ?? start.line,
    lineVerified: start.verified && end.verified,
    agentPrompt: undefined,
  };
  return next;
}

/** Net line delta from numstat-style rows (for scope blowout). */
export function totalLineDelta(entries: Array<{ additions?: number; deletions?: number }>): number {
  return (entries || []).reduce((n, e) => n + Math.abs(Number(e.additions) || 0) + Math.abs(Number(e.deletions) || 0), 0);
}
