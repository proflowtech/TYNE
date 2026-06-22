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
  githubToken: string,
  machineId: string,
  byokKey?: string,
  byokProvider?: 'claude' | 'openai',
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

  const response = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'X-Machine-ID': machineId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      gitDiff: truncatedDiff,
      goal,
      subtasks,
      feature: 'deep-review',
      byokKey,
      byokProvider
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `Edge Function failed (${response.status})` })) as { error?: string };
    throw new Error(errorData.error || `Validation failed: HTTP ${response.status}`);
  }

  const { responseText } = await response.json() as { responseText: string };
  return JSON.parse(responseText.replace(/```json|```/g, '').trim()) as ValidationResponse;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStitchCount(git: any): Promise<number> {
  const log = await git.log({ maxCount: 20 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return log.all.filter((c: any) => c.message.startsWith('🔗 Tyne stitch:')).length;
}
