/**
 * Mine nearby-file conventions and flag inconsistencies in the change.
 */
import { changedLinesFromDiff, type FileFacts } from './astFacts';
import type { QualityFinding } from './qualityTypes';

export function mineConsistency(input: {
  diff: string;
  changedFacts: FileFacts[];
  nearbyFacts: FileFacts[];
}): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const nearby = input.nearbyFacts;
  if (!nearby.length) return findings;

  const nearbyText = nearby.map(f => f.lines.join('\n')).join('\n');
  const usesCamel = /function\s+[a-z][a-zA-Z0-9]+|const\s+[a-z][a-zA-Z0-9]+\s*=/.test(nearbyText);
  const usesSnake = /\bdef\s+[a-z]+_[a-z_]+|\b[a-z]+_[a-z_]+\s*=/.test(nearbyText);
  const usesResultErr = /\b(ok\(|err\(|Result<|Either<)/.test(nearbyText);
  const usesTryCatch = /\btry\s*\{|\btry:/.test(nearbyText);
  const usesLogger = /\blogger\.|createLogger|pino\(|winston/.test(nearbyText);

  const lines = changedLinesFromDiff(input.diff);
  for (const row of lines) {
    if (usesCamel && !usesSnake && /\b(function|const|def)\s+[a-z]+_[a-z_]+\b/.test(row.text)) {
      findings.push({
        id: `QUALITY_NAMING:${row.file}:${row.line}`,
        ruleId: 'QUALITY_NAMING',
        subcategory: 'naming_inconsistency',
        category: 'style',
        severity: 'low',
        confidence: 'medium',
        title: 'Naming style differs from nearby code (snake_case vs camelCase)',
        explanation: 'Nearby modules prefer camelCase identifiers.',
        file: row.file,
        line: row.line,
        evidence: row.text.slice(0, 160),
        suggestedFix: 'Rename to match local camelCase convention.',
        detectedBy: 'consistency',
        blocking: false,
        debtMinutes: 10,
        betterPattern: 'Match naming used in neighboring files',
      });
    }

    if (usesTryCatch && !usesResultErr && /\bResult\.|ok\(|err\(/.test(row.text)) {
      findings.push({
        id: `QUALITY_ERR_STYLE:${row.file}:${row.line}`,
        ruleId: 'QUALITY_ERR_STYLE',
        subcategory: 'error_handling_inconsistency',
        category: 'maintainability',
        severity: 'medium',
        confidence: 'medium',
        title: 'Error-handling style differs from nearby code',
        explanation: 'Nearby code uses try/catch; this change introduces Result/ok/err style.',
        file: row.file,
        line: row.line,
        evidence: row.text.slice(0, 160),
        suggestedFix: 'Follow the existing try/catch pattern in this area.',
        detectedBy: 'consistency',
        blocking: false,
        debtMinutes: 20,
        betterPattern: 'Use try/catch like neighboring modules',
      });
    }

    if (usesLogger && /console\.(log|error|warn)\s*\(/.test(row.text) && !/(test|spec)\./i.test(row.file)) {
      findings.push({
        id: `QUALITY_LOG_STYLE:${row.file}:${row.line}`,
        ruleId: 'QUALITY_LOG_STYLE',
        subcategory: 'error_handling_inconsistency',
        category: 'style',
        severity: 'low',
        confidence: 'high',
        title: 'Uses console instead of project logger',
        explanation: 'Nearby code uses a structured logger.',
        file: row.file,
        line: row.line,
        evidence: row.text.slice(0, 160),
        suggestedFix: 'Use the shared logger utility.',
        detectedBy: 'consistency',
        blocking: false,
        debtMinutes: 8,
        betterPattern: 'Use the existing logger from nearby modules',
      });
    }
  }

  // duplicate utility names: export colliding with nearby export
  const nearbyExports = new Map<string, string>();
  for (const f of nearby) {
    for (const e of f.exports) nearbyExports.set(e.name, f.path);
  }
  for (const f of input.changedFacts) {
    for (const e of f.exports) {
      const other = nearbyExports.get(e.name);
      if (other && other !== f.path) {
        findings.push({
          id: `QUALITY_DUP_UTIL:${f.path}:${e.name}`,
          ruleId: 'QUALITY_DUP_UTIL',
          subcategory: 'duplicate_utility',
          category: 'maintainability',
          severity: 'medium',
          confidence: 'high',
          title: `Export "${e.name}" already exists in ${other}`,
          explanation: 'New export collides with an existing utility name nearby.',
          file: f.path,
          line: e.line,
          evidence: `export ${e.name}`,
          suggestedFix: `Reuse ${other} instead of re-exporting a duplicate.`,
          detectedBy: 'consistency',
          blocking: false,
          debtMinutes: 35,
          betterPattern: `Import from ${other}`,
        });
      }
    }
  }

  return findings.slice(0, 20);
}
