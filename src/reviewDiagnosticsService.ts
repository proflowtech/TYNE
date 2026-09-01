import * as vscode from 'vscode';
import * as path from 'path';
import { TyneValidateReviewResult, TyneValidateReviewFinding, toDisplaySeverity } from './validateReviewTypes';
import { mayAutoApply, withClassifiedAction } from './actionEngine';
import { clearReviewCommentThreads } from './reviewCommentController';

// ── ReviewDiagnosticsService ─────────────────────────────────────────────────
// Surfaces Validate & Review findings as native VS Code diagnostics (squiggles)
// and offers quick-fix code actions for applyable patches only.

const DIAGNOSTIC_SOURCE = 'Tyne';

let collection: vscode.DiagnosticCollection | undefined;
let findingsByFile = new Map<string, TyneValidateReviewFinding[]>();

export function getReviewDiagnosticsCollection(): vscode.DiagnosticCollection {
  if (!collection) {
    collection = vscode.languages.createDiagnosticCollection('tyne-review');
  }
  return collection;
}

function severityToDiagnostic(severity: string, category?: string): vscode.DiagnosticSeverity {
  switch (toDisplaySeverity(severity, category)) {
    case 'critical':
      return vscode.DiagnosticSeverity.Error;
    case 'major':
      return vscode.DiagnosticSeverity.Warning;
    case 'minor':
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

export function publishReviewDiagnostics(result: TyneValidateReviewResult): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return; }

  const diagnostics = getReviewDiagnosticsCollection();
  diagnostics.clear();
  findingsByFile = new Map();

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const finding of result.findings || []) {
    // Synthetic throttle rows ("N more minor suggestions") have no real anchor.
    if (!finding.file || String(finding.id || '').startsWith('throttled-')) { continue; }
    const line = Math.max(0, (finding.line || 1) - 1);
    const endLine = Math.max(line, (finding.endLine || finding.line || 1) - 1);
    const startColumn = typeof finding.startColumn === 'number' && finding.startColumn >= 0 ? finding.startColumn : 0;
    const endColumn = typeof finding.endColumn === 'number' && finding.endColumn > startColumn
      ? finding.endColumn
      : Number.MAX_SAFE_INTEGER;
    const range = new vscode.Range(line, startColumn, endLine, endColumn);
    const diagnostic = new vscode.Diagnostic(
      range,
      `${finding.title}${finding.explanation ? ` — ${finding.explanation}` : ''}`,
      severityToDiagnostic(finding.severity, finding.category),
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = finding.ruleId || finding.category;

    // Hover shows the fix description and grouped occurrences, not just the title.
    const related: vscode.DiagnosticRelatedInformation[] = [];
    const fixDescription = finding.fix?.description
      || (finding.suggestedFix ? 'A drop-in replacement is available via quick fix.' : '');
    if (fixDescription) {
      related.push(new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(path.join(folder.uri.fsPath, finding.file)), range),
        `Suggested fix: ${fixDescription}`,
      ));
    }
    for (const loc of (finding.relatedLocations || []).slice(0, 6)) {
      if (!loc.file || !loc.startLine) { continue; }
      related.push(new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          vscode.Uri.file(path.join(folder.uri.fsPath, loc.file)),
          new vscode.Range(Math.max(0, loc.startLine - 1), 0, Math.max(0, (loc.endLine || loc.startLine) - 1), Number.MAX_SAFE_INTEGER),
        ),
        'Same issue also occurs here',
      ));
    }
    if (related.length) {
      diagnostic.relatedInformation = related;
    }

    const existing = byFile.get(finding.file) || [];
    existing.push(diagnostic);
    byFile.set(finding.file, existing);

    const classified = withClassifiedAction(finding) as TyneValidateReviewFinding;
    const found = findingsByFile.get(finding.file) || [];
    found.push(classified);
    findingsByFile.set(finding.file, found);
  }

  for (const [relPath, diags] of byFile) {
    const uri = vscode.Uri.file(path.join(folder.uri.fsPath, relPath));
    diagnostics.set(uri, diags);
  }
}

export function clearReviewDiagnostics(): void {
  getReviewDiagnosticsCollection().clear();
  findingsByFile = new Map();
  clearReviewCommentThreads();
}

export async function openFindingInEditor(finding: { file?: string; line?: number; endLine?: number }): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !finding.file) { return; }
  const uri = vscode.Uri.file(path.join(folder.uri.fsPath, finding.file));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    const line = Math.max(0, Math.min(doc.lineCount - 1, (finding.line || 1) - 1));
    const range = doc.lineAt(line).range;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch {
    vscode.window.showWarningMessage(`Tyne: could not open ${finding.file}.`);
  }
}

// ── Quick-fix code actions ───────────────────────────────────────────────────

class TyneReviewCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const tyneDiagnostics = context.diagnostics.filter(d => d.source === DIAGNOSTIC_SOURCE);
    if (!tyneDiagnostics.length) { return []; }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return []; }
    const relPath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    const findings = findingsByFile.get(relPath) || [];

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of tyneDiagnostics) {
      const finding = findings.find(f =>
        (f.line || 1) - 1 === diagnostic.range.start.line && mayAutoApply(f),
      );
      if (!finding || !finding.suggestedFix || finding.actionClass !== 'applyable') { continue; }
      const action = new vscode.CodeAction(
        `Tyne: ${finding.fix?.description || `apply suggested fix — ${finding.title}`}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = finding.fix?.applyConfidence === 'high';
      const edit = new vscode.WorkspaceEdit();
      const startLine = Math.max(0, (finding.line || 1) - 1);
      const endLine = Math.max(startLine, (finding.endLine || finding.line || 1) - 1);
      const replaceRange = new vscode.Range(
        startLine, 0,
        endLine, document.lineAt(Math.min(endLine, document.lineCount - 1)).range.end.character,
      );
      edit.replace(document.uri, replaceRange, finding.suggestedFix.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
      action.edit = edit;
      actions.push(action);
    }
    return actions;
  }
}

export function registerReviewDiagnostics(context: vscode.ExtensionContext): void {
  context.subscriptions.push(getReviewDiagnosticsCollection());
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new TyneReviewCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.clearReviewDiagnostics', () => {
      clearReviewDiagnostics();
    }),
  );
}
