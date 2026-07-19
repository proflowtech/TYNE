/**
 * Narrow performance heuristics on changed lines (JS/TS/Python/Go).
 */
import { changedLinesFromDiff } from './astFacts';
import type { QualityFinding } from './qualityTypes';

export function scanPerformance(diff: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const lines = changedLinesFromDiff(diff);
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    const window = lines.slice(Math.max(0, i - 2), i + 3).map(l => l.text).join('\n');
    if (/\bfor\s*\(|\bwhile\s*\(|\.map\s*\(|\.forEach\s*\(/.test(window)
      && /JSON\.parse\s*\(/.test(row.text)) {
      findings.push({
        id: `PERF_JSON_LOOP:${row.file}:${row.line}`,
        ruleId: 'PERF_JSON_PARSE_LOOP',
        subcategory: 'hot_loop',
        category: 'performance',
        severity: 'medium',
        confidence: 'medium',
        title: 'JSON.parse inside a loop',
        explanation: 'Parsing JSON repeatedly in a hot loop is expensive.',
        file: row.file,
        line: row.line,
        evidence: row.text.slice(0, 160),
        suggestedFix: 'Parse once outside the loop or reuse a parsed object.',
        detectedBy: 'ast_rule',
        blocking: false,
        debtMinutes: 20,
      });
    }
    if (/fs\.(readFileSync|writeFileSync|existsSync)\s*\(/.test(row.text)
      && !/(test|spec)\./i.test(row.file)) {
      findings.push({
        id: `PERF_SYNC_IO:${row.file}:${row.line}`,
        ruleId: 'PERF_SYNC_IO',
        subcategory: 'sync_io',
        category: 'performance',
        severity: 'medium',
        confidence: 'high',
        title: 'Synchronous filesystem I/O',
        explanation: 'Sync fs calls can block the event loop in request paths.',
        file: row.file,
        line: row.line,
        evidence: row.text.slice(0, 160),
        suggestedFix: 'Prefer async fs.promises APIs.',
        detectedBy: 'ast_rule',
        blocking: false,
        debtMinutes: 15,
      });
    }
  }
  return findings.slice(0, 12);
}
