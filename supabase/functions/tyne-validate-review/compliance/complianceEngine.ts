import { collectComplianceEvidence } from './evidenceEngine.ts'
import { destinationFor } from './dataClassification.ts'
import { analyzeDataFlows } from './dataFlowEngine.ts'
import { scoreFramework } from './complianceScoring.ts'
import { customPolicy, getPolicies } from './policyRegistry.ts'
import { buildEvidenceRecordSync } from './evidenceRedaction.ts'
import { COMPLIANCE_DISCLAIMER } from './legal.ts'
import type {
  ComplianceEvidence,
  CompliancePolicy,
  ComplianceReviewContext,
  ComplianceRule,
  CustomCompliancePolicy,
  DataClassificationType,
  DeterministicComplianceFinding,
} from './types.ts'

function ruleApplies(rule: ComplianceRule, evidence: ComplianceEvidence): boolean {
  if (rule.dataTypes?.length && !rule.dataTypes.some(type => evidence.dataTypes.includes(type))) return false
  if (rule.requireAny?.length && !rule.requireAny.some(signal => evidence.signals.has(signal))) return false
  if (rule.requireAll?.length && !rule.requireAll.every(signal => evidence.signals.has(signal))) return false
  if (rule.missingAny?.length && !rule.missingAny.some(signal => !evidence.signals.has(signal))) return false
  if (rule.minFields && evidence.fieldCount < rule.minFields) return false
  if (rule.patterns?.length && !rule.patterns.some(pattern => evidence.text.toLowerCase().includes(pattern.toLowerCase()))) return false
  return true
}

function relevantToControl(policy: CompliancePolicy, controlId: string, evidence: ComplianceEvidence): boolean {
  return policy.controls
    .find(control => control.id === controlId)
    ?.rules.some(rule =>
      (!rule.dataTypes?.length || rule.dataTypes.some(type => evidence.dataTypes.includes(type)))
      && (!rule.requireAny?.length || rule.requireAny.some(signal => evidence.signals.has(signal)))
      && (!rule.requireAll?.length || rule.requireAll.some(signal => evidence.signals.has(signal)))
    ) || false
}

