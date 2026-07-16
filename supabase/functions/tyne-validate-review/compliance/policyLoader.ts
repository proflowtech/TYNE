import { getPolicies } from './policyRegistry.ts'
import type { ComplianceFramework, CompliancePolicy, ComplianceRule, ComplianceSeverity } from './types.ts'

type DbClient = {
  from: (table: string) => any
}

function asSeverity(value: unknown, fallback: ComplianceSeverity = 'high'): ComplianceSeverity {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low' ? value : fallback
}

function ruleFromConfig(controlId: string, row: Record<string, unknown>): ComplianceRule | null {
  const config = (row.rule_config && typeof row.rule_config === 'object' ? row.rule_config : {}) as Record<string, unknown>
  const embedded = (config.rule && typeof config.rule === 'object' ? config.rule : config) as Record<string, unknown>
  const id = String(row.rule_id || embedded.id || config.ruleId || '').trim()
  const title = String(embedded.title || config.title || '').trim()
  if (!id || !title) return null
  return {
    id,
    control: controlId,
    title,
    severity: asSeverity(row.severity || embedded.severity, 'high'),
    confidence: embedded.confidence === 'high' || embedded.confidence === 'low' ? embedded.confidence : 'medium',
    blocking: typeof row.blocking === 'boolean' ? row.blocking : Boolean(embedded.blocking),
    dataTypes: Array.isArray(embedded.dataTypes) ? embedded.dataTypes as ComplianceRule['dataTypes'] : undefined,
    requireAny: Array.isArray(embedded.requireAny) ? embedded.requireAny as ComplianceRule['requireAny'] : undefined,
    requireAll: Array.isArray(embedded.requireAll) ? embedded.requireAll as ComplianceRule['requireAll'] : undefined,
    missingAny: Array.isArray(embedded.missingAny) ? embedded.missingAny as ComplianceRule['missingAny'] : undefined,
    minFields: typeof embedded.minFields === 'number' ? embedded.minFields : undefined,
    patterns: Array.isArray(embedded.patterns) ? embedded.patterns.filter((p): p is string => typeof p === 'string') : undefined,
    impact: String(embedded.impact || 'Detected compliance control risk in reviewed code changes.'),
    remediation: String(embedded.remediation || 'Remediate the control gap before merge.'),
  }
}

/** Load active policies from Supabase. Falls back to bundled registry when DB has no executable rules. */
export async function loadPoliciesFromDb(
  supabase: DbClient,
  frameworks: ComplianceFramework[],
): Promise<CompliancePolicy[]> {
  const wanted = frameworks.filter(id => id !== 'CUSTOM')
  if (!wanted.length) return []

  const { data: frameworkRows, error: frameworkError } = await supabase
    .from('compliance_frameworks')
    .select('id, name, version, description, enabled')
    .in('id', wanted)
    .eq('enabled', true)
  if (frameworkError) {
    console.warn('compliance_frameworks load failed:', frameworkError.message || frameworkError)
    return getPolicies(wanted)
  }

  const { data: controlRows, error: controlError } = await supabase
    .from('compliance_controls')
    .select('id, framework_id, control_id, name, description, severity')
    .in('framework_id', wanted)
  if (controlError) {
    console.warn('compliance_controls load failed:', controlError.message || controlError)
    return overlayVersions(getPolicies(wanted), frameworkRows || [])
  }

  const controlIds = (controlRows || []).map((row: any) => row.id)
  let ruleRows: any[] = []
  if (controlIds.length) {
    const { data, error } = await supabase
      .from('compliance_rules')
      .select('id, control_id, rule_id, rule_type, language, pattern, ast_query, severity, blocking, enabled, rule_config')
      .in('control_id', controlIds)
      .eq('enabled', true)
    if (error) {
      console.warn('compliance_rules load failed:', error.message || error)
      return overlayVersions(getPolicies(wanted), frameworkRows || [])
    }
    ruleRows = data || []
  }

  const rulesByControl = new Map<string, ComplianceRule[]>()
  for (const row of ruleRows) {
    const control = (controlRows || []).find((c: any) => c.id === row.control_id)
    if (!control) continue
    const rule = ruleFromConfig(control.control_id, row)
    if (!rule) continue
    const list = rulesByControl.get(control.id) || []
    list.push(rule)
    rulesByControl.set(control.id, list)
  }

  const executableCount = [...rulesByControl.values()].reduce((n, list) => n + list.length, 0)
  if (!executableCount) {
    return overlayVersions(getPolicies(wanted), frameworkRows || [])
  }

  return (frameworkRows || []).map((fw: any) => {
    const controls = (controlRows || [])
      .filter((control: any) => control.framework_id === fw.id)
      .map((control: any) => ({
        id: control.control_id,
        name: control.name,
        description: control.description,
        rules: rulesByControl.get(control.id) || [],
      }))
      .filter((control: { rules: ComplianceRule[] }) => control.rules.length > 0)
    return {
      id: fw.id as ComplianceFramework,
      name: fw.name,
      version: fw.version || '1',
      description: fw.description || '',
      controls,
    }
  }).filter((policy: CompliancePolicy) => policy.controls.length > 0)
}

/** Upsert bundled registry rules into DB so catalogs become executable source of truth. */
export async function syncBundledPoliciesToDb(supabase: DbClient): Promise<void> {
  const bundled = getPolicies([
    'HIPAA', 'SOC2', 'PCI_DSS', 'GDPR', 'ISO27001', 'NIST_CSF', 'NIST_800_53', 'FEDRAMP', 'CCPA_CPRA', 'SOX',
  ])
  for (const policy of bundled) {
    await supabase.from('compliance_frameworks').upsert({
      id: policy.id,
      name: policy.name,
      version: policy.version,
      description: policy.description,
      enabled: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })

    for (const control of policy.controls) {
      const { data: controlRow, error } = await supabase
        .from('compliance_controls')
        .upsert({
          framework_id: policy.id,
          control_id: control.id,
          name: control.name,
          description: control.description,
          severity: control.rules[0]?.severity || 'high',
        }, { onConflict: 'framework_id,control_id' })
        .select('id')
        .maybeSingle()
      if (error || !controlRow?.id) continue

      for (const rule of control.rules) {
        await supabase.from('compliance_rules').upsert({
          control_id: controlRow.id,
          rule_id: rule.id,
          rule_type: 'dataflow',
          severity: rule.severity,
          blocking: rule.blocking ?? rule.severity === 'critical',
          enabled: true,
          rule_config: { engine: 'policy', ruleId: rule.id, rule },
        }, { onConflict: 'control_id,rule_id' })
      }
    }
  }
}

function overlayVersions(policies: CompliancePolicy[], frameworkRows: Array<{ id: string; version?: string; name?: string }>): CompliancePolicy[] {
  const byId = new Map(frameworkRows.map(row => [row.id, row]))
  return policies.map(policy => {
    const row = byId.get(policy.id)
    if (!row) return policy
    return {
      ...policy,
      name: row.name || policy.name,
      version: row.version || policy.version,
    }
  })
}
