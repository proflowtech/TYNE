import * as vscode from 'vscode';
import { TyneState, getState, saveState, clearState } from './stateManager';
import { sanitizeBranchName, createBranch, saveStitch, hasStitch, undoStitch, tieTheKnot } from './gitManager';
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
      const { branch, pushed } = await tieTheKnot(this._state.taskId, this._state.goal);
      await clearState(this._context);
      this._state = getState(this._context);
      this._view?.webview.postMessage({ type: 'stateCleared' });

      if (pushed) {
        vscode.window.showInformationMessage(`Thread complete! Branch ${branch} pushed. ✓`);
      } else {
        vscode.window.showInformationMessage(
          `Thread committed locally. Add a remote to push: git remote add origin <url>`,
        );
      }
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private _debouncedSave(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); }
    this._saveTimer = setTimeout(() => {
      saveState(this._context, this._state);
    }, 500);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tyne</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Courier New', 'Consolas', monospace;
      font-size: 12px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      padding: 8px 10px;
      line-height: 1.4;
    }

    .header {
      font-size: 12px;
      font-weight: bold;
      letter-spacing: 0.05em;
      margin-bottom: 10px;
      color: var(--vscode-foreground);
    }

    .row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .field-group {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1;
    }

    .field-group.narrow {
      flex: 0 0 90px;
    }

    label {
      font-size: 9px;
      opacity: 0.55;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }

    input[type="text"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
      padding: 3px 6px;
      font-family: inherit;
      font-size: 11px;
      width: 100%;
      outline: none;
    }

    input[type="text"]:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }

    .section-label {
      font-size: 9px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 5px;
    }

    .section-rule {
      display: flex;
      align-items: center;
      gap: 4px;
      margin: 10px 0 6px;
    }

    .section-rule span {
      font-size: 9px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      white-space: nowrap;
    }

    .section-rule::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--vscode-panel-border, rgba(255,255,255,0.1));
    }

    .subtask-item {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 0;
      font-size: 11px;
    }

    .subtask-item input[type="checkbox"] {
      accent-color: var(--vscode-button-background, #007acc);
      cursor: pointer;
      flex-shrink: 0;
    }

    .subtask-text {
      flex: 1;
      word-break: break-word;
    }

    .subtask-text.done {
      text-decoration: line-through;
      opacity: 0.45;
    }

    .del-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0;
      font-size: 10px;
      padding: 0 2px;
      flex-shrink: 0;
      transition: opacity 0.1s;
    }

    .subtask-item:hover .del-btn { opacity: 0.5; }
    .del-btn:hover { opacity: 1 !important; }

    .add-subtask {
      display: flex;
      gap: 4px;
      margin-top: 5px;
    }

    .add-subtask input { flex: 1; }

    .btn-plus {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
      padding: 3px 8px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
    }

    .btn-plus:hover {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .progress-line {
      font-size: 11px;
      letter-spacing: 0.01em;
      margin: 4px 0;
      opacity: 0.8;
    }

    .status-banner {
      text-align: center;
      padding: 4px 8px;
      border: 1px solid currentColor;
      margin: 10px 0;
      font-size: 11px;
      letter-spacing: 0.12em;
    }

    .status-waiting {
      color: var(--vscode-foreground);
      opacity: 0.55;
    }

    .status-weaving {
      color: #e8a857;
    }

    .action-btn {
      display: block;
      width: 100%;
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.04));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
      padding: 5px 8px;
      margin-bottom: 3px;
      font-family: inherit;
      font-size: 11px;
      text-align: left;
      letter-spacing: 0.02em;
      opacity: 0.4;
      pointer-events: none;
      cursor: default;
      transition: background 0.1s, opacity 0.1s;
    }

    .action-btn.enabled {
      opacity: 1;
      pointer-events: all;
      cursor: pointer;
    }

    .action-btn.enabled:hover {
      background: var(--vscode-button-background, #007acc);
      color: var(--vscode-button-foreground, #fff);
    }

    .branch-label {
      font-size: 9px;
      opacity: 0.5;
      margin: 1px 0 5px 8px;
      word-break: break-all;
      display: none;
    }

    .bottom-rule {
      height: 1px;
      background: var(--vscode-panel-border, rgba(255,255,255,0.1));
      margin: 8px 0 5px;
    }

    .needle {
      font-size: 11px;
      opacity: 0.7;
    }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    @keyframes slide { 0%{letter-spacing:0} 50%{letter-spacing:.08em} 100%{letter-spacing:0} }

    .weaving .status-banner {
      animation: pulse 1.4s ease-in-out infinite;
    }

    .weaving .needle {
      animation: slide 2s linear infinite;
    }

    .stitch-counter {
      font-size: 9px;
      opacity: 0.55;
      padding: 4px 0 4px 2px;
      letter-spacing: 0.05em;
      display: none;
    }

    .validation-panel { display: none; }

    .val-summary {
      font-size: 10px;
      opacity: 0.65;
      padding: 2px 0 5px;
      font-style: italic;
    }

    .val-result-item {
      display: flex;
      gap: 5px;
      align-items: baseline;
      padding: 2px 0;
      font-size: 10px;
    }

    .val-icon { flex-shrink: 0; }
    .val-text { flex: 1; }
    .val-reason { opacity: 0.55; font-size: 9px; }

    .val-icon.pass { color: #4ec9b0; }
    .val-icon.fail { color: #f48771; }
    .val-icon.warn { color: #e8a857; }

    .validation-actions {
      display: flex;
      gap: 5px;
      margin-top: 6px;
      flex-wrap: wrap;
    }

    .val-btn {
      background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.04));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
      padding: 3px 7px;
      font-family: inherit;
      font-size: 10px;
      cursor: pointer;
      letter-spacing: 0.02em;
    }

    .val-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.08));
    }
  </style>
