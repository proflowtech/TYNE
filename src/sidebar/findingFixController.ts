import * as vscode from 'vscode';
import * as path from 'path';
import type { SidebarHost } from './sidebarHost';
import { getGit } from '../gitManager';
import { parseNumstat } from '../numstat';
import {
  buildAgentPrompt,
  buildBatchAgentPrompt,
  classifyFindingAction,
  mayAutoApply,
  partitionFindingsByActionClass,
  simpleContentHash,
  type AutoApplyPolicy,
} from '../actionEngine';
import { openFindingInEditor } from '../reviewDiagnosticsService';
import { remapFindingsThroughDiff } from '../services/findingLineRemap';
import { buildTouchSnapshot, type TouchSnapshot } from '../services/scopeBlowout';

function statusPaths(files: Array<{ path?: string; from?: string }>): string[] {
  const out: string[] = [];
  for (const f of files || []) {
    if (f.path) { out.push(String(f.path).replace(/\\/g, '/')); }
    if (f.from) { out.push(String(f.from).replace(/\\/g, '/')); }
  }
  return out;
}
import { notifyWithActions } from '../notifyWithActions';
import { saveState } from '../stateManager';
import type { TyneValidateReviewFinding } from '../validateReviewTypes';


export interface AppliedFindingFix {
  file: string;
  range: vscode.Range;
  originalText: string;
  expectedText: string;
}

export interface FindingFixPlan {
  range: vscode.Range;
  originalText: string;
  proposedText: string;
  language: string;
  mode: 'replace' | 'insert';
}

export interface BatchApplyResult {
  findingId: string;
  success: boolean;
  error?: string;
}


type FindingFixHost = Pick<SidebarHost, 'context' | 'state' | 'postMessage' | 'actionLog'>;

export class FindingFixController {
  private readonly appliedFindingFixes = new Map<string, AppliedFindingFix>();
  private readonly appliedAudit: Array<Record<string, unknown>> = [];
  private lastAppliedFinding: Record<string, unknown> | null = null;

  constructor(private readonly host: FindingFixHost) {}

  autoApplyPolicy(): AutoApplyPolicy {
    const raw = vscode.workspace.getConfiguration('tyne').get<string>('actionEngine.autoApplyPolicy', 'applyable_only');
    return raw === 'never' ? 'never' : 'applyable_only';
  }

  logApplyAudit(entry: Record<string, unknown>): void {
    this.appliedAudit.push(entry);
    if (this.appliedAudit.length > 100) { this.appliedAudit.shift(); }
    this.host.actionLog.appendLine(JSON.stringify(entry));
    void this.host.context.globalState.update('tyne.applyAudit', this.appliedAudit.slice(-50));
  }

  /**
   * When the last review ran on staged changes, a fix written to the working
   * tree is invisible to the next `git diff --cached` — re-stage it so the
   * re-validation actually sees the fix.
   */
  async restageAfterFix(file: string): Promise<boolean> {
    if (this.host.state.validateReviewResult?.scope !== 'staged_changes') { return false; }
    const git = getGit();
    if (!git) { return false; }
    try {
      await git.add([file]);
      return true;
    } catch {
      vscode.window.showWarningMessage(
        `Fix saved, but ${file} could not be re-staged. Run "git add ${file}" before re-validating, or the review will see the old staged version.`,
      );
      return false;
    }
  }

