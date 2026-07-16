import type { DataClassificationType } from './types.ts'

type ClassHit = { type: DataClassificationType; confidence: 'high' | 'medium' | 'low' }

export interface AstContext {
  /** e.g. patient.name, user.email */
  propertyAccess: string[]
  /** e.g. patients, users from ORM/table literals */
  tableRefs: string[]
  /** Bound subject vars: patient, user, customer */
  subjectVars: string[]
  /** Detected sinks on this/nearby lines */
  sinks: Array<'response' | 'log' | 'storage'>
  hasAuthNearby: boolean
}

const STRONG: Array<[DataClassificationType, RegExp]> = [
  ['PHI', /\b(patient|diagnosis|prescription|medical[_ ]?record|mrn|lab[_ ]?results?|ehr|phi|hipaa|medications?)\b/i],
  ['PCI', /\b(cardholder|card[_ ]?number|credit[_ ]?card|cvv|cvc|pan|payment[_ ]?card)\b/i],
  ['Credential', /\b(password|passwd|api[_ ]?key|access[_ ]?token|refresh[_ ]?token|private[_ ]?key|secret[_ ]?key|bearer\s+[a-z0-9._-]{8,})\b/i],
  ['Financial', /\b(bank[_ ]?account|routing[_ ]?number|tax[_ ]?id|ledger[_ ]?entry|invoice[_ ]?total)\b/i],
]

const WEAK_PII = /\b(email|phone|address|date[_ ]?of[_ ]?birth|dob|passport|ssn|social[_ ]?security)\b/i
const FLOW_SINK = /\b(res\.json|Response\.json|NextResponse\.json|res\.send|logger|console\.|insert|create|select|findUnique|findMany)\b/i

/**
 * Lightweight structural context (regex/AST-ish) — property access, table refs, sinks, auth.
 * # ponytail: not a real TS parser; swap to typescript compiler API if FP rate needs it.
 */
