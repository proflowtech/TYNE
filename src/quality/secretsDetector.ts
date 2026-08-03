/**
 * Deterministic hardcoded-secret scanner for Validate & Review.
 * Diff-scoped with full-file pass for multiline patterns (private keys).
 */

export type SecretConfidence = 'high' | 'medium' | 'low';
export type SecretVerdict = 'pass' | 'warn' | 'BLOCK';
export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';

export type SecretType =
  | 'aws_key'
  | 'github_token'
  | 'stripe_key'
  | 'database_password'
  | 'api_key'
  | 'jwt_token'
  | 'private_key'
  | 'slack_webhook'
  | 'oauth_token'
  | 'postgres_uri';

export interface SecretMatch {
  type: SecretType;
  /** Pattern / rule identifier (same as type). */
  pattern: string;
  line: number;
  file: string;
  confidence: SecretConfidence;
  value_preview: string;
}

export interface SecretDetectionResult {
  secrets: SecretMatch[];
  verdict: SecretVerdict;
  severity: SecretSeverity;
}

interface SecretRule {
  type: SecretType;
  /** Line-oriented regex (global). */
  re: RegExp;
  /** When true, also scan full file text (multiline). */
  multiline?: boolean;
}

const RULES: SecretRule[] = [
  { type: 'aws_key', re: /AKIA[0-9A-Z]{16}/g },
  { type: 'github_token', re: /gh[opstu]_[A-Za-z0-9_]{36,255}/g },
  { type: 'stripe_key', re: /(?:sk_live_|pk_live_)[A-Za-z0-9]{20,}/g },
  { type: 'database_password', re: /password\s*[:=]\s*["'][^"']{8,}["']/gi },
  { type: 'api_key', re: /api[_-]?key\s*[:=]\s*["'][^"']{20,}["']/gi },
  { type: 'jwt_token', re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g },
  {
    type: 'private_key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    multiline: true,
  },
  { type: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { type: 'oauth_token', re: /oauth[_-]?token\s*[:=]\s*["'][^"']{40,}["']/gi },
  { type: 'postgres_uri', re: /postgres(?:ql)?:\/\/[^:]+:[^@\s"'`]+@[^/\s"'`]+\/\w+/gi },
];

const ENV_FILE_RE = /\.(env|env\.\w+)$/i;
const CONFIG_FILE_RE = /(^|\/)(?:\.?env|config|settings|credentials|secrets?|\.npmrc|docker-compose|terraform|pulumi)/i;
const DOC_FILE_RE = /\.(md|mdx|rst|txt|adoc)$/i;
const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs|json|yaml|yml|vue|svelte)$/i;

function fileConfidence(file: string): SecretConfidence {
  const base = file.split('/').pop() || file;
  if (ENV_FILE_RE.test(base) || /\.(pem|key|p12|pfx)$/i.test(base)) return 'high';
  if (/^(config|settings|credentials|secrets?)\./i.test(base) || CONFIG_FILE_RE.test(file)) {
    return 'high';
  }
  if (DOC_FILE_RE.test(base)) return 'low';
  if (CODE_FILE_RE.test(base)) return 'medium';
  return 'medium';
}

function previewValue(raw: string, max = 24): string {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s.length > 8 ? `${s.slice(0, 4)}****` : '****';
  return `${s.slice(0, Math.min(12, max - 4))}****`;
}

function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  return !t || /^\/\//.test(t) || /^\/\*/.test(t) || /^\*/.test(t) || /^#/.test(t);
}

/** Strip trailing // comments without breaking URLs like postgres:// */
function codeLine(text: string): string {
  if (isCommentOnlyLine(text)) return '';
  const lastQuote = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"), text.lastIndexOf('`'));
  const slashIdx = text.indexOf('//');
  if (slashIdx >= 0 && slashIdx > lastQuote) {
    return text.slice(0, slashIdx);
  }
  return text.replace(/\/\*.*?\*\//g, '');
}

function isLikelyPlaceholder(value: string, fullLine: string): boolean {
  const v = value.trim().toLowerCase();
  // Rules like api_key match the whole assignment; check the quoted value too.
  const quoted = value.match(/["']([^"']*)["']\s*$/);
  const inner = (quoted ? quoted[1] : value).trim();
  // Match only obvious dummy literals, not substrings inside hostnames (e.g. db.example.com).
  if (/^(?:example|sample|xxx+|changeme|dummy|fake|test|placeholder|redacted|undefined|null)$/i.test(v)) {
    return true;
  }
  if (/placeholder|changeme|your[-_]|not[-_]?a[-_]?real|authorization_code/i.test(v)) return true;
  // Template markers and masked values: "<YOUR_KEY>", "${API_KEY}", "{{key}}", "%KEY%", "********".
  if (/^(?:<[^>]*>|\$\{[^}]*\}|%[^%]*%|\{\{[^}]*\}\})$/.test(inner)) return true;
  if (/^[x*#•._-]{8,}$/i.test(inner)) return true;
  if (/^(?:redacted|masked|hidden|removed)$/i.test(inner)) return true;
  if (/^["']?(password|secret|apikey|token)["']?\s*[:=]\s*["'](?:password|secret|token|123456|admin)["']?$/i.test(fullLine.trim())) {
    return true;
  }
  if (/password\s*[:=]\s*["'](?:[^"']{1,7})["']/i.test(fullLine)) return true;
  return false;
}

interface ScanLine {
  file: string;
  line: number;
  text: string;
}

function linesFromDiff(diff: string): ScanLine[] {
  const rows: ScanLine[] = [];
  let file = 'unknown';
  let newLine = 0;
  for (const rawLine of String(diff || '').split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch) { file = fileMatch[1]; continue; }
    const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) { newLine = Number(hunk[1]) || 0; continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      rows.push({ file, line: newLine || 1, text: rawLine.slice(1) });
      newLine++;
    } else if (!rawLine.startsWith('-') && newLine) {
      newLine++;
    }
  }
  return rows;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function scanText(
  file: string,
  text: string,
  startLine: number,
  out: SecretMatch[],
  seen: Set<string>,
  opts: { multiline?: boolean },
): void {
  const confidence = fileConfidence(file);
  for (const rule of RULES) {
    if (rule.multiline && !opts.multiline) continue;
    if (!rule.multiline && opts.multiline) continue;
    const source = rule.multiline ? text : codeLine(text);
    if (!source.trim()) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(source)) !== null) {
      const value = m[0];
      const line = opts.multiline
        ? startLine + lineNumberAt(text, m.index) - 1
        : startLine;
      if (isLikelyPlaceholder(value, source)) continue;
      const key = `${file}:${line}:${rule.type}:${value.slice(0, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: rule.type,
        pattern: rule.type,
        line: Math.max(1, line),
        file,
        confidence,
        value_preview: previewValue(value),
      });
    }
  }
}

function buildVerdict(secrets: SecretMatch[]): Pick<SecretDetectionResult, 'verdict' | 'severity'> {
  if (secrets.some(s => s.confidence === 'high')) {
    return { verdict: 'BLOCK', severity: 'critical' };
  }
  if (secrets.some(s => s.confidence === 'medium')) {
    return { verdict: 'warn', severity: 'high' };
  }
  if (secrets.length) {
    return { verdict: 'warn', severity: 'medium' };
  }
  return { verdict: 'pass', severity: 'low' };
}

/**
 * Scan git diff (+ optional full changed file bodies) for hardcoded secrets.
 */
export async function detectSecrets(
  diff: string,
  changedFiles: Record<string, string> = {},
): Promise<SecretDetectionResult> {
  const secrets: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const row of linesFromDiff(diff)) {
    if (!row.text.trim()) continue;
    scanText(row.file, row.text, row.line, secrets, seen, { multiline: false });
  }

  // Full-file pass: multiline private keys + env assignments not only in diff hunks.
  for (const [file, content] of Object.entries(changedFiles)) {
    if (!content) continue;
    scanText(file, content, 1, secrets, seen, { multiline: true });
    // .env KEY=value (no quotes)
    if (ENV_FILE_RE.test(file.split('/').pop() || file)) {
      const envRe = /^[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)[A-Z0-9_]*\s*=\s*(.+)$/gim;
      let em: RegExpExecArray | null;
      while ((em = envRe.exec(content)) !== null) {
        const val = em[2].trim();
        if (!val || val.startsWith('$') || isLikelyPlaceholder(val, em[0])) continue;
        const line = lineNumberAt(content, em.index);
        const key = `${file}:${line}:env_secret`;
        if (seen.has(key)) continue;
        seen.add(key);
        secrets.push({
          type: 'api_key',
          pattern: 'env_assignment',
          line,
          file,
          confidence: 'high',
          value_preview: previewValue(val),
        });
      }
    }
  }

  const { verdict, severity } = buildVerdict(secrets);
  return { secrets: secrets.slice(0, 32), verdict, severity };
}

/** Map to Validate & Review finding shape (blocks commit via quality gate). */
export function secretsToReviewFindings(result: SecretDetectionResult): Array<{
  id: string;
  file: string;
  line?: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'security';
  title: string;
  explanation: string;
  confidence: SecretConfidence;
  detectedBy: 'secret_scanner';
  blocking: boolean;
}> {
  return result.secrets.map((s, i) => ({
    id: `sec_${s.type}_${i + 1}`,
    file: s.file,
    line: s.line,
    severity: s.confidence === 'high' ? 'critical' : s.confidence === 'medium' ? 'high' : 'medium',
    category: 'security' as const,
    title: `Hardcoded ${s.type.replace(/_/g, ' ')} detected`,
    explanation: `Matched ${s.pattern} (${s.confidence} confidence). Preview: ${s.value_preview}`,
    confidence: s.confidence,
    detectedBy: 'secret_scanner' as const,
    blocking: s.confidence === 'high',
  }));
}
