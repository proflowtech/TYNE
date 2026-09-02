/**
 * Offline detector eval harness — judges golden fixtures with production scanners.
 *
 * harnessKind: detector_eval — calls src/quality secrets/injection/heuristics and
 * scopeDriftHarness (deterministic matrix from ticket+diff). Not a live LLM review.
 *
 * Soft gate by default (EVAL_ENFORCE off) until security-subset recall is trusted.
 * Schema smoke for Staff Engineer verify* remains a lightweight contract check.
 *
 * Usage: npx ts-node --project tsconfig.test.json eval/runEval.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseScopeDriftMatrix,
  resolveScopeDrift,
  parseA2AVerdict,
} from '../src/scopeDriftHarness';
import { dependencyManifestHasPackageDelta } from '../src/reviewPrecisionHarness';
import { verifyStaffEngineerOutput } from '../src/pevAgents';
import { detectSecrets } from '../src/quality/secretsDetector';
import { detectInjectionVulnerabilities, injectionToReviewFindings } from '../src/quality/injectionDetector';
import {
  changedFilesFromDiff,
  detectStaticSecurityHeuristics,
} from '../src/quality/staticSecurityHeuristics';

interface GoldenCase {
  id: string;
  label: 'hipaa_leak' | 'scope_drift' | 'clean' | 'security' | 'compliance' | 'maintainability';
  description: string;
  diff: string;
  ticket: { title: string; acceptanceCriteria: string[] };
  expect: {
    mustCatchCategories?: string[];
    mustNotCatchCategories?: string[];
    mustNotDrift?: boolean;
    mustDetectDrift?: boolean;
    driftContains?: string;
    mustBeClean?: boolean;
  };
}

interface CaseResult {
  id: string;
  pass: boolean;
  reason: string;
  expectedCategories: string[];
  foundCategories: string[];
}

interface DetectorFinding {
  category: string;
  severity: string;
  title?: string;
}

const ROOT = path.join(__dirname);
const GOLDEN = path.join(ROOT, 'golden', 'seed.json');
const threshold = Number(process.env.EVAL_THRESHOLD || '0.66');

function loadGolden(): GoldenCase[] {
  return JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as GoldenCase[];
}

function tokenize(s: string): Set<string> {
  const spaced = String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(spaced.split(/\s+/).filter(t => t.length > 2));
}

function tokenOverlap(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

/** Extract coarse developer additions from a unified diff (no keyword allowlist). */
function additionsFromDiff(diff: string): string[] {
  const adds: string[] = [];
  const seen = new Set<string>();
  const push = (label: string) => {
    const t = label.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    adds.push(t);
  };

  const changedPaths = Array.from(String(diff || '').matchAll(/^diff --git a\/(.+) b\/(.+)$/gm))
    .map(match => match[2]);
  for (const changedPath of changedPaths) {
    if (dependencyManifestHasPackageDelta(diff, changedPath)) {
      push(`dependency manifest: ${changedPath}`);
    }
  }

  for (const raw of String(diff || '').split(/\r?\n/)) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);

    const fn = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/);
    if (fn) push(fn[1]);

    const named = line.match(/export\s+(?:const|let|var)\s+([A-Za-z_][\w]*)/);
    if (named) push(named[1]);

    const alter = line.match(/\bALTER\s+TABLE\s+(\w+)/i);
    if (alter) push(`ALTER TABLE ${alter[1]}`);

    const fetchHost = line.match(/fetch\(\s*['"]https?:\/\/([^/'"]+)/i);
    if (fetchHost) push(`HTTP client: ${fetchHost[1]}`);
  }
  return adds.slice(0, 20);
}

function additionMapsToRequirements(addition: string, requirements: string[]): boolean {
  return requirements.some((req) => {
    if (tokenOverlap(addition, req) >= 0.34) return true;
    const addToks = tokenize(addition);
    const reqToks = tokenize(req);
    for (const t of addToks) {
      if (!reqToks.has(t)) continue;
      // Shared meaningful token (camelCase-split) ties addition to AC/title.
      if (t.length >= 4 || /oauth|login|auth|add|css|btn/i.test(t)) return true;
    }
    return false;
  });
}

/**
 * Build a scope-drift matrix from ticket AC + diff-derived additions, then
 * resolve with non-required A2A verdicts (deterministic offline stand-in).
 */
function resolveDriftFromCase(c: GoldenCase) {
  const reqs = [
    ...(c.ticket.acceptanceCriteria || []),
    ...(c.ticket.title ? [c.ticket.title] : []),
  ];
  const developer_additions = additionsFromDiff(c.diff);
  const unmapped = developer_additions.filter(a => !additionMapsToRequirements(a, reqs));
  const matrix = parseScopeDriftMatrix({
    ticket_requirements: reqs,
    developer_additions,
    unmapped_additions: unmapped,
    drift_detected: unmapped.length > 0,
  })!;
  const verdicts = matrix.unmapped_additions.map(a =>
    parseA2AVerdict({
      required_dependency: false,
      material_risk: true,
      confidence: 'high',
      evidence: `Diff adds ${a}; no ticket requirement maps to this behavior.`,
      reason: 'not required for ticket AC',
    }, a),
  );
  return resolveScopeDrift(matrix, verdicts);
}

/** Run production detectors against the golden diff. */
async function runDetectors(c: GoldenCase): Promise<DetectorFinding[]> {
  const files = changedFilesFromDiff(c.diff);
  const [secrets, injection] = await Promise.all([
    detectSecrets(c.diff, files),
    detectInjectionVulnerabilities(files),
  ]);
  const heuristics = detectStaticSecurityHeuristics(c.diff);
  const findings: DetectorFinding[] = [];

  for (const s of secrets.secrets) {
    findings.push({ category: 'security', severity: s.confidence === 'high' ? 'critical' : 'high', title: s.type });
  }
  for (const f of injectionToReviewFindings(injection)) {
    findings.push({ category: 'security', severity: f.severity, title: f.title });
  }
  for (const h of heuristics) {
    findings.push({ category: h.category, severity: h.severity, title: h.title });
  }
  return findings;
}

async function judgeCase(c: GoldenCase): Promise<CaseResult> {
  const findings = await runDetectors(c);
  const drift = resolveDriftFromCase(c);
  const staff = verifyStaffEngineerOutput({ score: 80, summary: 'ok', findings: [] });

  const expectedCategories: string[] = [];
  if (c.expect.mustCatchCategories) expectedCategories.push(...c.expect.mustCatchCategories);
  if (c.expect.mustDetectDrift) expectedCategories.push('scope_drift');

  const foundCategories = new Set<string>();
  for (const f of findings) foundCategories.add(f.category);
  if (drift.matrix.drift_detected) foundCategories.add('scope_drift');

  const result: CaseResult = {
    id: c.id,
    pass: false,
    reason: '',
    expectedCategories,
    foundCategories: Array.from(foundCategories),
  };

  if (!staff) {
    result.reason = 'staff schema failed';
    return result;
  }

  if (c.expect.mustCatchCategories?.length) {
    const missed = c.expect.mustCatchCategories.filter(cat => !foundCategories.has(cat));
    if (missed.length) {
      result.reason = `missed categories ${missed.join(',')}; found ${[...foundCategories].join(',') || '(none)'}`;
      return result;
    }
  }
  if (c.expect.mustNotCatchCategories?.length) {
    const unexpected = c.expect.mustNotCatchCategories.filter(cat => foundCategories.has(cat));
    if (unexpected.length) {
      result.reason = `forbidden categories ${unexpected.join(',')} were reported`;
      return result;
    }
  }
  if (c.expect.mustDetectDrift) {
    if (!drift.matrix.drift_detected) {
      result.reason = `missed scope drift; additions=${JSON.stringify(additionsFromDiff(c.diff))}`;
      return result;
    }
    if (c.expect.driftContains
      && !drift.lockedDrift.some(x => x.toLowerCase().includes(c.expect.driftContains!.toLowerCase()))) {
      result.reason = `drift missing ${c.expect.driftContains}; locked=${JSON.stringify(drift.lockedDrift)}`;
      return result;
    }
  }
  if (c.expect.mustNotDrift && drift.matrix.drift_detected) {
    result.reason = `false drift; locked=${JSON.stringify(drift.lockedDrift)}`;
    return result;
  }
  if (c.expect.mustBeClean) {
    if (drift.matrix.drift_detected) {
      result.reason = `false drift; locked=${JSON.stringify(drift.lockedDrift)}`;
      return result;
    }
    if (findings.some(f => f.severity === 'critical' || f.severity === 'high')) {
      result.reason = `false positive finding: ${findings.map(f => f.title || f.category).join(',')}`;
      return result;
    }
  }

  result.pass = true;
  result.reason = 'ok';
  return result;
}

function calculateMetrics(results: CaseResult[]) {
  const categories = new Set<string>();
  const casesById = new Map(loadGolden().map(c => [c.id, c]));
  results.forEach(r => {
    r.expectedCategories.forEach(c => categories.add(c));
    r.foundCategories.forEach(c => categories.add(c));
    casesById.get(r.id)?.expect.mustNotCatchCategories?.forEach(c => categories.add(c));
  });

  const metrics: Record<string, { tp: number; fp: number; fn: number; precision: number; recall: number }> = {};

  categories.forEach(cat => {
    let tp = 0, fp = 0, fn = 0;
    results.forEach(r => {
      const golden = casesById.get(r.id);
      const expected = r.expectedCategories.includes(cat);
      const explicitlyNegative = golden?.expect.mustBeClean === true
        || golden?.expect.mustNotCatchCategories?.includes(cat) === true
        || (cat === 'scope_drift' && golden?.expect.mustNotDrift === true);
      const found = r.foundCategories.includes(cat);
      if (expected && found) tp++;
      else if (explicitlyNegative && found) fp++;
      else if (expected && !found) fn++;
    });
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    metrics[cat] = { tp, fp, fn, precision, recall };
  });

  return metrics;
}

async function main() {
  const cases = loadGolden();
  const results = await Promise.all(cases.map(judgeCase));
  const passed = results.filter(r => r.pass).length;
  const accuracy = cases.length ? passed / cases.length : 0;

  const categoryMetrics = calculateMetrics(results);
  const securitySubset = results.filter(r =>
    r.expectedCategories.some(c => c === 'security' || c === 'compliance' || c === 'maintainability'),
  );
  const securityPassed = securitySubset.filter(r => r.pass).length;
  const securityRecall = securitySubset.length ? securityPassed / securitySubset.length : 1;

  const report = {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    accuracy,
    threshold,
    gate: accuracy >= threshold ? 'PASS' : 'FAIL',
    harnessKind: 'detector_eval',
    securitySubset: {
      total: securitySubset.length,
      passed: securityPassed,
      recall: securityRecall,
    },
    categoryMetrics,
    results,
    note: 'Detector eval via production src/quality + scopeDriftHarness. Soft CI until EVAL_ENFORCE=1. Not a live LLM review gate.',
  };
  const outPath = path.join(ROOT, 'last-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.EVAL_ENFORCE === '1' && report.gate === 'FAIL') process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