export function extractAstContext(text: string, nearby = ''): AstContext {
  const haystack = `${text}\n${nearby}`
  const propertyAccess = [...haystack.matchAll(/\b([a-zA-Z_][\w]*)\.(name|email|phone|address|ssn|mrn|diagnosis|dob|cvv|pan|password)\b/gi)]
    .map(m => `${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
  const tableRefs = [
    ...haystack.matchAll(/\b(?:from|into|update|join)\s+['"`]?([a-z_][\w]*)['"`]?/gi),
    ...haystack.matchAll(/\.(?:patient|user|users|customers|payments|invoices|members)\b/gi),
    ...haystack.matchAll(/\b(?:db|prisma|supabase)\.([a-z_][\w]*)\b/gi),
    ...haystack.matchAll(/\b(patients?|users|customers|payments|invoices|ehr|medical_records)\b/gi),
  ].map(m => (m[1] || m[0]).replace(/^\./, '').toLowerCase())

  const subjectVars = [
    ...haystack.matchAll(/\b(?:const|let|var)\s+(patient|user|customer|member|employee|card|payment)\b/gi),
    ...haystack.matchAll(/\b(patient|user|customer)\s*=/gi),
    ...propertyAccess.map(p => p.split('.')[0]),
  ].map(m => (typeof m === 'string' ? m : m[1]).toLowerCase())

  const sinks: AstContext['sinks'] = []
  if (/\b(Response\.json|res\.json|NextResponse\.json|res\.send|reply\.send)\b/i.test(haystack)) sinks.push('response')
  if (/\b(logger|console)\.(log|info|warn|error|debug)\s*\(/i.test(haystack)) sinks.push('log')
  if (/\b(insert|create|upsert|save|persist)\b/i.test(haystack)) sinks.push('storage')

  const hasAuthNearby = /\b(authorize|authorization|authenticate|canAccess|hasAccess|owns|ownership|requireRole|permission|assertOwner|tenantId|userId\s*===|user_id\s*===|getServerSession|requireAuth)\b/i
    .test(haystack)

  return {
    propertyAccess: [...new Set(propertyAccess)],
    tableRefs: [...new Set(tableRefs)],
    subjectVars: [...new Set(subjectVars)],
    sinks,
    hasAuthNearby,
  }
}

/**
 * Classification = regex + AST context + variable/subject + sink flow.
 * Bare `name` alone is never PII/PHI.
 */
export function classifyData(text: string, nearby = ''): DataClassificationType[] {
  const ctx = extractAstContext(text, nearby)
  const haystack = `${text}\n${nearby}`
  const hits: ClassHit[] = []
  const hasSink = ctx.sinks.length > 0 || FLOW_SINK.test(text)
  const hasPatientSubject =
    ctx.subjectVars.some(v => /patient|ehr|medical/i.test(v))
    || ctx.tableRefs.some(t => /patient|ehr|medical/i.test(t))
    || ctx.propertyAccess.some(p => /^patient\./i.test(p))
  const hasPersonSubject =
    hasPatientSubject
    || ctx.subjectVars.some(v => /user|customer|member|employee/i.test(v))
    || ctx.tableRefs.some(t => /user|customer|member|employee/i.test(t))
    || ctx.propertyAccess.some(p => /^(user|customer|member)\./i.test(p))

  for (const [type, pattern] of STRONG) {
    if (pattern.test(haystack)) hits.push({ type, confidence: 'high' })
  }

  // PHI: patient subject + sensitive field or patient entity flowing to sink
  if (hasPatientSubject && (hasSink || ctx.propertyAccess.some(p => /patient\.(name|email|diagnosis|mrn|dob)/i.test(p)))) {
    if (!hits.some(h => h.type === 'PHI')) hits.push({ type: 'PHI', confidence: hasSink ? 'high' : 'medium' })
  }

  // PII: person subject + weak identity field + sink/flow — never bare "name"
  if (WEAK_PII.test(haystack) && hasPersonSubject && hasSink) {
    hits.push({ type: 'PII', confidence: 'high' })
  } else if (ctx.propertyAccess.some(p => /\.(email|phone|address|ssn|dob)$/i.test(p)) && hasPersonSubject) {
    hits.push({ type: hasPatientSubject ? 'PHI' : 'PII', confidence: hasSink ? 'high' : 'medium' })
  } else if (ctx.propertyAccess.some(p => /\.name$/i.test(p)) && hasPersonSubject && hasSink) {
    hits.push({ type: hasPatientSubject ? 'PHI' : 'PII', confidence: 'medium' })
  }

  // Explicit false-positive guard: bare name / displayName without subject+sink
  if (!hasPersonSubject && /\bname\b/i.test(text) && !STRONG.some(([, re]) => re.test(haystack))) {
    return hits.filter(h => h.type !== 'PII' && h.type !== 'PHI').map(h => h.type)
  }

  return [...new Set(hits.map(h => h.type))]
}

export function destinationFor(signals: Set<string>): string {
  if (signals.has('log')) return 'Application logs'
  if (signals.has('response')) return 'API Response'
  if (signals.has('storage')) return 'Persistent storage'
  if (signals.has('export')) return 'Data export'
  return 'Downstream code'
}

export function inferDataFlowChain(input: {
  dataType?: DataClassificationType
  signals: Set<string>
  file: string
}): string[] {
  const chain = [transformLabel(input.file)]
  chain.unshift(sourceFallback(input.dataType))
  if (input.signals.has('response')) chain.push('API Response')
  else if (input.signals.has('log')) chain.push('Application logs')
  else if (input.signals.has('storage')) chain.push('Persistent storage')
  else chain.push(destinationFor(input.signals))
  return [...new Set(chain)]
}

function transformLabel(file: string): string {
  return file.split('/').pop() || file
}

function sourceFallback(type?: DataClassificationType): string {
  if (type === 'PHI') return 'Database: patients table'
  if (type === 'PCI') return 'Database: payments table'
  if (type === 'PII') return 'Database: users table'
  if (type === 'Financial') return 'Database: financial records'
  if (type === 'Credential') return 'Secrets / credentials store'
  return 'Sensitive data source'
}
