/**
 * Deterministic SQL / NoSQL / command injection scanner (JS/TS).
 * Scans changed file contents line-by-line with low FP heuristics.
 */

export type InjectionType = 'sql' | 'nosql' | 'command';
export type InjectionSeverity = 'critical';

export interface InjectionVulnerability {
  type: InjectionType;
  /** Matched rule id / snippet label. */
  pattern: string;
  line: number;
  file: string;
  cwe: string;
  severity: InjectionSeverity;
  vulnerable_pattern: string;
  safe_pattern: string;
  fix_suggestion: string;
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;
const TEST_FILE = /(^|\/|\.)(test|spec)\.[a-z0-9]+$/i;

const USER_INPUT_RE = /(?:req\.(?:body|query|params|headers)|request\.(?:body|query|params)|query\.|params\.|body\.|input\b|userInput|userId|id\b)/;

interface InjectionRule {
  type: InjectionType;
  cwe: string;
  re: RegExp;
  fix: (match: string) => { safe_pattern: string; fix_suggestion: string };
  /** Skip match when line already looks parameterized / safe. */
  skip?: (line: string, match: string) => boolean;
}

function sqlFix(match: string): { safe_pattern: string; fix_suggestion: string } {
  const trimmed = match.trim().slice(0, 120);
  return {
    safe_pattern: trimmed.replace(/\+\s*\w+/g, '?", [id])').replace(/\$\{[^}]+\}/g, '?'),
    fix_suggestion: 'Use parameterized queries to prevent SQL injection',
  };
}

function nosqlFix(match: string): { safe_pattern: string; fix_suggestion: string } {
  return {
    safe_pattern: match.replace(/(?:req\.|query\.|params\.|body\.)(\w+)/g, 'validated_$1'),
    fix_suggestion: 'Validate and sanitize user input before using in NoSQL queries (e.g. ObjectId(id), schema validation)',
  };
}

