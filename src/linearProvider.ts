import {
  TyneNormalizedTaskStatus,
  TyneTask,
  TyneTaskComment,
  TyneTaskDetails,
  TyneTaskHistoryEvent,
  TynePullTasksInput,
  TyneTaskProviderCapabilities,
  TyneCreateTaskInput,
  TyneUpdateTaskInput,
  TyneSubtask,
  TyneTaskProviderUpdateEvent,
} from './taskTypes';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

function getVscode(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

function getApiKey(): string | undefined {
  return getVscode().workspace.getConfiguration('tyne.linear').get<string>('apiKey');
}

async function linearFetch<T>(body: { query: string; variables?: Record<string, unknown> }): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) { throw new Error('Linear API key is not configured in settings.'); }
  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null;
  if (!response.ok || !payload || payload.errors?.length) {
    const message = payload?.errors?.[0]?.message || response.statusText || 'Linear API request failed';
    throw new Error(`Linear API error (${response.status}): ${message}`);
  }
  return payload.data as T;
}

export interface LinearIssueState {
  id: string;
  name: string;
  color: string;
  type: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { id: string; name: string };
  assignee?: { id: string; name: string };
  team?: { id: string; name: string; states: { nodes: LinearIssueState[] } };
}

export class LinearProvider {
  async isConnected(): Promise<boolean> {
    try {
      await linearFetch({ query: '{ viewer { id } }' });
      return true;
    } catch {
      return false;
    }
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    const id = issueId.replace(/^linear:/, '');
    const data = await linearFetch<{ issue: LinearIssue }>({
      query: `
        query GetIssue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            url
            state { id name }
            assignee { id name }
            team { id name states { nodes { id name color type } } }
          }
        }
      `,
      variables: { id },
    });
    if (!data.issue) { throw new Error(`Linear issue ${id} not found.`); }
    return data.issue;
  }

  async findDoneStateId(issue: LinearIssue): Promise<string> {
    const states = issue.team?.states?.nodes || [];
    const done = states.find(s => /done|complete|closed/i.test(s.name));
    if (done) { return done.id; }
    throw new Error(`No Done state found in Linear team ${issue.team?.name || 'unknown'}.`);
  }

  async updateIssueStatus(issueId: string, stateId: string): Promise<{ id: string; stateName: string }> {
    const id = issueId.replace(/^linear:/, '');
    const data = await linearFetch<{ issueUpdate: { success: boolean; issue: { id: string; state: { name: string } } } }>({
      query: `
        mutation UpdateIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, stateId: $stateId) {
            success
            issue { id state { name } }
          }
        }
      `,
      variables: { id, stateId },
    });
    if (!data.issueUpdate?.success) { throw new Error('Linear issueUpdate mutation failed.'); }
    return { id: data.issueUpdate.issue.id, stateName: data.issueUpdate.issue.state.name };
  }

  async addComment(issueId: string, body: string): Promise<{ id: string }> {
    const id = issueId.replace(/^linear:/, '');
    const data = await linearFetch<{ commentCreate: { success: boolean; comment: { id: string } } }>({
      query: `
        mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(issueId: $issueId, body: $body) {
            success
            comment { id }
          }
        }
      `,
      variables: { issueId: id, body },
    });
    if (!data.commentCreate?.success) { throw new Error('Linear commentCreate mutation failed.'); }
    return { id: data.commentCreate.comment.id };
  }

  async pullTasks(_input: TynePullTasksInput): Promise<TyneTask[]> { return []; }
  async getTaskDetails(_taskId: string): Promise<TyneTaskDetails> { throw new Error('Not implemented'); }
  async getTaskComments(_taskId: string): Promise<TyneTaskComment[]> { return []; }
  async getTaskHistoryLast30Days(_taskId: string): Promise<TyneTaskHistoryEvent[]> { return []; }
  async getCapabilities(): Promise<TyneTaskProviderCapabilities> { throw new Error('Not implemented'); }
  async createTask(_input: TyneCreateTaskInput): Promise<TyneTaskDetails> { throw new Error('Not implemented'); }
  async updateTask(_taskId: string, _input: TyneUpdateTaskInput): Promise<TyneTaskDetails> { throw new Error('Not implemented'); }
  async addSubtask(_taskId: string, _input: { title: string }): Promise<TyneSubtask> { throw new Error('Not implemented'); }
  async updateSubtask(_taskId: string, _subtaskId: string, _input: Partial<TyneSubtask>): Promise<TyneSubtask> { throw new Error('Not implemented'); }
  async subscribeToTaskUpdates(_callback: (e: TyneTaskProviderUpdateEvent) => void): Promise<() => void> { return () => undefined; }
}
