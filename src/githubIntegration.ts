import simpleGit from 'simple-git';
import * as vscode from 'vscode';

const GITHUB_API = 'https://api.github.com';

export interface PRResult {
  url: string;
  number: number;
  title: string;
}

interface GitHubRepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
}

interface GitHubErrorResponse {
  message?: string;
}

interface GitHubPullResponse {
  html_url: string;
  number: number;
  title: string;
}

interface GitHubRepoResponse {
  default_branch?: string;
}

export async function createDraftPR(
  token: string,
  goal: string,
  taskId: string,
  subtasks: Array<{ text: string; done: boolean }>,
  branchName: string,
): Promise<PRResult | null> {
  const { owner, repo, defaultBranch } = await getRepoInfo(token);
  if (!owner || !repo) { return null; }

  const title = taskId ? `[${taskId}] ${goal}` : goal;
  const completedSubtasks = subtasks.filter(s => s.done);
  const pendingSubtasks = subtasks.filter(s => !s.done);
  const body = buildPRBody(goal, taskId, completedSubtasks, pendingSubtasks);

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title,
      body,
      head: branchName,
      base: defaultBranch,
      draft: true,
    }),
  });

  if (!res.ok) {
    const err = await readGitHubError(res);
    throw new Error(err.message || 'GitHub API error');
  }

  const pr = await res.json() as GitHubPullResponse;
  return { url: pr.html_url, number: pr.number, title: pr.title };
}

function buildPRBody(
  goal: string,
  taskId: string,
  completed: Array<{ text: string }>,
  pending: Array<{ text: string }>,
): string {
  let body = `## ${goal}\n\n`;

  if (taskId) {
    body += `**Task:** ${taskId}\n\n`;
  }

  if (completed.length > 0) {
    body += '## Completed\n\n';
    completed.forEach(s => { body += `- [x] ${s.text}\n`; });
    body += '\n';
  }

  if (pending.length > 0) {
    body += '## Remaining\n\n';
    pending.forEach(s => { body += `- [ ] ${s.text}\n`; });
    body += '\n';
  }

  body += '---\n*Created by [Tyne](https://tyne.dev) - goal-enforcement for vibe coding.*\n';
  return body;
}

async function getRepoInfo(token: string): Promise<GitHubRepoInfo> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error('No workspace'); }

  const git = simpleGit(workspaceRoot);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find(r => r.name === 'origin');
  if (!origin?.refs.fetch) { throw new Error('No origin remote found'); }

  const parsed = parseGitHubRemote(origin.refs.fetch);
  if (!parsed) {
    throw new Error('Could not parse GitHub URL from remote: ' + origin.refs.fetch);
  }

  const repoRes = await fetch(`${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!repoRes.ok) {
    const err = await readGitHubError(repoRes);
    throw new Error(err.message || 'Could not read GitHub repository');
  }

  const repoData = await repoRes.json() as GitHubRepoResponse;
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    defaultBranch: repoData.default_branch || 'main',
  };
}

function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) { return null; }

  return {
    owner: match[1],
    repo: match[2],
  };
}

async function readGitHubError(res: Response): Promise<GitHubErrorResponse> {
  try {
    return await res.json() as GitHubErrorResponse;
  } catch {
    return { message: `GitHub API error (${res.status})` };
  }
}
