import { resolveComplianceStatus } from './complianceBlocking.ts'
import type {
  ComplianceFramework,
  ComplianceFrameworkAssessment,
  CompliancePolicy,
  DeterministicComplianceFinding,
} from './types.ts'

const PENALTY = { critical: 35, high: 20, medium: 10, low: 4 } as const

/** Coverage categories shown in UI (Phase 2). Infrastructure is never code-reviewed. */
export type CoverageCategoryId = 'access_control' | 'encryption' | 'audit_logging' | 'infrastructure'

export interface CoverageCategoryScore {
  id: CoverageCategoryId
  label: string
  /** 0–100 when reviewed; omit / null when not reviewed */
  percent: number | null
  status: 'scored' | 'not_reviewed'
}

const CATEGORY_LABEL: Record<CoverageCategoryId, string> = {
  access_control: 'Access Control',
  encryption: 'Encryption',
  audit_logging: 'Audit Logging',
  infrastructure: 'Infrastructure',
}

/** Map control ids/names → coverage buckets. */
export function categoryForControl(controlId: string, controlName = ''): CoverageCategoryId | null {
  const hay = `${controlId} ${controlName}`.toLowerCase()
  if (/infra|cloud|iam|network|physical/.test(hay)) return 'infrastructure'
  if (/164\.312\(e\)|transmiss|encrypt|crypt|tls|sc-8|a\.8\.24|4\.2/.test(hay)) return 'encryption'
  if (/164\.312\(b\)|audit|logging|au-2|a\.8\.15|10\.2|cc7|monitor/.test(hay)) return 'audit_logging'
  if (/164\.312\(a\)|164\.502|access|auth|ac-3|cc6|a\.5\.15|minimum|integrity|164\.312\(c\)/.test(hay)) {
    return 'access_control'
  }
  return 'access_control'
}

export function buildCoverageScores(
  policy: CompliancePolicy,
  findings: DeterministicComplianceFinding[],
  controlsChecked: Array<{ id: string; label: string; framework: string; status: string }>,
): CoverageCategoryScore[] {
  const buckets: Record<CoverageCategoryId, { reviewed: number; issues: number; penalty: number }> = {
    access_control: { reviewed: 0, issues: 0, penalty: 0 },
    encryption: { reviewed: 0, issues: 0, penalty: 0 },
    audit_logging: { reviewed: 0, issues: 0, penalty: 0 },
    infrastructure: { reviewed: 0, issues: 0, penalty: 0 },
  }

  for (const control of policy.controls) {
    const cat = categoryForControl(control.id, control.name)
    if (!cat || cat === 'infrastructure') continue
    const checked = controlsChecked.find(c => c.framework === policy.id && c.id === control.id)
    if (!checked || checked.status === 'not_reviewed') continue
    buckets[cat].reviewed++
    if (checked.status === 'issues_detected') buckets[cat].issues++
  }

  for (const finding of findings.filter(f => f.framework === policy.id)) {
    const cat = categoryForControl(finding.controlId, finding.title)
    if (!cat || cat === 'infrastructure') continue
    buckets[cat].penalty += PENALTY[finding.severity] || 4
    if (!buckets[cat].reviewed) buckets[cat].reviewed = 1
  }

  const ordered: CoverageCategoryId[] = ['access_control', 'encryption', 'audit_logging', 'infrastructure']
  return ordered.map(id => {
    if (id === 'infrastructure') {
      return { id, label: CATEGORY_LABEL[id], percent: null, status: 'not_reviewed' as const }
    }
    const b = buckets[id]
    if (!b.reviewed) {
      return { id, label: CATEGORY_LABEL[id], percent: null, status: 'not_reviewed' as const }
    }
    const percent = Math.max(0, Math.min(100, 100 - b.penalty))
    return { id, label: CATEGORY_LABEL[id], percent, status: 'scored' as const }
  })
}

export function scoreFramework(
  policy: CompliancePolicy,
  findings: DeterministicComplianceFinding[],
  controlsChecked: Array<{ id: string; label: string; framework: string; status: string }> = [],
): ComplianceFrameworkAssessment {
  const relevant = findings.filter(finding => finding.framework === policy.id)
  const score = Math.max(0, 100 - relevant.reduce((sum, finding) => sum + PENALTY[finding.severity], 0))
  const status = resolveComplianceStatus(relevant)
  const coverage = buildCoverageScores(policy, findings, controlsChecked)
  return {
    framework: policy.id as ComplianceFramework,
    name: policy.name,
    version: policy.version,
    status,
    score,
    findingCount: relevant.length,
    controlsChecked: policy.controls.length,
    scopeNote: 'Reviewed code changes only',
    confidence: relevant.some(f => f.confidence === 'high') ? 'high' : relevant.length ? 'medium' : 'medium',
    coverage,
  }
}
