import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { getGit } from './gitManager';
import { getByokKeyService } from './byokKeyService';
import { getState } from './stateManager';
import { getAutomationSettings } from './automationMetadataService';
import { getEffectiveAuthToken } from './deviceAuth';
import { collectLastEditedCode, resolveReviewScope } from './reviewScopeResolver';
import { collectSafeCodebaseContext } from './safeCodebaseContextCollector';
import { collectStaticAnalysis } from './staticAnalysisCollector';
import { getTierPolicy, truncateDiff, truncateContext, loadCustomGuardrails } from './reviewGuardrailEngine';
import {
  computeContributionBreakdown,
  computeLanguageBreakdownFromChangedFiles,
} from './reviewStats';
import { resolvePrivacySettings } from './privacy/privacyModeService';
import { sanitizeValidateReviewPayload } from './privacy/payloadSanitizer';
import { runDirectByokReview } from './privacy/directByokReview';
import { effectivePrivacyMode, resolveValidateReviewFunctionUrl } from './privacy/residencyRouter';
import { redactSensitiveText } from './privacy/localRedactionEngine';
import { runLocalQualityEngine, qualityFindingsToReviewFindings } from './quality/qualityEngine';
import { getSemanticWorkspaceIndex } from './services/semanticIndexService';
import { appendLearning, matchLearning, parseLearningsFile, removeLearning, type Learning } from './quality/learningsStore';
import { getLineHistory } from './gitManager';
import type { FingerprintIndex } from './quality/semantic/fingerprintIndex';
import { detectSecrets, secretsToReviewFindings } from './quality/secretsDetector';
import { detectInjectionVulnerabilities, hasBlockingSqlInjection, injectionToReviewFindings } from './quality/injectionDetector';
import { detectStaticSecurityHeuristics } from './quality/staticSecurityHeuristics';
import { getAxiomReportVault, mergeAxiomReports } from './axiomReportVault';
import {
  checkDependencyVulnerabilities,
  dependencyVulnsToReviewFindings,
  hasBlockingDependencyCve,
  type DependencyVulnerabilityResult,
} from './quality/dependencyVulnerabilityChecker';
import { scanForAiSlop } from './quality/vibeCodeScanner';
import { changedLinesFromDiff, extractFileFacts } from './quality/astFacts';
import { detectEffects, type EffectSite } from './quality/effectDetector';
import { detectDecisions, type DecisionSite } from './quality/branchDetector';
import { buildArchitectureGraph, type FileImportHint } from './quality/architectureGraph';
import { BLAST_RADIUS_CAPS, findBlastRadiusSync, isBlastSkipPath } from './quality/blastRadius';
import {
  mergeImporters,
  packCodegraphNeighborhood,
  similarFromFingerprints,
  neighborhoodFileList,
  type Hop1Result,
} from './quality/importGraph';
import { collectLspImporters } from './services/lspNeighborhood';
import {
  buildPrAnalysisFromReview,
  explainScopeDrift,
} from './services/scopeDriftExplainer';
import {
  acValidationToReviewFindings,
  validateAcceptanceCriteria,
} from './quality/acceptanceCriteriaValidator';
import {
  buildFileReviewConfig,
  mergeFileReviewFindings,
  reviewFilesInParallel,
} from './services/reviewFileParallel';
import type { FileReviewCache } from './validateReviewPipeline';
import {
  MODE_CONFIGS,
  classifyPrSize,
  rankFilesByRisk,
  selectFilesForMode,
  timeStage,
  GLOBAL_REVIEW_BUDGET_MS,
  enforceIncompleteReviewHonesty,
  type ReviewMode,
  type ReviewProgressFn,
  type ReviewWarning,
  type StageTiming,
} from './reviewPerformance';
import * as fs from 'fs';
import * as path from 'path';
import { getRecurringVibeTitles } from './reviewTrendService';
import {
  TyneValidateReviewResult,
  TyneValidateReviewFinding,
  TyneValidateReviewResponse,
  TyneValidateReviewHistoryResponse,
  TyneValidateReviewError,
  TyneValidateReviewRequest,
  ReviewTier,
  ReviewScope,
  LastEditedCodeContext,
  SafeCodebaseContext,
  ReviewPmTaskContext,
  ReviewCustomGuardrails,
  isValidateReviewResult,
  compactReviewLimits,
  FindingFeedbackRequest,
  FindingFeedbackResponse,
  FindingVerdict,
  verdictFromFindings,
  toDisplaySeverity,
} from './validateReviewTypes';
import { postProcessReviewFindings, carryForwardUnresolvedMinors, type SuppressionRecord } from './services/findingsMerger';
import { emptyGroundingStats } from './services/findingGrounding';

/*
 * PART 0 — Large-PR timeout diagnosis (code audit + stage instrumentation):
 * 1) PRIMARY: edge LLM chunk review (per-file packs) — latency ≈ packs × model latency;
 *    grows near-linear with file count and blows past 60–90s on 40–100+ files.
 * 2) SECONDARY: collectSafeCodebaseContext (findFiles + full changed contents) and
 *    full-project `tsc --noEmit` in static analysis (now skipped when >20 files).
 * 3) TERTIARY: clone detection O(changed×nearby) — now hash-bucketed.
 * Mitigations: mode auto-downgrade, file risk caps, edge budget, cache-before-LLM.
 */

const REVIEW_TIMEOUT_MS = 300_000;
const LAST_REVIEW_FINDINGS_KEY = 'tyne.lastValidateReviewFindings';
const DISMISSED_FINDING_TITLES_KEY = 'tyne.dismissedFindingTitles';
const FILE_REVIEW_CACHE_KEY = 'tyne.fileReviewCache';


export function getValidateReviewService(context: vscode.ExtensionContext): ValidateReviewService {
  return new ValidateReviewService(context);
}

export class ValidateReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidateReviewError';
  }
}

