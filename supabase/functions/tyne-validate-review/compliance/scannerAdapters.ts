/**
 * Enterprise scanner integration adapters.
 * Normalize SAST / dependency / container / cloud findings into Tyne finding shape.
 * # ponytail: adapters only — wire real scanners when configured; no vendor SDKs yet.
 */
export type ExternalScannerKind = 'sast' | 'dependency' | 'container' | 'cloud'

export interface ExternalScannerFinding {
  scanner: ExternalScannerKind | string
  tool?: string
  id?: string
  title: string
  severity?: string
  file?: string
  line?: number
  evidence?: string
  remediation?: string
  ruleId?: string
  cve?: string
  packageName?: string
  raw?: unknown
}

export interface NormalizedTyneFinding {
  id: string
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  category: 'security' | 'compliance' | 'maintainability' | 'correctness' | 'style' | 'vibe_code'
  title: string
  explanation: string
  confidence: 'high' | 'medium' | 'low'
  evidence?: string
  remediation?: string
  detectedBy: string
  blocking: boolean
  scannerKind: ExternalScannerKind | 'unknown'
  tool?: string
  ruleId?: string
  cve?: string
  packageName?: string
}

function parseSeverity(value: unknown): NormalizedTyneFinding['severity'] {
  const raw = String(value || 'medium').toLowerCase()
  if (raw === 'critical' || raw === 'fatal' || raw === 'error') return raw === 'error' ? 'high' : 'critical'
  if (raw === 'high') return 'high'
  if (raw === 'low' || raw === 'info' || raw === 'note') return 'low'
  return 'medium'
}

function kindOf(scanner: string): ExternalScannerKind | 'unknown' {
  const s = scanner.toLowerCase()
  if (s === 'sast' || s.includes('semgrep') || s.includes('eslint') || s.includes('codeql')) return 'sast'
  if (s === 'dependency' || s.includes('snyk') || s.includes('npm-audit') || s.includes('osv')) return 'dependency'
  if (s === 'container' || s.includes('trivy') || s.includes('grype') || s.includes('clair')) return 'container'
  if (s === 'cloud' || s.includes('prowler') || s.includes('scout') || s.includes('cspm')) return 'cloud'
  return 'unknown'
}

/** Normalize one external scanner finding into Tyne review finding format. */
export function normalizeScannerFinding(input: ExternalScannerFinding, index = 0): NormalizedTyneFinding {
  const scannerKind = kindOf(String(input.scanner || 'sast'))
  const severity = parseSeverity(input.severity)
  const title = String(input.title || '').trim() || `${scannerKind} finding ${index + 1}`
  const tool = input.tool || String(input.scanner)
  return {
    id: input.id || `${scannerKind}_${index + 1}`,
    file: input.file || 'unknown',
    line: typeof input.line === 'number' ? input.line : undefined,
    severity,
    category: 'security',
    title,
    explanation: [
      `Detected by ${tool} (${scannerKind} scanner).`,
      input.evidence || '',
      input.cve ? `CVE: ${input.cve}` : '',
      input.packageName ? `Package: ${input.packageName}` : '',
    ].filter(Boolean).join(' '),
    confidence: scannerKind === 'unknown' ? 'low' : 'high',
    evidence: input.evidence,
    remediation: input.remediation || 'Review and remediate this scanner finding before merge.',
    detectedBy: `${scannerKind}_scanner`,
    blocking: severity === 'critical' || (severity === 'high' && scannerKind !== 'unknown'),
    scannerKind,
    tool,
    ruleId: input.ruleId,
    cve: input.cve,
    packageName: input.packageName,
  }
}

export function normalizeScannerFindings(raw: unknown): NormalizedTyneFinding[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is ExternalScannerFinding => Boolean(item && typeof item === 'object' && typeof (item as any).title === 'string'))
    .map((item, index) => normalizeScannerFinding(item, index))
    .slice(0, 40)
}
