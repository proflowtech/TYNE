import * as vscode from 'vscode';
import type { SidebarHost } from './sidebarHost';
import { saveState } from '../stateManager';
import { getGit } from '../gitManager';
import { resolveReviewScope, collectLastEditedCode } from '../reviewScopeResolver';
import { getEffectiveAuthToken } from '../deviceAuth';
import { normalizeTier } from '../codeValidationService';
import { TyneValidationResult } from '../validationTypes';
import { getValidateReviewService } from '../validateReviewService';
import {
  TyneValidateReviewResult,
  ReviewPmTaskContext,
  FindingFeedbackRequest,
  FindingVerdict,
  ReviewScope,
} from '../validateReviewTypes';
import { autoSelectMode, classifyPrSize, type ReviewMode } from '../reviewPerformance';
import { publishReviewDiagnostics } from '../reviewDiagnosticsService';
import { handleValidationPass } from '../taskAutomationService';
import {
  TynePmTool,
  TynePmTaskValidationResult,
  TyneCreateTaskInput,
} from '../taskTypes';
import { createTask as pmCreateTask, canUsePmWrite } from '../writableTaskService';
import { parseNumstat } from '../numstat';
import { assessScopeBlowout, buildTouchSnapshot, isUsablePreFixSnapshot, type TouchSnapshot } from '../services/scopeBlowout';
import { isLocatableFindingPath } from '../services/findingGrounding';
import { applyProofStrikeOff } from '../taskEnrichmentService';
import { notifyWithActions } from '../notifyWithActions';
import { getAxiomReportVault } from '../axiomReportVault';

type ValidateReviewHost = Pick<
  SidebarHost,
  | 'context'
  | 'state'
  | 'postMessage'
  | 'userProfile'
  | 'isAuthenticated'
  | 'byokKeyService'
  | 'usageService'
  | 'historyService'
  | 'displayService'
  | 'traceService'
  | 'validationService'
  | 'postSettings'
  | 'postState'
  | 'setBusy'
  | 'logLinear'
  | 'getRepositoryId'
  | 'buildAutomationCtx'
  | 'refreshTasksContext'
  | 'notifyValidationOutcome'
  | 'updateStatusBar'
  | 'handleInvalidGitHubToken'
>;

export class ValidateReviewController {
  constructor(private readonly host: ValidateReviewHost) {}


  // On a passing validation, mark the matched proof points / acceptance criteria
  // as satisfied so the thread checklist "closes" — without touching the PM tool.
  markProofPointsMet(result: TyneValidationResult): void {
    if (!applyProofStrikeOff(this.host.state.subtasks || [], result)) { return; }
    void saveState(this.host.context, this.host.state);
    this.host.postState();
  }

  /** Restore latest validation + proof strike-off after task load / checklist rebuild. */
  async rehydrateValidationForTask(taskId: string): Promise<void> {
    const id = String(taskId || '').trim();
    if (!id) { return; }
    const prior = await this.host.historyService.getLatestValidationForTask(id);
    if (!prior || prior.taskId !== id) { return; }
    this.host.state.validationResult = prior;
    await saveState(this.host.context, this.host.state);
    const stages = this.mapResultToStages(prior, this.host.userProfile.tier);
    this.host.postMessage({
      type: 'validationComplete',
      result: prior,
      stages,
      trace: prior.trace || undefined,
    });
    this.markProofPointsMet(prior);
    await notifyWithActions(
      'Prior validation restored for this task.',
      [{ title: 'Open report', command: 'tyne.openLatestValidateReview' }],
    );
    this.host.updateStatusBar();
  }



  postValidationRunning(tier: string): void {
    const normalTier = normalizeTier(tier);
    const stages = normalTier === 'max'
      ? [
          { stage: 1, name: 'Code Analysis' },
          { stage: 2, name: 'Goal Matching' },
          { stage: 3, name: 'Risk Assessment' },
          { stage: 4, name: 'Performance Check' },
          { stage: 5, name: 'Security Check' },
        ]
      : [
          { stage: 1, name: 'Code Analysis' },
          { stage: 2, name: 'Goal Matching' },
          { stage: 3, name: 'Risk Assessment' },
        ];
    const trace = this.host.traceService.buildValidationTraceRunning(normalTier, {
      taskId: this.host.state.taskId || undefined,
      taskTitle: this.host.state.taskTitle || undefined,
      goal: this.host.state.goal || undefined,
      branchName: this.host.state.branchName || undefined,
    });
    this.host.postMessage({ type: 'validationRunning', tier: normalTier, stages, trace });
  }



