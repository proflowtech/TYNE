import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { getGit } from './gitManager';
import { getByokKeyService } from './byokKeyService';
import { getState } from './stateManager';
import { getAutomationSettings } from './automationMetadataService';
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
import {
  TyneValidateReviewResult,
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
} from './validateReviewTypes';

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

  async runReview(tier: string, pmTask?: ReviewPmTaskContext, scope?: ReviewScope, selectedCommitSha?: string): Promise<TyneValidateReviewResult> {
    const normalizedTier = this._normalizeTier(tier);
    const policy = getTierPolicy(normalizedTier);

    // 1. Resolve review scope (use provided scope or auto-resolve: staged > unstaged > last commit)
    const resolvedScope = scope || await resolveReviewScope().catch(() => 'staged_changes' as ReviewScope);

    // 2. Collect last edited code
    const editedCode = await collectLastEditedCode(resolvedScope, selectedCommitSha);
    if (!editedCode) {
      throw new ValidateReviewError('No git repository or workspace found.');
    }
    if (!editedCode.diff && editedCode.changedFiles.length === 0) {
      throw new ValidateReviewError('No code changes found to review.');
    }

    // 3. Collect safe codebase context (limited, never full repo)
    const codebaseContext = await collectSafeCodebaseContext({
      changedFiles: editedCode.changedFiles,
      pmTask,
      maxRelevantFiles: policy.maxRelevantFiles,
    });
    if (!codebaseContext) {
      throw new ValidateReviewError('Could not gather codebase context.');
    }

    // 4. Apply tier guardrails (truncate diff + context)
    const truncatedDiff = truncateDiff(editedCode.diff, policy.maxDiffChars);
    const truncatedContext = truncateContext(codebaseContext, policy.maxRelevantFiles);
    const truncatedEditedCode: LastEditedCodeContext = { ...editedCode, diff: truncatedDiff };

    // 4b. Local static analysis on changed files (best-effort; never blocks review)
    const staticAnalysis = await collectStaticAnalysis(editedCode.changedFiles.map(f => f.path));

    // 5. Load custom guardrails (Max only)
    const folder = vscode.workspace.workspaceFolders?.[0];
    const guardrails = folder
      ? await loadCustomGuardrails(folder.uri.fsPath, this.context, normalizedTier)
      : undefined;
    const automationSettings = getAutomationSettings(this.context);
    const privacy = resolvePrivacySettings(automationSettings);
    const privacyMode = effectivePrivacyMode(privacy.privacyMode, privacy.dataResidency);
    const complianceChecksEnabled = normalizedTier === 'max'
      && automationSettings.complianceChecksEnabled === true;
    const complianceFrameworks = complianceChecksEnabled
      ? automationSettings.complianceFrameworks
      : [];

    // 6. BYOK stays on-device (Phase 3 direct) — never put key on the egress request.
    const byokService = getByokKeyService(this.context);
    const selectedProvider = await byokService.getSelectedProvider();
    const byokKey = selectedProvider ? await byokService.getApiKey(selectedProvider) : undefined;

    // 7. Build request (no BYOK secrets)
    const request: TyneValidateReviewRequest = {
      editedCode: truncatedEditedCode,
      codebaseContext: truncatedContext,
      staticAnalysis: staticAnalysis.length ? staticAnalysis : undefined,
      pmTask,
      guardrails,
      complianceChecksEnabled,
      complianceFrameworks,
      repository: getRepositoryIdentity(),
      thread: buildThreadMetadata(getState(this.context), pmTask),
    };

    // 7a. Direct BYOK: VS Code → provider. Backend receives result metadata only for the LLM pass.
    let clientAiReview: Record<string, unknown> | undefined;
    let llmExecutionPath: 'managed' | 'direct_byok' | 'local' =
      privacyMode === 'local_compliance' ? 'local' : 'managed';
    let byokModel: string | undefined;
    let byokProviderName: string | undefined;
    if (byokKey && selectedProvider && privacyMode !== 'local_compliance') {
      const diffForLlm = privacyMode === 'privacy_enhanced'
        ? redactSensitiveText(truncatedDiff).text
        : truncatedDiff;
      const direct = await runDirectByokReview({
        provider: selectedProvider,
        apiKey: byokKey,
        diff: diffForLlm,
        changedFiles: editedCode.changedFiles,
        pmTitle: pmTask?.title,
      });
      clientAiReview = direct.review;
      llmExecutionPath = 'direct_byok';
      byokModel = direct.model;
      byokProviderName = direct.provider;
    }

    // 7b. Privacy gate — MUST run before any network / logging of payload contents.
    const sanitized = sanitizeValidateReviewPayload(request as unknown as Record<string, any>, {
      privacyMode,
      dataResidency: privacy.dataResidency,
      evidencePersistenceDisabled: privacy.evidencePersistenceDisabled,
      clientAiReview,
      llmExecutionPath,
      byokModel,
      byokProviderName,
    });

    // 8. Call edge (residency-routed) with sanitized payload only
    const result = await this._callEdgeFunction(
      sanitized.request as TyneValidateReviewRequest,
      privacy.dataResidency,
    );
    result.languageBreakdown = computeLanguageBreakdownFromChangedFiles(editedCode.changedFiles);
    result.contributionBreakdown = await computeContributionBreakdown(editedCode);
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
    return compactReviewLimits(result);
  }

  private async _callEdgeFunction(
    request: TyneValidateReviewRequest,
    dataResidency: 'us' | 'eu' | 'local_only' | 'enterprise_managed' = 'us',
  ): Promise<TyneValidateReviewResult> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new ValidateReviewError('GitHub connection is required to run a review.');
    }

    const cfg = vscode.workspace.getConfiguration('tyne');
    const functionUrl = resolveValidateReviewFunctionUrl(dataResidency, {
      supabaseUrl: cfg.get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co'),
      supabaseUrlEu: cfg.get<string>('supabaseUrlEu', ''),
      enterpriseEndpoint: cfg.get<string>('enterpriseValidateReviewUrl', ''),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    try {
      response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          'X-Machine-ID': vscode.env.machineId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ValidateReviewError('Review timed out after 120 seconds. Try with a smaller diff.');
      }
      throw err;
    }
    clearTimeout(timer);

    const data = await response.json() as TyneValidateReviewResponse | TyneValidateReviewError;
    if (!response.ok) {
      const error = (data as TyneValidateReviewError).error || `Review failed (${response.status})`;
      throw new ValidateReviewError(error);
    }

    const result = (data as TyneValidateReviewResponse).result;
    if (!isValidateReviewResult(result)) {
      throw new ValidateReviewError('Invalid review response from server.');
    }

    return result;
  }

  async listReports(): Promise<TyneValidateReviewResult[]> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new ValidateReviewError('GitHub connection is required to load report history.');
    }
    const supabaseUrl = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co').replace(/\/+$/, '');
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review?limit=50`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'X-Machine-ID': vscode.env.machineId,
        Accept: 'application/json',
      },
    });
    const data = await response.json().catch(() => null) as TyneValidateReviewHistoryResponse | TyneValidateReviewError | null;
    if (!response.ok || !data) {
      const error = data && 'error' in data ? data.error : `Could not load report history (${response.status})`;
      throw new ValidateReviewError(error);
    }
    return (data as TyneValidateReviewHistoryResponse).reports || [];
  }

  async submitFindingFeedback(input: FindingFeedbackRequest): Promise<void> {
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new ValidateReviewError('GitHub connection is required to submit feedback.');
    }
    const supabaseUrl = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co').replace(/\/+$/, '');
    const response = await fetch(`${supabaseUrl}/functions/v1/tyne-validate-review/feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
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
    const githubToken = await this.context.secrets.get('tyne_github_token');
    if (!githubToken) {
      throw new ValidateReviewError('GitHub connection is required.');
    }
    const supabaseUrl = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co').replace(/\/+$/, '');
    return {
      githubToken,
      supabaseUrl,
      headers: {
        Authorization: `Bearer ${githubToken}`,
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

  private _normalizeTier(tier: string): ReviewTier {
    const t = tier.toLowerCase();
    if (t === 'pro') return 'pro';
    if (t === 'max') return 'max';
    return 'free';
  }
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
): TyneValidateReviewRequest['thread'] {
  const source = pmTask?.source || (state.taskSource === 'jira' || state.taskSource === 'linear' ? state.taskSource : undefined);
  return {
    threadId: state.taskId || undefined,
    issueSource: source || (state.taskId ? 'manual' : undefined),
    issueId: state.taskId || undefined,
    issueIdentifier: pmTask?.issueIdentifier || state.pmTaskContext?.issueIdentifier || state.pmTaskContext?.issueKey || state.taskId || undefined,
    issueTitle: pmTask?.title || state.taskTitle || state.goal || undefined,
  };
}
