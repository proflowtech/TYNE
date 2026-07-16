/**
 * Local deterministic security scan for Local Compliance Mode.
 * Runs on-device; never sends evidence snippets off-machine.
 * # ponytail: subset of edge scanDeterministicSecurity; expand rules when FP budget allows.
 */

export interface LocalSecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  ruleId: string;
  file?: string;
  line?: number;
  blocking: boolean;
  /** Hash-only — never raw evidence. */
  evidenceHash: string;
}

export interface LocalSecurityResult {
  findings: LocalSecurityFinding[];
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  status: 'clean' | 'warning' | 'blocked';
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function changedLines(diff: string): Array<{ file: string; line?: number; text: string }> {
  const rows: Array<{ file: string; line?: number; text: string }> = [];
  let file = 'unknown';
  let newLine = 0;
  for (const rawLine of String(diff || '').split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch) { file = fileMatch[1]; continue; }
    const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) { newLine = Number(hunk[1]) || 0; continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      rows.push({ file, line: newLine || undefined, text: rawLine.slice(1) });
      newLine++;
    } else if (!rawLine.startsWith('-') && newLine) {
      newLine++;
    }
  }
  return rows;
}

const SECRET_RE = /\b(?:sk|pk|api|tok|secret|bearer)[-_][A-Za-z0-9._-]{8,}\b/i;

export function runLocalSecurityScan(diff: string): LocalSecurityResult {
  const findings: LocalSecurityFinding[] = [];
  const lines = changedLines(diff);

  const add = (f: Omit<LocalSecurityFinding, 'id' | 'evidenceHash'> & { evidence: string }) => {
    findings.push({
      id: `loc_sec_${findings.length + 1}`,
      severity: f.severity,
      confidence: f.confidence,
      category: f.category,
      title: f.title,
      ruleId: f.ruleId,
      file: f.file,
      line: f.line,
      blocking: f.blocking,
      evidenceHash: hash(f.evidence),
    });
  };

  for (const row of lines) {
    const text = row.text;
    if (/(console\.(log|debug|info|warn|error)|logger\.(debug|info|warn|error))\([^)]*\b(password|secret|apiKey|accessToken|refreshToken|privateKey)\b/i.test(text)) {
      const isPassword = /password|passwd|pwd/i.test(text);
      add({
        ruleId: isPassword ? 'SEC_PASSWORD_LOG' : 'SEC_TOKEN_LOG',
        file: row.file,
        line: row.line,
        severity: isPassword ? 'critical' : 'high',
        confidence: 'high',
        blocking: isPassword,
        category: 'data_exposure',
        title: isPassword ? 'Password is logged' : 'Token or secret is logged',
        evidence: text,
      });
    }
    if (SECRET_RE.test(text) || /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/i.test(text)) {
      add({
        ruleId: 'SEC_SECRET_HARDCODED',
        file: row.file,
        line: row.line,
        severity: 'critical',
        confidence: 'high',
        blocking: true,
        category: 'secrets',
        title: 'Hardcoded secret or credential in source',
        evidence: text,
      });
    }
    if (/innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/i.test(text)) {
      add({
        ruleId: 'SEC_XSS_SINK',
        file: row.file,
        line: row.line,
        severity: 'high',
        confidence: 'medium',
        blocking: false,
        category: 'injection',
        title: 'Potential XSS sink without sanitization',
        evidence: text,
      });
    }
    if (/\beval\s*\(|new Function\s*\(/i.test(text)) {
      add({
        ruleId: 'SEC_CODE_EXEC',
        file: row.file,
        line: row.line,
        severity: 'critical',
        confidence: 'high',
        blocking: true,
        category: 'injection',
        title: 'Dynamic code execution sink',
        evidence: text,
      });
    }
    if (/child_process|execSync|spawnSync|exec\s*\([^)]*\$\{/i.test(text)) {
      add({
        ruleId: 'SEC_COMMAND_INJECTION',
        file: row.file,
        line: row.line,
        severity: 'high',
        confidence: 'medium',
        blocking: true,
        category: 'injection',
        title: 'Command execution may allow injection',
        evidence: text,
      });
    }
  }

  const criticalFindings = findings.filter(f => f.severity === 'critical').length;
  const highFindings = findings.filter(f => f.severity === 'high').length;
  const mediumFindings = findings.filter(f => f.severity === 'medium').length;
  const lowFindings = findings.filter(f => f.severity === 'low').length;
  const status = findings.some(f => f.blocking || f.severity === 'critical')
    ? 'blocked'
    : highFindings > 0
      ? 'warning'
      : 'clean';

  return {
    findings: findings.slice(0, 24),
    criticalFindings,
    highFindings,
    mediumFindings,
    lowFindings,
    status,
  };
}