export class ValidateReviewService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async runReview(
    tier: string,
    pmTask?: ReviewPmTaskContext,
    scope?: ReviewScope,
    selectedCommitSha?: string,
    mode: ReviewMode = 'full',
    onProgress?: ReviewProgressFn,
  ): Promise<TyneValidateReviewResult> {
    const timings: StageTiming[] = [];
    const warnings: ReviewWarning[] = [];
    const budgetStart = Date.now();
    const remainingMs = () => GLOBAL_REVIEW_BUDGET_MS - (Date.now() - budgetStart);

    const normalizedTier = this._normalizeTier(tier);
    const policy = getTierPolicy(normalizedTier);

    onProgress?.({ type: 'review_progress', stage: 'scope_resolution', status: 'started' });
    const resolvedScope = await timeStage(timings, 'scope_resolution', 0, async () =>
      scope || await resolveReviewScope().catch(() => 'staged_changes' as ReviewScope));
    onProgress?.({ type: 'review_progress', stage: 'scope_resolution', status: 'done' });

    const editedCode = await timeStage(timings, 'collect_last_edited', 0, () =>
      collectLastEditedCode(resolvedScope, selectedCommitSha));
    if (!editedCode) {
      throw new ValidateReviewError('No git repository or workspace found.');
    }
    if (!editedCode.diff && editedCode.changedFiles.length === 0) {
      throw new ValidateReviewError('No code changes found to review.');
    }

    const sizeClass = classifyPrSize(editedCode.diff, editedCode.changedFiles.length);
    // Mode is caller-confirmed (controller modal). Never silently downgrade Full→Triage.
    const actualMode = mode;
    const modeConfig = MODE_CONFIGS[actualMode];
    if (sizeClass.classification === 'huge' || sizeClass.classification === 'large') {
      warnings.push({
        type: 'size_advisory',
        reason: `PR is ${sizeClass.classification} (${sizeClass.fileCount} files, ${sizeClass.totalLinesChanged} lines) — running ${actualMode}`,
      });
    }

    const ranked = rankFilesByRisk(editedCode.changedFiles.map(f => f.path));
    const filePlan = selectFilesForMode(ranked, modeConfig);
    warnings.push(...filePlan.warnings);

    // Cap context collection to files we will actually review
    const focusPaths = new Set([
      ...filePlan.deepReviewed,
      ...filePlan.skippedButSummarized.slice(0, 30),
    ]);
    const focusChangedFiles = editedCode.changedFiles.filter(f =>
      focusPaths.size === 0 || focusPaths.has(f.path) || actualMode === 'triage');

    onProgress?.({ type: 'review_progress', stage: 'collect_context', status: 'started' });
    const folder = vscode.workspace.workspaceFolders?.[0];
    let hop1: Hop1Result | undefined;
    const workspaceIndex = folder
      ? getSemanticWorkspaceIndex(this.context, folder)
      : undefined;
    if (workspaceIndex) {
      await workspaceIndex.ensureFresh().catch(() => undefined);
      hop1 = workspaceIndex.queryHop1(
        (actualMode === 'full' ? editedCode.changedFiles : (focusChangedFiles.length ? focusChangedFiles : editedCode.changedFiles.slice(0, modeConfig.maxFilesQuickReview)))
          .map(f => f.path),
      );
      const lspHits = folder
        ? await collectLspImporters(folder, hop1).catch(() => [])
        : [];
      if (lspHits.length) {
        hop1 = { ...hop1, importers: mergeImporters(hop1.importers, lspHits) };
      }
    }
    // Team-shared suppressions from .tyne/learnings.md, unioned with the
    // per-user dismissed-title list below. A cheap single file read; never
    // worth blocking or failing a review over.
    const sharedLearnings: Learning[] = folder
      ? await this._readSharedLearnings(folder).catch(() => [])
      : [];
    const codebaseContext = await timeStage(
      timings,
      'collect_context',
      editedCode.changedFiles.length,
      () => collectSafeCodebaseContext({
        changedFiles: actualMode === 'full' ? editedCode.changedFiles : (focusChangedFiles.length ? focusChangedFiles : editedCode.changedFiles.slice(0, modeConfig.maxFilesQuickReview)),
        pmTask,
        maxRelevantFiles: actualMode === 'triage' ? Math.min(4, policy.maxRelevantFiles) : policy.maxRelevantFiles,
        hop1,
        diff: editedCode.diff,
      }),
    );
    onProgress?.({ type: 'review_progress', stage: 'collect_context', status: 'done' });
    if (!codebaseContext) {
      throw new ValidateReviewError('Could not gather codebase context.');
    }

    const truncatedDiff = truncateDiff(editedCode.diff, policy.maxDiffChars);
    const truncatedContext = truncateContext(codebaseContext, policy.maxRelevantFiles);
    // Diff-only preference: drop full contents for files not in deep/summarized set when large
    if (sizeClass.classification === 'large' || sizeClass.classification === 'huge') {
      const keep = new Set([...filePlan.deepReviewed, ...filePlan.skippedButSummarized.slice(0, 20)]);
      truncatedContext.changedFileContents = (truncatedContext.changedFileContents || [])
        .filter(c => keep.has(c.path) || (c.content || '').length < 15_000)
        .map(c => keep.has(c.path) || (c.content || '').length < 8_000
          ? c
          : { ...c, content: (c.content || '').slice(0, 8_000) + '\n/* truncated for large PR */' });
    }
    const truncatedEditedCode: LastEditedCodeContext = { ...editedCode, diff: truncatedDiff };

    if (hop1) {
      const fpIndex = workspaceIndex?.toFingerprintIndex(editedCode.changedFiles.map(f => f.path));
      const similar = fpIndex
        ? similarFromFingerprints(
          fpIndex,
          (truncatedContext.changedFileContents || []).map(c => ({ path: c.path, content: c.content })),
        )
        : [];
      truncatedContext.codegraphNeighborhood = packCodegraphNeighborhood({
        importers: hop1.importers,
        importees: hop1.importees,
        similar,
        changed: hop1.changedExports,
      });
    }
    const neighborhoodFiles = neighborhoodFileList(truncatedContext.codegraphNeighborhood);

    const skipTsc = sizeClass.classification === 'large' || sizeClass.classification === 'huge'
      || editedCode.changedFiles.length > 20;
    const staticAnalysis = await timeStage(
      timings,
      'static_analysis',
      editedCode.changedFiles.length,
      () => collectStaticAnalysis(editedCode.changedFiles.map(f => f.path), { skipTsc }),
    );

    let changedFilesMap: Record<string, string> = Object.fromEntries(
      (truncatedContext.changedFileContents || [])
        .filter(c => c.path && c.content)
        .map(c => [c.path, c.content]),
    );
    // Cap parallel local review map to mode limits
    const mapKeys = Object.keys(changedFilesMap);
    if (mapKeys.length > modeConfig.maxFilesQuickReview) {
      const keep = new Set(filePlan.deepReviewed.concat(filePlan.skippedButSummarized).slice(0, modeConfig.maxFilesQuickReview));
      changedFilesMap = Object.fromEntries(Object.entries(changedFilesMap).filter(([k]) => keep.has(k)));
    }

    onProgress?.({ type: 'review_progress', stage: 'local_quality_engine', status: 'started' });
    const priorFileCache = this._loadFileReviewCache();
    const { results: fileReviewResults, cache: fileReviewCache } = await timeStage(
      timings,
      'parallel_file_review',
      Object.keys(changedFilesMap).length,
      () => reviewFilesInParallel(changedFilesMap, buildFileReviewConfig(truncatedDiff, priorFileCache)),
    );
    this._saveFileReviewCache(fileReviewCache);
    const parallelVibeFindings = mergeFileReviewFindings(fileReviewResults);

    let qualityContext = await timeStage(
      timings,
      'local_quality_engine',
      editedCode.changedFiles.length,
      async () => {
        if (!modeConfig.runLocalQualityEngine) {
          return {
            findings: parallelVibeFindings,
            metrics: { debtMinutes: 0 } as any,
            scorecard: { correctness: 80, maintainability: 80, vibe: 80, architecture: 80, overall: 80 },
            qualityScore: 80,
            vibeCodeRisk: 'low' as const,
            sectionScores: [],
            egressSummary: {},
          };
        }
        const recurringVibeTitles = await getRecurringVibeTitles(this.context).catch(() => []);
        // Repo-wide fingerprint index for semantic duplication. Budgeted and
        // cached; a failure or a partial build just narrows the corpus the
        // detector can match against, so it never blocks the review.
        const semanticIndex = folder
          ? await buildSemanticIndex(this.context, folder, editedCode.changedFiles).catch(() => undefined)
          : undefined;
        return runLocalQualityEngine({
          diff: truncatedDiff,
          changedFiles: editedCode.changedFiles,
          fileContents: truncatedContext.changedFileContents,
          nearbyContents: truncatedContext.nearbyFiles,
          workspaceRoot: folder?.uri.fsPath,
          recurringVibeTitles,
          parallelVibeFindings,
          semanticIndex,
        });
      },
    );
    onProgress?.({
      type: 'review_partial_result',
      stage: 'local_quality_engine',
      findings: qualityContext.findings?.slice?.(0, 20) || qualityFindingsToReviewFindings(qualityContext.findings || []).slice(0, 20),
    });
    onProgress?.({ type: 'review_progress', stage: 'local_quality_engine', status: 'done' });

    if (remainingMs() < 8000) {
      warnings.push({ type: 'llm_review_incomplete', reason: 'global_budget_exceeded_before_edge' });
      return attachTaskMetadata(await this._finalizeLocalOnlyResult({
        editedCode,
        qualityContext,
        timings,
        warnings,
        actualMode,
        requestedMode: mode,
        sizeClass,
        staticAnalysis,
        neighborhoodFiles,
        sharedLearnings,
      }), getState(this.context), pmTask);
    }

    const secretScan = await detectSecrets(truncatedDiff, changedFilesMap);
    const injectionScan = await detectInjectionVulnerabilities(changedFilesMap);
    const heuristicFindings = detectStaticSecurityHeuristics(truncatedDiff);
    const knownFiles = new Set<string>([
      ...Object.keys(changedFilesMap),
      ...(truncatedContext.changedFileContents || []).map(c => c.path),
      ...(truncatedContext.nearbyFiles || []).map(f => f.path),
    ]);
    const aiSlop = await scanForAiSlop(changedFilesMap, knownFiles);
    let depScan: DependencyVulnerabilityResult = { added_packages: {}, vulnerabilities: [], verdict: 'pass' };
    const manifestChanged = editedCode.changedFiles.some(f => /package(-lock)?\.json$/i.test(f.path));
    if (manifestChanged && folder) {
      depScan = await loadDependencyScan(folder.uri.fsPath);
    }

    const guardrails = folder
      ? await loadCustomGuardrails(folder.uri.fsPath, this.context, normalizedTier)
      : undefined;
    const automationSettings = getAutomationSettings(this.context);
    const privacy = resolvePrivacySettings(automationSettings);
    const privacyMode = effectivePrivacyMode(privacy.privacyMode, privacy.dataResidency);
    const complianceChecksEnabled = modeConfig.runComplianceEngine
      && normalizedTier === 'max'
      && automationSettings.complianceChecksEnabled === true;
    const complianceFrameworks = complianceChecksEnabled
      ? automationSettings.complianceFrameworks
      : [];

    const byokService = getByokKeyService(this.context);
    const selectedProvider = await byokService.getSelectedProvider();
    const byokKey = selectedProvider ? await byokService.getApiKey(selectedProvider) : undefined;

    const acValidation = pmTask
      ? await validateAcceptanceCriteria(
        pmTask.description || pmTask.title || '',
        pmTask.acceptanceCriteria || [],
        truncatedDiff,
        changedFilesMap,
        byokKey && selectedProvider
          ? { provider: selectedProvider, apiKey: byokKey }
          : undefined,
      )
      : undefined;

    if (acValidation?.criteria?.length) {
      onProgress?.({
        type: 'proof_strike_progress',
        items: acValidation.criteria.map((c) => ({
          text: c.text,
          status: c.status,
        })),
      });
    }

    const request: TyneValidateReviewRequest = {
      editedCode: truncatedEditedCode,
      codebaseContext: truncatedContext,
      staticAnalysis: staticAnalysis.length ? staticAnalysis : undefined,
      qualityReview: {
        qualityScore: qualityContext.qualityScore,
        vibeCodeRisk: qualityContext.vibeCodeRisk,
        scorecard: qualityContext.scorecard,
        metrics: qualityContext.metrics as unknown as Record<string, number>,
        findings: qualityFindingsToReviewFindings(qualityContext.findings),
        sectionScores: qualityContext.sectionScores,
        egressSummary: qualityContext.egressSummary as unknown as Record<string, unknown>,
        debtMinutes: qualityContext.metrics.debtMinutes,
      },
      pmTask,
      mode: actualMode,
      guardrails,
      // Prevention beats filtering: telling the model what the team already
      // accepted stops it generating those findings, instead of us dropping
      // them after the tokens are spent. Titles only — notes and scopes are
      // local context the model does not need.
      teamLearnings: sharedLearnings.slice(0, 40).map(l => ({ title: l.title })),
      complianceChecksEnabled,
      complianceFrameworks,
      repository: getRepositoryIdentity(),
      thread: buildThreadMetadata(getState(this.context), pmTask),
    };

    let clientAiReview: Record<string, unknown> | undefined;
    let llmExecutionPath: 'managed' | 'direct_byok' | 'local' =
      privacyMode === 'local_compliance' ? 'local' : 'managed';
    let byokModel: string | undefined;
    let byokProviderName: string | undefined;
    // Core's 5 managed validations must use Tyne Gemini (Pro-parity pipeline),
    // not Direct BYOK Claude/OpenAI — otherwise PM review quality diverges from Pro.
    if (
      normalizedTier !== 'free'
      && byokKey
      && selectedProvider
      && privacyMode !== 'local_compliance'
      && actualMode !== 'triage'
    ) {
      const diffForLlm = privacyMode === 'privacy_enhanced'
        ? redactSensitiveText(truncatedDiff).text
        : truncatedDiff;
      const direct = await runDirectByokReview({
        provider: selectedProvider,
        apiKey: byokKey,
        diff: diffForLlm.slice(0, actualMode === 'quick' ? 24_000 : 48_000),
        changedFiles: editedCode.changedFiles.filter(f => filePlan.deepReviewed.includes(f.path) || filePlan.deepReviewed.length === 0).slice(0, modeConfig.maxFilesDeepReview || 15),
        pmTask: pmTask
          ? {
            source: pmTask.source,
            issueIdentifier: pmTask.issueIdentifier,
            title: pmTask.title,
            description: pmTask.description,
            goal: pmTask.goal,
            acceptanceCriteria: pmTask.acceptanceCriteria,
            subtasks: pmTask.subtasks,
            decisions: pmTask.decisions,
            constraints: pmTask.constraints,
            blockers: pmTask.blockers,
            openQuestions: pmTask.openQuestions,
            developerTaskPlan: pmTask.developerTaskPlan
              ? { implementationTasks: pmTask.developerTaskPlan.implementationTasks }
              : undefined,
          }
          : undefined,
      });
      clientAiReview = direct.review;
      llmExecutionPath = 'direct_byok';
      byokModel = direct.model;
      byokProviderName = direct.provider;
    } else if (actualMode === 'triage') {
      warnings.push({ type: 'llm_review_incomplete', reason: 'triage_mode_local_only_plus_edge_cache' });
    }

    const sanitized = sanitizeValidateReviewPayload(request as unknown as Record<string, any>, {
      privacyMode,
      dataResidency: privacy.dataResidency,
      evidencePersistenceDisabled: privacy.evidencePersistenceDisabled,
      clientAiReview,
      llmExecutionPath,
      byokModel,
      byokProviderName,
    });

    onProgress?.({
      type: 'review_progress',
      stage: 'edge_function_call',
      status: 'started',
      filesRemaining: filePlan.deepReviewed.length,
    });
    // Edge/gateway body limits (~6MB). Trim before send so large PRs fail soft, not as a opaque network error.
    const MAX_EDGE_PAYLOAD_CHARS = 4_500_000;
    let edgeRequest = sanitized.request as TyneValidateReviewRequest;
    let payloadSize = JSON.stringify(edgeRequest).length;
    if (payloadSize > MAX_EDGE_PAYLOAD_CHARS) {
      const ctx = edgeRequest.codebaseContext as { changedFileContents?: Array<{ path: string; content?: string }>; nearbyFiles?: unknown[] } | undefined;
      if (ctx) {
        ctx.nearbyFiles = [];
        ctx.changedFileContents = (ctx.changedFileContents || [])
          .slice(0, 12)
          .map(c => ({
            ...c,
            content: String(c.content || '').slice(0, 4_000),
          }));
      }
      if (edgeRequest.editedCode?.diff) {
        edgeRequest = {
          ...edgeRequest,
          editedCode: {
            ...edgeRequest.editedCode,
            diff: String(edgeRequest.editedCode.diff).slice(0, 80_000),
          },
        };
      }
      payloadSize = JSON.stringify(edgeRequest).length;
      warnings.push({
        type: 'pipeline_error',
        message: `Review payload was too large (${Math.round(payloadSize / 1024)}KB after trim); reviewing a reduced context set.`,
      });
    }
    let result: TyneValidateReviewResult;
    try {
      result = await timeStage(timings, 'edge_function_call', payloadSize, () =>
        this._callEdgeFunction(
          edgeRequest,
          privacy.dataResidency,
        ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Quota / auth rejections must surface — never silently fall back to unmetered local review.
      if (err instanceof ValidateReviewError) {
        const lower = message.toLowerCase();
        if (
          lower.includes('limit reached')
          || lower.includes('upgrade to')
          || lower.includes('failed to check usage')
          || lower.includes('authentication')
        ) {
          throw err;
        }
      }
      warnings.push({ type: 'pipeline_error', message });
      result = await this._finalizeLocalOnlyResult({
        editedCode,
        qualityContext,
        timings,
        warnings,
        actualMode,
        requestedMode: mode,
        sizeClass,
        staticAnalysis,
        llmFailureReason: message,
        neighborhoodFiles,
        sharedLearnings,
      });
      console.table(timings);
      return attachTaskMetadata(result, getState(this.context), pmTask);
    }
    onProgress?.({ type: 'review_progress', stage: 'edge_function_call', status: 'done' });

    result.languageBreakdown = computeLanguageBreakdownFromChangedFiles(editedCode.changedFiles);
    result.contributionBreakdown = await computeContributionBreakdown(editedCode);
    result.qualityScore = result.qualityScore ?? qualityContext.qualityScore;
    result.qualityScorecard = result.qualityScorecard ?? qualityContext.scorecard;
    result.qualityMetrics = result.qualityMetrics ?? (qualityContext.metrics as unknown as Record<string, number>);
    result.debtMinutes = result.debtMinutes ?? qualityContext.metrics.debtMinutes;
    result.vibeCodeRisk = result.vibeCodeRisk || qualityContext.vibeCodeRisk;
    if (aiSlop.slop_score > 50) {
      result.vibeCodeRisk = 'high';
    } else if (aiSlop.slop_score > 25 && result.vibeCodeRisk === 'low') {
      result.vibeCodeRisk = 'medium';
    }
    result.privacyInfo = result.privacyInfo || {
      reviewMode: sanitized.privacy.privacyMode,
      codeProcessing: sanitized.privacy.codeProcessing,
      evidenceStorage: sanitized.privacy.evidenceStorage,
      dataSent: sanitized.privacy.dataSent,
      dataResidency: sanitized.privacy.dataResidency,
      evidenceRedacted: sanitized.privacy.evidenceRedacted,
    };
    if (sanitized.privacy.llmExecutionPath) {
      (result.privacyInfo as any).llmExecutionPath = sanitized.privacy.llmExecutionPath;
    }

    const localSecretFindings = secretsToReviewFindings(secretScan);
    const localInjectionFindings = injectionToReviewFindings(injectionScan);
    const localDepFindings = dependencyVulnsToReviewFindings(depScan);
    const localAcFindings = acValidation ? acValidationToReviewFindings(acValidation) : [];
    const localHeuristicSecurity = heuristicFindings.filter(f => f.category === 'security');
    const localHeuristicOther = heuristicFindings.filter(f => f.category !== 'security');
    const localSecurityFindings = [
      ...localSecretFindings,
      ...localInjectionFindings,
      ...localDepFindings,
      ...localHeuristicSecurity,
    ];
    if (localHeuristicOther.length) {
      result.findings = [
        ...localHeuristicOther.map(f => ({
          id: f.id,
          title: f.title,
          severity: f.severity,
          category: f.category,
          file: f.file,
          line: f.line,
          explanation: f.explanation,
          confidence: f.confidence,
          blocking: f.blocking,
          detectedBy: f.detectedBy,
        })),
        ...(result.findings || []),
      ];
    }
    if (localAcFindings.length) {
      result.findings = [
        ...localAcFindings.map(f => ({
          id: f.id,
          title: f.title,
          severity: f.severity,
          category: f.category,
          file: f.file,
          line: f.line,
          explanation: f.explanation,
          suggestedFix: f.suggestedFix,
          confidence: f.confidence,
          blocking: f.blocking,
          detectedBy: 'ac_validator',
        })),
        ...(result.findings || []),
      ];
      if (acValidation?.verdict === 'partial_ac_met' && result.status === 'passed') {
        result.status = 'needs_work';
      }
    }
    if (localSecurityFindings.length) {
      result.findings = [...localSecurityFindings, ...(result.findings || [])];
      result.securityFindings = [
        ...(result.securityFindings || []),
        ...localSecurityFindings.map(f => {
          const inj = localInjectionFindings.find(x => x.id === f.id);
          const heuristic = localHeuristicSecurity.find(h => h.id === f.id);
          const cat = f.detectedBy === 'secret_scanner'
            ? 'secrets' as const
            : f.detectedBy === 'dependency_scanner'
              ? 'dependency' as const
              : heuristic
                ? (/xss|innerhtml/i.test(heuristic.title) ? 'xss' as const : 'configuration' as const)
                : inj?.title.startsWith('SQL') ? 'sql_injection' as const
                  : inj?.title.startsWith('COMMAND') ? 'command_injection' as const
                    : 'sql_injection' as const;
          return {
            id: f.id,
            ruleId: f.detectedBy === 'secret_scanner' ? 'SEC_SECRET_HARDCODED'
              : f.detectedBy === 'dependency_scanner' ? 'SEC_DEPENDENCY_CVE'
                : heuristic ? `SEC_${String(heuristic.id).toUpperCase()}`
                  : `SEC_${cat.toUpperCase()}`,
            file: f.file,
            line: f.line,
            severity: f.severity,
            confidence: f.confidence,
            category: cat,
            title: f.title,
            evidence: f.explanation,
            impact: f.detectedBy === 'secret_scanner'
              ? 'Hardcoded credentials can leak via git history and logs.'
              : f.detectedBy === 'dependency_scanner'
                ? 'Known CVE in a newly added or updated dependency.'
                : heuristic
                  ? 'Weak crypto or XSS sinks can lead to account takeover or data theft.'
                  : 'Untrusted input may alter queries or execute arbitrary commands.',
            remediation: ('suggestedFix' in f && f.suggestedFix) ? f.suggestedFix : f.explanation,
            detectedBy: f.detectedBy,
            blocking: f.blocking,
          };
        }),
      ];
    }
    if (
      secretScan.verdict === 'BLOCK'
      || hasBlockingSqlInjection(injectionScan)
      || hasBlockingDependencyCve(depScan)
      || localHeuristicSecurity.some(f => f.blocking)
    ) {
      result.status = 'blocked';
      result.securityStatus = 'blocked';
      result.riskLevel = 'high';
    } else if (
      (secretScan.verdict === 'warn' || injectionScan.length > 0 || depScan.verdict === 'warn')
      && result.status === 'passed'
    ) {
      result.status = 'needs_work';
    }
    (result as TyneValidateReviewResult & {
      secretDetection?: typeof secretScan;
      injectionScan?: typeof injectionScan;
      dependencyScan?: typeof depScan;
      aiSlop?: typeof aiSlop;
    }).secretDetection = secretScan;
    (result as TyneValidateReviewResult & { injectionScan?: typeof injectionScan }).injectionScan = injectionScan;
    (result as TyneValidateReviewResult & { dependencyScan?: typeof depScan }).dependencyScan = depScan;
    (result as TyneValidateReviewResult & { aiSlop?: typeof aiSlop }).aiSlop = aiSlop;
    if (acValidation) {
      (result as TyneValidateReviewResult & { acValidation?: typeof acValidation }).acValidation = acValidation;
    }
    (result as TyneValidateReviewResult & {
      fileReviewStats?: { total: number; cached: number; failed: number };
    }).fileReviewStats = {
      total: fileReviewResults.length,
      cached: fileReviewResults.filter(r => r.cached).length,
      failed: fileReviewResults.filter(r => r.error).length,
    };

    result.actualModeUsed = actualMode;
    result.requestedMode = mode;
    result.prSizeClass = sizeClass.classification;
    result.reviewWarnings = warnings;
    result.stageTimings = timings;
    (result as { pipelineInfo?: Record<string, unknown> }).pipelineInfo = {
      ...(((result as { pipelineInfo?: Record<string, unknown> }).pipelineInfo) || {}),
      mode: actualMode,
      runPevAgents: modeConfig.runPevAgents,
      runLocalQualityEngine: modeConfig.runLocalQualityEngine,
    };

    if (pmTask && result.driftMatrix && modeConfig.runPevAgents && remainingMs() > 15_000) {
      try {
        const scopeDriftExplanation = await explainScopeDrift(
          {
            description: pmTask.description || pmTask.title || '',
            acceptance_criteria: pmTask.acceptanceCriteria || [],
            title: pmTask.title,
            goal: pmTask.goal,
          },
          buildPrAnalysisFromReview({
            driftMatrix: result.driftMatrix,
            diff: truncatedDiff,
            changedFiles: editedCode.changedFiles,
          }),
          byokKey && selectedProvider
            ? { provider: selectedProvider, apiKey: byokKey }
            : undefined,
        );
        (result as TyneValidateReviewResult & {
          scopeDriftExplanation?: typeof scopeDriftExplanation;
        }).scopeDriftExplanation = scopeDriftExplanation;
      } catch {
        // Non-fatal
      }
    } else if (pmTask && modeConfig.runPevAgents === false) {
      warnings.push({ type: 'scope_drift_skipped', reason: `mode_${actualMode}` });
      result.reviewWarnings = warnings;
    } else if (pmTask && remainingMs() <= 15_000) {
      warnings.push({ type: 'scope_drift_skipped', reason: 'insufficient_time_budget' });
      result.reviewWarnings = warnings;
    }

    // Merge local + LLM + PEV findings into one deduplicated list before the UI
    // sees them: overlapping-line duplicates collapse, 3+ hits of the same rule
    // group into relatedLocations, and minor/nit noise is throttled per file.
    const groundingStats = emptyGroundingStats();
    const suppressionStats = { suppressedCount: 0 };
    const suppressionRecords: SuppressionRecord<TyneValidateReviewFinding>[] = [];
    const dismissedTitles = this.getDismissedFindingTitles();
    result.findings = postProcessReviewFindings(result.findings || [], {
      changedFiles: editedCode.changedFiles,
      neighborhoodFiles,
      groundingStats,
      dismissedTitles,
      suppressionStats,
      suppressionRecords,
      matchLearning: sharedLearnings.length
        ? (finding) => matchLearning(finding, sharedLearnings)
        : undefined,
    });
    result.suppressedFindings = await this._buildSuppressedView(suppressionRecords);
    // LLM re-runs often drop soft findings after majors are fixed — keep prior
    // minors that still touch this diff until the user dismisses or fixes them.
    result.findings = await this._carryForwardFromPrior(result.findings, editedCode, dismissedTitles);
    result.overallVerdict = verdictFromFindings(result.findings);
    if (result.overallVerdict === 'block') {
      result.status = 'blocked';
    } else if (result.overallVerdict === 'changes_requested' && result.status === 'passed') {
      result.status = 'needs_work';
    }
    const pipe = (result as { pipelineInfo?: { failedPacks?: number } }).pipelineInfo;
    const fileFailed = (result as { fileReviewStats?: { failed?: number } }).fileReviewStats?.failed;
    const honesty = enforceIncompleteReviewHonesty({
      status: result.status,
      score: result.score,
      actualMode,
      failedPacks: Number(pipe?.failedPacks || fileFailed || 0),
      reviewWarnings: result.reviewWarnings || warnings,
    });
    if (honesty.demoted) {
      result.status = honesty.status as TyneValidateReviewResult['status'];
      if (typeof honesty.score === 'number') { result.score = honesty.score; }
      warnings.push({
        type: 'llm_review_incomplete',
        message: 'Review coverage was incomplete — not marked as passed',
      });
      result.reviewWarnings = warnings;
    }
    result.groundingStats = groundingStats;
    if (suppressionStats.suppressedCount > 0) {
      (result as { pipelineInfo?: Record<string, unknown> }).pipelineInfo = {
        ...(((result as { pipelineInfo?: Record<string, unknown> }).pipelineInfo) || {}),
        suppressedFalsePositives: suppressionStats.suppressedCount,
      };
    }
    if (result.modelInfo) {
      result.modelInfo = { ...result.modelInfo, groundingStats };
    } else {
      result.modelInfo = { groundingStats };
    }
    if (!Array.isArray(result.topConcerns) || !result.topConcerns.length) {
      result.topConcerns = result.findings
        .filter(f => {
          const d = toDisplaySeverity(f.severity, f.category);
          return d === 'critical' || d === 'major';
        })
        .slice(0, 3)
        .map(f => f.title);
    }

    // Rebuild the architecture flow from what the diff proves, keeping only the
    // LLM's narrative. Findings are final here, so effect + fault markers line
    // up with the same ids the rest of the report uses.
    const localFlow = await this._buildLocalArchitectureFlow(editedCode, result.findings, result.architectureFlow);
    if (localFlow) { result.architectureFlow = localFlow; }

    console.table(timings);
    onProgress?.({ type: 'review_progress', stage: 'complete', status: 'done' });
    this._cacheFindingsForCarryForward(result.findings);
    return attachTaskMetadata(compactReviewLimits(result), getState(this.context), pmTask);
  }

  /**
   * Builds the architecture flow locally from the diff: which files changed,
   * how much, the findings on them, and the DB/LLM/external call sites the
   * changed code actually makes. This is authoritative over the LLM's guess —
   * we only borrow its narrative (title/summary). Source is re-read fresh from
   * disk (local, no egress) so effect detection isn't blinded by the 400-line
   * truncation the review payload applies.
   */
  private async _buildLocalArchitectureFlow(
    editedCode: LastEditedCodeContext,
    findings: TyneValidateReviewFinding[],
    narrative?: TyneValidateReviewResult['architectureFlow'],
  ): Promise<TyneValidateReviewResult['architectureFlow'] | undefined> {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) { return undefined; }
      const root = folder.uri.fsPath;

      const changedByFile = new Map<string, Set<number>>();
      for (const row of changedLinesFromDiff(editedCode.diff || '')) {
        if (row.line === undefined) { continue; }
        const key = row.file.replace(/\\/g, '/');
        (changedByFile.get(key) || changedByFile.set(key, new Set()).get(key)!).add(row.line);
      }

      const effects: EffectSite[] = [];
      const decisions: DecisionSite[] = [];
      const fileImports: FileImportHint[] = [];
      const changedContents: Array<{ path: string; content: string }> = [];
      let budget = 400_000;
      const candidates = editedCode.changedFiles.slice(0, 12);
      for (const file of candidates) {
        const rel = file.path.replace(/\\/g, '/');
        // A migration file is evidence by itself and needs no read.
        if (/(^|\/)migrations?\//i.test(rel) || /\.sql$/i.test(rel) || /(^|\/)schema\//i.test(rel)) {
          effects.push(...detectEffects(rel, ''));
          continue;
        }
        if (!/\.[tj]sx?$/i.test(rel)) { continue; }
        if (budget <= 0) { break; }
        let content = '';
        try {
          content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, rel)))).toString('utf8');
        } catch {
          continue; // deleted/renamed away — nothing to read
        }
        budget -= content.length;
        const changed = changedByFile.get(rel);
        effects.push(...detectEffects(rel, content, changed));
        decisions.push(...detectDecisions(rel, content, changed));
        const facts = extractFileFacts(rel, content);
        fileImports.push({ file: rel, imports: facts.imports, changedLines: changed });
        changedContents.push({ path: rel, content });
      }

      // Prefer the persistent import graph; fall back to a capped workspace scan.
      let blastImporters = findBlastRadiusSync({ changedFiles: changedContents, candidates: [] });
      if (folder) {
        const hopImporters = getSemanticWorkspaceIndex(this.context, folder)
          .queryHop1(editedCode.changedFiles.map(f => f.path)).importers;
        if (hopImporters.length) {
          blastImporters = hopImporters;
        } else {
          try {
            const changedSet = new Set(editedCode.changedFiles.map(f => f.path.replace(/\\/g, '/')));
            const uris = await vscode.workspace.findFiles(
              '**/*.{ts,tsx,js,jsx}',
              '{**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.git/**}',
              200,
            );
            const outside: Array<{ path: string; content: string }> = [];
            for (const uri of uris) {
              if (outside.length >= BLAST_RADIUS_CAPS.maxCandidates) { break; }
              const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
              if (!rel || rel.startsWith('..') || changedSet.has(rel) || isBlastSkipPath(rel)) { continue; }
              let content = '';
              try {
                content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
              } catch {
                continue;
              }
              const basenames = changedContents.map(c => {
                const b = c.path.split('/').pop() || '';
                return b.replace(/\.(tsx?|jsx?)$/i, '');
              }).filter(Boolean);
              if (basenames.length && !basenames.some(b => content.includes(b))) { continue; }
              outside.push({ path: rel, content });
            }
            blastImporters = findBlastRadiusSync({ changedFiles: changedContents, candidates: outside });
          } catch {
            // Blast radius is best-effort — never fail the review.
          }
        }
      }

      return buildArchitectureGraph({
        changedFiles: editedCode.changedFiles,
        effects,
        decisions,
        findings,
        fileImports,
        blastImporters,
        narrative: narrative
          ? { title: narrative.title, summary: narrative.summary, whatWentRight: narrative.whatWentRight, whatWentWrong: narrative.whatWentWrong }
          : undefined,
      });
    } catch {
      // Never let graph-building fail a review.
      return undefined;
    }
  }

  private async _finalizeLocalOnlyResult(args: {
    editedCode: LastEditedCodeContext;
    qualityContext: Awaited<ReturnType<typeof runLocalQualityEngine>> | any;
    timings: StageTiming[];
    warnings: ReviewWarning[];
    actualMode: ReviewMode;
    requestedMode: ReviewMode;
    sizeClass: ReturnType<typeof classifyPrSize>;
    staticAnalysis: Awaited<ReturnType<typeof collectStaticAnalysis>>;
    llmFailureReason?: string;
    neighborhoodFiles?: string[];
    sharedLearnings?: Learning[];
  }): Promise<TyneValidateReviewResult> {
    const qc = args.qualityContext;
    const findings = qualityFindingsToReviewFindings(qc.findings || []) as any[];
    const reason = args.llmFailureReason
      || args.warnings.find(w => w.type === 'llm_review_incomplete')?.reason
      || 'LLM stage skipped or timed out';
    const localScore = typeof qc.qualityScore === 'number' ? qc.qualityScore : 70;
    // LLM never ran — damp score so a partial local report cannot look like a full pass.
    const score = Math.min(localScore, 75);
    const result: TyneValidateReviewResult = {
      scope: args.editedCode.scope || 'staged_changes',
      // Incomplete LLM path is never a full pass — UI maps needs_work → "partial".
      status: 'needs_work',
      score,
      riskLevel: 'medium',
      vibeCodeRisk: qc.vibeCodeRisk || 'medium',
      summary: `Partial review from local analysis (${reason}).`,
      completedGoals: [],
      pendingGoals: [],
      findings,
      missingTests: [],
      nextActions: [{ title: 'Re-run review after fixing auth/backend, or use a smaller scope', reason: 'partial_result' }],
      visualDiff: (args.editedCode.changedFiles || []).slice(0, 40).map(f => ({
        file: f.path,
        status: (f.status as any) || 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      })),
      qualityScore: score,
      qualityScorecard: qc.scorecard,
      debtMinutes: qc.metrics?.debtMinutes,
      actualModeUsed: args.actualMode,
      requestedMode: args.requestedMode,
      prSizeClass: args.sizeClass.classification,
      reviewWarnings: args.warnings,
      stageTimings: args.timings,
    };
    const groundingStats = emptyGroundingStats();
    const dismissedTitles = this.getDismissedFindingTitles();
    const suppressionRecords: SuppressionRecord<TyneValidateReviewFinding>[] = [];
    const learnings = args.sharedLearnings || [];
    result.findings = postProcessReviewFindings(result.findings || [], {
      changedFiles: args.editedCode.changedFiles,
      neighborhoodFiles: args.neighborhoodFiles,
      groundingStats,
      dismissedTitles,
      suppressionRecords,
      matchLearning: learnings.length
        ? (finding) => matchLearning(finding, learnings)
        : undefined,
    });
    result.suppressedFindings = await this._buildSuppressedView(suppressionRecords);
    // Same carry-forward as the full edge path — local-only re-runs must not drop
    // unresolved minors just because the LLM stage never ran.
    result.findings = await this._carryForwardFromPrior(result.findings, args.editedCode, dismissedTitles);
    result.overallVerdict = verdictFromFindings(result.findings);
    if (result.overallVerdict === 'block') {
      result.status = 'blocked';
    } else if (result.overallVerdict === 'changes_requested' && result.status === 'passed') {
      result.status = 'needs_work';
    }
    const localHonesty = enforceIncompleteReviewHonesty({
      status: result.status,
      score: result.score,
      actualMode: args.actualMode,
      failedPacks: 0,
      reviewWarnings: [
        ...(args.warnings || []),
        { type: 'llm_review_incomplete', message: 'local-only path' },
      ],
    });
    if (localHonesty.demoted) {
      result.status = localHonesty.status as TyneValidateReviewResult['status'];
      if (typeof localHonesty.score === 'number') { result.score = localHonesty.score; }
    }
    result.groundingStats = groundingStats;
    // The LLM never ran on this path, so there is no architectureFlow at all —
    // build it locally so a partial review still shows the real code map.
    const localFlow = await this._buildLocalArchitectureFlow(args.editedCode, result.findings);
    if (localFlow) { result.architectureFlow = localFlow; }
    console.table(args.timings);
    this._cacheFindingsForCarryForward(result.findings);
    return compactReviewLimits(result);
  }

  /** Prior findings from history (flat or nested `result`) or last local cache. */
  private async _priorFindingsForCarryForward(): Promise<TyneValidateReviewFinding[]> {
    try {
      const prior = (await this.listReports())[0] as (TyneValidateReviewResult & { result?: { findings?: TyneValidateReviewFinding[] } }) | undefined;
      if (prior?.findings?.length) { return prior.findings; }
      const nested = prior?.result?.findings;
      if (Array.isArray(nested) && nested.length) { return nested; }
    } catch {
      // History is best-effort.
    }
    const cached = this.context.workspaceState.get<TyneValidateReviewFinding[]>(LAST_REVIEW_FINDINGS_KEY);
    return Array.isArray(cached) ? cached : [];
  }

  private async _carryForwardFromPrior(
    current: TyneValidateReviewFinding[],
    editedCode: LastEditedCodeContext,
    dismissedTitles?: Set<string>,
  ): Promise<TyneValidateReviewFinding[]> {
    const priorFindings = await this._priorFindingsForCarryForward();
    if (!priorFindings.length) { return current; }
    return carryForwardUnresolvedMinors(current, priorFindings, {
      changedFiles: (editedCode.changedFiles || []).map(f => f.path),
      dismissedTitles: dismissedTitles || this.getDismissedFindingTitles(),
    });
  }

  getDismissedFindingTitles(): Set<string> {
    const raw = this.context.workspaceState.get<string[]>(DISMISSED_FINDING_TITLES_KEY) || [];
    return new Set(raw.map(t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean));
  }

  /** Persist titles marked Ignore / Wrong / Not relevant so re-runs hard-drop them. */
  rememberDismissedFinding(title: string): void {
    const key = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) { return; }
    const next = this.getDismissedFindingTitles();
    next.add(key);
    void this.context.workspaceState.update(DISMISSED_FINDING_TITLES_KEY, [...next].slice(-80));
  }

  private _learningsFileUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, '.tyne', 'learnings.md');
  }

  /** Public accessor so the sidebar can open the file after writing to it. */
  learningsFileUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? this._learningsFileUri(folder) : undefined;
  }

  /** Team-shared suppressions from `.tyne/learnings.md`. Missing file is not an error — an empty set. */
  private async _readSharedLearnings(folder: vscode.WorkspaceFolder): Promise<Learning[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this._learningsFileUri(folder));
      return parseLearningsFile(Buffer.from(bytes).toString('utf8'));
    } catch {
      return [];
    }
  }

  /**
   * Attach git-blame provenance to suppression records.
   *
   * This is the property CodeRabbit's cloud-stored learnings structurally
   * cannot have: because `.tyne/learnings.md` is a file in the repo, every
   * suppression can name who introduced it and when. Reuses the line-history
   * helper already built for prior-commit context.
   */
  /**
   * Turn raw suppression records into the UI-facing view, with git-blame
   * provenance attached. Ordered learning-first so the team-level reasons
   * read before an individual's dismissals.
   */
  private async _buildSuppressedView(
    records: SuppressionRecord<TyneValidateReviewFinding>[],
  ): Promise<TyneValidateReviewResult['suppressedFindings']> {
    if (!records.length) { return undefined; }
    const view = records.map(record => ({
      title: String(record.finding?.title || 'Finding'),
      file: record.finding?.file,
      line: record.finding?.line,
      severity: record.finding?.severity,
      category: record.finding?.category,
      source: record.source,
      learningTitle: record.learningTitle,
      learningNote: record.learningNote,
      learningSource: record.learningSource,
      learningScope: record.learningScope,
      matchKind: record.matchKind,
      score: record.score,
      author: undefined as string | undefined,
      addedOn: undefined as string | undefined,
    }));
    await this._attachLearningProvenance(view).catch(() => undefined);
    return view.sort((a, b) => (a.source === b.source ? 0 : a.source === 'learning' ? -1 : 1));
  }

  private async _attachLearningProvenance(
    records: Array<{ learningSource?: string; author?: string; addedOn?: string }>,
  ): Promise<void> {
    const byLine = new Map<number, Array<{ author?: string; addedOn?: string }>>();
    for (const record of records) {
      const line = Number(String(record.learningSource || '').split(':')[1]);
      if (!Number.isFinite(line) || line < 1) { continue; }
      const bucket = byLine.get(line) || [];
      bucket.push(record);
      byLine.set(line, bucket);
    }
    for (const [line, bucket] of byLine) {
      try {
        const commits = await getLineHistory('.tyne/learnings.md', line, line);
        const commit = commits[0];
        if (!commit) { continue; }
        for (const record of bucket) {
          record.author = commit.author;
          record.addedOn = commit.date;
        }
      } catch { /* provenance is a bonus, never a failure */ }
    }
  }

  /**
   * Add one team-shared learning. Public entry point for the "suppress this
   * for everyone" side of the Ignore flow — separate from
   * `rememberDismissedFinding`, which stays per-user and frictionless.
   * Returns false when the learning already existed (idempotent) or no
   * workspace is open.
   */
  async rememberSharedLearning(title: string, note?: string, scope?: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return false; }
    const uri = this._learningsFileUri(folder);

    let current = '';
    try {
      current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch { /* file doesn't exist yet — appendLearning starts it */ }

    const { content, added } = appendLearning(current, title, note, scope);
    if (!added) { return false; }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.tyne'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return true;
  }

  /**
   * Remove a team learning, so the "Checked but not shown" panel can undo a
   * suppression instead of only reporting it. Returns false when the learning
   * is not in the file (already removed, or hand-edited away).
   */
  async forgetSharedLearning(title: string, scope?: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return false; }
    const uri = this._learningsFileUri(folder);

    let current = '';
    try {
      current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return false;
    }

    const { content, removed } = removeLearning(current, title, scope);
    if (!removed) { return false; }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return true;
  }

  /** Drop a per-user dismissal so the finding is reported again. */
  forgetDismissedFinding(title: string): boolean {
    const key = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key) { return false; }
    const next = this.getDismissedFindingTitles();
    if (!next.delete(key)) { return false; }
    void this.context.workspaceState.update(DISMISSED_FINDING_TITLES_KEY, [...next]);
    return true;
  }

  private _cacheFindingsForCarryForward(findings: TyneValidateReviewFinding[]): void {
    void this.context.workspaceState.update(LAST_REVIEW_FINDINGS_KEY, (findings || []).slice(0, 40));
  }

  private async _callEdgeFunction(
    request: TyneValidateReviewRequest,
    dataResidency: 'us' | 'eu' | 'local_only' | 'enterprise_managed' = 'us',
  ): Promise<TyneValidateReviewResult> {
    const token = await getEffectiveAuthToken(this.context);
    if (!token) {
      throw new ValidateReviewError('Authentication token is required to run a review.');
    }

    const cfg = vscode.workspace.getConfiguration('tyne');
    const functionUrl = resolveValidateReviewFunctionUrl(dataResidency, {
      supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
      supabaseUrlEu: cfg.get<string>('supabaseUrlEu', ''),
      enterpriseEndpoint: cfg.get<string>('enterpriseValidateReviewUrl', ''),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Machine-ID': vscode.env.machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ValidateReviewError(
          'Review timed out after 5 minutes. For large changes, use Quick/Triage mode or review fewer files (last commit / staged only).',
        );
      }
      throw err;
    }
    clearTimeout(timer);

    const data = await response.json() as TyneValidateReviewResponse | TyneValidateReviewError;
    // Save-failed path returns 200 with result + persisted:false (or legacy 500 with result).
    const maybeResult = (data as TyneValidateReviewResponse).result
      || (data as TyneValidateReviewError).result;
    if (!response.ok) {
      if (response.status === 401) {
        throw new ValidateReviewError('Session expired. Sign in again.');
      }
      if (maybeResult && isValidateReviewResult(maybeResult)) {
        const warnings = Array.isArray(maybeResult.reviewWarnings) ? [...maybeResult.reviewWarnings] : [];
        warnings.push({
          type: 'pipeline_error',
          message: (data as TyneValidateReviewError).error || 'Report history could not be saved.',
        });
        return { ...maybeResult, reviewWarnings: warnings };
      }
      const error = (data as TyneValidateReviewError).error || `Review failed (${response.status})`;
      throw new ValidateReviewError(error);
    }

    const result = maybeResult;
    if (!isValidateReviewResult(result)) {
      const serverError = (data as TyneValidateReviewError).error;
      throw new ValidateReviewError(
        serverError
          ? `Invalid review response from server: ${serverError}`
          : 'Invalid review response from server (missing result payload).',
      );
    }

    if ((data as TyneValidateReviewResponse).persisted === false) {
      const warnings = Array.isArray(result.reviewWarnings) ? [...result.reviewWarnings] : [];
      warnings.push({
        type: 'pipeline_error',
        message: (data as TyneValidateReviewError).error || 'Report history could not be saved.',
      });
      return { ...result, reviewWarnings: warnings };
    }

    return result;
  }

  async listReports(): Promise<TyneValidateReviewResult[]> {
    const local = await getAxiomReportVault().listReports(50).catch(() => [] as TyneValidateReviewResult[]);
    let cloud: TyneValidateReviewResult[] = [];
    try {
      const token = await getEffectiveAuthToken(this.context);
      if (token) {
        const cfg = vscode.workspace.getConfiguration('tyne');
        const privacy = resolvePrivacySettings({
          privacyMode: cfg.get('privacyMode'),
          dataResidency: cfg.get('dataResidency'),
        });
        const functionUrl = resolveValidateReviewFunctionUrl(privacy.dataResidency, {
          supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
          supabaseUrlEu: cfg.get<string>('supabaseUrlEu', ''),
          enterpriseEndpoint: cfg.get<string>('enterpriseValidateReviewUrl', ''),
        });
        const response = await fetch(`${functionUrl}?limit=50`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Machine-ID': vscode.env.machineId,
            Accept: 'application/json',
          },
        });
        const data = await response.json().catch(() => null) as TyneValidateReviewHistoryResponse | TyneValidateReviewError | null;
        if (response.ok && data && 'reports' in data) {
          cloud = ((data as TyneValidateReviewHistoryResponse).reports || []).map(normalizeHistoryReport);
        }
      }
    } catch (err) {
      console.warn('Cloud report history unavailable; using local vault:', err);
    }
    return mergeAxiomReports(local, cloud, 50);
  }

  async submitFindingFeedback(input: FindingFeedbackRequest): Promise<void> {
    const token = await getEffectiveAuthToken(this.context);
    if (!token) {
      throw new ValidateReviewError('Authentication token is required to submit feedback.');
    }
    const cfg = vscode.workspace.getConfiguration('tyne');
    const privacy = resolvePrivacySettings({
      privacyMode: cfg.get('privacyMode'),
      dataResidency: cfg.get('dataResidency'),
    });
    const functionUrl = resolveValidateReviewFunctionUrl(privacy.dataResidency, {
      supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
      supabaseUrlEu: cfg.get<string>('supabaseUrlEu', ''),
      enterpriseEndpoint: cfg.get<string>('enterpriseValidateReviewUrl', ''),
    });
    const response = await fetch(`${functionUrl}/feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new ValidateReviewError(`Failed to submit feedback: ${text}`);
    }
  }

  private async _authHeaders(): Promise<{ githubToken: string; supabaseUrl: string; headers: Record<string, string> }> {
    const token = await getEffectiveAuthToken(this.context);
    if (!token) {
      throw new ValidateReviewError('Authentication connection is required.');
    }
    const supabaseUrl = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co').replace(/\/+$/, '');
    return {
      githubToken: token,
      supabaseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Machine-ID': vscode.env.machineId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
  }

  async saveFindingWorkflow(input: {
    reportId: string;
    findingId: string;
    findingTitle?: string;
    framework?: string;
    status: string;
    owner?: string;
    comments?: string;
    resolution?: string;
  }): Promise<void> {
    const { supabaseUrl, headers } = await this._authHeaders();
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review/finding-workflow`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new ValidateReviewError(`Failed to save finding workflow: ${text}`);
    }
  }

  async listCustomPolicies(): Promise<any[]> {
    const { supabaseUrl, headers } = await this._authHeaders();
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review/custom-policies`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new ValidateReviewError(`Failed to load custom policies: ${text}`);
    }
    const data = await response.json() as { policies?: any[] };
    return data.policies || [];
  }

  async createCustomPolicy(input: Record<string, unknown>): Promise<any> {
    const { supabaseUrl, headers } = await this._authHeaders();
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review/custom-policies`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new ValidateReviewError(`Failed to create custom policy: ${text}`);
    }
    const data = await response.json() as { policy?: any };
    return data.policy;
  }

  async deleteCustomPolicy(id: string): Promise<void> {
    const { supabaseUrl, headers } = await this._authHeaders();
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review/custom-policies?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new ValidateReviewError(`Failed to delete custom policy: ${text}`);
    }
  }

  private _loadFileReviewCache(): FileReviewCache {
    return this.context.workspaceState.get<FileReviewCache>(FILE_REVIEW_CACHE_KEY, {}) || {};
  }

  private _saveFileReviewCache(cache: FileReviewCache): void {
    const keys = Object.keys(cache);
    if (keys.length > 80) {
      keys
        .sort((a, b) => String(cache[a].updatedAt || '').localeCompare(String(cache[b].updatedAt || '')))
        .slice(0, keys.length - 80)
        .forEach(k => { delete cache[k]; });
    }
    void this.context.workspaceState.update(FILE_REVIEW_CACHE_KEY, cache);
  }

  private _normalizeTier(tier: string): ReviewTier {
    const t = tier.toLowerCase();
    if (t === 'pro') return 'pro';
    if (t === 'max') return 'max';
    return 'free';
  }
}

