/**
 * Balanced PM ship-comment harness: dual-audience (PM + tech lead) rewrite via
 * cheap Gemini flash on the edge, plus a compact HTML report appendix for paste.
 * Falls back to a deterministic template when the LLM is unavailable.
 *
 * Pure helpers stay vscode-free so node:test can import them.
 */

import type { ExtensionContext } from 'vscode';
import type { TyneValidationResult } from '../validationTypes';
import type { TyneValidateReviewResult } from '../validateReviewTypes';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const HTML_MARK_START = '--- HTML report ---';
const HTML_MARK_END = '--- end HTML report ---';
const SHIP_NARRATIVE_WORD_LIMIT = 220;
const HTML_APPENDIX_MAX_CHARS = 12_000;
const AI_PHRASE_RE = /\b(?:AI analysis|the AI found|the system determined|based on analysis|the model suggests|I analyzed)\b/gi;

function scrubNarrative(body: string, wordLimit = SHIP_NARRATIVE_WORD_LIMIT): string {
  const cleaned = body
    .replace(AI_PHRASE_RE, '')
    .split('\n')
    .map(line => line.replace(/\s{2,}/g, ' ').trimEnd())
    .filter(line => line.trim())
    .join('\n')
    .trim();
  const words = cleaned.split(/\s+/);
  return words.length <= wordLimit
    ? cleaned
    : `${words.slice(0, wordLimit - 1).join(' ')}…`;
}

export interface ShipCommentFacts {
  taskId: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  validationStatus: string;
  riskLevel: string;
  summary?: string;
  criteriaMet?: string[];
  criteriaNotMet?: Array<{ criterion: string; reason: string }>;
  missingRequirements?: string[];
  suggestions?: string[];
  codeQualityNotes?: string[];
  reviewScore?: number;
  reviewVerdict?: string;
  reviewStatus?: string;
  topFindings?: Array<{ title: string; severity?: string; category?: string }>;
}

export interface HumanizedShipParts {
  pmSummary: string;
  techLeadNotes: string[];
  statusLine: string;
  model?: string;
  source: 'llm' | 'template';
}

function escHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildShipCommentFacts(args: {
  taskId: string;
  taskTitle?: string;
  branchName?: string;
  commitHash?: string;
  commitUrl?: string;
  validationStatus: string;
  riskLevel: string;
  validationResult?: TyneValidationResult | null;
  reviewResult?: TyneValidateReviewResult | null;
}): ShipCommentFacts {
  const v = args.validationResult;
  const r = args.reviewResult;
  const findings = (r?.findings || [])
    .slice(0, 5)
    .map(f => ({
      title: String(f.title || '').trim(),
      severity: f.severity,
      category: f.category,
    }))
    .filter(f => f.title);

  return {
    taskId: args.taskId,
    taskTitle: args.taskTitle,
    branchName: args.branchName,
    commitHash: args.commitHash,
    commitUrl: args.commitUrl,
    validationStatus: args.validationStatus,
    riskLevel: args.riskLevel,
    summary: v?.summary || r?.summary,
    criteriaMet: v?.criteriaMet?.slice(0, 5),
    criteriaNotMet: v?.criteriaNotMet?.slice(0, 4),
    missingRequirements: v?.missingRequirements?.slice(0, 4),
    suggestions: v?.suggestions?.slice(0, 4),
    codeQualityNotes: v?.codeQualityNotes?.slice(0, 3),
    reviewScore: typeof r?.score === 'number' ? r.score : undefined,
    reviewVerdict: r?.overallVerdict,
    reviewStatus: r?.status,
    topFindings: findings.length ? findings : undefined,
  };
}

