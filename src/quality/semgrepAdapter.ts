/**
 * Optional Semgrep adapter — normalize CLI JSON into quality findings.
 * Runs only when `semgrep` binary + config file exist; never blocks review.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { QualityFinding } from './qualityTypes';

const execFileAsync = promisify(execFile);

export async function collectSemgrepFindings(input: {
  workspaceRoot: string;
  changedFiles: string[];
}): Promise<QualityFinding[]> {
  const root = input.workspaceRoot;
  const config = ['.semgrep.yml', '.semgrep.yaml', 'semgrep.yml']
    .find(name => fs.existsSync(path.join(root, name)));
  if (!config) return [];

  const targets = input.changedFiles.filter(f => /\.(ts|tsx|js|jsx|py|go)$/i.test(f)).slice(0, 20);
  if (!targets.length) return [];

  try {
    const { stdout } = await execFileAsync(
      'semgrep',
      ['--json', '--config', config, ...targets],
      { cwd: root, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout || '{}') as { results?: Array<Record<string, any>> };
    return (parsed.results || []).slice(0, 20).map((r, idx) => {
      const severityRaw = String(r.extra?.severity || 'medium').toLowerCase();
      const severity = (['critical', 'high', 'medium', 'low'].includes(severityRaw)
        ? severityRaw
        : 'medium') as QualityFinding['severity'];
      return {
        id: `SEMGREP:${r.check_id || idx}`,
        ruleId: String(r.check_id || 'SEMGREP'),
        subcategory: 'debt' as const,
        category: 'correctness' as const,
        severity,
        confidence: 'high' as const,
        title: String(r.extra?.message || r.check_id || 'Semgrep finding'),
        explanation: String(r.extra?.message || r.check_id || 'Semgrep finding'),
        file: String(r.path || 'unknown'),
        line: Number(r.start?.line) || undefined,
        evidence: String(r.extra?.lines || '[semgrep]').slice(0, 200),
        detectedBy: 'semgrep' as const,
        blocking: severity === 'critical',
        debtMinutes: 25,
      };
    });
  } catch {
    return [];
  }
}