export function runComplianceReview(input: {
  diff: string
  frameworks: Parameters<typeof getPolicies>[0]
  customPolicies?: CustomCompliancePolicy[]
  policies?: CompliancePolicy[]
  maxFindings?: number
}): ComplianceReviewContext {
  const evidence = collectComplianceEvidence(input.diff)
  const analyzedFlows = analyzeDataFlows(input.diff)
  const policies = [
    ...(input.policies?.length ? input.policies : getPolicies(input.frameworks)),
    ...(input.customPolicies || []).map(customPolicy),
  ]
  const findings: DeterministicComplianceFinding[] = []

  for (const policy of policies) {
    for (const control of policy.controls) {
      for (const rule of control.rules) {
        for (const item of evidence) {
          if (!ruleApplies(rule, item)) continue
          const dataType = item.dataTypes.find(type => rule.dataTypes?.includes(type)) || item.dataTypes[0]
          const evidenceRecord = buildEvidenceRecordSync({
            file: item.file,
            line: item.line,
            text: item.text,
            classification: dataType,
          })
          const sinkish = item.signals.has('log') || item.signals.has('response') || item.signals.has('storage')
          const matchingFlow = analyzedFlows.find(flow =>
            flow.files.some(f => f.path === item.file && (f.line === undefined || f.line === item.line))
            || (flow.files.some(f => f.path === item.file) && flow.dataType === dataType)
          )
          const flowIssue = matchingFlow?.issues[0]
          findings.push({
            id: `${rule.id}:${item.file}:${item.line || 0}`,
            framework: policy.id,
            frameworkVersion: policy.version,
            controlId: rule.control,
            ruleId: rule.id,
            control: rule.control,
            title: flowIssue && /without detected authorization/i.test(flowIssue)
              ? flowIssue
              : rule.title,
            severity: rule.severity,
            confidence: rule.confidence || 'medium',
            evidence: evidenceRecord,
            impact: rule.impact,
            remediation: rule.remediation,
            affectedFiles: [item.file],
            file: item.file,
            line: item.line,
            dataType,
            dataFlow: matchingFlow
              ? [
                  { file: item.file, line: item.line, description: matchingFlow.source },
                  ...matchingFlow.transformations.map(t => ({ file: item.file, line: item.line, description: t })),
                  { file: item.file, line: item.line, description: matchingFlow.sink },
                ]
              : sinkish
                ? [{ file: item.file, line: item.line, description: `${dataType || 'Sensitive data'} reaches ${destinationFor(item.signals)}` }]
                : undefined,
            blocking: (rule.blocking ?? rule.severity === 'critical') && (rule.confidence || 'medium') !== 'low',
            detectedBy: matchingFlow ? 'dataflow' : sinkish ? 'dataflow' : 'ast',
          })
        }
      }
    }
  }

  // Emit data-flow findings when analysis found auth gaps not already covered by rule matches
  for (const flow of analyzedFlows) {
    if (!flow.issues.length || !flow.dataType) continue
    for (const policy of policies) {
      const accessControl = policy.controls.find(c => /access|164\.312\(a\)|CC6|AC-3/i.test(`${c.id} ${c.name}`))
      if (!accessControl?.rules.length) continue
      const rule = accessControl.rules.find(r => !r.dataTypes?.length || r.dataTypes.includes(flow.dataType!)) || accessControl.rules[0]
      const file = flow.files[0]?.path || 'unknown'
      const line = flow.files[0]?.line
      if (findings.some(f => f.file === file && f.line === line && (f.title === flow.issues[0] || f.detectedBy === 'dataflow'))) continue
      findings.push({
        id: `dataflow:${policy.id}:${file}:${line || 0}`,
        framework: policy.id,
        frameworkVersion: policy.version,
        controlId: accessControl.id,
        ruleId: rule.id,
        control: accessControl.id,
        title: flow.issues[0],
        severity: flow.dataType === 'PHI' || flow.dataType === 'PCI' ? 'critical' : 'high',
        confidence: flow.hasAuthorization ? 'low' : 'high',
        evidence: buildEvidenceRecordSync({
          file,
          line,
          text: `${flow.source} → ${flow.transformations.join(' → ')} → ${flow.sink}`,
          classification: flow.dataType,
        }),
        impact: rule.impact,
        remediation: rule.remediation,
        affectedFiles: flow.files.map(f => f.path),
        file,
        line,
        dataType: flow.dataType,
        dataFlow: [
          { file, line, description: flow.source },
          ...flow.transformations.map(t => ({ file, line, description: t })),
          { file, line, description: flow.sink },
        ],
        blocking: !flow.hasAuthorization && (flow.dataType === 'PHI' || flow.dataType === 'PCI' || flow.dataType === 'PII'),
        detectedBy: 'dataflow',
      })
    }
  }

  const uniqueFindings = [...new Map(findings.map(finding => [
    `${finding.framework}|${finding.controlId}|${finding.ruleId}|${finding.file}|${finding.line}|${finding.title}`,
    finding,
  ])).values()].slice(0, input.maxFindings || 40)

  const classifications = evidence.flatMap(item => item.dataTypes.map(type => ({
    type,
    source: sourceFor(type),
    destination: destinationFor(item.signals),
    confidence: (item.signals.has('response') || item.signals.has('log') ? 'high' : 'medium') as 'high' | 'medium',
    file: item.file,
    line: item.line,
    evidence: buildEvidenceRecordSync({ file: item.file, line: item.line, text: item.text, classification: type }).snippet,
  }))).slice(0, 24)

  const dataFlows = analyzedFlows.map(flow => ({
    source: flow.source,
    transformations: flow.transformations,
    sink: flow.sink,
    dataType: flow.dataType,
    files: flow.files,
    issues: flow.issues,
  }))

  const controlsChecked = policies.flatMap(policy => policy.controls.map(control => {
    const failed = uniqueFindings.some(finding => finding.framework === policy.id && finding.controlId === control.id)
    const reviewed = evidence.some(item => relevantToControl(policy, control.id, item))
      || uniqueFindings.some(finding => finding.framework === policy.id && finding.controlId === control.id)
    const status = failed ? 'issues_detected' as const : reviewed ? 'no_issues' as const : 'not_reviewed' as const
    return { id: control.id, label: control.name, framework: policy.id, status, passed: status === 'no_issues' }
  }))

  const assessmentPolicies = [...policies.reduce((byFramework, policy) => {
    const existing = byFramework.get(policy.id)
    if (existing) existing.controls.push(...policy.controls)
    else byFramework.set(policy.id, { ...policy, name: policy.id === 'CUSTOM' ? 'Custom Enterprise Policies' : policy.name, controls: [...policy.controls] })
    return byFramework
  }, new Map<CompliancePolicy['id'], CompliancePolicy>()).values()]

  return {
    findings: uniqueFindings,
    classifications,
    dataFlows,
    controlsChecked,
    assessments: assessmentPolicies.map(policy => scoreFramework(policy, uniqueFindings, controlsChecked)),
    reviewedScope: ['Changed files', 'Application data flows', 'Impacted compliance controls'],
    notReviewedScope: ['Cloud IAM', 'Production configuration', 'Runtime data', 'Third-party services', 'Infrastructure'],
    disclaimer: COMPLIANCE_DISCLAIMER,
  }
}

export function emptyComplianceContext(): ComplianceReviewContext {
  return {
    findings: [],
    classifications: [],
    dataFlows: [],
    controlsChecked: [],
    assessments: [],
    regressions: [],
    reviewedScope: [],
    notReviewedScope: [],
    disclaimer: COMPLIANCE_DISCLAIMER,
  }
}

function sourceFor(type: DataClassificationType): string {
  if (type === 'PHI') return 'Protected health information'
  if (type === 'PCI') return 'Cardholder data'
  if (type === 'PII') return 'Personal information'
  if (type === 'Financial') return 'Financial records'
  if (type === 'Credential') return 'Credentials'
  return 'Sensitive data'
}
