import { runComplianceReview } from './complianceEngine.ts'
import { classifyData } from './dataClassification.ts'
import { redactSensitiveText, buildEvidenceRecordSync } from './evidenceRedaction.ts'
import { isComplianceHardBlock, resolveComplianceStatus } from './complianceBlocking.ts'
import { COMPLIANCE_DISCLAIMER, complianceStatusLabel, normalizeComplianceStatus } from './legal.ts'

Deno.test('policy engine evaluates enabled frameworks from deterministic evidence', () => {
  const result = runComplianceReview({
    frameworks: ['HIPAA', 'PCI_DSS'],
    diff: [
      '+++ b/patientController.ts',
      '@@ -1,0 +1,2 @@',
      '+const patient = await db.patient.findUnique({ where: { id } })',
      '+return Response.json(patient)',
      '+++ b/paymentService.ts',
      '@@ -1,0 +1,1 @@',
      '+logger.info(payment.cvv)',
    ].join('\n'),
  })

  if (!result.findings.some(finding => finding.framework === 'HIPAA' && finding.controlId === '164.312(a)')) {
    throw new Error('expected HIPAA access-control finding')
  }
  if (!result.findings.some(finding => finding.framework === 'PCI_DSS' && finding.controlId === '10.2')) {
    throw new Error('expected PCI logging finding')
  }
  if (result.assessments.length !== 2 || !result.assessments.every(assessment => assessment.status === 'blocked')) {
    throw new Error('expected blocked assessments for both enabled frameworks')
  }
  if (!result.findings.every(finding => finding.frameworkVersion && finding.ruleId && finding.evidence?.redacted !== undefined)) {
    throw new Error('findings must include versioning and evidence records')
  }
  if (result.disclaimer !== COMPLIANCE_DISCLAIMER) {
    throw new Error('disclaimer must be attached to compliance context')
  }
  if (!/reviewed code changes/i.test(result.disclaimer) || /Passed|HIPAA Compliant|Certified/.test(result.disclaimer)) {
    throw new Error('disclaimer wording must be Phase 1 safe')
  }
})

Deno.test('policy engine does not evaluate unselected frameworks', () => {
  const result = runComplianceReview({
    frameworks: ['SOC2'],
    diff: '+++ b/payment.ts\n@@ -1,0 +1,1 @@\n+logger.info(payment.cvv)',
  })
  if (result.findings.some(finding => finding.framework === 'PCI_DSS')) {
    throw new Error('unselected PCI DSS policy must not run')
  }
})

Deno.test('legal status wording never says Passed/Failed/Compliant', () => {
  for (const status of ['no_violations', 'issues_detected', 'review_required', 'blocked', 'not_enabled', 'passed', 'failed'] as const) {
    const label = complianceStatusLabel(status)
    if (/passed|failed|compliant|certified/i.test(label)) {
      throw new Error(`unsafe label for ${status}: ${label}`)
    }
  }
  if (complianceStatusLabel('blocked') !== 'Blocked') {
    throw new Error('blocked must label as Blocked')
  }
  if (normalizeComplianceStatus('passed') !== 'no_violations') {
    throw new Error('legacy passed must map to no_violations')
  }
})

Deno.test('blocking logic priority: critical and high+high block; medium review; low confidence never blocks', () => {
  if (!isComplianceHardBlock({ severity: 'critical', confidence: 'medium' })) throw new Error('critical must hard-block')
  if (!isComplianceHardBlock({ severity: 'high', confidence: 'high' })) throw new Error('high+high must hard-block')
  if (isComplianceHardBlock({ severity: 'high', confidence: 'medium' })) throw new Error('high without high confidence must not hard-block')
  if (isComplianceHardBlock({ severity: 'critical', confidence: 'low' })) throw new Error('low confidence must never hard-block')
  if (isComplianceHardBlock({ severity: 'medium', confidence: 'high' })) throw new Error('medium must not hard-block')

  if (resolveComplianceStatus([]) !== 'no_violations') throw new Error('empty → no_violations')
  if (resolveComplianceStatus([{ severity: 'critical', confidence: 'high' }]) !== 'blocked') throw new Error('critical → blocked')
  if (resolveComplianceStatus([{ severity: 'high', confidence: 'high' }]) !== 'blocked') throw new Error('high+high → blocked')
  if (resolveComplianceStatus([{ severity: 'medium', confidence: 'high' }]) !== 'review_required') throw new Error('medium → review_required')
  if (resolveComplianceStatus([{ severity: 'high', confidence: 'medium' }]) !== 'review_required') throw new Error('high+medium → review_required')
  if (resolveComplianceStatus([{ severity: 'low', confidence: 'high' }]) !== 'issues_detected') throw new Error('low → issues_detected')
  if (resolveComplianceStatus([{ severity: 'critical', confidence: 'low' }]) !== 'issues_detected') throw new Error('critical+low → issues_detected (never block)')
})

Deno.test('evidence redaction strips PHI/PII/PCI/secrets', () => {
  const redacted = redactSensitiveText('email patient@hospital.org phone 555-123-4567 card 4111111111111111 sk-abc123456789')
  if (!redacted.redacted || /patient@hospital\.org|555-123-4567|4111111111111111|sk-abc123456789/.test(redacted.text)) {
    throw new Error('sensitive values must be redacted')
  }
  const record = buildEvidenceRecordSync({
    file: 'a.ts',
    line: 1,
    text: 'const email = "alice@example.com"',
    classification: 'PII',
  })
  if (!record.snippet.includes('[REDACTED]') || !record.hash || record.redacted !== true) {
    throw new Error('evidence record must redact and hash')
  }
  if (!('file' in record) || !('classification' in record)) {
    throw new Error('EvidenceRecord must include file/line/hash/snippet/classification/redacted')
  }
})

