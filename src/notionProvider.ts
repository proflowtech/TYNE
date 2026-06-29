const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function getVscode(): typeof import('vscode') {
  return require('vscode') as typeof import('vscode');
}

function getApiKey(): string | undefined {
  return getVscode().workspace.getConfiguration('tyne.notion').get<string>('apiKey');
}

function getDatabaseId(): string | undefined {
  return getVscode().workspace.getConfiguration('tyne.notion').get<string>('databaseId');
}

function getStatusProperty(): string {
  return getVscode().workspace.getConfiguration('tyne.notion').get<string>('statusProperty') || 'Status';
}

export function statusPropertyName(): string {
  return getStatusProperty();
}

async function notionFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) { throw new Error('Notion API key is not configured in settings.'); }
  const response = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null) as T | { message?: string; status?: number } | null;
  if (!response.ok) {
    const message = (payload && typeof (payload as { message?: string }).message === 'string'
      ? (payload as { message?: string }).message
      : response.statusText) || 'Notion API request failed';
    throw new Error(`Notion API error (${response.status}): ${message}`);
  }
  if (!payload) { throw new Error('Notion API returned an empty response.'); }
  return payload as T;
}

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, unknown>;
}

export interface NotionStatusOption {
  id: string;
  name: string;
  color?: string;
}

export interface NotionDatabaseProperty {
  status?: { options: NotionStatusOption[] };
  select?: { options: NotionStatusOption[] };
}

export interface NotionDatabase {
  properties: Record<string, NotionDatabaseProperty>;
}

export class NotionProvider {
  statusPropertyName(): string {
    return getStatusProperty();
  }

  async isConnected(): Promise<boolean> {
    try {
      await notionFetch<{ id: string }>('/users/me', { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  async getPage(pageId: string): Promise<NotionPage> {
    const id = pageId.replace(/^notion:/, '').replace(/-/g, '');
    return notionFetch<NotionPage>(`/pages/${id}`);
  }

  async findDoneStatusOption(databaseId: string): Promise<NotionStatusOption> {
    const data = await notionFetch<NotionDatabase>(`/databases/${databaseId.replace(/-/g, '')}`);
    const prop = data.properties[getStatusProperty()];
    const options = prop?.status?.options || prop?.select?.options || [];
    const done = options.find((o: NotionStatusOption) => /done|complete|closed/i.test(o.name));
    if (!done) { throw new Error(`No Done option found in Notion status property '${getStatusProperty()}'.`); }
    return done;
  }

  async updatePageStatus(pageId: string, statusName: string): Promise<NotionPage> {
    const id = pageId.replace(/^notion:/, '').replace(/-/g, '');
    const statusProp = getStatusProperty();
    return notionFetch<NotionPage>(`/pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          [statusProp]: { status: { name: statusName } },
        },
      }),
    });
  }

  async updateValidationMetadata(pageId: string, timestamp: string): Promise<NotionPage> {
    const id = pageId.replace(/^notion:/, '').replace(/-/g, '');
    return notionFetch<NotionPage>(`/pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          'Validation timestamp': { date: { start: timestamp } },
        },
      }),
    });
  }

  async completeTask(pageId: string): Promise<{ id: string; url: string; statusName: string }> {
    const databaseId = getDatabaseId();
    if (!databaseId) { throw new Error('Notion database ID is not configured in settings.'); }
    const doneOption = await this.findDoneStatusOption(databaseId);
    await this.updatePageStatus(pageId, doneOption.name);
    const timestamp = new Date().toISOString();
    await this.updateValidationMetadata(pageId, timestamp).catch(() => undefined);
    const page = await this.getPage(pageId);
    return { id: page.id, url: page.url, statusName: doneOption.name };
  }
}
