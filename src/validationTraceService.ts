import {
  TyneAiProvider,
  TynePlanTier,
  TyneRiskLevel,
  TyneValidationResult,
  TyneValidationStepStatus,
  TyneValidationStepTrace,
  TyneValidationTrace,
  TyneValidationTraceOverallStatus,
  TyneValidationTraceProvider,
  TyneValidationWorkflowType,
} from './validationTypes';

type TracePlanTier = 'core' | 'pro' | 'max';
type ExecutionMode = 'deterministic' | 'hybrid' | 'staged';

interface ValidationTraceContext {
  taskId?: string;
  taskTitle?: string;
  goal?: string;
  branchName?: string;
  commitHash?: string;
  changedFiles?: string[];
  linesAdded?: number;
  linesDeleted?: number;
}

interface ValidationExecutionStepDefinition {
  key: string;
  title: string;
  description: string;
  provider: TyneValidationTraceProvider;
  model: string;
  metadata?: Record<string, unknown>;
}

export interface ValidationExecutionPlan {
  planTier: TracePlanTier;
  workflowType: TyneValidationWorkflowType;
  executionMode: ExecutionMode;
  strategySummary: string;
  steps: ValidationExecutionStepDefinition[];
}

export function getValidationTraceService(): ValidationTraceService {
  return new ValidationTraceService();
}

export class ValidationTraceService {
  getValidationExecutionPlan(planTier: TynePlanTier, workflowType: TyneValidationWorkflowType = 'code_validation'): ValidationExecutionPlan {
    const tier = toTracePlanTier(planTier);
    return {
      planTier: tier,
      workflowType,
      executionMode: executionModeForTier(tier),
      strategySummary: strategySummaryForTier(tier),
      steps: buildValidationSteps(tier),
    };
  }

  getPreferredValidationProvider(planTier: TynePlanTier, stepKey: string): { provider: TyneValidationTraceProvider; model: string } {
    const plan = this.getValidationExecutionPlan(planTier);
    const step = plan.steps.find(item => item.key === stepKey);
    if (!step) {
      return { provider: 'system', model: 'Deterministic guardrail' };
    }
    return { provider: step.provider, model: step.model };
  }

  buildValidationTraceRunning(planTier: TynePlanTier, context: ValidationTraceContext = {}): TyneValidationTrace {
    const plan = this.getValidationExecutionPlan(planTier);
    const now = new Date().toISOString();
    const steps = plan.steps.map((step, index) => ({
      id: traceStepId(step.key),
      key: step.key,
      title: step.title,
      description: step.description,
      status: index === 0 ? 'running' as TyneValidationStepStatus : 'pending' as TyneValidationStepStatus,
      provider: step.provider,
      model: step.model,
      summary: index === 0 ? this._runningSummary(step.key, context) : undefined,
      startedAt: index === 0 ? now : undefined,
      metadata: step.metadata,
    }));

    return {
      id: traceId('validation'),
      traceType: 'code_validation',
      entityType: 'task',
      entityId: context.taskId,
      overallStatus: 'running',
      currentStepKey: steps[0]?.key,
      planTier: plan.planTier,
      strategySummary: plan.strategySummary,
      executionMode: plan.executionMode,
      steps,
      createdAt: now,
      updatedAt: now,
    };
  }

  buildValidationTraceComplete(planTier: TynePlanTier, result: TyneValidationResult, context: ValidationTraceContext = {}): TyneValidationTrace {
    const plan = this.getValidationExecutionPlan(planTier);
    const endAt = result.createdAt || new Date().toISOString();
    const startAt = result.durationMs ? new Date(new Date(endAt).getTime() - result.durationMs).toISOString() : endAt;
    const durationParts = allocateDurations(result.durationMs || 0, plan.steps.length);
    let cursor = new Date(startAt).getTime();

    const steps = plan.steps.map((def, index) => {
      const durationMs = durationParts[index] || 0;
      const startedAt = new Date(cursor).toISOString();
      const completedAt = new Date(cursor + durationMs).toISOString();
      cursor += durationMs;
      const step = this._completeStep(def, result, context, plan.planTier);
      return {
        id: traceStepId(def.key),
        key: def.key,
        title: def.title,
        description: def.description,
        provider: step.provider ?? def.provider,
        model: step.model ?? def.model,
        status: step.status || 'success',
        summary: step.summary,
        details: step.details,
        evidence: step.evidence,
        confidence: step.confidence,
        errorMessage: step.errorMessage,
        retryCount: 0,
        costEstimate: step.costEstimate,
        tokenEstimate: step.tokenEstimate,
        metadata: { ...def.metadata, ...step.metadata },
        startedAt,
        completedAt,
        durationMs,
      };
    });

    return {
      id: traceId(result.id || 'validation'),
      traceType: 'code_validation',
      entityType: 'task',
      entityId: result.taskId || context.taskId,
      overallStatus: overallStatusFromResult(result.status),
      currentStepKey: undefined,
      planTier: plan.planTier,
      strategySummary: plan.strategySummary,
      executionMode: plan.executionMode,
      steps,
      createdAt: startAt,
      updatedAt: endAt,
    };
  }

