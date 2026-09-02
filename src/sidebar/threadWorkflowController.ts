import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { TyneState, getState, saveState, clearState } from '../stateManager';
import {
  sanitizeBranchName,
  createBranch,
  saveStitch as commitStitch,
  hasStitch as repoHasStitch,
  undoStitch as rollbackStitch,
  tieTheKnot as shipThread,
  branchExists,
  getCommitCount,
  getLatestCommit,
  getWorkingTreeStatus,
  isGitRepo,
} from '../gitManager';
import { notifyWithActions } from '../notifyWithActions';
import { createDraftPR } from '../githubIntegration';
import { prepareWorkspace } from '../workspacePrep';
import { synthesizeCommitMessage } from '../commitSynthesizer';
import { byokAllowedForTier } from '../codeValidationService';
import {
  BranchRecord,
  createBranchRecord,
  getBranchByTaskId,
  updateBranchRecord,
} from '../branchMetadataService';
import { TynePmTool } from '../taskTypes';
import {
  hasActionableEnrichment,
  hasEnrichmentContent,
  buildProofChecklist,
} from '../taskEnrichmentService';
import { getCachedTaskDetailsSync, listCachedTasksSync } from '../taskCacheService';
import { stopDriftDetection } from '../driftDetector';

type ThreadWorkflowHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'userProfile'
  | 'byokKeyService'
  | 'getRepositoryPath'
  | 'setRunner'
  | 'setBusy'
  | 'logJira'
  | 'logLinear'
  | 'isProjectLeadMode'
  | 'startProjectLeadWatcher'
  | 'switchToBranch'
  | 'refreshBranchContext'
  | 'refreshCommitContext'
  | 'refreshGitStatus'
  | 'evaluateQualityGate'
  | 'runTieKnotAutomation'
  | 'postThreadCreateTasksVisibility'
  | 'getStoredPmIntelligence'
  | 'extractIntelligenceForStartThread'
  | 'postEnrichmentToWebview'
  | 'findCachedTask'
  | 'rehydrateValidationForTask'
>;

export class ThreadWorkflowController {
  constructor(private readonly host: ThreadWorkflowHost) {}

  async startThread(): Promise<void> {
    if (!this.host.state.taskId.trim()) { vscode.window.showErrorMessage('Select a task before starting a thread.'); return; }
    if (!this.host.state.appName || !this.host.state.goal) { vscode.window.showErrorMessage('App name and goal are required'); return; }
    if (!(await isGitRepo())) { vscode.window.showErrorMessage('Tyne could not find a Git repository in this workspace.'); return; }
    const repositoryPath = this.host.getRepositoryPath();
    this.host.setRunner(true);
    try {
      this.host.logJira(`Start Thread clicked: ${this.host.state.taskId}`);
      const taskTitle = this.host.state.taskTitle || this.host.state.goal;
      const branchName = sanitizeBranchName(this.host.state.taskId, taskTitle);
      const linked = getBranchByTaskId(this.host.context, repositoryPath, this.host.state.taskId);
      if (linked) {
        const choice = await vscode.window.showInformationMessage(
          `Task ${this.host.state.taskId} is already linked to ${linked.branchName}.`,
          'Switch to Branch',
          'Cancel',
        );
        if (choice === 'Switch to Branch') {
          await this.host.switchToBranch(linked.branchName);
          // Branch already existed — ensure weaving state is set now.
          this.host.state.status = 'weaving';
          await saveState(this.host.context, this.host.state);
          this.host.postMessage({ type: 'statusChanged', status: 'weaving', branchName: linked.branchName });
        }
        return;
      }

      const workingTree = await getWorkingTreeStatus();
      if (!workingTree.isClean) {
        const choice = await vscode.window.showWarningMessage(
          `This workspace has ${workingTree.changedFiles} uncommitted change(s). Creating a thread now will keep those changes on the new branch.`,
          'Create Branch Anyway',
          'Cancel',
        );
        if (choice !== 'Create Branch Anyway') { return; }
      }

      if (await branchExists(branchName)) {
        const choice = await vscode.window.showInformationMessage(
          `Branch ${branchName} already exists.`,
          'Switch to Existing Branch',
          'Cancel',
        );
        if (choice === 'Switch to Existing Branch') {
          await this.host.switchToBranch(branchName);
          // Branch already existed — ensure weaving state is set now.
          this.host.state.status = 'weaving';
          await saveState(this.host.context, this.host.state);
          this.host.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
        }
        return;
      }

      if (this.host.isProjectLeadMode()) {
        this.host.postMessage({ type: 'prepStarted' });
        try {
          const prep = await prepareWorkspace();
          this.host.postMessage({ type: 'prepComplete', stashed: prep.stashed, pullSummary: prep.pullSummary || 'No remote to pull from', clean: prep.clean });
          await new Promise(resolve => setTimeout(resolve, 700));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'User cancelled workspace prep') { return; }
          vscode.window.showErrorMessage('Workspace prep failed: ' + message);
          this.host.postMessage({ type: 'prepComplete', error: message });
          return;
        }
      }

      await createBranch(branchName);
      this.host.logJira(`Branch created/switched: ${branchName}`);
      if (this.host.state.taskSource.toLowerCase() === 'linear') { this.host.logLinear(`Linear thread started: ${branchName}`); }
      const [commitCount, latestCommit] = await Promise.all([
        getCommitCount(branchName),
        getLatestCommit(branchName),
      ]);
      const record: BranchRecord = {
        taskId: this.host.state.taskId,
        taskTitle,
        taskSource: this.host.state.taskSource || 'Solo Mode',
        taskUrl: this.host.state.taskUrl || undefined,
        branchName,
        repositoryPath,
        createdAt: new Date().toISOString(),
        lastCheckedOutAt: new Date().toISOString(),
        currentStatus: 'active',
        commitCount,
        latestCommitHash: latestCommit.hash,
        latestCommitMessage: latestCommit.message,
      };
      await createBranchRecord(this.host.context, record);
      this.host.state.branchName = branchName;
      this.host.state.status = 'weaving';
      await saveState(this.host.context, this.host.state);
      this.host.logJira(`Active Jira task saved: ${this.host.state.taskId}`);
      this.host.postMessage({ type: 'statusChanged', status: 'weaving', branchName });
      this.host.startProjectLeadWatcher();
      await this.host.refreshBranchContext(true);
      await this.host.refreshCommitContext(true);
      await this.host.refreshGitStatus();
      await notifyWithActions(
        'Thread started on branch: ' + branchName,
        [{ title: 'Validate & Review', command: 'tyne.runValidateReview' }],
      );
    } catch (err: unknown) {
      vscode.window.showErrorMessage('Could not create branch: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this.host.setRunner(false);
    }
  }

