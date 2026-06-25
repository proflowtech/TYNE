import { TyneAiProvider, TyneRiskLevel, TyneValidationInput, TyneValidationResult, TyneValidationStatus } from '../validationTypes';

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export function buildValidationPrompt(input: TyneValidationInput): string {
  const tierNote = input.tier === 'free'
    ? 'Provide a concise validation. Only include status, summary, matchPercent, and optional filesReviewed. Do not include detailedExplanation, riskLevel, missingRequirements, suggestions, or codeQualityNotes.'
    : 'Provide an enhanced validation including riskLevel, matchPercent, detailedExplanation, missingRequirements, suggestions, codeQualityNotes, and filesReviewed.';

  return `You are a senior code reviewer. Validate whether the code changes below satisfy the task goal and requirements.

${tierNote}

Return strictly JSON with this shape:
{
  "status": "pass" | "partial" | "fail",
  "matchPercent": 0-100 number,
  "riskLevel": "low" | "medium" | "high" | "not_assessed",
  "summary": "one sentence result",
  "detailedExplanation": "string or omitted",
  "missingRequirements": ["string"] or omitted,
  "suggestions": ["string"] or omitted,
  "codeQualityNotes": ["string"] or omitted,
  "filesReviewed": ["string"] or omitted
}

Task: ${input.taskTitle || input.taskId || 'N/A'}
Task ID: ${input.taskId || 'N/A'}
Branch: ${input.branchName || 'N/A'}
Commit: ${input.commitHash || 'N/A'}

Description:
${input.taskDescription || input.goal || 'No task description provided.'}

Goal:
${input.goal || 'No goal provided.'}

Subtasks:
${(input.subtasks || []).map(s => `- ${s}`).join('\n') || 'None'}

Acceptance Criteria:
${(input.acceptanceCriteria || []).map(s => `- ${s}`).join('\n') || 'None'}

Changed Files:
${input.changedFiles.join('\n') || 'None'}

Git Diff:
\`\`\`
${truncateDiff(input.diffText, 120000)}
\`\`\`

Respond with only the JSON object. Do not wrap it in markdown code fences.`;
}

export function parseValidationResponse(
  text: string,
  input: TyneValidationInput,
  provider: TyneAiProvider,
): TyneValidationResult {
  const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Validation failed because the AI provider returned an invalid response.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Validation failed because the AI provider returned an invalid response.');
  }
  const data = parsed as Record<string, unknown>;

  const status = parseStatus(data.status);
  const matchPercent = parseNumber(data.matchPercent);
  const riskLevel = parseRiskLevel(data.riskLevel);
  const summary = typeof data.summary === 'string' && data.summary.trim()
    ? data.summary.trim()
    : defaultSummary(status);

  const result: TyneValidationResult = {
    id: generateId(),
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    branchName: input.branchName,
    commitHash: input.commitHash,
    provider,
    tier: input.tier,
    status,
    matchPercent,
    riskLevel,
    summary,
    createdAt: new Date().toISOString(),
  };

  if (typeof data.detailedExplanation === 'string' && data.detailedExplanation.trim()) {
    result.detailedExplanation = data.detailedExplanation.trim();
  }
  if (Array.isArray(data.missingRequirements)) {
    result.missingRequirements = data.missingRequirements.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(data.suggestions)) {
    result.suggestions = data.suggestions.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(data.codeQualityNotes)) {
    result.codeQualityNotes = data.codeQualityNotes.filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(data.filesReviewed)) {
    result.filesReviewed = data.filesReviewed.filter((s): s is string => typeof s === 'string');
  } else if (input.changedFiles.length) {
    result.filesReviewed = input.changedFiles;
  }

  return result;
}

function parseStatus(value: unknown): TyneValidationStatus {
  const s = typeof value === 'string' ? value.toLowerCase() : '';
  if (s === 'pass' || s === 'partial' || s === 'fail') { return s; }
  return 'partial';
}

function parseRiskLevel(value: unknown): TyneRiskLevel | undefined {
  const r = typeof value === 'string' ? value.toLowerCase() : '';
  if (r === 'low' || r === 'medium' || r === 'high') { return r; }
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) { return undefined; }
  return Math.max(0, Math.min(100, Math.round(n)));
}

function defaultSummary(status: TyneValidationStatus): string {
  switch (status) {
    case 'pass': return 'Code matches the goal.';
    case 'fail': return 'Code does not match the goal.';
    default: return 'Code partially matches the goal.';
  }
}

function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) { return diff; }
  return diff.slice(0, maxChars) + '\n\n... [diff truncated] ...';
}