/**
 * Refresh the workspace fingerprint index and hand the detector a corpus that
 * excludes the files under review — otherwise changed code would be matched
 * against its own pre-edit fingerprints and every edit would look like a
 * duplicate of itself.
 */
async function buildSemanticIndex(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
  changedFiles: Array<{ path: string }>,
): Promise<FingerprintIndex | undefined> {
  const index = getSemanticWorkspaceIndex(context, folder);
  await index.ensureFresh();
  if (!index.fileCount) return undefined;
  return index.toFingerprintIndex(changedFiles.map(f => f.path));
}

async function loadDependencyScan(workspaceRoot: string): Promise<DependencyVulnerabilityResult> {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { added_packages: {}, vulnerabilities: [], verdict: 'pass', error: 'no package.json' };
  }
  const packageJson = fs.readFileSync(pkgPath, 'utf8');
  const lockPath = path.join(workspaceRoot, 'package-lock.json');
  const packageLockJson = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
  let baselinePackageJson: string | undefined;
  try {
    const git = getGit();
    if (git) baselinePackageJson = await git.show(['HEAD:package.json']);
  } catch { /* no baseline */ }
  return checkDependencyVulnerabilities(packageJson, packageLockJson, baselinePackageJson);
}

function getRepositoryIdentity(): { repositoryId: string; repositoryName?: string } {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = folder?.uri.fsPath || 'unknown-workspace';
  return {
    repositoryId: createHash('sha256').update(workspacePath).digest('hex'),
    repositoryName: folder?.name,
  };
}

