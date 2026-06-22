import simpleGit from 'simple-git';
import * as vscode from 'vscode';

export interface WorkspacePrepResult {
  pulled: boolean;
  stashed: boolean;
  stashMessage?: string;
  pullSummary?: string;
  clean: boolean;
}

export async function prepareWorkspace(): Promise<WorkspacePrepResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error('No workspace open'); }

  const git = simpleGit(workspaceRoot);
  const defaultBranch = vscode.workspace.getConfiguration('tyne').get<string>('defaultBranch', 'main');
  const result: WorkspacePrepResult = { pulled: false, stashed: false, clean: false };

  const status = await git.status();
  if (status.files.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Workspace has ${status.files.length} uncommitted change(s). Stash them before pulling?`,
      'Stash & Continue',
      'Ignore & Continue',
      'Cancel',
    );

    if (!choice || choice === 'Cancel') {
      throw new Error('User cancelled workspace prep');
    }

    if (choice === 'Stash & Continue') {
      const stashMessage = `Tyne auto-stash before thread ${new Date().toISOString().slice(0, 19)}`;
      await git.stash(['push', '-m', stashMessage]);
      result.stashed = true;
      result.stashMessage = stashMessage;
    }
  }

  try {
    const remotes = await git.getRemotes(true);
    if (remotes.some(remote => remote.name === 'origin')) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Tyne: Pulling latest...' },
        async () => {
          const pullResult = await git.pull('origin', defaultBranch, { '--rebase': 'false' });
          result.pullSummary = pullResult.summary.changes > 0
            ? `Pulled ${pullResult.summary.changes} change(s) from origin/${defaultBranch}`
            : `Already up to date with origin/${defaultBranch}`;
          result.pulled = true;
        },
      );
    } else {
      result.pullSummary = 'No remote to pull from';
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.pullSummary = 'Pull skipped';
    vscode.window.showWarningMessage(`Could not pull from remote: ${message}. Continuing with local state.`);
  }

  const freshStatus = await git.status();
  result.clean = freshStatus.files.length === 0;
  return result;
}