</head>
<body>
<div id="app">

  <div class="header">TYNE ────────────────────────────</div>

  <div class="row">
    <div class="field-group">
      <label>APP</label>
      <input type="text" id="appName" placeholder="app name" autocomplete="off" />
    </div>
    <div class="field-group narrow">
      <label>TASK ID</label>
      <input type="text" id="taskId" placeholder="T-001" autocomplete="off" />
    </div>
  </div>

  <div class="field-group" style="margin-bottom:0">
    <label>GOAL</label>
    <input type="text" id="goal" placeholder="what are we building?" autocomplete="off" />
  </div>

  <div class="section-rule"><span>SUBTASKS</span></div>

  <div id="subtaskList"></div>

  <div class="add-subtask">
    <input type="text" id="newSubtask" placeholder="add subtask..." autocomplete="off" />
    <button class="btn-plus" id="addSubtaskBtn">[+]</button>
  </div>

  <div class="section-rule" style="margin-top:8px"><span>PROGRESS</span></div>

  <div class="progress-line" id="progressLine">[░░░░░░░░░░░░] 0/0</div>

  <div id="statusBanner" class="status-banner status-waiting">[STATUS: WAITING]</div>

  <button class="action-btn" id="btn-startThread" data-action="startThread">[ 1. START THREAD  ]</button>
  <div class="branch-label" id="branchLabel"></div>
  <button class="action-btn" id="btn-saveStitch"  data-action="saveStitch">[ 2. SAVE STITCH   ]</button>
  <button class="action-btn" id="btn-undoStitch"  data-action="undoStitch">[ 3. UNDO STITCH   ]</button>
  <button class="action-btn" id="btn-validateGoal" data-action="validateGoal">[ 4. VALIDATE GOAL ]</button>
  <button class="action-btn" id="btn-tieKnot"     data-action="tieKnot">[ 5. TIE THE KNOT  ] \u{1F512}</button>

  <div class="stitch-counter" id="stitchCounter">
    stitches: <span id="stitchCountVal">0</span>&nbsp;&nbsp;&nbsp;last: <span id="lastStitchVal">—</span>
  </div>

  <div class="validation-panel" id="validationPanel">
    <div class="section-rule"><span>LAST VALIDATION</span></div>
    <div id="validationResults"></div>
    <div class="validation-actions">
      <button class="val-btn" id="btn-revalidate">[ RE-VALIDATE ]</button>
      <button class="val-btn" id="btn-override">[ OVERRIDE &amp; PROCEED ]</button>
    </div>
  </div>

  <div class="bottom-rule"></div>
  <div class="needle" id="needle">\u{1F517} idle</div>

