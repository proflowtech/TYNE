const ASANA_API_URL = 'https://app.asana.com/api/1.0';

function getVscode(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

function getApiKey(): string | undefined {
  return getVscode().workspace.getConfiguration('tyne.asana').get<string>('apiKey');
}

async function asanaFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) { throw new Error('Asana API key is not configured in settings.'); }
  const response = await fetch(`${ASANA_API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null) as { data?: T; errors?: Array<{ message: string }> } | null;
  if (!response.ok || !payload || payload.errors?.length) {
    const message = payload?.errors?.[0]?.message || response.statusText || 'Asana API request failed';
    throw new Error(`Asana API error (${response.status}): ${message}`);
  }
  return payload.data as T;
}

export interface AsanaTask {
  gid: string;
  name: string;
  completed: boolean;
  permalink_url?: string;
  assignee?: { gid: string; name: string };
  workspace?: { gid: string; name: string };
  projects?: Array<{ gid: string; name: string }>;
}

export interface AsanaStory {
  gid: string;
  text: string;
}

export class AsanaProvider {
  async isConnected(): Promise<boolean> {
    try {
      await asanaFetch<{ gid: string }>('/users/me', { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  async getTask(taskId: string): Promise<AsanaTask> {
    const gid = taskId.replace(/^asana:/, '');
    return asanaFetch<AsanaTask>(`/tasks/${gid}?opt_fields=gid,name,completed,permalink_url,assignee,workspace,projects`);
  }

  async updateTaskCompleted(taskId: string, completed: boolean): Promise<AsanaTask> {
    const gid = taskId.replace(/^asana:/, '');
    return asanaFetch<AsanaTask>(`/tasks/${gid}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { completed } }),
    });
  }

  async addTaskComment(taskId: string, text: string): Promise<AsanaStory> {
    const gid = taskId.replace(/^asana:/, '');
    return asanaFetch<AsanaStory>(`/tasks/${gid}/stories`, {
      method: 'POST',
      body: JSON.stringify({ data: { text } }),
    });
  }
}