  mapResultToStages(result: TyneValidationResult, tier: string): Array<{ stage: number; name: string; status: 'completed' | 'failed'; details?: string }> {
    const normalTier = normalizeTier(tier);
    const isMax = normalTier === 'max';
    const isPass = result.status === 'pass';
    const base = [
      { stage: 1, name: 'Code Analysis', status: 'completed' as const, details: isMax ? `Reviewed ${result.filesReviewed?.length ?? 0} file(s)` : undefined },
      { stage: 2, name: 'Goal Matching', status: (isPass ? 'completed' : result.status === 'fail' ? 'failed' : 'completed') as 'completed' | 'failed', details: isMax ? (typeof result.matchPercent === 'number' ? `Matched ${result.matchPercent}% of requirements` : 'Requirements checked') : undefined },
      { stage: 3, name: 'Risk Assessment', status: 'completed' as const, details: isMax ? (result.riskLevel ? `Risk level: ${result.riskLevel}` : 'Risk assessed') : undefined },
    ];
    if (isMax) {
      base.push(
        { stage: 4, name: 'Performance Check', status: 'completed' as const, details: result.codeQualityNotes?.length ? `${result.codeQualityNotes.length} note(s) found` : 'No issues found' },
        { stage: 5, name: 'Security Check', status: 'completed' as const, details: result.missingRequirements?.length ? `${result.missingRequirements.length} gap(s) noted` : 'No vulnerabilities found' },
      );
    }
    return base;
  }



  async validateGoal(): Promise<void> {
    this.host.setBusy('think', true);
    this.postValidationRunning(this.host.userProfile.tier);
    try {
      const normalizedTier = normalizeTier(this.host.userProfile.tier);
      const pmSource = this.host.state.taskSource.toLowerCase();
      const isPmTask = (pmSource === 'jira' || pmSource === 'linear') && this.host.state.taskId;
      let result: TyneValidationResult;
      let pmValidationResult: TynePmTaskValidationResult | null = null;

      if (isPmTask) {
        if (pmSource === 'linear') { this.host.logLinear('Linear validation started'); }
        pmValidationResult = await this.host.validationService.validatePmTask(this.host.userProfile.tier);
        this.host.state.pmTaskValidationResult = pmValidationResult;
        result = this.mapPmValidationToTyneValidation(pmValidationResult);
        if (pmSource === 'linear') { this.host.logLinear('Linear validation completed'); }
      } else {
        // Run the validation without an OS-level progress notification — the
        // sidebar's live stages panel (validationRunning → validationComplete) is
        // the single surface for validation state. No window notifications.
        result = await this.host.validationService.validateGoal(this.host.userProfile.tier);
      }
      const trace = this.host.traceService.buildValidationTraceComplete(normalizedTier, result, {
        taskId: this.host.state.taskId || result.taskId || undefined,
        taskTitle: this.host.state.taskTitle || result.taskTitle || undefined,
        goal: this.host.state.goal || undefined,
        branchName: this.host.state.branchName || result.branchName || undefined,
      });
      result.trace = trace;

      this.host.state.validationResult = result;
      await saveState(this.host.context, this.host.state);

      const completedStages = this.mapResultToStages(result, this.host.userProfile.tier);
      const tier = normalizeTier(this.host.userProfile.tier);
      const usageSummary = await this.host.usageService.getUsageSummary(tier).catch(() => null);

      this.host.postMessage({
        type: 'validationComplete',
        result,
        pmValidationResult: pmValidationResult ?? undefined,
        stages: completedStages,
        trace,
        validationCountRemaining: usageSummary?.remaining ?? null,
        validationCountTotal: usageSummary?.limit ?? null,
      });
      this.host.postSettings();
      await this.postValidationHistory();
      // Result (pass/partial/fail) is shown in the sidebar scorecard — no popups.
      if (result.status === 'pass') {
        const automCtx = this.host.buildAutomationCtx();
        if (automCtx) { void handleValidationPass({ ...automCtx, validationResult: result }); }
      }
      // The PM task is closed on tie-the-knot (ship), NOT here. On a passing
      // validation we only mark the matched proof points / acceptance criteria as
      // satisfied so the thread checklist reflects progress without touching Jira.
      this.markProofPointsMet(result);
      this.host.updateStatusBar();
      await this.host.notifyValidationOutcome(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const trace = this.host.traceService.buildValidationTraceError(normalizeTier(this.host.userProfile.tier), message, {
        taskId: this.host.state.taskId || undefined,
        taskTitle: this.host.state.taskTitle || undefined,
        goal: this.host.state.goal || undefined,
        branchName: this.host.state.branchName || undefined,
      });
      // Error surfaces inline in the sidebar stages panel (validationError state).
      this.host.postMessage({ type: 'validationError', message, trace });
    } finally {
      this.host.setBusy('think', false);
    }
  }



  mapPmValidationToTyneValidation(pm: TynePmTaskValidationResult): TyneValidationResult {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: this.host.state.taskId,
      taskTitle: this.host.state.taskTitle,
      branchName: this.host.state.branchName,
      commitHash: undefined,
      provider: pm.modelProvider as any,
      tier: normalizeTier(this.host.userProfile.tier),
      status: pm.status,
      matchPercent: pm.matchPercent,
      riskLevel: 'not_assessed',
      summary: pm.summary,
      detailedExplanation: pm.recommendedNextActions.length ? pm.recommendedNextActions.join('\n') : undefined,
      missingRequirements: pm.missingWork.length ? pm.missingWork : undefined,
      criteriaMet: pm.passedCriteria.length ? pm.passedCriteria : undefined,
      criteriaNotMet: pm.failedCriteria.length ? pm.failedCriteria : undefined,
      // Prefer structured developerActions; keep suggestions only as a fallback.
      suggestions: pm.developerActions?.length
        ? undefined
        : (pm.recommendedNextActions.length ? pm.recommendedNextActions : undefined),
      generatedProofPoints: pm.generatedProofPoints.length ? pm.generatedProofPoints : undefined,
      filesReviewed: pm.codeEvidence?.length ? pm.codeEvidence.map(e => e.file) : pm.changedFiles?.length ? pm.changedFiles : undefined,
      completedGoals: pm.completedGoals,
      pendingGoals: pm.pendingGoals,
      developerActions: pm.developerActions,
      codeEvidence: pm.codeEvidence,
      fullReport: pm.fullReport,
      enrichmentStatus: pm.enrichmentStatus,
      enrichmentError: pm.enrichmentError,
      contextSource: pm.contextSource,
      confidence: pm.confidence,
      validationStatus: pm.validationStatus,
      warnings: pm.warnings,
      resolvedContext: pm.resolvedContext,
      developerTaskPlan: pm.developerTaskPlan,
      createdAt: new Date().toISOString(),
    };
  }



