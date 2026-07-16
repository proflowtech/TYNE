/**
 * Application-aware compliance data-flow engine.
 * Builds Source → Transformation → Destination chains from changed code.
 * # ponytail: line/hunk heuristics (not full-program taint); upgrade to real CFG if FP rate rises.
 */
import type { DataClassificationType } from './types'
import { classifyData, extractAstContext, type AstContext } from './dataClassification'

export interface DataFlowAnalysis {
  source: string
  transformations: string[]
  sink: string
  dataType?: DataClassificationType
  files: Array<{ path: string; line?: number }>
  issues: string[]
  hasAuthorization: boolean
}

type DiffLine = { file: string; line?: number; text: string }

function changedLines(diff: string): DiffLine[] {
  const rows: DiffLine[] = []
  let file = 'unknown'
  let line: number | undefined
  for (const raw of diff.split('\n')) {
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) { file = fileMatch[1]; continue }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { line = Number(hunk[1]); continue }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ file, line, text: raw.slice(1) })
      if (line !== undefined) line++
    } else if (!raw.startsWith('-') && line !== undefined) {
      line++
    }
  }
  return rows
}

function tableLabel(ctx: AstContext): string | undefined {
  if (ctx.tableRefs.length) {
    const t = ctx.tableRefs[0]
    if (/patient|ehr|medical|phi|diagnosis/i.test(t)) return 'Database: patients table'
    if (/user|customer|member|employee/i.test(t)) return 'Database: users table'
    if (/payment|card|invoice/i.test(t)) return 'Database: payments table'
    return `Database: ${t} table`
  }
  if (ctx.subjectVars.some(v => /patient|ehr|medical/i.test(v))) return 'Database: patients table'
  if (ctx.subjectVars.some(v => /user|customer|member/i.test(v))) return 'Database: users table'
  if (ctx.subjectVars.some(v => /payment|card|invoice/i.test(v))) return 'Database: payments table'
  return undefined
}

function sourceLabel(dataType: DataClassificationType | undefined, ctx: AstContext): string {
  return tableLabel(ctx)
    || (dataType === 'PHI' ? 'Database: patients table'
      : dataType === 'PCI' ? 'Database: payments table'
      : dataType === 'PII' ? 'Database: users table'
      : dataType === 'Credential' ? 'Secrets / credentials store'
      : dataType === 'Financial' ? 'Database: financial records'
      : 'Sensitive data source')
}

function transformLabel(file: string): string {
  const base = file.split('/').pop() || file
  if (/service|repo|model|dao|store/i.test(base)) return base
  if (/controller|handler|route|api|resolver/i.test(base)) return base
  return base
}

function sinkLabel(ctx: AstContext, text: string): string | undefined {
  if (ctx.sinks.includes('response') || /\b(Response\.json|res\.json|NextResponse\.json|res\.send)\b/i.test(text)) {
    return 'API Response'
  }
  if (ctx.sinks.includes('log') || /\b(logger|console)\.(log|info|warn|error|debug)\b/i.test(text)) {
    return 'Application logs'
  }
  if (ctx.sinks.includes('storage') || /\b(insert|create|upsert|save|persist)\b/i.test(text)) {
    return 'Persistent storage'
  }
  if (/frontend|component|page|view|\.tsx|\.jsx|\.vue/i.test(text)) return 'Frontend'
  return undefined
}

function issueForFlow(input: {
  dataType?: DataClassificationType
  sink: string
  hasAuthorization: boolean
  ctx: AstContext
}): string | undefined {
  if (!input.dataType) return undefined
  if (input.sink === 'API Response' && !input.hasAuthorization) {
    if (input.dataType === 'PHI') {
      return 'PHI data flows to API response without detected authorization control.'
    }
    if (input.dataType === 'PII') {
      return 'PII data flows to API response without detected authorization control.'
    }
    if (input.dataType === 'PCI') {
      return 'Cardholder data flows to API response without detected authorization control.'
    }
  }
  if (input.sink === 'Application logs' && (input.dataType === 'PHI' || input.dataType === 'PCI' || input.dataType === 'Credential')) {
    return `${input.dataType} appears to reach application logs.`
  }
  if (input.sink === 'API Response' && input.ctx.propertyAccess.some(p => /patient\.|diagnosis|mrn|ssn|email|phone/i.test(p))) {
    if (!input.hasAuthorization && input.dataType === 'PHI') {
      return 'PHI data flows to API response without detected authorization control.'
    }
  }
  return undefined
}

/** Analyze changed diff into Source → Transformation → Destination flows. */
export function analyzeDataFlows(diff: string): DataFlowAnalysis[] {
  const lines = changedLines(diff)
  const flows: DataFlowAnalysis[] = []

  for (const row of lines) {
    const nearby = lines
      .filter(other => other.file === row.file && Math.abs((other.line || 0) - (row.line || 0)) <= 16)
      .map(other => other.text)
      .join('\n')
    const ctx = extractAstContext(row.text, nearby)
    const dataTypes = classifyData(row.text, nearby)
    if (!dataTypes.length) continue

    const sink = sinkLabel(ctx, `${row.text}\n${nearby}`)
    if (!sink) continue

    const dataType = dataTypes[0]
    const source = sourceLabel(dataType, ctx)
    const transformations = [transformLabel(row.file)]
    if (sink === 'API Response' && !/frontend|component|page|\.tsx|\.jsx/i.test(row.file)) {
      // Keep service → API; frontend hop is implied when returning JSON to clients.
    }
    const hasAuthorization = ctx.hasAuthNearby
    const issue = issueForFlow({ dataType, sink, hasAuthorization, ctx })
    flows.push({
      source,
      transformations,
      sink,
      dataType,
      files: [{ path: row.file, line: row.line }],
      issues: issue ? [issue] : [],
      hasAuthorization,
    })
  }

  // Merge identical source/transform/sink chains
  const merged = new Map<string, DataFlowAnalysis>()
  for (const flow of flows) {
    const key = `${flow.source}|${flow.transformations.join('>')}|${flow.sink}|${flow.dataType}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, flow)
      continue
    }
    existing.files.push(...flow.files)
    for (const issue of flow.issues) {
      if (!existing.issues.includes(issue)) existing.issues.push(issue)
    }
    existing.hasAuthorization = existing.hasAuthorization && flow.hasAuthorization
  }
  return [...merged.values()].slice(0, 16)
}
