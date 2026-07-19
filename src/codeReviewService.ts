import * as vscode from 'vscode';
import {
  TyneReviewContextPack,
  TyneCodeReviewResult,
  TyneCodeReviewResponse,
  TyneCodeReviewError,
  TyneCodeReviewRequest,
  compactReviewResultLimits,
  isReviewResult,
} from './codeReviewTypes';
import { getByokKeyService } from './byokKeyService';

export class CodeReviewService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async runCodeReview(contextPack: TyneReviewContextPack, githubToken: string): Promise<TyneCodeReviewResult> {
    const byokService = getByokKeyService(this.context);
    const hasByok = await byokService.hasApiKey();
    const selectedProvider = await byokService.getSelectedProvider();
    const byokProvider = selectedProvider || 'anthropic';
    const byokKey = hasByok ? await byokService.getApiKey(byokProvider) : undefined;

    const supabaseUrl = vscode.workspace.getConfiguration('tyne').get<string>('supabaseUrl', 'https://mvzcfqjtleasuawvvmtg.supabase.co');
    const functionUrl = `${supabaseUrl}/functions/v1/tyne-code-review`;

    const payload: TyneCodeReviewRequest = {
      context: contextPack,
      byokKey: byokKey || undefined,
      byokProvider,
    };

    const res = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as TyneCodeReviewResponse | TyneCodeReviewError;
    if (!res.ok) {
      const error = (data as TyneCodeReviewError).error || `Review request failed (${res.status})`;
      throw new CodeReviewError(error);
    }

    const result = (data as TyneCodeReviewResponse).result;
    if (!isReviewResult(result)) {
      throw new CodeReviewError('Invalid review response from server.');
    }

    const compact = compactReviewResultLimits(result);
    return {
      ...compact,
      id: `code_review_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      reviewMode: contextPack.reviewMode,
      currentBranch: contextPack.currentBranch,
      changedFiles: contextPack.git.changedFiles,
    };
  }
}

export class CodeReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeReviewError';
  }
}

export function getCodeReviewService(context: vscode.ExtensionContext): CodeReviewService {
  return new CodeReviewService(context);
}
