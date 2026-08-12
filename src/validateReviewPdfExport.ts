/**
 * Print-ready Validate & Review PDF (HTML → browser Print → Save as PDF).
 * Design system matched to Tyne Validate Review Report (JetBrains Mono / #0A0E1A / #0025CC).
 * # ponytail: no PDF library; styled HTML is enough and ships offline.
 */
import type { TyneValidateReviewResult } from './validateReviewTypes';
import { COMPLIANCE_DISCLAIMER, complianceStatusLabel } from './validateReviewTypes';
import { TYNE_LOGO_WORDMARK_DATA_URI } from './tyneLogoDataUri';

export interface ValidateReviewPdfMeta {
  generatedBy?: string;
  generatedByEmail?: string;
  generatedAt?: string;
  workspacePath?: string;
  requestedBy?: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function goalTitle(goal: string | { title?: string }): string {
  return typeof goal === 'string' ? goal : String(goal?.title || '');
}

function fmtPct(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return `${Math.round(v * 10) / 10}%`;
}

function fmtDateUtc(iso?: string): string {
  try {
    const d = new Date(iso || Date.now());
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    }).replace(',', '') + ' UTC';
  } catch {
    return iso || new Date().toISOString();
  }
}

function shortSha(sha?: string): string {
  const s = String(sha || '').trim();
  return s ? s.slice(0, 10) : '—';
}

function titleCase(s: string): string {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || '—';
}

function verdictLabel(status: string, overall?: string): string {
  const raw = String(overall || status || '').toLowerCase();
  if (raw === 'approve_with_suggestions') return 'Approved · Suggestions';
  if (raw === 'passed' || raw === 'pass' || raw === 'approve' || raw === 'approved') return 'Approved';
  if (raw === 'blocked' || raw === 'failed' || raw === 'block') return 'Blocked';
  if (raw === 'changes_requested' || raw === 'needs_work') return 'Requires Remediation';
  if (raw === 'context_limited') return 'Context Limited';
  return titleCase(raw);
}

function verdictColor(status: string, overall?: string): string {
  const raw = String(overall || status || '').toLowerCase();
  if (raw === 'passed' || raw === 'pass' || raw === 'approve' || raw === 'approved' || raw === 'approve_with_suggestions') return '#0F6E5C';
  if (raw === 'blocked' || raw === 'failed' || raw === 'block') return '#9B2226';
  return '#95610A';
}

function statusColor(status: string): string {
  const s = String(status || '').toLowerCase();
  if (s === 'good' || s === 'pass' || s === 'passed' || s === 'ok') return '#0F6E5C';
  if (s === 'bad' || s === 'fail' || s === 'failed' || s === 'blocked') return '#9B2226';
  if (s === 'warn' || s === 'warning' || s === 'needs_work') return '#95610A';
  return '#5B6472';
}

function severityColor(sev: string): string {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'high') return '#9B2226';
  if (s === 'medium') return '#95610A';
  return '#5B6472';
}

function scopeLabel(scope: string): string {
  const s = String(scope || '').toLowerCase();
  if (s === 'last_commit' || s === 'last commit') return 'Last commit';
  if (s === 'staged_changes' || s === 'staged') return 'Staged changes';
  if (s === 'unstaged_changes' || s === 'unstaged') return 'Unstaged changes';
  if (s === 'selected_commit' || s === 'selected commit') return 'Selected commit';
  if (s === 'working_tree' || s === 'uncommitted') return 'Working tree';
  if (s === 'branch_diff' || s === 'branch') return 'Branch diff';
  return titleCase(scope);
}

function barRow(label: string, score: number, emphasize = false, warn = false): string {
  const w = Math.max(0, Math.min(100, Math.round(score)));
  const fill = warn || (emphasize && w < 80) ? '#95610A' : '#0025CC';
  return `<tr>
    <td${emphasize ? ' style="font-weight:600"' : ''}>${esc(label)}</td>
    <td><div class="barTrack"><div class="barFill" style="width:${w}%;background:${fill}"></div></div></td>
    <td class="mono" style="text-align:right;font-weight:${emphasize ? '700' : '600'}">${w}</td>
  </tr>`;
}

