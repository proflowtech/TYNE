import * as vscode from 'vscode';
import type { SidebarHost, SidebarCommitSummary } from './sidebarHost';
import { saveState } from '../stateManager';
import {
  getGit,
  branchExists,
  checkoutBranch,
  deleteLocalBranch,
  getCommitCount,
  getCurrentBranch,
  getLatestCommit,
  getWorkingTreeStatus,
  getDetailedGitStatus,
  isBranchMerged,
  isGitRepo,
} from '../gitManager';
import {
  BranchRecord,
  deleteBranchRecord,
  listTyneBranches,
  replaceBranchRecords,
  updateBranchRecord,
} from '../branchMetadataService';
import { clusterCommits } from '../commitClusteringService';
import { extractTaskIdFromBranch, linkCommitToTask } from '../commitLinkingService';
import {
  listCommitRecords,
  listCommitSessions,
  replaceCommitRecords,
  replaceCommitSessions,
} from '../commitMetadataService';
import { getCommitsForBranch } from '../gitCommitService';
import { TyneCommitRecord, TyneCommitSession } from '../commitTypes';
import { DriftEvent } from '../driftDetector';
import { TyneValidateReviewResult, QualityGateResult } from '../validateReviewTypes';
import { getQualityGateService } from '../qualityGateService';
import { writeGateBlockFile, writeGateWarnFile, clearGateFiles } from '../gitHookService';

interface BranchViewModel extends BranchRecord {
  isCurrent: boolean;
}

interface CommitSummary {
  totalCommits: number;
  totalSessions: number;
  totalMinutes: number;
  latestCommit: TyneCommitRecord | null;
  lastActivityAt: string;
}

type GitContextHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'hasWebview'
  | 'userProfile'
  | 'getRepositoryPath'
  | 'updateStatusBar'
  | 'debouncedSave'
  | 'logJira'
  | 'lastCommitSessions'
  | 'getParkedIdeas'
  | 'setParkedIdeas'
  | 'refreshTimeContext'
  | 'refreshAutomationContext'
  | 'refreshTasksContext'
>;

export class GitContextController {
  private readonly driftEvents = new Map<string, DriftEvent>();

  constructor(private readonly host: GitContextHost) {}

