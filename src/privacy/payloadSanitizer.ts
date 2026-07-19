import { createHash } from 'crypto';
import type { PrivacyMode, DataResidency, SourceProcessingType } from './privacyPolicy';
import { sourceProcessingForMode } from './privacyPolicy';
import {
  allowsByokRelayToBackend,
  allowsSourceCodeEgress,
  requiresClientRedaction,
} from './privacyModeService';
import { redactObjectStrings, redactSensitiveText } from './localRedactionEngine';
import { countSensitiveByClass } from './sensitiveDataScanner';
import {
  runLocalIntelligence,
  type LocalEgressSummary,
  type LocalFrameworkSummary,
} from './localIntelligence/localReviewEngine';

/** Hash-only evidence reference — never stores raw sensitive content. */
export interface EvidenceReference {
  id: string;
  file: string;
  line?: number;
  hash: string;
  classification: string;
  redacted: boolean;
}

export interface PrivacyEgressMeta {
  privacyMode: PrivacyMode;
  dataResidency: DataResidency;
  sourceProcessingType: SourceProcessingType;
  evidenceRedacted: boolean;
  evidencePersistenceDisabled: boolean;
  codeProcessing: 'cloud' | 'local';
  evidenceStorage: 'enabled' | 'disabled' | 'redacted_only';
  dataSent: string;
  llmExecutionPath?: 'managed' | 'direct_byok' | 'local';
  byokDirect?: boolean;
}

export interface LocalComplianceSummary extends LocalEgressSummary {
  status: 'no_violations' | 'issues_detected' | 'review_required' | 'blocked' | string;
  sensitiveCounts: Record<string, number>;
  frameworks: LocalFrameworkSummary[];
}

export function hashEvidence(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function toEvidenceReference(input: {
  file: string;
  line?: number;
  text: string;
  classification?: string;
}): EvidenceReference {
  const { text, redacted } = redactSensitiveText(input.text);
  return {
    id: `${input.file}:${input.line || 0}:${hashEvidence(input.text)}`,
    file: input.file,
    line: input.line,
    hash: hashEvidence(input.text),
    classification: input.classification || 'Sensitive',
    redacted: redacted || text.includes('[REDACTED'),
  };
}

function stripSourceFromEditedCode(editedCode: any): any {
  if (!editedCode || typeof editedCode !== 'object') return editedCode;
  return {
    ...editedCode,
    diff: '',
    changedFiles: Array.isArray(editedCode.changedFiles)
      ? editedCode.changedFiles.map((f: any) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        }))
      : [],
  };
}

function stripSourceFromContext(ctx: any): any {
  if (!ctx || typeof ctx !== 'object') return ctx;
  return {
    repositoryName: ctx.repositoryName,
    projectHints: Array.isArray(ctx.projectHints) ? ctx.projectHints.slice(0, 8) : [],
    nearbyFiles: [],
    changedFileContents: [],
    impactedFiles: Array.isArray(ctx.impactedFiles)
      ? ctx.impactedFiles.map((f: any) => ({ path: f.path }))
      : [],
    importedSymbols: [],
    pmTaskRelevantFiles: [],
  };
}

function stripPmBodies(pmTask: any): any {
  if (!pmTask || typeof pmTask !== 'object') return pmTask;
  return {
    source: pmTask.source,
    issueId: pmTask.issueId,
    issueIdentifier: pmTask.issueIdentifier,
    title: typeof pmTask.title === 'string' ? redactSensitiveText(pmTask.title).text : pmTask.title,
    // Drop free-text bodies that may contain PHI/PII
    description: undefined,
    comments: undefined,
    attachments: undefined,
    acceptanceCriteria: Array.isArray(pmTask.acceptanceCriteria)
      ? pmTask.acceptanceCriteria.map((c: string) => redactSensitiveText(String(c)).text).slice(0, 12)
      : undefined,
  };
}

/**
 * Run on-device compliance + security + classification + data-flow.
 * Returns egress-safe aggregates (titles + hashes only; never source/snippets).
 */
export function buildLocalComplianceSummary(input: {
  diff?: string;
  frameworks?: string[];
}): LocalComplianceSummary {
  const local = runLocalIntelligence({
    diff: input.diff || '',
    frameworks: input.frameworks,
  });
  const counts = countSensitiveByClass(input.diff || '');
  return {
    ...local.egressSummary,
    status: local.egressSummary.status,
    sensitiveCounts: counts,
  };
}

