import * as vscode from 'vscode';
import { TyneRiskLevel, TyneValidationHistoryFilters, TyneValidationResult, TyneValidationTrendSummary } from './validationTypes';
import { ValidationHistoryService } from './validationHistoryService';
import { calculatePassRate, calculateAverageMatch, calculateAverageRiskLevel, calculateTrendDirection } from './validationUtils';

export function getValidationTrendService(historyService: ValidationHistoryService): ValidationTrendService {
  return new ValidationTrendService(historyService);
}

export class ValidationTrendService {
  constructor(private readonly historyService: ValidationHistoryService) {}

  async getTrendSummary(filters?: TyneValidationHistoryFilters): Promise<TyneValidationTrendSummary> {
    const results = await this.historyService.filterValidationHistory(filters || {});
    if (results.length === 0) {
      return this._emptySummary();
    }
    const total = results.length;
    const passCount = results.filter(r => r.status === 'pass').length;
    const partialCount = results.filter(r => r.status === 'partial').length;
    const failCount = results.filter(r => r.status === 'fail').length;
    const averageMatch = this.calculateAverageMatch(results);
    const averageRisk = this.calculateAverageRiskLevel(results);
    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisWeek = results.filter(r => new Date(r.createdAt) >= weekStart).length;
    const thisMonth = results.filter(r => new Date(r.createdAt) >= monthStart).length;
    const taskCounts = this._countByTask(results);
    const mostValidated = Object.entries(taskCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      totalValidations: total,
      passRatePercent: Math.round((passCount / total) * 100),
      partialRatePercent: Math.round((partialCount / total) * 100),
      failRatePercent: Math.round((failCount / total) * 100),
      averageMatchPercent: averageMatch,
      averageRiskLevel: averageRisk,
      validationsThisWeek: thisWeek,
      validationsThisMonth: thisMonth,
      mostValidatedTaskId: mostValidated?.[0],
      mostValidatedTaskTitle: results.find(r => r.taskId === mostValidated?.[0])?.taskTitle,
      trendDirection: this.calculateTrendDirection(results),
    };
  }

  calculatePassRate(results: TyneValidationResult[]): number {
    return calculatePassRate(results);
  }

  calculateAverageMatch(results: TyneValidationResult[]): number | undefined {
    return calculateAverageMatch(results);
  }

  calculateAverageRiskLevel(results: TyneValidationResult[]): TyneRiskLevel | undefined {
    return calculateAverageRiskLevel(results);
  }

  calculateTrendDirection(results: TyneValidationResult[]): 'improving' | 'declining' | 'stable' | 'not_enough_data' {
    return calculateTrendDirection(results);
  }


  private _countByTask(results: TyneValidationResult[]): Record<string, number> {
    return results.reduce((acc, r) => {
      if (!r.taskId) { return acc; }
      acc[r.taskId] = (acc[r.taskId] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  private _emptySummary(): TyneValidationTrendSummary {
    return {
      totalValidations: 0,
      passRatePercent: 0,
      partialRatePercent: 0,
      failRatePercent: 0,
      averageMatchPercent: undefined,
      averageRiskLevel: undefined,
      validationsThisWeek: 0,
      validationsThisMonth: 0,
      trendDirection: 'not_enough_data',
    };
  }
}
