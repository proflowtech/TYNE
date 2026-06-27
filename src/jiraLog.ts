import * as vscode from 'vscode';

let jiraOutputChannel: vscode.OutputChannel | undefined;

export function getJiraOutputChannel(): vscode.OutputChannel {
  if (!jiraOutputChannel) {
    jiraOutputChannel = vscode.window.createOutputChannel('Tyne: Jira');
  }
  return jiraOutputChannel;
}

export function logJira(message: string): void {
  getJiraOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}
