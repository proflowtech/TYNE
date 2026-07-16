import type { ComplianceFramework, ComplianceStatus } from './types.ts'
import type { CoverageCategoryScore } from './complianceScoring.ts'

export interface ComplianceHistorySnapshot {
  repositoryId?: string
  repositoryName?: string
  commitHash?: string
  framework: ComplianceFramework | string
  status: ComplianceStatus | string
  score: number
  findings: Array<{ id?: string; title: string; severity?: string; controlId?: string }>
  coverage?: CoverageCategoryScore[]
  timestamp?: string
}

export interface ComplianceRegression {
  framework: string
  previousStatus: string
  currentStatus: string
  previousFindingCount: number
  currentFindingCount: number
  newFindings: Array<{ title: string; severity?: string }>
  message: string
}

function normalizeStatus(status: string): string {
  return String(status || '').toLowerCase().replace(/\s+/g, '_')
}

function wasClean(status: string): boolean {
  const s = normalizeStatus(status)
  return s === 'no_violations' || s === 'passed' || s === 'pass' || s === 'clean'
}

/**
 * Detect compliance regressions vs prior history rows for the same repository/framework.
 */
export function detectComplianceRegressions(
  previous: ComplianceHistorySnapshot[],
  current: ComplianceHistorySnapshot[],
): ComplianceRegression[] {
  const regressions: ComplianceRegression[] = []
  for (const curr of current) {
    const prior = previous
      .filter(p => String(p.framework) === String(curr.framework))
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0]
    if (!prior) continue

    const priorTitles = new Set((prior.findings || []).map(f => f.title.trim().toLowerCase()))
    const newFindings = (curr.findings || []).filter(f => !priorTitles.has(f.title.trim().toLowerCase()))
    const grew = (curr.findings || []).length > (prior.findings || []).length
    const cleanToDirty = wasClean(String(prior.status)) && !wasClean(String(curr.status))
    const scoreDrop = typeof prior.score === 'number' && typeof curr.score === 'number' && curr.score < prior.score - 5

    if (!cleanToDirty && !newFindings.length && !grew && !scoreDrop) continue

    const count = newFindings.length || Math.max(0, (curr.findings || []).length - (prior.findings || []).length)
    regressions.push({
      framework: String(curr.framework),
      previousStatus: String(prior.status),
      currentStatus: String(curr.status),
      previousFindingCount: (prior.findings || []).length,
      currentFindingCount: (curr.findings || []).length,
      newFindings: newFindings.slice(0, 8).map(f => ({ title: f.title, severity: f.severity })),
      message: count > 0
        ? `Compliance Regression Detected — ${curr.framework}: ${count} new finding${count === 1 ? '' : 's'}`
        : `Compliance Regression Detected — ${curr.framework}: status worsened from ${prior.status}`,
    })
  }
  return regressions
}
