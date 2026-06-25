import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TynePlanTier, TyneValidationHistoryFilters, TyneValidationResult } from './validationTypes';
import { exportCsv, exportJson, buildExportFileName, limitHistoryForTier, matchesHistoryFilters } from './validationUtils';

const HISTORY_DIR = '.tyne';
const HISTORY_FILE = 'validation-history.json';

export function getValidationHistoryService(context: vscode.ExtensionContext): ValidationHistoryService {
  return new ValidationHistoryService(context);
}

export class ValidationHistoryService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async saveValidationResult(result: TyneValidationResult): Promise<void> {
    const history = await this._loadHistory();
    history.unshift(result);
    await this._saveHistory(history);
  }

  async listValidationHistory(tier: TynePlanTier): Promise<TyneValidationResult[]> {
    const history = await this._loadHistory();
    return limitHistoryForTier(history, tier);
  }

  async listFreeValidationHistory(): Promise<TyneValidationResult[]> {
    const history = await this._loadHistory();
    return limitHistoryForTier(history, 'free');
  }

  async listFullValidationHistory(): Promise<TyneValidationResult[]> {
    return this._loadHistory();
  }

  async listRecentValidationHistory(limit: number): Promise<TyneValidationResult[]> {
    const history = await this._loadHistory();
    return history.slice(0, limit);
  }

  async getLatestValidationForTask(taskId: string): Promise<TyneValidationResult | null> {
    const history = await this._loadHistory();
    return history.find(h => h.taskId === taskId) || null;
  }

  async getLatestValidationForBranch(branchName: string): Promise<TyneValidationResult | null> {
    const history = await this._loadHistory();
    return history.find(h => h.branchName === branchName) || null;
  }

  async filterValidationHistory(filters: TyneValidationHistoryFilters): Promise<TyneValidationResult[]> {
    const history = await this._loadHistory();
    return history.filter(h => matchesHistoryFilters(h, filters));
  }

  async exportValidationHistory(filters: TyneValidationHistoryFilters, format: 'csv' | 'json'): Promise<string> {
    const results = await this.filterValidationHistory(filters);
    if (format === 'csv') { return exportCsv(results); }
    return exportJson(results);
  }

  async clearHistory(): Promise<void> {
    await this._saveHistory([]);
  }

  private async _loadHistory(): Promise<TyneValidationResult[]> {
    const historyPath = this._historyPath();
    try {
      const raw = await fs.readFile(historyPath, 'utf8');
      const parsed = JSON.parse(raw) as TyneValidationResult[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async _saveHistory(history: TyneValidationResult[]): Promise<void> {
    const historyPath = this._historyPath();
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    // Ensure we never persist raw diffs or keys.
    const sanitized = history.map(r => ({ ...r, diffText: undefined, rawDiff: undefined }));
    await fs.writeFile(historyPath, JSON.stringify(sanitized, null, 2), 'utf8');
  }

  private _historyPath(): string {
    return path.join(os.homedir(), HISTORY_DIR, HISTORY_FILE);
  }
}

export { exportCsv, exportJson, buildExportFileName };

