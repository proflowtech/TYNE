import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { isGitRepo } from '../gitManager';
import { repairTimeStorage, listTimeLogs, listManualEntries } from '../timeMetadataService';
import { generateTimeLogsFromSessions, getTimeLogsForTask, getTimeLogsForBranch } from '../timeTrackingService';
import { buildDeveloperAnalytics, listAnalyticsTasks } from '../developerAnalytics';
import { createManualTimeEntry, updateManualTimeEntry, deleteManualTimeEntry, listManualTimeEntriesForTask } from '../manualTimeEntryService';
import {
  getTaskTimeSummary,
  getBranchTimeSummary,
  getProjectTimeSummary,
  getDailyTimeSummary,
  getWeeklyTimeSummary,
  getMonthlyTimeSummary,
} from '../timeSummaryService';
import type { ManualTimeEntryInput } from '../timeTypes';

type TimeAnalyticsHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'hasWebview'
  | 'analyticsTaskId'
  | 'lastCommitSessions'
  | 'getRepositoryPath'
  | 'updateStatusBar'
  | 'usageService'
>;

export class TimeAnalyticsController {
  constructor(private readonly host: TimeAnalyticsHost) {}

  async refreshTimeContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this.postEmptyTimeData();
      }
      return;
    }
    try {
      await repairTimeStorage(this.host.context);
      const repositoryName = vscode.workspace.workspaceFolders?.[0]?.name;
      const sessions = this.host.lastCommitSessions;
      if (sessions.length > 0) {
        await generateTimeLogsFromSessions(this.host.context, sessions, repositoryPath, repositoryName);
      }
      const today = new Date().toISOString();
      const allLogs = listTimeLogs(this.host.context).filter(l => l.repositoryPath === repositoryPath);
      const allManuals = listManualEntries(this.host.context).filter(e => e.repositoryPath === repositoryPath);
      const analyticsTasks = listAnalyticsTasks(allLogs, allManuals, sessions);
      const selectedTaskId =
        this.host.analyticsTaskId ||
        (this.host.state.taskId && analyticsTasks.some(t => t.taskId === this.host.state.taskId) ? this.host.state.taskId : undefined) ||
        analyticsTasks[0]?.taskId ||
        this.host.state.taskId ||
        undefined;
      this.host.analyticsTaskId = selectedTaskId;
      const selectedTaskMeta = analyticsTasks.find(t => t.taskId === selectedTaskId);
      const currentBranch = this.host.state.branchName;
      const taskSummary = selectedTaskId
        ? getTaskTimeSummary(this.host.context, repositoryPath, selectedTaskId)
        : null;
      const branchSummary = currentBranch
        ? getBranchTimeSummary(this.host.context, repositoryPath, currentBranch)
        : null;
      const projectSummary = getProjectTimeSummary(this.host.context, repositoryPath);
      const dailySummary = getDailyTimeSummary(this.host.context, repositoryPath, today);
      const weeklySummary = getWeeklyTimeSummary(this.host.context, repositoryPath, today);
      const monthlySummary = getMonthlyTimeSummary(this.host.context, repositoryPath, today);
      const taskLogs = selectedTaskId ? getTimeLogsForTask(this.host.context, selectedTaskId) : [];
      const branchLogs = currentBranch ? getTimeLogsForBranch(this.host.context, currentBranch) : [];
      const manualEntries = selectedTaskId
        ? listManualTimeEntriesForTask(this.host.context, selectedTaskId)
        : [];
      const scopeLogs = selectedTaskId ? taskLogs : branchLogs;
      const scopeSessions = sessions.filter(s =>
        selectedTaskId ? s.taskId === selectedTaskId : (currentBranch ? s.branchName === currentBranch : true),
      );
      const scopeManuals = selectedTaskId
        ? manualEntries
        : allManuals.filter(e => !currentBranch || e.branchName === currentBranch);
      const analytics = await this.buildAnalyticsPayload({
        taskId: selectedTaskId,
        taskTitle: selectedTaskMeta?.taskTitle || this.host.state.taskTitle,
        repositoryName,
        branchName: selectedTaskMeta?.branchName || currentBranch,
        taskSummary,
        branchSummary,
        dailySummary,
        weeklySummary,
        logs: scopeLogs,
        manuals: scopeManuals,
        sessions: scopeSessions,
      });
      if (postMessage || this.host.hasWebview()) {
        this.host.postMessage({
          type: 'timeDataLoaded',
          taskSummary,
          branchSummary,
          projectSummary,
          dailySummary,
          weeklySummary,
          monthlySummary,
          taskLogs,
          branchLogs,
          manualEntries: scopeManuals,
          allLogs,
          allManuals,
          analytics,
          analyticsTasks,
          selectedTaskId: selectedTaskId || null,
        });
      }
      this.host.updateStatusBar();
    } catch (err) {
      console.error('Tyne: time refresh failed', err);
    }
  }

  postEmptyTimeData(): void {
    this.host.postMessage({
      type: 'timeDataLoaded',
      taskSummary: null, branchSummary: null, projectSummary: null,
      dailySummary: null, weeklySummary: null, monthlySummary: null,
      taskLogs: [], branchLogs: [], manualEntries: [], allLogs: [], allManuals: [],
      analyticsTasks: [],
      selectedTaskId: this.host.analyticsTaskId || this.host.state.taskId || null,
      analytics: buildDeveloperAnalytics({
        logs: [], manuals: [], sessions: [],
        taskId: this.host.analyticsTaskId || this.host.state.taskId,
        taskTitle: this.host.state.taskTitle,
        branchName: this.host.state.branchName,
      }),
    });
  }

  async buildAnalyticsPayload(input: Parameters<typeof buildDeveloperAnalytics>[0]) {
    let validationRuns = 0;
    const recentModels: string[] = [];
    let qualityScore: number | undefined;
    try {
      const usage = await this.host.usageService.getUsageSummary().catch(() => null);
      validationRuns = usage?.used ?? 0;
    } catch { /* offline */ }
    // ponytail: use in-memory latest review only — full history fetch is too heavy for tab refresh
    const latest = this.host.state.validateReviewResult;
    if (latest) {
      const mi = latest.modelInfo;
      if (mi?.primaryModel) { recentModels.push(mi.primaryModel); }
      if (mi?.secondaryModel) { recentModels.push(mi.secondaryModel); }
      if (mi?.judgeModel) { recentModels.push(mi.judgeModel); }
      if (typeof latest.qualityScore === 'number') { qualityScore = latest.qualityScore; }
    }
    return buildDeveloperAnalytics({
      ...input,
      validationRuns,
      recentModels,
      qualityScore,
    });
  }

  async addManualTime(entry: ManualTimeEntryInput): Promise<void> {
    if (!entry) { return; }
    const repositoryPath = this.host.getRepositoryPath();
    const repositoryName = vscode.workspace.workspaceFolders?.[0]?.name;
    const filled: ManualTimeEntryInput = {
      ...entry,
      repositoryPath: entry.repositoryPath || repositoryPath,
      repositoryName: entry.repositoryName || repositoryName,
      taskId: entry.taskId || this.host.state.taskId || undefined,
      taskTitle: entry.taskTitle || this.host.state.taskTitle || undefined,
      branchName: entry.branchName || this.host.state.branchName || undefined,
    };
    const result = await createManualTimeEntry(this.host.context, filled);
    if (result.errors?.length) {
      this.host.postMessage({ type: 'manualTimeError', errors: result.errors });
      return;
    }
    this.host.postMessage({ type: 'manualTimeSaved', entry: result.entry });
    vscode.window.showInformationMessage('Manual time entry saved.');
    await this.refreshTimeContext(true);
  }

  async editManualTime(id: string, input: Partial<ManualTimeEntryInput>): Promise<void> {
    const result = await updateManualTimeEntry(this.host.context, id, input);
    if (result.errors?.length) {
      this.host.postMessage({ type: 'manualTimeError', errors: result.errors });
      return;
    }
    this.host.postMessage({ type: 'manualTimeSaved', entry: result.entry });
    vscode.window.showInformationMessage('Manual time entry updated.');
    await this.refreshTimeContext(true);
  }

  async deleteManualTime(id: string): Promise<void> {
    await deleteManualTimeEntry(this.host.context, id);
    this.host.postMessage({ type: 'manualTimeDeleted', id });
    vscode.window.showInformationMessage('Manual time entry deleted.');
    await this.refreshTimeContext(true);
  }
}
