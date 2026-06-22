import * as vscode from 'vscode';
import { TyneState, getState, saveState, clearState } from './stateManager';
import { sanitizeBranchName, createBranch, saveStitch, hasStitch, undoStitch, tieTheKnot, getGit } from './gitManager';
import { createDraftPR } from './githubIntegration';
import { startGitHubDeviceFlow, pollGitHubDeviceToken, openGitHubDeviceUri } from './githubOAuth';
import { validateGoal, ValidationResponse } from './validator';
import { prepareWorkspace } from './workspacePrep';
import { DriftEvent, startDriftDetection, stopDriftDetection } from './driftDetector';
import { synthesizeCommitMessage } from './commitSynthesizer';
import { closePMTicket, fetchPMTasksForStandup } from './pmIntegration';

export class TyneSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _saveTimer?: ReturnType<typeof setTimeout>;
  private _state: TyneState;
  private _isAuthenticated: boolean;
  private readonly _driftEvents = new Map<string, DriftEvent>();
  private _userProfile: { tier: string; credits: number; githubUsername?: string; githubId?: string } = { tier: 'CORE', credits: 0, githubUsername: '', githubId: '' };

  constructor(
    private readonly _context: vscode.ExtensionContext,
    isAuthenticated = false,
  ) {
    this._state = getState(_context);
    this._isAuthenticated = isAuthenticated;
    if (this._isAuthenticated) {
      this._updateProfile();
    }
  }

  public async updateAuthenticationState(isAuthenticated: boolean): Promise<void> {
    this._isAuthenticated = isAuthenticated;
    if (isAuthenticated) {
      await this._updateProfile();
    } else {
      this._userProfile = { tier: 'CORE', credits: 0 };
    }
    this._postAuthState();
    this._postState();
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
      if (msg.command === 'WEBVIEW_READY') {
        console.log('HOST: Received WEBVIEW_READY, fetching profile...');
        if (this._isAuthenticated) {
          await this._updateProfile();
        }
        return;
      }
      switch (msg.type) {
        case 'ready':
          this._postState();
          break;
        case 'fieldChange': this._handleFieldChange(msg.field as string, msg.value as string); break;
        case 'subtaskAdd': this._handleSubtaskAdd(msg.text as string); break;
        case 'subtaskToggle': this._handleSubtaskToggle(msg.id as string); break;
        case 'subtaskDelete': this._handleSubtaskDelete(msg.id as string); break;
        case 'buttonClick': await this._handleButtonClick(msg.action as string); break;
        case 'openExternal':
          if (typeof msg.url === 'string') { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
          break;
        case 'continueWithGitHub': await this._continueWithGitHub(); break;
        case 'logout': await this._logout(); break;
        case 'settingChange': await this._handleSettingChange(msg.key as string, msg.value); break;
        case 'saveByokKey': await this._handleSaveByokKey(msg.apiKey as string, msg.provider as string); break;
        case 'driftAction': await this._handleDriftAction(msg.file as string, msg.action as string); break;
        case 'parkedIdeasClear': await this._setParkedIdeas([]); this._postSettings(); break;
        case 'standupSelect': await this._handleStandupSelect(msg.task); break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this._state = getState(this._context); this._postState(); }
    });
  }

  private _postState(): void {
    this._view?.webview.postMessage({ type: 'stateLoaded', state: this._state });
    this._postAuthState();
    this._postSettings();
  }

  private _postAuthState(): void {
    this._view?.webview.postMessage({ type: 'AUTH_STATE_CHANGE', isAuthenticated: this._isAuthenticated });
  }

  private async _continueWithGitHub(): Promise<void> {
    const clientId = vscode.workspace.getConfiguration('tyne').get<string>('githubClientId', '');
    if (!clientId) {
      vscode.window.showErrorMessage('No GitHub Client ID configured. Set tyne.githubClientId in settings.');
      return;
    }
    this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'starting' });
    try {
      const flow = await startGitHubDeviceFlow(clientId);
      openGitHubDeviceUri(flow.verificationUri);
      this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'pending', userCode: flow.userCode, verificationUri: flow.verificationUri });
      const progressOptions = { location: vscode.ProgressLocation.Notification, title: `GitHub: enter code ${flow.userCode}`, cancellable: true };
      const token = await vscode.window.withProgress(progressOptions, async (progress, tokenSource) => {
        progress.report({ message: 'Waiting for authorization...' });
        const controller = new AbortController();
        tokenSource.onCancellationRequested(() => controller.abort());
        const result = await pollGitHubDeviceToken(clientId, flow.deviceCode, flow.interval, this._context, controller.signal);
        return result.accessToken;
      });
      if (token) { vscode.window.showInformationMessage('GitHub connected ✓'); await this.updateAuthenticationState(true); }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('GitHub connection failed: ' + message);
      this._view?.webview.postMessage({ type: 'githubConnectStatus', status: 'error', error: message });
    }
  }

  private async _logout(): Promise<void> {
    await this._context.secrets.delete('tyne_github_token');
    stopDriftDetection();
    await this.updateAuthenticationState(false);
  }

  private _isProjectLeadMode(): boolean {
    return vscode.workspace.getConfiguration('tyne').get<boolean>('projectLeadMode', false);
  }

  private async _updateProfile(): Promise<void> {
    this._userProfile = await this._fetchUserProfile();
    this._view?.webview.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this._userProfile.tier,
        credits: this._userProfile.credits,
        githubUsername: this._userProfile.githubUsername || '',
        githubId: this._userProfile.githubId || '',
      }
    });
  }

  private async _fetchUserProfile(): Promise<{ tier: string; credits: number; githubUsername?: string; githubId?: string }> {
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) {
      return { tier: 'CORE', credits: 0, githubUsername: '', githubId: '' };
    }
    const machineId = vscode.env.machineId;
    try {
      const res = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'X-Machine-ID': machineId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ feature: 'profile' })
      });
      if (res.ok) {
        const data = await res.json() as { tier: string; credits: number; githubUsername?: string; githubId?: string };
        return data;
      }
    } catch (e) {
      console.error("Error fetching user profile:", e);
    }
    return { tier: 'CORE', credits: 0, githubUsername: '', githubId: '' };
  }

  private _getParkedIdeas(): string[] {
    return this._context.workspaceState.get<string[]>('tyne.parkedIdeas', []);
  }

  private async _setParkedIdeas(ideas: string[]): Promise<void> {
    await this._context.workspaceState.update('tyne.parkedIdeas', ideas);
  }

  private _getAiAccessMode(): 'byok' | 'max' {
    return this._context.workspaceState.get<'byok' | 'max'>('tyne.aiAccessMode', 'byok');
  }

  private _getAiUsageLimit(): number {
    return this._getAiAccessMode() === 'max' ? 200 : 50;
  }

  private _getAiUsageUsed(): number {
    return this._context.workspaceState.get<number>('tyne.aiUsageUsed', 0);
  }

  private async _postSettings(): Promise<void> {
    const projectLeadMode = this._isProjectLeadMode();
    const aiAccessMode = this._getAiAccessMode();
    const aiProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    const hasBYOKKey = Boolean(await this._context.secrets.get('tyne.byokApiKey'));
    const aiUsageUsed = this._getAiUsageUsed();
    const aiUsageLimit = this._getAiUsageLimit();
    this._view?.webview.postMessage({
      type: 'settingsLoaded',
      projectLeadMode,
      parkedIdeas: this._getParkedIdeas(),
      aiAccessMode,
      aiProvider,
      hasBYOKKey,
      aiUsageUsed,
      aiUsageLimit,
      userTier: this._userProfile.tier,
      userCredits: this._userProfile.credits,
      githubUsername: this._userProfile.githubUsername || '',
    });
    this._view?.webview.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this._userProfile.tier,
        credits: this._userProfile.credits,
        githubUsername: this._userProfile.githubUsername || '',
        githubId: this._userProfile.githubId || '',
      }
    });
    fetchPMTasksForStandup().then(tasks => {
      this._view?.webview.postMessage({ type: 'standupReady', tasks });
    }).catch(() => {
      this._view?.webview.postMessage({ type: 'standupReady', tasks: [] });
    });
  }

  private async _handleSettingChange(key: string, value: unknown): Promise<void> {
    if (key === 'aiAccessMode') {
      await this._context.workspaceState.update('tyne.aiAccessMode', value === 'max' ? 'max' : 'byok');
      this._postSettings();
      return;
    }
    if (key === 'byokProvider') {
      const provider = value === 'openai' ? 'openai' : 'claude';
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('tyne').update('byokProvider', provider, target);
      this._postSettings();
      return;
    }
    if (key !== 'projectLeadMode') { return; }
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('tyne').update('projectLeadMode', Boolean(value), target);
    if (!value) { stopDriftDetection(); } else if (this._state.status === 'weaving') { this._startProjectLeadWatcher(); }
    this._postSettings();
  }

  private async _handleSaveByokKey(apiKey: string, provider: string): Promise<void> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      vscode.window.showErrorMessage('Enter an API key before saving.');
      return;
    }
    await this._context.secrets.store('tyne.byokApiKey', trimmed);
    await this._handleSettingChange('byokProvider', provider);
    await this._context.workspaceState.update('tyne.aiAccessMode', 'byok');
    this._view?.webview.postMessage({ type: 'aiSettingsSaved' });
    this._postSettings();
    vscode.window.showInformationMessage('Tyne API key saved securely.');
  }

  private async _handleStandupSelect(task: unknown): Promise<void> {
    if (!task || typeof task !== 'object') { return; }
    const selected = task as { id?: string; title?: string };
    this._state.taskId = selected.id || this._state.taskId;
    this._state.goal = selected.title || this._state.goal;
    this._state.appName = this._state.appName || vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    await saveState(this._context, this._state);
    this._postState();
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
    if (task) { task.done = !task.done; this._debouncedSave(); this._postState(); }
  }

  private _handleSubtaskDelete(id: string): void {
    this._state.subtasks = this._state.subtasks.filter(t => t.id !== id);
    this._debouncedSave();
    this._postState();
  }

  private async _handleButtonClick(action: string): Promise<void> {
    switch (action) {
      case 'startThread': await this._startThread(); break;
      case 'saveStitch': await this._saveStitch(); break;
      case 'undoStitch': await this._undoStitch(); break;
      case 'validateGoal': await this._validateGoal(); break;
      case 'overrideProceed': await this._overrideProceed(); break;
      case 'tieKnot': await this._tieTheKnot(); break;
      default: vscode.window.showInformationMessage(`Tyne: ${action} coming soon`);
    }
  }

  private async _startThread(): Promise<void> {
    if (!this._state.appName || !this._state.goal) { vscode.window.showErrorMessage('App name and goal are required'); return; }
    const branchName = sanitizeBranchName(this._state.taskId || 'task', this._state.goal);
    try {
      if (this._isProjectLeadMode()) {
        this._view?.webview.postMessage({ type: 'prepStarted' });
        try {
          const prep = await prepareWorkspace();
          this._view?.webview.postMessage({ type: 'prepComplete', stashed: prep.stashed, pullSummary: prep.pullSummary || 'No remote to pull from', clean: prep.clean });
          await new Promise(resolve => setTimeout(resolve, 700));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'User cancelled workspace prep') { return; }
          vscode.window.showErrorMessage('Workspace prep failed: ' + message);
          this._view?.webview.postMessage({ type: 'prepComplete', error: message });
          return;
        }
      }
      await createBranch(branchName);
      this._state.branchName = branchName;
      this._state.status = 'weaving';
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
      this._startProjectLeadWatcher();
      vscode.window.showInformationMessage('Thread started on branch: ' + branchName);
    } catch (err: unknown) {
      vscode.window.showErrorMessage('Could not create branch: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private _startProjectLeadWatcher(): void {
    if (!this._isProjectLeadMode() || this._state.status !== 'weaving') { return; }
    startDriftDetection(this._state.goal, this._state.taskId, event => { this._handleDriftDetected(event); });
  }

  private _handleDriftDetected(event: DriftEvent): void {
    this._driftEvents.set(event.file, event);
    this._view?.webview.postMessage({ type: 'driftDetected', event });
    const goalPreview = this._state.goal.length > 44 ? `${this._state.goal.slice(0, 44)}...` : this._state.goal;
    vscode.window.showWarningMessage(`Tyne: "${event.file}" looks off-scope for "${goalPreview}"`, 'Park changes', 'New ticket', 'Dismiss').then(choice => {
      if (choice === 'Park changes') { this._handleDriftAction(event.file, 'park'); }
      else if (choice === 'New ticket') { this._handleDriftAction(event.file, 'new_ticket'); }
      else if (choice === 'Dismiss') { this._handleDriftAction(event.file, 'dismiss'); }
    });
  }

  private async _handleDriftAction(file: string, action: string): Promise<void> {
    const event = this._driftEvents.get(file);
    if (!event) { return; }
    if (action === 'dismiss') { this._driftEvents.delete(file); this._view?.webview.postMessage({ type: 'driftDismissed', file }); return; }
    if (action === 'park') {
      try {
        const git = getGit();
        if (!git) { throw new Error('No git repo'); }
        await git.stash(['push', '-m', `Tyne drift-park: ${file}`]);
        this._driftEvents.delete(file);
        this._view?.webview.postMessage({ type: 'driftParked', file });
        vscode.window.showInformationMessage(`Changes parked in stash for ${file} ✓`);
      } catch (err: unknown) {
        vscode.window.showWarningMessage('Could not park changes: ' + (err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (action === 'new_ticket') {
      const note = await vscode.window.showInputBox({ prompt: 'Describe this unrelated change', placeHolder: 'Fix payment form validation' });
      if (!note) { return; }
      const idea = `${file}: ${note}`;
      const parkedIdeas = [...this._getParkedIdeas(), idea];
      await this._setParkedIdeas(parkedIdeas);
      this._driftEvents.delete(file);
      this._view?.webview.postMessage({ type: 'parkedIdeaSaved', idea, parkedIdeas });
      vscode.window.showInformationMessage(`Parked idea saved: "${note}" ✓`);
    }
  }

  private async _saveStitch(): Promise<void> {
    try {
      const hash = await saveStitch(this._state.taskId || 'task');
      this._state.stitchCount += 1;
      this._state.lastStitchTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({ type: 'stitchSaved', hash, stitchCount: this._state.stitchCount, lastStitchTime: this._state.lastStitchTime });
      this._view?.webview.postMessage({ type: 'hasStitch', value: true });
      vscode.window.showInformationMessage(`Stitch saved ✓ (${hash.slice(0, 7)})`);
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  private async _undoStitch(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Undo last stitch? All changes since the last stitch will be lost.', 'Yes, undo', 'Cancel');
    if (pick !== 'Yes, undo') { return; }
    try {
      await undoStitch();
      this._state.stitchCount = Math.max(0, this._state.stitchCount - 1);
      await saveState(this._context, this._state);
      const stillHas = await hasStitch();
      this._view?.webview.postMessage({ type: 'stitchUndone', stitchCount: this._state.stitchCount });
      this._view?.webview.postMessage({ type: 'hasStitch', value: stillHas });
      vscode.window.showInformationMessage('Stitch undone. Rolled back to previous state.');
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  private async _validateGoal(): Promise<void> {
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) {
      vscode.window.showErrorMessage('Connect your GitHub account in the Tyne sidebar first.');
      return;
    }
    const aiAccessMode = this._getAiAccessMode();
    const byokKey = aiAccessMode === 'byok' ? (await this._context.secrets.get('tyne.byokApiKey') || undefined) : undefined;
    const byokProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    
    if (!byokKey && this._userProfile.tier !== 'MAX') {
      const action = await vscode.window.showErrorMessage(
        'Goal Validation (Deep Code Review) requires a MAX tier subscription or your own API Key (BYOK) in settings.',
        'Open AI Settings', 'Set API Key Command'
      );
      if (action === 'Open AI Settings') { this._view?.webview.postMessage({ type: 'openAiSettings' }); }
      if (action === 'Set API Key Command') { await vscode.commands.executeCommand('tyne.setBYOKKey'); }
      return;
    }

    const machineId = vscode.env.machineId;
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Validating goal...',
        cancellable: false
      }, () => validateGoal(
        this._state.goal,
        this._state.subtasks,
        githubToken,
        machineId,
        byokKey,
        byokProvider
      ));

      this._state.validationResult = result;
      await this._updateProfile();
      await saveState(this._context, this._state);
      this._view?.webview.postMessage({ type: 'validationComplete', result });
      this._postSettings();
      if (result.overall === 'pass') {
        vscode.window.showInformationMessage('Validation passed ✓ Tie the Knot is now unlocked.');
      } else {
        vscode.window.showWarningMessage(`Validation ${result.overall}: ${result.summary}`);
      }
    } catch (err: unknown) {
      vscode.window.showErrorMessage('Validation failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async _overrideProceed(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Override validation? Tie the Knot will proceed even though validation did not fully pass.', 'Yes, override', 'Cancel');
    if (pick !== 'Yes, override') { return; }
    this._state.validationOverride = true;
    await saveState(this._context, this._state);
    this._view?.webview.postMessage({ type: 'tieKnotUnlocked' });
  }

  private async _tieTheKnot(): Promise<void> {
    if (!this._state.validationResult && !this._state.validationOverride) { vscode.window.showErrorMessage('Validate your goal first, or use Override.'); return; }
    const pick = await vscode.window.showWarningMessage(`Tie the knot on "${this._state.goal}"? This will commit and push.`, 'Yes, ship it', 'Cancel');
    if (pick !== 'Yes, ship it') { return; }
    try {
      const threadState = { goal: this._state.goal, taskId: this._state.taskId, subtasks: [...this._state.subtasks], branchName: this._state.branchName };
      const { subject, body } = await this._resolveCommitMessage();
      const { branch, pushed } = await tieTheKnot(this._state.taskId, subject, body);
      stopDriftDetection();
      await clearState(this._context);
      this._state = getState(this._context);
      this._view?.webview.postMessage({ type: 'stateCleared', branch, pushed, taskId: threadState.taskId });
      if (pushed) {
        vscode.window.showInformationMessage(`Thread complete! Branch ${branch} pushed. ✓`);
        this._maybeCreateDraftPR({ ...threadState, branchName: branch });
        this._maybeClosePMTicket(threadState.taskId);
      } else {
        vscode.window.showInformationMessage('Thread committed locally. Add a remote to push: git remote add origin <url>');
      }
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  private async _resolveCommitMessage(): Promise<{ subject: string; body: string }> {
    if (!this._isProjectLeadMode()) { return { subject: this._state.goal, body: '' }; }
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) { vscode.window.showWarningMessage('Commit synthesis skipped: GitHub is not connected.'); return { subject: this._state.goal, body: '' }; }
    
    const aiAccessMode = this._getAiAccessMode();
    const byokKey = aiAccessMode === 'byok' ? (await this._context.secrets.get('tyne.byokApiKey') || undefined) : undefined;
    const byokProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    
    if (this._userProfile.tier === 'CORE' && !byokKey) {
      vscode.window.showErrorMessage('Free Tier requires your own API Key (BYOK) to synthesize commits. Configure it in Tyne settings.');
      return { subject: this._state.goal, body: '' };
    }

    const machineId = vscode.env.machineId;
    try {
      this._view?.webview.postMessage({ type: 'synthStarted' });
      const synth = await synthesizeCommitMessage(this._state.goal, this._state.taskId, this._state.subtasks, githubToken, machineId, byokKey, byokProvider);
      const choice = await vscode.window.showInformationMessage(`Commit: "${synth.subject}"`, 'Use this', 'Edit', 'Use original goal');
      if (choice === 'Use this') { return { subject: synth.subject, body: synth.body }; }
      if (choice === 'Edit') {
        const edited = await vscode.window.showInputBox({ value: synth.subject, prompt: 'Edit commit message', placeHolder: 'feat(PRO-102): ...' });
        return { subject: edited || synth.subject, body: synth.body };
      }
    } catch (err: unknown) {
      vscode.window.showWarningMessage('Commit synthesis failed, using goal as message: ' + (err instanceof Error ? err.message : String(err)));
    }
    return { subject: this._state.goal, body: '' };
  }

  private _maybeClosePMTicket(taskId: string): void {
    if (!this._isProjectLeadMode() || !taskId) { return; }
    closePMTicket().then(result => { if (result.skipped) { return; } this._view?.webview.postMessage({ type: 'ticketClosed', taskId }); })
      .catch((err: unknown) => { vscode.window.showWarningMessage(`Ticket close failed (thread still done): ${err instanceof Error ? err.message : String(err)}`); });
  }

  private async _maybeCreateDraftPR(thread: { goal: string; taskId: string; subtasks: TyneState['subtasks']; branchName: string }): Promise<void> {
    const githubToken = await this._context.secrets.get('tyne_github_token');
    if (!githubToken) { return; }
    createDraftPR(githubToken, thread.goal, thread.taskId, thread.subtasks, thread.branchName).then(pr => {
      if (!pr) { return; }
      this._view?.webview.postMessage({ type: 'prCreated', url: pr.url, number: pr.number, title: pr.title });
      vscode.window.showInformationMessage(`Draft PR created: ${pr.title}`, 'View PR').then(choice => {
        if (choice === 'View PR') { vscode.env.openExternal(vscode.Uri.parse(pr.url)); }
      });
    }).catch((err: unknown) => { vscode.window.showWarningMessage(`PR creation failed (thread still closed): ${err instanceof Error ? err.message : String(err)}`); });
  }

  private _debouncedSave(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); }
    this._saveTimer = setTimeout(() => { saveState(this._context, this._state); }, 500);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'tyne.svg'));
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} https://*.vscode-cdn.net data:;`;
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
      --bg: #000000;
      --panel: #000000;
      --line: rgba(255,255,255,0.12);
      --line-hi: rgba(255,255,255,0.3);
      --text: #ffffff;
      --muted: #888888;
      --faint: #444444;
      --primary: #1A56DB;
      --primary-hover: #3998bf;
      --green: #38E54D;
      --amber: #E5A33D;
      --red: #ff453a;
      --sans: "Geist", "SF Pro Display", "Segoe UI", Arial, sans-serif;
      --mono: "JetBrains Mono", "SF Mono", Monaco, Consolas, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #app { height: 100%; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      line-height: 1.4;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; color: inherit; border-radius: 0; outline: none; }
    button { cursor: pointer; }
    .hidden { display: none !important; }

    .welcome { display: none; min-height: 100%; padding: 24px; align-items: center; justify-content: center; }
    .welcome.active { display: flex; }
    .welcome-card { width: 100%; border: 1px solid var(--line); padding: 24px; }
    .welcome-brand img { width: 44px; height: 44px; }
    .welcome-title { font-size: 24px; font-weight: 600; margin-top: 12px; }

    .app-shell { display: none; min-height: 100%; flex-direction: column; background: var(--bg); }
    .app-shell.active { display: flex; }

    .topbar {
      height: 64px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-around;
      flex-shrink: 0;
    }
    .top-icon {
      font-size: 28px;
      background: transparent;
      border: none;
      color: var(--muted);
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .top-icon:hover { color: var(--text); }
    .top-icon.active { color: var(--primary); border-bottom: 2px solid var(--primary); }

    .rail { display: none; }
    .shell-body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    
    .pages { flex: 1; overflow-y: auto; padding: 16px; }
    .page { display: none; }
    .page.active { display: block; }

    .section-label {
      color: var(--primary);
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin: 24px 0 12px;
    }
    .section-label::before { content: "// "; }

    .btn {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: transparent;
      color: var(--text);
      border: 1px solid var(--line-hi);
      padding: 10px 14px;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }
    .btn:hover { border-color: var(--text); }
    .btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    .btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn.primary::before { content: "[ "; color: var(--green); margin-right: 6px; }
    .btn.primary::after { content: " ]"; color: var(--green); margin-left: 6px; }
    .btn.danger { border-color: var(--red); color: var(--red); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }

    .field { margin-bottom: 12px; }
    label { display: block; font-family: var(--mono); font-size: 10px; color: var(--muted); margin-bottom: 6px; }
    input[type="text"], input[type="password"], select {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--text);
      padding: 10px;
      font-size: 13px;
      font-family: var(--mono);
    }
    input:focus, select:focus { border-color: var(--primary); }

    .workflow { border: 1px solid var(--line); padding: 12px; margin-bottom: 16px; position: relative; }
    .workflow::before, .workflow::after { content: ""; position: absolute; width: 6px; height: 6px; background: #1a1a1a; }
    .workflow::before { top: 0; left: 0; }
    .workflow::after { bottom: 0; right: 0; }
    
    .workflow-kicker { color: var(--green); font-family: var(--mono); font-size: 10px; margin-bottom: 8px; }
    .workflow-grid { display: flex; gap: 4px; margin-bottom: 12px; }
    .workflow-step { flex: 1; font-family: var(--mono); font-size: 9px; padding: 6px 2px; text-align: center; color: var(--muted); border: 1px solid var(--line); }
    .workflow-step.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    .workflow-step.done { color: var(--green); border-color: var(--green); }
    .workflow-meta { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--muted); margin-bottom: 12px; }
    
    .workflow-runner { display: none; height: 2px; background: var(--line); margin-top: 12px; }
    .workflow-runner.visible { display: block; }
    .workflow-runner-fill { height: 100%; width: 0%; background: var(--primary); }
    @keyframes fillBar { from { width: 0%; } to { width: 100%; } }

    .status-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .metric { border: 1px solid var(--line); padding: 10px; text-align: center; }
    .metric-label { font-family: var(--mono); font-size: 9px; color: var(--muted); margin-bottom: 4px; }
    .metric-value { font-family: var(--mono); font-size: 14px; color: var(--text); }
    .metric-value.blue { color: var(--primary); }
    .metric-value.green { color: var(--green); }

    .add-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .add-row input { flex: 1; }
    .btn-plus { border: 1px solid var(--line); background: transparent; color: var(--primary); width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; font-family: var(--mono); }
    .btn-plus:hover { border-color: var(--primary); }

    .subtask-item, .val-result-item, .parked-item { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); align-items: flex-start; }
    .subtask-toggle { width: 14px; height: 14px; border: 1px solid var(--line-hi); background: transparent; margin-top: 2px; flex-shrink: 0; }
    .subtask-toggle.done { background: var(--green); border-color: var(--green); }
    .subtask-text { flex: 1; font-size: 13px; }
    .subtask-text.done { color: var(--muted); text-decoration: line-through; }
    .del-btn { border: none; background: transparent; color: var(--red); font-family: var(--mono); margin-left: 8px; }

    .notice { border: 1px solid var(--line); padding: 12px; margin-bottom: 16px; font-family: var(--mono); font-size: 11px; }
    .notice.warn { border-color: var(--amber); }
    .notice.good { border-color: var(--green); }
    .notice-title { color: var(--text); margin-bottom: 8px; }
    .notice-copy { color: var(--muted); }

    .usage-row { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--muted); margin-bottom: 4px; }
    .usage-track { height: 4px; background: var(--line); }
    .usage-fill { height: 100%; background: var(--primary); }

    .task-item { border: 1px solid var(--line); padding: 12px; margin-bottom: 8px; }
    .task-title { font-weight: 600; margin-bottom: 4px; }
    .task-meta { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-bottom: 8px; }
    .tag-row { display: flex; gap: 4px; margin-bottom: 12px; }
    .tag { font-family: var(--mono); font-size: 9px; padding: 2px 4px; border: 1px solid var(--line-hi); color: var(--muted); }

    .settings-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); }
    .setting-title { font-size: 13px; }
    .setting-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .toggle { width: 36px; height: 18px; border: 1px solid var(--line); background: var(--bg); position: relative; }
    .toggle::after { content: ""; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; background: var(--muted); }
    .toggle.active { border-color: var(--primary); }
    .toggle.active::after { background: var(--primary); transform: translateX(18px); }

    .mode-grid { display: flex; gap: 8px; margin-bottom: 12px; }
    .mode-btn { flex: 1; border: 1px solid var(--line); background: transparent; color: var(--muted); font-family: var(--mono); font-size: 10px; padding: 8px 0; text-align: center; }
    .mode-btn.active { border-color: var(--primary); color: var(--primary); }

    .validation-panel { display: none; margin-top: 16px; border: 1px solid var(--line); padding: 12px; }
    .drift-panel, .prep-panel, .parked-panel, .pr-panel { display: none; }
    .drift-panel.visible, .prep-panel.visible, .parked-panel.visible, .pr-panel.visible { display: block; }
    .manual-actions { display: none !important; }
    .btn-row.three { display: flex; gap: 8px; }
    .btn-row.three .btn { flex: 1; }

    .branch-label { display: none; color: var(--green); margin-bottom: 12px; word-break: break-all; }
  </style>