</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  let state = {
    appName: '', taskId: '', goal: '', status: 'waiting',
    subtasks: [], validationResult: null, branchName: '',
    stitchCount: 0, lastStitchTime: ''
  };
  let saveTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;

  // Notify extension the webview is ready
  vscode.postMessage({ type: 'ready' });

  // Debounced field inputs
  ['appName', 'taskId', 'goal'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      state[id] = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        vscode.postMessage({ type: 'fieldChange', field: id, value: e.target.value });
      }, 500);
    });
  });

  // Add subtask
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

  // Button clicks
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('enabled')) { return; }
      vscode.postMessage({ type: 'buttonClick', action: btn.dataset.action });
    });
  });

  document.getElementById('btn-revalidate').addEventListener('click', () => {
    vscode.postMessage({ type: 'buttonClick', action: 'validateGoal' });
  });
  document.getElementById('btn-override').addEventListener('click', () => {
    vscode.postMessage({ type: 'buttonClick', action: 'overrideProceed' });
  });

  // --- Render helpers ---

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderProgressBar(done, total, width) {
    if (total === 0) { return '░'.repeat(width); }
    const filled = Math.round((done / total) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  function renderSubtasks() {
    const list = document.getElementById('subtaskList');
    list.innerHTML = '';
    state.subtasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'subtask-item';
      item.innerHTML =
        '<input type="checkbox" ' + (task.done ? 'checked' : '') + ' data-id="' + escHtml(task.id) + '" />' +
        '<span class="subtask-text ' + (task.done ? 'done' : '') + '">' + escHtml(task.text) + '</span>' +
        '<button class="del-btn" data-id="' + escHtml(task.id) + '" title="remove">×</button>';
      list.appendChild(item);
    });

    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
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
    const total = state.subtasks.length;
    const done = state.subtasks.filter(t => t.done).length;
    const bar = renderProgressBar(done, total, 12);
    document.getElementById('progressLine').textContent = '[' + bar + '] ' + done + '/' + total;
  }

  function renderStitchCounter() {
    const count = state.stitchCount || 0;
    const counter = document.getElementById('stitchCounter');
    if (count > 0) {
      document.getElementById('stitchCountVal').textContent = String(count);
      document.getElementById('lastStitchVal').textContent = state.lastStitchTime || '—';
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
      const icon = item.passed ? '✓' : '✗';
      const iconClass = item.passed ? 'pass' : 'fail';
      div.innerHTML =
        '<span class="val-icon ' + iconClass + '">' + icon + '</span>' +
        '<span class="val-text">' + escHtml(item.subtask) +
        (item.reason ? ' <span class="val-reason">— ' + escHtml(item.reason) + '</span>' : '') +
        '</span>';
      container.appendChild(div);
    });

    const incomplete = state.subtasks.filter(t => !t.done).length;
    if (incomplete > 0) {
      const warn = document.createElement('div');
      warn.className = 'val-result-item';
      warn.innerHTML =
        '<span class="val-icon warn">⚠</span>' +
        '<span class="val-text">' + incomplete + ' subtask' + (incomplete !== 1 ? 's' : '') + ' incomplete</span>';
      container.appendChild(warn);
    }
  }

  function applyStatus() {
    const weaving = state.status === 'weaving';
    const app = document.getElementById('app');
    const banner = document.getElementById('statusBanner');
    const needle = document.getElementById('needle');
    const startBtn = document.getElementById('btn-startThread');
    const saveBtn = document.getElementById('btn-saveStitch');
    const undoBtn = document.getElementById('btn-undoStitch');
    const branchLabel = document.getElementById('branchLabel');

    if (weaving) {
      app.classList.add('weaving');
      banner.textContent = '[STATUS: WEAVING]';
      banner.className = 'status-banner status-weaving';
      needle.textContent = '\u{1F517} ────────── >';

      startBtn.classList.remove('enabled');
      if (state.branchName) {
        branchLabel.textContent = state.branchName;
        branchLabel.style.display = 'block';
      }
      saveBtn.classList.add('enabled');
    } else {
      app.classList.remove('weaving');
      banner.textContent = '[STATUS: WAITING]';
      banner.className = 'status-banner status-waiting';
      needle.textContent = '\u{1F517} idle';

      startBtn.classList.add('enabled');
      branchLabel.style.display = 'none';
      saveBtn.classList.remove('enabled');
    }

    if (weaving && localHasStitch) {
      undoBtn.classList.add('enabled');
    } else {
      undoBtn.classList.remove('enabled');
    }

    const validateBtn = document.getElementById('btn-validateGoal');
    const tieBtn = document.getElementById('btn-tieKnot');

    if (weaving) {
      validateBtn.classList.add('enabled');
    } else {
      validateBtn.classList.remove('enabled');
    }

    if (tieKnotUnlocked) {
      tieBtn.classList.add('enabled');
    } else {
      tieBtn.classList.remove('enabled');
    }
  }

  function applyState() {
    document.getElementById('appName').value = state.appName || '';
    document.getElementById('taskId').value  = state.taskId  || '';
    document.getElementById('goal').value    = state.goal    || '';
    localHasStitch = (state.stitchCount || 0) > 0 && state.status === 'weaving';
    tieKnotUnlocked = state.validationResult?.overall === 'pass';
    renderSubtasks();
    renderStitchCounter();
    renderValidation();
    applyStatus();
  }

  // Messages from extension
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
    } else if (msg.type === 'hasStitch') {
      localHasStitch = msg.value;
      applyStatus();
    } else if (msg.type === 'validationComplete') {
      state.validationResult = msg.result;
      tieKnotUnlocked = msg.result.overall === 'pass';
      renderValidation();
      applyStatus();
    } else if (msg.type === 'tieKnotUnlocked') {
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
      applyState();
    }
  });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