/** Deterministic dual-audience body when LLM is offline / fails. */
export function buildTemplateHumanizedParts(facts: ShipCommentFacts): HumanizedShipParts {
  const title = facts.taskTitle || facts.taskId;
  const outcome =
    facts.validationStatus === 'pass' ? 'validation passed'
      : facts.validationStatus === 'partial' ? 'validation needs a short follow-up'
        : facts.validationStatus === 'fail' ? 'validation found open issues'
          : 'work was shipped (validation not run)';

  const pmSummary = [
    `We finished “${title}” and ${outcome}.`,
    facts.summary ? String(facts.summary).replace(/\s+/g, ' ').trim().slice(0, 180) : '',
    facts.commitHash
      ? `Latest commit: ${facts.commitUrl || facts.commitHash}.`
      : '',
  ].filter(Boolean).join(' ');

  const techLeadNotes: string[] = [];
  if (facts.branchName) { techLeadNotes.push(`Branch: ${facts.branchName}`); }
  if (typeof facts.reviewScore === 'number') {
    techLeadNotes.push(`Review score ${facts.reviewScore}${facts.reviewVerdict ? ` (${facts.reviewVerdict})` : ''}`);
  }
  techLeadNotes.push(`Risk: ${facts.riskLevel || 'not assessed'}`);
  for (const item of facts.criteriaMet || []) {
    techLeadNotes.push(`Done: ${item}`);
    if (techLeadNotes.length >= 5) { break; }
  }
  for (const item of facts.criteriaNotMet || []) {
    techLeadNotes.push(`Open: ${item.criterion} — ${item.reason}`);
    if (techLeadNotes.length >= 6) { break; }
  }
  for (const f of facts.topFindings || []) {
    techLeadNotes.push(`Finding (${f.severity || 'note'}): ${f.title}`);
    if (techLeadNotes.length >= 7) { break; }
  }
  if (techLeadNotes.length < 3) {
    for (const s of facts.suggestions || []) {
      techLeadNotes.push(`Follow-up: ${s}`);
      if (techLeadNotes.length >= 4) { break; }
    }
  }

  const statusLine =
    facts.validationStatus === 'pass' ? 'Validation passed'
      : facts.validationStatus === 'partial' ? 'Shipped with follow-ups'
        : facts.validationStatus === 'fail' ? 'Shipped — validation incomplete'
          : 'Shipped';

  return { pmSummary, techLeadNotes, statusLine, source: 'template' };
}

export function formatHumanizedNarrative(parts: HumanizedShipParts, facts: ShipCommentFacts): string {
  const lines: string[] = [
    `Status update — ${facts.taskTitle || facts.taskId}`,
    '',
    parts.statusLine || 'Update',
    '',
    'For PMs / stakeholders:',
    parts.pmSummary.trim(),
  ];
  if (parts.techLeadNotes.length) {
    lines.push('', 'For tech leads:');
    for (const note of parts.techLeadNotes) {
      lines.push(`- ${note}`);
    }
  }
  if (facts.commitHash) {
    lines.push('', `Commit: ${facts.commitUrl || facts.commitHash}`);
  }
  if (facts.branchName) {
    lines.push(`Branch: ${facts.branchName}`);
  }
  return scrubNarrative(lines.join('\n'));
}