function emptyOrList(items: string[], empty: string): string {
  if (!items.length) return `<p style="color:#5B6472;font-size:13.5px">${esc(empty)}</p>`;
  return `<ul style="margin:0;padding-left:18px;font-size:13.5px">${items.map(i =>
    `<li style="margin-bottom:6px">${esc(i)}</li>`).join('')}</ul>`;
}

export function buildValidateReviewPdfHtml(
  report: TyneValidateReviewResult,
  meta: ValidateReviewPdfMeta = {},
): string {
  const generatedAt = meta.generatedAt || report.createdAt || new Date().toISOString();
  const generatedBy = meta.generatedBy || 'Tyne user';
  const requestedBy = meta.requestedBy || generatedBy;
  const status = String(report.status || 'unknown');
  const overall = String(report.overallVerdict || '');
  // Prefer overallVerdict as the single ship signal; fall back to status.
  const verdict = verdictLabel(status, overall || undefined);
  const vColor = verdictColor(status, overall || undefined);
  const displayVerdict = overall
    ? verdictLabel('', overall)
    : verdictLabel(status);
  const scoreNum = typeof report.score === 'number' && Number.isFinite(report.score) ? Math.round(report.score) : null;
  const score = scoreNum == null ? '—' : String(scoreNum);
  const card = report.qualityScorecard || {} as NonNullable<TyneValidateReviewResult['qualityScorecard']>;
  const contributors = Array.isArray(report.contributionBreakdown) ? report.contributionBreakdown : [];
  const languages = Array.isArray(report.languageBreakdown) ? report.languageBreakdown : [];
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const missingTests = Array.isArray(report.missingTests) ? report.missingTests : [];
  const nextActions = Array.isArray(report.nextActions) ? report.nextActions : [];
  const changed = Array.isArray(report.visualDiff) ? report.visualDiff : [];
  const sections = Array.isArray(report.sectionScores) ? report.sectionScores : [];
  const completed = (report.completedGoals || []).map(goalTitle).filter(Boolean);
  const pending = (report.pendingGoals || []).map(g => typeof g === 'string' ? g : (g.title || '')).filter(Boolean);
  const concerns = Array.isArray(report.topConcerns) ? report.topConcerns : [];
  const humanAuthors = contributors.filter(c => c.kind === 'human');
  const aiAuthors = contributors.filter(c => c.kind === 'ai');
  const primaryAuthor = humanAuthors[0]?.label || contributors[0]?.label || 'Not attributed';
  const authorShare = humanAuthors[0]
    ? `${fmtPct(humanAuthors[0].percent)} authored`
    : contributors[0] ? `${fmtPct(contributors[0].percent)} of change` : 'share n/a';
  const aiAssist = aiAuthors.length
    ? aiAuthors.map(c => `${c.label} (${fmtPct(c.percent)})`).join(', ')
    : 'no AI assistance detected';
  const disclaimer = report.complianceDisclaimer || COMPLIANCE_DISCLAIMER;
  const complianceOn = report.complianceStatus && report.complianceStatus !== 'not_enabled';
  const highFindings = findings.filter(f => {
    const s = String(f.severity || '').toLowerCase();
    return s === 'high' || s === 'critical';
  }).length;
  const packStats = (report as { pipelineInfo?: { failedPacks?: number; reviewedPacks?: number; packs?: number } }).pipelineInfo
    || (report.modelInfo as { pipelineInfo?: { failedPacks?: number; reviewedPacks?: number; packs?: number } } | undefined)?.pipelineInfo;
  const failedPacks = Number(packStats?.failedPacks || 0);
  const reviewedPacks = Number(packStats?.reviewedPacks || 0);
  const totalPacks = Number(packStats?.packs || 0);
  const packCount = totalPacks > 0 ? totalPacks : Math.max(1, changed.length || 1);
  const fileCount = changed.length;
  const warningNotes = [
    ...(Array.isArray(report.reviewWarnings) ? report.reviewWarnings.map(w => w.message || w.type).filter(Boolean) : []),
    report.actualModeUsed && report.requestedMode && report.actualModeUsed !== report.requestedMode
      ? `Mode auto-downgraded to ${String(report.actualModeUsed).replace(/_/g, ' ')}`
      : '',
    failedPacks > 0 ? `${failedPacks} file pack(s) failed or timed out during review` : '',
    status === 'context_limited' ? 'Review coverage was incomplete (context limited)' : '',
  ].filter(Boolean) as string[];

  const qualityRows = [
    typeof (report.qualityScore ?? card.overall) === 'number'
      ? barRow('Overall code quality', Number(report.qualityScore ?? card.overall)) : '',
    typeof card.correctness === 'number' ? barRow('Correctness', card.correctness) : '',
    typeof card.maintainability === 'number' ? barRow('Maintainability', card.maintainability) : '',
    typeof card.architecture === 'number' ? barRow('Architecture', card.architecture) : '',
    typeof card.vibe === 'number' ? barRow('Vibe / AI-slop risk', card.vibe) : '',
    typeof report.score === 'number'
      ? barRow('Review score (composite)', report.score, true, report.score < 80) : '',
  ].filter(Boolean).join('') || `<tr><td colspan="3" style="color:#5B6472">No quality scorecard.</td></tr>`;

  const sectionRows = sections.map(s => {
    const st = titleCase(String(s.status || '—'));
    return `<tr>
      <td>${esc(s.title || s.id || 'Section')}</td>
      <td style="color:${statusColor(String(s.status || ''))};font-weight:600">${esc(st)}</td>
      <td class="mono" style="text-align:right">${typeof s.score === 'number' ? Math.round(s.score) : '—'}</td>
      <td style="color:#5B6472">${esc(s.summary || '')}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" style="color:#5B6472">No section scores.</td></tr>`;

  const contribRows = contributors.map(c => `<tr>
    <td>${esc(c.label)}</td>
    <td class="mono" style="text-align:right">${fmtPct(c.percent)}</td>
    <td style="text-align:right;color:#5B6472">${esc(titleCase(c.kind))}</td>
  </tr>`).join('') || `<tr><td colspan="3" style="color:#5B6472">No authorship signals.</td></tr>`;

  const langRows = languages.map(l => `<tr>
    <td>${esc(l.language)}</td>
    <td class="mono" style="text-align:right">${fmtPct(l.percent)}</td>
    <td class="mono" style="text-align:right;color:#5B6472">${esc(l.lines)}</td>
  </tr>`).join('') || `<tr><td colspan="3" style="color:#5B6472">No language mix recorded.</td></tr>`;

  const findingBlocks = findings.slice(0, 40).map((f, i) => {
    const sev = String(f.severity || 'medium');
    const n = String(i + 1).padStart(2, '0');
    const cat = [f.category, f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''].filter(Boolean).join(' · ');
    const body = f.explanation || f.evidence || '';
    const fix = f.remediation || f.suggestedFix || '';
    return `<div class="sec" style="border-top:1px solid #0A0E1A;padding-top:16px;margin-bottom:26px">
      <div style="display:flex;gap:16px;align-items:baseline">
        <div style="font-size:34px;color:#5B6472;line-height:1">${n}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <h3 style="font-size:15.5px;font-weight:600">${esc(f.title || 'Finding')}</h3>
            <span style="font-size:9.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${severityColor(sev)};border:1px solid ${severityColor(sev)};padding:2px 7px">${esc(sev)}</span>
          </div>
          ${cat ? `<div class="eyebrow" style="margin-bottom:8px">Category: ${esc(cat)}</div>` : ''}
          <p style="font-size:13.5px;color:#334155">${esc(body)}</p>
          ${fix ? `<div style="margin-top:10px;font-size:13px;color:#0F6E5C"><strong style="color:#0A0E1A;font-weight:600">Recommendation: </strong>${esc(fix)}</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') || `<p style="color:#5B6472;font-size:13.5px">No findings in this review.</p>`;

  const fileRows = changed.slice(0, 80).map(f => `<tr>
    <td class="mono">${esc(f.file || '')}</td>
    <td>${esc(titleCase(String(f.status || '')))}</td>
    <td class="mono" style="text-align:right">+${esc(f.additions ?? 0)}</td>
    <td class="mono" style="text-align:right">−${esc(f.deletions ?? 0)}</td>
  </tr>`).join('') || `<tr><td colspan="4" style="color:#5B6472">No changed files listed.</td></tr>`;

  const missingItems = missingTests.map(t => {
    const bits = [t.title, t.relatedFile ? `(${t.relatedFile})` : '', t.reason || ''].filter(Boolean);
    return bits.join(' — ');
  });
  const nextItems = nextActions.map(a => {
    const bits = [a.title, a.fileHint ? `(${a.fileHint})` : '', a.reason || ''].filter(Boolean);
    return bits.join(' — ');
  });

  const complianceRows = (report.complianceAssessments || []).map(a => `<tr>
    <td>${esc(a.name || a.framework || 'Framework')}</td>
    <td style="font-weight:600">${esc(titleCase(String(a.status || '—')))}</td>
    <td class="mono" style="text-align:right">${typeof a.score === 'number' ? Math.round(a.score) : '—'}</td>
    <td style="color:#5B6472">${esc(a.version ? `v${a.version}` : '')}</td>
  </tr>`).join('');

  const summaryText = report.walkthrough || report.summary || '';
  const concernNote = concerns.length
    ? concerns.map(c => esc(c)).join('; ')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tyne Validate &amp; Review — ${esc(report.issueIdentifier || report.repositoryName || report.id || 'Report')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; }
  .toolbar {
    display: flex; gap: 10px; justify-content: flex-end;
    padding: 16px 24px; background: #0A0E1A;
  }
  .toolbar button {
    border: 0; border-radius: 0; padding: 10px 16px; font: 600 12px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer;
  }
  .toolbar .primary { background: #0025CC; color: #fff; }
  .toolbar .secondary { background: transparent; color: #fff; border: 1px solid #5B6472; }
  .page { max-width: 820px; margin: 0 auto; padding: 0.85in 0.85in 1.1in; }
  .rpt { font-family: "JetBrains Mono", ui-monospace, monospace; color: #0A0E1A; font-size: 13.5px; line-height: 1.6; }
  .rpt h1, .rpt h2, .rpt h3 { font-family: "JetBrains Mono", monospace; font-weight: 600; margin: 0; }
  .mono { font-family: "JetBrains Mono", monospace; }
  .eyebrow {
    font-family: "JetBrains Mono", monospace; font-size: 10.5px; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: #5B6472;
  }
  .rpt table { width: 100%; border-collapse: collapse; }
  .rpt th {
    text-align: left; font-family: "JetBrains Mono", monospace; font-size: 10.5px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase; color: #5B6472; padding: 0 0 8px;
    border-bottom: 1px solid #0A0E1A;
  }
  .rpt td { padding: 12px 0; border-bottom: 1px solid #E1E4EB; vertical-align: top; font-size: 13.5px; }
  .rpt tr:last-child td { border-bottom: 1px solid #0A0E1A; }
  .sec { break-inside: avoid; }
  .barTrack { height: 4px; background: #E1E4EB; border-radius: 0; position: relative; }
  .barFill { height: 100%; background: #0025CC; }
  .doc-header, .doc-footer {
    display: flex; align-items: center; justify-content: space-between;
    font-family: "JetBrains Mono", monospace;
  }
  .doc-header {
    padding-bottom: 10px; border-bottom: 1px solid #0A0E1A; margin-bottom: 28px;
  }
  .doc-footer {
    padding-top: 8px; border-top: 1px solid #E1E4EB; margin-top: 36px;
    font-size: 9.5px; color: #5B6472; letter-spacing: 0.02em;
  }
  .legal {
    margin-top: 28px; padding: 14px 0 0; border-top: 1px solid #0A0E1A;
    font-size: 11px; line-height: 1.55; color: #5B6472;
  }
  .legal strong { color: #0A0E1A; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; font-size: 10.5px; }
  @media print {
    .toolbar { display: none !important; }
    .page { max-width: none; padding: 0; }
    a { color: inherit; text-decoration: none; }
    body { background: #fff; }
  }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <button class="secondary" type="button" onclick="window.close()">Close</button>
    <button class="primary" type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="page">
    <div class="doc-header">
      <span style="font-size:11px;font-weight:600;letter-spacing:0.1em;color:#0A0E1A;text-transform:uppercase">Validate &amp; Review</span>
      <span style="font-size:10px;color:#5B6472;letter-spacing:0.04em">CONFIDENTIAL — INTERNAL USE ONLY</span>
    </div>

    <div class="rpt">
      <div class="sec" style="display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:6px">
        <div>
          <img src="${TYNE_LOGO_WORDMARK_DATA_URI}" alt="Tyne" style="height:30px;width:auto;display:block;margin-bottom:22px"/>
          <div class="eyebrow" style="margin-bottom:10px">Automated Code Validation &amp; Review</div>
          <h1 style="font-size:34px;letter-spacing:-0.01em;line-height:1.15">Validate &amp; Review Assessment</h1>
          <div style="margin-top:10px;font-size:15px;color:#5B6472">${esc(report.repositoryName || 'Repository')} · commit <span class="mono">${esc(shortSha(report.commitSha || report.headSha))}</span></div>
        </div>
        <div style="text-align:right;min-width:150px">
          <div class="eyebrow" style="text-align:right">Composite Score</div>
          <div style="font-size:64px;line-height:1;color:#0025CC;margin-top:6px;font-weight:700">${esc(score)}<span style="font-size:22px;color:#5B6472">/100</span></div>
          <div style="margin-top:8px;display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${vColor};border:1px solid ${vColor};padding:4px 10px">${esc(verdict)}</div>
        </div>
      </div>

      <table style="margin-top:26px;table-layout:fixed" class="sec">
        <tr>
          <td style="border-bottom:1px solid #0A0E1A;border-top:1px solid #0A0E1A;padding:12px 12px 12px 0;width:25%">
            <div class="eyebrow">Branch</div>
            <div class="mono" style="margin-top:4px;font-size:12px;word-break:break-word">${esc(report.branchName || '—')}</div>
          </td>
          <td style="border-bottom:1px solid #0A0E1A;border-top:1px solid #0A0E1A;padding:12px;width:25%">
            <div class="eyebrow">PM Reference</div>
            <div style="margin-top:4px;font-weight:600">${esc(report.issueIdentifier || report.issueId || '—')}</div>
            <div style="color:#5B6472;font-size:12.5px">${esc(report.issueTitle || '')}</div>
          </td>
          <td style="border-bottom:1px solid #0A0E1A;border-top:1px solid #0A0E1A;padding:12px;width:25%">
            <div class="eyebrow">Review Scope</div>
            <div style="margin-top:4px;font-weight:600">${esc(scopeLabel(String(report.scope || '')))}</div>
            <div style="color:#5B6472;font-size:12.5px">${esc(packCount)} file pack reviewed · ${esc(fileCount)} file${fileCount === 1 ? '' : 's'} changed</div>
          </td>
          <td style="border-bottom:1px solid #0A0E1A;border-top:1px solid #0A0E1A;padding:12px 0 12px 12px;width:25%">
            <div class="eyebrow">Risk Rating</div>
            <div style="margin-top:4px;font-weight:600;color:${statusColor(String(report.riskLevel || ''))}">${esc(titleCase(String(report.riskLevel || '—')))}</div>
            <div style="color:#5B6472;font-size:12.5px">Vibe-code risk: ${esc(String(report.vibeCodeRisk || '—'))}</div>
          </td>
        </tr>
      </table>

      <div class="sec" style="margin-top:36px">
        <div class="eyebrow" style="margin-bottom:12px">01 &nbsp;Executive Summary</div>
        <p style="font-size:15px;max-width:640px">${esc(summaryText)}</p>
        ${concernNote ? `<p style="font-size:15px;max-width:640px;margin-top:12px">Top concerns: ${concernNote}.</p>` : ''}
        <table style="margin-top:18px">
          <tr>
            <td style="width:33%;padding-left:0">
              <div class="eyebrow">Author</div>
              <div style="margin-top:4px;font-weight:600">${esc(primaryAuthor)}</div>
              <div style="color:#5B6472;font-size:12.5px">${esc(authorShare)} · ${esc(aiAssist)}</div>
            </td>
            <td style="width:33%">
              <div class="eyebrow">Reviewed By</div>
              <div style="margin-top:4px;font-weight:600">Tyne Validate &amp; Review</div>
              <div style="color:#5B6472;font-size:12.5px">Automated assessment pipeline</div>
            </td>
            <td style="width:33%;padding-right:0">
              <div class="eyebrow">Verdict</div>
              <div style="margin-top:4px;font-weight:600;color:${vColor}">${esc(displayVerdict)}</div>
              <div style="color:#5B6472;font-size:12.5px">${esc(findings.length)} finding${findings.length === 1 ? '' : 's'} outstanding${highFindings ? `, ${highFindings} high/critical` : ''}</div>
            </td>
          </tr>
        </table>
        ${warningNotes.length ? `<div style="margin-top:14px;padding:10px 12px;border:1px solid #95610A;color:#95610A;font-size:12.5px"><strong style="color:#0A0E1A">Review notes</strong> — ${esc(warningNotes.join(' · '))}</div>` : ''}
        ${failedPacks || reviewedPacks ? `<div style="margin-top:8px;font-size:12px;color:#5B6472">Coverage: ${esc(reviewedPacks)} reviewed / ${esc(packCount)} packs${failedPacks ? ` · ${esc(failedPacks)} failed` : ''}${report.actualModeUsed ? ` · mode ${esc(String(report.actualModeUsed).replace(/_/g, ' '))}` : ''}</div>` : ''}
      </div>

      <div class="sec" style="margin-top:34px">
        <div class="eyebrow" style="margin-bottom:12px">02 &nbsp;Assessment Scores</div>
        <table>
          <thead><tr><th>Dimension</th><th style="width:40%">Distribution</th><th style="text-align:right">Score</th></tr></thead>
          <tbody>${qualityRows}</tbody>
        </table>
        <div style="margin-top:6px;font-size:12px;color:#5B6472">Estimated remediation debt: ${typeof report.debtMinutes === 'number' ? `${esc(report.debtMinutes)} minutes` : 'n/a'}.</div>
      </div>

      <div class="sec" style="margin-top:34px">
        <div class="eyebrow" style="margin-bottom:12px">03 &nbsp;Section Scores</div>
        <table>
          <thead><tr><th>Section</th><th>Status</th><th style="text-align:right">Score</th><th style="width:40%">Summary</th></tr></thead>
          <tbody>${sectionRows}</tbody>
        </table>
      </div>

      <div class="sec" style="margin-top:34px;display:grid;grid-template-columns:1fr 1fr;gap:32px">
        <div>
          <div class="eyebrow" style="margin-bottom:12px">04 &nbsp;Authorship</div>
          <table>
            <thead><tr><th>Contributor</th><th style="text-align:right">Share</th><th style="text-align:right">Class</th></tr></thead>
            <tbody>${contribRows}</tbody>
          </table>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:12px">&nbsp;Languages</div>
          <table>
            <thead><tr><th>Language</th><th style="text-align:right">Share</th><th style="text-align:right">Lines</th></tr></thead>
            <tbody>${langRows}</tbody>
          </table>
        </div>
      </div>

      <div class="sec" style="margin-top:34px;display:grid;grid-template-columns:1fr 1fr;gap:32px">
        <div>
          <div class="eyebrow" style="margin-bottom:12px">05 &nbsp;Scope — Completed</div>
          ${emptyOrList(completed, 'No scope items were marked complete in this change.')}
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:12px">&nbsp;Scope — Pending</div>
          ${emptyOrList(pending, 'No pending scope items.')}
        </div>
      </div>

      <div class="sec" style="margin-top:36px;break-before:page">
        <div class="eyebrow" style="margin-bottom:16px">06 &nbsp;Findings (${esc(findings.length)})</div>
        ${findingBlocks}
      </div>

      <div class="sec" style="margin-top:36px;display:grid;grid-template-columns:1fr 1fr;gap:32px">
        <div>
          <div class="eyebrow" style="margin-bottom:12px">07 &nbsp;Missing Tests</div>
          ${emptyOrList(missingItems, 'No missing-test items were identified for this change.')}
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:12px">&nbsp;Next Actions</div>
          ${emptyOrList(nextItems, 'No further action items.')}
        </div>
      </div>

      <div class="sec" style="margin-top:34px">
        <div class="eyebrow" style="margin-bottom:12px">08 &nbsp;Changed Files (${esc(changed.length)})</div>
        <table>
          <thead><tr><th>Path</th><th>Status</th><th style="text-align:right">Added</th><th style="text-align:right">Removed</th></tr></thead>
          <tbody>${fileRows}</tbody>
        </table>
      </div>

      ${complianceOn || (report.complianceAssessments || []).length ? `
      <div class="sec" style="margin-top:34px">
        <div class="eyebrow" style="margin-bottom:12px">08b &nbsp;Compliance Assessments</div>
        <p style="font-size:12.5px;color:#5B6472;margin-bottom:10px">Status: <strong style="color:#0A0E1A">${esc(complianceStatusLabel(String(report.complianceStatus || '')))}</strong> — advisory only; not a certificate.</p>
        <table>
          <thead><tr><th>Framework</th><th>Status</th><th style="text-align:right">Score</th><th>Version</th></tr></thead>
          <tbody>${complianceRows || `<tr><td colspan="4" style="color:#5B6472">No framework assessments recorded.</td></tr>`}</tbody>
        </table>
      </div>` : ''}

      <div class="sec legal">
        <strong>Legal disclaimer — not a certificate</strong>
        <p style="margin:10px 0 0">${esc(disclaimer)}</p>
      </div>

      <div class="sec" style="margin-top:40px;padding-top:16px;border-top:1px solid #0A0E1A;display:flex;justify-content:space-between;align-items:flex-end">
        <div>
          <img src="${TYNE_LOGO_WORDMARK_DATA_URI}" alt="Tyne" style="height:11px;width:auto;display:block;margin-bottom:10px"/>
          <div style="font-size:11.5px;color:#5B6472;max-width:420px">Generated by Tyne’s automated Validate &amp; Review pipeline. This document is confidential and intended solely for the recipient organization’s engineering and compliance stakeholders. Tyne output is suggestive only and is not a compliance certificate.</div>
        </div>
        <div style="text-align:right;font-size:11px;color:#5B6472">
          <div>Prepared for: ${esc(requestedBy)}</div>
          <div class="mono" style="margin-top:2px">${esc(shortSha(report.commitSha || report.headSha))}</div>
        </div>
      </div>
    </div>

    <div class="doc-footer">
      <span>Report ID: <span style="color:#0A0E1A">${esc(report.id || '—')}</span> · Author: <span style="color:#0A0E1A">${esc(primaryAuthor)}</span> · Requested by: <span style="color:#0A0E1A">${esc(requestedBy)}</span></span>
      <span>Generated ${esc(fmtDateUtc(generatedAt))} · Tyne Platform</span>
    </div>
  </div>
</body>
</html>`;
}

export function buildValidateReviewPdfFileName(stamp = Date.now()): string {
  return `tyne-validate-review-${stamp}.html`;
}
