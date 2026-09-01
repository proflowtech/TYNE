import simpleGit from 'simple-git';
import * as vscode from 'vscode';
import { getByokKeyService } from './byokKeyService';
import { callLlmForCommit, callManagedCommitSynthesis, parseSynthesizedCommit, SynthesizedCommit } from './commitSynthesisUtils';

export { SynthesizedCommit } from './commitSynthesisUtils';

export async function synthesizeCommitMessage(
  context: vscode.ExtensionContext,
  goal: string,
  taskId: string,
  subtasks: Array<{ text: string; done: boolean }>,
  opts?: { allowByok?: boolean },
): Promise<SynthesizedCommit> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error('No workspace'); }

  const git = simpleGit(workspaceRoot);
  const diff = await getSafeDiff(git);
  const completedSubtasks = subtasks.filter(subtask => subtask.done).map(subtask => subtask.text);

  const byokService = getByokKeyService(context);
  const selectedProvider = await byokService.getSelectedProvider();
  const apiKey = selectedProvider ? await byokService.getApiKey(selectedProvider) : null;

  if (selectedProvider && apiKey && opts?.allowByok !== false) {
    const responseText = await callLlmForCommit(
      selectedProvider,
      apiKey,
      goal,
      taskId,
      completedSubtasks,
      diff,
    );
    return parseSynthesizedCommit(responseText, goal, taskId, completedSubtasks);
  }

  // No BYOK configured: fall back to managed backend synthesis.
  const githubToken = await context.secrets.get('tyne_github_token');
  if (!githubToken) {
    throw new Error('GitHub is not connected and no BYOK key is configured.');
  }
  const machineId = vscode.env.machineId;
  const responseText = await callManagedCommitSynthesis(githubToken, machineId, goal, taskId, subtasks, diff);
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
