import * as vscode from 'vscode';
import { TyneSidebarProvider } from './TyneSidebarProvider';
import { startGitHubDeviceFlow, pollGitHubDeviceToken, openGitHubDeviceUri } from './githubOAuth';
import { stopDriftDetection } from './driftDetector';
import { getByokKeyService } from './byokKeyService';
import { initializeTaskProviderRuntime } from './taskProviderRuntime';
import { registerJiraOAuthUriHandler } from './jiraOAuth';
import { registerLinearOAuthUriHandler } from './linearOAuth';
import { startGitCommitWatcher } from './gitCommitWatcher';
import { handleCommitDetected } from './taskAutomationService';
import { startCodeChangeWatcher } from './codeChangeWatcher';
import { registerReviewDiagnostics } from './reviewDiagnosticsService';
import { clearDeviceAuthTokens, getEffectiveAuthToken } from './deviceAuth';
import { scheduleOneShotValidateReminder } from './notifyWithActions';

const GITHUB_TOKEN_KEY = 'tyne_github_token';

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
  await clearDeviceAuthTokens(context);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeTaskProviderRuntime(context);
  const token = await getEffectiveAuthToken(context);
  const isAuthenticated = Boolean(token);
  const provider = new TyneSidebarProvider(context, isAuthenticated);

  // VS Code allows only ONE URI handler per extension — registering a second one
  // throws "Protocol handler already registered" and fails activation. Register a
  // single handler that delegates to both the Jira and Linear OAuth handlers; each
  // ignores URIs whose path it does not own, so one registration covers both flows.
  const jiraUriHandler = registerJiraOAuthUriHandler(context.extension.id);
  const linearUriHandler = registerLinearOAuthUriHandler(context.extension.id);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri): Promise<void> {
        await jiraUriHandler.handleUri(uri);
        await linearUriHandler.handleUri(uri);
      },
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tyneView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const commitWatcher = await startGitCommitWatcher(context, async (event) => {
    await handleCommitDetected(context, event);
  });
  context.subscriptions.push(commitWatcher);

  const codeChangeWatcher = startCodeChangeWatcher(context);
  context.subscriptions.push(codeChangeWatcher);
  registerReviewDiagnostics(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.focusSidebar', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.setBYOKKey', async () => {
      const provider = await vscode.window.showQuickPick(
        [
          { label: 'Anthropic (Claude)', value: 'anthropic' },
          { label: 'OpenAI (GPT)', value: 'openai' },
        ],
        { placeHolder: 'Select the AI provider for your API key' },
      );
      if (!provider) { return; }
      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider.label} API key`,
        password: true,
        placeHolder: provider.value === 'anthropic' ? 'sk-ant-...' : 'sk-...',
      });
      if (key) {
        const byokService = getByokKeyService(context);
        await byokService.saveApiKey(provider.value as 'anthropic' | 'openai', key);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.reconnectGitHub', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.reconnectGitHub();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.validateGoal', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.triggerValidation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.runCodeReview', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.triggerCodeReview();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.runValidateReview', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      // Execute Validate & Review (not navigation-only). Notification actions rely on this.
      await provider.triggerValidation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.connectJira', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.connectJira();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.disconnectJira', async () => {
      provider.disconnectJira();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.refreshJiraTasks', async () => {
      provider.refreshJiraTasks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.changeJiraProject', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.changeJiraProject();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.connectLinear', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.connectLinear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.disconnectLinear', async () => {
      provider.disconnectLinear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.refreshLinearTasks', async () => {
      provider.refreshLinearTasks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.changeLinearTeam', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.changeLinearTeam();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.tieTheKnot', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      await provider.triggerTieTheKnot();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.openLatestValidateReview', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.openLatestValidateReview();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.openSettingsPage', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      provider.openSettingsPage();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.undoLastFindingFix', async () => {
      await provider.undoLastFindingFix();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.scheduleValidateReminder', () => {
      scheduleOneShotValidateReminder();
      void vscode.window.showInformationMessage('Tyne will remind you to re-run Validate & Review in about 10 minutes.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.statusBarNextAction', async () => {
      await provider.runStatusBarNextAction();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tyne.startThread', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tyne-sidebar');
      await vscode.commands.executeCommand('tyneView.focus');
      await provider.triggerStartThread();
    })
  );
}

export function deactivate(): void {
  stopDriftDetection();
}
