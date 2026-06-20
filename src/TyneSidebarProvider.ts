import * as vscode from 'vscode';
import { TyneState, getState, saveState, clearState } from './stateManager';
import { sanitizeBranchName, createBranch, saveStitch, hasStitch, undoStitch, tieTheKnot } from './gitManager';
import { createDraftPR } from './githubIntegration';
import { validateGoal, ValidationResponse } from './validator';

export class TyneSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _saveTimer?: ReturnType<typeof setTimeout>;
  private _state: TyneState;

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._state = getState(_context);
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._state = getState(this._context);

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._postState();
          break;
        case 'fieldChange':
          this._handleFieldChange(msg.field as string, msg.value as string);
          break;
        case 'subtaskAdd':
          this._handleSubtaskAdd(msg.text as string);
          break;
        case 'subtaskToggle':
          this._handleSubtaskToggle(msg.id as string);
          break;
        case 'subtaskDelete':
          this._handleSubtaskDelete(msg.id as string);
          break;
        case 'buttonClick':
          await this._handleButtonClick(msg.action as string);
          break;
        case 'openExternal':
          if (typeof msg.url === 'string') {
            vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._state = getState(this._context);
        this._postState();
      }
    });
  }

  private _postState(): void {
    this._view?.webview.postMessage({ type: 'stateLoaded', state: this._state });
  }

  private _handleFieldChange(field: string, value: string): void {
    (this._state as unknown as Record<string, unknown>)[field] = value;
    this._debouncedSave();
  }

  private _handleSubtaskAdd(text: string): void {
    if (!text.trim()) { return; }
    this._state.subtasks.push({ id: Date.now().toString(), text: text.trim(), done: false });
    this._debouncedSave();
    this._postState();
  }

  private _handleSubtaskToggle(id: string): void {
    const task = this._state.subtasks.find(t => t.id === id);
    if (task) {
      task.done = !task.done;
      this._debouncedSave();
      this._postState();
    }
  }

  private _handleSubtaskDelete(id: string): void {
    this._state.subtasks = this._state.subtasks.filter(t => t.id !== id);
    this._debouncedSave();
    this._postState();
  }

  private async _handleButtonClick(action: string): Promise<void> {
    switch (action) {
      case 'startThread':
        await this._startThread();
        break;
      case 'saveStitch':
        await this._saveStitch();
        break;
      case 'undoStitch':
        await this._undoStitch();
        break;
      case 'validateGoal':
        await this._validateGoal();
        break;
      case 'overrideProceed':
        await this._overrideProceed();
        break;
      case 'tieKnot':
        await this._tieTheKnot();
        break;
      default:
        vscode.window.showInformationMessage(`Tyne: ${action} coming soon`);
    }
  }

  private async _startThread(): Promise<void> {
    if (!this._state.appName || !this._state.goal) {
      vscode.window.showErrorMessage('App name and goal are required');
      return;
    }
    const branchName = sanitizeBranchName(this._state.taskId || 'task', this._state.goal);
    try {
      await createBranch(branchName);
      this._state.branchName = branchName;
      this._state.status = 'weaving';
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
      vscode.window.showInformationMessage('Thread started on branch: ' + branchName);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('Could not create branch: ' + message);
    }
  }

  private async _saveStitch(): Promise<void> {
    try {
      const hash = await saveStitch(this._state.taskId || 'task');
      this._state.stitchCount += 1;
      this._state.lastStitchTime = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({
        type: 'stitchSaved',
        hash,
        stitchCount: this._state.stitchCount,
        lastStitchTime: this._state.lastStitchTime,
      });
      this._view?.webview.postMessage({ type: 'hasStitch', value: true });
      vscode.window.showInformationMessage(`Stitch saved ✓ (${hash.slice(0, 7)})`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async _undoStitch(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      'Undo last stitch? All changes since the last stitch will be lost.',
      'Yes, undo',
      'Cancel',
    );
    if (pick !== 'Yes, undo') { return; }

    try {
      await undoStitch();
      this._state.stitchCount = Math.max(0, this._state.stitchCount - 1);
      await saveState(this._context, this._state);
      const stillHas = await hasStitch();
      this._view?.webview.postMessage({
        type: 'stitchUndone',
        stitchCount: this._state.stitchCount,
      });
      this._view?.webview.postMessage({ type: 'hasStitch', value: stillHas });
      vscode.window.showInformationMessage('Stitch undone. Rolled back to previous state.');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async _validateGoal(): Promise<void> {
    const apiKey = await this._context.secrets.get('tyne.byokApiKey');
    if (!apiKey) {
      const action = await vscode.window.showErrorMessage(
        'No API key set. Run "Tyne: Set API Key" to add your Claude or OpenAI key.',
        'Set API Key',
      );
      if (action === 'Set API Key') {
        await vscode.commands.executeCommand('tyne.setBYOKKey');
      }
      return;
    }

    const provider = vscode.workspace.getConfiguration('tyne')
      .get<'claude' | 'openai'>('byokProvider', 'claude');

    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Validating goal...',
        cancellable: false,
      }, () => validateGoal(this._state.goal, this._state.subtasks, apiKey, provider));

      this._state.validationResult = result;
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({ type: 'validationComplete', result });

      if (result.overall === 'pass') {
        vscode.window.showInformationMessage('Validation passed ✓ Tie the Knot is now unlocked.');
      } else {
        vscode.window.showWarningMessage(`Validation ${result.overall}: ${result.summary}`);
      }
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        'Validation failed: ' + (err instanceof Error ? err.message : String(err))
      );
    }
  }

  private async _overrideProceed(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      'Override validation? Tie the Knot will proceed even though validation did not fully pass.',
      'Yes, override',
      'Cancel',
    );
    if (pick !== 'Yes, override') { return; }
    this._state.validationOverride = true;
    await saveState(this._context, this._state);
    this._view?.webview.postMessage({ type: 'tieKnotUnlocked' });
  }

  private async _tieTheKnot(): Promise<void> {
    if (!this._state.validationResult && !this._state.validationOverride) {
      vscode.window.showErrorMessage('Validate your goal first, or use Override.');
      return;
    }

    const pick = await vscode.window.showWarningMessage(
      `Tie the knot on "${this._state.goal}"? This will commit and push.`,
      'Yes, ship it',
      'Cancel',
    );
    if (pick !== 'Yes, ship it') { return; }

    try {
      const threadState = {
        goal: this._state.goal,
        taskId: this._state.taskId,
        subtasks: [...this._state.subtasks],
        branchName: this._state.branchName,
      };
      const { branch, pushed } = await tieTheKnot(this._state.taskId, this._state.goal);
      await clearState(this._context);
      this._state = getState(this._context);
      this._view?.webview.postMessage({ type: 'stateCleared' });

      if (pushed) {
        vscode.window.showInformationMessage(`Thread complete! Branch ${branch} pushed. ✓`);
        this._maybeCreateDraftPR({ ...threadState, branchName: branch });
      } else {
        vscode.window.showInformationMessage(
          `Thread committed locally. Add a remote to push: git remote add origin <url>`,
        );
      }
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async _maybeCreateDraftPR(thread: {
    goal: string;
    taskId: string;
    subtasks: TyneState['subtasks'];
    branchName: string;
  }): Promise<void> {
    const githubToken = await this._context.secrets.get('tyne.githubToken');
    const licenseKey = await this._context.secrets.get('tyne.licenseKey');

    if (!githubToken || !licenseKey) { return; }

    createDraftPR(githubToken, thread.goal, thread.taskId, thread.subtasks, thread.branchName)
      .then(pr => {
        if (!pr) { return; }

        this._view?.webview.postMessage({
          type: 'prCreated',
          url: pr.url,
          number: pr.number,
          title: pr.title,
        });

        vscode.window.showInformationMessage(
          `Draft PR created: ${pr.title}`,
          'View PR',
        ).then(choice => {
          if (choice === 'View PR') {
            vscode.env.openExternal(vscode.Uri.parse(pr.url));
          }
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(`PR creation failed (thread still closed): ${message}`);
      });
  }

  private _debouncedSave(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); }
    this._saveTimer = setTimeout(() => {
      saveState(this._context, this._state);
    }, 500);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'tyne.svg'),
    );
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return getPremiumSidebarHtml(csp, nonce, logoUri.toString());
  }
}

