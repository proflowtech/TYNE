import * as vscode from 'vscode';
import * as path from 'path';
import { getGit, getCurrentBranch } from './gitManager';
import { collectCodebaseContext } from './codebaseContextService';
import {
  TyneReviewContextPack,
  TyneReviewMode,
  TyneReviewPmTask,
  TyneReviewRelevantFile,
  TyneReviewExistingTest,
} from './codeReviewTypes';
import { TynePmTaskIntelligence } from './taskTypes';
import { getByokKeyService } from './byokKeyService';

const IGNORE_PATHS = /\/(node_modules|dist|build|out|\.next|coverage|\.git)\//;

export interface CollectReviewContextInput {
  mode: TyneReviewMode;
  pmTaskIntelligence?: TynePmTaskIntelligence;
  baseBranch?: string;
}

export async function collectReviewContext(
  context: vscode.ExtensionContext,
  input: CollectReviewContextInput,
): Promise<TyneReviewContextPack | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }

  const git = getGit();
  if (!git) { return undefined; }

  const workspaceRoot = folder.uri.fsPath;
  const repositoryName = folder.name;
  const currentBranch = await getCurrentBranch().catch(() => '');
  const status = await git.status();
  let changedFiles = status.files.map(f => f.path.replace(/\\/g, '/'));

  const baseBranch = input.baseBranch || 'main';
  const wantStaged = input.mode === 'staged_changes' || input.mode === 'before_commit' || input.mode === 'before_pr';
  const wantBranch = input.mode === 'current_branch' || input.mode === 'pm_task' || input.mode === 'before_pr';

  const stagedDiffRaw = wantStaged ? await git.diff(['--cached']).catch(() => '') : '';
  const branchDiffRaw = wantBranch ? await git.diff([baseBranch, '--']).catch(() => '') : '';

  let stagedDiff = stagedDiffRaw;
  let branchDiff = branchDiffRaw;

  if (!stagedDiff && !branchDiff) {
    const unstagedDiff = await git.diff().catch(() => '');
    if (unstagedDiff) {
      if (wantStaged) {
        stagedDiff = unstagedDiff;
      } else if (wantBranch) {
        branchDiff = unstagedDiff;
      } else {
        stagedDiff = unstagedDiff;
      }
    } else {
      const committedDiff = await git.diff([baseBranch, '--']).catch(() => '');
      if (committedDiff) {
        branchDiff = committedDiff;
      }
    }
  }

  if (changedFiles.length === 0 && branchDiff) {
    const nameOnly = await git.diff([baseBranch, '--name-only']).catch(() => '');
    if (nameOnly) {
      changedFiles = nameOnly.split('\n').map(p => p.replace(/\\/g, '/').trim()).filter(Boolean);
    }
  }

  const codebaseContext = await collectCodebaseContext({
    issueTitle: input.pmTaskIntelligence?.goal,
    issueDescription: input.pmTaskIntelligence?.codebaseContext?.diff,
    acceptanceCriteria: input.pmTaskIntelligence?.acceptanceCriteria,
    subtasks: input.pmTaskIntelligence?.subtasks,
    validationSteps: input.pmTaskIntelligence?.validationSteps,
    changedFiles,
    diffText: stagedDiff || branchDiff,
  });

  const projectHints = codebaseContext?.projectHints || {};
  const relevantFiles: TyneReviewRelevantFile[] = (codebaseContext?.relevantFiles || []).map(f => ({
    path: f.path,
    reason: f.reason,
    snippet: f.snippet,
  }));
  const existingTests: TyneReviewExistingTest[] = (codebaseContext?.existingTests || []).map(f => ({
    path: f.path,
    reason: f.reason,
  }));

  const pmTask: TyneReviewPmTask | undefined = input.pmTaskIntelligence
    ? {
        source: input.pmTaskIntelligence.source,
        issueId: input.pmTaskIntelligence.issueId,
        issueIdentifier: input.pmTaskIntelligence.issueIdentifier || input.pmTaskIntelligence.issueKey,
        title: input.pmTaskIntelligence.goal || input.pmTaskIntelligence.issueIdentifier || 'Untitled task',
        description: input.pmTaskIntelligence.codebaseContext?.diff,
        acceptanceCriteria: input.pmTaskIntelligence.acceptanceCriteria,
        subtasks: input.pmTaskIntelligence.subtasks,
        developerTaskPlan: input.pmTaskIntelligence.developerTaskPlan,
      }
    : undefined;

  const guardrails = await loadGuardrails(workspaceRoot, context);

  return {
    repositoryName,
    currentBranch,
    reviewMode: input.mode,
    projectHints,
    git: {
      changedFiles: changedFiles.filter(p => !IGNORE_PATHS.test('/' + p)),
      stagedDiff: truncateDiff(stagedDiff),
      branchDiff: truncateDiff(branchDiff),
    },
    pmTask,
    relevantFiles,
    existingTests,
    guardrails,
  };
}

async function loadGuardrails(workspaceRoot: string, context: vscode.ExtensionContext): Promise<TyneReviewContextPack['guardrails']> {
  const byokService = getByokKeyService(context);
  const requireTests = vscode.workspace.getConfiguration('tyne').get<boolean>('codeReview.requireTests', false);
  const allowedCommitTypes = vscode.workspace.getConfiguration('tyne').get<string[]>('codeReview.allowedCommitTypes', ['feat', 'fix', 'refactor', 'chore', 'docs', 'test']);
  const customRules: string[] = [];

  const rulesPath = path.join(workspaceRoot, '.tyne', 'review-rules.md');
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(rulesPath))).toString('utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    customRules.push(...lines.slice(0, 10));
  } catch {
    // No custom rules file is fine.
  }

  return {
    requireTests,
    allowedCommitTypes,
    customRules: customRules.length ? customRules : undefined,
  };
}

function truncateDiff(diff: string | undefined, max = 25_000): string | undefined {
  if (!diff) { return undefined; }
  return diff.length > max ? `${diff.slice(0, max)}\n... [truncated] ...` : diff;
}
