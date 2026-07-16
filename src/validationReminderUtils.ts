/**
 * Pure helpers for Validate & Review reminder coordination (no vscode import).
 */

export type ReminderReason = 'large_edit' | 'syntax_error' | 'long_session';

export interface ReminderConfig {
  enabled: boolean;
  lineThreshold: number;
  cooldownMinutes: number;
  sessionMinutes: number;
}

export const DEFAULT_LINE_THRESHOLD = 50;
export const DEFAULT_COOLDOWN_MINUTES = 20;
export const DEFAULT_SESSION_MINUTES = 45;
export const ACTIVE_EDIT_WINDOW_MS = 5 * 60_000;

export function countAddedLines(
  changes: ReadonlyArray<{ text: string; rangeEmpty: boolean; rangeLineSpan: number }>,
): number {
  return changes.reduce((sum, change) => {
    const newLines = change.text.split(/\r?\n/).length;
    const oldLines = change.rangeEmpty ? 1 : change.rangeLineSpan;
    return sum + Math.max(0, newLines - oldLines);
  }, 0);
}

export function isCooldownActive(
  lastPromptAt: number | undefined,
  now: number,
  cooldownMinutes: number,
): boolean {
  if (!lastPromptAt) return false;
  return now - lastPromptAt < Math.max(5, cooldownMinutes) * 60_000;
}

export function shouldPromptLongSession(input: {
  sessionStartedAt: number;
  lastEditAt: number;
  now: number;
  sessionMinutes: number;
}): boolean {
  const sessionMs = Math.max(10, input.sessionMinutes) * 60_000;
  if (input.now - input.sessionStartedAt < sessionMs) return false;
  return input.now - input.lastEditAt <= ACTIVE_EDIT_WINDOW_MS;
}

export function isCountableError(
  diagnostic: { severity: number; source?: string },
  errorSeverity: number,
): boolean {
  return diagnostic.severity === errorSeverity
    && String(diagnostic.source || '').toLowerCase() !== 'tyne';
}

export function countWorkspaceErrors(
  entries: ReadonlyArray<{
    scheme: string;
    diagnostics: ReadonlyArray<{ severity: number; source?: string }>;
  }>,
  errorSeverity: number,
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.scheme !== 'file') continue;
    for (const d of entry.diagnostics) {
      if (isCountableError(d, errorSeverity)) total += 1;
    }
  }
  return total;
}

export function normalizeReminderConfig(raw: {
  enabled?: boolean;
  lineThreshold?: number;
  cooldownMinutes?: number;
  sessionMinutes?: number;
}): ReminderConfig {
  const line = typeof raw.lineThreshold === 'number' ? raw.lineThreshold : DEFAULT_LINE_THRESHOLD;
  const cooldown = typeof raw.cooldownMinutes === 'number' ? raw.cooldownMinutes : DEFAULT_COOLDOWN_MINUTES;
  const session = typeof raw.sessionMinutes === 'number' ? raw.sessionMinutes : DEFAULT_SESSION_MINUTES;
  return {
    enabled: raw.enabled !== false,
    lineThreshold: Math.max(1, line),
    cooldownMinutes: Math.max(5, cooldown),
    sessionMinutes: Math.max(10, session),
  };
}
