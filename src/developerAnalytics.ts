/**
 * Developer analytics aggregator.
 * Hybrid: Git session time + manual entries + commit LOC + Tyne AI usage/review quality.
 * ponytail: no live keystroke tracker yet — upgrade when Max needs minute-level activity types.
 */
import { TyneCommitSession } from './commitTypes';
import { TyneManualTimeEntry, TyneTimeLog, TyneTimeSummary } from './timeTypes';

export type AnalyticsActivity =
  | 'coding'
  | 'testing'
  | 'debugging'
  | 'review'
  | 'waiting'
  | 'other'
  | 'idle';

export interface AnalyticsAiModelSlice {
  model: string;
  count: number;
  percentage: number;
}

export interface AnalyticsTaskOption {
  taskId: string;
  taskTitle: string;
  totalMinutes: number;
  branchName?: string;
  commitCount: number;
}

export interface AnalyticsTimelineItem {
  activity: AnalyticsActivity;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  label: string;
  aiModel?: string;
}

export interface DeveloperAnalytics {
  taskId?: string;
  totalMinutes: number;
  timeBreakdown: Record<AnalyticsActivity, number>;
  codeMetrics: {
    linesAdded: number;
    linesDeleted: number;
    filesChanged: number;
    commitCount: number;
    locPerHour: number;
    averageCommitSize: number;
  };
  aiUsed: {
    primaryModel?: string;
    validationRuns: number;
    models: AnalyticsAiModelSlice[];
    aiAssistanceRatio: number;
  };
  productivityScore: number;
  velocityTrend: 'improving' | 'stable' | 'declining' | 'unknown';
  insights: string[];
  trackingAccuracy: 'estimated' | 'hybrid';
  qualityScore?: number;
  prTitle?: string;
  repository?: string;
  branchName?: string;
  peakCodingHours: string[];
  timeline: AnalyticsTimelineItem[];
}

export interface BuildAnalyticsInput {
  taskId?: string;
  taskTitle?: string;
  repositoryName?: string;
  branchName?: string;
  taskSummary?: TyneTimeSummary | null;
  branchSummary?: TyneTimeSummary | null;
  dailySummary?: TyneTimeSummary | null;
  weeklySummary?: TyneTimeSummary | null;
  logs: TyneTimeLog[];
  manuals: TyneManualTimeEntry[];
  sessions: TyneCommitSession[];
  validationRuns?: number;
  recentModels?: string[];
  qualityScore?: number;
}

function classifyManualNote(note?: string): AnalyticsActivity {
  const n = (note || '').toLowerCase();
  if (/debug|bug|fix|error|stack/.test(n)) { return 'debugging'; }
  if (/test|spec|coverage|jest|mocha|vitest/.test(n)) { return 'testing'; }
  if (/review|proof|self[- ]?check|read/.test(n)) { return 'review'; }
  if (/wait|pending|blocked/.test(n)) { return 'waiting'; }
  if (/idle|break|meeting/.test(n)) { return 'idle'; }
  return 'other';
}

function emptyBreakdown(): Record<AnalyticsActivity, number> {
  return { coding: 0, testing: 0, debugging: 0, review: 0, waiting: 0, other: 0, idle: 0 };
}

