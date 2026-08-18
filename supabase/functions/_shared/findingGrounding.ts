/**
 * Ground Validate & Review findings to the reviewed diff.
 * Drops LLM inventions like `(project root)` and mass-deletion claims with no deleted paths.
 * Keep in sync with supabase/functions/_shared/findingGrounding.ts
 */

export interface ChangedFileRef {
  path?: string;
  file?: string;
  status?: string;
}

export interface GroundingStats {
  rawFindingCount: number;
  droppedUngroundedCount: number;
  syntheticPathCount: number;
  hallucinationRate: number;
}

const ALLOWED_SYNTHETIC_PATHS = new Set(['(scope)', '(none)']);

const DELETION_CLAIM_RE =
  /\b(delet(?:e|ed|ing|ion)|remov(?:e|ed|ing)|wiped|without\s+replacement|non-functional\s+state|no\s+build\s+configuration)\b/i;

const INFRA_FILE_RE =
  /\b(\.gitignore|readme(?:\.md)?|package(?:-lock)?\.json|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|eslint\.config\.\w+|index\.html|tsconfig(?:\.\w+)?\.json|dockerfile|vite\.config\.\w+|next\.config\.\w+)\b/i;

const DETERMINISTIC_SOURCES = new Set(['local_engine', 'sast', 'scanner']);
const DETERMINISTIC_DETECTORS = new Set([
  'secret_scanner', 'dependency_scanner', 'ast_rule', 'dataflow', 'metric', 'architecture', 'ac_validator',
]);

const SEVERITY_DOWN: Record<string, string> = {
  critical: 'high',
  high: 'medium',
  major: 'medium',
  medium: 'low',
  minor: 'low',
};

export function normalizeFindingPath(file: unknown): string {
  return String(file || '').replace(/\\/g, '/').trim();
}

/** Parenthetical placeholders, unknown, empty — not a real workspace path. */
export function isSyntheticFindingPath(file: unknown): boolean {
  const f = normalizeFindingPath(file);
  if (!f) { return true; }
  if (/^unknown$/i.test(f)) { return true; }
  if (/^\(.*\)$/.test(f)) { return true; }
  return false;
}

/** Intentional non-file anchors (scope drift / AC). */
export function isAllowedSyntheticPath(file: unknown): boolean {
  return ALLOWED_SYNTHETIC_PATHS.has(normalizeFindingPath(file).toLowerCase());
}

/** Safe to tell an IDE agent “open this file”. */
export function isLocatableFindingPath(file: unknown): boolean {
  return !isSyntheticFindingPath(file);
}

export function changedFilePathSet(changedFiles: ChangedFileRef[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const row of changedFiles || []) {
    const p = normalizeFindingPath(row.path || row.file);
    if (p) { set.add(p); }
  }
  return set;
}

export function deletedPathSet(changedFiles: ChangedFileRef[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const row of changedFiles || []) {
    const status = String(row.status || '').toLowerCase();
    if (status !== 'deleted' && status !== 'removed') { continue; }
    const p = normalizeFindingPath(row.path || row.file);
    if (p) { set.add(p); }
  }
  return set;
}

function pathInSet(file: string, set: Set<string>): boolean {
  const f = normalizeFindingPath(file);
  if (!f || !set.size) { return false; }
  if (set.has(f)) { return true; }
  const base = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
  for (const p of set) {
    if (p === f || p.endsWith('/' + f) || f.endsWith('/' + p)) { return true; }
    const pBase = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
    if (base && base === pBase) { return true; }
  }
  return false;
}

export function claimsMassDeletion(finding: {
  title?: string;
  explanation?: string;
  remediation?: string;
}): boolean {
  const blob = `${finding.title || ''} ${finding.explanation || ''} ${finding.remediation || ''}`;
  if (!DELETION_CLAIM_RE.test(blob)) { return false; }
  if (INFRA_FILE_RE.test(blob)) { return true; }
  const named = blob.match(/\b[\w.-]+\.[a-z0-9]{1,5}\b/gi) || [];
  return named.length >= 3;
}

function isDeterministicFinding(f: { source?: string; detectedBy?: string }): boolean {
  if (f.source && DETERMINISTIC_SOURCES.has(f.source)) { return true; }
  return Boolean(f.detectedBy && DETERMINISTIC_DETECTORS.has(f.detectedBy));
}

function isTestOrTypePath(file: string): boolean {
  const f = normalizeFindingPath(file).toLowerCase();
  return /(^|\/)tests?\//.test(f) || /(^|\/)__tests__\//.test(f) || /\.d\.ts$/.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || /\.spec\.[cm]?[jt]sx?$/.test(f);
}

function downgradeSeverity(severity: unknown): string {
  const s = String(severity || 'medium').toLowerCase();
  return SEVERITY_DOWN[s] || s;
}

