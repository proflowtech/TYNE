import * as vscode from 'vscode';
import type { SettingsByokController } from './settingsByokController';
import type { ComplianceExportController } from './complianceExportController';
import type { StoryDecompositionController } from './storyDecompositionController';
import type { BetaBugController } from './betaBugController';
import type { FindingFixController } from './findingFixController';
import type { TimeAnalyticsController } from './timeAnalyticsController';
import type { OnboardingController } from './onboardingController';
import type { TyneState } from '../stateManager';
import type {
  TynePmTool,
  TyneTaskFilters,
  TyneTaskSort,
  TyneAdvancedTaskFilters,
  TyneAdvancedTaskSort,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
} from '../taskTypes';
import type { TyneTaskAutomationSettings, TyneMaxFeedbackSection } from '../automationTypes';
import type { ManualTimeEntryInput } from '../timeTypes';
import { getBranchByTaskId } from '../branchMetadataService';
import { openFindingInEditor, clearReviewDiagnostics } from '../reviewDiagnosticsService';
import { startActiveTaskSync, stopActiveTaskSync } from '../realTimeSyncService';

type ReviewMode = 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr';

export type MessageRouterDeps = {
  context: vscode.ExtensionContext;
  state: TyneState;
  isAuthenticated: boolean;
  analyticsTaskId: string | undefined;
  settingsByok: SettingsByokController;
  complianceExport: ComplianceExportController;
  storyDecomposition: StoryDecompositionController;
  betaBug: BetaBugController;
  findingFix: FindingFixController;
  timeAnalytics: TimeAnalyticsController;
  onboarding: OnboardingController;
  agentDebugLog: (payload: Record<string, unknown>) => void;
  updateProfile: (force?: boolean) => Promise<void>;
  postState: () => void;
  postSettings: () => Promise<void>;
  handleFieldChange: (field: string, value: string) => void;
  handleSubtaskAdd: (text: string) => void;
  handleSubtaskToggle: (id: string) => void;
  handleSubtaskDelete: (id: string) => void;
  handleBillingCheckout: (plan: string) => Promise<void>;
  continueWithGitHub: () => Promise<void>;
  reconnectGitHub: () => Promise<void>;
  logout: () => Promise<void>;
  continueWithDeviceAuth: () => Promise<void>;
  cancelDeviceAuth: (reason: string) => void;
  connectPmTool: (tool: TynePmTool) => Promise<void>;
  disconnectPmTool: (tool: TynePmTool) => Promise<void>;
  changeJiraProject: () => void;
  handleValidationHistoryRequest: (filters?: unknown) => Promise<void>;
  handleValidationTrendsRequest: () => Promise<void>;
  handleReviewTrendsRequest: () => Promise<void>;
  handleExportValidationHistory: (format: 'csv' | 'json', filters?: unknown) => Promise<void>;
  handleDriftAction: (file: string, action: string) => Promise<void>;
  setParkedIdeas: (ideas: string[]) => Promise<void>;
  handleStandupSelect: (task: unknown) => Promise<void>;
  switchToBranch: (branchName: string) => Promise<void>;
  deleteBranch: (branchName: string) => Promise<void>;
  refreshBranchContext: (postMessage: boolean) => Promise<void>;
  refreshCommitContext: (postMessage: boolean, maxCommits?: number) => Promise<void>;
  refreshTimeContext: (postMessage: boolean) => Promise<void>;
  refreshAutomationContext: (postMessage: boolean) => Promise<void>;
  refreshTasksContext: (postMessage: boolean) => Promise<void>;
  refreshGitStatus: () => Promise<void>;
  pullTasks: (tool?: TynePmTool) => Promise<void>;
  openTaskDetail: (taskId: string, tool: TynePmTool) => Promise<void>;
  selectTaskIntoThread: (taskId: string, tool: TynePmTool) => Promise<void>;
  retryPmEnrichment: () => Promise<void>;
  switchTaskInThread: (taskId: string, tool: TynePmTool) => Promise<void>;
  fetchAndPostPmTaskIntelligence: (taskId: string, forceRefresh: boolean) => Promise<void>;
  queryTasks: (query: string, filters: TyneTaskFilters, sort: TyneTaskSort) => void;
  queryTasksAdvanced: (query: string, filters: TyneAdvancedTaskFilters, sort: TyneAdvancedTaskSort) => void;
  listPresets: () => void;
  savePreset: (msg: unknown) => Promise<void>;
  renamePreset: (id: string, name: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  setDefaultPreset: (id: string) => Promise<void>;
  applyPreset: (id: string) => void;
  createTask: (input: TyneCreateTaskInput) => Promise<void>;
  updateTask: (taskId: string, sourceTool: TynePmTool, input: TyneUpdateTaskInput) => Promise<void>;
  addSubtask: (taskId: string, sourceTool: TynePmTool, input: { title: string; assigneeId?: string; dueDate?: string }) => Promise<void>;
  addComment: (taskId: string, sourceTool: TynePmTool, body: string) => Promise<void>;
  checkCapabilities: (tool: TynePmTool) => Promise<void>;
  detectConflict: (taskId: string, tool: TynePmTool) => Promise<void>;
  startThreadFromTask: (taskId: string, title: string, tool: TynePmTool, url?: string) => Promise<void>;
  runCodeReview: (mode: ReviewMode) => Promise<void>;
  runValidateReview: (
    scope?: string,
    selectedCommitSha?: string,
    opts?: { acknowledgeScopeBlowout?: boolean },
  ) => Promise<void>;
  postValidateReviewReports: () => Promise<void>;
  handleFindingFeedback: (feedback: Record<string, unknown>) => Promise<void>;
  addTeamLearning: (learning: Record<string, unknown>) => Promise<void>;
  removeTeamLearning: (payload: Record<string, unknown>) => Promise<void>;
  openLearningsFile: () => Promise<void>;
  createTaskFromFinding: (finding: Record<string, unknown>) => Promise<void>;
  openFindingPanel: (finding: Record<string, unknown>) => Promise<void>;
  fixPendingGoal: (goal: Record<string, unknown>) => Promise<void>;
  pendingGoalFeedback: (goal: Record<string, unknown>) => Promise<void>;
  handleMarkTaskDone: () => Promise<void>;
  handlePostFeedback: (bodyOverride?: string) => Promise<void>;
  handleCompleteAndFeedback: (bodyOverride?: string) => Promise<void>;
  handlePreviewFeedback: () => Promise<void>;
  handleSaveAutomationSettings: (settings: TyneTaskAutomationSettings) => Promise<void>;
  handleSaveMaxReportSettings: (sections: TyneMaxFeedbackSection[]) => Promise<void>;
  handleReinstallCommitHook: () => Promise<void>;
  getRepositoryPath: () => string;
  jiraKeyFromUrl: (url: string) => string;
  logJira: (message: string) => void;
  startThread: () => Promise<void>;
  saveStitch: () => Promise<void>;
  undoStitch: () => Promise<void>;
  generateCommitPreview: () => Promise<void>;
  overrideProceed: () => Promise<void>;
  tieTheKnot: () => Promise<void>;
};

export class MessageRouter {
  constructor(private readonly deps: MessageRouterDeps) {}

  async handle(msg: any): Promise<void> {
        if (msg.command === 'WEBVIEW_READY') {
          console.log('HOST: Received WEBVIEW_READY, fetching profile...');
          // #region agent log
          this.deps.agentDebugLog({
            runId: 'audit1',
            hypothesisId: 'BOOT',
            location: 'TyneSidebarProvider.ts:WEBVIEW_READY',
            message: 'host received WEBVIEW_READY',
            data: {
              extensionPath: this.deps.context.extensionPath,
              isAuthenticated: this.deps.isAuthenticated,
            },
          });
          // #endregion
          if (this.deps.isAuthenticated) {
            void this.deps.updateProfile();
          }
          return;
        }
        switch (msg.type) {
          case 'ready':
            this.deps.postState();
            if (this.deps.isAuthenticated) {
              void this.deps.updateProfile();
            }
            break;
          case 'debugLog':
            this.deps.agentDebugLog(msg.payload as Record<string, unknown>);
            break;
          case 'fieldChange': this.deps.handleFieldChange(msg.field as string, msg.value as string); break;
          case 'subtaskAdd': this.deps.handleSubtaskAdd(msg.text as string); break;
          case 'subtaskToggle': this.deps.handleSubtaskToggle(msg.id as string); break;
          case 'subtaskDelete': this.deps.handleSubtaskDelete(msg.id as string); break;
          case 'buttonClick': await this.handleButtonClick(msg.action as string); break;
          case 'openExternal':
            if (typeof msg.url === 'string') {
              const jiraKey = this.deps.jiraKeyFromUrl(msg.url);
              if (jiraKey) { this.deps.logJira(`Opening Jira task externally: ${jiraKey}`); }
              vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            break;
          case 'startBillingCheckout':
            await this.deps.handleBillingCheckout(String(msg.plan || ''));
            break;
          case 'continueWithGitHub': await this.deps.continueWithGitHub(); break;
          case 'reconnectGitHub': await this.deps.reconnectGitHub(); break;
          case 'logout': await this.deps.logout(); break;
          case 'deviceAuthRetry': await this.deps.continueWithDeviceAuth(); break;
          case 'deviceAuthCancel': this.deps.cancelDeviceAuth('user_cancel'); break;
          case 'onboardingGetStatus': this.deps.onboarding.postStatus(); break;
          case 'onboardingSkipTour':
            await this.deps.onboarding.skipTour();
            if (this.deps.isAuthenticated) { await this.deps.postSettings(); }
            break;
          case 'onboardingChooseSolo': await this.deps.onboarding.prepareSoloPath(); this.deps.postState(); break;
          case 'onboardingChoosePm': await this.deps.onboarding.markPmPathChosen(); break;
          case 'onboardingOpenedThread': await this.deps.onboarding.setStep('thread'); break;
          case 'onboardingOpenedReview': await this.deps.onboarding.setStep('review'); break;
          case 'onboardingComplete': await this.deps.onboarding.complete(); break;
          case 'onboardingFirstReviewDone': await this.deps.onboarding.markFirstReviewDone(); break;
          case 'settingChange': await this.deps.settingsByok.handleSettingChange(msg.key as string, msg.value); break;
          case 'saveJiraSettings': await this.deps.settingsByok.saveJiraSettings(msg); break;
          case 'connectJira':
            await this.deps.settingsByok.saveJiraSettings(msg);
            await this.deps.connectPmTool('jira');
            break;
          case 'changeJiraProject':
            this.deps.changeJiraProject();
            break;
          case 'saveByokKey': await this.deps.settingsByok.saveByokKey(msg.apiKey as string, msg.provider as string); break;
          case 'deleteByokKey': await this.deps.settingsByok.deleteByokKey(); break;
          case 'testByokKey': await this.deps.settingsByok.testByokKey(msg.provider as string); break;
          case 'getValidationHistory': await this.deps.handleValidationHistoryRequest(msg.filters); break;
          case 'getValidationTrends': await this.deps.handleValidationTrendsRequest(); break;
          case 'getReviewTrends': await this.deps.handleReviewTrendsRequest(); break;
          case 'exportValidationHistory': await this.deps.handleExportValidationHistory(msg.format as 'csv' | 'json', msg.filters); break;
          case 'exportComplianceEvidence': await this.deps.complianceExport.exportComplianceEvidence(msg.format as string, msg.report as Record<string, unknown>); break;
          case 'exportValidateReviewPdf': await this.deps.complianceExport.exportValidateReviewPdf(msg.report as Record<string, unknown>); break;
          case 'complianceFindingWorkflow': await this.deps.complianceExport.handleFindingWorkflow(msg as Record<string, unknown>); break;
          case 'listCustomCompliancePolicies': await this.deps.complianceExport.listCustomPolicies(); break;
          case 'createCustomCompliancePolicy': await this.deps.complianceExport.createCustomPolicy(msg.policy as Record<string, unknown>); break;
          case 'deleteCustomCompliancePolicy': await this.deps.complianceExport.deleteCustomPolicy(msg.id as string); break;
          case 'driftAction': await this.deps.handleDriftAction(msg.file as string, msg.action as string); break;
          case 'parkedIdeasClear': await this.deps.setParkedIdeas([]); this.deps.postSettings(); break;
          case 'standupSelect': await this.deps.handleStandupSelect(msg.task); break;
          case 'connectIntegration': await this.handleConnectIntegration(msg.provider as string); break;
          case 'switchBranch': await this.deps.switchToBranch(msg.branchName as string); break;
          case 'deleteBranch': await this.deps.deleteBranch(msg.branchName as string); break;
          case 'refreshBranches':
            await this.deps.refreshBranchContext(true);
            await this.deps.refreshCommitContext(true, 200);
            break;
          case 'refreshCommits': await this.deps.refreshCommitContext(true, 200); break;
          case 'refreshTime': await this.deps.refreshTimeContext(true); break;
          case 'selectAnalyticsTask':
            this.deps.analyticsTaskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
            await this.deps.refreshTimeContext(true);
            break;
          case 'refreshAutomation': await this.deps.refreshAutomationContext(true); break;
          case 'refreshTasks': await this.deps.refreshTasksContext(true); break;
          case 'pullTasks': await this.deps.pullTasks(msg.tool as TynePmTool | undefined); break;
          case 'connectPmTool': await this.deps.connectPmTool(msg.tool as TynePmTool); break;
          case 'disconnectPmTool': await this.deps.disconnectPmTool(msg.tool as TynePmTool); break;
          case 'openTaskDetail': await this.deps.openTaskDetail(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'selectTaskIntoThread': await this.deps.selectTaskIntoThread(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'retryPmEnrichment': await this.deps.retryPmEnrichment(); break;
          case 'switchTaskInThread': await this.deps.switchTaskInThread(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'refreshTaskDetail': await this.deps.openTaskDetail(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'refreshPmTaskIntelligence': await this.deps.fetchAndPostPmTaskIntelligence(msg.taskId as string, true); break;
          case 'queryTasks': this.deps.queryTasks(msg.query as string, msg.filters as TyneTaskFilters, msg.sort as TyneTaskSort); break;
          case 'queryTasksAdvanced': this.deps.queryTasksAdvanced(msg.query as string, msg.filters as TyneAdvancedTaskFilters, msg.sort as TyneAdvancedTaskSort); break;
          case 'listPresets': this.deps.listPresets(); break;
          case 'savePreset': await this.deps.savePreset(msg); break;
          case 'renamePreset': await this.deps.renamePreset(msg.id as string, msg.name as string); break;
          case 'deletePreset': await this.deps.deletePreset(msg.id as string); break;
          case 'setDefaultPreset': await this.deps.setDefaultPreset(msg.id as string); break;
          case 'applyPreset': this.deps.applyPreset(msg.id as string); break;
          case 'createTask': await this.deps.createTask(msg.input as TyneCreateTaskInput); break;
          case 'updateTask': await this.deps.updateTask(msg.taskId as string, msg.sourceTool as TynePmTool, msg.input as TyneUpdateTaskInput); break;
          case 'addSubtask': await this.deps.addSubtask(msg.taskId as string, msg.sourceTool as TynePmTool, msg.input as { title: string; assigneeId?: string; dueDate?: string }); break;
          case 'addComment': await this.deps.addComment(msg.taskId as string, msg.sourceTool as TynePmTool, msg.body as string); break;
          case 'checkCapabilities': await this.deps.checkCapabilities(msg.tool as TynePmTool); break;
          case 'detectConflict': await this.deps.detectConflict(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'startRealTimeSync': await startActiveTaskSync(); break;
          case 'stopRealTimeSync': await stopActiveTaskSync(); break;
          case 'startThreadFromTask': await this.deps.startThreadFromTask(msg.taskId as string, msg.title as string, msg.tool as TynePmTool, msg.url as string | undefined); break;
          case 'storyDecomposeAnalyze': await this.deps.storyDecomposition.analyze(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'storyDecomposeGenerate': await this.deps.storyDecomposition.generate(msg.taskId as string, msg.answers as Record<string, string>); break;
          case 'storyDecomposeCreate': await this.deps.storyDecomposition.create(msg.taskId as string, msg.tasks as unknown, msg.createInJira === true, msg.dueDate); break;
          case 'storyDecomposeCancel': this.deps.storyDecomposition.cancel(msg.taskId as string); break;
          case 'storyDecomposeStartTask': await this.deps.storyDecomposition.startTask(msg.parentTaskId as string, msg.pmKey as string | undefined, msg.title as string); break;
          case 'storyDecomposeRegenerate': await this.deps.storyDecomposition.regenerate(msg.taskId as string, msg.tool as TynePmTool); break;
          case 'getGitStatus': await this.deps.refreshGitStatus(); break;
          case 'runCodeReview': await this.deps.runCodeReview(msg.mode as ReviewMode); break;
          case 'runValidateReview': await this.deps.runValidateReview(
            msg.scope as string | undefined,
            msg.selectedCommitSha as string | undefined,
            { acknowledgeScopeBlowout: msg.acknowledgeScopeBlowout === true },
          ); break;
          case 'loadValidateReviewReports': await this.deps.postValidateReviewReports(); break;
          case 'submitBetaBug': await this.deps.betaBug.submit(msg); break;
          case 'findingFeedback': await this.deps.handleFindingFeedback(msg.feedback as Record<string, unknown>); break;
          case 'addTeamLearning': await this.deps.addTeamLearning(msg.learning as Record<string, unknown>); break;
          case 'removeTeamLearning': await this.deps.removeTeamLearning(msg.suppression as Record<string, unknown>); break;
          case 'openLearningsFile': await this.deps.openLearningsFile(); break;
          case 'createTaskFromFinding': await this.deps.createTaskFromFinding(msg.finding as Record<string, unknown>); break;
          case 'fixPendingGoal': await this.deps.fixPendingGoal(msg.goal as Record<string, unknown>); break;
          case 'pendingGoalFeedback': await this.deps.pendingGoalFeedback(msg.goal as Record<string, unknown>); break;
          case 'previewFix': await this.deps.findingFix.previewFix(msg.finding as Record<string, unknown>); break;
          case 'applyFix': await this.deps.findingFix.applyFix(msg.finding as Record<string, unknown>); break;
          case 'applyFixesBatch': await this.deps.findingFix.applyFixesBatch((msg.findings as Array<Record<string, unknown>>) || []); break;
          case 'fixSelectedBatch': await this.deps.findingFix.fixSelectedBatch((msg.findings as Array<Record<string, unknown>>) || []); break;
          case 'undoFix': await this.deps.findingFix.undoFix(msg.finding as Record<string, unknown>); break;
          case 'agentFix': await this.deps.findingFix.agentFix(msg.finding as Record<string, unknown>); break;
          case 'agentFixBatch': await this.deps.findingFix.agentFixBatch((msg.findings as Array<Record<string, unknown>>) || []); break;
          case 'openFindingPanel': await this.deps.openFindingPanel(msg.finding as Record<string, unknown>); break;
          case 'openFinding': {
            const finding = msg.finding as { id?: string; file?: string; line?: number; endLine?: number };
            // Synthetic locations like "(scope)" have no file to open — a scope
            // gap is about the ticket, not a line — so reveal only real paths.
            const loc = String(finding.file || '');
            if (loc && !loc.startsWith('(')) { await openFindingInEditor(finding); }
            break;
          }
          case 'clearReviewDiagnostics': clearReviewDiagnostics(); break;
          case 'copyTaskId':
            if (typeof msg.taskId === 'string') {
              await vscode.env.clipboard.writeText(msg.taskId);
              vscode.window.showInformationMessage(`Copied ${msg.taskId}`);
            }
            break;
          case 'copyTaskLink':
            if (typeof msg.url === 'string') {
              await vscode.env.clipboard.writeText(msg.url);
              vscode.window.showInformationMessage('Task link copied.');
            }
            break;
          case 'automationMarkDone': await this.deps.handleMarkTaskDone(); break;
          case 'automationPostFeedback': await this.deps.handlePostFeedback(msg.bodyOverride as string | undefined); break;
          case 'automationCompleteAndFeedback': await this.deps.handleCompleteAndFeedback(msg.bodyOverride as string | undefined); break;
          case 'automationPreviewFeedback': await this.deps.handlePreviewFeedback(); break;
          case 'automationSaveSettings': await this.deps.handleSaveAutomationSettings(msg.settings as TyneTaskAutomationSettings); break;
          case 'automationSaveMaxReportSettings': await this.deps.handleSaveMaxReportSettings(msg.sections as TyneMaxFeedbackSection[]); break;
          case 'reinstallCommitHook': await this.deps.handleReinstallCommitHook(); break;
          case 'automationSyncStatus': await this.deps.refreshAutomationContext(true); break;
          case 'addManualTime': await this.deps.timeAnalytics.addManualTime(msg.entry as ManualTimeEntryInput); break;
          case 'editManualTime': await this.deps.timeAnalytics.editManualTime(msg.id as string, msg.entry as Partial<ManualTimeEntryInput>); break;
          case 'deleteManualTime': await this.deps.timeAnalytics.deleteManualTime(msg.id as string); break;
          case 'copyBranchName':
            if (typeof msg.branchName === 'string') {
              await vscode.env.clipboard.writeText(msg.branchName);
              vscode.window.showInformationMessage(`Copied ${msg.branchName}`);
            }
            break;
          case 'copyCommitHash':
            if (typeof msg.commitHash === 'string') {
              await vscode.env.clipboard.writeText(msg.commitHash);
              vscode.window.showInformationMessage(`Copied ${msg.commitHash.slice(0, 8)}`);
            }
            break;
          case 'copyCommitMessage':
            if (typeof msg.message === 'string') {
              await vscode.env.clipboard.writeText(msg.message);
              vscode.window.showInformationMessage('Commit message copied');
            }
            break;
          case 'openChangedFile':
            if (typeof msg.filePath === 'string') {
              const repo = this.deps.getRepositoryPath();
              const uri = vscode.Uri.file(vscode.Uri.joinPath(vscode.Uri.file(repo), msg.filePath).fsPath);
              await vscode.window.showTextDocument(uri, { preview: false });
            }
            break;
          case 'openCommitGraph':
            if (typeof msg.commitHash === 'string') {
              try {
                await vscode.commands.executeCommand('gitlens.showCommitInView', { commit: msg.commitHash });
              } catch {
                vscode.window.showInformationMessage('No Git graph integration was available for this commit.');
              }
            }
            break;
        }
      
  }

  async handleButtonClick(action: string): Promise<void> {
    switch (action) {
      case 'startThread': await this.deps.startThread(); break;
      case 'switchSelectedBranch': {
        const linked = getBranchByTaskId(this.deps.context, this.deps.getRepositoryPath(), this.deps.state.taskId);
        if (linked) { await this.deps.switchToBranch(linked.branchName); }
        break;
      }
      case 'saveStitch': await this.deps.saveStitch(); break;
      case 'stageAll':
        try {
          await vscode.commands.executeCommand('git.stageAll');
        } catch {
          await vscode.commands.executeCommand('workbench.view.scm');
        }
        await this.deps.refreshGitStatus();
        break;
      case 'undoStitch': await this.deps.undoStitch(); break;
      case 'validateGoal':
      case 'validateReview':
        await this.deps.runValidateReview();
        break;
      case 'generateCommitPreview': await this.deps.generateCommitPreview(); break;
      case 'overrideProceed': await this.deps.overrideProceed(); break;
      case 'tieKnot': await this.deps.tieTheKnot(); break;
      default: vscode.window.showInformationMessage(`Tyne: ${action} coming soon`);
    }
  }

  async handleConnectIntegration(provider: string): Promise<void> {
    const names: Record<string, string> = { slack: 'Slack', salesforce: 'Salesforce', jira: 'Jira', linear: 'Linear', monday: 'Monday', asana: 'Asana', notion: 'Notion' };
    const name = names[provider] || provider;
    // Only Jira and Linear are live integrations; the rest are not built yet.
    if (provider === 'jira' || provider === 'linear') {
      await this.deps.connectPmTool(provider as TynePmTool);
      return;
    }
    vscode.window.showInformationMessage(`${name} integration is coming soon.`);
  }
}
