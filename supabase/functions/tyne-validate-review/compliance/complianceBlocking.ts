/** Deterministic compliance blocking — score/PM cannot override these rules. */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | string
export type Confidence = 'high' | 'medium' | 'low' | string

export interface ComplianceBlockFinding {
  severity?: Severity
  confidence?: Confidence
  blocking?: boolean
}

/**
 * Hard-block rules (Phase 1):
 * - Low confidence: never block
 * - Critical: block
 * - High severity + high confidence: block
 * - Explicit blocking flag on critical/high (non-low confidence): block
 */
export function isComplianceHardBlock(finding: ComplianceBlockFinding): boolean {
  if ((finding.confidence || 'medium') === 'low') return false
  if (finding.severity === 'critical') return true
  if (finding.severity === 'high' && finding.confidence === 'high') return true
  if (finding.blocking === true && (finding.severity === 'critical' || finding.severity === 'high')) return true
  return false
}

/**
 * Status resolution after hard-block check:
 * - medium (or high without hard-block): review_required
 * - low / residual: issues_detected
 * - none: no_violations
 */
export function resolveComplianceStatus(
  findings: ComplianceBlockFinding[],
): 'no_violations' | 'issues_detected' | 'review_required' | 'blocked' {
  if (!findings.length) return 'no_violations'
  if (findings.some(isComplianceHardBlock)) return 'blocked'
  const needsReview = findings.some(finding => {
    if ((finding.confidence || 'medium') === 'low') return false
    return finding.severity === 'medium' || finding.severity === 'high'
  })
  if (needsReview) return 'review_required'
  return 'issues_detected'
}
