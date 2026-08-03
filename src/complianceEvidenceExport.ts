/**
 * Compliance evidence export for Validate & Review (MD / JSON / print-ready PDF HTML).
 * # ponytail: PDF is print-ready HTML (browser/IDE Print → PDF); no PDF dependency.
 */
import { COMPLIANCE_DISCLAIMER } from './validateReviewTypes';
import { TYNE_LOGO_WORDMARK_DATA_URI } from './tyneLogoDataUri';

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
  const ts = input.timestamp || new Date().toISOString();
  const findings = allFindings(input);
  const assessments = (input.assessments || []).map(a => {
    const cov = (a.coverage || []).map(c =>
      `<li>${escHtml(c.label || 'Coverage')}: ${c.status === 'not_reviewed' || c.percent == null ? 'Not Reviewed' : `${c.percent}%`}</li>`
    ).join('');
    return `<article class="card">
      <h3>${escHtml(a.name || a.framework || 'Framework')}</h3>
      <p class="muted">${escHtml(a.framework || '')}${a.version ? ` · v${escHtml(a.version)}` : ''}</p>
      <p><strong>Status:</strong> ${escHtml(a.status || '—')}${typeof a.score === 'number' ? ` · Score ${a.score}` : ''}</p>
      ${cov ? `<ul>${cov}</ul>` : ''}
    </article>`;
  }).join('') || '<p class="muted">No assessments.</p>';

  const findingCards = findings.map((f, i) => `<article class="card">
    <div class="row"><span class="pill">${escHtml(f.severity || 'info')}</span><strong>#${i + 1} ${escHtml(f.title || 'Finding')}</strong></div>
    <p class="muted">${escHtml(f.framework || '')}${f.controlId || f.control ? ` · ${escHtml(f.controlId || f.control || '')}` : ''}</p>
    <p><b>Evidence:</b> ${escHtml(evidenceText(f.evidence) || 'n/a')}</p>
    <p><b>Remediation:</b> ${escHtml(f.remediation || 'n/a')}</p>
  </article>`).join('') || '<p class="muted">No compliance findings.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Tyne Compliance Evidence</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box}body{margin:0;font:13.5px/1.6 "JetBrains Mono",monospace;color:#0A0E1A;background:#fff}
.page{max-width:820px;margin:0 auto;padding:0.85in}
.toolbar{display:flex;justify-content:flex-end;padding:16px 24px;background:#0A0E1A;margin:0 -0.85in 28px}
.toolbar button{border:0;padding:10px 16px;background:#0025CC;color:#fff;font:600 12px/1 "JetBrains Mono",monospace;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.eyebrow{font-size:10.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#5B6472}
h1{margin:10px 0 0;font-size:28px;font-weight:600;letter-spacing:-.01em}
.sub{margin:8px 0 0;color:#5B6472;font-size:13px}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin:24px 0;border-top:1px solid #0A0E1A;border-bottom:1px solid #0A0E1A}
.cell{padding:12px 12px 12px 0}.cell+.cell{padding-left:12px}
.k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#5B6472;font-weight:600}
.v{margin-top:4px;font-weight:600;word-break:break-word}
h2{margin:28px 0 12px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#5B6472}
.card{border-top:1px solid #0A0E1A;padding:14px 0;margin:0}
.muted{color:#5B6472}.pill{display:inline-block;padding:2px 7px;border:1px solid #9B2226;color:#9B2226;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-right:8px}
.row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.legal{margin-top:28px;padding-top:14px;border-top:1px solid #0A0E1A;color:#5B6472;font-size:11px;line-height:1.55}
.legal strong{display:block;color:#0A0E1A;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
@media print{.toolbar{display:none!important}.page{padding:0}}
@media(max-width:720px){.meta{grid-template-columns:1fr 1fr}}
</style></head><body>
<div class="page">
  <div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <img src="${TYNE_LOGO_WORDMARK_DATA_URI}" alt="Tyne" style="height:30px;width:auto;display:block;margin-bottom:18px"/>
  <div class="eyebrow">Compliance Evidence Export</div>
  <h1>Compliance Assessment Evidence</h1>
  <p class="sub">Automated advisory suggestions only · not a compliance certificate</p>
  <section class="meta">
    <div class="cell"><div class="k">Repository</div><div class="v">${escHtml(input.repositoryName || '—')}</div></div>
    <div class="cell"><div class="k">Branch</div><div class="v">${escHtml(input.branchName || '—')}</div></div>
    <div class="cell"><div class="k">Commit</div><div class="v"><code>${escHtml(input.commitHash || '—')}</code></div></div>
    <div class="cell"><div class="k">Exported</div><div class="v">${escHtml(ts)}</div></div>
  </section>
  <h2>01 &nbsp;Assessments</h2>${assessments}
  <h2>02 &nbsp;Findings</h2>${findingCards}
  <div class="legal"><strong>Legal disclaimer — not a certificate</strong>${escHtml(input.disclaimer || COMPLIANCE_DISCLAIMER)}</div>
</div>
</body></html>`;
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