</head>
<body>
<div id="app">
  <section id="welcomeView" class="welcome">
    <div class="welcome-card">
      <div class="welcome-brand" style="text-align: center; margin-bottom: 24px;">
        <img src="${logoUri}" alt="Tyne Logo" style="max-width: 140px; height: auto; display: block; margin: 0 auto;" />
      </div>
      <div class="welcome-copy" style="color: var(--muted); margin: 16px 0; font-size: 13px;">Local project lead for VS Code. Authenticate to proceed.</div>
      <div class="btn-row">
        <button class="btn primary" id="continueGithubBtn">GITHUB</button>
        <button class="btn" id="wlc-signin-trigger" type="button">SKIP</button>
      </div>
      <div class="welcome-pending" id="welcomePending" style="display: none; margin-top: 16px; border: 1px solid var(--line); padding: 12px;">
        <div class="muted" style="font-family: var(--mono); font-size: 10px;">ENTER CODE AT GITHUB</div>
        <div style="font-size:24px; font-weight:700; font-family: var(--mono); margin:8px 0; color: var(--primary);" id="pendingCode">----</div>
        <button class="btn" id="pendingLink" type="button">github.com/login/device</button>
      </div>
    </div>
  </section>

  <main id="mainView" class="app-shell active">
    <header class="topbar">
      <button class="top-icon active" title="Thread" data-nav="thread"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></button>
      <button class="top-icon" title="Tasks" data-nav="tasks"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></button>
      <button class="top-icon" title="Integrations" data-nav="integrations"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/></svg></button>
      <button class="top-icon" title="Account" data-nav="account"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></button>
      <button class="top-icon" title="Settings" data-nav="settings"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </header>
    <div id="tierBadge" style="display: none; text-align: center; font-family: var(--mono); font-size: 10px; padding: 6px; border-bottom: 1px solid var(--line); color: var(--primary); background: #111;"></div>
    <div class="shell-body">
      <section class="pages">
        <section class="page active" id="threadPage">
          
          <div class="workflow">
            <div class="workflow-kicker" id="flowKicker">00 / STANDBY</div>
            <div class="workflow-grid" id="flowSteps">
              <div class="workflow-step active">01 TASK</div>
              <div class="workflow-step">02 WEAVE</div>
              <div class="workflow-step">03 VERIFY</div>
              <div class="workflow-step">04 SHIP</div>
            </div>
            <div class="workflow-meta">
              <div><span style="color:var(--primary);">TASK:</span> <span id="flowTaskValue">-</span></div>
            </div>
            <div class="workflow-title hidden" id="flowTitle"></div>
            <div class="workflow-copy hidden" id="flowCopy"></div>
            <div class="btn-row" id="flowActions">
              <button class="btn primary" id="flowPrimaryBtn" type="button" data-flow-action="selectTask">PROCEED</button>
              <button class="btn" id="flowSecondaryBtn" type="button" data-flow-action="openAi">AI SETUP</button>
            </div>
            <div class="workflow-runner" id="flowRunner"><div class="workflow-runner-fill" id="flowRunnerFill"></div></div>
            <div class="hidden" id="flowNote"></div>
          </div>

          <div class="status-grid">
            <div class="metric"><div class="metric-label">TASK</div><div class="metric-value blue" id="pmText">-</div></div>
            <div class="metric"><div class="metric-label">STITCHES</div><div class="metric-value green" id="stitchMetric">0</div></div>
            <div class="metric"><div class="metric-label">TIME</div><div class="metric-value" id="elapsedMetric">0m</div></div>
          </div>

          <div style="margin-bottom: 24px;">
            <div class="usage-row"><span id="aiUsageLabel">BYOK AI</span><span id="aiUsageText">0 / 50</span></div>
            <div class="usage-track"><div class="usage-fill" id="aiUsageFill"></div></div>
          </div>

          <div class="notice prep-panel" id="prepPanel">
            <div class="notice-title" style="color: var(--primary);">// WORKSPACE PREP</div>
            <div id="prepLines"><div class="prep-line" style="color: var(--muted);">&gt; preparing workspace...</div></div>
          </div>

          <div class="notice warn drift-panel" id="driftPanel">
            <div class="notice-title" style="color: var(--amber);">// DRIFT DETECTED</div>
            <div class="notice-copy" id="driftFile" style="color: var(--text); margin-bottom: 4px;"></div>
            <div class="notice-copy" id="driftNote"></div>
            <div class="btn-row three" style="margin-top:12px">
              <button class="btn" data-drift-action="park">PARK</button>
              <button class="btn" data-drift-action="new_ticket">TICKET</button>
              <button class="btn" data-drift-action="dismiss">IGNORE</button>
            </div>
          </div>

          <div id="briefSection">
            <div class="section-label">THREAD BRIEF</div>
            <div class="field"><label for="appName">PROJECT / APP</label><input type="text" id="appName" placeholder="Workspace" autocomplete="off" /></div>
            <div class="field"><label for="taskId">TASK ID</label><input type="text" id="taskId" placeholder="PRO-102" autocomplete="off" /></div>
            <div class="field"><label for="goal">GOAL</label><input type="text" id="goal" placeholder="What must be true when this thread is done?" autocomplete="off" /></div>
          </div>

          <div id="deepReviewLock" class="notice warn hidden" style="border-color: var(--red); padding: 16px; margin: 16px 0; text-align: center;">
            <div style="font-family: var(--mono); color: var(--red); font-weight: bold; margin-bottom: 8px;">DEEP GOAL TRACKING LOCKED</div>
            <div style="font-size: 11px; color: var(--muted); margin-bottom: 12px;">Deep Goal Tracking & Code Review requires a MAX plan subscription or a local BYOK key.</div>
            <button class="btn primary" id="upgradeToMaxBtn" type="button">[ UPGRADE TO MAX ]</button>
          </div>

          <div id="proofSection">
            <div class="section-label">PROOF POINTS</div>
            <div id="subtaskList"></div>
            <div class="add-row">
              <span style="color: var(--green); font-family: var(--mono);">$</span>
              <input type="text" id="newSubtask" placeholder="Add a proof point..." autocomplete="off" style="border: none; border-bottom: 1px solid var(--line); background: transparent;" />
              <button class="btn-plus" id="addSubtaskBtn" title="Add">+</button>
            </div>
          </div>

          <div class="section-label" style="margin-top: 24px;">CONTROLS</div>
          <div class="branch-label mono-label" id="branchLabel"></div>
          <div class="btn-row manual-actions" id="actionButtons" aria-hidden="true" style="display: flex; flex-direction: column;">
            <button class="btn primary" id="btn-startThread" data-action="startThread">START THREAD</button>
            <div style="display: flex; gap: 8px; width: 100%;">
              <button class="btn" id="btn-saveStitch" data-action="saveStitch" style="flex: 2;">SAVE STITCH</button>
              <button class="btn danger" id="btn-undoStitch" data-action="undoStitch" style="flex: 1;">UNDO</button>
            </div>
            <button class="btn" id="btn-validateGoal" data-action="validateGoal">VALIDATE</button>
            <button class="btn primary" id="btn-tieKnot" data-action="tieKnot">TIE THE KNOT</button>
          </div>
          <div style="font-family: var(--mono); font-size: 9px; color: var(--muted); margin-top: 12px; text-align: center;" id="stitchCounter">STITCHES: <span id="stitchCountVal">0</span> / LAST <span id="lastStitchVal">--:--</span></div>

          <div class="validation-panel" id="validationPanel">
            <div class="section-label" style="margin-top: 0; color: var(--amber);">VALIDATION LOG</div>
            <div id="validationResults"></div>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn primary" id="btn-revalidate">RUN AGAIN</button>
              <button class="btn" id="btn-override">OVERRIDE</button>
            </div>
          </div>

          <div class="notice good pr-panel" id="prPanel">
            <div style="color: var(--green); margin-bottom: 8px;">&gt; Thread complete</div>
            <div id="prSummary" style="color: var(--text);">Draft PR created</div>
            <button class="btn" id="prLink" style="margin-top:12px; width: 100%;">VIEW ON GITHUB</button>
          </div>

          <div class="parked-panel" id="parkedPanel" style="margin-top: 24px;">
            <div class="section-label" id="parkedTitle">PARKED IDEAS</div>
            <div id="parkedList"></div>
            <button class="btn" id="clearParkedBtn" type="button" style="margin-top:12px;width:100%">CLEAR ALL</button>
          </div>
        </section>

        <!-- TASKS PAGE -->
        <section class="page" id="tasksPage">
          <div class="section-label">TASKS</div>
          <input type="text" id="taskSearch" placeholder="Search tasks..." autocomplete="off" style="margin-bottom: 16px;" />
          <div id="standupList"></div>
        </section>

        <!-- INTEGRATIONS PAGE -->
        <section class="page" id="integrationsPage">
          <div class="section-label">INTEGRATIONS</div>
          <div class="task-item">
            <div class="task-title">GitHub</div>
            <div class="task-meta">Draft PRs, branch push, review links</div>
            <div class="tag-row"><span class="tag">repo</span><span class="tag">pull-request</span></div>
            <button class="btn primary" id="connectGithubFromIntegrations" style="width: 100%;">CONNECT</button>
          </div>
          <div class="task-item" style="opacity: 0.5;">
            <div class="task-title">Jira / Linear</div>
            <div class="task-meta">Task source and ticket close</div>
            <div class="tag-row"><span class="tag">planning</span></div>
            <button class="btn" disabled style="width: 100%;">PENDING</button>
          </div>
        </section>

        <!-- ACCOUNT PAGE -->
        <section class="page" id="accountPage">
          <div class="section-label">ACCOUNT</div>
          <div style="border: 1px solid var(--line); padding: 16px; margin-bottom: 16px; background: var(--bg);">
            <div style="font-family: var(--mono); color: var(--text); font-weight: bold; margin-bottom: 8px;" id="accountGithubId">Not connected</div>
            <div style="font-family: var(--mono); font-size: 12px; color: var(--muted); margin-bottom: 12px;" id="accountPlanTier">Current Plan: CORE</div>
            <div id="accountCreditsContainer" style="display: none; font-family: var(--mono); font-size: 12px; color: var(--green); border-top: 1px solid var(--line); padding-top: 8px;">
              Remaining Credits: <span id="accountCreditsVal">0</span>/100
            </div>
          </div>
          <div class="btn-row" style="display: flex; flex-direction: column; gap: 8px;">
            <button class="btn primary" id="btn-manageBilling" style="width: 100%;">[ MANAGE BILLING / UPGRADE ]</button>
            <button class="btn" id="signoutBtn" style="width: 100%;">LOG OUT</button>
          </div>
        </section>

        <!-- SETTINGS PAGE -->
        <section class="page" id="settingsPage">
          <div class="section-label">API CONFIGURATION</div>
          
          <!-- Tier: CORE configuration -->
          <div id="coreConfigContainer" style="display: none;">
            <div class="notice warn" style="border-color: var(--amber); padding: 12px; margin-bottom: 16px; font-family: var(--mono); font-size: 11px;">
              <span style="color: var(--amber); font-weight: bold;">[ WARNING ]</span> Free tier requires your own API key. 
              <a href="#" id="upgradeFromSettingsLink" style="color: var(--green); text-decoration: underline;">[ Upgrade to PRO ]</a> to use Tyne's default models.
            </div>
            
            <div class="field">
              <label>API PROVIDER</label>
              <div class="mode-grid">
                <button class="mode-btn active" type="button" data-provider="claude">CLAUDE</button>
                <button class="mode-btn" type="button" data-provider="openai">OPENAI</button>
              </div>
            </div>
            
            <div class="field">
              <label for="byokApiKey">API KEY</label>
              <input type="password" id="byokApiKey" placeholder="sk-ant-... or sk-..." autocomplete="off" />
            </div>
            <button class="btn primary" id="saveByokBtn" type="button" style="margin-bottom: 8px;">SAVE KEY</button>
            <div class="setting-sub" id="byokStatus" style="margin-bottom: 24px;">No key saved.</div>
          </div>

          <!-- Tier: PRO or MAX configuration -->
          <div id="premiumConfigContainer" style="display: none;">
            <div class="notice good" style="border-color: var(--green); padding: 12px; margin-bottom: 16px; font-family: var(--mono); font-size: 12px;">
              ✓ Connected to Tyne Premium Models
            </div>

            <!-- Override with BYOK toggle -->
            <div class="field" style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
              <input type="checkbox" id="overrideByokToggle" style="width: auto; margin: 0;" />
              <label for="overrideByokToggle" style="margin: 0; cursor: pointer; font-size: 12px; font-family: var(--mono);">Override with Custom API Key (BYOK)</label>
            </div>

            <!-- Override fields (hidden by default) -->
            <div id="byokOverrideFields" style="display: none; border-top: 1px solid var(--line); padding-top: 16px;">
              <div class="field">
                <label>API PROVIDER</label>
                <div class="mode-grid">
                  <button class="mode-btn active" type="button" data-provider="claude">CLAUDE</button>
                  <button class="mode-btn" type="button" data-provider="openai">OPENAI</button>
                </div>
              </div>
              <div class="field">
                <label for="byokApiKeyPremium">API KEY</label>
                <input type="password" id="byokApiKeyPremium" placeholder="sk-ant-... or sk-..." autocomplete="off" />
              </div>
              <button class="btn primary" id="saveByokBtnPremium" type="button" style="margin-bottom: 8px;">SAVE KEY</button>
              <div class="setting-sub" id="byokStatusPremium" style="margin-bottom: 24px;">No key saved.</div>
            </div>
          </div>

          <div class="section-label">FEATURES</div>
          <div class="settings-row">
            <div><div class="setting-title">Project Lead Mode</div><div class="setting-sub">Prep repo, drift detection, synth commit.</div></div>
            <button class="toggle" data-toggle="projectLead" aria-pressed="false"></button>
          </div>
          <div class="settings-row">
            <div><div class="setting-title">Native Tool Call</div><div class="setting-sub">Use native function calling.</div></div>
            <button class="toggle active" aria-pressed="true"></button>
          </div>
          
          <div class="section-label">ABOUT</div>
          <div style="font-family: var(--mono); font-size: 14px; color: var(--text);">Tyne v0.1.0</div>
          <div style="color: var(--muted); font-size: 11px; margin-top: 8px;">Local project lead for VS Code.</div>
        </section>

      </section>
    </div>
  </main>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = { appName:'', taskId:'', goal:'', status:'waiting', subtasks:[], validationResult:null, validationOverride:false, branchName:'', stitchCount:0, lastStitchTime:'' };
  let saveTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;
  let animationMode = 'standby';
  let resetTimer = null;
  let prPanelTimer = null;
  let shippedTimer = null;
  let activeView = 'thread';
  let isAuthenticated = false;
  let projectLeadMode = false;
  let activeDriftFile = '';
  let aiCalls = 0;
  let sessionStart = 0;
  let shipped = false;
  let userTier = 'CORE';
  let userCredits = 0;
  let tasksCache = [];
  let aiSettings = { aiAccessMode:'byok', aiProvider:'claude', hasBYOKKey:false, aiUsageUsed:0, aiUsageLimit:50 };
  const fallbackTasks = [
    { id:'PRO-102', title:'Implement OAuth refresh handling and PR validation context' },
    { id:'PRO-118', title:'Tighten billing state sync before checkout handoff' },
    { id:'PRO-121', title:'Document VS Code authentication setup for reviewers' }
  ];

  vscode.postMessage({ command: 'WEBVIEW_READY' });
  vscode.postMessage({ type:'ready' });

  function $(id) { return document.getElementById(id); }
  function escHtml(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function showAppView(view) {
    activeView = view || 'thread';
    document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === activeView + 'Page'));
    document.querySelectorAll('.top-icon').forEach(btn => btn.classList.toggle('active', btn.dataset.nav === activeView));
  }

  function showScreen(screen) {
    if (screen === 'welcome') {
      $('welcomeView').classList.add('active');
      $('mainView').classList.remove('active');
      return;
    }
    $('welcomeView').classList.remove('active');
    $('mainView').classList.add('active');
    showAppView(screen === 'settings' ? 'settings' : screen === 'main' ? 'thread' : screen);
  }

  function setAuthenticated(v) {
    isAuthenticated = v;
    showScreen(v ? 'main' : 'welcome');
    const emailEl = $('accountEmail');
    if (emailEl) emailEl.textContent = v ? 'GitHub connected' : 'GitHub not connected';
    const githubIdEl = $('accountGithubId');
    if (githubIdEl && !githubIdEl.textContent.startsWith('@')) {
      githubIdEl.textContent = v ? 'GitHub connected' : 'GitHub not connected';
    }
    const connBtn = $('connectGithubFromIntegrations');
    if (connBtn) connBtn.textContent = v ? 'CONNECTED' : 'CONNECT';
    const signoutBtn = $('signoutBtn');
    if (signoutBtn) signoutBtn.disabled = !v;
  }

  function selectTask(task) {
    vscode.postMessage({ type:'standupSelect', task });
    showAppView('thread');
  }

  function runFlowAction(action) {
    if (action === 'selectTask') { selectTask(tasksCache[0] || fallbackTasks[0]); return; }
    if (action === 'startThread') { vscode.postMessage({ type:'buttonClick', action:'startThread' }); return; }
    if (action === 'saveStitch') { setMode('stitch', 1800); vscode.postMessage({ type:'buttonClick', action:'saveStitch' }); return; }
    if (action === 'validateGoal') { setMode('validate', 4000); vscode.postMessage({ type:'buttonClick', action:'validateGoal' }); return; }
    if (action === 'tieKnot') { setMode('launch', 6500); vscode.postMessage({ type:'buttonClick', action:'tieKnot' }); return; }
    if (action === 'overrideProceed') { vscode.postMessage({ type:'buttonClick', action:'overrideProceed' }); return; }
    if (action === 'openAi') { showAppView('settings'); }
  }

  function deriveMetrics() {
    const total = state.subtasks.length;
    const done = state.subtasks.filter(t => t.done).length;
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    const passed = state.validationResult && state.validationResult.overall === 'pass';
    return { total, done, percent, passed, stitchCount: state.stitchCount || 0 };
  }

  function getFlowState() {
    const hasTask = Boolean((state.taskId || '').trim());
    const hasBrief = Boolean((state.appName || '').trim() && (state.goal || '').trim());
    const weaving = state.status === 'weaving';
    const validation = state.validationResult;
    const passed = validation && validation.overall === 'pass';
    if (shipped) return { key:'done', kicker:'DONE', index:4, primary:'NEXT TASK', primaryAction:'selectTask', secondary:'', secondaryAction:'' };
    if (!hasTask) return { key:'task', kicker:'01 / SELECT TASK', index:0, primary:'SELECT TASK', primaryAction:'selectTask', secondary:'AI SETUP', secondaryAction:'openAi' };
    if (!weaving) return { key:'start', kicker:'02 / START THREAD', index:1, primary:hasBrief ? 'START THREAD' : 'COMPLETE BRIEF', primaryAction:hasBrief ? 'startThread' : 'selectTask', secondary:'AI SETUP', secondaryAction:'openAi' };
    if (weaving && (state.stitchCount || 0) < 3 && !validation) return { key:'stitch', kicker:'02 / WEAVING', index:1, primary:'SAVE STITCH', primaryAction:'saveStitch', secondary:'VALIDATE', secondaryAction:'validateGoal' };
    if (weaving && !validation) {
      const needsKey = aiSettings.aiAccessMode === 'byok' && !aiSettings.hasBYOKKey;
      return { key:'validate', kicker:'03 / VALIDATE', index:2, primary:needsKey ? 'AI SETUP' : 'VALIDATE GOAL', primaryAction:needsKey ? 'openAi' : 'validateGoal', secondary:needsKey ? 'VALIDATE ANYWAY' : 'SAVE STITCH', secondaryAction:needsKey ? 'validateGoal' : 'saveStitch' };
    }
    if (validation && !passed && !tieKnotUnlocked) return { key:'blocked', kicker:'03 / BLOCKED', index:2, primary:'RUN AGAIN', primaryAction:'validateGoal', secondary:'OVERRIDE', secondaryAction:'overrideProceed' };
    return { key:'ship', kicker:'04 / SHIP', index:3, primary:'TIE THE KNOT', primaryAction:'tieKnot', secondary:'SAVE STITCH', secondaryAction:'saveStitch' };
  }

  function renderFlow() {
    const flow = getFlowState();
    $('flowKicker').textContent = flow.kicker;
    $('flowTaskValue').textContent = state.taskId || 'NONE';
    $('flowPrimaryBtn').textContent = flow.primary;
    $('flowPrimaryBtn').dataset.flowAction = flow.primaryAction;
    $('flowSecondaryBtn').textContent = flow.secondary || '';
    $('flowSecondaryBtn').dataset.flowAction = flow.secondaryAction || '';
    $('flowSecondaryBtn').classList.toggle('hidden', !flow.secondary);
    document.querySelectorAll('#flowSteps .workflow-step').forEach((el, idx) => {
      el.classList.toggle('active', idx === Math.min(flow.index, 3));
      el.classList.toggle('done', idx < Math.min(flow.index, 3));
    });
    $('briefSection').classList.toggle('hidden', state.status === 'weaving');
    $('proofSection').classList.toggle('hidden', !state.taskId);
  }

  function renderAiUsage() {
    const used = Number(aiSettings.aiUsageUsed || 0);
    const limit = Math.max(1, Number(aiSettings.aiUsageLimit || 50));
    const pct = Math.min(100, Math.round((used / limit) * 100));
    
    if (userTier === 'MAX') {
      const usedPercent = Math.max(0, 100 - userCredits);
      $('aiUsageLabel').textContent = 'DAILY USAGE';
      $('aiUsageText').textContent = usedPercent + '%';
      $('aiUsageFill').style.width = usedPercent + '%';
      $('aiUsageFill').style.background = usedPercent > 80 ? 'var(--red)' : 'var(--green)';
    } else {
      $('aiUsageLabel').textContent = aiSettings.aiAccessMode === 'byok' ? 'BYOK AI' : 'FREE USAGE';
      $('aiUsageText').textContent = used + ' / ' + limit;
      $('aiUsageFill').style.width = pct + '%';
      $('aiUsageFill').style.background = 'var(--primary)';
    }
  }

  function fmtElapsed() {
    if (!sessionStart) return '0m';
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(s / 3600), mn = Math.floor((s % 3600) / 60);
    return h > 0 ? h + 'h ' + mn + 'm' : mn + 'm';
  }

  function setMode(mode, resetMs) {
    animationMode = mode;
    if (resetTimer) clearTimeout(resetTimer);
    const runner = $('flowRunner');
    const fill = $('flowRunnerFill');
    if (runner && fill && resetMs) {
      runner.classList.add('visible');
      fill.style.animation = 'none';
      fill.getBoundingClientRect();
      fill.style.animation = 'fillBar ' + resetMs + 'ms linear forwards';
    }
    if (resetMs) resetTimer = setTimeout(() => {
      animationMode = baseMode();
      if (runner) runner.classList.remove('visible');
      renderDeck();
    }, resetMs);
    renderDeck();
  }
  function baseMode() {
    if (shipped) return 'shipped';
    if (tieKnotUnlocked || (state.validationResult && state.validationResult.overall === 'pass')) return 'ready';
    if (state.status === 'weaving') return 'weaving';
    if (state.goal || state.appName || state.subtasks.length > 0) return 'armed';
    return 'standby';
  }

  function renderDeck() {
    const m = deriveMetrics();
    $('pmText').textContent = state.taskId || '-';
    $('stitchMetric').textContent = String(m.stitchCount);
    $('elapsedMetric').textContent = state.status === 'weaving' ? fmtElapsed() : '0m';
    renderFlow();
  }
  setInterval(renderDeck, 1000);

  function setEnabled(id, on) {
    const btn = $('btn-' + id);
    if (btn) btn.disabled = !on;
  }

  function applyStatus() {
    const weaving = state.status === 'weaving';
    const canStart = Boolean((state.appName || '').trim() && (state.goal || '').trim()) && !weaving;
    if (weaving && state.branchName) { $('branchLabel').textContent = '// BRANCH: ' + state.branchName; $('branchLabel').style.display = 'block'; }
    else $('branchLabel').style.display = 'none';

    // Update tier badge
    const badge = $('tierBadge');
    if (badge) {
      badge.style.display = 'block';
      if (userTier === 'CORE') {
        badge.innerHTML = 'CORE TIER // <a href="#" id="upgradeToProLink" style="color: var(--green); text-decoration: none;">[ UPGRADE TO PRO ]</a>';
        const link = $('upgradeToProLink');
        if (link) {
          link.onclick = (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' });
          };
        }
      } else if (userTier === 'PRO') {
        badge.innerHTML = 'PRO TIER // <a href="#" id="upgradeToMaxLink" style="color: var(--green); text-decoration: none;">[ UPGRADE TO MAX ]</a>';
        const link = $('upgradeToMaxLink');
        if (link) {
          link.onclick = (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' });
          };
        }
      } else if (userTier === 'MAX') {
        const usedPercent = Math.max(0, 100 - userCredits);
        badge.innerHTML = 'MAX TIER // DAILY USAGE: ' + usedPercent + '%';
      }
    }

    const hasBYOK = aiSettings.hasBYOKKey;
    const isCore = userTier === 'CORE';
    const isPro = userTier === 'PRO';

    // Gatekeeper controls inside UI
    const blockGoalValidation = (isCore || isPro) && !hasBYOK;
    const blockCommit = isCore && !hasBYOK;

    setEnabled('startThread', canStart);
    $('btn-startThread').style.display = weaving ? 'none' : 'block';
    setEnabled('saveStitch', weaving);
    $('btn-saveStitch').style.display = weaving ? 'block' : 'none';
    setEnabled('undoStitch', weaving && localHasStitch);
    $('btn-undoStitch').style.display = weaving ? 'block' : 'none';

    setEnabled('validateGoal', weaving && !blockGoalValidation);
    $('btn-validateGoal').style.display = weaving ? 'block' : 'none';

    setEnabled('tieKnot', tieKnotUnlocked && !blockCommit);
    $('btn-tieKnot').style.display = weaving ? 'block' : 'none';

    // Toggle locks
    $('deepReviewLock').classList.toggle('hidden', !blockGoalValidation);
    $('proofSection').classList.toggle('hidden', blockGoalValidation || !state.taskId);
    $('validationPanel').classList.toggle('hidden', blockGoalValidation || !state.validationResult);

    renderDeck();
  }

  function renderSubtasks() {
    const list = $('subtaskList');
    list.innerHTML = '';
    if (state.subtasks.length === 0) {
      list.innerHTML = '<div class="muted" style="font-family: var(--mono); font-size: 11px;">No proof points yet.</div>';
      return;
    }
    state.subtasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'subtask-item';
      item.innerHTML = '<button class="subtask-toggle ' + (task.done ? 'done' : '') + '" data-id="' + escHtml(task.id) + '"></button><span class="subtask-text ' + (task.done ? 'done' : '') + '">' + escHtml(task.text) + '</span><button class="del-btn" data-id="' + escHtml(task.id) + '">X</button>';
      list.appendChild(item);
    });
    list.querySelectorAll('.subtask-toggle').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type:'subtaskToggle', id:btn.dataset.id })));
    list.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => vscode.postMessage({ type:'subtaskDelete', id:btn.dataset.id })));
  }

  function renderStitchCounter() {
    $('stitchCountVal').textContent = String(state.stitchCount || 0);
    $('lastStitchVal').textContent = state.lastStitchTime || '--:--';
  }

  function renderValidation() {
    const panel = $('validationPanel'), r = state.validationResult;
    if (!r) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const c = $('validationResults');
    c.innerHTML = '<div style="color: var(--text); font-family: var(--mono); font-size: 10px; margin-bottom:12px">' + escHtml(r.summary || '') + '</div>';
    (r.results || []).forEach(item => {
      const d = document.createElement('div');
      d.className = 'val-result-item';
      d.innerHTML = '<span class="' + (item.passed ? 'green' : 'red') + '">' + (item.passed ? 'ok' : 'x') + '</span><span style="font-size:11px;"><strong>' + escHtml(item.subtask) + '</strong><br><span class="muted">' + escHtml(item.reason || '') + '</span></span>';
      c.appendChild(d);
    });
  }

  function renderPrepStarted() {
    $('prepPanel').classList.add('visible');
    $('prepLines').innerHTML = '<div class="prep-line" style="color: var(--text);">&gt; checking workspace...</div><div class="prep-line" style="color: var(--text);">&gt; preparing pull...</div>';
  }
  function renderPrepComplete(msg) {
    $('prepPanel').classList.add('visible');
    if (msg.error) { $('prepLines').innerHTML = '<div class="prep-line" style="color: var(--red);">&gt; workspace prep failed</div><div class="muted">' + escHtml(msg.error) + '</div>'; return; }
    $('prepLines').innerHTML =
      '<div class="prep-line" style="color: var(--green);">&gt; ' + (msg.stashed ? 'changes stashed' : 'stash not needed') + '</div>' +
      '<div class="prep-line" style="color: var(--green);">&gt; ' + escHtml(msg.pullSummary || 'No remote') + '</div>' +
      '<div class="prep-line" style="color: ' + (msg.clean ? 'var(--green)' : 'var(--red)') + ';">&gt; workspace clean</div>';
  }

  function renderDrift(e) {
    activeDriftFile = e.file || '';
    $('driftPanel').classList.toggle('visible', Boolean(activeDriftFile));
    $('driftFile').textContent = activeDriftFile ? activeDriftFile + ' MODIFIED' : '';
    $('driftNote').textContent = 'Severity: ' + (e.severity || 'medium');
  }
  function clearDrift(file) {
    if (!file || file === activeDriftFile) {
      activeDriftFile = '';
      $('driftPanel').classList.remove('visible');
    }
  }

  function renderParkedIdeas(ideas) {
    const safe = Array.isArray(ideas) ? ideas : [];
    $('parkedPanel').classList.toggle('visible', safe.length > 0);
    $('parkedTitle').textContent = 'PARKED IDEAS (' + safe.length + ')';
    $('parkedList').innerHTML = '';
    safe.forEach(idea => {
      const row = document.createElement('div');
      row.className = 'parked-item';
      row.innerHTML = '<span style="color:var(--green);">&gt;</span><span style="font-size:11px;">' + escHtml(idea) + '</span>';
      $('parkedList').appendChild(row);
    });
  }

  function renderTasks(tasks) {
    const incoming = Array.isArray(tasks) ? tasks.filter(task => task && task.id && task.title).slice(0, 8) : [];
    tasksCache = incoming.length > 0 ? incoming : fallbackTasks;
    const list = $('standupList');
    list.innerHTML = '';
    const query = ($('taskSearch').value || '').trim().toLowerCase();
    const filtered = query ? tasksCache.filter(task => (task.id + ' ' + task.title).toLowerCase().includes(query)) : tasksCache;
    if (filtered.length === 0) {
      list.innerHTML = '<div class="muted">No tasks match.</div>';
      return;
    }
    filtered.forEach((task, idx) => {
      const row = document.createElement('div');
      row.className = 'task-item';
      row.innerHTML = '<div class="task-title">' + escHtml(task.title || '') + '</div><div class="task-meta">' + escHtml(task.id || '') + '</div><button class="btn primary" type="button" style="width: 100%;">START</button>';
      row.querySelector('button').addEventListener('click', () => selectTask(task));
      list.appendChild(row);
    });
  }

  function showPRCreated(pr) {
    const panel = $('prPanel'), link = $('prLink');
    $('prSummary').textContent = 'PR #' + pr.number + ' created';
    link.dataset.url = pr.url;
    panel.classList.add('visible');
    if (prPanelTimer) clearTimeout(prPanelTimer);
    prPanelTimer = setTimeout(() => { panel.classList.remove('visible'); link.dataset.url = ''; }, 8000);
  }
  function showShipComplete(msg) {
    $('prSummary').textContent = msg.pushed ? ('Branch ' + (msg.branch || '') + ' pushed') : 'Committed locally';
    $('prPanel').classList.add('visible');
  }

  function renderSettings(s) {
    projectLeadMode = Boolean(s.projectLeadMode);
    aiSettings = {
      aiAccessMode: s.aiAccessMode || 'byok',
      aiProvider: s.aiProvider || 'claude',
      hasBYOKKey: Boolean(s.hasBYOKKey),
      aiUsageUsed: Number(s.aiUsageUsed || 0),
      aiUsageLimit: Number(s.aiUsageLimit || 50)
    };
    userTier = s.userTier || 'CORE';
    userCredits = s.userCredits || 0;
    
    const tg = document.querySelector('[data-toggle="projectLead"]');
    if (tg) { tg.classList.toggle('active', projectLeadMode); tg.setAttribute('aria-pressed', String(projectLeadMode)); }
    
    // Update Account Tab profile info
    const githubIdEl = $('accountGithubId');
    if (githubIdEl) {
      if (s.githubUsername) githubIdEl.textContent = '@' + s.githubUsername;
      else if (!githubIdEl.textContent.startsWith('@')) githubIdEl.textContent = isAuthenticated ? 'Connected' : 'Not connected';
    }
    const planTierEl = $('accountPlanTier');
    if (planTierEl) {
      planTierEl.textContent = 'Current Plan: ' + userTier;
    }
    const creditsContainer = $('accountCreditsContainer');
    if (creditsContainer) {
      if (userTier === 'MAX') {
        creditsContainer.style.display = 'block';
        const usedPercent = Math.max(0, 100 - userCredits);
        creditsContainer.innerHTML = 'Daily Usage: <span id="accountCreditsVal">' + usedPercent + '</span>%';
      } else {
        creditsContainer.style.display = 'none';
      }
    }

    // Update Settings Tab plan-based rendering
    if (userTier === 'CORE') {
      $('coreConfigContainer').style.display = 'block';
      $('premiumConfigContainer').style.display = 'none';
      $('byokStatus').textContent = aiSettings.hasBYOKKey ? 'Key saved.' : 'No key saved.';
    } else {
      $('coreConfigContainer').style.display = 'none';
      $('premiumConfigContainer').style.display = 'block';
      
      const overrideToggle = $('overrideByokToggle');
      if (overrideToggle) {
        const isOverride = aiSettings.aiAccessMode === 'byok';
        overrideToggle.checked = isOverride;
        $('byokOverrideFields').style.display = isOverride ? 'block' : 'none';
      }
      $('byokStatusPremium').textContent = aiSettings.hasBYOKKey ? 'Key saved.' : 'No key saved.';
    }

    // Highlight selected provider button
    document.querySelectorAll('[data-provider]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.provider === aiSettings.aiProvider);
    });

    renderAiUsage();
    renderParkedIdeas(s.parkedIdeas || []);
    applyStatus();
  }

  function applyState() {
    $('appName').value = state.appName || '';
    $('taskId').value = state.taskId || '';
    $('goal').value = state.goal || '';
    localHasStitch = (state.stitchCount || 0) > 0 && state.status === 'weaving';
    tieKnotUnlocked = state.validationOverride || (state.validationResult && state.validationResult.overall === 'pass');
    if (state.status === 'weaving' && !sessionStart) sessionStart = Date.now();
    renderSubtasks();
    renderStitchCounter();
    renderValidation();
    renderAiUsage();
    applyStatus();
  }

  ['appName','taskId','goal'].forEach(id => {
    $(id).addEventListener('input', e => {
      state[id] = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => vscode.postMessage({ type:'fieldChange', field:id, value:e.target.value }), 500);
      applyStatus();
    });
  });
  $('addSubtaskBtn').addEventListener('click', () => {
    const input = $('newSubtask');
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type:'subtaskAdd', text });
    input.value = '';
  });
  $('newSubtask').addEventListener('keydown', e => { if (e.key === 'Enter') $('addSubtaskBtn').click(); });

  document.querySelectorAll('[data-nav]').forEach(btn => btn.addEventListener('click', () => showAppView(btn.dataset.nav)));
  document.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const a = btn.dataset.action;
    if (a === 'saveStitch') setMode('stitch', 1800);
    if (a === 'validateGoal') setMode('validate', 4000);
    if (a === 'tieKnot') setMode('launch', 6500);
    vscode.postMessage({ type:'buttonClick', action:a });
  }));
  $('flowPrimaryBtn').addEventListener('click', () => runFlowAction($('flowPrimaryBtn').dataset.flowAction));
  $('flowSecondaryBtn').addEventListener('click', () => runFlowAction($('flowSecondaryBtn').dataset.flowAction));
  $('btn-revalidate').addEventListener('click', () => runFlowAction('validateGoal'));
  $('btn-override').addEventListener('click', () => runFlowAction('overrideProceed'));
  $('upgradeToMaxBtn').addEventListener('click', () => { vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' }); });
  $('continueGithubBtn').addEventListener('click', () => { $('continueGithubBtn').disabled = true; $('wlc-signin-trigger').disabled = true; vscode.postMessage({ type:'continueWithGitHub' }); });
  $('wlc-signin-trigger').addEventListener('click', () => { showScreen('main'); });
  $('signoutBtn').addEventListener('click', () => { vscode.postMessage({ type:'logout' }); });
  $('connectGithubFromIntegrations').addEventListener('click', () => { vscode.postMessage({ type:'continueWithGitHub' }); });
  $('clearParkedBtn').addEventListener('click', () => { vscode.postMessage({ type:'parkedIdeasClear' }); });
  $('saveByokBtn').addEventListener('click', () => { vscode.postMessage({ type:'saveByokKey', apiKey:$('byokApiKey').value, provider:aiSettings.aiProvider }); $('byokApiKey').value = ''; });
  $('saveByokBtnPremium').addEventListener('click', () => { vscode.postMessage({ type:'saveByokKey', apiKey:$('byokApiKeyPremium').value, provider:aiSettings.aiProvider }); $('byokApiKeyPremium').value = ''; });
  $('btn-manageBilling').addEventListener('click', () => { vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/account/billing' }); });
  $('upgradeFromSettingsLink').addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' }); });
  $('overrideByokToggle').addEventListener('change', (e) => {
    const checked = e.target.checked;
    $('byokOverrideFields').style.display = checked ? 'block' : 'none';
    vscode.postMessage({ type: 'settingChange', key: 'aiAccessMode', value: checked ? 'byok' : 'max' });
  });
  $('prLink').addEventListener('click', () => { if ($('prLink').dataset.url) vscode.postMessage({ type:'openExternal', url:$('prLink').dataset.url }); });
  $('pendingLink').addEventListener('click', () => { if ($('pendingLink').dataset.url) vscode.postMessage({ type:'openExternal', url:$('pendingLink').dataset.url }); });

  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const isOff = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(isOff));
      btn.classList.toggle('active', isOff);
      if (btn.dataset.toggle === 'projectLead') {
        vscode.postMessage({ type:'settingChange', key:'projectLeadMode', value:isOff });
      }
    });
  });

  document.querySelectorAll('[data-provider]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prov = btn.dataset.provider;
      vscode.postMessage({ type:'settingChange', key:'byokProvider', value:prov });
    });
  });

  $('taskSearch').addEventListener('input', () => renderTasks(tasksCache));

  document.addEventListener('click', e => {
    const driftBtn = e.target.closest('[data-drift-action]');
    if (driftBtn) vscode.postMessage({ type:'driftAction', file:activeDriftFile, action:driftBtn.dataset.driftAction });
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'stateLoaded') {
      state = Object.assign(state, msg.state);
      applyState();
      showScreen(isAuthenticated ? 'main' : 'welcome');
    }
    else if (msg.command === 'HYDRATE_PROFILE') {
      userTier = msg.payload.tier || 'CORE';
      userCredits = msg.payload.credits || 0;
      
      const githubIdEl = $('accountGithubId');
      if (githubIdEl) githubIdEl.textContent = msg.payload.githubUsername ? '@' + msg.payload.githubUsername : (isAuthenticated ? 'Connected' : 'Not connected');
      const planTierEl = $('accountPlanTier');
      if (planTierEl) planTierEl.textContent = 'Current Plan: ' + userTier;
      const creditsContainer = $('accountCreditsContainer');
      if (creditsContainer) {
        if (userTier === 'MAX') {
          creditsContainer.style.display = 'block';
          const usedPercent = Math.max(0, 100 - userCredits);
          creditsContainer.innerHTML = 'Daily Usage: <span id="accountCreditsVal">' + usedPercent + '</span>%';
        } else {
          creditsContainer.style.display = 'none';
        }
      }
      if (userTier === 'CORE') {
        $('coreConfigContainer').style.display = 'block';
        $('premiumConfigContainer').style.display = 'none';
      } else {
        $('coreConfigContainer').style.display = 'none';
        $('premiumConfigContainer').style.display = 'block';
      }
      applyStatus();
      renderAiUsage();
    }
    else if (msg.type === 'settingsLoaded') { renderSettings(msg); }
    else if (msg.type === 'prepStarted') { renderPrepStarted(); }
    else if (msg.type === 'prepComplete') { renderPrepComplete(msg); }
    else if (msg.type === 'driftDetected') { renderDrift(msg.event); }
    else if (msg.type === 'driftDismissed' || msg.type === 'driftParked') { clearDrift(msg.file); }
    else if (msg.type === 'parkedIdeaSaved') { renderParkedIdeas(msg.parkedIdeas); clearDrift(); }
    else if (msg.type === 'aiSettingsSaved') { $('byokApiKey').value = ''; }
    else if (msg.type === 'standupReady') { renderTasks(msg.tasks || []); }
    else if (msg.type === 'AUTH_STATE_CHANGE') { setAuthenticated(Boolean(msg.isAuthenticated)); }
    else if (msg.type === 'githubConnectStatus') {
      if (msg.status === 'pending') {
        $('welcomePending').style.display = 'block';
        $('pendingCode').textContent = msg.userCode || '----';
        $('pendingLink').textContent = (msg.verificationUri || 'https://github.com/login/device').replace('https://','');
        $('pendingLink').dataset.url = msg.verificationUri || 'https://github.com/login/device';
      } else if (msg.status === 'error') {
        $('continueGithubBtn').disabled = false;
        $('wlc-signin-trigger').disabled = false;
        $('welcomePending').style.display = 'none';
      }
    }
    else if (msg.type === 'statusChanged') { state.status = msg.status; state.branchName = msg.branchName || state.branchName; if (state.status === 'weaving') sessionStart = Date.now(); applyStatus(); }
    else if (msg.type === 'stitchSaved') { state.stitchCount = msg.stitchCount; state.lastStitchTime = msg.lastStitchTime; localHasStitch = true; renderStitchCounter(); applyStatus(); }
    else if (msg.type === 'stitchUndone') { state.stitchCount = msg.stitchCount; renderStitchCounter(); applyStatus(); }
    else if (msg.type === 'hasStitch') { localHasStitch = msg.value; applyStatus(); }
    else if (msg.type === 'validationComplete') { state.validationResult = msg.result; tieKnotUnlocked = msg.result.overall === 'pass'; aiCalls += 1; renderValidation(); applyStatus(); }
    else if (msg.type === 'tieKnotUnlocked') { state.validationOverride = true; tieKnotUnlocked = true; applyStatus(); }
    else if (msg.type === 'stateCleared') {
      shipped = true;
      showShipComplete(msg);
      if (shippedTimer) clearTimeout(shippedTimer);
      shippedTimer = setTimeout(() => {
        shipped = false; sessionStart = 0; aiCalls = 0;
        state = { appName:'', taskId:'', goal:'', status:'waiting', subtasks:[], validationResult:null, validationOverride:false, branchName:'', stitchCount:0, lastStitchTime:'' };
        localHasStitch = false; tieKnotUnlocked = false; activeDriftFile = '';
        $('prepPanel').classList.remove('visible'); $('driftPanel').classList.remove('visible');
        applyState();
      }, 9000);
    }
    else if (msg.type === 'prCreated') { showPRCreated(msg); }
  });
</script>
</body>
</html>`
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