/** Compact self-contained HTML report for pasting into Linear/Jira (code block). */
export function buildShipCommentHtmlReport(facts: ShipCommentFacts): string {
  const findings = (facts.topFindings || [])
    .map(f => `<li><strong>${escHtml(f.severity || 'note')}</strong> ${escHtml(f.title)}${f.category ? ` <em>(${escHtml(f.category)})</em>` : ''}</li>`)
    .join('');
  const met = (facts.criteriaMet || []).map(c => `<li>${escHtml(c)}</li>`).join('');
  const open = [
    ...(facts.criteriaNotMet || []).map(c => `${c.criterion}: ${c.reason}`),
    ...(facts.missingRequirements || []),
    ...(facts.suggestions || []),
  ].slice(0, 6).map(c => `<li>${escHtml(c)}</li>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Tyne ship report — ${escHtml(facts.taskId)}</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;color:#0A0E1A;max-width:720px;margin:24px auto;padding:0 16px;line-height:1.45}
h1{font-size:1.25rem;margin:0 0 8px}h2{font-size:1rem;margin:20px 0 8px;color:#0025CC}
.meta{color:#445;font-size:.9rem}.badge{display:inline-block;padding:2px 8px;border-radius:4px;background:#EEF1FF;color:#0025CC;font-size:.8rem}
ul{padding-left:1.2rem}code{background:#F4F6FA;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>Tyne ship report</h1>
<p class="meta"><span class="badge">${escHtml(facts.validationStatus)}</span>
 ${escHtml(facts.taskTitle || facts.taskId)} · risk ${escHtml(facts.riskLevel)}
${typeof facts.reviewScore === 'number' ? ` · review ${escHtml(facts.reviewScore)}${facts.reviewVerdict ? ` (${escHtml(facts.reviewVerdict)})` : ''}` : ''}</p>
${facts.summary ? `<h2>Summary</h2><p>${escHtml(facts.summary)}</p>` : ''}
${facts.branchName || facts.commitHash ? `<h2>Change</h2><p>${facts.branchName ? `Branch <code>${escHtml(facts.branchName)}</code><br>` : ''}${facts.commitHash ? `Commit ${facts.commitUrl ? `<a href="${escHtml(facts.commitUrl)}">${escHtml(facts.commitHash)}</a>` : `<code>${escHtml(facts.commitHash)}</code>`}` : ''}</p>` : ''}
${met ? `<h2>Completed</h2><ul>${met}</ul>` : ''}
${open ? `<h2>Open / follow-ups</h2><ul>${open}</ul>` : ''}
${findings ? `<h2>Top findings</h2><ul>${findings}</ul>` : ''}
<p class="meta">Generated by Tyne · paste-friendly HTML report</p>
</body></html>`;

  return html.length > HTML_APPENDIX_MAX_CHARS
    ? html.slice(0, HTML_APPENDIX_MAX_CHARS - 20) + '\n<!-- truncated -->'
    : html;
}

export function composeShipCommentBody(narrative: string, htmlReport: string): string {
  const html = String(htmlReport || '').trim();
  if (!html) { return narrative.trim(); }
  return `${narrative.trim()}\n\n${HTML_MARK_START}\n\`\`\`html\n${html}\n\`\`\`\n${HTML_MARK_END}`;
}

export function splitShipCommentHtmlAppendix(body: string): { narrative: string; html: string } {
  const start = body.indexOf(HTML_MARK_START);
  const end = body.indexOf(HTML_MARK_END);
  if (start < 0 || end < 0 || end <= start) {
    return { narrative: body, html: '' };
  }
  const narrative = body.slice(0, start).trim();
  let html = body.slice(start + HTML_MARK_START.length, end).trim();
  html = html.replace(/^```html\s*/i, '').replace(/```$/i, '').trim();
  return { narrative, html };
}

async function callShipCommentEdge(
  context: ExtensionContext,
  facts: ShipCommentFacts,
  tier: string,
): Promise<HumanizedShipParts | null> {
  // Lazy-load vscode-only deps so pure helpers stay testable under node:test.
  const vscode = await import('vscode');
  const { getEffectiveAuthToken } = await import('../deviceAuth');
  const token = await getEffectiveAuthToken(context);
  if (!token) { return null; }
  const base = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  try {
    const res = await fetch(`${base}/functions/v1/pm-ship-comment`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ facts, tier }),
      signal: controller.signal,
    });
    if (!res.ok) { return null; }
    const data = await res.json() as {
      pmSummary?: string;
      techLeadNotes?: string[];
      statusLine?: string;
      model?: string;
    };
    if (!data.pmSummary?.trim()) { return null; }
    return {
      pmSummary: data.pmSummary.trim(),
      techLeadNotes: Array.isArray(data.techLeadNotes) ? data.techLeadNotes.map(String).filter(Boolean).slice(0, 6) : [],
      statusLine: String(data.statusLine || '').trim(),
      model: data.model,
      source: 'llm',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the full ship comment: humanoid dual-audience narrative + HTML report appendix.
 */
export async function buildBalancedShipComment(args: {
  context: ExtensionContext;
  facts: ShipCommentFacts;
  tier?: string;
}): Promise<{ body: string; parts: HumanizedShipParts; htmlReport: string }> {
  const llm = await callShipCommentEdge(args.context, args.facts, args.tier || 'free');
  const parts = llm || buildTemplateHumanizedParts(args.facts);
  const narrative = formatHumanizedNarrative(parts, args.facts);
  const htmlReport = buildShipCommentHtmlReport(args.facts);
  return {
    body: composeShipCommentBody(narrative, htmlReport),
    parts,
    htmlReport,
  };
}

export const SHIP_COMMENT_HTML_MARKERS = { start: HTML_MARK_START, end: HTML_MARK_END } as const;
