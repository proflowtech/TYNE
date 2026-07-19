import { TyneValidateReviewResult, TyneValidateReviewFinding } from './validateReviewTypes';
import { getValidateReviewService } from './validateReviewService';
import * as vscode from 'vscode';

export interface ReviewTrendSummary {
  totalReviews: number;
  averageScore: number;
  passRatePercent: number;
  needsWorkRatePercent: number;
  blockedRatePercent: number;
  averageRiskLevel: string;
  averageVibeCodeRisk: string;
  reviewsThisWeek: number;
  reviewsThisMonth: number;
  trendDirection: 'improving' | 'declining' | 'stable' | 'not_enough_data';
  commonIssueTypes: { category: string; count: number; severity: string }[];
  riskyFiles: { file: string; findingCount: number; avgSeverity: string }[];
  vibeCodeTrend: { high: number; medium: number; low: number };
  scoreTrend: number[];
  topFindingTitles: { title: string; count: number }[];
}

export function getReviewTrendService(context: vscode.ExtensionContext): ReviewTrendService {
  return new ReviewTrendService(context);
}

/** Recurring vibe_code finding titles across recent reports (for quality engine boost). */
export async function getRecurringVibeTitles(
  context: vscode.ExtensionContext,
): Promise<Array<{ title: string; count: number }>> {
  try {
    const reports = await getValidateReviewService(context).listReports();
    const counts = new Map<string, { title: string; count: number }>();
    for (const report of reports.slice(0, 40)) {
      for (const f of report.findings || []) {
        if (f.category !== 'vibe_code' || !f.title) continue;
        const key = f.title.toLowerCase().trim();
        const prev = counts.get(key);
        if (prev) prev.count++;
        else counts.set(key, { title: f.title, count: 1 });
      }
    }
    return [...counts.values()].filter(x => x.count >= 2).sort((a, b) => b.count - a.count).slice(0, 12);
  } catch {
    return [];
  }
}

export class ReviewTrendService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getReviewTrends(): Promise<ReviewTrendSummary> {
    let reports: TyneValidateReviewResult[] = [];
    try {
      const service = getValidateReviewService(this.context);
      reports = await service.listReports();
    } catch {
      return this._emptySummary();
    }

    if (!reports.length) {
      return this._emptySummary();
    }

    const total = reports.length;
    const scores = reports.map(r => r.score || 0);
    const averageScore = Math.round(scores.reduce((a, b) => a + b, 0) / total);
    const passCount = reports.filter(r => r.status === 'passed').length;
    const needsWorkCount = reports.filter(r => r.status === 'needs_work').length;
    const blockedCount = reports.filter(r => r.status === 'blocked').length;

    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const reviewsThisWeek = reports.filter(r => r.createdAt && new Date(r.createdAt) >= weekStart).length;
    const reviewsThisMonth = reports.filter(r => r.createdAt && new Date(r.createdAt) >= monthStart).length;

    const sorted = [...reports].sort((a, b) => {
      const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aDate - bDate;
    });

    const scoreTrend = sorted.map(r => r.score || 0);
    const trendDirection = this._calculateTrendDirection(scoreTrend);

    const allFindings = reports.flatMap(r => r.findings || []);
    const commonIssueTypes = this._aggregateByCategory(allFindings);
    const riskyFiles = this._aggregateRiskyFiles(allFindings);
    const topFindingTitles = this._aggregateByTitle(allFindings);

    const vibeHigh = reports.filter(r => r.vibeCodeRisk === 'high').length;
    const vibeMedium = reports.filter(r => r.vibeCodeRisk === 'medium').length;
    const vibeLow = reports.filter(r => r.vibeCodeRisk === 'low').length;

    const avgRisk = this._averageRiskLevel(reports);
    const avgVibe = this._averageVibeCodeRisk(reports);

