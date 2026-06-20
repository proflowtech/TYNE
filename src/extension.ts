import * as vscode from 'vscode';
import { TyneSidebarProvider } from './TyneSidebarProvider';

export async function getBYOKKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get('tyne.byokApiKey');
}

export async function setBYOKKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store('tyne.byokApiKey', key);
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
}

export function deactivate(): void {}
