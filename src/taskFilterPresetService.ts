import * as vscode from 'vscode';
import {
  TyneTaskFilterPreset,
  TyneAdvancedTaskFilters,
  TyneAdvancedTaskSort,
  TynePmTool,
  DEFAULT_ADVANCED_SORT,
} from './taskTypes';

const KEY_PRESETS = 'tyne.taskFilterPresets';
const ISO = () => new Date().toISOString();

function uid(): string {
  return `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listPresetsSync(context: vscode.ExtensionContext): TyneTaskFilterPreset[] {
  const raw = context.workspaceState.get<TyneTaskFilterPreset[]>(KEY_PRESETS, []);
  return Array.isArray(raw) ? raw : [];
}

async function persistPresets(context: vscode.ExtensionContext, presets: TyneTaskFilterPreset[]): Promise<void> {
  await context.workspaceState.update(KEY_PRESETS, presets);
}

export async function savePreset(
  context: vscode.ExtensionContext,
  input: { name: string; query?: string; sourceTools?: TynePmTool[]; filters: TyneAdvancedTaskFilters; sort: TyneAdvancedTaskSort; isDefault?: boolean },
): Promise<TyneTaskFilterPreset> {
  const presets = listPresetsSync(context);
  const now = ISO();
  const preset: TyneTaskFilterPreset = {
    id: uid(),
    name: input.name.trim() || 'Untitled Preset',
    query: input.query,
    sourceTools: input.sourceTools,
    filters: input.filters,
    sort: input.sort ?? DEFAULT_ADVANCED_SORT,
    isDefault: input.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };

  if (preset.isDefault) {
    presets.forEach(p => { p.isDefault = false; });
  }

  presets.push(preset);
  await persistPresets(context, presets);
  return preset;
}

export async function renamePreset(
  context: vscode.ExtensionContext,
  id: string,
  name: string,
): Promise<TyneTaskFilterPreset> {
  const presets = listPresetsSync(context);
  const preset = presets.find(p => p.id === id);
  if (!preset) { throw new Error(`Preset "${id}" not found.`); }
  preset.name = name.trim() || preset.name;
  preset.updatedAt = ISO();
  await persistPresets(context, presets);
  return preset;
}

export async function deletePreset(context: vscode.ExtensionContext, id: string): Promise<void> {
  const presets = listPresetsSync(context).filter(p => p.id !== id);
  await persistPresets(context, presets);
}

export async function setDefaultPreset(context: vscode.ExtensionContext, id: string): Promise<void> {
  const presets = listPresetsSync(context);
  presets.forEach(p => { p.isDefault = p.id === id; p.updatedAt = ISO(); });
  await persistPresets(context, presets);
}

export function getDefaultPreset(context: vscode.ExtensionContext): TyneTaskFilterPreset | null {
  return listPresetsSync(context).find(p => p.isDefault) ?? null;
}

export function getPresetById(context: vscode.ExtensionContext, id: string): TyneTaskFilterPreset | null {
  return listPresetsSync(context).find(p => p.id === id) ?? null;
}

export async function repairPresetStorage(context: vscode.ExtensionContext): Promise<{ repaired: boolean }> {
  const raw = context.workspaceState.get<unknown>(KEY_PRESETS);
  if (!Array.isArray(raw)) {
    await context.workspaceState.update(KEY_PRESETS, []);
    return { repaired: true };
  }
  return { repaired: false };
}
