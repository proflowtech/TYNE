import type { DataClassificationType } from './types'

export type EvidenceClassification = 'PHI' | 'PII' | 'PCI' | 'SECRET' | 'Financial' | 'Credential' | 'Sensitive'

export interface EvidenceRecord {
  file: string
  line?: number
  hash: string
  /** Always a redacted snippet — never raw PHI/PII/secrets. */
  snippet: string
  classification?: EvidenceClassification
  redacted: boolean
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PHONE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g
const CARD = /\b(?:\d[ -]*?){13,19}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g
const MRN = /\b(?:mrn|medical[_ ]?record)[:\s#-]*[A-Z0-9-]{4,}\b/gi
const SECRET = /\b(?:sk|pk|api|tok|secret|bearer)[-_][A-Za-z0-9._-]{8,}\b/gi
const QUOTED = /(["'`])(?:(?!\1).){2,80}\1/g

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function hashEvidence(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toHex(digest).slice(0, 16)
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let redacted = false
  const next = text
    .replace(EMAIL, () => { redacted = true; return '[REDACTED]' })
    .replace(PHONE, () => { redacted = true; return '[REDACTED]' })
    .replace(SSN, () => { redacted = true; return '[REDACTED]' })
    .replace(CARD, () => { redacted = true; return '[REDACTED]' })
    .replace(MRN, () => { redacted = true; return '[REDACTED]' })
    .replace(SECRET, () => { redacted = true; return '[REDACTED]' })
    .replace(QUOTED, (match) => {
      if (/\b(patient|email|phone|ssn|cvv|password|token|secret)\b/i.test(match) || /@/.test(match) || /\d{4,}/.test(match)) {
        redacted = true
        return '"[REDACTED]"'
      }
      return match
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
  return { text: next || '[REDACTED]', redacted }
}

export async function buildEvidenceRecord(input: {
  file: string
  line?: number
  text: string
  classification?: DataClassificationType | EvidenceClassification
}): Promise<EvidenceRecord> {
  const { text, redacted } = redactSensitiveText(input.text)
  const hash = await hashEvidence(input.text)
  const classification = input.classification === 'Credential'
    ? 'SECRET'
    : (input.classification as EvidenceClassification | undefined)
  return {
    file: input.file,
    line: input.line,
    hash,
    snippet: text,
    classification,
    redacted: redacted || text.includes('[REDACTED]'),
  }
}

/** Sync helper for non-async call sites; hashes with a cheap fallback. */
export function buildEvidenceRecordSync(input: {
  file: string
  line?: number
  text: string
  classification?: DataClassificationType | EvidenceClassification
}): EvidenceRecord {
  const { text, redacted } = redactSensitiveText(input.text)
  let hash = '0'
  try {
    // Fast non-crypto fingerprint for sync paths; async path uses SHA-256.
    let h = 2166136261
    for (let i = 0; i < input.text.length; i++) {
      h ^= input.text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    hash = (h >>> 0).toString(16).padStart(8, '0')
  } catch { /* keep 0 */ }
  const classification = input.classification === 'Credential'
    ? 'SECRET'
    : (input.classification as EvidenceClassification | undefined)
  return {
    file: input.file,
    line: input.line,
    hash,
    snippet: text,
    classification,
    redacted: redacted || text.includes('[REDACTED]'),
  }
}
