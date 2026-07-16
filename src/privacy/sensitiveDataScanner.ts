/** Local sensitive-data scanner — runs on-device before any network request. */

export type SensitiveClass =
  | 'SECRET'
  | 'JWT'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'PHI'
  | 'PCI'
  | 'PII';

export interface SensitiveMatch {
  classification: SensitiveClass;
  start: number;
  end: number;
  /** Never log or return the raw matched value outside the redactor. */
  placeholder: string;
}

const PATTERNS: Array<{ classification: SensitiveClass; placeholder: string; re: RegExp }> = [
  { classification: 'SECRET', placeholder: '[REDACTED_SECRET]', re: /\b(?:sk|pk|api|tok|secret|bearer)[-_][A-Za-z0-9._-]{8,}\b/gi },
  { classification: 'SECRET', placeholder: '[REDACTED_PRIVATE_KEY]', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { classification: 'SECRET', placeholder: '[REDACTED_PASSWORD]', re: /\b(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{3,}['"`]/gi },
  { classification: 'JWT', placeholder: '[REDACTED_JWT]', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { classification: 'EMAIL', placeholder: '[REDACTED_EMAIL]', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { classification: 'PHONE', placeholder: '[REDACTED_PHONE]', re: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g },
  { classification: 'PCI', placeholder: '[REDACTED_CARD]', re: /\b(?:\d[ -]*?){13,19}\b/g },
  { classification: 'PHI', placeholder: '[REDACTED_PHI]', re: /\b(?:mrn|medical[_ ]?record)[:\s#-]*[A-Z0-9-]{4,}\b/gi },
  { classification: 'PHI', placeholder: '[REDACTED_PHI]', re: /\b(?:diagnosis|prescription|lab[_ ]?results?)\b/gi },
  { classification: 'ADDRESS', placeholder: '[REDACTED_ADDRESS]', re: /\b\d{1,5}\s+[A-Za-z0-9.\s]{3,40}\b(?:Street|St|Avenue|Ave|Road|Rd|Blvd|Lane|Ln)\b/gi },
  { classification: 'PII', placeholder: '[REDACTED_SSN]', re: /\b\d{3}-\d{2}-\d{4}\b/g },
];

export function scanSensitiveData(text: string): SensitiveMatch[] {
  if (!text) return [];
  const matches: SensitiveMatch[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(text)) !== null) {
      matches.push({
        classification: pattern.classification,
        start: m.index,
        end: m.index + m[0].length,
        placeholder: pattern.placeholder,
      });
      if (m[0].length === 0) pattern.re.lastIndex++;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function countSensitiveByClass(text: string): Record<SensitiveClass, number> {
  const counts = {
    SECRET: 0, JWT: 0, EMAIL: 0, PHONE: 0, ADDRESS: 0, PHI: 0, PCI: 0, PII: 0,
  } as Record<SensitiveClass, number>;
  for (const match of scanSensitiveData(text)) {
    counts[match.classification]++;
  }
  return counts;
}
