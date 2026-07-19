import { TynePmTool, TyneTask } from './taskTypes';

export interface TynePmWorkspaceOption {
  value: '' | TynePmTool;
  label: string;
}

export interface TynePmIntegrationSnapshot {
  githubConnected: boolean;
  connectedTools: TynePmTool[];
  jira?: {
    connected: boolean;
    projectKey?: string;
    projectName?: string;
    siteName?: string;
  };
  linear?: {
    connected: boolean;
    workspaceName?: string;
    teamKey?: string;
    teamName?: string;
  };
}

export function filterTasksForConnectedTools(
  tasks: TyneTask[],
  connectedTools: TynePmTool[],
): TyneTask[] {
  if (!connectedTools.length) { return []; }
  const connected = new Set<TynePmTool>(connectedTools);
  return tasks.filter(task => connected.has(task.sourceTool));
}

export function buildPmWorkspaceOptions(
  snapshot: TynePmIntegrationSnapshot,
): TynePmWorkspaceOption[] {
  const options: TynePmWorkspaceOption[] = [{ value: '', label: 'All connected workspaces' }];
  const connected = new Set<TynePmTool>(snapshot.connectedTools || []);

  if (connected.has('jira')) {
    const project = [snapshot.jira?.projectKey, snapshot.jira?.projectName].filter(Boolean).join(' · ');
    options.push({ value: 'jira', label: `Jira: ${project || snapshot.jira?.siteName || 'Connected project'}` });
  }

  if (connected.has('linear')) {
    const team = [snapshot.linear?.teamKey, snapshot.linear?.teamName].filter(Boolean).join(' · ');
    options.push({ value: 'linear', label: `Linear: ${team || snapshot.linear?.workspaceName || 'Connected workspace'}` });
  }

  return options;
}
