import * as path from 'path';
import * as vscode from 'vscode';
import { TyneValidateReviewFinding, TyneValidateReviewResult, toDisplaySeverity } from './validateReviewTypes';

type ReviewActions = {
  apply(finding: TyneValidateReviewFinding): Promise<void>;
  dismiss(finding: TyneValidateReviewFinding): Promise<void>;
  suppress(finding: TyneValidateReviewFinding): Promise<void>;
};

let controller: vscode.CommentController | undefined;
let actions: ReviewActions | undefined;
let threads = new Map<string, vscode.CommentThread>();
let findings = new Map<string, TyneValidateReviewFinding>();
let findingsByThread = new WeakMap<vscode.CommentThread, TyneValidateReviewFinding>();

function categoryLabel(finding: TyneValidateReviewFinding): string {
  const rule = String(finding.ruleId || '').toUpperCase();
  if (/^QUALITY_(SEMANTIC_)?CLONE/.test(rule)) { return 'Duplicate Logic'; }
  if (rule === 'VIBE_HALLUCINATED_IMPORT') { return 'Hallucinated Call'; }
  if (finding.category === 'pm_alignment') { return 'Scope Gap'; }
  if (finding.category === 'security' || finding.category === 'compliance') { return 'Security Risk'; }
  if (finding.category === 'breaking_change') { return 'Breaking Change'; }
  if (finding.category === 'style') { return 'Style Nit'; }
  if (finding.category === 'maintainability' || finding.category === 'performance') { return 'Code Smell'; }
  return 'Logic Risk';
}

function severityGlyph(finding: TyneValidateReviewFinding): string {
  const severity = toDisplaySeverity(finding.severity, finding.category);
  if (severity === 'critical' || severity === 'major') { return '●'; }
  if (severity === 'minor') { return '▲'; }
  return '○';
}

function markdownFor(finding: TyneValidateReviewFinding): vscode.MarkdownString {
  const body = new vscode.MarkdownString();
  body.isTrusted = false;
  body.appendMarkdown(`**${categoryLabel(finding)} ${severityGlyph(finding)}**\n\n`);
  body.appendMarkdown(`**${finding.title}**\n\n`);
  if (finding.ruleId) { body.appendMarkdown(`Related rule: \`${finding.ruleId}\`\n\n`); }
  body.appendMarkdown(`${finding.explanation || finding.remediation || 'Review this change before merging.'}\n\n`);
  const evidence = finding.fix?.diff || finding.codeSnippet || finding.evidence;
  if (evidence) {
    const language = path.extname(finding.file || '').replace(/^\./, '') || 'text';
    body.appendCodeblock(String(evidence).slice(0, 1800), language);
  }
  return body;
}

function clearThreads(): void {
  for (const thread of threads.values()) { thread.dispose(); }
  threads = new Map();
  findings = new Map();
  findingsByThread = new WeakMap();
}

export function registerReviewCommentController(context: vscode.ExtensionContext, nextActions: ReviewActions): void {
  actions = nextActions;
  if (!controller) {
    controller = vscode.comments.createCommentController('tyne-review', 'Tyne Review');
    context.subscriptions.push(controller);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.reviewApplyFinding', async (thread: vscode.CommentThread) => {
      const finding = findingsByThread.get(thread);
      if (finding) { await actions?.apply(finding); }
    }),
    vscode.commands.registerCommand('tyne.reviewDismissFinding', async (thread: vscode.CommentThread) => {
      const finding = findingsByThread.get(thread);
      if (!finding) { return; }
      await actions?.dismiss(finding);
      thread.state = vscode.CommentThreadState.Resolved;
    }),
    vscode.commands.registerCommand('tyne.reviewSuppressFinding', async (thread: vscode.CommentThread) => {
      const finding = findingsByThread.get(thread);
      if (finding) { await actions?.suppress(finding); }
    }),
  );
}

export function publishReviewCommentThreads(result: TyneValidateReviewResult): void {
  if (!controller) { return; }
  clearThreads();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return; }
  for (const finding of result.findings || []) {
    if (!finding.id || !finding.file || String(finding.id).startsWith('throttled-')) { continue; }
    const start = Math.max(0, (finding.line || 1) - 1);
    const end = Math.max(start, (finding.endLine || finding.line || 1) - 1);
    const uri = vscode.Uri.file(path.join(folder.uri.fsPath, finding.file));
    const comment: vscode.Comment = {
      body: markdownFor(finding),
      mode: vscode.CommentMode.Preview,
      author: { name: 'Tyne' },
      contextValue: 'tyneReviewFinding',
    };
    const thread = controller.createCommentThread(uri, new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER), [comment]);
    thread.contextValue = 'tyneReviewFinding';
    thread.label = categoryLabel(finding);
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.state = vscode.CommentThreadState.Unresolved;
    threads.set(String(finding.id), thread);
    findings.set(String(finding.id), finding);
    findingsByThread.set(thread, finding);
  }
}

export function selectReviewCommentThread(findingId?: string): void {
  for (const [id, thread] of threads) {
    thread.collapsibleState = id === findingId
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
  }
}

export function clearReviewCommentThreads(): void {
  clearThreads();
}