    return {
      totalReviews: total,
      averageScore,
      passRatePercent: Math.round((passCount / total) * 100),
      needsWorkRatePercent: Math.round((needsWorkCount / total) * 100),
      blockedRatePercent: Math.round((blockedCount / total) * 100),
      averageRiskLevel: avgRisk,
      averageVibeCodeRisk: avgVibe,
      reviewsThisWeek,
      reviewsThisMonth,
      trendDirection,
      commonIssueTypes,
      riskyFiles,
      vibeCodeTrend: { high: vibeHigh, medium: vibeMedium, low: vibeLow },
      scoreTrend: scoreTrend.slice(-10),
      topFindingTitles,
    };
  }

  private _calculateTrendDirection(scores: number[]): 'improving' | 'declining' | 'stable' | 'not_enough_data' {
    if (scores.length < 3) { return 'not_enough_data'; }
    const recent = scores.slice(-5);
    const older = scores.slice(0, Math.max(1, scores.length - 5));
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const diff = recentAvg - olderAvg;
    if (diff > 5) { return 'improving'; }
    if (diff < -5) { return 'declining'; }
    return 'stable';
  }

  private _aggregateByCategory(findings: TyneValidateReviewFinding[]): { category: string; count: number; severity: string }[] {
    const byCat = new Map<string, { count: number; severities: string[] }>();
    for (const f of findings) {
      const cat = f.category || 'other';
      if (!byCat.has(cat)) { byCat.set(cat, { count: 0, severities: [] }); }
      const entry = byCat.get(cat)!;
      entry.count++;
      entry.severities.push(f.severity);
    }
    return Array.from(byCat.entries())
      .map(([category, { count, severities }]) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const avgSev = severities.map(s => severityOrder[s as keyof typeof severityOrder] || 2)
          .reduce((a, b) => a + b, 0) / severities.length;
        const severity = avgSev >= 3.5 ? 'critical' : avgSev >= 2.5 ? 'high' : avgSev >= 1.5 ? 'medium' : 'low';
        return { category, count, severity };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }

  private _aggregateRiskyFiles(findings: TyneValidateReviewFinding[]): { file: string; findingCount: number; avgSeverity: string }[] {
    const byFile = new Map<string, { count: number; severities: string[] }>();
    for (const f of findings) {
      if (!f.file) { continue; }
      if (!byFile.has(f.file)) { byFile.set(f.file, { count: 0, severities: [] }); }
      const entry = byFile.get(f.file)!;
      entry.count++;
      entry.severities.push(f.severity);
    }
    return Array.from(byFile.entries())
      .map(([file, { count, severities }]) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const avgSev = severities.map(s => severityOrder[s as keyof typeof severityOrder] || 2)
          .reduce((a, b) => a + b, 0) / severities.length;
        const avgSeverity = avgSev >= 3.5 ? 'critical' : avgSev >= 2.5 ? 'high' : avgSev >= 1.5 ? 'medium' : 'low';
        return { file, findingCount: count, avgSeverity };
      })
      .sort((a, b) => b.findingCount - a.findingCount)
      .slice(0, 5);
  }

  private _aggregateByTitle(findings: TyneValidateReviewFinding[]): { title: string; count: number }[] {
    const byTitle = new Map<string, number>();
    for (const f of findings) {
      const title = (f.title || '').toLowerCase().trim();
      if (!title) { continue; }
      byTitle.set(title, (byTitle.get(title) || 0) + 1);
    }
    return Array.from(byTitle.entries())
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  private _averageRiskLevel(reports: TyneValidateReviewResult[]): string {
    const order = { low: 1, medium: 2, high: 3 };
    const values = reports.map(r => order[r.riskLevel as keyof typeof order] || 2);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return avg >= 2.5 ? 'high' : avg >= 1.5 ? 'medium' : 'low';
  }

  private _averageVibeCodeRisk(reports: TyneValidateReviewResult[]): string {
    const order = { low: 1, medium: 2, high: 3 };
    const values = reports.map(r => order[r.vibeCodeRisk as keyof typeof order] || 2);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return avg >= 2.5 ? 'high' : avg >= 1.5 ? 'medium' : 'low';
  }

  private _emptySummary(): ReviewTrendSummary {
    return {
      totalReviews: 0,
      averageScore: 0,
      passRatePercent: 0,
      needsWorkRatePercent: 0,
      blockedRatePercent: 0,
      averageRiskLevel: 'medium',
      averageVibeCodeRisk: 'medium',
      reviewsThisWeek: 0,
      reviewsThisMonth: 0,
      trendDirection: 'not_enough_data',
      commonIssueTypes: [],
      riskyFiles: [],
      vibeCodeTrend: { high: 0, medium: 0, low: 0 },
      scoreTrend: [],
      topFindingTitles: [],
    };
  }
}