function buildThreadMetadata(
  state: ReturnType<typeof getState>,
  pmTask?: ReviewPmTaskContext,
): NonNullable<TyneValidateReviewRequest['thread']> {
  const source = pmTask?.source || (state.taskSource === 'jira' || state.taskSource === 'linear' ? state.taskSource : undefined);
  return {
    threadId: state.taskId || undefined,
    issueSource: source || (state.taskId ? 'manual' : undefined),
    issueId: state.taskId || undefined,
    issueIdentifier: normalizeIssueIdentifier(
      pmTask?.issueIdentifier || state.pmTaskContext?.issueIdentifier || state.pmTaskContext?.issueKey || state.taskId,
    ) || undefined,
    issueTitle: pmTask?.title || state.taskTitle || state.goal || undefined,
  };
}

/** Strip tool prefixes so UI grouping matches Linear/Jira keys. */
function normalizeIssueIdentifier(raw: unknown): string {
  return String(raw || '').replace(/^(linear|jira|asana|notion|monday):/i, '').trim();
}

/** Stamp active-thread fields so Validate page groups the run under that task. */
function attachTaskMetadata(
  result: TyneValidateReviewResult,
  state: ReturnType<typeof getState>,
  pmTask?: ReviewPmTaskContext,
): TyneValidateReviewResult {
  const thread = buildThreadMetadata(state, pmTask);
  if (!result.threadId && thread.threadId) { result.threadId = thread.threadId; }
  if (!result.issueId && thread.issueId) { result.issueId = thread.issueId; }
  if (!result.issueSource && thread.issueSource) { result.issueSource = thread.issueSource; }
  if (!result.issueIdentifier && thread.issueIdentifier) { result.issueIdentifier = thread.issueIdentifier; }
  if (!result.issueTitle && thread.issueTitle) { result.issueTitle = thread.issueTitle; }
  if (!result.createdAt) { result.createdAt = new Date().toISOString(); }
  if (!result.branchName && state.branchName) { result.branchName = state.branchName; }
  return result;
}

