/** Permanent legal disclaimer for compliance assessment surfaces (Phase 1). */
export const COMPLIANCE_DISCLAIMER =
  'IMPORTANT LEGAL NOTICE: Tyne Validate & Review and any compliance-related output are automated, advisory suggestions only. ' +
  'They do not constitute a compliance certificate, attestation, audit opinion, legal advice, regulatory filing, warranty, or guarantee of any kind. ' +
  'Tyne does not certify that software, systems, processes, or organizations meet HIPAA, SOC 2, GDPR, PCI-DSS, ISO, NIST, FedRAMP, or any other legal, regulatory, industry, or contractual standard. ' +
  'Findings and scores are heuristic and may be incomplete, inaccurate, or out of date. Recipients remain solely responsible for independent professional review, formal certification by qualified auditors or counsel, and all compliance decisions. ' +
  'Use of this report does not create an attorney-client, auditor-client, or similar professional relationship with Tyne or its affiliates.'

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
