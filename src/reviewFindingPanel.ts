import * as path from 'path';
import * as vscode from 'vscode';
import { toDisplaySeverity } from './validateReviewTypes';

/**
 * A full editor-tab detail view for a single review finding.
 *
 * The sidebar drawer is fine for a glance, but a finding often carries a real
 * diff and a paragraph of reasoning that deserve the editor's width. This
 * opens a WebviewPanel (a proper tab, beside the code) with the finding's
 * explanation, evidence, and every action — Fix in IDE, Apply Fix (only when
 * safely applyable), Dismiss, Suppress for team, Open in editor.
 *
 * A single panel is reused: opening another finding re-renders it in place
 * rather than spawning tabs. Actions are injected so this module stays
 * decoupled from the fix/feedback controllers.
 */

export interface ReviewFindingActions {
  apply(finding: Record<string, unknown>): Promise<void> | void;
  agentFix(finding: Record<string, unknown>): Promise<void> | void;
  dismiss(finding: Record<string, unknown>): Promise<void> | void;
  suppress(finding: Record<string, unknown>): Promise<void> | void;
  reveal(finding: Record<string, unknown>): Promise<void> | void;
}

let panel: vscode.WebviewPanel | undefined;
let current: Record<string, unknown> | undefined;

function categoryLabel(f: Record<string, unknown>): string {
  const rule = String(f.ruleId || '').toUpperCase();
  if (/^QUALITY_(SEMANTIC_)?CLONE/.test(rule)) { return 'Duplicate Logic'; }
  if (rule === 'VIBE_HALLUCINATED_IMPORT') { return 'Hallucinated Call'; }
  const category = String(f.category || '');
  if (category === 'pm_alignment') { return 'Scope Gap'; }
  if (category === 'security' || category === 'compliance') { return 'Security Risk'; }
  if (category === 'breaking_change') { return 'Breaking Change'; }
  if (category === 'style') { return 'Style Nit'; }
  if (category === 'maintainability' || category === 'performance') { return 'Code Smell'; }
  return 'Logic Risk';
}

function severityTone(f: Record<string, unknown>): { tone: string; glyph: string; label: string } {
  const s = toDisplaySeverity(f.severity, f.category as string | undefined);
  if (s === 'critical' || s === 'major') { return { tone: 'major', glyph: '●', label: 'Major' }; }
  if (s === 'minor') { return { tone: 'minor', glyph: '▲', label: 'Minor' }; }
  return { tone: 'nit', glyph: '○', label: 'Nit' };
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function evidenceOf(f: Record<string, unknown>): string {
  const fix = f.fix as { diff?: string } | undefined;
  return String(fix?.diff || f.codeSnippet || f.evidence || '');
}

function isApplyable(f: Record<string, unknown>): boolean {
  return f.actionClass === 'applyable' && Boolean(String(f.suggestedFix || '').trim());
}

function isSyntheticFile(f: Record<string, unknown>): boolean {
  const file = String(f.file || '');
  return !file || file.charAt(0) === '(';
}

function renderHtml(webview: vscode.Webview, f: Record<string, unknown>, nonce: string): string {
  const sev = severityTone(f);
  const loc = f.file
    ? `${esc(f.file)}${f.line ? ':' + esc(f.line) : ''}`
    : '';
  const evidence = evidenceOf(f);
  const lang = path.extname(String(f.file || '')).replace(/^\./, '') || '';
  const houseRule = f.houseRule as { text?: string; source?: string } | undefined;

  const primary = isApplyable(f)
    ? '<button class="act primary" data-cmd="apply">Apply fix</button>'
    : '<button class="act primary" data-cmd="agentFix">Fix in IDE</button>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 20px 24px 28px;
    font-family: var(--vscode-font-family); font-size: 13px;
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    line-height: 1.55;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  .cat {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .sev.major { color: var(--vscode-editorError-foreground, #e5534b); }
  .sev.minor { color: var(--vscode-editorWarning-foreground, #d0872a); }
  .sev.nit { color: var(--vscode-descriptionForeground); }
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; margin: 10px 0 6px; line-height: 1.25; }
  .loc { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
  .explain { font-size: 13px; margin: 0 0 16px; }
  .house {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    border-left: 2px solid var(--vscode-textLink-foreground); padding: 4px 10px; margin: 0 0 16px;
  }
  pre {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1));
    border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25));
    border-radius: 4px; padding: 12px 14px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; margin: 0 0 18px;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); }
  .act { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; font-size: 13px; color: var(--vscode-descriptionForeground); }
  .act:hover { color: var(--vscode-foreground); text-decoration: underline; }
  .act.primary { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style></head>
<body><div class="wrap">
  <div class="cat">${esc(categoryLabel(f))} <span class="sev ${sev.tone}" title="${esc(sev.label)}">${sev.glyph}</span></div>
  <h1>${esc(f.title || 'Finding')}</h1>
  ${loc ? `<div class="loc">${loc}</div>` : ''}
  <p class="explain">${esc(f.explanation || f.remediation || f.evidence || 'No explanation was returned for this finding.')}</p>
  ${houseRule ? `<div class="house">Team rule: “${esc(houseRule.text || '')}”${houseRule.source ? ' · ' + esc(houseRule.source) : ''}</div>` : ''}
  ${evidence ? `<pre><code class="language-${esc(lang)}">${esc(evidence.slice(0, 4000))}</code></pre>` : ''}
  <div class="actions">
    ${primary}
    <button class="act" data-cmd="dismiss">Dismiss</button>
    <button class="act" data-cmd="suppress">Suppress for team</button>
    ${isSyntheticFile(f) ? '' : '<button class="act" data-cmd="reveal">Open in editor</button>'}
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () { vscode.postMessage({ command: b.dataset.cmd }); });
  });
</script></body></html>`;
}

function nonceStr(): string {
  let out = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}

export function openReviewFindingPanel(
  context: vscode.ExtensionContext,
  finding: Record<string, unknown>,
  actions: ReviewFindingActions,
): void {
  current = finding;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'tyneReviewFinding',
      'Tyne Finding',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => { panel = undefined; current = undefined; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (msg: { command?: string }) => {
      if (!current) { return; }
      const f = current;
      switch (msg.command) {
        case 'apply': await actions.apply(f); break;
        case 'agentFix': await actions.agentFix(f); break;
        case 'dismiss': await actions.dismiss(f); break;
        case 'suppress': await actions.suppress(f); break;
        case 'reveal': await actions.reveal(f); break;
      }
    }, null, context.subscriptions);
  }
  panel.title = `Finding: ${String(finding.title || 'Finding').slice(0, 40)}`;
  panel.webview.html = renderHtml(panel.webview, finding, nonceStr());
  panel.reveal(vscode.ViewColumn.Beside, false);
}

export function disposeReviewFindingPanel(): void {
  panel?.dispose();
  panel = undefined;
  current = undefined;
}