function stampMs(iso?: string): number {
  if (!iso) { return 0; }
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Gaps ≥30m between timed entries become waiting (capped at 2h). */
export function insertWaitingGaps(items: AnalyticsTimelineItem[]): AnalyticsTimelineItem[] {
  const sorted = [...items].sort((a, b) => stampMs(a.startTime) - stampMs(b.startTime));
  const out: AnalyticsTimelineItem[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (i > 0) {
      const prev = sorted[i - 1];
      const prevEnd = stampMs(prev.endTime || prev.startTime);
      const curStart = stampMs(cur.startTime);
      if (prevEnd > 0 && curStart > prevEnd) {
        const gapMin = Math.round((curStart - prevEnd) / 60_000);
        if (gapMin >= 30) {
          const waiting = Math.min(gapMin, 120);
          out.push({
            activity: 'waiting',
            startTime: prev.endTime || prev.startTime,
            endTime: cur.startTime,
            durationMinutes: waiting,
            label: 'Pending / waiting between sessions',
          });
        }
      }
    }
    out.push(cur);
  }
  return out;
}

export function listAnalyticsTasks(
  logs: TyneTimeLog[],
  manuals: TyneManualTimeEntry[],
  sessions: TyneCommitSession[] = [],
): AnalyticsTaskOption[] {
  type Acc = { taskId: string; taskTitle: string; totalMinutes: number; branchName?: string; commitCount: number };
  const map = new Map<string, Acc>();
  const bump = (taskId: string, title: string | undefined, mins: number, branch?: string, commits = 0) => {
    if (!taskId) { return; }
    const cur = map.get(taskId) || {
      taskId,
      taskTitle: title || taskId,
      totalMinutes: 0,
      branchName: branch,
      commitCount: 0,
    };
    cur.totalMinutes += Math.max(0, mins);
    cur.commitCount += commits;
    if (title) { cur.taskTitle = title; }
    if (branch) { cur.branchName = branch; }
    map.set(taskId, cur);
  };
  for (const l of logs) {
    if (!l.taskId) { continue; }
    bump(l.taskId, l.taskTitle, l.durationMinutes || 0, l.branchName, l.commitHashes?.length || 0);
  }
  for (const m of manuals) {
    if (!m.taskId) { continue; }
    bump(m.taskId, m.taskTitle, m.durationMinutes || 0, m.branchName);
  }
  for (const s of sessions) {
    if (!s.taskId) { continue; }
    // sessions already reflected in auto logs when generated; only fill title/branch if missing
    if (!map.has(s.taskId)) {
      bump(s.taskId, s.taskTitle, s.durationMinutes || 0, s.branchName, s.commitCount || 0);
    } else {
      const cur = map.get(s.taskId)!;
      if (s.taskTitle) { cur.taskTitle = s.taskTitle; }
      if (s.branchName) { cur.branchName = s.branchName; }
    }
  }
  return [...map.values()].sort((a, b) => b.totalMinutes - a.totalMinutes || a.taskTitle.localeCompare(b.taskTitle));
}

function hourBucket(iso?: string): string | null {
  if (!iso) { return null; }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) { return null; }
  const h = d.getHours();
  const end = (h + 1) % 24;
  const fmt = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return `${fmt(h)}–${fmt(end)}`;
}

