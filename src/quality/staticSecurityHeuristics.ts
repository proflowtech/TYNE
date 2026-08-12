/**
 * Minimal deterministic security/compliance heuristics shared by host review
 * and offline eval. Not a full “legacy security engine” — only patterns the
 * golden seeds + common AI-slop miss without these checks.
 */

export type HeuristicCategory = 'security' | 'compliance' | 'maintainability';

export interface HeuristicFinding {
  id: string;
  file: string;
  line?: number;
  severity: 'critical' | 'high' | 'medium';
  category: HeuristicCategory;
  title: string;
  explanation: string;
  confidence: 'high' | 'medium';
  detectedBy: 'ast_rule';
  blocking: boolean;
}

interface DiffLine {
  file: string;
  line: number;
  text: string;
}

function linesFromDiff(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let file = 'unknown';
  let newLine = 0;
  for (const raw of String(diff || '').split(/\r?\n/)) {
    const fileMatch = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch) { file = fileMatch[1]; continue; }
    const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) { newLine = Number(hunk[1]) || 0; continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ file, line: newLine || 1, text: raw.slice(1) });
      newLine += 1;
    } else if (!raw.startsWith('-') && newLine) {
      newLine += 1;
    }
  }
  return rows;
}

/** Scan added diff lines for weak crypto, XSS sinks, sensitive logging, and N+1 query loops. */
export function detectStaticSecurityHeuristics(diff: string): HeuristicFinding[] {
  const findings: HeuristicFinding[] = [];
  const seen = new Set<string>();
  const rows = linesFromDiff(diff);

  for (const row of rows) {
    const t = row.text;
    const push = (partial: Omit<HeuristicFinding, 'file' | 'line'>) => {
      const key = `${partial.id}:${row.file}:${row.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ ...partial, file: row.file, line: row.line });
    };

    if (/createHash\s*\(\s*['"]md5['"]\s*\)/i.test(t) || /\.createHash\s*\(\s*['"]md5['"]/i.test(t)) {
      push({
        id: 'weak_crypto_md5',
        severity: 'critical',
        category: 'security',
        title: 'Weak hashing (MD5)',
        explanation: 'MD5 is cryptographically broken. Use bcrypt, scrypt, or Argon2 for passwords; SHA-256+ for integrity.',
        confidence: 'high',
        detectedBy: 'ast_rule',
        blocking: true,
      });
    }
    if (/createHash\s*\(\s*['"]sha1['"]\s*\)/i.test(t)) {
      push({
        id: 'weak_crypto_sha1',
        severity: 'high',
        category: 'security',
        title: 'Weak hashing (SHA-1)',
        explanation: 'SHA-1 is deprecated for security-sensitive hashing. Prefer SHA-256 or a password KDF.',
        confidence: 'high',
        detectedBy: 'ast_rule',
        blocking: true,
      });
    }
    if (/dangerouslySetInnerHTML/.test(t)) {
      push({
        id: 'xss_dangerously_set_inner_html',
        severity: 'high',
        category: 'security',
        title: 'Potential XSS via dangerouslySetInnerHTML',
        explanation: 'Rendering unsanitized HTML enables XSS. Sanitize or avoid dangerouslySetInnerHTML.',
        confidence: 'high',
        detectedBy: 'ast_rule',
        blocking: true,
      });
    }
    if (/console\.(?:log|info|debug|warn)\s*\(/.test(t)
      && /\b(ssn|phi|diagnosis|patient|email)\b/i.test(t)) {
      push({
        id: 'sensitive_data_logged',
        severity: 'high',
        category: 'compliance',
        title: 'Sensitive data logged',
        explanation: 'Console logging of PHI/PII (SSN, patient, diagnosis, email) risks compliance violations.',
        confidence: 'high',
        detectedBy: 'ast_rule',
        blocking: true,
      });
    }
  }

  // N+1: loop window with a DB query inside (maintainability / perf smell).
  for (let i = 0; i < rows.length; i++) {
    const window = rows.slice(i, Math.min(rows.length, i + 4)).map(r => r.text).join('\n');
    if (/\bfor\s*\(/.test(window) && /\.(?:query|execute)\s*\(/.test(window)
      && /\+|\$\{/.test(window)) {
      const row = rows[i];
      const key = `n_plus_one:${row.file}:${row.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          id: 'n_plus_one_query',
          file: row.file,
          line: row.line,
          severity: 'medium',
          category: 'maintainability',
          title: 'Possible N+1 query in loop',
          explanation: 'Database query inside a loop often causes N+1 performance issues. Batch or join instead.',
          confidence: 'medium',
          detectedBy: 'ast_rule',
          blocking: false,
        });
      }
      break;
    }
  }

  return findings.slice(0, 24);
}

/** Build file bodies from a unified diff (added lines only) for injection/secrets scanners. */
export function changedFilesFromDiff(diff: string): Record<string, string> {
  const byFile = new Map<string, string[]>();
  let file = '';
  for (const raw of String(diff || '').split(/\r?\n/)) {
    const fileMatch = raw.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[1];
      if (!byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      byFile.get(file)!.push(raw.slice(1));
    }
  }
  const out: Record<string, string> = {};
  for (const [f, lines] of byFile) {
    out[f] = lines.join('\n');
  }
  return out;
}