  async postValidationHistory(): Promise<void> {
    const tier = normalizeTier(this.host.userProfile.tier);
    const history = await this.host.historyService.listValidationHistory(tier);
    const summary = await this.host.usageService.getUsageSummary(tier);
    this.host.postMessage({
      type: 'validationHistory',
      tier,
      history: history.map(h => tier === 'free' ? this.host.displayService.toFreeValidationView(h) : this.host.displayService.toEnhancedValidationView(h)),
      summary,
      usageText: this.host.displayService.formatUsageSummary(summary),
    });
  }



  async handleValidationHistoryRequest(filters?: unknown): Promise<void> {
    const tier = normalizeTier(this.host.userProfile.tier);
    const history = await this.host.historyService.listValidationHistory(tier);
    const typedFilters = (filters || {}) as Record<string, unknown>;
    const filtered = typedFilters && Object.keys(typedFilters).length > 0
      ? await this.host.historyService.filterValidationHistory(typedFilters as import('../validationTypes').TyneValidationHistoryFilters)
      : history;
    this.host.postMessage({
      type: 'validationHistory',
      tier,
      history: filtered.map(h => tier === 'free' ? this.host.displayService.toFreeValidationView(h) : this.host.displayService.toEnhancedValidationView(h)),
    });
  }



  async handleValidationTrendsRequest(): Promise<void> {
    const tier = normalizeTier(this.host.userProfile.tier);
    if (tier === 'free') {
      this.host.postMessage({ type: 'validationTrends', trends: null, reason: 'Trends are available in Pro and Max.' });
      return;
    }
    const { getValidationTrendService } = await import('../validationTrendService');
    const trends = await getValidationTrendService(this.host.historyService).getTrendSummary();
    this.host.postMessage({ type: 'validationTrends', trends });
  }



