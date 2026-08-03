import * as vscode from 'vscode';
import {
  TynePmTool,
  ALL_PM_TOOLS,
  TyneTaskProviderAdapter,
} from './taskTypes';
import {
  LinearTaskAdapter,
  JiraTaskAdapter,
  AsanaTaskAdapter,
  NotionTaskAdapter,
  MondayTaskAdapter,
} from './taskProviderAdapters';
import { getTaskSyncStateSync } from './taskCacheService';

const KEY_CONNECTED = 'tyne.pmConnectedTools';

const ADAPTER_MAP: Record<TynePmTool, TyneTaskProviderAdapter> = {
  linear: new LinearTaskAdapter(),
  jira: new JiraTaskAdapter(),
  asana: new AsanaTaskAdapter(),
  notion: new NotionTaskAdapter(),
  monday: new MondayTaskAdapter(),
};

// ── Tier limits ───────────────────────────────────────────────────────────────

export function getAvailableProvidersForTier(tier: 'free' | 'pro' | 'max'): TynePmTool[] {
  if (tier === 'free') { return [ALL_PM_TOOLS[0]]; }
  return ALL_PM_TOOLS;
}

export function isFreeTier(tier: string): boolean {
  return tier.toUpperCase() === 'CORE' || tier.toLowerCase() === 'free';
}

// ── Connected tools (persisted) ───────────────────────────────────────────────

export function getConnectedToolsSync(context: vscode.ExtensionContext): TynePmTool[] {
  const raw = context.workspaceState.get<TynePmTool[]>(KEY_CONNECTED, []);
  return Array.isArray(raw) ? raw : [];
}

export async function getConnectedTools(context: vscode.ExtensionContext): Promise<TynePmTool[]> {
  return getConnectedToolsSync(context);
}

export async function connectTool(
  context: vscode.ExtensionContext,
  tool: TynePmTool,
  tier: string,
): Promise<{ ok: boolean; message: string; warning?: string }> {
  const free = isFreeTier(tier);
  const current = getConnectedToolsSync(context);

  if (free && current.length >= 1 && !current.includes(tool)) {
    return {
      ok: false,
      message: 'Free plan supports one PM tool. Upgrade to Pro or Max to connect all PM tools.',
    };
  }

  const adapter = ADAPTER_MAP[tool];
  const result = await adapter.connect();
  if (!result.connected) {
    return { ok: false, message: result.errorMessage ?? `Could not connect to ${tool}.` };
  }

  const updated = current.includes(tool) ? current : [...current, tool];
  await context.workspaceState.update(KEY_CONNECTED, updated);
  return { ok: true, message: `Connected to ${tool}.`, warning: result.errorMessage };
}

export async function markToolConnected(context: vscode.ExtensionContext, tool: TynePmTool): Promise<void> {
  const current = getConnectedToolsSync(context);
  if (!current.includes(tool)) {
    await context.workspaceState.update(KEY_CONNECTED, [...current, tool]);
  }
}

export async function markToolDisconnected(context: vscode.ExtensionContext, tool: TynePmTool): Promise<void> {
  const current = getConnectedToolsSync(context);
  if (!current.includes(tool)) { return; }
  await context.workspaceState.update(KEY_CONNECTED, current.filter(t => t !== tool));
}

export async function disconnectTool(
  context: vscode.ExtensionContext,
  tool: TynePmTool,
): Promise<void> {
  const adapter = ADAPTER_MAP[tool];
  await adapter.disconnect().catch(() => undefined);
  const current = getConnectedToolsSync(context);
  await context.workspaceState.update(KEY_CONNECTED, current.filter(t => t !== tool));
}

export async function canConnectProvider(
  context: vscode.ExtensionContext,
  tier: string,
  tool: TynePmTool,
): Promise<boolean> {
  if (!isFreeTier(tier)) { return true; }
  const current = getConnectedToolsSync(context);
  return current.length === 0 || current.includes(tool);
}

// ── Adapter access ────────────────────────────────────────────────────────────

export function getAdapter(tool: TynePmTool): TyneTaskProviderAdapter {
  return ADAPTER_MAP[tool];
}

// ── Summary of sync states ────────────────────────────────────────────────────

export function buildProviderSummary(
  context: vscode.ExtensionContext,
  connectedTools: TynePmTool[],
): { tool: TynePmTool; cachedCount: number; lastSyncedAt?: string; syncStatus: string }[] {
  return connectedTools.map(tool => {
    const s = getTaskSyncStateSync(context, tool);
    return { tool, cachedCount: s.cachedTaskCount, lastSyncedAt: s.lastSyncedAt, syncStatus: s.syncStatus };
  });
}
