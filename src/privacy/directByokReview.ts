/**
 * Direct BYOK for Validate & Review: VS Code → AI provider.
 * Backend never receives the API key (Phase 3).
 *
 * Must score the diff against the PM Golden Contract — never a free-floating
 * "code quality of this repo" review. Title-only prompts caused that regression.
 */
import type { TyneAiProvider } from '../validationTypes';
import { compileGoldenContract } from '../scopeDriftHarness';

export interface DirectByokPmTask {
  source?: string;
  issueIdentifier?: string;
  title?: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  subtasks?: Array<{ title: string; status?: string }>;
  decisions?: string[];
  constraints?: string[];
  blockers?: string[];
  openQuestions?: string[];
  developerTaskPlan?: {
    implementationTasks?: Array<{ title: string; status: string }>;
  };
}

export interface DirectByokReviewInput {
  provider: TyneAiProvider;
  apiKey: string;
  diff: string;
  changedFiles?: Array<{ path?: string; status?: string; additions?: number; deletions?: number }>;
  /** Full PM task — required for task-bound validation. */
  pmTask?: DirectByokPmTask | null;
  /** @deprecated use pmTask */
  pmTitle?: string;
  /** Optional precomputed local/security signals (titles only). */
  localHints?: string[];
}

const SYSTEM = `You are Tyne, a senior engineer validating a code diff against a PM task (Golden Contract).
Primary job: decide whether the DIFF satisfies the linked ticket — acceptance criteria, goal, and constraints.
Do NOT review the repository as a generic code-quality pass. Ignore unrelated modules/files.
Return STRICT JSON (no markdown fences) with:
status ("passed"|"needs_work"|"blocked"), score (0-100), riskLevel, vibeCodeRisk,
securityStatus, complianceStatus, confidence, summary, completedGoals[], pendingGoals[],
findings[{id,title,severity,category,file,line,rationale,suggestedFix}],
missingTests[], nextActions[], fullReport (markdown string).
Rules:
- completedGoals / pendingGoals MUST map to acceptance criteria or explicit ticket goals.
- findings category "pm_alignment" for unmet criteria / scope drift; use other categories only for issues in the changed diff that block the ticket.
- Never invent file paths. Prefer high-confidence findings only.
- If no Golden Contract is provided, set completedGoals/pendingGoals empty and say the review lacked a linked PM task.`;

function buildUserPrompt(input: DirectByokReviewInput): string {
  const files = (input.changedFiles || [])
    .map(f => `- ${f.path || 'unknown'} (${f.status || 'modified'}, +${f.additions || 0}/-${f.deletions || 0})`)
    .join('\n') || 'None';
  const hints = (input.localHints || []).slice(0, 12).map(h => `- ${h}`).join('\n');
  const pm = input.pmTask || (input.pmTitle ? { title: input.pmTitle } : null);
  const golden = compileGoldenContract(pm as Record<string, unknown> | null);
  const decisions = (pm?.decisions || []).map(d => `- ${d}`).join('\n') || 'None';
  const constraints = (pm?.constraints || []).map(c => `- ${c}`).join('\n') || 'None';
  const blockers = (pm?.blockers || []).map(b => `- ${b}`).join('\n') || 'None';
  const openQuestions = (pm?.openQuestions || []).map(q => `- ${q}`).join('\n') || 'None';

  return [
    golden
      ? `PM Task Context (Golden Contract — immutable; score the DIFF against this):\n<linear_ticket>\n${golden}\n\nLatest decisions:\n${decisions}\n\nConstraints:\n${constraints}\n\nBlockers:\n${blockers}\n\nOpen questions:\n${openQuestions}\n</linear_ticket>`
      : 'PM Task Context: NONE — no linked Jira/Linear task. Do not invent requirements.',
    `Changed files (validate only these against the ticket):\n${files}`,
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

/** Exported for tests — confirms Golden Contract lands in the BYOK user prompt. */
export function buildDirectByokUserPromptForTest(input: DirectByokReviewInput): string {
  return buildUserPrompt(input);
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