  async handleReviewTrendsRequest(): Promise<void> {
    const tier = normalizeTier(this.host.userProfile.tier);
    if (tier === 'free') {
      this.host.postMessage({ type: 'reviewTrends', trends: null, reason: 'Review trends are available in Pro and Max.' });
      return;
    }
    try {
      const { getReviewTrendService } = await import('../reviewTrendService');
      const trends = await getReviewTrendService(this.host.context).getReviewTrends();
      this.host.postMessage({ type: 'reviewTrends', trends });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'reviewTrends', trends: null, reason: msg });
    }
  }



  async handleExportValidationHistory(format: 'csv' | 'json', filters?: unknown): Promise<void> {
    const tier = normalizeTier(this.host.userProfile.tier);
    if (tier === 'free') {
      vscode.window.showErrorMessage('Export is available in Pro and Max.');
      return;
    }
    const { getValidationExportService } = await import('../validationExportService');
    const typedFilters = (filters || {}) as import('../validationTypes').TyneValidationHistoryFilters;
    const exportService = getValidationExportService(this.host.historyService);
    const content = await exportService.exportValidationHistory(typedFilters, format);
    const filePath = await exportService.saveExportToDownloads(content, format);
    vscode.window.showInformationMessage(`Validation history exported to ${filePath}`);
    this.host.postMessage({ type: 'validationExported', format, filePath });
  }



  /**
   * When Full/Quick would auto-downgrade for size, ask — never silent triage after Full.
   * Returns undefined if the user cancels.
   */
  async confirmReviewMode(
    requested: ReviewMode,
    scope?: ReviewScope,
    selectedCommitSha?: string,
  ): Promise<ReviewMode | undefined> {
    try {
      const resolved = scope || await resolveReviewScope().catch(() => 'staged_changes' as ReviewScope);
      const edited = await collectLastEditedCode(resolved, selectedCommitSha);
      if (!edited) { return requested; }
      const size = classifyPrSize(edited.diff, edited.changedFiles.length);
      const suggested = autoSelectMode(requested, size);
      if (suggested === requested) { return requested; }
      const pick = await vscode.window.showWarningMessage(
        `This PR is ${size.classification} (${size.fileCount} files, ${size.totalLinesChanged} lines). ` +
          `Requested ${requested} would normally use ${suggested}. Choose depth for this run:`,
        { modal: true },
        'Full (slow)',
        'Quick',
        'Triage',
      );
      if (!pick) { return undefined; }
      if (pick.startsWith('Full')) { return 'full'; }
      if (pick === 'Quick') { return 'quick'; }
      return 'triage';
    } catch {
      return requested;
    }
  }

  async runCodeReview(mode: 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr'): Promise<void> {
    if (!this.host.isAuthenticated) {
      this.host.postMessage({ type: 'codeReviewError', message: 'Sign in to run Technical Review.' });
      return;
    }
    const authToken = await getEffectiveAuthToken(this.host.context);
    if (!authToken) {
      this.host.postMessage({ type: 'codeReviewError', message: 'Sign in to run a review.' });
      return;
    }

    const normalizedMode = (['staged_changes', 'current_branch', 'pm_task', 'before_commit', 'before_pr'].includes(mode as string)
      ? mode
      : 'staged_changes') as 'staged_changes' | 'current_branch' | 'pm_task' | 'before_commit' | 'before_pr';
    // Merged into Validate & Review — 'quick' mode for technical review entry points.
    this.host.postMessage({ type: 'validateReviewRunning' });
    try {
      const service = getValidateReviewService(this.host.context);
      let reviewMode: ReviewMode = normalizedMode === 'before_pr' || normalizedMode === 'pm_task' ? 'full' : 'quick';
      const scopeMap: Record<string, ReviewScope | undefined> = {
        staged_changes: 'staged_changes',
        current_branch: 'unstaged_changes',
        before_commit: 'staged_changes',
        before_pr: 'last_commit',
        pm_task: undefined,
      };
      const confirmed = await this.confirmReviewMode(reviewMode, scopeMap[normalizedMode]);
      if (!confirmed) {
        this.host.postMessage({ type: 'codeReviewError', message: 'Review cancelled.' });
        return;
      }
      reviewMode = confirmed;
      let pmTask: ReviewPmTaskContext | undefined;
      if (normalizedMode === 'pm_task') {
        const sourceRaw = (this.host.state.taskSource || '').trim().toLowerCase();
        if (!this.host.state.taskId || (sourceRaw !== 'jira' && sourceRaw !== 'linear')) {
          this.host.postMessage({
            type: 'codeReviewError',
            message: 'Select a Jira or Linear task before PM-task review.',
          });
          return;
        }
        const pmCtx = this.host.state.pmTaskContext?.pmContext;
        const description = [
          pmCtx?.summary,
          this.host.state.pmTaskContext?.goal,
          this.host.state.goal,
        ].map(s => (s || '').trim()).find(Boolean) || this.host.state.taskTitle || '';
        pmTask = {
          source: sourceRaw === 'linear' ? 'linear' : 'jira',
          issueIdentifier: this.host.state.pmTaskContext?.issueIdentifier || this.host.state.taskId,
          title: this.host.state.taskTitle || this.host.state.goal || 'Untitled task',
          description,
          goal: this.host.state.pmTaskContext?.goal || this.host.state.goal || description,
          acceptanceCriteria: this.host.state.acceptanceCriteria?.length
            ? this.host.state.acceptanceCriteria
            : (pmCtx?.acceptanceCriteria || []),
          subtasks: this.host.state.subtasks.map(s => ({ title: s.text, status: s.done ? 'completed' : 'not_started' })),
          validationSteps: this.host.state.validationSteps,
          decisions: pmCtx?.decisions,
          constraints: pmCtx?.constraints,
          blockers: pmCtx?.blockers,
          openQuestions: pmCtx?.openQuestions,
          attachments: pmCtx?.attachments?.map(a => ({ name: a.name, summary: a.summary })),
          comments: pmCtx?.comments,
          linkedIssues: pmCtx?.linkedIssues,
          developerTaskPlan: this.host.state.pmTaskContext?.developerTaskPlan,
        };
      }
      const result = await service.runReview(
        this.host.userProfile.tier,
        pmTask,
        scopeMap[normalizedMode],
        undefined,
        reviewMode,
        (ev) => this.host.postMessage(ev as Record<string, unknown>),
      );
      this.host.state.validateReviewResult = result;
      this.host.postMessage({
        type: 'codeReviewResult',
        result: {
          id: result.id || `review_${Date.now()}`,
          status: result.status,
          score: result.score,
          summary: result.summary,
          findings: result.findings,
          reviewMode: normalizedMode,
          actualModeUsed: result.actualModeUsed,
          reviewWarnings: result.reviewWarnings,
          createdAt: result.createdAt || new Date().toISOString(),
        },
      });
      this.host.postMessage({ type: 'validateReviewResult', result });
      try {
        const saved = await getAxiomReportVault().saveReport(result);
        this.host.state.validateReviewResult = saved;
        this.host.state.latestValidateReviewReportId = saved.id || '';
        await saveState(this.host.context, this.host.state);
      } catch (vaultErr) {
        console.warn('AXIOM local report vault save failed:', vaultErr);
      }
    } catch (err: unknown) {
      const message = err instanceof Error && err.message.trim()
        ? err.message
        : 'Code review failed. Try again.';
      console.error('Code review failed:', err);
      this.host.postMessage({ type: 'codeReviewError', message });
    }
  }



  async checkScopeBlowoutBeforeValidate() {
    const before = this.host.context.workspaceState.get<TouchSnapshot>('tyne.preFixTouchSnapshot')
      || this.host.context.globalState.get<TouchSnapshot>('tyne.preFixTouchSnapshot');
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!isUsablePreFixSnapshot(before, workspace)) {
      if (before) {
        await this.host.context.workspaceState.update('tyne.preFixTouchSnapshot', undefined);
        await this.host.context.globalState.update('tyne.preFixTouchSnapshot', undefined);
      }
      return null;
    }
    const git = getGit();
    if (!git) { return null; }
    try {
      const status = await git.status();
      const numstatRaw = await git.raw(['diff', '--numstat']).catch(() => '');
      const entries = parseNumstat(numstatRaw);
      const findingFiles = (this.host.state.validateReviewResult?.findings || [])
        .map(f => String(f.file || ''))
        .filter(f => isLocatableFindingPath(f));
      const after = buildTouchSnapshot({
        paths: [
          ...status.files.flatMap(f => [String(f.path || ''), String((f as { from?: string }).from || '')]
            .map(p => p.replace(/\\/g, '/')).filter(Boolean)),
          ...entries.map(e => e.path),
        ],
        additionsDeletions: entries,
        findingFiles,
        workspace,
      });
      return assessScopeBlowout(before, after);
    } catch {
      return null;
    }
  }

  async runValidateReview(
    scope?: string,
    selectedCommitSha?: string,
    opts?: { acknowledgeScopeBlowout?: boolean },
  ): Promise<void> {
    if (!this.host.isAuthenticated) {
      this.host.postMessage({ type: 'validateReviewError', message: 'Sign in to run a review.' });
      this.host.postMessage({ type: 'validationError', message: 'Sign in to run Validate & Review.' });
      return;
    }
    const authToken = await getEffectiveAuthToken(this.host.context);
    if (!authToken) {
      this.host.postMessage({ type: 'validateReviewError', message: 'Sign in to run a review.' });
      this.host.postMessage({ type: 'validationError', message: 'Sign in to run Validate & Review.' });
      return;
    }

    if (!opts?.acknowledgeScopeBlowout) {
      const blowout = await this.checkScopeBlowoutBeforeValidate();
      if (blowout?.blowout) {
        this.host.postMessage({
          type: 'scopeBlowoutWarning',
          message: blowout.message,
          extraPaths: blowout.extraPaths,
          lineDeltaGrowth: blowout.lineDeltaGrowth,
          scope,
          selectedCommitSha,
        });
        return;
      }
    } else {
      await this.host.context.workspaceState.update('tyne.preFixTouchSnapshot', undefined);
      await this.host.context.globalState.update('tyne.preFixTouchSnapshot', undefined);
    }

    const tier = normalizeTier(this.host.userProfile.tier);
    const hasByok = await this.host.byokKeyService.hasApiKey();
    const quota = await this.host.usageService.canRunValidation(tier, hasByok);
    if (!quota.allowed) {
      const message = quota.message || 'Validation limit reached. Upgrade your plan to continue.';
      this.host.postMessage({ type: 'validateReviewError', message, upgradeRequired: true });
      this.host.postMessage({ type: 'validationError', message });
      await this.host.postSettings();
      return;
    }

    const state = this.host.state;
    const sourceRaw = (state.taskSource || '').trim().toLowerCase();
    const isPmTask = Boolean(state.taskId) && (sourceRaw === 'jira' || sourceRaw === 'linear');

    // Thread stays on Thread with inline loader; Reviews page uses the page runner.
    this.host.postMessage({ type: 'validateReviewRunning' });

    try {
      // Linked PM task is optional: when present, pass it for PM-alignment scoring.
      let pmTask: ReviewPmTaskContext | undefined;
      if (isPmTask) {
        const pmCtx = state.pmTaskContext?.pmContext;
        const description = [
          pmCtx?.summary,
          state.pmTaskContext?.goal,
          state.goal,
        ].map(s => (s || '').trim()).find(Boolean) || state.taskTitle || '';
        const acceptanceCriteria = (state.acceptanceCriteria?.length
          ? state.acceptanceCriteria
          : pmCtx?.acceptanceCriteria) || [];
        pmTask = {
          source: sourceRaw === 'linear' ? 'linear' : 'jira',
          issueIdentifier: state.pmTaskContext?.issueIdentifier || state.taskId,
          title: state.taskTitle || state.goal || 'Untitled task',
          description,
          goal: state.pmTaskContext?.goal || state.goal || description,
          acceptanceCriteria,
          subtasks: state.subtasks.map(s => ({ title: s.text, status: s.done ? 'completed' : 'not_started' })),
          validationSteps: state.validationSteps,
          decisions: pmCtx?.decisions,
          constraints: pmCtx?.constraints,
          blockers: pmCtx?.blockers,
          openQuestions: pmCtx?.openQuestions,
          attachments: pmCtx?.attachments?.map(a => ({ name: a.name, summary: a.summary })),
          comments: pmCtx?.comments,
          linkedIssues: pmCtx?.linkedIssues,
          developerTaskPlan: state.pmTaskContext?.developerTaskPlan,
        };
      }

      const service = getValidateReviewService(this.host.context);
      const validScopes = ['staged_changes', 'unstaged_changes', 'last_commit', 'selected_commit'];
      const resolvedScope = scope && validScopes.includes(scope) ? scope as ReviewScope : undefined;
      await this.prepareWorkspaceForReview(resolvedScope);
      const reviewMode = await this.confirmReviewMode('full', resolvedScope, selectedCommitSha);
      if (!reviewMode) {
        this.host.postMessage({ type: 'validateReviewError', message: 'Review cancelled.' });
        this.host.postMessage({ type: 'validationError', message: 'Review cancelled.' });
        return;
      }
      const result = await service.runReview(
        this.host.userProfile.tier,
        pmTask,
        resolvedScope,
        selectedCommitSha,
        reviewMode,
        (ev) => this.host.postMessage(ev as Record<string, unknown>),
      );
      this.host.state.validateReviewResult = result;
      this.host.state.latestValidateReviewReportId = result.id || '';
      await this.host.context.workspaceState.update('tyne.preFixTouchSnapshot', undefined);
      await this.host.context.globalState.update('tyne.preFixTouchSnapshot', undefined);
      publishReviewDiagnostics(result);
      this.host.state.validationResult = this.mapValidateReviewToTyneValidation(result);
      await saveState(this.host.context, this.host.state);
      try {
        const saved = await getAxiomReportVault().saveReport(result);
        this.host.state.validateReviewResult = saved;
        this.host.state.latestValidateReviewReportId = saved.id || '';
        this.host.state.validationResult = this.mapValidateReviewToTyneValidation(saved);
        await saveState(this.host.context, this.host.state);
      } catch (vaultErr) {
        console.warn('AXIOM local report vault save failed:', vaultErr);
      }
      const trace = this.host.traceService.buildValidationTraceComplete(normalizeTier(this.host.userProfile.tier), this.host.state.validationResult, {
        taskId: this.host.state.taskId || undefined,
        taskTitle: this.host.state.taskTitle || undefined,
        goal: this.host.state.goal || undefined,
        branchName: this.host.state.branchName || result.branchName || undefined,
      });
      this.host.state.validationResult.trace = trace;
      await saveState(this.host.context, this.host.state);
      await this.host.historyService.saveValidationResult(this.host.state.validationResult);
      const completedStages = this.mapResultToStages(this.host.state.validationResult, this.host.userProfile.tier);
      this.host.postMessage({ type: 'validateReviewResult', result });
      this.host.postMessage({
        type: 'validationComplete',
        result: this.host.state.validationResult,
        stages: completedStages,
        trace,
      });
      this.markProofPointsMet(this.host.state.validationResult);
      this.host.updateStatusBar();
      await this.host.notifyValidationOutcome(this.host.state.validationResult);
      await this.postValidateReviewReports();
    } catch (err: unknown) {
      const message = err instanceof Error && err.message.trim()
        ? err.message
        : 'Review failed. Try again.';
      console.error('Validate & Review failed:', err);
      if (/session expired|invalid auth token|invalid github token|sign in again/i.test(message)) {
        await this.host.handleInvalidGitHubToken('validate-review');
      }
      this.host.postMessage({ type: 'validateReviewError', message });
      this.host.postMessage({ type: 'validationError', message });
    }
  }



  async handleFindingFeedback(feedback: Record<string, unknown>): Promise<void> {
    try {
      const request: FindingFeedbackRequest = {
        reportId: String(feedback.reportId || ''),
        findingId: String(feedback.findingId || ''),
        verdict: feedback.verdict as FindingVerdict,
        findingTitle: String(feedback.findingTitle || ''),
        findingFile: feedback.findingFile as string | undefined,
        findingCategory: feedback.findingCategory as string | undefined,
        findingSeverity: feedback.findingSeverity as string | undefined,
        repositoryId: this.host.getRepositoryId(),
      };
      const service = getValidateReviewService(this.host.context);
      await service.submitFindingFeedback(request);
      const verdict = String(request.verdict || '');
      if (verdict === 'dismissed' || verdict === 'wrong' || verdict === 'not_relevant') {
        service.rememberDismissedFinding(request.findingTitle || '');
      }
      this.host.postMessage({ type: 'findingFeedbackConfirmed', findingId: request.findingId, verdict: request.verdict });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'findingFeedbackError', message: msg });
    }
  }



  /**
   * Write a finding to `.tyne/learnings.md` so it is suppressed for the team.
   *
   * Scope is asked for up front via a native quick-pick rather than always
   * writing a repo-wide rule. A path-scoped learning ("procedural style is
   * fine *in workers*") is almost always the more accurate decision, and
   * before this it was only reachable by hand-editing the file.
   */
  async addTeamLearning(learning: Record<string, unknown>): Promise<void> {
    const title = String(learning.title || '').trim();
    if (!title) {
      this.host.postMessage({ type: 'teamLearningError', message: 'That finding has no title to record.' });
      return;
    }
    const file = String(learning.file || '').replace(/\\/g, '/').trim();

    try {
      const scope = await this._pickLearningScope(file);
      if (scope === undefined) {
        // Cancelled — re-enable the button, write nothing.
        this.host.postMessage({ type: 'teamLearningError', message: '' });
        return;
      }
      const note = await vscode.window.showInputBox({
        title: 'Why is this acceptable?',
        prompt: 'Optional — recorded in .tyne/learnings.md so reviewers understand the decision',
        placeHolder: 'e.g. workers intentionally stream to stdout',
        ignoreFocusOut: true,
      });

      const service = getValidateReviewService(this.host.context);
      const added = await service.rememberSharedLearning(title, note?.trim() || undefined, scope || undefined);
      this.host.postMessage({ type: 'teamLearningSaved', title, added });
      void vscode.window.showInformationMessage(
        added
          ? `Added to .tyne/learnings.md${scope ? ` (scoped to ${scope})` : ''} — commit it to share with your team.`
          : `"${title}" is already in .tyne/learnings.md.`,
      );
      const uri = service.learningsFileUri();
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'teamLearningError', message: msg });
    }
  }

  /**
   * Returns the chosen glob, `''` for repo-wide, or `undefined` if cancelled.
   * Directory and file options are only offered when the finding has a path.
   */
  private async _pickLearningScope(file: string): Promise<string | undefined> {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const options: Array<{ label: string; description: string; scope: string }> = [];
    if (dir) {
      options.push({ label: `Only in ${dir}/`, description: 'Recommended — narrowest rule that covers this case', scope: `${dir}/**` });
    }
    if (file) {
      options.push({ label: `Only in ${file}`, description: 'This one file', scope: file });
    }
    options.push({ label: 'Everywhere in this repo', description: 'Applies to every file', scope: '' });

    const picked = await vscode.window.showQuickPick(options, {
      title: 'Suppress this finding for the team',
      placeHolder: 'Where should this learning apply?',
      ignoreFocusOut: true,
    });
    return picked?.scope;
  }

  /**
   * Undo a suppression from the "Checked but not shown" panel — either a team
   * learning or the user's own prior dismissal. Without this the panel could
   * only report what was hidden, never act on it.
   */
  async removeTeamLearning(payload: Record<string, unknown>): Promise<void> {
    const source = String(payload.source || 'learning');
    const service = getValidateReviewService(this.host.context);
    try {
      let undone = false;
      if (source === 'dismissed') {
        undone = service.forgetDismissedFinding(String(payload.title || ''));
      } else {
        undone = await service.forgetSharedLearning(
          String(payload.learningTitle || ''),
          String(payload.scope || '') || undefined,
        );
      }
      this.host.postMessage({ type: 'teamLearningRemoved', undone });
      void vscode.window.showInformationMessage(
        undone
          ? 'Suppression removed. Re-run the review to see the finding again.'
          : 'That suppression was not found — it may already have been removed.',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'teamLearningError', message: msg });
    }
  }

  async createTaskFromFinding(finding: Record<string, unknown>): Promise<void> {
    const tier = this.host.userProfile?.tier ?? 'CORE';
    if (!canUsePmWrite(tier)) {
      this.host.postMessage({ type: 'taskWriteBlocked', reason: 'Creating tasks from findings is available in Pro and Max.' });
      return;
    }
    try {
      const state = this.host.state;
      const sourceTool: TynePmTool = state.taskSource.toLowerCase() === 'linear' ? 'linear' : 'jira';
      const title = String(finding.title || 'Review finding');
      const category = String(finding.category || 'correctness');
      const isScopeGap = category === 'pm_alignment';
      const fileLoc = finding.file ? `${finding.file}${finding.line ? ':' + finding.line : ''}` : '';
      const description = [
        String(finding.explanation || ''),
        fileLoc ? `\n**File:** ${fileLoc}` : '',
        finding.suggestedFix ? `\n**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`` : '',
        `\n**Severity:** ${finding.severity || 'medium'} · **Category:** ${category}`,
      ].join('');
      const input: TyneCreateTaskInput = {
        title: `${isScopeGap ? '[Scope]' : '[Review]'} ${title.slice(0, 100)}`,
        description,
        status: 'todo',
        priority: finding.severity === 'critical' ? 'urgent' : finding.severity === 'high' ? 'high' : 'medium',
        sourceTool,
      };
      const details = await pmCreateTask(this.host.context, tier, input);
      this.host.postMessage({ type: 'taskCreated', details });
      vscode.window.showInformationMessage(`Task created from ${isScopeGap ? 'scope gap' : 'finding'}: ${details.title}`);
      await this.host.refreshTasksContext(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.postMessage({ type: 'taskWriteError', message: msg });
      vscode.window.showErrorMessage(`Create task from finding failed: ${msg}`);
    }
  }



  async fixPendingGoal(goal: Record<string, unknown>): Promise<void> {
    const relatedFile = String(goal.relatedFile || '');
    const relatedFiles = Array.isArray(goal.relatedFiles)
      ? goal.relatedFiles.map(f => String(f || '')).filter(Boolean)
      : [];
    const file = relatedFile || relatedFiles[0] || '';
    const suggestedAction = String(goal.suggestedAction || '').trim();
    const title = String(goal.title || 'Pending scope item');

    if (suggestedAction) {
      await vscode.env.clipboard.writeText(suggestedAction);
    }

    if (file) {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const fileUri = vscode.Uri.joinPath(wsFolder.uri, file);
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, { preview: true });
          vscode.window.showInformationMessage(
            suggestedAction
              ? `Opened ${file}. Suggested action copied to clipboard.`
              : `Opened ${file} for: ${title}`
          );
          return;
        } catch {
          // Fall through to clipboard / message if file cannot be opened.
        }
      }
    }

    if (suggestedAction) {
      vscode.window.showInformationMessage(`Suggested action copied: ${suggestedAction}`);
      return;
    }
    vscode.window.showInformationMessage(`No file or suggested action for: ${title}`);
  }



  async pendingGoalFeedback(goal: Record<string, unknown>): Promise<void> {
    const title = String(goal.title || 'Pending scope item');
    const verdict = String(goal.verdict || '');
    if (verdict === 'out_of_scope') {
      vscode.window.showInformationMessage(`Marked out of scope: ${title}`);
      this.host.postMessage({
        type: 'pendingGoalFeedbackConfirmed',
        title,
        verdict: 'out_of_scope',
      });
      return;
    }
    vscode.window.showInformationMessage(`Recorded feedback for: ${title}`);
  }

  /**
   * Make sure applied/agent fixes reach the reviewed diff before validation:
   * save dirty buffers (git reads from disk) and, for staged scope, surface
   * staged files whose working-tree copy has newer edits.
   */

  /**
   * Make sure applied/agent fixes reach the reviewed diff before validation:
   * save dirty buffers (git reads from disk) and, for staged scope, surface
   * staged files whose working-tree copy has newer edits.
   */
  async prepareWorkspaceForReview(scope?: ReviewScope): Promise<void> {
    const hasDirty = vscode.workspace.textDocuments.some(d => d.isDirty && !d.isUntitled);
    if (hasDirty) {
      try { await vscode.workspace.saveAll(false); } catch { /* validation proceeds on disk state */ }
    }

    const effectiveScope = scope || await resolveReviewScope().catch(() => undefined);
    if (effectiveScope !== 'staged_changes') { return; }
    const git = getGit();
    if (!git) { return; }
    const status = await git.status().catch(() => null);
    if (!status) { return; }
    const drifted = status.files
      .filter(f => f.index !== ' ' && f.index !== '?' && f.index !== '' && f.working_dir !== ' ' && f.working_dir !== '?' && f.working_dir !== '')
      .map(f => f.path);
    if (!drifted.length) { return; }

    const choice = await vscode.window.showWarningMessage(
      `${drifted.length} staged file(s) also have newer unstaged edits (e.g. applied fixes). The review validates the staged version only.`,
      'Stage Latest & Validate',
      'Validate Staged Only',
    );
    if (choice === 'Stage Latest & Validate') {
      try {
        await git.add(drifted);
      } catch {
        vscode.window.showWarningMessage('Could not stage the edited files — the review will use the currently staged versions.');
      }
    }
  }



  mapValidateReviewToTyneValidation(result: TyneValidateReviewResult): TyneValidationResult {
    const status = result.status === 'passed' ? 'pass' : result.status === 'blocked' ? 'fail' : 'partial';
    const completedGoals = (result.completedGoals || []).map(goal => typeof goal === 'string'
      ? { title: goal }
      : goal);
    const criteriaMet = completedGoals.map(g => g.title).filter(Boolean);
    const ac = (result as TyneValidateReviewResult & {
      acValidation?: { criteria?: Array<{ text?: string; status?: string; implemented?: boolean }> };
    }).acValidation;
    if (ac?.criteria?.length) {
      for (const c of ac.criteria) {
        if (c && (c.status === 'implemented' || c.implemented === true) && c.text) {
          criteriaMet.push(c.text);
        }
      }
    }
    return {
      id: result.id || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: this.host.state.taskId || result.threadId,
      taskTitle: this.host.state.taskTitle || result.issueTitle,
      branchName: result.branchName || this.host.state.branchName,
      commitHash: result.commitSha,
      provider: 'managed',
      tier: normalizeTier(this.host.userProfile.tier),
      status,
      matchPercent: result.score,
      riskLevel: result.riskLevel,
      summary: result.summary,
      missingRequirements: result.pendingGoals?.map(g => g.title),
      criteriaMet,
      criteriaNotMet: result.pendingGoals?.map(g => ({ criterion: g.title, reason: g.reason })),
      suggestions: result.nextActions?.map(a => a.title),
      codeQualityNotes: result.findings?.map(f => `${f.severity}: ${f.title}`),
      filesReviewed: result.visualDiff?.map(f => f.file),
      completedGoals,
      pendingGoals: result.pendingGoals?.map(g => ({
        title: g.title,
        reason: g.reason,
        suggestedAction: g.suggestedAction,
        relatedFiles: g.relatedFiles,
        priority: g.priority || 'medium',
      })),
      developerActions: result.nextActions,
      codeEvidence: result.visualDiff?.map(f => ({
        file: f.file,
        reason: `${f.status} · +${f.additions || 0} -${f.deletions || 0}`,
      })),
      fullReport: result.fullReport,
      confidence: result.confidence,
      validationStatus: result.status,
      createdAt: result.createdAt || new Date().toISOString(),
    };
  }



  async postValidateReviewReports(): Promise<void> {
    try {
      const service = getValidateReviewService(this.host.context);
      const reports = await service.listReports();
      this.host.postMessage({ type: 'validateReviewReportsLoaded', reports });
    } catch (err) {
      console.warn('Validate & Review history load failed:', err);
      // Still surface an empty list so the UI does not stick on a spinner.
      this.host.postMessage({ type: 'validateReviewReportsLoaded', reports: [] });
    }
  }
}
