import simpleGit from 'simple-git';
import * as vscode from 'vscode';

export interface SynthesizedCommit {
  subject: string;
  body: string;
  type: 'feat' | 'fix' | 'refactor' | 'chore' | 'docs' | 'test';
}

export async function synthesizeCommitMessage(
  goal: string,
  taskId: string,
  subtasks: Array<{ text: string; done: boolean }>,
  githubToken: string,
  machineId: string,
  byokKey?: string,
  byokProvider?: string,
): Promise<SynthesizedCommit> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error('No workspace'); }

  const git = simpleGit(workspaceRoot);
  const diff = await getSafeDiff(git);

  const response = await fetch('https://mvzcfqjtleasuawvvmtg.supabase.co/functions/v1/generate-commit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${githubToken}`,
      'X-Machine-ID': machineId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      gitDiff: diff,
      goal,
      taskId,
      subtasks,
      feature: 'commit',
      byokKey,
      byokProvider
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `Edge Function failed (${response.status})` })) as { error?: string };
    throw new Error(errorData.error || `Failed to synthesize commit: HTTP ${response.status}`);
  }

  const { responseText } = await response.json() as { responseText: string };
  const completedSubtasks = subtasks.filter(subtask => subtask.done).map(subtask => subtask.text);
  return parseSynthesizedCommit(responseText, goal, taskId, completedSubtasks);
}

async function getSafeDiff(git: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const log = await git.log({ maxCount: 20 });
    const stitchCount = log.all.filter(commit => commit.message.startsWith('🔗 Tyne stitch:')).length;
    if (stitchCount > 0) {
      return await git.diff([`HEAD~${stitchCount}`, 'HEAD', '--stat']);
    }
  } catch {
    // Fall back to working tree diff below.
  }

  try {
    return await git.diff(['--stat']);
  } catch {
    return '';
  }
}

function parseSynthesizedCommit(
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
