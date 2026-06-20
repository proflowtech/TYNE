import * as vscode from 'vscode';
import { TyneSidebarProvider } from './TyneSidebarProvider';

export async function getBYOKKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get('tyne.byokApiKey');
}

export async function setBYOKKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store('tyne.byokApiKey', key);
}

export async function setGitHubToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  await context.secrets.store('tyne.githubToken', token);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TyneSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tyneView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.setBYOKKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Claude or OpenAI API key',
        password: true,
        placeHolder: 'sk-ant-... or sk-...',
      });
      if (key) {
        await setBYOKKey(context, key);
        vscode.window.showInformationMessage('API key saved securely ✓');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.setGitHubToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitHub Personal Access Token with repo scope',
        password: true,
        placeHolder: 'ghp_xxxx',
      });
      if (token) {
        await setGitHubToken(context, token);
        vscode.window.showInformationMessage(
          'GitHub token saved. PRs will auto-draft on Tie the Knot. ✓',
        );
      }
    })
  );
}

export function deactivate(): void {}