/** Map slim/raw edge history rows (snake_case or nested `result`) into UI shape. */
function normalizeHistoryReport(row: TyneValidateReviewResult | Record<string, unknown>): TyneValidateReviewResult {
  const raw = (row || {}) as Record<string, unknown>;
  const nested = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
    ? raw.result as Record<string, unknown>
    : null;
  const pick = <T>(...vals: unknown[]): T | undefined => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== '') { return v as T; }
    }
    return undefined;
  };
  const issueIdentifier = normalizeIssueIdentifier(
    pick(raw.issueIdentifier, raw.issue_identifier, nested?.issueIdentifier, nested?.issue_identifier),
  );
  return {
    ...((nested || {}) as unknown as TyneValidateReviewResult),
    ...(raw as unknown as TyneValidateReviewResult),
    id: pick<string>(raw.id, nested?.id),
    threadId: pick<string>(raw.threadId, raw.thread_id, nested?.threadId),
    issueId: pick<string>(raw.issueId, raw.issue_id, nested?.issueId),
    issueSource: pick<'jira' | 'linear' | 'manual'>(raw.issueSource, raw.issue_source, nested?.issueSource),
    issueIdentifier: issueIdentifier || undefined,
    issueTitle: pick<string>(raw.issueTitle, raw.issue_title, nested?.issueTitle),
    branchName: pick<string>(raw.branchName, raw.branch_name, nested?.branchName),
    scope: (pick(raw.scope, raw.review_scope, nested?.scope) || 'staged_changes') as TyneValidateReviewResult['scope'],
    status: (pick(raw.status, nested?.status) || 'needs_work') as TyneValidateReviewResult['status'],
    score: Number(pick(raw.score, nested?.score) ?? 0),
    riskLevel: (pick(raw.riskLevel, raw.risk_level, nested?.riskLevel) || 'medium') as TyneValidateReviewResult['riskLevel'],
    vibeCodeRisk: (pick(raw.vibeCodeRisk, raw.vibe_code_risk, nested?.vibeCodeRisk) || 'medium') as TyneValidateReviewResult['vibeCodeRisk'],
    summary: String(pick(raw.summary, nested?.summary) || ''),
    findings: (pick(raw.findings, nested?.findings) as TyneValidateReviewResult['findings']) || [],
    completedGoals: (pick(raw.completedGoals, raw.completed_goals, nested?.completedGoals) as TyneValidateReviewResult['completedGoals']) || [],
    pendingGoals: (pick(raw.pendingGoals, raw.pending_goals, nested?.pendingGoals) as TyneValidateReviewResult['pendingGoals']) || [],
    missingTests: (pick(raw.missingTests, raw.missing_tests, nested?.missingTests) as TyneValidateReviewResult['missingTests']) || [],
    nextActions: (pick(raw.nextActions, raw.next_actions, nested?.nextActions) as TyneValidateReviewResult['nextActions']) || [],
    visualDiff: (pick(raw.visualDiff, raw.visual_diff, nested?.visualDiff) as TyneValidateReviewResult['visualDiff']) || [],
    createdAt: pick<string>(raw.createdAt, raw.created_at, nested?.createdAt),
  };
}