function commandFix(match: string): { safe_pattern: string; fix_suggestion: string } {
  const cmd = match.match(/["'`]([^"'`]+?)["'`]/)?.[1]?.split(/\s+/)[0] || 'command';
  return {
    safe_pattern: `child_process.execFile("${cmd}", [userInput])`,
    fix_suggestion: 'Use child_process.execFile with an argument array instead of string concatenation',
  };
}

const RULES: InjectionRule[] = [
  {
    type: 'sql',
    cwe: 'CWE-89',
    re: /\.(?:query|execute|run|sql|rawQuery|\$queryRaw|\$executeRaw)\s*\(\s*(["'`])(?:[^"'\\]|\\.)*\1\s*\+/gi,
    fix: sqlFix,
    skip: (line) => /\?\s*,\s*\[/.test(line) || /\$\d/.test(line) || /:\w+/.test(line),
  },
  {
    type: 'sql',
    cwe: 'CWE-89',
    re: /\.(?:query|execute|run|sql)\s*\(\s*`[^`]*\$\{(?!.*\?\s*,)/gi,
    fix: sqlFix,
    skip: (line, match) => {
      if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i.test(match)) return true;
      return /\?\s*,\s*\[/.test(line);
    },
  },
  {
    type: 'sql',
    cwe: 'CWE-89',
    re: /(?:query|execute|run|sql)\s*\(\s*(["'`])(?:SELECT|INSERT|UPDATE|DELETE)[^"'`]*\1\s*\+/gi,
    fix: sqlFix,
    skip: (line) => /\?\s*,\s*\[/.test(line),
  },
  {
    type: 'nosql',
    cwe: 'CWE-943',
    re: /\.(?:find|findOne|updateOne|updateMany|deleteOne|deleteMany|insertOne|insertMany|aggregate)\s*\(\s*\{[^}]*:\s*(?:req\.|query\.|params\.|body\.)/gi,
    fix: nosqlFix,
    skip: (line, match) =>
      /ObjectId\s*\(/.test(line)
      || /new\s+Types\.ObjectId/.test(line)
      || /parseInt\s*\(/.test(line)
      || /Number\s*\(/.test(line)
      || /z\.(?:string|number)/.test(line)
      || !USER_INPUT_RE.test(match),
  },
  {
    type: 'nosql',
    cwe: 'CWE-943',
    re: /\.collection\.(?:find|updateOne|deleteOne)\s*\(\s*\{[^}]*:\s*(?:req\.|query\.|params\.)/gi,
    fix: nosqlFix,
    skip: (line) => /ObjectId\s*\(/.test(line),
  },
  {
    type: 'command',
    cwe: 'CWE-78',
    re: /(?:^|[^\w.])(?:exec|execSync|spawn|spawnSync|system)\s*\(\s*(["'`])(?:[^"'\\]|\\.)*\1\s*\+/gi,
    fix: commandFix,
    skip: (line) => /execFile\s*\(/.test(line) || /spawn\s*\([^,]+,\s*\[/.test(line),
  },
  {
    type: 'command',
    cwe: 'CWE-78',
    re: /child_process\.(?:exec|execSync|spawn)\s*\(\s*(["'`])(?:[^"'\\]|\\.)*\1\s*\+/gi,
    fix: commandFix,
    skip: (line) => /execFile/.test(line),
  },
];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return !t || /^\/\//.test(t) || /^\/\*/.test(t) || /^\*/.test(t);
}

function trimSnippet(line: string, max = 140): string {
  return line.trim().replace(/\s+/g, ' ').slice(0, max);
}

function scanLine(file: string, lineNum: number, line: string, out: InjectionVulnerability[], seen: Set<string>): void {
  if (isCommentLine(line)) return;
  if (TEST_FILE.test(file) && !USER_INPUT_RE.test(line)) return;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(line)) !== null) {
      const match = m[0];
      if (rule.skip?.(line, match)) continue;
      const key = `${file}:${lineNum}:${rule.type}:${match.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snippet = trimSnippet(line);
      const { safe_pattern, fix_suggestion } = rule.fix(match);
      out.push({
        type: rule.type,
        pattern: snippet,
        line: lineNum,
        file,
        cwe: rule.cwe,
        severity: 'critical',
        vulnerable_pattern: snippet,
        safe_pattern,
        fix_suggestion,
      });
    }
  }
}

/** Scan changed JS/TS files for injection vulnerabilities. */
export async function detectInjectionVulnerabilities(
  files: Record<string, string>,
): Promise<InjectionVulnerability[]> {
  const out: InjectionVulnerability[] = [];
  const seen = new Set<string>();

  for (const [file, content] of Object.entries(files)) {
    if (!content || !CODE_EXT.test(file)) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      scanLine(file, i + 1, lines[i], out, seen);
    }
  }

  return out.slice(0, 24);
}

/** True when any critical SQL injection was found (commit gate). */
export function hasBlockingSqlInjection(vulns: InjectionVulnerability[]): boolean {
  return vulns.some(v => v.type === 'sql' && v.severity === 'critical');
}

/** Map to Validate & Review finding shape. */
export function injectionToReviewFindings(vulns: InjectionVulnerability[]): Array<{
  id: string;
  file: string;
  line?: number;
  severity: 'critical';
  category: 'security';
  title: string;
  explanation: string;
  suggestedFix?: string;
  confidence: 'high';
  detectedBy: 'ast_rule';
  blocking: boolean;
}> {
  return vulns.map((v, i) => ({
    id: `inj_${v.type}_${i + 1}`,
    file: v.file,
    line: v.line,
    severity: 'critical' as const,
    category: 'security' as const,
    title: `${v.type.toUpperCase()} injection (${v.cwe})`,
    explanation: `${v.fix_suggestion}. Vulnerable: ${v.vulnerable_pattern}`,
    suggestedFix: `Safe pattern: ${v.safe_pattern}`,
    confidence: 'high' as const,
    detectedBy: 'ast_rule' as const,
    blocking: v.type === 'sql',
  }));
}