  async refreshBranchContext(postMessage: boolean): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this.host.postMessage({
          type: 'branchDataLoaded',
          currentBranchName: '',
          currentBranchRecord: null,
          selectedTaskBranch: null,
          branches: [],
        });
      }
      this.host.updateStatusBar(undefined, '');
      return;
    }

    const currentBranchName = await getCurrentBranch();
    const records = listTyneBranches(this.host.context, repositoryPath);
    const updatedRecords: BranchRecord[] = [];
    for (const record of records) {
      const exists = await branchExists(record.branchName).catch(() => false);
      if (!exists) { continue; }
      const [commitCount, latestCommit] = await Promise.all([
        getCommitCount(record.branchName).catch(() => record.commitCount),
        getLatestCommit(record.branchName).catch(() => ({
          hash: record.latestCommitHash,
          message: record.latestCommitMessage,
        })),
      ]);
      updatedRecords.push({
        ...record,
        commitCount,
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
        currentStatus: record.branchName === currentBranchName ? 'active' : 'inactive',
      });
    }
    let currentBranchRecord = updatedRecords.find(record => record.branchName === currentBranchName) || null;
    if (!currentBranchRecord && currentBranchName.startsWith('tyne/')) {
      const extractedTaskId = extractTaskIdFromBranch(currentBranchName);
      const latestCommit = await getLatestCommit(currentBranchName).catch(() => ({ hash: '', message: '' }));
      currentBranchRecord = {
        taskId: extractedTaskId || this.host.state.taskId || 'Unknown',
        taskTitle: this.host.state.taskTitle || this.host.state.goal || extractedTaskId || 'Unknown task',
        taskSource: this.host.state.taskSource || 'Recovered',
        taskUrl: this.host.state.taskUrl || undefined,
        branchName: currentBranchName,
        repositoryPath,
        createdAt: new Date().toISOString(),
        lastCheckedOutAt: new Date().toISOString(),
        currentStatus: 'active',
        commitCount: await getCommitCount(currentBranchName).catch(() => 0),
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
      };
      updatedRecords.push(currentBranchRecord);
    }
    // Persist recovered records too. Previously the replacement happened before
    // recovery, so the sidebar looked linked for one render while storage stayed empty.
    await replaceBranchRecords(this.host.context, repositoryPath, updatedRecords);
    if (currentBranchRecord && this.host.state.status !== 'weaving') {
      this.host.state.taskId = currentBranchRecord.taskId;
      this.host.state.taskTitle = currentBranchRecord.taskTitle;
      this.host.state.taskSource = currentBranchRecord.taskSource;
      this.host.state.taskUrl = currentBranchRecord.taskUrl || '';
      this.host.state.goal = this.host.state.goal || currentBranchRecord.taskTitle;
      this.host.state.branchName = currentBranchRecord.branchName;
      // Being on a tyne/ branch means the thread is active.
      if (currentBranchName.startsWith('tyne/')) {
        this.host.state.status = 'weaving';
        this.host.postMessage({ type: 'statusChanged', status: 'weaving', branchName: currentBranchName });
      }
      this.host.debouncedSave();
    }

    const selectedTaskBranch = this.host.state.taskId
      ? updatedRecords.find(record => record.taskId === this.host.state.taskId) || null
      : null;

    const branches: BranchViewModel[] = updatedRecords
      .map(record => ({ ...record, isCurrent: record.branchName === currentBranchName }))
      .sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) { return -1; }
        if (!a.isCurrent && b.isCurrent) { return 1; }
        return b.lastCheckedOutAt.localeCompare(a.lastCheckedOutAt);
      });

    if (postMessage || this.host.hasWebview()) {
      this.host.postMessage({
        type: 'branchDataLoaded',
        currentBranchName,
        currentBranchRecord,
        selectedTaskBranch,
        branches,
      });
    }
    const storedCommits = listCommitRecords(this.host.context, repositoryPath)
      .filter(commit => commit.branchName === currentBranchName);
    const storedSessions = listCommitSessions(this.host.context, repositoryPath)
      .filter(session => session.branchName === currentBranchName);
    this.host.updateStatusBar(
      currentBranchRecord || undefined,
      currentBranchName,
      this.buildCommitSummary(storedCommits, storedSessions) as SidebarCommitSummary,
    );
  }

  async refreshGitStatus(): Promise<void> {
    if (!(await isGitRepo().catch(() => false))) { return; }
    try {
      const gitStatus = await getDetailedGitStatus();
      const hasActiveTask = Boolean(this.host.state.taskId?.trim());
      const isWeaving = this.host.state.status === 'weaving';

      let ctaReason: string;
      if (!hasActiveTask) {
        ctaReason = 'no_active_task';
      } else if (!isWeaving) {
        ctaReason = 'thread_not_started';
      } else if (gitStatus.isClean) {
        ctaReason = 'no_changes';
      } else if (gitStatus.stagedFiles > 0) {
        ctaReason = 'has_staged';
      } else {
        ctaReason = 'has_unstaged';
      }

      this.host.logJira(`Git status refreshed: staged=${gitStatus.stagedFiles} unstaged=${gitStatus.unstagedFiles}`);
      this.host.logJira(`Validation CTA state: ${ctaReason}`);

      this.host.postMessage({
        type: 'gitStatusLoaded',
        currentBranch: gitStatus.currentBranch,
        stagedFiles: gitStatus.stagedFiles,
        unstagedFiles: gitStatus.unstagedFiles,
        isClean: gitStatus.isClean,
        hasActiveTask,
        isWeaving,
        ctaReason,
      });
    } catch (err) {
      console.error('Tyne: git status refresh failed', err);
    }
  }

  buildCommitSummary(commits: TyneCommitRecord[], sessions: TyneCommitSession[]): CommitSummary {
    const latestCommit = commits[0] || null;
    return {
      totalCommits: commits.length,
      totalSessions: sessions.length,
      totalMinutes: sessions.reduce((sum, session) => sum + session.durationMinutes, 0),
      latestCommit,
      lastActivityAt: latestCommit?.committedAt || '',
    };
  }

  async refreshCommitContext(postMessage: boolean, maxCommits = 20): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath || !(await isGitRepo())) {
      if (postMessage) {
        this.host.postMessage({
          type: 'commitDataLoaded',
          currentBranchName: '',
          currentBranchCommits: [],
          currentBranchSessions: [],
          taskCommits: [],
          taskSessions: [],
          summaries: {},
        });
      }
      return;
    }

    const currentBranchName = await getCurrentBranch();
    const branchRecords = listTyneBranches(this.host.context, repositoryPath);
    const branchNames = new Set(branchRecords.map(record => record.branchName));
    if (currentBranchName.startsWith('tyne/')) {
      branchNames.add(currentBranchName);
    }

    const allCommits: TyneCommitRecord[] = [];
    const allSessions: TyneCommitSession[] = [];
    for (const branchName of branchNames) {
      const branchRecord = branchRecords.find(record => record.branchName === branchName);
      const commits = await getCommitsForBranch(branchName, maxCommits).catch(() => []);
      const linkedCommits = commits.map(commit => linkCommitToTask(commit, branchRecord));
      const existingSessions = listCommitSessions(this.host.context, repositoryPath).filter(session => session.branchName === branchName);
      const sessions = clusterCommits([...linkedCommits].reverse()).map(session => ({
        ...session,
        taskId: session.taskId || branchRecord?.taskId,
        taskTitle: session.taskTitle || branchRecord?.taskTitle,
        taskSource: session.taskSource || branchRecord?.taskSource,
        synced: existingSessions.find(existing => existing.id === session.id)?.synced,
        syncedAt: existingSessions.find(existing => existing.id === session.id)?.syncedAt,
        syncedWorklogIds: existingSessions.find(existing => existing.id === session.id)?.syncedWorklogIds,
      }));
      for (const session of sessions) {
        for (const hash of session.commitHashes) {
          const commit = linkedCommits.find(item => item.commitHash === hash);
          if (commit) { commit.sessionId = session.id; }
        }
      }
      allCommits.push(...linkedCommits.sort((a, b) => new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime()));
      allSessions.push(...sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()));
    }

    await replaceCommitRecords(this.host.context, repositoryPath, allCommits);
    await replaceCommitSessions(this.host.context, repositoryPath, allSessions);
    this.host.lastCommitSessions = allSessions;

    const currentBranchCommits = allCommits.filter(commit => commit.branchName === currentBranchName);
    const currentBranchSessions = allSessions.filter(session => session.branchName === currentBranchName);
    const taskBranchName = branchRecords.find(record => record.taskId === this.host.state.taskId)?.branchName;
    const taskCommits = taskBranchName
      ? allCommits.filter(commit => commit.branchName === taskBranchName)
      : currentBranchCommits.filter(commit => commit.taskId === this.host.state.taskId);
    const taskSessions = taskBranchName
      ? allSessions.filter(session => session.branchName === taskBranchName)
      : currentBranchSessions.filter(session => session.taskId === this.host.state.taskId);

    const summaries: Record<string, CommitSummary> = {};
    for (const branchName of branchNames) {
      summaries[branchName] = this.buildCommitSummary(
        allCommits.filter(commit => commit.branchName === branchName),
        allSessions.filter(session => session.branchName === branchName),
      );
    }

    if (postMessage || this.host.hasWebview()) {
      this.host.postMessage({
        type: 'commitDataLoaded',
        currentBranchName,
        currentBranchCommits,
        currentBranchSessions,
        taskCommits,
        taskSessions,
        summaries,
      });
    }
    const currentBranchRecord = branchRecords.find(record => record.branchName === currentBranchName);
    this.host.updateStatusBar(
      currentBranchRecord,
      currentBranchName,
      (summaries[currentBranchName] || this.buildCommitSummary(currentBranchCommits, currentBranchSessions)) as SidebarCommitSummary,
    );
    void this.host.refreshTimeContext(false);
    void this.host.refreshAutomationContext(false);
    void this.host.refreshTasksContext(false);
  }

  async switchToBranch(branchName: string): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath) { return; }
    if (!(await branchExists(branchName))) {
      vscode.window.showErrorMessage(`Branch ${branchName} does not exist locally.`);
      return;
    }

    const status = await getWorkingTreeStatus();
    if (!status.isClean) {
      const choice = await vscode.window.showWarningMessage(
        `You have ${status.changedFiles} uncommitted change(s). Stash them before switching?`,
        'Stash & Switch',
        'Cancel',
      );
      if (choice !== 'Stash & Switch') { return; }
      const git = getGit();
      if (!git) { throw new Error('No git repo'); }
      await git.stash(['push', '-m', `Tyne auto-stash before switching to ${branchName}`]);
    }

    await checkoutBranch(branchName);
    const [commitCount, latestCommit] = await Promise.all([
      getCommitCount(branchName),
      getLatestCommit(branchName),
    ]);
    const updated = await updateBranchRecord(this.host.context, repositoryPath, branchName, {
      lastCheckedOutAt: new Date().toISOString(),
      currentStatus: 'active',
      commitCount,
      latestCommitHash: latestCommit.hash,
      latestCommitMessage: latestCommit.message,
    });
    if (updated) {
      this.host.state.taskId = updated.taskId;
      this.host.state.taskTitle = updated.taskTitle;
      this.host.state.taskSource = updated.taskSource;
      this.host.state.taskUrl = updated.taskUrl || '';
      this.host.state.goal = updated.taskTitle;
      this.host.state.branchName = updated.branchName;
    }
    // Switching to a tyne/ branch means the thread is active — always set weaving.
    if (branchName.startsWith('tyne/')) {
      this.host.state.status = 'weaving';
    }
    await saveState(this.host.context, this.host.state);
    this.host.logJira(`Branch created/switched: ${branchName}`);
    if (this.host.state.status === 'weaving') {
      this.host.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
    }
    await this.refreshBranchContext(true);
    await this.refreshCommitContext(true);
    await this.refreshGitStatus();
    vscode.window.showInformationMessage(`Switched to ${branchName}`);
  }

  async deleteBranch(branchName: string): Promise<void> {
    const repositoryPath = this.host.getRepositoryPath();
    if (!repositoryPath) { return; }
    const currentBranch = await getCurrentBranch();
    if (currentBranch === branchName) {
      vscode.window.showWarningMessage('Tyne will not delete the current branch.');
      return;
    }
    const status = await getWorkingTreeStatus();
    if (!status.isClean) {
      vscode.window.showWarningMessage('Commit or stash your current changes before deleting another branch.');
      return;
    }

    const merged = await isBranchMerged(branchName).catch(() => false);
    const choice = await vscode.window.showWarningMessage(
      merged
        ? `Delete local branch ${branchName}?`
        : `${branchName} does not look merged yet. Delete the local branch anyway?`,
      'Delete Branch',
      'Cancel',
    );
    if (choice !== 'Delete Branch') { return; }

    await deleteLocalBranch(branchName, !merged);
    await deleteBranchRecord(this.host.context, repositoryPath, branchName);
    await this.refreshBranchContext(true);
    await this.refreshCommitContext(true);
    vscode.window.showInformationMessage(`Deleted local branch ${branchName}`);
  }

  handleDriftDetected(event: DriftEvent): void {
    this.driftEvents.set(event.file, event);
    this.host.postMessage({ type: 'driftDetected', event });
    const goalPreview = this.host.state.goal.length > 44 ? `${this.host.state.goal.slice(0, 44)}...` : this.host.state.goal;
    vscode.window.showWarningMessage(`Tyne: "${event.file}" looks off-scope for "${goalPreview}"`, 'Park changes', 'New ticket', 'Dismiss').then(choice => {
      if (choice === 'Park changes') { this.handleDriftAction(event.file, 'park'); }
      else if (choice === 'New ticket') { this.handleDriftAction(event.file, 'new_ticket'); }
      else if (choice === 'Dismiss') { this.handleDriftAction(event.file, 'dismiss'); }
    });
  }

  async handleDriftAction(file: string, action: string): Promise<void> {
    const event = this.driftEvents.get(file);
    if (!event) { return; }
    if (action === 'dismiss') { this.driftEvents.delete(file); this.host.postMessage({ type: 'driftDismissed', file }); return; }
    if (action === 'park') {
      try {
        const git = getGit();
        if (!git) { throw new Error('No git repo'); }
        await git.stash(['push', '-m', `Tyne drift-park: ${file}`]);
        this.driftEvents.delete(file);
        this.host.postMessage({ type: 'driftParked', file });
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
      const parkedIdeas = [...this.host.getParkedIdeas(), idea];
      await this.host.setParkedIdeas(parkedIdeas);
      this.driftEvents.delete(file);
      this.host.postMessage({ type: 'parkedIdeaSaved', idea, parkedIdeas });
      vscode.window.showInformationMessage(`Parked idea saved: "${note}" ✓`);
    }
  }

  async evaluateQualityGate(gateType: 'pre_commit' | 'pre_push'): Promise<QualityGateResult | null> {
    try {
      const service = getQualityGateService(this.host.context);
      const reviewResult = this.host.state.validateReviewResult || this.host.state.validationResult as unknown as TyneValidateReviewResult || null;
      const result = await service.evaluateGate(
        gateType,
        this.host.userProfile.tier,
        this.host.state.branchName,
        reviewResult,
      );
      this.host.postMessage({ type: 'qualityGateResult', result });
      // Write gate files so installed git hooks can enforce on terminal too
      if (result.blocks.length > 0) {
        await writeGateBlockFile(result.blocks.map(b => b.reason));
      } else if (result.warnings.length > 0) {
        await writeGateWarnFile(result.warnings.map(w => w.reason));
      } else {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) { clearGateFiles(folder.uri.fsPath); }
      }
      return result;
    } catch {
      return null;
    }
  }
}
