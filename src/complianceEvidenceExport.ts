/**
 * Compliance evidence export for Validate & Review (MD / JSON / print-ready PDF HTML).
 * # ponytail: PDF is print-ready HTML (browser/IDE Print → PDF); no PDF dependency.
 */
import { COMPLIANCE_DISCLAIMER } from './validateReviewTypes';

export type ComplianceExportFormat = 'markdown' | 'json' | 'pdf';

export interface ComplianceExportFinding {
  framework?: string;
  frameworkVersion?: string;
  control?: string;
  controlId?: string;
  title?: string;
  evidence?: string | { snippet?: string };
  remediation?: string;
  severity?: string;
  status?: string;
  owner?: string;
  resolution?: string;
}

export interface ComplianceExportInput {
  reportId?: string;
  commitHash?: string;
  timestamp?: string;
  repositoryName?: string;
  branchName?: string;
  complianceStatus?: string;
  assessments?: Array<{
    framework?: string;
    name?: string;
    version?: string;
    status?: string;
    score?: number;
    coverage?: Array<{ label?: string; percent?: number | null; status?: string }>;
  }>;
  findings?: ComplianceExportFinding[];
  complianceFindings?: ComplianceExportFinding[];
  regressions?: Array<{ message?: string; framework?: string }>;
  disclaimer?: string;
}

function evidenceText(value: ComplianceExportFinding['evidence']): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.snippet || '';
}

function allFindings(input: ComplianceExportInput): ComplianceExportFinding[] {
  const list = [
    ...(input.complianceFindings || []),
    ...(input.findings || []).filter((f: any) => f.category === 'compliance' || f.framework),
  ];
  const seen = new Set<string>();
  return list.filter(f => {
    const key = `${f.framework}|${f.controlId || f.control}|${f.title}|${evidenceText(f.evidence)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildComplianceEvidenceJson(input: ComplianceExportInput): string {
  const findings = allFindings(input).map(f => ({
    framework: f.framework || 'CUSTOM',
    frameworkVersion: f.frameworkVersion || '',
    control: f.controlId || f.control || '',
    evidence: evidenceText(f.evidence),
    finding: f.title || '',
    remediation: f.remediation || '',
    severity: f.severity || '',
    workflowStatus: f.status || 'open',
    owner: f.owner || '',
    resolution: f.resolution || '',
  }));
  return JSON.stringify({
    schema: 'tyne.compliance_evidence.v1',
    commitHash: input.commitHash || '',
    timestamp: input.timestamp || new Date().toISOString(),
    repositoryName: input.repositoryName || '',
    branchName: input.branchName || '',
    reportId: input.reportId || '',
    complianceStatus: input.complianceStatus || '',
    assessments: input.assessments || [],
    regressions: input.regressions || [],
    findings,
    disclaimer: input.disclaimer || COMPLIANCE_DISCLAIMER,
  }, null, 2);
}

export function buildComplianceEvidenceMarkdown(input: ComplianceExportInput): string {
  const ts = input.timestamp || new Date().toISOString();
  const findings = allFindings(input);
  const assessmentLines = (input.assessments || []).map(a => {
    const cov = (a.coverage || []).map(c =>
      `  - ${c.label}: ${c.status === 'not_reviewed' || c.percent == null ? 'Not Reviewed' : `${c.percent}%`}`
    ).join('\n');
    return [
      `### ${(a.name || a.framework || 'Framework')} Assessment`,
      `- Framework: ${a.framework || ''}`,
      `- Framework Version: ${a.version || ''}`,
      `- Status: ${a.status || ''}`,
      cov ? `- Coverage:\n${cov}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const findingLines = findings.map((f, i) => [
    `#### Finding ${i + 1}`,
    `- Framework: ${f.framework || ''}`,
    `- Framework Version: ${f.frameworkVersion || ''}`,
    `- Control: ${f.controlId || f.control || ''}`,
    `- Finding: ${f.title || ''}`,
    `- Evidence: ${evidenceText(f.evidence) || 'n/a'}`,
    `- Remediation: ${f.remediation || 'n/a'}`,
    f.status ? `- Workflow: ${f.status}` : '',
    f.owner ? `- Owner: ${f.owner}` : '',
    f.resolution ? `- Resolution: ${f.resolution}` : '',
  ].filter(Boolean).join('\n')).join('\n\n') || '_No compliance findings._';

  const regressions = (input.regressions || []).map(r => `- ${r.message || r.framework}`).join('\n');

  return [
    '# Tyne Compliance Evidence Export',
    '',
    `- Commit Hash: ${input.commitHash || 'n/a'}`,
    `- Timestamp: ${ts}`,
    `- Repository: ${input.repositoryName || 'n/a'}`,
    `- Branch: ${input.branchName || 'n/a'}`,
    `- Report ID: ${input.reportId || 'n/a'}`,
    '',
    '## Assessments',
    assessmentLines || '_None_',
    '',
    regressions ? `## Regressions\n${regressions}\n` : '',
    '## Findings',
    findingLines,
    '',
    '---',
    `> ${input.disclaimer || COMPLIANCE_DISCLAIMER}`,
    '',
  ].filter(Boolean).join('\n');
}

/** Print-ready HTML — use Print → Save as PDF. */
export function buildComplianceEvidencePdfHtml(input: ComplianceExportInput): string {
  const md = buildComplianceEvidenceMarkdown(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Tyne Compliance Evidence</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:800px;margin:32px auto;padding:0 16px;color:#111;line-height:1.45}
pre{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px}
@media print{body{margin:0}}
</style></head><body>
<h1>Tyne Compliance Evidence</h1>
<pre>${md}</pre>
<p><em>Use Print → Save as PDF for archival PDF output.</em></p>
</body></html>`;
}

export function buildComplianceExport(
  input: ComplianceExportInput,
  format: ComplianceExportFormat,
): { content: string; extension: string; mime: string } {
  if (format === 'json') {
    return { content: buildComplianceEvidenceJson(input), extension: 'json', mime: 'application/json' };
  }
  if (format === 'pdf') {
    return { content: buildComplianceEvidencePdfHtml(input), extension: 'html', mime: 'text/html' };
  }
  return { content: buildComplianceEvidenceMarkdown(input), extension: 'md', mime: 'text/markdown' };
}

export function buildComplianceExportFileName(format: ComplianceExportFormat, stamp = Date.now()): string {
  const ext = format === 'pdf' ? 'html' : format === 'json' ? 'json' : 'md';
  return `tyne-compliance-evidence-${stamp}.${ext}`;
}
