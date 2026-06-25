import {
  TyneEnhancedValidationView,
  TyneFreeValidationView,
  TynePlanTier,
  TyneRiskLevel,
  TyneValidationResult,
  TyneValidationStatus,
  TyneValidationUsageSummary,
} from './validationTypes';
import { formatHistoryLine, capitalize, formatDate } from './validationUtils';

export function getValidationDisplayService(): ValidationDisplayService {
  return new ValidationDisplayService();
}

export class ValidationDisplayService {
  toFreeValidationView(result: TyneValidationResult): TyneFreeValidationView {
    return {
      id: result.id,
      status: result.status,
      summary: result.summary,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      branchName: result.branchName,
      commitHash: result.commitHash,
      createdAt: result.createdAt,
    };
  }

  toEnhancedValidationView(result: TyneValidationResult): TyneEnhancedValidationView {
    return {
      id: result.id,
      status: result.status,
      matchPercent: result.matchPercent,
      riskLevel: result.riskLevel,
      summary: result.summary,
      detailedExplanation: result.detailedExplanation,
      missingRequirements: result.missingRequirements,
      suggestions: result.suggestions,
      codeQualityNotes: result.codeQualityNotes,
      filesReviewed: result.filesReviewed,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      branchName: result.branchName,
      commitHash: result.commitHash,
      provider: result.provider,
      createdAt: result.createdAt,
    };
  }

  getValidationBadge(result: TyneValidationResult): string {
    return statusLabel(result.status);
  }

  getRiskBadge(result: TyneValidationResult): string {
    if (!result.riskLevel) { return 'Risk: N/A'; }
    return `Risk: ${capitalize(result.riskLevel)}`;
  }

  formatUsageSummary(summary: TyneValidationUsageSummary): string {
    if (summary.limit === 'unlimited') {
      return 'Validations: Unlimited';
    }
    return `Validations: ${summary.used}/${summary.limit}`;
  }

  formatHistoryLine(result: TyneValidationResult): string {
    return formatHistoryLine(result);
  }

  formatValidationStatus(status: TyneValidationStatus): string {
    return statusLabel(status);
  }

  formatRiskLevel(risk?: TyneRiskLevel): string {
    if (!risk || risk === 'not_assessed') { return 'Not assessed'; }
    return capitalize(risk);
  }

  formatHistoryItem(result: TyneValidationResult, tier: TynePlanTier): string {
    if (tier === 'free') {
      return formatHistoryLine(result);
    }
    const parts = [statusLabel(result.status).toUpperCase()];
    if (result.matchPercent !== undefined) { parts.push(`${result.matchPercent}%`); }
    if (result.riskLevel) { parts.push(`Risk: ${capitalize(result.riskLevel)}`); }
    if (result.taskId) { parts.push(`${result.taskId}`); }
    if (result.taskTitle) { parts.push(result.taskTitle); }
    if (result.branchName) { parts.push(`Branch: ${result.branchName}`); }
    if (result.commitHash) { parts.push(`Commit: ${result.commitHash.slice(0, 8)}`); }
    parts.push(`Validated: ${formatDate(result.createdAt)}`);
    return parts.join(' · ');
  }
}

export function statusLabel(status: TyneValidationStatus): string {
  switch (status) {
    case 'pass': return 'Pass';
    case 'fail': return 'Fail';
    case 'partial': return 'Partial';
  }
}

export function statusClass(status: TyneValidationStatus): string {
  switch (status) {
    case 'pass': return 'good';
    case 'fail': return 'bad';
    case 'partial': return 'warn';
  }
}

