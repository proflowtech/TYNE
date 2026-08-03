/**
 * Post-Fix scope blowout: compare workspace touch before agent handoff vs now.
 */

import { totalLineDelta } from './findingLineRemap';

export interface TouchSnapshot {
  paths: string[];
  totalLineDelta: number;
  findingFiles: string[];
  at: string;
}

export interface ScopeBlowoutAssessment {
  blowout: boolean;
  extraPaths: string[];
  lineDeltaGrowth: number;
  message: string;
}

const DEFAULT_EXTRA_FILE_LIMIT = 0;
const DEFAULT_LINE_DELTA_LIMIT = 80;

function normalizePath(p: unknown): string {
  return String(p || '').replace(/\\/g, '/').trim().replace(/^\.\//, '');
}

export function buildTouchSnapshot(args: {
  paths: string[];
  additionsDeletions?: Array<{ additions?: number; deletions?: number }>;
  findingFiles?: string[];
  at?: string;
}): TouchSnapshot {
  const paths = [...new Set((args.paths || []).map(normalizePath).filter(Boolean))].sort();
  return {
    paths,
    totalLineDelta: totalLineDelta(args.additionsDeletions || []),
    findingFiles: [...new Set((args.findingFiles || []).map(normalizePath).filter(Boolean))],
    at: args.at || new Date().toISOString(),
  };
}

export function assessScopeBlowout(
  before: TouchSnapshot | null | undefined,
  after: TouchSnapshot,
  opts?: { maxExtraFiles?: number; maxLineDeltaGrowth?: number },
): ScopeBlowoutAssessment {
  if (!before) {
    return { blowout: false, extraPaths: [], lineDeltaGrowth: 0, message: '' };
  }
  const maxExtra = opts?.maxExtraFiles ?? DEFAULT_EXTRA_FILE_LIMIT;
  const maxDelta = opts?.maxLineDeltaGrowth ?? DEFAULT_LINE_DELTA_LIMIT;
  const beforeSet = new Set(before.paths);
  const allowed = new Set([...before.paths, ...before.findingFiles]);
  const extraPaths = after.paths.filter((p) => !allowed.has(p) && !beforeSet.has(p));
  // Also flag paths that were not in the finding set and not dirty before.
  const unexpected = after.paths.filter((p) => !allowed.has(p));
  const lineDeltaGrowth = Math.max(0, after.totalLineDelta - before.totalLineDelta);
  const blowout =
    unexpected.length > maxExtra || lineDeltaGrowth > maxDelta;

  const parts: string[] = [];
  if (unexpected.length) {
    parts.push(`${unexpected.length} file(s) outside the finding scope were touched (${unexpected.slice(0, 4).join(', ')}${unexpected.length > 4 ? '…' : ''})`);
  }
  if (lineDeltaGrowth > maxDelta) {
    parts.push(`~${lineDeltaGrowth} lines changed since Fix-in-IDE (threshold ${maxDelta})`);
  }
  return {
    blowout,
    extraPaths: unexpected.length ? unexpected : extraPaths,
    lineDeltaGrowth,
    message: blowout
      ? `Scope blowout: ${parts.join('; ')}. Re-validate will spend a credit — continue only if intentional.`
      : '',
  };
}