/**
 * Light calibration: soft categories and test/type files should not stay critical.
 */
export function calibrateFindingSeverity<T extends {
  file?: string;
  severity?: string;
  category?: string;
  confidence?: string;
}>(finding: T): T {
  const cat = String(finding.category || '').toLowerCase();
  const confidence = String(finding.confidence || 'medium').toLowerCase();
  let next = finding;

  if (cat === 'pm_alignment' && String(finding.severity || '').toLowerCase() === 'critical' && confidence !== 'high') {
    next = { ...next, severity: 'high' };
  }
  if (isTestOrTypePath(String(finding.file || ''))) {
    const sev = String(next.severity || finding.severity || '').toLowerCase();
    if (sev === 'critical' || sev === 'high' || sev === 'major') {
      next = { ...next, severity: downgradeSeverity(sev) };
    }
  }
  return next;
}

export function emptyGroundingStats(): GroundingStats {
  return {
    rawFindingCount: 0,
    droppedUngroundedCount: 0,
    syntheticPathCount: 0,
    hallucinationRate: 0,
  };
}

/** Paths the review LLM was shown besides the diff (1-hop importers/callees/similar). */
export function neighborhoodPathSet(
  neighborhoodFiles?: Array<string | { path?: string; file?: string }> | undefined,
): Set<string> {
  const set = new Set<string>();
  for (const row of neighborhoodFiles || []) {
    const p = normalizeFindingPath(typeof row === 'string' ? row : (row.path || row.file));
    if (p) { set.add(p); }
  }
  return set;
}

export function codegraphNeighborhoodPaths(ctx?: {
  codegraphNeighborhood?: {
    importers?: Array<{ file?: string }>;
    importees?: Array<{ path?: string }>;
    similar?: Array<{ path?: string }>;
  };
  impactedFiles?: Array<{ path?: string }>;
}): string[] {
  const rows: Array<{ path?: string; file?: string }> = [];
  for (const i of ctx?.codegraphNeighborhood?.importers || []) { rows.push({ file: i.file }); }
  for (const c of ctx?.codegraphNeighborhood?.importees || []) { rows.push({ path: c.path }); }
  for (const s of ctx?.codegraphNeighborhood?.similar || []) { rows.push({ path: s.path }); }
  for (const f of ctx?.impactedFiles || []) { rows.push({ path: f.path }); }
  return [...neighborhoodPathSet(rows)];
}

/**
 * Drop ungrounded LLM findings and hallucinated “deleted the whole project” claims.
 * Keeps allowlisted synthetic paths `(scope)` / `(none)` and graph-neighborhood files.
 * When `statsOut` is provided, fills hallucination telemetry counters.
 */
export function groundReviewFindings<T extends {
  file?: string;
  title?: string;
  explanation?: string;
  remediation?: string;
  confidence?: string;
  severity?: string;
  category?: string;
  source?: string;
  detectedBy?: string;
}>(
  findings: T[],
  changedFiles: ChangedFileRef[] | undefined,
  statsOut?: GroundingStats,
  neighborhoodFiles?: Array<string | { path?: string; file?: string }>,
): T[] {
  const changed = changedFilePathSet(changedFiles);
  for (const p of neighborhoodPathSet(neighborhoodFiles)) { changed.add(p); }
  const deleted = deletedPathSet(changedFiles);
  const raw = findings || [];
  let dropped = 0;
  let syntheticEmitted = 0;

  const kept = raw.flatMap((f) => {
    const file = normalizeFindingPath(f.file);

    if (claimsMassDeletion(f)) {
      if (!deleted.size) { dropped += 1; return []; }
      const blob = `${f.title || ''} ${f.explanation || ''} ${f.remediation || ''}`;
      const namesDeleted = [...deleted].some((p) => {
        const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
        return blob.includes(p) || (base.length > 1 && blob.includes(base));
      });
      if (!namesDeleted) { dropped += 1; return []; }
    }

    if (isSyntheticFindingPath(file)) {
      if (isAllowedSyntheticPath(file)) {
        syntheticEmitted += 1;
        return [calibrateFindingSeverity(f)];
      }
      dropped += 1;
      return [];
    }

    if (changed.size && !pathInSet(file, changed)) {
      if (isDeterministicFinding(f)) {
        return [calibrateFindingSeverity({ ...f, confidence: 'low' })];
      }
      dropped += 1;
      return [];
    }

    return [calibrateFindingSeverity(f)];
  });

  if (statsOut) {
    statsOut.rawFindingCount = raw.length;
    statsOut.droppedUngroundedCount = dropped;
    statsOut.syntheticPathCount = syntheticEmitted;
    statsOut.hallucinationRate = raw.length
      ? Math.round((dropped / raw.length) * 1000) / 10
      : 0;
  }

  return kept;
}