  buildValidationTraceError(planTier: TynePlanTier, message: string, context: ValidationTraceContext = {}): TyneValidationTrace {
    const plan = this.getValidationExecutionPlan(planTier);
    const now = new Date().toISOString();
    const failedKey = plan.planTier === 'max' ? 'axiom_synthesis' : 'axiom_review';
    const steps = plan.steps.map((step, index) => {
      let status: TyneValidationStepStatus = 'pending';
      if (index === 0) { status = 'success'; }
      if (step.key === failedKey) { status = 'failed'; }
      if (index === 1 && step.key !== failedKey) { status = 'success'; }
      return {
        id: traceStepId(step.key),
        key: step.key,
        title: step.title,
        description: step.description,
        status,
        provider: step.provider,
        model: step.model,
        summary: step.key === failedKey ? 'Validation stopped before completion.' : this._runningSummary(step.key, context),
        errorMessage: step.key === failedKey ? message : undefined,
        details: step.key === failedKey ? message : undefined,
        metadata: step.metadata,
        startedAt: index < 2 ? now : undefined,
        completedAt: status === 'success' ? now : undefined,
        durationMs: status !== 'pending' ? 0 : undefined,
      };
    });

    return {
      id: traceId('validation-error'),
      traceType: 'code_validation',
      entityType: 'task',
      entityId: context.taskId,
      overallStatus: 'failed',
      currentStepKey: failedKey,
      planTier: plan.planTier,
      strategySummary: plan.strategySummary,
      executionMode: plan.executionMode,
      steps,
      createdAt: now,
      updatedAt: now,
    };
  }

  private _runningSummary(stepKey: string, context: ValidationTraceContext): string {
    if (stepKey === 'request_received') {
      return context.taskId ? `Bound to ${context.taskId}.` : 'Collecting validation context.';
    }
    if (stepKey === 'scope_parsed') {
      return context.goal ? trimSentence(context.goal) : 'Parsing goal and proof points.';
    }
    if (stepKey === 'workspace_snapshot' || stepKey === 'context_distilled') {
      const fileCount = context.changedFiles?.length || 0;
      return fileCount > 0 ? `Preparing ${fileCount} changed file(s) for review.` : 'Preparing workspace diff for review.';
    }
    return 'Validation in progress.';
  }

