import * as vscode from 'vscode';
import { TyneSidebarProvider } from './TyneSidebarProvider';
import { startGitHubDeviceFlow, pollGitHubDeviceToken, openGitHubDeviceUri } from './githubOAuth';
import { stopDriftDetection } from './driftDetector';

const GITHUB_TOKEN_KEY = 'tyne_github_token';

export async function getBYOKKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get('tyne.byokApiKey');
}

export async function setBYOKKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store('tyne.byokApiKey', key);
}

export async function connectGitHub(context: vscode.ExtensionContext): Promise<string | undefined> {
  const clientId = vscode.workspace.getConfiguration('tyne').get<string>('githubClientId', '');
  if (!clientId) {
    vscode.window.showErrorMessage(
      'No GitHub Client ID configured. Set tyne.githubClientId in settings.',
    );
    return undefined;
  }

  const flow = await startGitHubDeviceFlow(clientId);
  openGitHubDeviceUri(flow.verificationUri);

  const progressOptions = {
    location: vscode.ProgressLocation.Notification,
    title: `GitHub: enter code ${flow.userCode}`,
    cancellable: true,
  };

  const result = await vscode.window.withProgress(progressOptions, async (progress, tokenSource) => {
    progress.report({ message: 'Waiting for authorization...' });
    const controller = new AbortController();
    tokenSource.onCancellationRequested(() => controller.abort());

    return await pollGitHubDeviceToken(
      clientId,
      flow.deviceCode,
      flow.interval,
      context,
      controller.signal,
    );
  });

  vscode.window.showInformationMessage('GitHub connected ✓');
  return result.accessToken;
}

export async function logout(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(GITHUB_TOKEN_KEY);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const token = await context.secrets.get(GITHUB_TOKEN_KEY);
  const isAuthenticated = Boolean(token);
  const provider = new TyneSidebarProvider(context, isAuthenticated);

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
    vscode.commands.registerCommand('tyne.connectGitHub', async () => {
      const token = await connectGitHub(context);
      if (token) {
        await provider.updateAuthenticationState(true);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.logout', async () => {
      await logout(context);
      await provider.updateAuthenticationState(false);
      vscode.window.showInformationMessage('Tyne: Logged out.');
    })
  );
}

export function deactivate(): void {
  stopDriftDetection();
}