function getPremiumSidebarHtml(csp: string, nonce: string, logoUri: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tyne</title>
  <style>
    :root {
      --bg: #030303;
      --panel: #080808;
      --panel-2: #0e0e0e;
      --line: #1d1d1d;
      --blue: #2458ff;
      --blue-soft: #101a45;
      --lime: #9cff1a;
      --lime-soft: #17230b;
      --warn: #d8b14a;
      --danger: #ff596d;
      --text: #f4f4f4;
      --muted: #8f8f8f;
      --faint: #5a5a5a;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-width: 0;
      padding: 8px;
      color: var(--text);
      background: var(--vscode-sideBar-background, var(--bg));
      font-family: "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.45;
    }

    button, input { font: inherit; }
    button { color: inherit; border-radius: 0; }

    #app {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      max-width: 100%;
    }

    .deck, .panel, .stitch-counter, .boot { border: 0; }

    .deck {
      position: relative;
      overflow: hidden;
      padding: 10px;
      background: #050505;
    }

    .deck::before {
      content: none;
    }

    .deck::after {
      content: none;
    }

    .deck > * { position: relative; }

    .topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      min-width: 0;
      margin-bottom: 12px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }

    .icon-btn {
      width: 26px;
      height: 26px;
      border: 0;
      background: #111;
      color: var(--muted);
      cursor: pointer;
      font-weight: 900;
    }

    .icon-btn:hover,
    .icon-btn.active {
      background: var(--blue);
      color: var(--text);
    }

    .logo-mark {
      width: 42px;
      height: 42px;
      object-fit: contain;
      display: block;
      background: transparent;
    }

    .title-stack { min-width: 0; }

    .eyebrow, .section-title, label {
      color: var(--muted);
      font-size: 9px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .subtitle {
      max-width: 176px;
      overflow: hidden;
      color: var(--faint);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-pill {
      flex: 0 0 auto;
      border: 0;
      background: #111;
      color: var(--muted);
      padding: 4px 7px;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .status-pill.ready {
      background: var(--lime);
      color: #050505;
    }

    .status-pill.weaving {
      background: #17230b;
      color: var(--lime);
    }

    .status-pill.validated {
      background: var(--blue);
      color: #fff;
    }

    .rail-wrap {
      border: 0;
      background: #000;
      padding: 7px 0;
      margin-bottom: 10px;
    }

    .rail {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 7px;
      min-width: 0;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .rail-line {
      min-width: 0;
      overflow: hidden;
      color: var(--blue);
      text-overflow: clip;
      white-space: nowrap;
    }

    .rail-state {
      flex: 0 0 auto;
      color: var(--lime);
      white-space: nowrap;
    }

    .weaving .rail-line,
    .ready .rail-line {
      animation: pixelStep 900ms steps(4, end) infinite;
    }

    .mode-standby .rail-line {
      color: var(--muted);
      animation: standbyPulse 1.8s steps(3, end) infinite;
    }

    .mode-stitch .rail-line {
      color: var(--lime);
      animation: stitchPop 520ms steps(5, end) infinite;
    }

    .mode-validate .rail-line {
      color: var(--warn);
      animation: validateSweep 700ms steps(6, end) infinite;
    }

    .mode-launch .rail-line {
      color: var(--lime);
      animation: rocketJitter 420ms steps(4, end) infinite;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .metric {
      min-width: 0;
      border: 0;
      background: transparent;
      padding: 0;
    }

    .metric-label {
      margin-bottom: 2px;
      color: var(--faint);
      font-size: 8px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .metric-value {
      overflow: hidden;
      color: var(--text);
      font-size: 12px;
      font-weight: 900;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .metric-value.accent { color: var(--lime); }

    .panel {
      padding: 6px 0;
      background: transparent;
    }

    .screen {
      display: none;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .screen.active {
      display: flex;
    }

    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      margin-bottom: 7px;
    }

    .section-head::after {
      content: none;
    }

    .mission-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(74px, 0.42fr);
      gap: 7px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .field.full { grid-column: 1 / -1; }

    input[type="text"] {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 0;
      border-radius: 2px;
      outline: none;
      background: #111;
      color: var(--text);
      padding: 8px 9px;
    }

    input[type="text"]::placeholder { color: #575757; }

    input[type="text"]:focus {
      background: #151515;
    }

    .task-id-input {
      color: var(--lime) !important;
      font-weight: 900;
      letter-spacing: 0.04em;
    }

    .progress-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 8px;
    }

    .progress-line {
      overflow: hidden;
      color: var(--blue);
      font-size: 11px;
      letter-spacing: 0.02em;
      text-overflow: clip;
      white-space: nowrap;
    }

    .progress-count {
      color: var(--text);
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
    }

    .progress-note {
      grid-column: 1 / -1;
      margin-top: 2px;
      color: var(--muted);
      font-size: 10px;
    }

    .subtask-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 22px;
    }

    .empty-state {
      border: 0;
      background: #111;
      color: var(--faint);
      padding: 8px;
      font-size: 10px;
    }

    .subtask-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 7px;
      min-width: 0;
      border: 0;
      border-radius: 2px;
      background: #111;
      padding: 7px;
    }

    .subtask-toggle {
      min-width: 26px;
      border: 0;
      background: transparent;
      color: var(--faint);
      cursor: pointer;
      font-weight: 900;
      text-align: left;
    }

    .subtask-toggle.done { color: var(--lime); }

    .subtask-text {
      min-width: 0;
      color: var(--text);
      word-break: break-word;
    }

    .subtask-text.done {
      color: var(--faint);
      text-decoration: line-through;
      text-decoration-color: #314b1b;
    }

    .del-btn {
      width: 22px;
      height: 22px;
      border: 0;
      background: transparent;
      color: var(--faint);
      cursor: pointer;
      opacity: 0.72;
    }

    .del-btn:hover {
      background: #251014;
      color: var(--danger);
      opacity: 1;
    }

    .add-subtask {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 36px;
      gap: 6px;
      margin-top: 7px;
    }

    .btn-plus {
      min-height: 34px;
      border: 0;
      background: var(--blue);
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      font-weight: 900;
    }

    .btn-plus:hover {
      background: var(--blue);
      color: #fff;
    }

    .command-stack {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .action-btn {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-width: 0;
      min-height: 40px;
      border: 0;
      background: #111;
      color: var(--faint);
      padding: 8px;
      text-align: left;
      cursor: default;
      opacity: 0.72;
      pointer-events: none;
    }

    .action-btn.enabled {
      background: var(--blue);
      color: var(--text);
      cursor: pointer;
      opacity: 1;
      pointer-events: all;
    }

    .action-btn.enabled:hover {
      background: var(--blue);
    }

    .action-btn.primary.enabled {
      background: var(--lime);
      color: #061004;
    }

    .cmd-num {
      font-weight: 900;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }

    .cmd-title {
      min-width: 0;
      overflow: hidden;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .cmd-meta {
      color: currentColor;
      font-size: 10px;
      opacity: 0.68;
      white-space: nowrap;
    }

    .branch-label {
      display: none;
      margin: -1px 0 2px 7px;
      color: #9fb4ff;
      padding-left: 0;
      font-size: 10px;
      word-break: break-all;
    }

    .stitch-counter {
      display: none;
      background: #111;
      color: var(--muted);
      padding: 7px;
      font-size: 10px;
    }

    .validation-panel {
      display: none;
      background: transparent;
    }

    .settings-panel {
      padding: 6px 0;
    }

    .settings-back {
      border: 0;
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font-weight: 900;
      letter-spacing: 0.16em;
      text-align: left;
      text-transform: uppercase;
    }

    .settings-card {
      background: #111;
      padding: 10px;
    }

    .license-key {
      margin-top: 7px;
      color: var(--text);
      font-weight: 900;
      word-break: break-all;
    }

    .license-status {
      margin-top: 3px;
      color: var(--lime);
      font-weight: 900;
    }

    .usage-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 9px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .usage-bar {
      height: 4px;
      margin: 7px 0 6px;
      background: #050505;
    }

    .usage-fill {
      width: 24%;
      height: 100%;
      background: var(--blue);
    }

    .source-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }

    .source-tile {
      position: relative;
      display: flex;
      min-height: 56px;
      align-items: center;
      justify-content: center;
      background: #111;
      color: var(--muted);
      font-weight: 900;
    }

    .source-tile.active {
      background: #071039;
      color: var(--text);
    }

    .source-dot {
      position: absolute;
      right: 7px;
      top: 7px;
      width: 5px;
      height: 5px;
      background: var(--lime);
      border-radius: 50%;
    }

    .settings-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 9px 0;
    }

    .settings-row + .settings-row {
      border-top: 1px solid #171717;
    }

    .setting-title {
      color: var(--text);
      font-weight: 900;
    }

    .setting-subtitle {
      color: var(--faint);
      font-size: 10px;
    }

    .on-dot {
      color: var(--lime);
      font-size: 10px;
      font-weight: 900;
      white-space: nowrap;
    }

    .toggle {
      width: 34px;
      height: 18px;
      padding: 2px;
      background: #263f08;
    }

    .toggle::after {
      content: "";
      display: block;
      width: 14px;
      height: 14px;
      margin-left: auto;
      background: var(--lime);
      border-radius: 50%;
    }

    .signout-btn {
      width: 100%;
      min-height: 36px;
      border: 0;
      background: #111;
      color: var(--muted);
      cursor: pointer;
    }

    .pr-panel {
      display: none;
      background: #111;
      color: var(--text);
      padding: 8px;
      font-size: 10px;
    }

    .pr-panel.visible {
      display: block;
    }

    .pr-line {
      display: flex;
      gap: 6px;
      align-items: baseline;
      min-width: 0;
      padding: 2px 0;
    }

    .pr-mark {
      color: var(--lime);
      font-weight: 900;
      flex: 0 0 auto;
    }

    .pr-link {
      color: #9fb4ff;
      cursor: pointer;
      text-decoration: none;
    }

    .pr-link:hover {
      color: var(--text);
    }

    .val-summary {
      margin-bottom: 7px;
      color: var(--muted);
      font-size: 10px;
    }

    .val-result-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: 7px;
      min-width: 0;
      padding: 4px 0;
    }

    .val-icon {
      min-width: 12px;
      font-weight: 900;
    }

    .val-icon.pass { color: var(--lime); }
    .val-icon.fail { color: var(--danger); }
    .val-icon.warn { color: var(--warn); }

    .val-text {
      min-width: 0;
      word-break: break-word;
    }

    .val-reason {
      display: block;
      margin-top: 1px;
      color: var(--muted);
      font-size: 10px;
    }

    .validation-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      margin-top: 9px;
    }

    .val-btn {
      min-width: 0;
      min-height: 32px;
      overflow: hidden;
      border: 0;
      background: #111;
      color: var(--text);
      cursor: pointer;
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .val-btn:hover {
      background: var(--blue);
    }

    .boot {
      background: #111;
      color: var(--muted);
      padding: 8px;
      font-size: 10px;
    }

    .boot-line {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .boot-line span:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .boot-line span:last-child {
      color: var(--lime);
      white-space: nowrap;
    }

    .caret {
      color: var(--lime);
      animation: blink 1s steps(2, start) infinite;
    }

    @keyframes blink {
      0%, 45% { opacity: 1; }
      46%, 100% { opacity: 0.2; }
    }

    @keyframes pixelStep {
      0% { transform: translateX(0); }
      25% { transform: translateX(2px); }
      50% { transform: translateX(4px); }
      75% { transform: translateX(6px); }
      100% { transform: translateX(0); }
    }

    @keyframes standbyPulse {
      0%, 100% { opacity: 0.52; }
      50% { opacity: 0.92; }
    }

    @keyframes stitchPop {
      0% { transform: translateY(0); }
      40% { transform: translateY(-1px); }
      100% { transform: translateY(0); }
    }

    @keyframes validateSweep {
      0% { transform: translateX(-2px); opacity: 0.62; }
      50% { transform: translateX(3px); opacity: 1; }
      100% { transform: translateX(-2px); opacity: 0.62; }
    }

    @keyframes rocketJitter {
      0% { transform: translateX(0); }
      25% { transform: translateX(3px); }
      50% { transform: translateX(1px); }
      75% { transform: translateX(5px); }
      100% { transform: translateX(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
    }

    @media (max-width: 265px) {
      body { padding: 7px; }
      .deck, .panel { padding: 8px; }
      .mission-grid, .metrics, .validation-actions, .source-grid { grid-template-columns: 1fr; }
      .subtitle { display: none; }
      .action-btn { grid-template-columns: auto minmax(0, 1fr); }
      .cmd-meta { grid-column: 2; }
    }
  </style>
</head>
<body>
<div id="app">
  <section class="deck">
    <div class="topline">
      <div class="brand">
        <img class="logo-mark" src="${logoUri}" alt="Tyne" />
        <div class="title-stack">
          <div class="eyebrow" id="screenTitle">Goal Manager</div>
          <div class="subtitle" id="deckSubtitle">scope locked / drift watched</div>
        </div>
      </div>
      <div class="top-actions">
        <div id="statusPill" class="status-pill">INIT</div>
        <button class="icon-btn" id="settingsBtn" title="Settings">::</button>
      </div>
    </div>

    <div class="rail-wrap">
      <div class="rail">
        <span id="railLine" class="rail-line">TYNE ---- THREAD IDLE ---- READY</span>
        <span id="railState" class="rail-state">0 XP</span>
      </div>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="metric-label">Rank</div>
        <div id="rankValue" class="metric-value accent">INIT</div>
      </div>
      <div class="metric">
        <div class="metric-label">Stitches</div>
        <div id="stitchMetric" class="metric-value">0</div>
      </div>
      <div class="metric">
        <div class="metric-label">Ready</div>
        <div id="readyMetric" class="metric-value">0%</div>
      </div>
    </div>
  </section>

  <main id="mainView" class="screen active">
  <section class="panel">
    <div class="section-head"><span class="section-title">Mission Input</span></div>
    <div class="mission-grid">
      <div class="field">
        <label for="appName">App</label>
        <input type="text" id="appName" placeholder="Acme CRM" autocomplete="off" />
      </div>
      <div class="field">
        <label for="taskId">Task ID</label>
        <input type="text" id="taskId" class="task-id-input" placeholder="PRO-142" autocomplete="off" />
      </div>
      <div class="field full">
        <label for="goal">Goal</label>
        <input type="text" id="goal" placeholder="Describe the code outcome to defend" autocomplete="off" />
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="section-head"><span class="section-title">Subtasks</span></div>
    <div id="subtaskList" class="subtask-list"></div>
    <div class="add-subtask">
      <input type="text" id="newSubtask" placeholder="+ add mission checkpoint" autocomplete="off" />
      <button class="btn-plus" id="addSubtaskBtn" title="Add subtask">+</button>
    </div>
  </section>

  <section class="panel">
    <div class="section-head"><span class="section-title">Progress</span></div>
    <div class="progress-card">
      <div class="progress-line" id="progressLine">[----------------] 0/0</div>
      <div class="progress-count" id="progressCount">0%</div>
      <div class="progress-note" id="progressNote">No checkpoints loaded. Define the mission.</div>
    </div>
  </section>

  <section class="panel command-stack">
    <button class="action-btn" id="btn-startThread" data-action="startThread">
      <span class="cmd-num">1.</span><span class="cmd-title">Start Thread</span><span class="cmd-meta" id="meta-startThread">ready</span>
    </button>
    <div class="branch-label" id="branchLabel"></div>
    <button class="action-btn" id="btn-saveStitch" data-action="saveStitch">
      <span class="cmd-num">2.</span><span class="cmd-title">Save Stitch</span><span class="cmd-meta" id="meta-saveStitch">locked</span>
    </button>
    <button class="action-btn" id="btn-undoStitch" data-action="undoStitch">
      <span class="cmd-num">3.</span><span class="cmd-title">Undo Stitch</span><span class="cmd-meta" id="meta-undoStitch">locked</span>
    </button>
    <button class="action-btn" id="btn-validateGoal" data-action="validateGoal">
      <span class="cmd-num">4.</span><span class="cmd-title">Validate Goal</span><span class="cmd-meta" id="meta-validateGoal">locked</span>
    </button>
    <button class="action-btn primary" id="btn-tieKnot" data-action="tieKnot">
      <span class="cmd-num">5.</span><span class="cmd-title">Tie The Knot</span><span class="cmd-meta" id="meta-tieKnot">locked</span>
    </button>
  </section>

  <div class="stitch-counter" id="stitchCounter">
    STITCH LOG :: <span id="stitchCountVal">0</span> saved / last <span id="lastStitchVal">--:--</span>
  </div>

  <section class="panel validation-panel" id="validationPanel">
    <div class="section-head"><span class="section-title">Last Validation</span></div>
    <div id="validationResults"></div>
    <div class="validation-actions">
      <button class="val-btn" id="btn-revalidate">RE-VALIDATE</button>
      <button class="val-btn" id="btn-override">OVERRIDE</button>
    </div>
  </section>

  <section class="pr-panel" id="prPanel">
    <div class="pr-line"><span class="pr-mark">+</span><span>Thread complete</span></div>
    <div class="pr-line"><span class="pr-mark">+</span><span id="prSummary">Draft PR created</span></div>
    <div class="pr-line"><span>&gt;</span><a class="pr-link" id="prLink">View on GitHub</a></div>
  </section>

  <section class="boot" id="bootPanel">
    <div class="boot-line"><span id="bootSignal">tyne -- awaiting mission</span><span class="caret">&gt;</span></div>
  </section>
  </main>

  <main id="settingsView" class="screen">
    <section class="settings-panel">
      <button class="settings-back" id="backBtn">&lt; Settings</button>
    </section>

    <section class="settings-card">
      <div class="section-title">License</div>
      <div class="license-key">TYNE-9F2A-C71E-44BD-0E5A</div>
      <div class="license-status">+ active - Team tier</div>
    </section>

    <section class="settings-card">
      <div class="usage-row"><span>AI Calls / Month</span><span>resets Jul 1</span></div>
      <div class="usage-bar"><div class="usage-fill"></div></div>
      <div>47 / 200 (153 left)</div>
    </section>

    <section class="settings-panel">
      <div class="section-head"><span class="section-title">Task Source</span></div>
      <div class="source-grid">
        <div class="source-tile">Jira</div>
        <div class="source-tile">monday.com</div>
        <div class="source-tile">ClickUp</div>
        <div class="source-tile active">Linear<span class="source-dot"></span></div>
      </div>
    </section>

    <section class="settings-panel">
      <div class="section-head"><span class="section-title">Automations</span></div>
      <div class="settings-row">
        <div>
          <div class="setting-title">GitHub PR auto-draft</div>
          <div class="setting-subtitle">on Tie the Knot</div>
        </div>
        <div class="on-dot">+ ON</div>
      </div>
      <div class="settings-row">
        <div>
          <div class="setting-title">Slack notifications</div>
          <div class="setting-subtitle">on every stitch</div>
        </div>
        <div class="on-dot">+ ON</div>
      </div>
    </section>

    <section class="settings-panel">
      <div class="section-head"><span class="section-title">Preferences</span></div>
      <div class="settings-row">
        <div>
          <div class="setting-title">Project Lead Mode</div>
          <div class="setting-subtitle">auto prep + drift + AI commit</div>
        </div>
        <div class="toggle"></div>
      </div>
    </section>

    <button class="signout-btn" type="button">Sign out</button>
  </main>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  let state = {
    appName: '', taskId: '', goal: '', status: 'waiting',
    subtasks: [], validationResult: null, validationOverride: false, branchName: '',
    stitchCount: 0, lastStitchTime: ''
  };
  let saveTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;
  let animationMode = 'standby';
  let animationTick = 0;
  let animationResetTimer = null;
  let prPanelTimer = null;
  let currentScreen = 'main';

  const railFrames = {
    standby: [
      'TYNE [    ] STANDBY -- SCOPE RADAR',
      'TYNE [.   ] STANDBY -- SCOPE RADAR',
      'TYNE [..  ] STANDBY -- SCOPE RADAR',
      'TYNE [... ] STANDBY -- SCOPE RADAR',
      'TYNE [....] STANDBY -- SCOPE RADAR'
    ],
    armed: [
      'TYNE [////] MISSION ARMED',
      'TYNE [||||] THREAD READY',
      'TYNE [\\\\\\\\] SCOPE LOCKED',
      'TYNE [----] AWAITING START'
    ],
    weaving: [
      'TYNE <#---#---#> WEAVING',
      'TYNE <-#---#---# WEAVING',
      'TYNE <--#---#-- WEAVING',
      'TYNE <---#---#- WEAVING',
      'TYNE <#---#---#> WEAVING'
    ],
    stitch: [
      'STITCH [#       ] SNAPSHOT',
      'STITCH [###     ] SNAPSHOT',
      'STITCH [#####   ] SNAPSHOT',
      'STITCH [####### ] SAVED',
      'STITCH [########] SAVED'
    ],
    validate: [
      'SCAN   [>-------] GOAL',
      'SCAN   [--->----] DIFF',
      'SCAN   [----->--] SUBTASKS',
      'SCAN   [------->] VERDICT'
    ],
    ready: [
      'TYNE [VALIDATED] SHIP GATE GREEN',
      'TYNE [==OK===>] KNOT UNLOCKED',
      'TYNE [READY   ] AI COMMIT ARMED'
    ],
    launch: [
      'PUSH   [=>      ] ignition',
      'PUSH   [===>    ] branch',
      'PUSH   [=====>  ] remote',
      'PUSH   [=======] orbit',
      'PUSH   [==>    ] telemetry'
    ]
  };

  vscode.postMessage({ type: 'ready' });

  ['appName', 'taskId', 'goal'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      state[id] = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        vscode.postMessage({ type: 'fieldChange', field: id, value: e.target.value });
      }, 500);
      applyStatus();
      updateProgress();
    });
  });

  document.getElementById('addSubtaskBtn').addEventListener('click', addSubtask);
  document.getElementById('newSubtask').addEventListener('keydown', e => {
    if (e.key === 'Enter') { addSubtask(); }
  });

  function addSubtask() {
    const input = document.getElementById('newSubtask');
    const text = input.value.trim();
    if (!text) { return; }
    vscode.postMessage({ type: 'subtaskAdd', text });
    input.value = '';
  }

  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('enabled')) { return; }
      if (btn.dataset.action === 'saveStitch') {
        setAnimationMode('stitch', 1800);
      } else if (btn.dataset.action === 'validateGoal') {
        setAnimationMode('validate', 2400);
      } else if (btn.dataset.action === 'tieKnot') {
        setAnimationMode('launch', 7000);
      }
      vscode.postMessage({ type: 'buttonClick', action: btn.dataset.action });
    });
  });

  document.getElementById('btn-revalidate').addEventListener('click', () => {
    setAnimationMode('validate', 2400);
    vscode.postMessage({ type: 'buttonClick', action: 'validateGoal' });
  });
  document.getElementById('btn-override').addEventListener('click', () => {
    vscode.postMessage({ type: 'buttonClick', action: 'overrideProceed' });
  });
  document.getElementById('settingsBtn').addEventListener('click', () => {
    showScreen('settings');
  });
  document.getElementById('backBtn').addEventListener('click', () => {
    showScreen('main');
  });
  document.getElementById('prLink').addEventListener('click', () => {
    const url = document.getElementById('prLink').dataset.url;
    if (url) {
      vscode.postMessage({ type: 'openExternal', url });
    }
  });

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderProgressBar(done, total, width) {
    if (total === 0) { return '-'.repeat(width); }
    const filled = Math.round((done / total) * width);
    return '#'.repeat(filled) + '-'.repeat(width - filled);
  }

  function deriveMetrics() {
    const total = state.subtasks.length;
    const done = state.subtasks.filter(t => t.done).length;
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    const validation = state.validationResult;
    const passed = validation?.overall === 'pass';
    const stitchCount = state.stitchCount || 0;
    const xp = (done * 25) + (stitchCount * 40) + (state.status === 'weaving' ? 20 : 0) + (passed ? 120 : 0);
    let rank = 'INIT';
    if (tieKnotUnlocked) {
      rank = 'SHIP READY';
    } else if (passed) {
      rank = 'VALIDATED';
    } else if (state.status === 'weaving') {
      rank = 'WEAVING';
    } else if (state.goal || state.appName || total > 0) {
      rank = 'ARMING';
    }
    return { total, done, percent, xp, rank, passed, stitchCount };
  }

  function setEnabled(id, enabled, meta) {
    const btn = document.getElementById('btn-' + id);
    const metaEl = document.getElementById('meta-' + id);
    if (enabled) {
      btn.classList.add('enabled');
    } else {
      btn.classList.remove('enabled');
    }
    if (metaEl) { metaEl.textContent = meta; }
  }

  function setAnimationMode(mode, resetAfterMs) {
    animationMode = mode;
    animationTick = 0;
    if (animationResetTimer) {
      clearTimeout(animationResetTimer);
      animationResetTimer = null;
    }
    if (resetAfterMs) {
      animationResetTimer = setTimeout(() => {
        animationMode = deriveBaseAnimationMode();
        animationTick = 0;
        renderDeck();
      }, resetAfterMs);
    }
    renderDeck();
  }

  function deriveBaseAnimationMode() {
    if (tieKnotUnlocked) { return 'ready'; }
    if (state.validationResult?.overall === 'pass') { return 'ready'; }
    if (state.status === 'weaving') { return 'weaving'; }
    if (state.goal || state.appName || state.subtasks.length > 0) { return 'armed'; }
    return 'standby';
  }

  function currentRailFrame(mode) {
    const frames = railFrames[mode] || railFrames.standby;
    return frames[animationTick % frames.length];
  }

  function showScreen(screen) {
    currentScreen = screen;
    document.getElementById('mainView').classList.toggle('active', screen === 'main');
    document.getElementById('settingsView').classList.toggle('active', screen === 'settings');
    document.getElementById('settingsBtn').classList.toggle('active', screen === 'settings');
    document.getElementById('screenTitle').textContent = screen === 'settings' ? 'Settings' : 'Goal Manager';
    renderDeck();
  }

  function renderSubtasks() {
    const list = document.getElementById('subtaskList');
    list.innerHTML = '';
    if (state.subtasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No checkpoints yet. Break the mission into proof points.';
      list.appendChild(empty);
      updateProgress();
      return;
    }

    state.subtasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'subtask-item';
      item.innerHTML =
        '<button class="subtask-toggle ' + (task.done ? 'done' : '') + '" data-id="' + escHtml(task.id) + '">' + (task.done ? '[x]' : '[ ]') + '</button>' +
        '<span class="subtask-text ' + (task.done ? 'done' : '') + '">' + escHtml(task.text) + '</span>' +
        '<button class="del-btn" data-id="' + escHtml(task.id) + '" title="remove">x</button>';
      list.appendChild(item);
    });

    list.querySelectorAll('.subtask-toggle').forEach(cb => {
      cb.addEventListener('click', () => {
        vscode.postMessage({ type: 'subtaskToggle', id: cb.dataset.id });
      });
    });
    list.querySelectorAll('.del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'subtaskDelete', id: btn.dataset.id });
      });
    });

    updateProgress();
  }

  function updateProgress() {
    const metrics = deriveMetrics();
    const bar = renderProgressBar(metrics.done, metrics.total, 16);
    document.getElementById('progressLine').textContent = '[' + bar + '] ' + metrics.done + '/' + metrics.total;
    document.getElementById('progressCount').textContent = metrics.percent + '%';
    document.getElementById('progressNote').textContent =
      metrics.total === 0
        ? 'No checkpoints loaded. Define the mission.'
        : metrics.done + ' checkpoint' + (metrics.done === 1 ? '' : 's') + ' sealed / ' + (metrics.total - metrics.done) + ' open.';
    renderDeck();
  }

  function renderStitchCounter() {
    const count = state.stitchCount || 0;
    const counter = document.getElementById('stitchCounter');
    if (count > 0) {
      document.getElementById('stitchCountVal').textContent = String(count);
      document.getElementById('lastStitchVal').textContent = state.lastStitchTime || '--:--';
      counter.style.display = 'block';
    } else {
      counter.style.display = 'none';
    }
  }

  function renderValidation() {
    const panel = document.getElementById('validationPanel');
    const r = state.validationResult;
    if (!r) { panel.style.display = 'none'; return; }

    panel.style.display = 'block';
    const container = document.getElementById('validationResults');
    container.innerHTML = '';

    const summary = document.createElement('div');
    summary.className = 'val-summary';
    summary.textContent = r.summary || '';
    container.appendChild(summary);

    (r.results || []).forEach(item => {
      const div = document.createElement('div');
      div.className = 'val-result-item';
      const icon = item.passed ? '+' : 'x';
      const iconClass = item.passed ? 'pass' : 'fail';
      div.innerHTML =
        '<span class="val-icon ' + iconClass + '">' + icon + '</span>' +
        '<span class="val-text">' + escHtml(item.subtask) +
        (item.reason ? ' <span class="val-reason">-- ' + escHtml(item.reason) + '</span>' : '') +
        '</span>';
      container.appendChild(div);
    });

    const incomplete = state.subtasks.filter(t => !t.done).length;
    if (incomplete > 0) {
      const warn = document.createElement('div');
      warn.className = 'val-result-item';
      warn.innerHTML =
        '<span class="val-icon warn">!</span>' +
        '<span class="val-text">' + incomplete + ' subtask' + (incomplete !== 1 ? 's' : '') + ' incomplete</span>';
      container.appendChild(warn);
    }
  }

  function showPRCreated(pr) {
    const panel = document.getElementById('prPanel');
    const link = document.getElementById('prLink');
    document.getElementById('prSummary').textContent = 'PR #' + pr.number + ' created (draft)';
    link.dataset.url = pr.url;
    panel.classList.add('visible');

    if (prPanelTimer) {
      clearTimeout(prPanelTimer);
    }
    prPanelTimer = setTimeout(() => {
      panel.classList.remove('visible');
      link.dataset.url = '';
    }, 5000);
  }

  function renderDeck() {
    const metrics = deriveMetrics();
    const weaving = state.status === 'weaving';
    const app = document.getElementById('app');
    const pill = document.getElementById('statusPill');
    const railLine = document.getElementById('railLine');
    const railState = document.getElementById('railState');
    const subtitle = document.getElementById('deckSubtitle');
    const boot = document.getElementById('bootSignal');
    const baseMode = deriveBaseAnimationMode();
    if (!['stitch', 'validate', 'launch'].includes(animationMode)) {
      animationMode = baseMode;
    }

    app.classList.toggle('weaving', weaving);
    app.classList.toggle('ready', tieKnotUnlocked);
    app.classList.toggle('mode-standby', animationMode === 'standby');
    app.classList.toggle('mode-stitch', animationMode === 'stitch');
    app.classList.toggle('mode-validate', animationMode === 'validate');
    app.classList.toggle('mode-launch', animationMode === 'launch');
    pill.className = 'status-pill ' + (tieKnotUnlocked ? 'ready' : metrics.passed ? 'validated' : weaving ? 'weaving' : '');
    pill.textContent = metrics.rank;

    document.getElementById('rankValue').textContent = metrics.rank;
    document.getElementById('stitchMetric').textContent = String(metrics.stitchCount);
    document.getElementById('readyMetric').textContent = metrics.percent + '%';
    railState.textContent = metrics.xp + ' XP';
    railLine.textContent = currentRailFrame(animationMode);

    if (tieKnotUnlocked) {
      subtitle.textContent = 'validation sealed / knot unlocked';
      boot.textContent = 'ship vector green -- tie the knot';
    } else if (metrics.passed) {
      subtitle.textContent = 'proof accepted / ship gate ready';
      boot.textContent = 'validation pass -- final command armed';
    } else if (weaving) {
      subtitle.textContent = state.branchName || 'thread live / commits guarded';
      boot.textContent = 'watching diff -- drift shield online';
    } else {
      subtitle.textContent = state.goal ? 'mission drafted / start thread' : 'scope locked / drift watched';
      boot.textContent = state.goal ? 'mission loaded -- awaiting branch' : 'tyne -- awaiting mission';
    }

    if (currentScreen === 'settings') {
      subtitle.textContent = 'license + integrations + automation';
    }
  }

  setInterval(() => {
    animationTick += 1;
    renderDeck();
  }, 950);

  function applyStatus() {
    const weaving = state.status === 'weaving';
    const canStart = Boolean((state.appName || '').trim() && (state.goal || '').trim()) && !weaving;
    const startBtn = document.getElementById('btn-startThread');
    const branchLabel = document.getElementById('branchLabel');

    if (weaving) {
      startBtn.classList.remove('enabled');
      if (state.branchName) {
        branchLabel.textContent = 'branch :: ' + state.branchName;
        branchLabel.style.display = 'block';
      }
    } else {
      branchLabel.style.display = 'none';
    }

    setEnabled('startThread', canStart, weaving ? 'done' : canStart ? 'ready' : 'need goal');
    setEnabled('saveStitch', weaving, weaving ? ((state.stitchCount || 0) + ' saved') : 'locked');
    setEnabled('undoStitch', weaving && localHasStitch, weaving && localHasStitch ? 'armed' : 'locked');
    setEnabled('validateGoal', weaving, state.validationResult ? 'ran' : weaving ? 'ready' : 'locked');
    setEnabled('tieKnot', tieKnotUnlocked, tieKnotUnlocked ? 'AI commit' : 'locked');
    renderDeck();
  }

  function applyState() {
    document.getElementById('appName').value = state.appName || '';
    document.getElementById('taskId').value  = state.taskId  || '';
    document.getElementById('goal').value    = state.goal    || '';
    localHasStitch = (state.stitchCount || 0) > 0 && state.status === 'weaving';
    tieKnotUnlocked = state.validationOverride || state.validationResult?.overall === 'pass';
    renderSubtasks();
    renderStitchCounter();
    renderValidation();
    applyStatus();
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'stateLoaded') {
      state = msg.state;
      applyState();
    } else if (msg.type === 'statusChanged') {
      state.status = msg.status;
      state.branchName = msg.branchName || state.branchName;
      applyStatus();
    } else if (msg.type === 'stitchSaved') {
      state.stitchCount = msg.stitchCount;
      state.lastStitchTime = msg.lastStitchTime;
      localHasStitch = true;
      renderStitchCounter();
      applyStatus();
    } else if (msg.type === 'stitchUndone') {
      state.stitchCount = msg.stitchCount;
      renderStitchCounter();
      applyStatus();
    } else if (msg.type === 'hasStitch') {
      localHasStitch = msg.value;
      applyStatus();
    } else if (msg.type === 'validationComplete') {
      state.validationResult = msg.result;
      tieKnotUnlocked = msg.result.overall === 'pass';
      renderValidation();
      applyStatus();
    } else if (msg.type === 'tieKnotUnlocked') {
      state.validationOverride = true;
      tieKnotUnlocked = true;
      applyStatus();
    } else if (msg.type === 'stateCleared') {
      state = {
        appName: '', taskId: '', goal: '', status: 'waiting',
        subtasks: [], validationResult: null, validationOverride: false,
        branchName: '', stitchCount: 0, lastStitchTime: ''
      };
      localHasStitch = false;
      tieKnotUnlocked = false;
      animationMode = 'standby';
      animationTick = 0;
      applyState();
    } else if (msg.type === 'prCreated') {
      showPRCreated(msg);
    }
  });
</script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
