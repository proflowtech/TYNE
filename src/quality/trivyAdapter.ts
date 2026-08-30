/**
 * Optional Trivy adapter — Dockerfile/IaC misconfiguration scanning.
 *
 * The security-tool-breadth gap identified against CodeRabbit isn't "we need
 * 40 integrations" — it's that Tyne has one external scanner (Semgrep) plus a
 * few homegrown checks, and enterprise security reviewers check named tools
 * off a list. Trivy is the name procurement checklists look for on that list
 * for container/IaC scanning, and its config scanner (`trivy config`) covers
 * ground nothing else here does: Dockerfiles, Terraform, Kubernetes
 * manifests, CloudFormation.
 *
 * Deliberately scoped to config/IaC scanning only, not dependency CVEs —
 * `dependencyVulnerabilityChecker.ts` already covers npm packages via `npm
 * audit`, and re-scanning the same lockfile with a second tool would just be
 * duplicate noise wearing a different vendor name.
 *
 * Same contract as `semgrepAdapter.ts`: attempt directly, swallow a missing
 * binary or non-zero exit as "nothing to report", never block a review.
 * Unlike `semgrepAdapter.ts`, the subprocess call is injectable so the whole
 * adapter — detection, invocation, parsing — is unit-testable without a real
 * trivy binary on the machine running the tests.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { QualityFinding } from './qualityTypes';

const execFileAsync = promisify(execFile);

export type ExecFileFn = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Dockerfiles, Terraform, and common Kubernetes/CloudFormation manifest
 * paths — the file types `trivy config` actually understands. Deliberately
 * narrow rather than "any .yaml": a repo's CI workflow YAML or an unrelated
 * config file is not an IaC misconfiguration surface, and matching it would
 * just mean paying the subprocess cost on every review for no findings.
 */
const IAC_FILE = /(^|\/)(dockerfile(\.\w+)?|docker-compose\.ya?ml|[^/]+\.tf|[^/]+\.tfvars|k8s\/[^/]+\.ya?ml|kubernetes\/[^/]+\.ya?ml|[^/]+\.cfn\.(json|ya?ml))$/i;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Files in this changeset that Trivy's config scanner can actually evaluate. */
export function iacTargets(changedFiles: string[]): string[] {
  return changedFiles.map(normalizePath).filter(f => IAC_FILE.test(f));
}

const SEVERITY_MAP: Record<string, QualityFinding['severity']> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

interface TrivyMisconfiguration {
  ID?: string;
  Title?: string;
  Message?: string;
  Severity?: string;
  Resolution?: string;
  CauseMetadata?: { StartLine?: number; EndLine?: number };
}

interface TrivyResult {
  Target?: string;
  Misconfigurations?: TrivyMisconfiguration[];
}

interface TrivyOutput {
  Results?: TrivyResult[];
}

const MAX_FINDINGS = 20;

/**
 * Parse `trivy config --format json` output into quality findings.
 * Pure — no subprocess, so it can be tested against fixture JSON directly.
 */
export function parseTrivyConfigJson(raw: string): QualityFinding[] {
  let parsed: TrivyOutput;
  try {
    parsed = JSON.parse(raw || '{}') as TrivyOutput;
  } catch {
    return [];
  }

  const out: QualityFinding[] = [];
  for (const result of parsed.Results || []) {
    const file = normalizePath(String(result.Target || 'unknown'));
    for (const misconfig of result.Misconfigurations || []) {
      const severityRaw = String(misconfig.Severity || 'MEDIUM').toUpperCase();
      const severity = SEVERITY_MAP[severityRaw] || 'medium';
      const title = String(misconfig.Title || misconfig.ID || 'Trivy misconfiguration');
      out.push({
        id: `TRIVY:${misconfig.ID || out.length}:${file}`,
        ruleId: String(misconfig.ID || 'TRIVY'),
        // Matches semgrepAdapter's convention: external-tool findings route
        // through the general 'debt' subcategory rather than a dedicated one —
        // adding a new QualitySubcategory value is a wider, riskier change
        // than this adapter needs to make.
        subcategory: 'debt',
        category: 'correctness',
        severity,
        confidence: 'high',
        title,
        explanation: String(misconfig.Message || title),
        file,
        line: misconfig.CauseMetadata?.StartLine || undefined,
        endLine: misconfig.CauseMetadata?.EndLine || undefined,
        evidence: `[trivy] ${misconfig.ID || ''}`.trim(),
        suggestedFix: misconfig.Resolution || undefined,
        detectedBy: 'trivy',
        blocking: severity === 'critical',
        debtMinutes: 20,
      });
      if (out.length >= MAX_FINDINGS) { return out; }
    }
  }
  return out;
}

export async function collectTrivyFindings(input: {
  workspaceRoot: string;
  changedFiles: string[];
  execFileFn?: ExecFileFn;
}): Promise<QualityFinding[]> {
  const targets = iacTargets(input.changedFiles);
  if (!targets.length) { return []; }

  const run = input.execFileFn || execFileAsync;
  try {
    const { stdout } = await run(
      'trivy',
      ['config', '--format', 'json', '--quiet', ...targets],
      { cwd: input.workspaceRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseTrivyConfigJson(stdout);
  } catch {
    // Missing binary, non-zero exit, timeout, or malformed output — all mean
    // "nothing to report", exactly like a missing Semgrep config does.
    return [];
  }
}