  private _completeStep(
    step: ValidationExecutionStepDefinition,
    result: TyneValidationResult,
    context: ValidationTraceContext,
    planTier: TracePlanTier,
  ): Partial<TyneValidationStepTrace> {
    switch (step.key) {
      case 'request_received':
        return {
          status: 'success',
          summary: result.taskId ? `Validation linked to ${result.taskId}.` : 'Validation request received.',
          details: result.taskTitle || context.goal,
          evidence: compactEvidence([
            result.taskId ? `Task ${result.taskId}` : undefined,
            result.branchName ? `Branch ${result.branchName}` : undefined,
            result.commitHash ? `Commit ${result.commitHash.slice(0, 8)}` : undefined,
          ]),
        };
      case 'scope_parsed':
        return {
          status: 'success',
          summary: result.taskTitle || context.goal || 'Goal and branch scope parsed.',
          details: context.goal || result.summary,
          confidence: typeof result.matchPercent === 'number' ? Math.max(0, Math.min(1, result.matchPercent / 100)) : null,
        };
      case 'workspace_snapshot':
        return {
          status: 'success',
          summary: result.filesReviewed?.length
            ? `Prepared ${result.filesReviewed.length} file(s) for review.`
            : `Prepared ${context.changedFiles?.length || 0} file(s) for review.`,
          details: describeDiffContext(result, context),
          evidence: compactEvidence(result.filesReviewed || context.changedFiles),
        };
      case 'context_distilled':
        return {
          status: 'success',
          summary: 'Compressed workspace context for the final validator.',
          details: 'Max plan keeps expensive reasoning bounded by distilling the diff, task goal, and proof points before the final AXIOM synthesis.',
          provider: 'internal',
          model: 'Structured context distiller',
          evidence: compactEvidence([
            result.filesReviewed?.length ? `${result.filesReviewed.length} reviewed file(s)` : undefined,
            context.linesAdded !== undefined || context.linesDeleted !== undefined
              ? `Diff balance +${context.linesAdded || 0} / -${context.linesDeleted || 0}`
              : undefined,
          ]),
          metadata: {
            plannedProvider: 'deepseek',
            plannedModel: 'DeepSeek structural routing',
            note: 'Architecture-ready staged routing; current production flow still uses one AXIOM synthesis pass.',
          },
        };
      case 'axiom_review':
      case 'axiom_synthesis':
        return {
          status: result.status === 'fail' ? 'failed' : result.status === 'partial' ? 'warning' : 'success',
          summary: result.summary,
          details: result.detailedExplanation || result.summary,
          provider: 'axiom',
          model: axiomModelLabel(result.provider, planTier),
          evidence: compactEvidence(result.missingRequirements || result.suggestions || result.filesReviewed),
          confidence: typeof result.matchPercent === 'number' ? Math.max(0, Math.min(1, result.matchPercent / 100)) : null,
          tokenEstimate: estimateTokens(result),
          metadata: {
            actualProvider: result.provider,
            planTier,
          },
        };
      case 'risk_assessment':
        return {
          status: riskStatus(result.riskLevel, result.status),
          summary: result.riskLevel && result.riskLevel !== 'not_assessed'
            ? `Risk level ${result.riskLevel}.`
            : 'Risk assessed from validation evidence.',
          details: buildRiskDetails(result),
          provider: result.status === 'pass' && planTier === 'core' ? 'rule_engine' : 'axiom',
          model: result.status === 'pass' && planTier === 'core' ? 'Rule-based thresholding' : axiomModelLabel(result.provider, planTier),
          evidence: compactEvidence(result.codeQualityNotes || result.missingRequirements),
        };
      case 'final_decision':
        return {
          status: stepStatusFromResult(result.status),
          summary: finalDecisionSummary(result),
          details: result.detailedExplanation || result.summary,
          provider: 'system',
          model: 'Outcome gate',
          evidence: compactEvidence([
            typeof result.matchPercent === 'number' ? `Match ${result.matchPercent}%` : undefined,
            result.riskLevel ? `Risk ${result.riskLevel}` : undefined,
            result.status.toUpperCase(),
          ]),
        };
      default:
        return { status: 'success' };
    }
  }
}

function buildValidationSteps(planTier: TracePlanTier): ValidationExecutionStepDefinition[] {
  const base: ValidationExecutionStepDefinition[] = [
    {
      key: 'request_received',
      title: 'Request received',
      description: 'The validation run is registered and tied to the active task and branch.',
      provider: 'system',
      model: 'Workflow bootstrap',
    },
    {
      key: 'scope_parsed',
      title: 'Scope parsed',
      description: 'Goal, proof points, and acceptance context are normalized into a validation brief.',
      provider: 'rule_engine',
      model: planTier === 'core' ? 'Deterministic scope parser' : 'Hybrid scope parser',
    },
    {
      key: 'workspace_snapshot',
      title: 'Context loaded',
      description: 'Changed files and sanitized diffs are prepared for review.',
      provider: 'internal',
      model: 'Diff sanitizer',
    },
  ];

  if (planTier === 'max') {
    base.push({
      key: 'context_distilled',
      title: 'Context distilled',
      description: 'Large workspace context is compressed into a smaller reasoning packet before the final review.',
      provider: 'internal',
      model: 'Structured context distiller',
      metadata: {
        preferredProvider: 'deepseek',
        preferredModel: 'DeepSeek structural routing',
      },
    });
    base.push({
      key: 'axiom_synthesis',
      title: 'AXIOM synthesis',
      description: 'AXIOM performs the final validation pass using the distilled context packet.',
      provider: 'axiom',
      model: 'AXIOM Max Review',
    });
  } else {
    base.push({
      key: 'axiom_review',
      title: 'AXIOM review',
      description: 'AXIOM evaluates whether the change satisfies the goal and proof points.',
      provider: 'axiom',
      model: planTier === 'core' ? 'AXIOM Core Review' : 'AXIOM Pro Review',
    });
  }

  base.push(
    {
      key: 'risk_assessment',
      title: 'Risk assessed',
      description: 'Validation findings are converted into a delivery risk signal.',
      provider: planTier === 'core' ? 'rule_engine' : 'axiom',
      model: planTier === 'core' ? 'Rule-based thresholding' : 'AXIOM Risk Score',
    },
    {
      key: 'final_decision',
      title: 'Decision prepared',
      description: 'The final pass/warning/fail outcome is packaged for the sidebar and workflow gates.',
      provider: 'system',
      model: 'Outcome gate',
    },
  );

  return base;
}