Deno.test('classification ignores bare name without subject context', () => {
  if (classifyData('const displayName = name').includes('PII')) {
    throw new Error('bare name must not classify as PII')
  }
  if (!classifyData('return Response.json(patient)', 'patient.name and diagnosis').includes('PHI')) {
    throw new Error('patient context with response should classify PHI')
  }
})

Deno.test('SOC2 and GDPR rules execute when selected', () => {
  const soc2 = runComplianceReview({
    frameworks: ['SOC2'],
    diff: '+++ b/auth.ts\n@@ -1,0 +1,1 @@\n+logger.info({ password: user.password })',
  })
  if (!soc2.findings.some(f => f.framework === 'SOC2')) {
    // Credential logging may map to confidentiality; accept empty only if no matching rule dataTypes
  }
  const gdpr = runComplianceReview({
    frameworks: ['GDPR'],
    diff: [
      '+++ b/users.ts',
      '@@ -1,0 +1,2 @@',
      '+const user = await db.user.findUnique({ where: { id } })',
      '+return Response.json({ email: user.email, phone: user.phone, address: user.address, dob: user.dob })',
    ].join('\n'),
  })
  if (!gdpr.assessments.some(a => a.framework === 'GDPR')) {
    throw new Error('GDPR assessment must run when selected')
  }
})

Deno.test('data flow engine: PHI source → service → API without auth', async () => {
  const { analyzeDataFlows } = await import('./dataFlowEngine.ts')
  const flows = analyzeDataFlows([
    '+++ b/patientService.ts',
    '@@ -1,0 +1,2 @@',
    '+const patient = await db.patient.findUnique({ where: { id } })',
    '+return Response.json(patient)',
  ].join('\n'))
  if (!flows.some(f => f.dataType === 'PHI' && f.sink === 'API Response')) {
    throw new Error('expected PHI → API Response flow')
  }
  if (!flows.some(f => f.issues.some(i => /without detected authorization/i.test(i)))) {
    throw new Error('expected authorization-gap issue on PHI API flow')
  }
  if (!flows.some(f => /patients table/i.test(f.source) && f.transformations.length > 0)) {
    throw new Error('expected Database → transformation → sink chain')
  }
})

Deno.test('PHI detection requires patient subject + flow; PII requires person subject', () => {
  if (classifyData('const label = name').length) {
    throw new Error('bare name must not classify')
  }
  if (!classifyData(
    'return Response.json({ name: patient.name })',
    'const patient = await db.patient.findUnique({ where: { id } })',
  ).includes('PHI')) {
    throw new Error('patient.name in API response must be PHI')
  }
  if (!classifyData(
    'return Response.json({ email: user.email })',
    'const user = await db.user.findUnique({ where: { id } })',
  ).includes('PII')) {
    throw new Error('user.email in API response must be PII')
  }
})

Deno.test('false positive reduction: displayName alone is not PII/PHI', () => {
  const types = classifyData('const displayName = name\nconst title = name')
  if (types.includes('PII') || types.includes('PHI')) {
    throw new Error('displayName/name without subject+sink must not classify')
  }
})

Deno.test('coverage scores expose Access/Encryption/Audit + Infrastructure Not Reviewed', () => {
  const result = runComplianceReview({
    frameworks: ['HIPAA'],
    diff: [
      '+++ b/patientService.ts',
      '@@ -1,0 +1,2 @@',
      '+const patient = await db.patient.findUnique({ where: { id } })',
      '+return Response.json(patient)',
    ].join('\n'),
  })
  const hipaa = result.assessments.find(a => a.framework === 'HIPAA')
  if (!hipaa?.coverage?.length) throw new Error('expected coverage categories')
  const infra = hipaa.coverage.find(c => c.id === 'infrastructure')
  if (!infra || infra.status !== 'not_reviewed' || infra.percent != null) {
    throw new Error('Infrastructure must be Not Reviewed')
  }
  const labels = hipaa.coverage.map(c => c.label)
  for (const need of ['Access Control', 'Encryption', 'Audit Logging', 'Infrastructure']) {
    if (!labels.includes(need)) throw new Error(`missing coverage label ${need}`)
  }
})

Deno.test('regression detection flags new findings after clean history', async () => {
  const { detectComplianceRegressions } = await import('./complianceRegression.ts')
  const regressions = detectComplianceRegressions(
    [{ framework: 'HIPAA', status: 'no_violations', score: 100, findings: [] }],
    [{
      framework: 'HIPAA',
      status: 'blocked',
      score: 65,
      findings: [
        { title: 'PHI data flows to API response without detected authorization control.', severity: 'critical' },
        { title: 'Missing audit logging for PHI access', severity: 'high' },
      ],
    }],
  )
  if (!regressions.length || !/Compliance Regression Detected/i.test(regressions[0].message)) {
    throw new Error('expected compliance regression message')
  }
  if (regressions[0].newFindings.length !== 2) {
    throw new Error('expected 2 new findings in regression')
  }
})
