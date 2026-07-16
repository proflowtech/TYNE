import { normalizeScannerFinding, normalizeScannerFindings } from './scannerAdapters.ts'

Deno.test('normalizeScannerFinding maps SAST into Tyne finding format', () => {
  const finding = normalizeScannerFinding({
    scanner: 'sast',
    tool: 'semgrep',
    title: 'SQL injection',
    severity: 'critical',
    file: 'api.ts',
    line: 12,
    evidence: 'string concat in query',
    remediation: 'Use parameterized queries',
    ruleId: 'sqli',
  })
  if (finding.category !== 'security' || finding.detectedBy !== 'sast_scanner') {
    throw new Error('expected security/sast_scanner finding')
  }
  if (!finding.blocking || finding.severity !== 'critical') {
    throw new Error('critical SAST should block')
  }
})

Deno.test('normalizeScannerFindings accepts dependency/container/cloud kinds', () => {
  const list = normalizeScannerFindings([
    { scanner: 'dependency', title: 'CVE in lodash', severity: 'high', cve: 'CVE-2021-23337', packageName: 'lodash' },
    { scanner: 'trivy', title: 'Base image CVE', severity: 'medium' },
    { scanner: 'prowler', title: 'Public S3 bucket', severity: 'high' },
  ])
  if (list.length !== 3) throw new Error('expected 3 normalized findings')
  if (list[0].scannerKind !== 'dependency') throw new Error('dependency kind')
  if (list[1].scannerKind !== 'container') throw new Error('container kind from trivy')
  if (list[2].scannerKind !== 'cloud') throw new Error('cloud kind from prowler')
})
