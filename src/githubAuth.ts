import * as vscode from 'vscode';

export { GitHubTokenInvalidError, isInvalidGitHubTokenResponse } from './githubAuthUtils';

let githubOutputChannel: vscode.OutputChannel | undefined;

export function getGitHubOutputChannel(): vscode.OutputChannel {
  if (!githubOutputChannel) {
    githubOutputChannel = vscode.window.createOutputChannel('Tyne: GitHub');
  }
  return githubOutputChannel;
}

// Safe logger: never pass tokens, headers, or secrets into `message`.
export function logGitHub(message: string): void {
  getGitHubOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}
