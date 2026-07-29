import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { stopDriftDetection } from '../driftDetector';
import { getJiraIntegrationSnapshot } from '../jiraProvider';
import { fetchPMTasksForStandup } from '../pmIntegration';
import { normalizeTier } from '../codeValidationService';

type SettingsByokHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'userProfile'
  | 'postMessage'
  | 'byokKeyService'
  | 'usageService'
  | 'displayService'
  | 'agentDebugLog'
  | 'isProjectLeadMode'
  | 'startProjectLeadWatcher'
  | 'buildPmIntegrationSnapshot'
>;

export class SettingsByokController {
  constructor(private readonly host: SettingsByokHost) {}

  getParkedIdeas(): string[] {
    return this.host.context.workspaceState.get<string[]>('tyne.parkedIdeas', []);
  }

  async setParkedIdeas(ideas: string[]): Promise<void> {
    await this.host.context.workspaceState.update('tyne.parkedIdeas', ideas);
  }

  getAiAccessMode(): 'byok' | 'max' {
    return this.host.context.workspaceState.get<'byok' | 'max'>('tyne.aiAccessMode', 'byok');
  }

  async postSettings(): Promise<void> {
    const projectLeadMode = this.host.isProjectLeadMode();
    const aiAccessMode = this.getAiAccessMode();
    const aiProvider = vscode.workspace.getConfiguration('tyne').get<'claude' | 'openai'>('byokProvider', 'claude');
    const byokConfig = await this.host.byokKeyService.getConfig();
    const hasBYOKKey = await this.host.byokKeyService.hasApiKey();
    const jiraIntegration = await getJiraIntegrationSnapshot(this.host.context);
    const pmIntegration = await this.host.buildPmIntegrationSnapshot(jiraIntegration);
    const connectedTools = pmIntegration.connectedTools;
    const tier = normalizeTier(this.host.userProfile.tier);
    const usageSummary = await this.host.usageService.getUsageSummary(tier).catch(() => undefined);
    const aiUsageUsed = usageSummary?.used ?? 0;
    const aiUsageLimit = usageSummary?.limit === 'unlimited' ? -1 : usageSummary?.limit ?? 50;
    // #region agent log
    this.host.agentDebugLog({
      runId: 'audit1',
      hypothesisId: 'A',
      location: 'TyneSidebarProvider.ts:_postSettings',
      message: 'host settingsLoaded payload',
      data: {
        jiraConnected: Boolean(jiraIntegration?.connected),
        linearConnected: Boolean(pmIntegration?.linear?.connected),
        connectedTools: connectedTools || [],
        pmJiraConnected: Boolean(pmIntegration?.jira?.connected),
        githubConnected: Boolean(pmIntegration?.githubConnected),
      },
    });
    // #endregion
    this.host.postMessage({
      type: 'settingsLoaded',
      projectLeadMode,
      parkedIdeas: this.getParkedIdeas(),
      aiAccessMode,
      aiProvider,
      hasBYOKKey,
      byokConfig,
      jiraIntegration,
      pmIntegration,
      connectedTools,
      aiUsageUsed,
      aiUsageLimit,
      userTier: this.host.userProfile.tier,
      userCredits: this.host.userProfile.credits,
      githubUsername: this.host.userProfile.githubUsername || '',
      validationUsage: usageSummary,
      validationUsageText: usageSummary ? this.host.displayService.formatUsageSummary(usageSummary) : 'Validations: loading...',
      validationResult: this.host.state.validationResult,
    });
    this.host.postMessage({
      command: 'HYDRATE_PROFILE',
      payload: {
        tier: this.host.userProfile.tier,
        credits: this.host.userProfile.credits,
        githubUsername: this.host.userProfile.githubUsername || '',
        githubId: this.host.userProfile.githubId || '',
      }
    });
    fetchPMTasksForStandup().then(tasks => {
      this.host.postMessage({ type: 'standupReady', tasks });
    }).catch(() => {
      this.host.postMessage({ type: 'standupReady', tasks: [] });
    });
  }

  async handleSettingChange(key: string, value: unknown): Promise<void> {
    if (key === 'aiAccessMode') {
      await this.host.context.workspaceState.update('tyne.aiAccessMode', value === 'max' ? 'max' : 'byok');
      this.postSettings();
      return;
    }
    if (key === 'byokProvider') {
      const provider = value === 'openai' ? 'openai' : 'claude';
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('tyne').update('byokProvider', provider, target);
      this.postSettings();
      return;
    }
    if (key !== 'projectLeadMode') { return; }
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('tyne').update('projectLeadMode', Boolean(value), target);
    if (!value) { stopDriftDetection(); } else if (this.host.state.status === 'weaving') { this.host.startProjectLeadWatcher(); }
    this.postSettings();
  }

  async saveJiraSettings(msg: { assignedToMe?: boolean }): Promise<void> {
    const config = vscode.workspace.getConfiguration('tyne');
    const assignedToMe = typeof msg.assignedToMe === 'boolean' ? msg.assignedToMe : true;

    // Jira site/project selection is managed by Tyne after hosted OAuth.
    // Do not write hidden cloud/project metadata to user-visible VS Code settings.
    await config.update('jira.assignedToMe', assignedToMe, vscode.ConfigurationTarget.Workspace);
    await this.postSettings();
  }

  async saveByokKey(apiKey: string, provider: string): Promise<void> {
    const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!trimmed) {
      vscode.window.showErrorMessage('Enter an API key before saving.');
      return;
    }
    const normalizedProvider = provider === 'openai' ? 'openai' : 'anthropic';
    await this.host.byokKeyService.saveApiKey(normalizedProvider, trimmed);
    await this.handleSettingChange('byokProvider', provider);
    await this.host.context.workspaceState.update('tyne.aiAccessMode', 'byok');
    this.host.postMessage({ type: 'aiSettingsSaved', provider: normalizedProvider, maskedKey: await this.host.byokKeyService.getMaskedKey(normalizedProvider) });
    this.postSettings();
    vscode.window.showInformationMessage('Tyne API key saved securely.');
  }

  async deleteByokKey(): Promise<void> {
    const provider = await this.host.byokKeyService.getSelectedProvider();
    if (provider) {
      await this.host.byokKeyService.deleteApiKey(provider);
    }
    this.host.postMessage({ type: 'byokKeyDeleted' });
    this.postSettings();
    vscode.window.showInformationMessage('BYOK key removed.');
  }

  async testByokKey(provider: string): Promise<void> {
    const normalized = provider === 'openai' ? 'openai' : 'anthropic';
    const result = await this.host.byokKeyService.testApiKey(normalized);
    this.host.postMessage({ type: 'byokKeyTested', provider: normalized, ok: result.ok, error: result.error });
  }
}