export function buildPrivacyMeta(input: {
  mode: PrivacyMode;
  residency: DataResidency;
  evidencePersistenceDisabled: boolean;
  evidenceRedacted: boolean;
  llmExecutionPath?: 'managed' | 'direct_byok' | 'local';
}): PrivacyEgressMeta {
  const mode = input.mode;
  const llmExecutionPath = input.llmExecutionPath
    || (mode === 'local_compliance' ? 'local' : 'managed');
  return {
    privacyMode: mode,
    dataResidency: input.residency,
    sourceProcessingType: sourceProcessingForMode(mode),
    evidenceRedacted: input.evidenceRedacted || mode !== 'cloud',
    evidencePersistenceDisabled: input.evidencePersistenceDisabled || mode === 'local_compliance',
    codeProcessing: mode === 'local_compliance' ? 'local' : 'cloud',
    evidenceStorage: mode === 'local_compliance'
      ? 'disabled'
      : (input.evidenceRedacted || mode === 'privacy_enhanced' ? 'redacted_only' : 'enabled'),
    dataSent: mode === 'local_compliance'
      ? 'Aggregated findings only'
      : mode === 'privacy_enhanced'
        ? 'Sanitized code and metadata'
        : 'Full review payload',
    llmExecutionPath,
    byokDirect: llmExecutionPath === 'direct_byok',
  };
}

/**
 * Sanitize Validate & Review request BEFORE any network call.
 * Cloud = identity (optional light pass). Privacy enhanced = redact. Local = strip source.
 * BYOK keys are never relayed (Phase 3 direct BYOK).
 */
export function sanitizeValidateReviewPayload(
  request: Record<string, any>,
  options: {
    privacyMode: PrivacyMode;
    dataResidency: DataResidency;
    evidencePersistenceDisabled?: boolean;
    clientAiReview?: Record<string, unknown>;
    llmExecutionPath?: 'managed' | 'direct_byok' | 'local';
    byokModel?: string;
    byokProviderName?: string;
  },
): { request: Record<string, any>; privacy: PrivacyEgressMeta; localSummary?: LocalComplianceSummary } {
  const mode = options.privacyMode;
  let next = { ...request };
  let evidenceRedacted = false;

  // Phase 3: never relay BYOK secrets to backend.
  if (!allowsByokRelayToBackend(mode)) {
    delete next.byokKey;
    delete next.byokProvider;
  }

  if (requiresClientRedaction(mode) && allowsSourceCodeEgress(mode)) {
    next = redactObjectStrings(next);
    evidenceRedacted = true;
    // Extra: ensure diff/snippets use typed placeholders
    if (next.editedCode?.diff) {
      const r = redactSensitiveText(String(next.editedCode.diff));
      next.editedCode = { ...next.editedCode, diff: r.text };
      evidenceRedacted = evidenceRedacted || r.redacted;
    }
  }

  let localSummary: LocalComplianceSummary | undefined;
  if (!allowsSourceCodeEgress(mode)) {
    localSummary = buildLocalComplianceSummary({
      diff: request.editedCode?.diff,
      frameworks: request.complianceFrameworks,
    });
    next.editedCode = stripSourceFromEditedCode(request.editedCode);
    next.codebaseContext = stripSourceFromContext(request.codebaseContext);
    next.pmTask = stripPmBodies(request.pmTask);
    next.staticAnalysis = undefined;
    next.guardrails = undefined;
    next.localComplianceSummary = localSummary;
    // Keep quality aggregates only — strip raw evidence snippets from findings.
    if (next.qualityReview && typeof next.qualityReview === 'object') {
      const qr = next.qualityReview;
      next.qualityReview = {
        qualityScore: qr.qualityScore,
        vibeCodeRisk: qr.vibeCodeRisk,
        scorecard: qr.scorecard,
        metrics: qr.metrics,
        debtMinutes: qr.debtMinutes,
        sectionScores: qr.sectionScores,
        egressSummary: qr.egressSummary,
        findings: Array.isArray(qr.findings)
          ? qr.findings.map((f: any) => ({
              id: f.id,
              title: f.title,
              severity: f.severity,
              category: f.category,
              confidence: f.confidence,
              file: f.file,
              line: f.line,
              debtMinutes: f.debtMinutes,
              metricValue: f.metricValue,
              ruleId: f.ruleId,
            }))
          : [],
      };
    }
    evidenceRedacted = true;
  }

  if (options.clientAiReview && typeof options.clientAiReview === 'object') {
    next.clientAiReview = options.clientAiReview;
    next.clientAiMeta = {
      provider: options.byokProviderName,
      model: options.byokModel,
      path: 'direct_byok',
    };
  }

  const privacy = buildPrivacyMeta({
    mode,
    residency: options.dataResidency,
    evidencePersistenceDisabled: options.evidencePersistenceDisabled === true || mode === 'local_compliance',
    evidenceRedacted,
    llmExecutionPath: options.llmExecutionPath
      || (mode === 'local_compliance' ? 'local' : options.clientAiReview ? 'direct_byok' : 'managed'),
  });
  next.privacyMode = privacy.privacyMode;
  next.dataResidency = privacy.dataResidency;
  next.evidencePersistenceDisabled = privacy.evidencePersistenceDisabled;
  next.privacyMeta = privacy;
  next.llmExecutionPath = privacy.llmExecutionPath;

  return { request: next, privacy, localSummary };
}
