import { classifyData } from './dataClassification'
import type { ComplianceEvidence, EvidenceSignal } from './types'

const SIGNAL_PATTERNS: Array<[EvidenceSignal, RegExp]> = [
  ['access', /\b(find|findUnique|findFirst|findMany|get|fetch|load|select|query)\b/i],
  ['response', /\b(res\.json|res\.send|reply\.send|Response\.json|NextResponse\.json|ctx\.body\s*=|return\s+\w+)\b/i],
  ['log', /\b(console|logger|log)\.(log|debug|info|warn|error)\s*\(/i],
  ['storage', /\b(insert|create|save|store|persist|update|upsert)\b|\b(cvv|cvc|cardNumber|pan)\b\s*=/i],
  ['mutation', /\b(post|put|patch|delete|insert|create|update|upsert|remove|destroy)\b/i],
  ['http', /['"`]http:\/\/[^'"`]+['"`]/i],
  ['auth', /\b(authorize|authorization|authenticate|canAccess|hasAccess|owns|ownership|requireRole|permission|assertOwner|tenantId|userId\s*===|user_id\s*===)\b/i],
  ['audit', /\b(audit|auditLog|accessLog|logAccess|recordAccess|activityLog|eventLog)\b/i],
  ['validation', /\b(validate|validation|schema\.parse|safeParse|assert|sanitize|constraint)\b/i],
  ['transaction', /\b(transaction|beginTransaction|commit|rollback|atomic)\b/i],
  ['consent', /\b(consent|opt[_ -]?in|lawful[_ -]?basis|processing[_ -]?permission)\b/i],
  ['deletion', /\b(deleteUserData|eraseUser|rightToDelete|deletePersonalData|purgeUser|removeAccountData)\b/i],
  ['export', /\b(exportUserData|dataExport|downloadMyData|portability)\b/i],
  ['monitoring', /\b(monitor|metric|alert|telemetry|healthcheck|observability)\b/i],
  ['approval', /\b(approve|approval|reviewedBy|fourEyes|dualControl)\b/i],
  ['incident', /\b(incident|securityEvent|breach|onCall|escalat)\b/i],
  ['backup', /\b(backup|restore|recovery|snapshot)\b/i],
  ['tests', /\b(test|spec|describe|it|expect|assert)\b/i],
]

type DiffLine = { file: string; line?: number; text: string }

function changedLines(diff: string): DiffLine[] {
  const rows: DiffLine[] = []
  let file = 'unknown'
  let line: number | undefined
  for (const raw of diff.split('\n')) {
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      file = fileMatch[1]
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ file, line, text: raw.slice(1) })
      if (line !== undefined) line++
    } else if (!raw.startsWith('-') && line !== undefined) {
      line++
    }
  }
  return rows
}

export function collectComplianceEvidence(diff: string): ComplianceEvidence[] {
  const lines = changedLines(diff)
  const changedTests = lines.some(row => /(?:^|\/)(?:test|tests|__tests__)\/|(?:\.test|\.spec)\.[^.]+$/i.test(row.file))
  const rowLocalSignals = new Set<EvidenceSignal>(['access', 'response', 'log', 'storage', 'mutation', 'http'])
  return lines.map(row => {
    const nearby = lines
      .filter(other => other.file === row.file && Math.abs((other.line || 0) - (row.line || 0)) <= 12)
      .map(other => other.text)
      .join('\n')
    const signals = new Set<EvidenceSignal>()
    for (const [signal, pattern] of SIGNAL_PATTERNS) {
      const searchable = rowLocalSignals.has(signal) ? row.text : nearby
      if (pattern.test(searchable)) signals.add(signal)
    }
    if (changedTests) signals.add('tests')
    const fieldHits = row.text.match(/\b(name|email|phone|address|location|dob|diagnosis|notes|insurance|ssn|mrn|labResults?|prescriptions?|cardNumber|cvv|pan)\b/gi) || []
    return {
      ...row,
      nearby,
      dataTypes: classifyData(row.text, nearby),
      signals,
      fieldCount: new Set(fieldHits.map(field => field.toLowerCase())).size,
    }
  })
}