export function calculateProductivityScore(input: {
  locPerHour: number;
  qualityScore?: number;
  debuggingPercent: number;
  aiAssistanceRatio: number;
  commitCount: number;
}): number {
  let score = 50;
  const loc = input.locPerHour;
  if (loc > 150) { score += 20; }
  else if (loc > 120) { score += 15; }
  else if (loc > 100) { score += 10; }
  else if (loc > 80) { score += 5; }
  else if (loc > 0) { score += 2; }

  const q = typeof input.qualityScore === 'number' ? input.qualityScore : 70;
  score += Math.round((Math.max(0, Math.min(100, q)) / 100) * 20);

  if (input.debuggingPercent < 5) { score += 15; }
  else if (input.debuggingPercent < 10) { score += 10; }
  else if (input.debuggingPercent < 15) { score += 5; }

  const ai = input.aiAssistanceRatio;
  if (ai >= 30 && ai <= 70) { score += 10; }
  else if (ai >= 20 && ai <= 80) { score += 5; }
  else if (ai > 0) { score += 2; }

  if (input.commitCount >= 3) { score += 5; }
  else if (input.commitCount >= 1) { score += 2; }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function buildDeveloperAnalytics(input: BuildAnalyticsInput): DeveloperAnalytics {
  const summary = input.taskSummary || input.branchSummary;
  const logs = input.logs || [];
  const manuals = input.manuals || [];
  const sessions = input.sessions || [];

  const breakdown = emptyBreakdown();
  const timeline: DeveloperAnalytics['timeline'] = [];

  for (const log of logs.filter(l => l.source === 'automatic_git')) {
    const mins = Math.max(0, log.durationMinutes || 0);
    breakdown.coding += mins;
    timeline.push({
      activity: 'coding',
      startTime: log.startTime,
      endTime: log.endTime,
      durationMinutes: mins,
      label: mins > 0 ? 'Git coding session' : 'Single-commit session',
    });
  }

  for (const entry of manuals) {
    const mins = Math.max(0, entry.durationMinutes || 0);
    const activity = classifyManualNote(entry.note);
    breakdown[activity] += mins;
    const start = entry.startTime
      ? (entry.startTime.includes('T') ? entry.startTime : `${entry.date}T${entry.startTime}`)
      : `${entry.date}T12:00:00`;
    const end = entry.endTime
      ? (entry.endTime.includes('T') ? entry.endTime : `${entry.date}T${entry.endTime}`)
      : undefined;
    timeline.push({
      activity,
      startTime: start,
      endTime: end,
      durationMinutes: mins,
      label: entry.note || 'Manual time',
    });
  }

  let timed = insertWaitingGaps(timeline);
  for (const w of timed.filter(t => t.activity === 'waiting')) {
    breakdown.waiting += w.durationMinutes;
  }

  const totalMinutes = Math.max(
    summary?.totalMinutes || 0,
    Object.values(breakdown).reduce((a, b) => a + b, 0),
  );

  const linesAdded = sessions.reduce((s, x) => s + (x.totalLinesAdded || 0), 0);
  const linesDeleted = sessions.reduce((s, x) => s + (x.totalLinesDeleted || 0), 0);
  const filesChanged = sessions.reduce((s, x) => s + (x.totalFilesChanged || 0), 0);
  const commitCount = sessions.reduce((s, x) => s + (x.commitCount || 0), 0)
    || summary?.commitCount
    || 0;
  const codingHours = breakdown.coding / 60;
  const locPerHour = codingHours > 0 ? Math.round(linesAdded / codingHours) : 0;
  const averageCommitSize = commitCount > 0 ? Math.round(linesAdded / commitCount) : 0;

  const modelCounts = new Map<string, number>();
  for (const m of input.recentModels || []) {
    const key = (m || '').trim() || 'unknown';
    modelCounts.set(key, (modelCounts.get(key) || 0) + 1);
  }
  const validationRuns = input.validationRuns ?? [...modelCounts.values()].reduce((a, b) => a + b, 0);
  const modelTotal = Math.max(1, [...modelCounts.values()].reduce((a, b) => a + b, 0));
  const models: AnalyticsAiModelSlice[] = [...modelCounts.entries()]
    .map(([model, count]) => ({
      model,
      count,
      percentage: Math.round((count / modelTotal) * 100),
    }))
    .sort((a, b) => b.count - a.count);
  const primaryModel = models[0]?.model;
  // ponytail: AI ratio ≈ share of coding time when Tyne AI was used this period
  const aiAssistanceRatio = breakdown.coding > 0 && validationRuns > 0
    ? Math.min(85, Math.round((validationRuns / Math.max(1, commitCount || validationRuns)) * 35))
    : 0;

  const debuggingPercent = totalMinutes > 0
    ? (breakdown.debugging / totalMinutes) * 100
    : 0;

  const productivityScore = calculateProductivityScore({
    locPerHour,
    qualityScore: input.qualityScore,
    debuggingPercent,
    aiAssistanceRatio,
    commitCount,
  });

  const hourHits = new Map<string, number>();
  for (const t of timeline) {
    const bucket = hourBucket(t.startTime);
    if (!bucket || t.activity !== 'coding') { continue; }
    hourHits.set(bucket, (hourHits.get(bucket) || 0) + t.durationMinutes);
  }
  const peakCodingHours = [...hourHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => h);

  let velocityTrend: DeveloperAnalytics['velocityTrend'] = 'unknown';
  const daily = input.dailySummary?.totalMinutes || 0;
  const weekly = input.weeklySummary?.totalMinutes || 0;
  if (weekly > 0) {
    const avgDay = weekly / 7;
    if (daily > avgDay * 1.15) { velocityTrend = 'improving'; }
    else if (daily < avgDay * 0.7 && daily > 0) { velocityTrend = 'declining'; }
    else if (daily > 0 || weekly > 0) { velocityTrend = 'stable'; }
  }

  const insights: string[] = [];
  if (totalMinutes === 0) {
    insights.push('No time tracked yet. Commit on a Tyne branch or add manual time.');
  } else {
    if (locPerHour >= 150) { insights.push(`Fast coding pace (~${locPerHour} LOC/hour).`); }
    else if (locPerHour > 0 && locPerHour < 80) { insights.push(`Coding pace is deliberate (~${locPerHour} LOC/hour).`); }
    if (debuggingPercent >= 20) { insights.push('Debugging is a large share of time — try a self-review before push.'); }
    if (aiAssistanceRatio >= 30 && aiAssistanceRatio <= 70) { insights.push('Balanced Tyne AI assistance.'); }
    else if (validationRuns === 0) { insights.push('No Tyne AI reviews yet this period.'); }
    if (breakdown.review < 5 && breakdown.coding >= 30) {
      insights.push('Little self-review logged — a few minutes of proof-reading often cuts review cycles.');
    }
    if (breakdown.waiting >= 60) {
      insights.push(`~${Math.round(breakdown.waiting)}m waiting between sessions — reviews may be the bottleneck.`);
    }
    if (productivityScore >= 80) { insights.push('Productivity score is strong.'); }
  }

  timed = timed.sort((a, b) => stampMs(a.startTime) - stampMs(b.startTime));

  return {
    taskId: input.taskId,
    totalMinutes,
    timeBreakdown: breakdown,
    codeMetrics: {
      linesAdded,
      linesDeleted,
      filesChanged,
      commitCount,
      locPerHour,
      averageCommitSize,
    },
    aiUsed: {
      primaryModel,
      validationRuns,
      models,
      aiAssistanceRatio,
    },
    productivityScore,
    velocityTrend,
    insights: insights.slice(0, 4),
    trackingAccuracy: manuals.length > 0 && logs.length > 0 ? 'hybrid' : 'estimated',
    qualityScore: input.qualityScore,
    prTitle: input.taskTitle,
    repository: input.repositoryName,
    branchName: input.branchName,
    peakCodingHours,
    timeline: timed.slice(0, 40),
  };
}
