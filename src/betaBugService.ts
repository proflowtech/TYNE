import * as vscode from 'vscode';
import { getEffectiveAuthToken } from './deviceAuth';

const DEFAULT_SUPABASE_URL = 'https://mvzcfqjtleasuawvvmtg.supabase.co';
const PATH = '/functions/v1/tyne-beta-bug';

export type BetaBugKind = 'bug' | 'confusing' | 'idea';

export interface BetaBugReportInput {
  kind: BetaBugKind;
  message: string;
  email?: string;
  githubUsername?: string;
  githubId?: string;
  page?: string;
  taskId?: string;
  taskTitle?: string;
}

export class BetaBugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BetaBugError';
  }
}

export async function submitBetaBugReport(
  context: vscode.ExtensionContext,
  input: BetaBugReportInput,
): Promise<{ id: string }> {
  const message = String(input.message || '').trim();
  if (message.length < 3) {
    throw new BetaBugError('Tell us a bit more about what went wrong.');
  }
  const email = String(input.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BetaBugError('Add your email so we can follow up.');
  }

  const token = await getEffectiveAuthToken(context);
  if (!token) {
    throw new BetaBugError('Sign in to send a beta bug report.');
  }

  const supabaseUrl = vscode.workspace.getConfiguration('tyne')
    .get<string>('supabaseUrl', DEFAULT_SUPABASE_URL)
    .replace(/\/+$/, '');

  const response = await fetch(`${supabaseUrl}${PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Machine-ID': vscode.env.machineId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: input.kind || 'bug',
      message,
      email,
      githubUsername: input.githubUsername,
      githubId: input.githubId,
      page: input.page,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      extensionVersion: context.extension.packageJSON?.version,
      vscodeVersion: vscode.version,
      os: `${process.platform} ${process.arch}`,
      clientMeta: {
        language: vscode.env.language,
        uiKind: String(vscode.env.uiKind),
        appName: vscode.env.appName,
      },
    }),
  });

  const data = await response.json().catch(() => null) as { id?: string; error?: string } | null;
  if (!response.ok || !data?.id) {
    throw new BetaBugError(data?.error || `Could not send report (${response.status})`);
  }
  return { id: data.id };
}
