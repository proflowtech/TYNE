/** Permanent legal disclaimer for compliance assessment surfaces (Phase 1). */
export const COMPLIANCE_DISCLAIMER =
  'Tyne provides developer-assistance compliance assessments based on reviewed code changes and available evidence. ' +
  'This is not a compliance certification, audit, legal opinion, or guarantee of security.'

export type ComplianceAssessmentStatus =
  | 'no_violations'
  | 'issues_detected'
  | 'review_required'
  | 'blocked'
  | 'not_enabled'

/** Map legacy / raw status values to safe assessment statuses. */
export function normalizeComplianceStatus(value: unknown): ComplianceAssessmentStatus {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '_')
  if (raw === 'not_enabled' || raw === 'disabled') return 'not_enabled'
  if (raw === 'blocked' || raw === 'failed') return 'blocked'
  if (raw === 'review_required' || raw === 'needs_work' || raw === 'needs_review') return 'review_required'
  if (raw === 'issues_detected' || raw === 'warning') return 'issues_detected'
  if (raw === 'no_violations' || raw === 'passed' || raw === 'pass' || raw === 'clean') return 'no_violations'
  return 'not_enabled'
}

export function complianceStatusLabel(status: ComplianceAssessmentStatus | string): string {
  switch (normalizeComplianceStatus(status)) {
    case 'blocked': return 'Blocked'
    case 'review_required': return 'Review required'
    case 'issues_detected': return 'Issues detected'
    case 'no_violations': return 'No detected violations'
    case 'not_enabled':
    default: return 'Not enabled'
  }
}

export type ControlCheckStatus = 'no_issues' | 'issues_detected' | 'not_reviewed'

export function normalizeControlStatus(value: unknown): ControlCheckStatus {
  const raw = String(value || '').toLowerCase()
  if (raw === 'issues_detected' || raw === 'failed' || raw === 'fail') return 'issues_detected'
  if (raw === 'no_issues' || raw === 'passed' || raw === 'pass') return 'no_issues'
  return 'not_reviewed'
}

export function controlStatusLabel(status: ControlCheckStatus | string): string {
  switch (normalizeControlStatus(status)) {
    case 'issues_detected': return 'Issues detected'
    case 'no_issues': return 'No detected issues'
    default: return 'Not reviewed'
  }
}