  async capturePreFixSnapshot(findingFiles: string[]): Promise<TouchSnapshot | undefined> {
    const git = getGit();
    if (!git) { return undefined; }
    try {
      const status = await git.status();
      const numstatRaw = await git.raw(['diff', '--numstat']).catch(() => '');
      const entries = parseNumstat(numstatRaw);
      const paths = [
        ...statusPaths(status.files),
        ...entries.map(e => e.path),
      ];
      const snap = buildTouchSnapshot({
        paths,
        additionsDeletions: entries,
        findingFiles,
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
      await this.host.context.workspaceState.update('tyne.preFixTouchSnapshot', snap);
      return snap;
    } catch {
      return undefined;
    }
  }

  /** Remap finding lines through the current working-tree diff before the next Fix-in-IDE. */
  async remapFindingsAfterAgentDiff(): Promise<number> {
    const result = this.host.state.validateReviewResult;
    if (!result?.findings?.length) { return 0; }
    const git = getGit();
    if (!git) { return 0; }
    const diff = await git.diff().catch(() => '');
    if (!String(diff || '').trim()) { return 0; }
    const { findings, remappedCount } = remapFindingsThroughDiff(
      result.findings as TyneValidateReviewFinding[],
      diff,
    );
    if (!remappedCount) { return 0; }
    result.findings = findings.map((f) => {
      const classified = classifyFindingAction(f as unknown as Record<string, unknown>);
      const merged = { ...f, ...classified };
      return {
        ...merged,
        agentPrompt: buildAgentPrompt(merged as unknown as Record<string, unknown>),
      } as TyneValidateReviewFinding;
    });
    this.host.state.validateReviewResult = result;
    await saveState(this.host.context, this.host.state);
    this.host.postMessage({ type: 'validateReviewResult', result });
    return remappedCount;
  }

  resolveLiveFinding(finding: Record<string, unknown>): Record<string, unknown> {
    const report = this.host.state.validateReviewResult;
    const findingId = String(finding.id || '');
    const live = (report?.findings || []).find(f => String(f.id || '') === findingId);
    return (live || finding) as Record<string, unknown>;
  }

  async agentFix(finding: Record<string, unknown>): Promise<void> {
    await this.remapFindingsAfterAgentDiff();
    const target = this.resolveLiveFinding(finding);
    const findingId = String(target.id || finding.id || '');

    const related = [
      String(target.file || ''),
      ...((target.relatedLocations as Array<{ file?: string }> | undefined) || []).map(r => String(r.file || '')),
    ].filter(Boolean);
    await this.capturePreFixSnapshot(related);

    const classified = classifyFindingAction(target);
    const prompt = classified.agentPrompt || buildAgentPrompt(target);
    await vscode.env.clipboard.writeText(prompt);
    const file = String(target.file || '');
    if (file) {
      await openFindingInEditor({
        file,
        line: typeof target.line === 'number' ? target.line : Number(target.line) || undefined,
        endLine: typeof target.endLine === 'number' ? target.endLine : Number(target.endLine) || undefined,
      });
    }

    const handedOff = await this.handoffPromptToIdeAgent(prompt);
    this.logApplyAudit({
      event: 'agent_fix',
      findingId,
      reportId: String(target.reportId || finding.reportId || 'current'),
      file,
      actionClass: classified.actionClass,
      handedOff,
      at: new Date().toISOString(),
    });
    this.host.postMessage({
      type: 'agentFixDone',
      findingId,
      reportId: String(target.reportId || finding.reportId || 'current'),
      handedOff,
    });
    await notifyWithActions(
      handedOff
        ? 'Fix in IDE: prompt opened in your agent chat. Review and send.'
        : 'Fix in IDE: prompt copied. Paste into Cursor / Claude / Codex / Copilot / Kimi chat.',
      [
        { title: 'Remind me to re-run', command: 'tyne.scheduleValidateReminder' },
        { title: 'Re-run now', command: 'tyne.runValidateReview' },
      ],
    );
  }

  /** Agent/guidance findings that need an IDE agent (not one-click patches). */
  agentBatchTargets(findings: Array<Record<string, unknown>>): ReturnType<typeof partitionFindingsByActionClass>['agent'] {
    const { agent, guidance } = partitionFindingsByActionClass(findings);
    return [...agent, ...guidance];
  }

  /** One agent handoff for many findings (severity-ordered batch prompt). */
  async agentFixBatch(findings: Array<Record<string, unknown>>): Promise<void> {
    await this.remapFindingsAfterAgentDiff();
    const live = (findings || []).map(f => this.resolveLiveFinding(f));
    const targets = this.agentBatchTargets(live);
    const reportId = String(
      live[0]?.reportId || findings[0]?.reportId || this.host.state.validateReviewResult?.id || 'current',
    );
    if (!targets.length) {
      vscode.window.showWarningMessage('No agent-fix findings selected. Use Apply safe for one-click patches.');
      this.host.postMessage({
        type: 'agentFixBatchDone',
        reportId,
        findingIds: [],
        handedOff: false,
        error: 'No agent findings',
      });
      return;
    }

    const related = targets.flatMap(f => [
      String(f.file || ''),
      ...((f as { relatedLocations?: Array<{ file?: string }> }).relatedLocations || [])
        .map(r => String(r.file || '')),
    ]).filter(Boolean);
    await this.capturePreFixSnapshot(related);

    const prompt = buildBatchAgentPrompt(targets);
    await vscode.env.clipboard.writeText(prompt);
    const first = targets[0];
    const firstFile = String(first.file || '');
    if (firstFile) {
      await openFindingInEditor({
        file: firstFile,
        line: typeof first.line === 'number' ? first.line : undefined,
        endLine: typeof first.endLine === 'number' ? first.endLine : undefined,
      });
    }

    const handedOff = await this.handoffPromptToIdeAgent(prompt);
    const findingIds = targets.map(f => String(f.id || '')).filter(Boolean);
    this.logApplyAudit({
      event: 'agent_fix_batch',
      findingIds,
      count: findingIds.length,
      reportId,
      handedOff,
      at: new Date().toISOString(),
    });
    this.host.postMessage({
      type: 'agentFixBatchDone',
      reportId,
      findingIds,
      handedOff,
    });
    await notifyWithActions(
      handedOff
        ? `Fix in IDE: ${findingIds.length} finding(s) opened in your agent chat. Review and send.`
        : `Fix in IDE: prompt for ${findingIds.length} finding(s) copied. Paste into Cursor / Claude / Codex / Copilot / Kimi chat.`,
      [
        { title: 'Remind me to re-run', command: 'tyne.scheduleValidateReminder' },
        { title: 'Re-run now', command: 'tyne.runValidateReview' },
      ],
    );
  }

  /**
   * One shot: apply all selected safe patches (one confirm), then send the rest
   * to the IDE agent in a single prompt.
   */
  async fixSelectedBatch(findings: Array<Record<string, unknown>>): Promise<void> {
    const live = (findings || []).map(f => this.resolveLiveFinding(f));
    const reportId = String(
      live[0]?.reportId || findings[0]?.reportId || this.host.state.validateReviewResult?.id || 'current',
    );
    const { applyable } = partitionFindingsByActionClass(live);
    const patches = applyable.filter(f => mayAutoApply(f, this.autoApplyPolicy()));
    const agents = this.agentBatchTargets(live);

    if (!patches.length && !agents.length) {
      vscode.window.showWarningMessage('Nothing selected to fix.');
      this.host.postMessage({ type: 'fixSelectedBatchDone', reportId, applied: 0, agentIds: [] });
      return;
    }

    const files = [...new Set(patches.map(f => String(f.file || '')).filter(Boolean))];
    const parts = [
      patches.length ? `${patches.length} safe patch${patches.length === 1 ? '' : 'es'}` : '',
      agents.length ? `${agents.length} via agent` : '',
    ].filter(Boolean);
    const choice = await vscode.window.showInformationMessage(
      `Fix selected: ${parts.join(' + ')}${files.length ? ` (${files.length} file${files.length === 1 ? '' : 's'})` : ''}?`,
      { modal: true },
      'Fix selected',
    );
    if (choice !== 'Fix selected') {
      this.host.postMessage({ type: 'fixSelectedBatchDone', reportId, applied: 0, agentIds: [], cancelled: true });
      return;
    }

    const results: BatchApplyResult[] = [];
    for (const finding of patches) {
      results.push(await this.applyFixSilent({
        ...finding,
        reportId,
        suggestedFix: finding.suggestedFix,
      } as Record<string, unknown>));
    }
    const applied = results.filter(r => r.success).length;
    if (results.length) {
      this.host.postMessage({ type: 'fixBatchApplied', reportId, results });
    }

    if (agents.length) {
      // Skip the empty-selection path's warning; reuse agent handoff without a second confirm.
      await this.remapFindingsAfterAgentDiff();
      const targets = this.agentBatchTargets(
        agents.map(f => this.resolveLiveFinding({ id: String(f.id || ''), reportId })),
      );
      if (targets.length) {
        const related = targets.flatMap(f => [
          String(f.file || ''),
          ...((f as { relatedLocations?: Array<{ file?: string }> }).relatedLocations || [])
            .map(r => String(r.file || '')),
        ]).filter(Boolean);
        await this.capturePreFixSnapshot(related);
        const prompt = buildBatchAgentPrompt(targets);
        await vscode.env.clipboard.writeText(prompt);
        const first = targets[0];
        const firstFile = String(first.file || '');
        if (firstFile) {
          await openFindingInEditor({
            file: firstFile,
            line: typeof first.line === 'number' ? first.line : undefined,
            endLine: typeof first.endLine === 'number' ? first.endLine : undefined,
          });
        }
        const handedOff = await this.handoffPromptToIdeAgent(prompt);
        const findingIds = targets.map(f => String(f.id || '')).filter(Boolean);
        this.logApplyAudit({
          event: 'fix_selected_batch',
          reportId,
          applied,
          skipped: results.length - applied,
          agentIds: findingIds,
          handedOff,
          at: new Date().toISOString(),
        });
        this.host.postMessage({
          type: 'agentFixBatchDone',
          reportId,
          findingIds,
          handedOff,
        });
        this.host.postMessage({
          type: 'fixSelectedBatchDone',
          reportId,
          applied,
          agentIds: findingIds,
          handedOff,
        });
        await notifyWithActions(
          `Fixed ${applied} patch${applied === 1 ? '' : 'es'}; ${findingIds.length} finding(s) ${handedOff ? 'opened in agent chat' : 'copied for agent'}.`,
          [
            { title: 'Re-run review', command: 'tyne.runValidateReview' },
            { title: 'Remind me to re-run', command: 'tyne.scheduleValidateReminder' },
          ],
        );
        return;
      }
    }

    this.logApplyAudit({
      event: 'fix_selected_batch',
      reportId,
      applied,
      skipped: results.length - applied,
      agentIds: [],
      at: new Date().toISOString(),
    });
    this.host.postMessage({ type: 'fixSelectedBatchDone', reportId, applied, agentIds: [] });
    await notifyWithActions(
      applied
        ? `Applied ${applied} safe patch${applied === 1 ? '' : 'es'}. Review the diffs before committing.`
        : 'No patches applied.',
      applied
        ? [
            { title: 'Re-run review', command: 'tyne.runValidateReview' },
            { title: 'Undo', command: 'tyne.undoLastFindingFix' },
          ]
        : [],
    );
  }

  /** Best-effort open of the host IDE agent chat with the prompt ready. */
  async handoffPromptToIdeAgent(prompt: string): Promise<boolean> {
    const tryOpen = async (command: string, args?: unknown): Promise<boolean> => {
      try {
        await vscode.commands.executeCommand(command, ...(args === undefined ? [] : [args]));
        return true;
      } catch {
        return false;
      }
    };

    // VS Code Copilot Chat accepts a prompt argument.
    if (await tryOpen('workbench.action.chat.open', { query: prompt })) { return true; }
    if (await tryOpen('workbench.action.chat.open', prompt)) { return true; }

    // Cursor Composer / Agent: open chat then paste (no official prompt arg).
    const openedComposer =
      (await tryOpen('composer.newAgentChat')) ||
      (await tryOpen('composer.startComposerPrompt')) ||
      (await tryOpen('aichat.newchataction'));
    if (openedComposer) {
      await new Promise(resolve => setTimeout(resolve, 120));
      try {
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async previewFix(finding: Record<string, unknown>): Promise<void> {
    const file = String(finding.file || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const endLine = typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || 0;
    const classified = classifyFindingAction(finding);
    // Preview is read-only, so unlike apply it does not require the fix to be
    // auto-applyable — a low-confidence or security fix is still worth showing
    // side by side. Fall back to the added lines of a structured unified diff.
    const structured = finding.fix as { diff?: string } | undefined;
    const diffProposal = typeof structured?.diff === 'string'
      ? structured.diff
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1))
        .join('\n')
      : '';
    const suggestedFix = String(classified.suggestedFix || finding.suggestedFix || diffProposal || '');
    if (!file) {
      vscode.window.showWarningMessage('No file path associated with this finding.');
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      if (!suggestedFix.trim()) {
        const range = line > 0
          ? new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
          : new vscode.Range(0, 0, 0, 0);
        await vscode.window.showTextDocument(doc, { selection: range, preview: true });
        return;
      }

      const plan = this.resolveFindingFixPlan(doc, line, endLine, suggestedFix);
      const leftContent = plan.originalText.length ? plan.originalText : '// (empty — insert at this location)\n';
      const left = await vscode.workspace.openTextDocument({ content: leftContent, language: plan.language });
      const right = await vscode.workspace.openTextDocument({ content: plan.proposedText, language: plan.language });
      const label = `${path.basename(file)}${line > 0 ? ':' + line : ''} (proposed fix)`;
      await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, label);
      this.host.postMessage({
        type: 'fixPreviewOpened',
        findingId: String(finding.id || ''),
        reportId: String(finding.reportId || 'current'),
      });
    } catch {
      vscode.window.showErrorMessage(`Could not preview fix for ${file}.`);
    }
  }

  findingFixKey(finding: Record<string, unknown>): string {
    return `${String(finding.reportId || 'current')}:${String(finding.id || '')}`;
  }

  rangeEndFromText(start: vscode.Position, text: string): vscode.Position {
    const lines = text.split(/\r?\n/);
    if (lines.length === 1) {
      return new vscode.Position(start.line, start.character + lines[0].length);
    }
    return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
  }

  resolveFindingFixPlan(
    doc: vscode.TextDocument,
    line: number,
    endLine: number,
    suggestedFix: string,
  ): FindingFixPlan {
    const proposedText = suggestedFix.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const language = doc.languageId || 'plaintext';

    if (line <= 0 || doc.lineCount === 0) {
      const lastLine = Math.max(doc.lineCount - 1, 0);
      const insertPos = doc.lineCount === 0
        ? new vscode.Position(0, 0)
        : new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
      return {
        range: new vscode.Range(insertPos, insertPos),
        originalText: '',
        proposedText,
        language,
        mode: 'insert',
      };
    }

    const startLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
    let lastLine = startLine;
    if (endLine > line) {
      lastLine = Math.min(Math.max(endLine - 1, startLine), doc.lineCount - 1);
    }
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      doc.lineAt(lastLine).range.end,
    );
    return {
      range,
      originalText: doc.getText(range),
      proposedText,
      language,
      mode: 'replace',
    };
  }

  /**
   * Apply one patch without a confirm dialog. Used by single Fix (after modal)
   * and by Apply-safe batch.
   */
  async applyFixSilent(finding: Record<string, unknown>): Promise<BatchApplyResult> {
    const file = String(finding.file || '');
    const classified = classifyFindingAction(finding);
    const suggestedFix = String(classified.suggestedFix || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const endLine = typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || 0;
    const findingId = String(finding.id || '');
    const reportId = String(finding.reportId || 'current');

    if (!mayAutoApply({ ...finding, ...classified }, this.autoApplyPolicy())) {
      return { findingId, success: false, error: 'Not applyable' };
    }
    if (!file || !suggestedFix.trim()) {
      return { findingId, success: false, error: 'No file or fix' };
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return { findingId, success: false, error: 'No workspace' };
    }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const plan = this.resolveFindingFixPlan(doc, line, endLine, suggestedFix);
      const snippet = String(finding.codeSnippet || '').trim();
      const evidence = String(finding.evidence || '').trim();
      const anchor = (snippet || evidence).split('\n')[0]?.trim() || '';
      if (anchor && plan.mode === 'replace' && !plan.originalText.includes(anchor.slice(0, Math.min(anchor.length, 120)))) {
        return { findingId, success: false, error: 'code_changed_since_review' };
      }
      if (plan.originalText === plan.proposedText) {
        return { findingId, success: false, error: 'No change' };
      }

      await this.capturePreFixSnapshot([file]);

      const edit = new vscode.WorkspaceEdit();
      const insertText = plan.mode === 'insert' && plan.range.start.character > 0
        ? '\n' + plan.proposedText
        : plan.proposedText;
      if (plan.mode === 'insert') {
        edit.insert(fileUri, plan.range.start, insertText);
      } else {
        edit.replace(fileUri, plan.range, plan.proposedText);
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { findingId, success: false, error: 'Edit rejected' };
      }

      const undoStart = plan.mode === 'insert' && insertText.startsWith('\n')
        ? new vscode.Position(plan.range.start.line, plan.range.start.character)
        : plan.range.start;
      const undoText = plan.mode === 'insert' ? insertText : plan.proposedText;
      const undoRange = new vscode.Range(undoStart, this.rangeEndFromText(undoStart, undoText));
      this.appliedFindingFixes.set(this.findingFixKey({ ...finding, reportId }), {
        file,
        range: undoRange,
        originalText: plan.mode === 'insert' ? '' : plan.originalText,
        expectedText: undoText,
      });
      this.lastAppliedFinding = { ...finding, reportId, id: findingId };
      let saved = false;
      try { saved = await doc.save(); } catch { saved = false; }
      const restaged = saved ? await this.restageAfterFix(file) : false;
      this.logApplyAudit({
        event: 'apply_fix',
        findingId,
        reportId,
        file,
        actionClass: 'applyable',
        beforeHash: simpleContentHash(plan.originalText),
        afterHash: simpleContentHash(undoText),
        saved,
        restaged,
        at: new Date().toISOString(),
      });
      return { findingId, success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { findingId, success: false, error: msg };
    }
  }

  async applyFix(finding: Record<string, unknown>): Promise<void> {
    const file = String(finding.file || '');
    const classified = classifyFindingAction(finding);
    const suggestedFix = String(classified.suggestedFix || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const findingId = String(finding.id || '');
    const reportId = String(finding.reportId || 'current');
    if (!mayAutoApply({ ...finding, ...classified }, this.autoApplyPolicy())) {
      vscode.window.showWarningMessage('This finding is not a safe one-click patch. Use Agent Fix instead.');
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Not applyable' });
      return;
    }
    if (!file || !suggestedFix.trim()) {
      vscode.window.showWarningMessage('No file or suggested fix available for this finding.');
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No file or fix' });
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Apply suggested fix to ${file}${line > 0 ? ':' + line : ''}?`,
      { modal: true },
      'Apply',
      'Show Diff',
    );
    if (choice === 'Show Diff') {
      await this.previewFix({ ...finding, suggestedFix, actionClass: 'applyable' });
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Previewed' });
      return;
    }
    if (choice !== 'Apply') {
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Cancelled' });
      return;
    }

    const result = await this.applyFixSilent({ ...finding, ...classified, suggestedFix });
    if (result.success) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder && file) {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(wsFolder.uri, file));
          const key = this.findingFixKey({ ...finding, reportId });
          const applied = this.appliedFindingFixes.get(key);
          await vscode.window.showTextDocument(doc, {
            selection: applied?.range,
            preview: true,
          });
        } catch { /* ignore open failure */ }
      }
      await notifyWithActions(
        `Fix applied to ${file}. Review the change before committing.`,
        [
          { title: 'Re-run review', command: 'tyne.runValidateReview' },
          { title: 'Undo', command: 'tyne.undoLastFindingFix' },
        ],
      );
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: true });
      return;
    }

    if (result.error === 'code_changed_since_review') {
      await notifyWithActions(
        'Current code no longer matches the reviewed code, so the patch was not applied.',
        [{ title: 'Re-run review', command: 'tyne.runValidateReview' }],
        'warn',
      );
    } else if (result.error === 'No change') {
      vscode.window.showInformationMessage('Suggested fix already matches the current code.');
    } else if (result.error) {
      vscode.window.showErrorMessage(`Apply fix failed: ${result.error}`);
    }
    this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: result.error });
  }

  /** Apply all checked applyable patches with one confirm. */
  async applyFixesBatch(findings: Array<Record<string, unknown>>): Promise<void> {
    const live = (findings || []).map(f => this.resolveLiveFinding(f));
    const { applyable } = partitionFindingsByActionClass(live);
    const reportId = String(
      live[0]?.reportId || findings[0]?.reportId || this.host.state.validateReviewResult?.id || 'current',
    );
    const candidates = applyable.filter(f =>
      mayAutoApply(f, this.autoApplyPolicy()),
    );
    if (!candidates.length) {
      vscode.window.showWarningMessage('No safe one-click patches in the selection.');
      this.host.postMessage({
        type: 'fixBatchApplied',
        reportId,
        results: [],
        error: 'No applyable findings',
      });
      return;
    }

    const files = [...new Set(candidates.map(f => String(f.file || '')).filter(Boolean))];
    const choice = await vscode.window.showInformationMessage(
      `Apply ${candidates.length} safe patch${candidates.length === 1 ? '' : 'es'} across ${files.length} file${files.length === 1 ? '' : 's'}?`,
      { modal: true },
      'Apply',
    );
    if (choice !== 'Apply') {
      this.host.postMessage({
        type: 'fixBatchApplied',
        reportId,
        results: candidates.map(f => ({ findingId: String(f.id || ''), success: false, error: 'Cancelled' })),
      });
      return;
    }

    const results: BatchApplyResult[] = [];
    for (const finding of candidates) {
      const result = await this.applyFixSilent({
        ...finding,
        reportId,
        suggestedFix: finding.suggestedFix,
      } as Record<string, unknown>);
      results.push(result);
    }

    const applied = results.filter(r => r.success).length;
    const skipped = results.length - applied;
    this.logApplyAudit({
      event: 'apply_fix_batch',
      reportId,
      applied,
      skipped,
      results,
      at: new Date().toISOString(),
    });
    this.host.postMessage({ type: 'fixBatchApplied', reportId, results });
    await notifyWithActions(
      skipped
        ? `Applied ${applied} patch${applied === 1 ? '' : 'es'}; skipped ${skipped} (stale or unchanged).`
        : `Applied ${applied} safe patch${applied === 1 ? '' : 'es'}. Review the diffs before committing.`,
      applied
        ? [
            { title: 'Re-run review', command: 'tyne.runValidateReview' },
            { title: 'Undo', command: 'tyne.undoLastFindingFix' },
          ]
        : skipped
          ? [{ title: 'Re-run review', command: 'tyne.runValidateReview' }]
          : [],
    );
  }

  async undoLastAppliedFix(): Promise<void> {
    if (!this.lastAppliedFinding) {
      vscode.window.showWarningMessage('No applied fix was found to undo.');
      return;
    }
    await this.undoFix(this.lastAppliedFinding);
  }

  async undoFix(finding: Record<string, unknown>): Promise<void> {
    const findingId = String(finding.id || '');
    const reportId = String(finding.reportId || 'current');
    const key = this.findingFixKey(finding);
    const applied = this.appliedFindingFixes.get(key);
    if (!applied) {
      vscode.window.showWarningMessage('No applied fix was found to undo.');
      this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: false, canUndo: false, error: 'No applied fix' });
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: 'No workspace' });
      return;
    }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, applied.file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      if (doc.getText(applied.range) !== applied.expectedText) {
        this.appliedFindingFixes.delete(key);
        vscode.window.showWarningMessage('The file changed after this fix was applied, so undo was not performed.');
        this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: false, canUndo: false, error: 'Applied text changed' });
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, applied.range, applied.originalText);
      const undone = await vscode.workspace.applyEdit(edit);
      if (undone) {
        this.appliedFindingFixes.delete(key);
        // Mirror apply: persist the undo to disk and re-stage so the next
        // validation does not review the discarded fix.
        let saved = false;
        try { saved = await doc.save(); } catch { saved = false; }
        const restaged = saved ? await this.restageAfterFix(applied.file) : false;
        this.logApplyAudit({
          event: 'undo_fix',
          findingId,
          reportId,
          file: applied.file,
          saved,
          restaged,
          at: new Date().toISOString(),
        });
        vscode.window.showInformationMessage(`Fix undone in ${applied.file}.`);
        this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: true });
      } else {
        this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: 'Edit rejected' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Undo fix failed: ${msg}`);
      this.host.postMessage({ type: 'fixUndone', findingId, reportId, success: false, error: msg });
    }
  }

}