function toTracePlanTier(planTier: TynePlanTier): TracePlanTier {
  return planTier === 'max' ? 'max' : planTier === 'pro' ? 'pro' : 'core';
}

function executionModeForTier(planTier: TracePlanTier): ExecutionMode {
  if (planTier === 'max') { return 'staged'; }
  if (planTier === 'pro') { return 'hybrid'; }
  return 'deterministic';
}

function strategySummaryForTier(planTier: TracePlanTier): string {
  if (planTier === 'max') {
    return 'Max uses staged validation: internal context shaping first, then AXIOM synthesis on condensed evidence.';
  }
  if (planTier === 'pro') {
    return 'Pro stays cost-aware with deterministic preprocessing followed by a compact AXIOM review.';
  }
  return 'Core prefers deterministic checks and a minimal AXIOM pass only when needed.';
}

function overallStatusFromResult(status: TyneValidationResult['status']): TyneValidationTraceOverallStatus {
  if (status === 'pass') { return 'success'; }
  if (status === 'fail') { return 'failed'; }
  return 'warning';
}

function stepStatusFromResult(status: TyneValidationResult['status']): TyneValidationStepStatus {
  if (status === 'pass') { return 'success'; }
  if (status === 'fail') { return 'failed'; }
  return 'warning';
}

function riskStatus(riskLevel: TyneRiskLevel | undefined, status: TyneValidationResult['status']): TyneValidationStepStatus {
  if (status === 'fail') { return 'failed'; }
  if (riskLevel === 'high' || riskLevel === 'medium' || status === 'partial') { return 'warning'; }
  return 'success';
}

function buildRiskDetails(result: TyneValidationResult): string {
  if (result.codeQualityNotes?.length) {
    return result.codeQualityNotes.join(' ');
  }
  if (result.missingRequirements?.length) {
    return result.missingRequirements.join(' ');
  }
  return result.riskLevel && result.riskLevel !== 'not_assessed'
    ? `The overall delivery risk was marked ${result.riskLevel}.`
    : 'No additional risk signals were attached to this run.';
}

function finalDecisionSummary(result: TyneValidationResult): string {
  if (result.status === 'pass') {
    return 'Validation passed and the workflow can proceed.';
  }
  if (result.status === 'fail') {
    return 'Validation failed and the workflow remains blocked.';
  }
  return 'Validation completed with warnings and still needs review.';
}

function describeDiffContext(result: TyneValidationResult, context: ValidationTraceContext): string {
  const pieces: string[] = [];
  if (result.filesReviewed?.length) {
    pieces.push(`Reviewed ${result.filesReviewed.length} file(s).`);
  } else if (context.changedFiles?.length) {
    pieces.push(`Prepared ${context.changedFiles.length} changed file(s).`);
  }
  if (context.linesAdded !== undefined || context.linesDeleted !== undefined) {
    pieces.push(`Diff footprint: +${context.linesAdded || 0} / -${context.linesDeleted || 0}.`);
  }
  return pieces.join(' ') || 'Prepared workspace context for validation.';
}

function estimateTokens(result: TyneValidationResult): number | null {
  const fileCount = result.filesReviewed?.length || 0;
  if (!fileCount && !result.durationMs) { return null; }
  return Math.max(120, fileCount * 180);
}

function axiomModelLabel(provider: TyneAiProvider, planTier: TracePlanTier): string {
  if (provider === 'managed') {
    return planTier === 'max' ? 'AXIOM Hosted Max' : planTier === 'pro' ? 'AXIOM Hosted Pro' : 'AXIOM Hosted Core';
  }
  return 'AXIOM Custom Key';
}

function compactEvidence(items?: Array<string | undefined>): string[] | undefined {
  if (!items || items.length === 0) { return undefined; }
  return items.filter((item): item is string => Boolean(item)).slice(0, 5);
}

function allocateDurations(totalMs: number, count: number): number[] {
  if (!totalMs || totalMs <= 0 || count <= 0) {
    return Array.from({ length: count }, () => 0);
  }
  const weights = count === 6 ? [1, 1, 1, 2, 2, 1] : count === 5 ? [1, 1, 2, 2, 1] : Array.from({ length: count }, () => 1);
  const weightTotal = weights.reduce((sum, item) => sum + item, 0);
  const values = weights.map(weight => Math.max(1, Math.round((totalMs * weight) / weightTotal)));
  const diff = totalMs - values.reduce((sum, item) => sum + item, 0);
  values[values.length - 1] += diff;
  return values;
}

function traceId(seed: string): string {
  return `trace-${seed}-${Date.now().toString(36)}`;
}

function traceStepId(key: string): string {
  return `step-${key}`;
}

function trimSentence(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}
