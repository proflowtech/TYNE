/**
 * Keep in sync with src/validateReviewTypes.ts findingCanHardBlock + verdictFromFindings.
 */

const NEVER_BLOCK_CATEGORIES = new Set([
  'pm_alignment',
  'style',
  'vibe_code',
  'maintainability',
  'performance',
])

const DISPLAY_SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
  info: 0,
}

function toDisplaySeverity(severity: unknown, category?: string): string {
  const raw = String(severity || '').toLowerCase()
  if (raw === 'critical') return 'critical'
  if (raw === 'major' || raw === 'high' || raw === 'error') return 'major'
  if (raw === 'minor' || raw === 'medium' || raw === 'warning') return 'minor'
  if (raw === 'nit' || raw === 'hint') return 'nit'
  if (raw === 'low') return category === 'style' ? 'nit' : 'minor'
  if (raw === 'info') return 'info'
  return 'minor'
}

function displaySeverityRank(severity: unknown, category?: string): number {
  return DISPLAY_SEVERITY_RANK[toDisplaySeverity(severity, category)] ?? 2
}

export function findingCanHardBlock(finding: {
  severity?: unknown
  category?: string
  blocking?: boolean
  confidence?: string
}): boolean {
  const cat = String(finding.category || '').toLowerCase()
  if (NEVER_BLOCK_CATEGORIES.has(cat)) return false
  const sev = String(finding.severity || '').toLowerCase()
  const confidence = String(finding.confidence || 'medium').toLowerCase()
  if (confidence === 'low') return false

  if (cat === 'security') {
    if (finding.blocking === true) return sev === 'critical' || sev === 'high' || sev === 'major'
    if (sev === 'critical') return true
    if ((sev === 'high' || sev === 'major') && confidence === 'high') return true
    return false
  }

  if (cat === 'compliance') {
    if (sev === 'critical') return true
    if ((sev === 'high' || sev === 'major') && confidence === 'high') return true
    if (finding.blocking === true && (sev === 'critical' || sev === 'high' || sev === 'major')) return true
    return false
  }

  if (cat === 'test_coverage' && finding.blocking === true && sev === 'critical') return true
  return false
}

export type ReviewOverallVerdict = 'approve' | 'approve_with_suggestions' | 'changes_requested' | 'block'

export function verdictFromFindings(findings: Array<{
  severity?: unknown
  category?: string
  blocking?: boolean
  confidence?: string
}>): ReviewOverallVerdict {
  const list = findings || []
  if (list.some(findingCanHardBlock)) return 'block'

  let worst = -1
  for (const f of list) {
    let rank = displaySeverityRank(f.severity, f.category)
    if (NEVER_BLOCK_CATEGORIES.has(String(f.category || '').toLowerCase()) && rank >= 4) {
      rank = 3
    }
    worst = Math.max(worst, rank)
  }
  if (worst >= 3) return 'changes_requested'
  if (worst >= 1) return 'approve_with_suggestions'
  return 'approve'
}
