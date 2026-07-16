/**
 * Direct BYOK for Validate & Review: VS Code → AI provider.
 * Backend never receives the API key (Phase 3).
 */
import type { TyneAiProvider } from '../validationTypes';

export interface DirectByokReviewInput {
  provider: TyneAiProvider;
  apiKey: string;
  diff: string;
  changedFiles?: Array<{ path?: string; status?: string; additions?: number; deletions?: number }>;
  pmTitle?: string;
  /** Optional precomputed local/security signals (titles only). */
  localHints?: string[];
}

const SYSTEM = `You are Tyne, a senior code reviewer. Review ONLY the provided diff.
Return STRICT JSON (no markdown fences) with:
status ("passed"|"needs_work"|"blocked"), score (0-100), riskLevel, vibeCodeRisk,
securityStatus, complianceStatus, confidence, summary, completedGoals[], pendingGoals[],
findings[{id,title,severity,category,file,line,rationale,suggestedFix}],
missingTests[], nextActions[], fullReport (markdown string).
Never invent file paths. Prefer high-confidence findings only.`;

function buildUserPrompt(input: DirectByokReviewInput): string {
  const files = (input.changedFiles || [])
    .map(f => `- ${f.path || 'unknown'} (${f.status || 'modified'}, +${f.additions || 0}/-${f.deletions || 0})`)
    .join('\n') || 'None';
  const hints = (input.localHints || []).slice(0, 12).map(h => `- ${h}`).join('\n');
  return [
    `PM task: ${input.pmTitle || 'none'}`,
    `Changed files:\n${files}`,
    hints ? `Local signals:\n${hints}` : '',
    `Diff:\n${(input.diff || '').slice(0, 48_000)}`,
  ].filter(Boolean).join('\n\n');
}

export async function runDirectByokReview(input: DirectByokReviewInput): Promise<{
  review: Record<string, unknown>;
  provider: string;
  model: string;
}> {
  const user = buildUserPrompt(input);
  if (input.provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const err = await response.text().catch(() => 'Unknown error');
      throw new Error(`Direct BYOK OpenAI review failed: ${err.slice(0, 200)}`);
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const text = data.choices?.[0]?.message?.content || '{}';
    return { review: parseJsonObject(text), provider: 'openai', model: 'gpt-4o-mini' };
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': input.apiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown error');
    throw new Error(`Direct BYOK Anthropic review failed: ${err.slice(0, 200)}`);
  }
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content?.find(c => c.type === 'text')?.text || '{}';
  return { review: parseJsonObject(text), provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {
    status: 'needs_work',
    score: 70,
    riskLevel: 'medium',
    vibeCodeRisk: 'low',
    summary: 'Direct BYOK review returned unparseable JSON.',
    completedGoals: [],
    pendingGoals: [],
    findings: [],
    missingTests: [],
    nextActions: [],
    fullReport: '## Tyne Review\n\nDirect BYOK response could not be parsed.',
  };
}
