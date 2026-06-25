import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TyneValidationHistoryFilters, TyneValidationResult } from './validationTypes';
import { ValidationHistoryService, exportCsv, exportJson, buildExportFileName } from './validationHistoryService';

export function getValidationExportService(historyService: ValidationHistoryService): ValidationExportService {
  return new ValidationExportService(historyService);
}

export class ValidationExportService {
  constructor(private readonly historyService: ValidationHistoryService) {}

  async exportValidationHistory(filters: TyneValidationHistoryFilters, format: 'csv' | 'json'): Promise<string> {
    return this.historyService.exportValidationHistory(filters, format);
  }

  exportCsv(results: TyneValidationResult[]): string {
    return exportCsv(results);
  }

  exportJson(results: TyneValidationResult[]): string {
    return exportJson(results);
  }

  buildExportFileName(format: 'csv' | 'json'): string {
    return buildExportFileName(format);
  }

  async saveExportToDownloads(content: string, format: 'csv' | 'json'): Promise<string> {
    const fileName = buildExportFileName(format);
    const downloads = path.join(os.homedir(), 'Downloads');
    await fs.mkdir(downloads, { recursive: true });
    const filePath = path.join(downloads, fileName);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }
}
