import * as vscode from 'vscode';
import simpleGit from 'simple-git';

export interface ValidationResult {
  subtask: string;
  passed: boolean;
  reason: string;
}

export interface ValidationResponse {
  overall: 'pass' | 'fail' | 'partial';
  results: ValidationResult[];
  summary: string;
}

export async function validateGoal(
  goal: string,
  subtasks: Array<{ text: string; done: boolean }>,
  apiKey: string,
  provider: 'claude' | 'openai',
): Promise<ValidationResponse> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) { throw new Error('No workspace'); }
  const git = simpleGit(workspaceRoot);

  let diff: string;
  try {
    const stitchCount = await getStitchCount(git);
    diff = stitchCount > 0
      ? await git.diff([`HEAD~${stitchCount}`, 'HEAD'])
      : await git.diff();
    if (!diff) { diff = await git.diff(); }
  } catch {
    diff = await git.diff();
  }

  const truncatedDiff = diff.slice(0, 8000);
  const prompt = buildValidationPrompt(goal, subtasks, truncatedDiff);

  if (provider === 'claude') {
    return callClaude(apiKey, prompt);
  } else {
    return callOpenAI(apiKey, prompt);
  }
}

function buildValidationPrompt(
  goal: string,
  subtasks: Array<{ text: string; done: boolean }>,
  diff: string,
): string {
  const subtaskList = subtasks
    .map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`)
    .join('\n');
  return `You are a code review assistant. Analyze if the code changes complete the stated goal and subtasks.

GOAL: ${goal}

SUBTASKS:
${subtaskList}

CODE CHANGES (git diff):
\`\`\`
${diff || '(no committed changes yet)'}
\`\`\`

Respond ONLY with valid JSON in this exact format:
{
  "overall": "pass" | "fail" | "partial",
  "summary": "one sentence summary",
  "results": [
    { "subtask": "exact subtask text", "passed": true/false, "reason": "brief reason" }
  ]
}`;
}

async function callClaude(apiKey: string, prompt: string): Promise<ValidationResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  if (!response.ok) { throw new Error(data.error?.message || 'Claude API error'); }
  const text: string = data.content?.[0]?.text || '{}';
  return JSON.parse(text.replace(/```json|```/g, '').trim()) as ValidationResponse;
}

async function callOpenAI(apiKey: string, prompt: string): Promise<ValidationResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  if (!response.ok) { throw new Error(data.error?.message || 'OpenAI API error'); }
  return JSON.parse(data.choices[0].message.content) as ValidationResponse;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStitchCount(git: any): Promise<number> {
  const log = await git.log({ maxCount: 20 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return log.all.filter((c: any) => c.message.startsWith('🔗 Tyne stitch:')).length;
}
