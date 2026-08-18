/**
 * Optional LSP hop: Find All References on changed exports.
 * Hard 800ms budget — language-server warmup must never stall a review.
 */

import * as vscode from 'vscode';
import type { BlastImporter } from '../quality/blastRadius';
import type { Hop1Result } from '../quality/importGraph';

const DEFAULT_BUDGET_MS = 800;
const MAX_EXPORTS = 6;

export async function collectLspImporters(
  folder: vscode.WorkspaceFolder,
  hop1: Hop1Result,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<BlastImporter[]> {
  const deadline = Date.now() + budgetMs;
  const hits: BlastImporter[] = [];
  const seen = new Set<string>();
  const changed = new Set(hop1.changedExports.map(e => e.path.replace(/\\/g, '/')));

  for (const exp of hop1.changedExports.slice(0, MAX_EXPORTS)) {
    if (Date.now() >= deadline) { break; }
    if (!exp.name) { continue; }
    try {
      const uri = vscode.Uri.joinPath(folder.uri, exp.path);
      const remaining = Math.max(50, deadline - Date.now());
      let position = new vscode.Position(Math.max(0, (exp.line || 1) - 1), 0);
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const lineText = doc.lineAt(position.line).text;
        const col = lineText.indexOf(exp.name);
        if (col >= 0) { position = new vscode.Position(position.line, col); }
      } catch { /* use line start */ }
      const refs = await Promise.race([
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          position,
        ),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), remaining)),
      ]);
      if (!refs) { break; }
      for (const loc of refs) {
        const rel = vscode.workspace.asRelativePath(loc.uri, false).replace(/\\/g, '/');
        if (changed.has(rel)) { continue; }
        const key = rel + '->' + exp.path;
        if (seen.has(key)) { continue; }
        seen.add(key);
        hits.push({
          file: rel,
          line: (loc.range?.start.line ?? 0) + 1,
          importedSymbols: [exp.name],
          fromModule: exp.path,
          targetFile: exp.path,
        });
      }
    } catch {
      /* LSP missing or file not in workspace — hop-1 AST graph still stands */
    }
  }
  return hits;
}
