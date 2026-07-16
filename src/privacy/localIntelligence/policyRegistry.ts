import { hipaaPolicy } from './frameworks/hipaa/controls'
import { catalogPolicies } from './frameworks/catalog'
import {
  COMPLIANCE_FRAMEWORKS,
  type ComplianceFramework,
  type CompliancePolicy,
  type CustomCompliancePolicy,
} from './types'

const registry = new Map<ComplianceFramework, CompliancePolicy>(
  [hipaaPolicy, ...catalogPolicies].map(policy => [policy.id, policy]),
)

export function parseFrameworks(value: unknown): ComplianceFramework[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is ComplianceFramework =>
    typeof item === 'string' && COMPLIANCE_FRAMEWORKS.includes(item as ComplianceFramework)
  ))]
}

export function getPolicies(frameworks: ComplianceFramework[]): CompliancePolicy[] {
  return frameworks.map(framework => registry.get(framework)).filter((policy): policy is CompliancePolicy => Boolean(policy))
}

export function customPolicy(custom: CustomCompliancePolicy): CompliancePolicy {
  const sinkSignals = (custom.sinks || []).map(sink => sink as 'log' | 'response' | 'storage')
  const blocking = custom.action === 'block' || (custom.action !== 'inform' && custom.action !== 'review' && custom.blocking)
  const category = custom.category || 'Enterprise Policy'
  return {
    id: 'CUSTOM',
    name: custom.name,
    version: '1',
    description: 'Max-tier enterprise policy.',
    controls: [{
      id: custom.controlId,
      name: custom.name,
      description: `${category}: ${custom.name}`,
      rules: [{
        id: custom.id,
        control: custom.controlId,
        title: custom.name,
        severity: custom.severity,
        blocking,
        confidence: 'high',
        dataTypes: custom.dataTypes,
        requireAny: sinkSignals.length ? sinkSignals : undefined,
        patterns: custom.patterns.map(pattern => pattern.slice(0, 100)).filter(Boolean),
        impact: `${category} — The reviewed change conflicts with an enabled enterprise compliance policy.`,
        remediation: custom.remediation || 'Remove the prohibited data flow or update the enterprise policy with an approved exception.',
      }],
    }],
  }
}
