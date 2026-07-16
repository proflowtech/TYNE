/**
 * Local Validate & Review intelligence for Local Compliance Mode.
 * Runs compliance + security + classification + data-flow on-device.
 * Egress payload contains aggregates + hash-only evidence — never source/PHI snippets.
 */
import { runComplianceReview } from './complianceEngine';
import { analyzeDataFlows } from './dataFlowEngine';
import { classifyData } from './dataClassification';
import { collectComplianceEvidence } from './evidenceEngine';
import { parseFrameworks } from './policyRegistry';
import { runLocalSecurityScan, type LocalSecurityResult } from './localSecurityEngine';
import type { ComplianceFramework, ComplianceReviewContext } from './types';

export interface LocalFindingSummary {
  id: string;
  framework?: string;
  controlId?: string;
  title: string;
  severity: string;
  confidence: string;
  category: 'compliance' | 'security';
  file?: string;
  line?: number;
  evidenceHash?: string;
  blocking?: boolean;
}

export interface LocalFrameworkSummary {
  framework: string;
  name: string;
  status: string;
  score: number;
  findingCount: number;
  coverage?: Array<{ label: string; percent: number | null; status: string }>;
}

export interface LocalIntelligenceResult {
  compliance: ComplianceReviewContext;
  security: LocalSecurityResult;
  frameworks: LocalFrameworkSummary[];
  findings: LocalFindingSummary[];
  classificationCounts: Record<string, number>;
  dataFlowCount: number;
  dataFlowIssues: string[];
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  complianceStatus: string;
  securityStatus: string;
  overallStatus: 'passed' | 'needs_work' | 'blocked';
  score: number;
  confidence: 'high' | 'medium' | 'low';
  /** Safe for cloud egress — no source, no raw evidence snippets. */
  egressSummary: LocalEgressSummary;
}

export interface LocalEgressSummary {
  framework: string;
  frameworks: LocalFrameworkSummary[];
  status: string;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  confidence: 'high' | 'medium' | 'low';
  securityStatus: string;
  complianceStatus: string;
  score: number;
  findingTitles: Array<{ title: string; severity: string; framework?: string; category: string }>;
  classificationCounts: Record<string, number>;
  dataFlowCount: number;
  dataFlowIssueCount: number;
  /** Hash-only evidence refs */
  evidenceRefs: Array<{ file?: string; line?: number; hash: string; classification?: string }>;
}

function countSeverities(items: Array<{ severity?: string }>) {
  let critical = 0, high = 0, medium = 0, low = 0;
  for (const item of items) {
    if (item.severity === 'critical') critical++;
    else if (item.severity === 'high') high++;
    else if (item.severity === 'medium') medium++;
    else low++;
  }
  return { critical, high, medium, low };
}

export function runLocalIntelligence(input: {
  diff: string;
  frameworks?: string[];
}): LocalIntelligenceResult {
  const frameworks = parseFrameworks(input.frameworks?.length ? input.frameworks : ['HIPAA']) as ComplianceFramework[];
  const enabled = frameworks.length ? frameworks : (['HIPAA'] as ComplianceFramework[]);

  const compliance = runComplianceReview({
    diff: input.diff || '',
    frameworks: enabled,
    maxFindings: 40,
  });
  const security = runLocalSecurityScan(input.diff || '');
  const flows = analyzeDataFlows(input.diff || '');
  const evidence = collectComplianceEvidence(input.diff || '');

  const classificationCounts: Record<string, number> = {};
  for (const item of evidence) {
    for (const type of item.dataTypes) {
      classificationCounts[type] = (classificationCounts[type] || 0) + 1;
    }
    // also count from classifyData for coverage
    for (const type of classifyData(item.text, item.nearby)) {
      classificationCounts[type] = classificationCounts[type] || 0;
    }
  }

  const complianceFindings: LocalFindingSummary[] = compliance.findings.map(f => ({
    id: f.id,
    framework: f.framework,
    controlId: f.controlId,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    category: 'compliance' as const,
    file: f.file,
    line: f.line,
    evidenceHash: typeof f.evidence === 'object' ? f.evidence.hash : undefined,
    blocking: f.blocking,
  }));

  const securityFindings: LocalFindingSummary[] = security.findings.map(f => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    confidence: f.confidence,
    category: 'security' as const,
    file: f.file,
    line: f.line,
    evidenceHash: f.evidenceHash,
    blocking: f.blocking,
  }));

  const findings = [...complianceFindings, ...securityFindings];
  const sev = countSeverities(findings);
  const complianceBlocked = compliance.assessments.some(a => a.status === 'blocked')
    || complianceFindings.some(f => f.blocking || f.severity === 'critical');
  const securityBlocked = security.status === 'blocked';

  const overallStatus: LocalIntelligenceResult['overallStatus'] = (complianceBlocked || securityBlocked)
    ? 'blocked'
    : (sev.high > 0 || compliance.assessments.some(a => a.status === 'review_required'))
      ? 'needs_work'
      : 'passed';

  const score = overallStatus === 'blocked' ? 42
    : overallStatus === 'needs_work' ? 68
      : 94;

  const frameworksSummary: LocalFrameworkSummary[] = compliance.assessments.map(a => ({
    framework: a.framework,
    name: a.name,
    status: a.status,
    score: a.score,
    findingCount: a.findingCount,
    coverage: (a.coverage || []).map(c => ({
      label: c.label,
      percent: c.percent,
      status: c.status,
    })),
  }));

  const primaryFramework = frameworksSummary[0]?.framework || enabled[0] || 'HIPAA';
  const complianceStatus = complianceBlocked
    ? 'blocked'
    : frameworksSummary.some(f => f.status === 'review_required')
      ? 'review_required'
      : frameworksSummary.some(f => f.status === 'issues_detected')
        ? 'issues_detected'
        : 'no_violations';

  const evidenceRefs = compliance.findings
    .filter(f => f.evidence && typeof f.evidence === 'object')
    .map(f => ({
      file: f.file,
      line: f.line,
      hash: f.evidence.hash,
      classification: f.dataType || f.evidence.classification,
    }))
    .concat(security.findings.map(f => ({
      file: f.file,
      line: f.line,
      hash: f.evidenceHash,
      classification: 'SECRET',
    })))
    .slice(0, 40);

  const egressSummary: LocalEgressSummary = {
    framework: primaryFramework,
    frameworks: frameworksSummary,
    status: complianceStatus,
    criticalFindings: sev.critical,
    highFindings: sev.high,
    mediumFindings: sev.medium,
    lowFindings: sev.low,
    confidence: sev.critical || sev.high ? 'high' : 'medium',
    securityStatus: security.status,
    complianceStatus,
    score,
    findingTitles: findings.slice(0, 20).map(f => ({
      title: f.title,
      severity: f.severity,
      framework: f.framework,
      category: f.category,
    })),
    classificationCounts,
    dataFlowCount: flows.length,
    dataFlowIssueCount: flows.reduce((n, f) => n + f.issues.length, 0),
    evidenceRefs,
  };

  return {
    compliance,
    security,
    frameworks: frameworksSummary,
    findings,
    classificationCounts,
    dataFlowCount: flows.length,
    dataFlowIssues: flows.flatMap(f => f.issues).slice(0, 12),
    criticalFindings: sev.critical,
    highFindings: sev.high,
    mediumFindings: sev.medium,
    lowFindings: sev.low,
    complianceStatus,
    securityStatus: security.status,
    overallStatus,
    score,
    confidence: egressSummary.confidence,
    egressSummary,
  };
}