  async saveStitch(): Promise<void> {
    try {
      // Quality gate: evaluate before committing
      const gateResult = await this.host.evaluateQualityGate('pre_commit');
      if (gateResult && !gateResult.passed && !gateResult.overridden) {
        this.host.postMessage({ type: 'qualityGateResult', result: gateResult });
        if (gateResult.blocks.length > 0) {
          vscode.window.showWarningMessage('Quality gate blocked this commit. Resolve critical issues or override.');
          return;
        }
      }

      const hash = await commitStitch(this.host.state.taskId || 'task');
      this.host.state.stitchCount += 1;
      this.host.state.lastStitchTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      await saveState(this.host.context, this.host.state);
      const repositoryPath = this.host.getRepositoryPath();
      const updated = await updateBranchRecord(this.host.context, repositoryPath, this.host.state.branchName, {
        commitCount: await getCommitCount(this.host.state.branchName).catch(() => this.host.state.stitchCount),
        latestCommitHash: hash,
        latestCommitMessage: (await getLatestCommit(this.host.state.branchName).catch(() => ({ hash, message: '' }))).message,
      });
      void updated;
      this.host.postMessage({ type: 'stitchSaved', hash, stitchCount: this.host.state.stitchCount, lastStitchTime: this.host.state.lastStitchTime });
      this.host.postMessage({ type: 'hasStitch', value: true });
      await this.host.refreshBranchContext(true);
      await this.host.refreshCommitContext(true);
      vscode.window.showInformationMessage(`Stitch saved ✓ (${hash.slice(0, 7)})`);
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  async undoStitch(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Undo last stitch? All changes since the last stitch will be lost.', 'Yes, undo', 'Cancel');
    if (pick !== 'Yes, undo') { return; }
    try {
      await rollbackStitch();
      this.host.state.stitchCount = Math.max(0, this.host.state.stitchCount - 1);
      await saveState(this.host.context, this.host.state);
      const stillHas = await repoHasStitch();
      this.host.postMessage({ type: 'stitchUndone', stitchCount: this.host.state.stitchCount });
      this.host.postMessage({ type: 'hasStitch', value: stillHas });
      vscode.window.showInformationMessage('Stitch undone. Rolled back to previous state.');
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  }

  async overrideProceed(): Promise<void> {
    const pick = await vscode.window.showWarningMessage('Override validation? Tie the Knot will proceed even though validation did not fully pass.', 'Yes, override', 'Cancel');
    if (pick !== 'Yes, override') { return; }
    this.host.state.validationOverride = true;
    await saveState(this.host.context, this.host.state);
    this.host.postMessage({ type: 'tieKnotUnlocked' });
  }

  async tieTheKnot(): Promise<void> {
    if (!this.host.state.validationResult && !this.host.state.validationOverride) { vscode.window.showErrorMessage('Validate your goal first, or use Override.'); return; }

    // Quality gate: evaluate before push
    const gateResult = await this.host.evaluateQualityGate('pre_push');
    if (gateResult && !gateResult.passed && !gateResult.overridden) {
      this.host.postMessage({ type: 'qualityGateResult', result: gateResult });
      if (gateResult.blocks.length > 0) {
        const override = await vscode.window.showWarningMessage(
          `Quality gate blocked this push:\n${gateResult.blocks.map(b => '  ✗ ' + b.reason).join('\n')}\n\nOverride and push anyway?`,
          'Override and push',
          'Cancel',
        );
        if (override !== 'Override and push') { return; }
      }
    }

    const pick = await vscode.window.showWarningMessage(`Tie the knot on "${this.host.state.goal}"? This will commit and push.`, 'Yes, ship it', 'Cancel');
    if (pick !== 'Yes, ship it') { return; }
    try {
      const threadState = {
        goal: this.host.state.goal,
        taskId: this.host.state.taskId,
        taskTitle: this.host.state.taskTitle,
        taskSource: this.host.state.taskSource,
        taskUrl: this.host.state.taskUrl || undefined,
        subtasks: [...this.host.state.subtasks],
        branchName: this.host.state.branchName,
      };
      // Capture the validation result before clearState() wipes it — tie-the-knot
      // automation (Jira → Done + feedback comment) needs the validation context.
      const validationAtShip = this.host.state.validationResult;
      const { subject, body } = await this.resolveCommitMessage();
      this.host.setBusy('push', true);
      const { branch, pushed } = await shipThread(this.host.state.taskId, subject, body);
      const repositoryPath = this.host.getRepositoryPath();
      const completedRecord = await updateBranchRecord(this.host.context, repositoryPath, branch, {
        currentStatus: 'inactive',
        commitCount: await getCommitCount(branch).catch(() => 0),
        latestCommitHash: (await getLatestCommit(branch).catch(() => ({ hash: '', message: '' }))).hash,
        latestCommitMessage: (await getLatestCommit(branch).catch(() => ({ hash: '', message: '' }))).message,
      });
      void completedRecord;
      stopDriftDetection();
      await clearState(this.host.context);
      Object.assign(this.host.state, getState(this.host.context));
      this.host.postMessage({ type: 'stateCleared', branch, pushed, taskId: threadState.taskId });
      await this.host.refreshBranchContext(true);
      await this.host.refreshCommitContext(true);
      if (pushed) {
        const githubToken = await this.host.context.secrets.get('tyne_github_token');
        if (githubToken) {
          await notifyWithActions(
            `Thread complete! Branch ${branch} pushed. ✓`,
            [{ title: 'Open Tasks', command: 'tyne.focusSidebar' }],
          );
          this.maybeCreateDraftPR({ ...threadState, branchName: branch });
        } else {
          await notifyWithActions(
            `Thread complete! Branch ${branch} pushed. ✓`,
            [
              { title: 'Connect GitHub', command: 'tyne.connectGitHub' },
              { title: 'Open Tasks', command: 'tyne.focusSidebar' },
            ],
          );
        }
      } else {
        await notifyWithActions(
          'Thread committed locally. Add a remote to push: git remote add origin <url>',
          [{ title: 'Open Tasks', command: 'tyne.focusSidebar' }],
        );
      }
      // Close the linked PM task + post the feedback comment on tie-the-knot,
      // respecting the autoCloseTrigger setting (await so failures surface).
      try {
        await this.host.runTieKnotAutomation(branch, threadState, validationAtShip, pushed);
      } catch (autoErr: unknown) {
        console.error('Tyne: tie-the-knot automation failed', autoErr);
        vscode.window.showWarningMessage(
          autoErr instanceof Error ? autoErr.message : 'Tie-the-knot could not update the PM task.',
        );
      }
    } catch (err: unknown) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
    finally { this.host.setBusy('push', false); }
  }

  async resolveCommitMessage(): Promise<{ subject: string; body: string }> {
    if (!this.host.isProjectLeadMode()) { return { subject: this.host.state.goal, body: '' }; }
    const githubToken = await this.host.context.secrets.get('tyne_github_token');
    if (!githubToken) { vscode.window.showWarningMessage('Commit synthesis skipped: GitHub is not connected.'); return { subject: this.host.state.goal, body: '' }; }

    try {
      this.host.postMessage({ type: 'synthStarted' });
      const synth = await synthesizeCommitMessage(
        this.host.context,
        this.host.state.goal,
        this.host.state.taskId,
        this.host.state.subtasks,
        { allowByok: byokAllowedForTier(this.host.userProfile.tier) },
      );
      this.host.setBusy('generate', false);
      const choice = await vscode.window.showInformationMessage(`Commit: "${synth.subject}"`, 'Use this', 'Edit', 'Use original goal');
      if (choice === 'Use this') { return { subject: synth.subject, body: synth.body }; }
      if (choice === 'Edit') {
        const edited = await vscode.window.showInputBox({ value: synth.subject, prompt: 'Edit commit message', placeHolder: 'feat(PRO-102): ...' });
        return { subject: edited || synth.subject, body: synth.body };
      }
    } catch (err: unknown) {
      this.host.setBusy('generate', false);
      vscode.window.showWarningMessage('Commit synthesis failed, using goal as message: ' + (err instanceof Error ? err.message : String(err)));
    }
    return { subject: this.host.state.goal, body: '' };
  }

  async generateCommitPreview(): Promise<void> {
    if (!this.host.state.taskId || this.host.state.status !== 'weaving') {
      vscode.window.showErrorMessage('Start a thread for this task before generating a commit.');
      return;
    }
    try {
      const { subject, body } = await this.resolveCommitMessage();
      const preview = [subject, body].filter(Boolean).join('\n\n');
      await vscode.env.clipboard.writeText(preview);
      vscode.window.showInformationMessage(`Commit preview copied: ${subject}`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  clearValidationForNewTask(): void {
    this.host.state.validationResult = null;
    this.host.state.validationOverride = false;
    this.host.state.pmTaskValidationResult = null;
    this.host.postMessage({ type: 'validationReset' });
  }

  async loadTaskIntoThread(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    // Show Create-tasks CTA from cached type before enrichment runs.
    this.host.postThreadCreateTasksVisibility(taskId);
    const stored = this.host.getStoredPmIntelligence(taskId);
    // Goal-only stubs are not enough — re-extract until proof points or subtasks exist.
    const enrichment = hasActionableEnrichment(stored)
      ? { intelligence: stored }
      : await this.host.extractIntelligenceForStartThread(taskId, tool, title);
    const intelligence = enrichment.intelligence;

    this.host.state.taskId = taskId;
    this.host.state.taskTitle = title;
    this.host.state.taskSource = tool;
    this.host.state.taskUrl = url ?? '';
    this.host.state.goal = title;
    if (intelligence?.goal) { this.host.state.goal = intelligence.goal; }
    this.host.state.acceptanceCriteria = intelligence?.acceptanceCriteria || [];
    this.host.state.proofPointTemplates = intelligence?.proofPointTemplates || [];
    this.host.state.validationSteps = intelligence?.validationSteps || [];
    this.host.state.pmTaskContext = intelligence;
    this.host.state.pmEnrichmentStatus = intelligence
      ? (hasEnrichmentContent(intelligence) ? 'success' : 'partial')
      : (enrichment.error ? 'failed' : 'skipped');
    this.host.state.pmEnrichmentError = enrichment.error || '';
    this.host.state.subtasks = buildProofChecklist(intelligence?.subtasks, intelligence?.proofPointTemplates);
    this.host.state.appName = this.host.state.appName || vscode.workspace.workspaceFolders?.[0]?.name || 'Workspace';
    this.clearValidationForNewTask();
    await this.host.rehydrateValidationForTask(taskId);
    await saveState(this.host.context, this.host.state);

    // Prefill the webview form fields immediately so the thread page reflects the task.
    const cachedType = this.host.findCachedTask(taskId)?.issueType
      || getCachedTaskDetailsSync(this.host.context, taskId)?.issueType
      || '';
    this.host.postMessage({
      type: 'prefillThread',
      taskId,
      taskTitle: title,
      taskSource: tool,
      taskUrl: url ?? '',
      issueType: cachedType,
      goal: this.host.state.goal,
      subtasks: this.host.state.subtasks,
      acceptanceCriteria: this.host.state.acceptanceCriteria,
      proofPointTemplates: this.host.state.proofPointTemplates,
      validationSteps: this.host.state.validationSteps,
      pmTaskContext: intelligence,
      pmEnrichmentStatus: this.host.state.pmEnrichmentStatus,
      pmEnrichmentError: this.host.state.pmEnrichmentError,
    });
    this.host.postEnrichmentToWebview(taskId);
    this.host.postMessage({ type: 'navigateTo', page: 'tasks', tab: 'thread' });
  }

  async selectTaskIntoThread(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    const cached = listCachedTasksSync(this.host.context).find(task => task.id === taskId);
    const title = cached?.title || taskId;
    const resolvedTool = (cached?.sourceTool as TynePmTool) || tool;
    if (resolvedTool === 'linear') {
      this.host.logLinear(`Task selected into thread: ${cached?.externalId || taskId.replace(/^linear:/, '')}`);
    } else {
      this.host.logJira(`Task selected into thread: ${taskId}`);
    }
    this.host.setRunner(true);
    try {
      await this.loadTaskIntoThread(taskId, title, resolvedTool, cached?.sourceUrl);
    } finally {
      this.host.setRunner(false);
    }
  }

  async switchTaskInThread(taskId: string, tool: TynePmTool): Promise<void> {
    if (!taskId) { return; }
    if (taskId === this.host.state.taskId) { return; }
    const cached = listCachedTasksSync(this.host.context).find(task => task.id === taskId);
    if (!cached) { return; }
    const resolvedTool = (cached.sourceTool as TynePmTool) || tool;

    // If we are not actually weaving yet, treat this like a normal task selection.
    if (this.host.state.status !== 'weaving') {
      await this.selectTaskIntoThread(taskId, resolvedTool);
      return;
    }

    const repositoryPath = this.host.getRepositoryPath();
    const linked = repositoryPath ? getBranchByTaskId(this.host.context, repositoryPath, taskId) : null;
    const taskLabel = cached.externalId || taskId;
    this.host.setRunner(true);
    try {
      if (linked) {
        const choice = await vscode.window.showInformationMessage(
          `Task ${taskLabel} is already linked to ${linked.branchName}.`,
          'Switch to branch',
          'Keep current branch',
          'Cancel',
        );
        if (choice === 'Switch to branch') {
          await this.host.switchToBranch(linked.branchName);
          await this.loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          vscode.window.showInformationMessage(`Switched to task ${taskLabel} on ${linked.branchName}.`);
        } else if (choice === 'Keep current branch') {
          await this.loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          await notifyWithActions(
            `Task changed to ${taskLabel}. The current branch ${this.host.state.branchName} remains linked to the previous task.`,
            [{ title: 'Start thread for this task', command: 'tyne.startThread' }],
            'warn',
          );
        }
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Task ${taskLabel} has no Tyne branch yet.`,
          'Start new thread',
          'Keep current branch',
          'Cancel',
        );
        if (choice === 'Start new thread') {
          await this.loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          await this.startThread();
        } else if (choice === 'Keep current branch') {
          await this.loadTaskIntoThread(taskId, cached.title, resolvedTool, cached.sourceUrl);
          await notifyWithActions(
            `Task changed to ${taskLabel}. The current branch ${this.host.state.branchName} remains linked to the previous task.`,
            [{ title: 'Start thread for this task', command: 'tyne.startThread' }],
            'warn',
          );
        }
      }
    } finally {
      this.host.setRunner(false);
    }
  }

  async startThreadFromTask(
    taskId: string, title: string, tool: TynePmTool, url?: string,
  ): Promise<void> {
    if (!taskId || !title) { return; }
    if (tool === 'linear') {
      this.host.logLinear(`Start Thread clicked: ${taskId.replace(/^linear:/, '')}`);
    } else {
      this.host.logJira(`Start Thread clicked: ${taskId}`);
    }
    this.host.setRunner(true);
    try {
      await this.loadTaskIntoThread(taskId, title, tool, url);
      // Now start the thread (create branch, set weaving state, refresh).
      await this.startThread();
    } finally {
      this.host.setRunner(false);
    }
  }

  async maybeCreateDraftPR(thread: { goal: string; taskId: string; subtasks: TyneState['subtasks']; branchName: string }): Promise<void> {
    const githubToken = await this.host.context.secrets.get('tyne_github_token');
    if (!githubToken) { return; }
    createDraftPR(githubToken, thread.goal, thread.taskId, thread.subtasks, thread.branchName).then(pr => {
      if (!pr) { return; }
      this.host.postMessage({ type: 'prCreated', url: pr.url, number: pr.number, title: pr.title });
      vscode.window.showInformationMessage(`Draft PR created: ${pr.title}`, 'View PR').then(choice => {
        if (choice === 'View PR') { vscode.env.openExternal(vscode.Uri.parse(pr.url)); }
      });
    }).catch((err: unknown) => { vscode.window.showWarningMessage(`PR creation failed (thread still closed): ${err instanceof Error ? err.message : String(err)}`); });
  }
}
