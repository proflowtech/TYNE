/**
 * Post-Fix scope blowout: compare workspace touch before agent handoff vs now.
 *
 * Intended edits on finding files (including large ones) are not blowout —
 * line growth there *is* the Fix-in-IDE. Blowout is unexpected extra files.
 */

import { totalLineDelta } from './findingLineRemap';

export interface TouchSnapshot {
  paths: string[];
  totalLineDelta: number;
  findingFiles: string[];
  at: string;
  workspace?: string;
}

export interface ScopeBlowoutAssessment {
  blowout: boolean;
  extraPaths: string[];
  lineDeltaGrowth: number;
  message: string;
}

/** Any file not already dirty and not cited by the finding is extra. */
const DEFAULT_EXTRA_FILE_LIMIT = 0;
/** Ignore leftover Fix-in-IDE snapshots after this (stale global leftovers blocked reviews). */
export const PREFIX_SNAPSHOT_TTL_MS = 90 * 60 * 1000;

function normalizePath(p: unknown): string {
  return String(p || '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
}

export function buildTouchSnapshot(args: {
  paths: string[];
  additionsDeletions?: Array<{ additions?: number; deletions?: number }>;
  findingFiles?: string[];
  at?: string;
  workspace?: string;
}): TouchSnapshot {
  const paths = [...new Set((args.paths || []).map(normalizePath).filter(Boolean))].sort();
  return {
    paths,
    totalLineDelta: totalLineDelta(args.additionsDeletions || []),
    findingFiles: [...new Set((args.findingFiles || []).map(normalizePath).filter(Boolean))],
    at: args.at || new Date().toISOString(),
    workspace: args.workspace,
  };
}

/** Drop snapshots that are stale or from another workspace. */
export function isUsablePreFixSnapshot(
  before: TouchSnapshot | null | undefined,
  workspace?: string,
): before is TouchSnapshot {
  if (!before?.at) { return false; }
  const age = Date.now() - Date.parse(before.at);
  if (!Number.isFinite(age) || age < 0 || age > PREFIX_SNAPSHOT_TTL_MS) { return false; }
  if (before.workspace && workspace && before.workspace !== workspace) { return false; }
  return true;
}

export function assessScopeBlowout(
  before: TouchSnapshot | null | undefined,
  after: TouchSnapshot,
  opts?: { maxExtraFiles?: number },
): ScopeBlowoutAssessment {
  if (!before) {
    return { blowout: false, extraPaths: [], lineDeltaGrowth: 0, message: '' };
  }
  const maxExtra = opts?.maxExtraFiles ?? DEFAULT_EXTRA_FILE_LIMIT;
  const allowed = new Set([...before.paths, ...before.findingFiles]);
  const unexpected = after.paths.filter((p) => !allowed.has(p));
  const lineDeltaGrowth = Math.max(0, after.totalLineDelta - before.totalLineDelta);
  const blowout = unexpected.length > maxExtra;

  const parts: string[] = [];
  if (unexpected.length) {
    parts.push(`${unexpected.length} file(s) outside the finding scope were touched (${unexpected.slice(0, 4).join(', ')}${unexpected.length > 4 ? '…' : ''})`);
  }
  return {
    blowout,
    extraPaths: unexpected,
    lineDeltaGrowth,
    message: blowout
      ? `Scope blowout: ${parts.join('; ')}. Re-validate will spend a credit — continue only if intentional.`
      : '',
  };
}
