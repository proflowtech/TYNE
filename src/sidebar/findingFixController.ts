import * as vscode from 'vscode';
import * as path from 'path';
import type { SidebarHost } from './sidebarHost';
import { getGit } from '../gitManager';
import {
  buildAgentPrompt,
  classifyFindingAction,
  mayAutoApply,
  simpleContentHash,
  type AutoApplyPolicy,
} from '../actionEngine';
import { openFindingInEditor } from '../reviewDiagnosticsService';

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


type FindingFixHost = Pick<SidebarHost, 'context' | 'state' | 'postMessage' | 'actionLog'>;

export class FindingFixController {
  private readonly appliedFindingFixes = new Map<string, AppliedFindingFix>();
  private readonly appliedAudit: Array<Record<string, unknown>> = [];

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

  async agentFix(finding: Record<string, unknown>): Promise<void> {
    const classified = classifyFindingAction(finding);
    const prompt = classified.agentPrompt || buildAgentPrompt(finding);
    await vscode.env.clipboard.writeText(prompt);
    const file = String(finding.file || '');
    if (file) {
      await openFindingInEditor({
        file,
        line: typeof finding.line === 'number' ? finding.line : Number(finding.line) || undefined,
        endLine: typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || undefined,
      });
    }

    const handedOff = await this.handoffPromptToIdeAgent(prompt);
    this.logApplyAudit({
      event: 'agent_fix',
      findingId: String(finding.id || ''),
      reportId: String(finding.reportId || 'current'),
      file,
      actionClass: classified.actionClass,
      handedOff,
      at: new Date().toISOString(),
    });
    this.host.postMessage({
      type: 'agentFixDone',
      findingId: String(finding.id || ''),
      reportId: String(finding.reportId || 'current'),
      handedOff,
    });
    vscode.window.showInformationMessage(
      handedOff
        ? 'Fix in IDE: prompt opened in your agent chat. Review and send.'
        : 'Fix in IDE: prompt copied. Paste into Cursor / Claude / Codex / Copilot / Kimi chat.',
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

  async applyFix(finding: Record<string, unknown>): Promise<void> {
    const file = String(finding.file || '');
    const classified = classifyFindingAction(finding);
    const suggestedFix = String(classified.suggestedFix || '');
    const line = typeof finding.line === 'number' ? finding.line : Number(finding.line) || 0;
    const endLine = typeof finding.endLine === 'number' ? finding.endLine : Number(finding.endLine) || 0;
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
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No workspace' });
      return;
    }
    const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const plan = this.resolveFindingFixPlan(doc, line, endLine, suggestedFix);
      // Content-match gate: the code must still look like it did when the finding
      // was generated (codeSnippet is verbatim from the reviewed diff; evidence is
      // the legacy field) — otherwise applying would silently corrupt newer code.
      const snippet = String(finding.codeSnippet || '').trim();
      const evidence = String(finding.evidence || '').trim();
      const anchor = (snippet || evidence).split('\n')[0]?.trim() || '';
      if (anchor && plan.mode === 'replace' && !plan.originalText.includes(anchor.slice(0, Math.min(anchor.length, 120)))) {
        vscode.window.showWarningMessage('Current code no longer matches the reviewed code, so the patch was not applied. Re-run the review.');
        this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'code_changed_since_review' });
        return;
      }
      if (plan.originalText === plan.proposedText) {
        vscode.window.showInformationMessage('Suggested fix already matches the current code.');
        this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'No change' });
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
      if (applied) {
        const undoStart = plan.mode === 'insert' && insertText.startsWith('\n')
          ? new vscode.Position(plan.range.start.line, plan.range.start.character)
          : plan.range.start;
        const undoText = plan.mode === 'insert' ? insertText : plan.proposedText;
        const undoRange = new vscode.Range(undoStart, this.rangeEndFromText(undoStart, undoText));
        this.appliedFindingFixes.set(this.findingFixKey(finding), {
          file,
          range: undoRange,
          originalText: plan.mode === 'insert' ? '' : plan.originalText,
          expectedText: undoText,
        });
        // The edit only changes the in-memory buffer; git diff reads from disk,
        // so an unsaved fix would be invisible to the next validation run.
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
        await vscode.window.showTextDocument(doc, { selection: undoRange, preview: true });
        vscode.window.showInformationMessage(
          saved
            ? `Fix applied and saved to ${file}${restaged ? ' (re-staged)' : ''}. Review the change before committing.`
            : `Fix applied to ${file} but the file could not be saved — save it before re-validating.`,
        );
        this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: true });
      } else {
        vscode.window.showErrorMessage('Could not apply the fix.');
        this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: 'Edit rejected' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Apply fix failed: ${msg}`);
      this.host.postMessage({ type: 'fixApplied', findingId, reportId, success: false, error: msg });
    }
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
