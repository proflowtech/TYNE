export const COMPLIANCE_FRAMEWORKS = [
  'HIPAA',
  'SOC2',
  'PCI_DSS',
  'GDPR',
  'ISO27001',
  'NIST_CSF',
  'NIST_800_53',
  'FEDRAMP',
  'CCPA_CPRA',
  'SOX',
  'CUSTOM',
] as const

export type ComplianceFramework = typeof COMPLIANCE_FRAMEWORKS[number]
export type ComplianceSeverity = 'critical' | 'high' | 'medium' | 'low'
export type ComplianceConfidence = 'high' | 'medium' | 'low'
export type ComplianceStatus =
  | 'no_violations'
  | 'issues_detected'
  | 'review_required'
  | 'blocked'
  | 'not_enabled'
export type DataClassificationType = 'PHI' | 'PII' | 'PCI' | 'Financial' | 'Credential' | 'Sensitive'
export type EvidenceSignal =
  | 'access' | 'response' | 'log' | 'storage' | 'mutation' | 'http'
  | 'auth' | 'audit' | 'validation' | 'transaction' | 'consent'
  | 'deletion' | 'export' | 'monitoring' | 'approval' | 'incident' | 'backup'
  | 'tests'

export type DetectedBy = 'rule' | 'ast' | 'dataflow' | 'llm' | 'combined'

export interface ComplianceEvidence {
  file: string
  line?: number
  text: string
  nearby: string
  dataTypes: DataClassificationType[]
  signals: Set<EvidenceSignal>
  fieldCount: number
}

export interface EvidenceRecord {
  file: string
  line?: number
  hash: string
  snippet: string
  classification?: 'PHI' | 'PII' | 'PCI' | 'SECRET' | 'Financial' | 'Credential' | 'Sensitive'
  redacted: boolean
}

export interface ComplianceRule {
  id: string
  control: string
  title: string
  severity: ComplianceSeverity
  confidence?: ComplianceConfidence
  blocking?: boolean
  dataTypes?: DataClassificationType[]
  requireAny?: EvidenceSignal[]
  requireAll?: EvidenceSignal[]
  missingAny?: EvidenceSignal[]
  minFields?: number
  patterns?: string[]
  impact: string
  remediation: string
}

export interface ComplianceControl {
  id: string
  name: string
  description: string
  rules: ComplianceRule[]
}

export interface CompliancePolicy {
  id: ComplianceFramework
  name: string
  version: string
  description: string
  controls: ComplianceControl[]
}

export interface DeterministicComplianceFinding {
  id: string
  framework: ComplianceFramework
  frameworkVersion: string
  controlId: string
  ruleId: string
  /** @deprecated use controlId */
  control: string
  title: string
  severity: ComplianceSeverity
  confidence: ComplianceConfidence
  evidence: EvidenceRecord
  impact: string
  remediation: string
  affectedFiles: string[]
  file?: string
  line?: number
  dataType?: DataClassificationType
  dataFlow?: Array<{ file: string; line?: number; description: string }>
  blocking: boolean
  detectedBy: DetectedBy
}

export interface ComplianceFrameworkAssessment {
  framework: ComplianceFramework
  name: string
  version?: string
  status: ComplianceStatus
  score: number
  findingCount: number
  controlsChecked: number
  scopeNote?: string
  confidence?: ComplianceConfidence
  coverage?: Array<{
    id: string
    label: string
    percent: number | null
    status: 'scored' | 'not_reviewed'
  }>
}

export interface ComplianceRegressionAlert {
  framework: string
  previousStatus: string
  currentStatus: string
  previousFindingCount: number
  currentFindingCount: number
  newFindings: Array<{ title: string; severity?: string }>
  message: string
}

export interface ComplianceReviewContext {
  findings: DeterministicComplianceFinding[]
  classifications: Array<{
    type: DataClassificationType
    source: string
    destination: string
    confidence: ComplianceConfidence
    file?: string
    line?: number
    evidence?: string
  }>
  dataFlows: Array<{
    source: string
    transformations: string[]
    sink: string
    dataType?: DataClassificationType
    files: Array<{ path: string; line?: number }>
    issues?: string[]
  }>
  controlsChecked: Array<{
    id: string
    label: string
    framework: ComplianceFramework
    status: 'no_issues' | 'issues_detected' | 'not_reviewed'
    passed?: boolean
  }>
  assessments: ComplianceFrameworkAssessment[]
  regressions?: ComplianceRegressionAlert[]
  reviewedScope: string[]
  notReviewedScope: string[]
  disclaimer: string
}

export interface CustomCompliancePolicy {
  id: string
  name: string
  controlId: string
  severity: ComplianceSeverity
  blocking: boolean
  patterns: string[]
  dataTypes?: DataClassificationType[]
  sinks?: Array<'log' | 'response' | 'storage'>
  remediation?: string
  /** Enterprise category, e.g. "PII Exposure" */
  category?: string
  /** block | review | inform */
  action?: 'block' | 'review' | 'inform'
}
