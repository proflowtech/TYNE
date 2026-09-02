/**
 * Final precision gate for review findings. This module is duplicated in the
 * Supabase Edge Function so the same adversarial cases protect local tests and
 * production review output.
 */

export interface PrecisionFinding {
  id?: string;
  ruleId?: string;
  file?: string;
  line?: number;
  severity?: string;
  category?: string;
  title?: string;
  explanation?: string;
  evidence?: string;
  confidence?: string;
  detectedBy?: string;
  blocking?: boolean;
  relatedLocations?: Array<{ file: string; line?: number }>;
  [key: string]: unknown;
}

export interface ReviewPrecisionStats {
  inputCount: number;
  outputCount: number;
  exactDuplicatesRemoved: number;
  semanticDuplicatesRemoved: number;
  nonActionableRemoved: number;
}

const LOCKFILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Gemfile\.lock|Cargo\.lock)$/i;
const JSON_MANIFEST_RE = /(^|\/)package\.json$/i;
const DEP_SECTION_RE = /^\s*["']?(dependencies|devDependencies|peerDependencies|optionalDependencies|bundledDependencies)["']?\s*[:=]/i;
const NON_DEP_SECTION_RE = /^\s*["']?(scripts|engines|config|lint-staged|workspaces)["']?\s*[:=]/i;
const REVIEW_ONLY_DEPENDENCY_RE = /dependency manifest changed and needs supply-chain review/i;
const REQUIREMENT_GAP_RE = /\b(does not|doesn't|fails? to|missing|required.+\bnot\b|without (?:clarifying|implementing|providing)|instead of (?:the )?required)\b/i;
const BENIGN_DOC_RE = /\b(readme|docs?|documentation|instructions?|guide|comment|example|heading|badge|link)\b/i;
const BENIGN_TOOLING_RE = /\b(lint|format(?:ter|ting)?|type[ -]?check|spell[ -]?check|developer command|local setup|troubleshoot)\b/i;

const STOP_WORDS = new Set([
  'scope', 'drift', 'added', 'add', 'addition', 'change', 'changed', 'project', 'required',
  'requirement', 'requirements', 'acceptance', 'criteria', 'does', 'not', 'without', 'for',
  'the', 'and', 'with', 'this', 'that', 'from', 'into', 'about', 'information', 'description',
  'presents', 'clarifying', 'implemented', 'implementation', 'issue', 'risk', 'potential',
]);

function normalizePath(path: unknown): string {
  return String(path || '').replace(/\\/g, '/').replace(/^\/?[ab]\//, '').trim();
}

function filePatch(diff: string, path: string): string[] {
  const wanted = normalizePath(path);
  const all = String(diff || '').split(/\r?\n/);
  const chunks: string[][] = [];
  let current: string[] | null = null;
  let matches = false;
  for (const line of all) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      if (current && matches) chunks.push(current);
      current = [line];
      matches = normalizePath(header[1]) === wanted || normalizePath(header[2]) === wanted;
    } else if (current) {
      current.push(line);
    }
  }
  if (current && matches) chunks.push(current);
  return chunks.length ? chunks.flat() : all;
}

function changedContentLines(lines: string[]): Array<{ index: number; text: string }> {
  const rows: Array<{ index: number; text: string }> = [];
  lines.forEach((line, index) => {
    if (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) {
      rows.push({ index, text: line.slice(1) });
    }
  });
  return rows;
}

/** True only when a manifest patch contains a package delta, not a script/doc edit. */
export function dependencyManifestHasPackageDelta(diff: string, path: string): boolean {
  const normalized = normalizePath(path);
  const lines = filePatch(diff, normalized);
  const changed = changedContentLines(lines);
  if (!changed.length) return false;
  if (LOCKFILE_RE.test(normalized)) return true;

  if (JSON_MANIFEST_RE.test(normalized)) {
    for (const row of changed) {
      if (DEP_SECTION_RE.test(row.text)) return true;
      if (!/^\s*["'][@a-z0-9_.\/-]+["']\s*:/i.test(row.text)) continue;
      const context = lines.slice(Math.max(0, row.index - 18), row.index + 1);
      let lastDependency = -1;
      let lastOther = -1;
      context.forEach((line, index) => {
        const content = line.replace(/^[ +\-]/, '');
        if (DEP_SECTION_RE.test(content)) lastDependency = index;
        if (NON_DEP_SECTION_RE.test(content)) lastOther = index;
      });
      if (lastDependency > lastOther) return true;
    }
    return false;
  }

  if (/(^|\/)(requirements\.txt|Gemfile|go\.mod)$/i.test(normalized)) {
    return changed.some(row => {
      const text = row.text.trim();
      return Boolean(text && !text.startsWith('#') && !/^(module|go)\s+/i.test(text));
    });
  }
  if (/(^|\/)(pyproject\.toml|Cargo\.toml)$/i.test(normalized)) {
    return changed.some(row => /\b(dependenc|optional-dependenc|dev-dependenc)/i.test(row.text))
      || changed.some(row => {
        const context = lines.slice(Math.max(0, row.index - 14), row.index + 1).join('\n');
        return /\[(?:tool\.[^.]+\.)?(?:dev-)?dependencies\]|\[.*dependenc.*\]/i.test(context);
      });
  }
  return false;
}

export function scopeAdditionDisposition(addition: string): 'candidate' | 'benign_adjacent' | 'requirement_gap' {
  const text = String(addition || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'benign_adjacent';
  if (REQUIREMENT_GAP_RE.test(text)) return 'requirement_gap';
  if (BENIGN_DOC_RE.test(text) && BENIGN_TOOLING_RE.test(text)) return 'benign_adjacent';
  if (/\b(typo|spelling|grammar|whitespace|formatting only)\b/i.test(text)) return 'benign_adjacent';
  return 'candidate';
}

function normalizedTitle(title: unknown): string {
  return String(title || '')
    .toLowerCase()
    .replace(/^(scope (?:gap|drift)|logic risk|security risk)\s*[:\-]\s*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function conceptTokens(title: unknown): Set<string> {
  return new Set(normalizedTitle(title).split(/\s+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)));
}

function semanticallySameScopeGap(a: PrecisionFinding, b: PrecisionFinding): boolean {
  if (String(a.category || '') !== 'pm_alignment' || String(b.category || '') !== 'pm_alignment') return false;
  const at = conceptTokens(a.title);
  const bt = conceptTokens(b.title);
  if (at.size < 3 || bt.size < 3) return false;
  let intersection = 0;
  for (const token of at) if (bt.has(token)) intersection++;
  return intersection >= 3 && intersection / Math.min(at.size, bt.size) >= 0.5;
}

function isSyntheticPath(path: unknown): boolean {
  const value = normalizePath(path);
  return !value || /^\(.*\)$/.test(value) || /^unknown$/i.test(value);
}

function preferenceScore(finding: PrecisionFinding): number {
  let score = isSyntheticPath(finding.file) ? 0 : 8;
  if (finding.line) score += 2;
  if (finding.blocking) score += 3;
  if (finding.severity === 'critical') score += 3;
  else if (finding.severity === 'high') score += 2;
  if (finding.confidence === 'high') score += 2;
  if (finding.detectedBy && finding.detectedBy !== 'llm') score += 2;
  if (finding.evidence) score += 1;
  return score;
}

function mergeDuplicate(a: PrecisionFinding, b: PrecisionFinding): PrecisionFinding {
  const winner = preferenceScore(b) > preferenceScore(a) ? b : a;
  const loser = winner === a ? b : a;
  const severityOrder = ['info', 'low', 'medium', 'high', 'critical'];
  const strongestSeverity = severityOrder.indexOf(String(a.severity || '').toLowerCase())
    >= severityOrder.indexOf(String(b.severity || '').toLowerCase())
    ? a.severity
    : b.severity;
  const related = [...(winner.relatedLocations || [])];
  if (!isSyntheticPath(loser.file) && loser.file && !related.some(row => row.file === loser.file && row.line === loser.line)) {
    related.push({ file: loser.file, line: loser.line });
  }
  return {
    ...winner,
    severity: strongestSeverity || winner.severity,
    blocking: a.blocking === true || b.blocking === true,
    explanation: winner.explanation || loser.explanation,
    evidence: winner.evidence || loser.evidence,
    ...(related.length ? { relatedLocations: related.slice(0, 8) } : {}),
  };
}

function isNonActionableFinding(finding: PrecisionFinding): boolean {
  return String(finding.ruleId || '').toUpperCase() === 'SEC_DEPENDENCY_DELTA_REVIEW'
    || REVIEW_ONLY_DEPENDENCY_RE.test(String(finding.title || ''));
}

/** Apply after every review engine has contributed findings. */
export function applyReviewPrecisionGate(findings: PrecisionFinding[]): {
  findings: PrecisionFinding[];
  stats: ReviewPrecisionStats;
} {
  const output: PrecisionFinding[] = [];
  let exactDuplicatesRemoved = 0;
  let semanticDuplicatesRemoved = 0;
  let nonActionableRemoved = 0;

  for (const finding of findings || []) {
    if (!finding || !String(finding.title || '').trim()) continue;
    if (isNonActionableFinding(finding)) {
      nonActionableRemoved++;
      continue;
    }
    // Analyzer-specific rule IDs must not make the same user-visible issue
    // appear twice. File + normalized title is the exact identity boundary.
    const exactKey = `${normalizePath(finding.file)}:${normalizedTitle(finding.title)}`;
    const exactIndex = output.findIndex(row =>
      `${normalizePath(row.file)}:${normalizedTitle(row.title)}` === exactKey,
    );
    if (exactIndex >= 0) {
      output[exactIndex] = mergeDuplicate(output[exactIndex], finding);
      exactDuplicatesRemoved++;
      continue;
    }
    const semanticIndex = output.findIndex(row => semanticallySameScopeGap(row, finding));
    if (semanticIndex >= 0) {
      output[semanticIndex] = mergeDuplicate(output[semanticIndex], finding);
      semanticDuplicatesRemoved++;
      continue;
    }
    output.push({ ...finding });
  }

  return {
    findings: output,
    stats: {
      inputCount: (findings || []).length,
      outputCount: output.length,
      exactDuplicatesRemoved,
      semanticDuplicatesRemoved,
      nonActionableRemoved,
    },
  };
}
