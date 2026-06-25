import { TyneAiProvider } from './validationTypes';

export interface SynthesizedCommit {
  subject: string;
  body: string;
  type: 'feat' | 'fix' | 'refactor' | 'chore' | 'docs' | 'test';
}

export function parseSynthesizedCommit(
  rawText: string,
  goal: string,
  taskId: string,
  completedSubtasks: string[],
): SynthesizedCommit {
  const scope = taskId ? `(${taskId.toLowerCase()})` : '';
  try {
    const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()) as Partial<SynthesizedCommit>;
    const type = normalizeType(parsed.type);
    const rawSubject = String(parsed.subject || goal).replace(/^(feat|fix|refactor|chore|docs|test)(\([^)]+\))?:\s*/i, '');
    return {
      type,
      subject: `${type}${scope}: ${rawSubject.slice(0, 96)}`,
      body: parsed.body || '',
    };
  } catch {
    return {
      type: 'feat',
      subject: `feat${scope}: ${goal.toLowerCase().slice(0, 96)}`,
      body: completedSubtasks.map(subtask => `- ${subtask}`).join('\n'),
    };
  }
}

function normalizeType(type: unknown): SynthesizedCommit['type'] {
  if (type === 'fix' || type === 'refactor' || type === 'chore' || type === 'docs' || type === 'test') {
    return type;
  }
  return 'feat';
}

export function buildCommitPrompt(
  goal: string,
  taskId: string,
  completedSubtasks: string[],
  diff: string,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = 'You are a Conventional Commit message generator.';
  const userPrompt = `Generate a conventional commit message for these code changes.

Goal: ${goal || 'Implement requested tasks'}
Task ID: ${taskId || 'none'}
Completed subtasks:
${completedSubtasks.map(s => `- ${s}`).join('\n') || '- none marked complete'}

File changes summary (git diff):
${diff || '(no diff available)'}

Respond ONLY with JSON in this exact format:
{
  "type": "feat" | "fix" | "refactor" | "chore" | "docs" | "test",
  "subject": "concise imperative subject line, max 72 chars",
  "body": "2-4 bullet points summarizing what changed and why"
}

Rules:
- Subject should be the text after the conventional commit prefix only.
- Subject must be specific, not generic.
- Body bullets must reflect actual changes.`;
  return { systemPrompt, userPrompt };
}

export async function callLlmForCommit(
  provider: TyneAiProvider,
  apiKey: string,
  goal: string,
  taskId: string,
  completedSubtasks: string[],
  diff: string,
): Promise<string> {
  const { systemPrompt, userPrompt } = buildCommitPrompt(goal, taskId, completedSubtasks, diff);

  if (provider === 'openai') {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenAI commit synthesis failed: ${errorText.slice(0, 200)}`);
    }
    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content || '';
  }

  // Anthropic (default)
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Anthropic commit synthesis failed: ${errorText.slice(0, 200)}`);
  }
  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.find(c => c.type === 'text')?.text || '';
}

export async function callManagedCommitSynthesis(
  githubToken: string,
  machineId: string,
  goal: string,
  taskId: string,
  subtasks: Array<{ text: string; done: boolean }>,
  diff: string,
): Promise<string> {
  const response = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'X-Machine-ID': machineId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      gitDiff: diff,
      goal,
      taskId,
      subtasks,
      feature: 'commit',
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `Edge Function failed (${response.status})` })) as { error?: string };
    throw new Error(errorData.error || `Failed to synthesize commit: HTTP ${response.status}`);
  }

  const { responseText } = await response.json() as { responseText: string };
  return responseText;
}
