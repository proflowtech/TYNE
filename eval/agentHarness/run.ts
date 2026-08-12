/**
 * Thin agent/composition harness — bags of findings through production merger,
 * grounding, and verdict helpers. Not a second orchestrator; no live LLM.
 *
 * Usage: npm run test:agent-harness
 * Soft by default; set AGENT_HARNESS_ENFORCE=1 to fail CI on regressions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { groundReviewFindings, emptyGroundingStats } from '../../src/services/findingGrounding';
import {
  mergeAndDeduplicateFindings,
  postProcessReviewFindings,
} from '../../src/services/findingsMerger';
import { MODE_CONFIGS, enforceIncompleteReviewHonesty, type ReviewMode } from '../../src/reviewPerformance';
import { verdictFromFindings, type ReviewOverallVerdict } from '../../src/validateReviewTypes';

type Finding = Record<string, unknown>;

interface ComposeCase {
  id: string;
  cohort: 'dedup' | 'never_block' | 'grounding' | 'verdict' | 'incomplete' | 'mode';
  description: string;
  changedFiles?: Array<{ path?: string; file?: string; status?: string }>;
  findings?: Finding[];
  mode?: ReviewMode;
  /** Recorded incomplete-pack / local-only signals (contract, not LLM). */
  pipelineInfo?: { failedPacks?: number; reviewedPacks?: number; packs?: number; localOnly?: boolean };
  expect: {
    maxFindings?: number;
    minFindings?: number;
    verdict?: ReviewOverallVerdict;
    droppedIds?: string[];
    keptIds?: string[];
    mode?: Partial<(typeof MODE_CONFIGS)[ReviewMode]>;
    /** Incomplete packs must not pretend to be a full pass. */
    statusHonesty?: 'needs_work' | 'context_limited';
  };
}

const CASES: ComposeCase[] = [
  {
    id: 'dedup-sqli-two-engines',
    cohort: 'dedup',
    description: 'Sentinel + Staff same SQLi → one finding',
    changedFiles: [{ path: 'db.ts', status: 'modified' }],
    findings: [
      {
        id: 'local-sqli',
        file: 'db.ts',
        line: 12,
        title: 'SQL injection risk',
        severity: 'critical',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'Unparameterized query',
      },
      {
        id: 'llm-sqli',
        file: 'db.ts',
        line: 13,
        title: 'Unsanitized SQL input',
        severity: 'high',
        category: 'security',
        confidence: 'high',
        source: 'llm',
        explanation: 'Template literal embeds id',
      },
    ],
    expect: { maxFindings: 1, verdict: 'block' },
  },
  {
    id: 'dedup-keeps-distinct-categories',
    cohort: 'dedup',
    description: 'Security + style on same line stay separate',
    changedFiles: [{ path: 'db.ts', status: 'modified' }],
    findings: [
      {
        id: 'sec',
        file: 'db.ts',
        line: 10,
        title: 'SQL injection',
        severity: 'critical',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'sqli',
      },
      {
        id: 'style',
        file: 'db.ts',
        line: 10,
        title: 'Prefer const',
        severity: 'low',
        category: 'style',
        confidence: 'high',
        source: 'llm',
        explanation: 'style',
      },
    ],
    expect: { minFindings: 2 },
  },
  {
    id: 'never-block-pm-alignment-critical',
    cohort: 'never_block',
    description: 'pm_alignment critical → changes_requested not block',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    findings: [
      {
        id: 'pm',
        file: 'src/a.ts',
        line: 1,
        title: 'AC incomplete',
        severity: 'critical',
        category: 'pm_alignment',
        confidence: 'high',
        source: 'llm',
        explanation: 'drift',
      },
    ],
    expect: { verdict: 'changes_requested' },
  },
  {
    id: 'never-block-style-critical',
    cohort: 'never_block',
    description: 'style critical cannot hard-block',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    findings: [
      {
        id: 'st',
        file: 'src/a.ts',
        line: 2,
        title: 'Naming',
        severity: 'critical',
        category: 'style',
        confidence: 'high',
        source: 'llm',
        explanation: 'name',
      },
    ],
    expect: { verdict: 'changes_requested' },
  },
  {
    id: 'never-block-vibe-critical',
    cohort: 'never_block',
    description: 'vibe_code critical cannot hard-block',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    findings: [
      {
        id: 'vb',
        file: 'src/a.ts',
        line: 3,
        title: 'Vibe smell',
        severity: 'critical',
        category: 'vibe_code',
        confidence: 'high',
        source: 'llm',
        explanation: 'vibe',
      },
    ],
    expect: { verdict: 'changes_requested' },
  },
  {
    id: 'never-block-maintainability-critical',
    cohort: 'never_block',
    description: 'maintainability critical cannot hard-block',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    findings: [
      {
        id: 'm',
        file: 'src/a.ts',
        line: 4,
        title: 'Complex',
        severity: 'critical',
        category: 'maintainability',
        confidence: 'high',
        source: 'llm',
        explanation: 'complex',
      },
    ],
    expect: { verdict: 'changes_requested' },
  },
  {
    id: 'security-critical-blocks',
    cohort: 'verdict',
    description: 'security critical + blocking → block',
    changedFiles: [{ path: 'auth.ts', status: 'modified' }],
    findings: [
      {
        id: 'sec',
        file: 'auth.ts',
        line: 8,
        title: 'Hardcoded secret',
        severity: 'critical',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'key',
      },
    ],
    expect: { verdict: 'block' },
  },
  {
    id: 'compliance-critical-blocks',
    cohort: 'verdict',
    description: 'compliance critical → block',
    changedFiles: [{ path: 'api/patient.ts', status: 'modified' }],
    findings: [
      {
        id: 'phi',
        file: 'api/patient.ts',
        line: 5,
        title: 'PHI logged',
        severity: 'critical',
        category: 'compliance',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'ssn',
      },
    ],
    expect: { verdict: 'block' },
  },
  {
    id: 'empty-approve',
    cohort: 'verdict',
    description: 'no findings → approve',
    findings: [],
    expect: { verdict: 'approve', maxFindings: 0 },
  },
  {
    id: 'low-style-suggestions',
    cohort: 'verdict',
    description: 'low style → approve_with_suggestions',
    changedFiles: [{ path: 'x.ts', status: 'modified' }],
    findings: [
      {
        id: 'nit',
        file: 'x.ts',
        line: 1,
        title: 'Nit',
        severity: 'low',
        category: 'style',
        confidence: 'high',
        source: 'llm',
        explanation: 'nit',
      },
    ],
    expect: { verdict: 'approve_with_suggestions' },
  },
  {
    id: 'grounding-drop-hallucinated-path',
    cohort: 'grounding',
    description: 'path not in diff is dropped',
    changedFiles: [{ path: 'src/real.ts', status: 'modified' }],
    findings: [
      {
        id: 'fake',
        file: 'src/invented/not-in-diff.ts',
        line: 1,
        title: 'Bug',
        severity: 'high',
        category: 'correctness',
        confidence: 'high',
        source: 'llm',
        explanation: 'hallucinated',
      },
      {
        id: 'real',
        file: 'src/real.ts',
        line: 2,
        title: 'Real issue',
        severity: 'medium',
        category: 'correctness',
        confidence: 'high',
        source: 'llm',
        explanation: 'ok',
      },
    ],
    expect: { droppedIds: ['fake'], keptIds: ['real'] },
  },
  {
    id: 'grounding-keep-scope-synthetic',
    cohort: 'grounding',
    description: '(scope) synthetic path is allowed',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    findings: [
      {
        id: 'drift',
        file: '(scope)',
        title: 'Scope drift: newsletter',
        severity: 'high',
        category: 'pm_alignment',
        confidence: 'high',
        source: 'llm',
        explanation: 'unmapped',
      },
    ],
    expect: { keptIds: ['drift'], verdict: 'changes_requested' },
  },
  {
    id: 'incomplete-failed-packs-honesty',
    cohort: 'incomplete',
    description: 'failed packs record must not claim full pass',
    pipelineInfo: { failedPacks: 2, reviewedPacks: 1, packs: 3 },
    expect: { statusHonesty: 'context_limited' },
  },
  {
    id: 'incomplete-local-only-honesty',
    cohort: 'incomplete',
    description: 'local-only incomplete signal stays needs_work',
    pipelineInfo: { failedPacks: 0, reviewedPacks: 0, packs: 0, localOnly: true },
    expect: { statusHonesty: 'needs_work' },
  },
  {
    id: 'incomplete-zero-failures-ok',
    cohort: 'incomplete',
    description: 'zero failed packs is not forced incomplete',
    pipelineInfo: { failedPacks: 0, reviewedPacks: 3, packs: 3 },
    findings: [],
    expect: { verdict: 'approve' },
  },
  {
    id: 'mode-full-runs-pev',
    cohort: 'mode',
    mode: 'full',
    description: 'full mode enables PEV',
    expect: { mode: { runPevAgents: true, runLocalQualityEngine: true } },
  },
  {
    id: 'mode-quick-skips-pev',
    cohort: 'mode',
    mode: 'quick',
    description: 'quick mode skips PEV',
    expect: { mode: { runPevAgents: false } },
  },
  {
    id: 'mode-triage-skips-pev',
    cohort: 'mode',
    mode: 'triage',
    description: 'triage mode skips PEV',
    expect: { mode: { runPevAgents: false, runLocalQualityEngine: true } },
  },
  {
    id: 'postprocess-dedup-end-to-end',
    cohort: 'dedup',
    description: 'postProcess merges overlapping security findings',
    changedFiles: [{ path: 'db.ts', status: 'modified' }],
    findings: [
      {
        id: 'a',
        file: 'db.ts',
        line: 20,
        title: 'SQL injection risk',
        severity: 'critical',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'a',
      },
      {
        id: 'b',
        file: 'db.ts',
        line: 21,
        title: 'Injection via string concat',
        severity: 'high',
        category: 'security',
        confidence: 'medium',
        source: 'llm',
        explanation: 'b',
      },
    ],
    expect: { maxFindings: 1, verdict: 'block' },
  },
  {
    id: 'merge-exact-duplicate-titles',
    cohort: 'dedup',
    description: 'exact title+file+line duplicates collapse',
    changedFiles: [{ path: 'x.ts', status: 'modified' }],
    findings: [
      {
        id: '1',
        file: 'x.ts',
        line: 5,
        title: 'Same title',
        severity: 'high',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'local_engine',
        explanation: 'one',
      },
      {
        id: '2',
        file: 'x.ts',
        line: 5,
        title: 'Same title',
        severity: 'high',
        category: 'security',
        confidence: 'high',
        blocking: true,
        source: 'llm',
        explanation: 'two',
      },
    ],
    expect: { maxFindings: 1 },
  },
];

function statusFromIncompleteSignals(info: ComposeCase['pipelineInfo']): 'needs_work' | 'passed' | 'context_limited' {
  const honesty = enforceIncompleteReviewHonesty({
    status: 'passed',
    score: 95,
    failedPacks: info?.failedPacks || 0,
    actualMode: 'full',
    reviewWarnings: info?.localOnly ? [{ type: 'llm_review_incomplete' }] : [],
  });
  return honesty.status as 'needs_work' | 'passed' | 'context_limited';
}

function runCase(c: ComposeCase): { pass: boolean; reason: string } {
  if (c.cohort === 'mode') {
    const cfg = MODE_CONFIGS[c.mode || 'full'];
    for (const [k, v] of Object.entries(c.expect.mode || {})) {
      if ((cfg as any)[k] !== v) {
        return { pass: false, reason: `mode ${c.mode}.${k}=${(cfg as any)[k]} want ${v}` };
      }
    }
    return { pass: true, reason: 'ok' };
  }

  if (c.expect.statusHonesty) {
    const status = statusFromIncompleteSignals(c.pipelineInfo);
    if (status !== c.expect.statusHonesty) {
      return { pass: false, reason: `status ${status} want ${c.expect.statusHonesty}` };
    }
    return { pass: true, reason: 'ok' };
  }

  const stats = emptyGroundingStats();
  const processed = postProcessReviewFindings((c.findings || []) as any[], {
    changedFiles: c.changedFiles,
    groundingStats: stats,
  });
  if (c.cohort === 'dedup' && c.id === 'merge-exact-duplicate-titles') {
    const merged = mergeAndDeduplicateFindings((c.findings || []) as any[]);
    if (c.expect.maxFindings != null && merged.length > c.expect.maxFindings) {
      return { pass: false, reason: `merge count ${merged.length} > ${c.expect.maxFindings}` };
    }
  }

  const ids = new Set(processed.map((f: any) => String(f.id || '')));
  const verdict = verdictFromFindings(processed as any[]);

  if (c.expect.maxFindings != null && processed.length > c.expect.maxFindings) {
    return { pass: false, reason: `findings ${processed.length} > max ${c.expect.maxFindings}` };
  }
  if (c.expect.minFindings != null && processed.length < c.expect.minFindings) {
    return { pass: false, reason: `findings ${processed.length} < min ${c.expect.minFindings}` };
  }
  if (c.expect.verdict && verdict !== c.expect.verdict) {
    return { pass: false, reason: `verdict ${verdict} want ${c.expect.verdict}` };
  }
  if (c.expect.droppedIds) {
    for (const id of c.expect.droppedIds) {
      if (ids.has(id)) return { pass: false, reason: `expected ${id} dropped` };
    }
  }
  if (c.expect.keptIds) {
    for (const id of c.expect.keptIds) {
      if (!ids.has(id)) return { pass: false, reason: `expected ${id} kept; got ${[...ids].join(',')}` };
    }
  }

  // Grounding cohort also checks via groundReviewFindings directly once.
  if (c.cohort === 'grounding' && c.expect.droppedIds?.length) {
    const gStats = emptyGroundingStats();
    groundReviewFindings((c.findings || []) as any[], c.changedFiles, gStats);
    if (gStats.droppedUngroundedCount < 1) {
      return { pass: false, reason: 'expected grounding drop telemetry' };
    }
  }

  return { pass: true, reason: 'ok' };
}

function main(): void {
  const results = CASES.map(c => {
    const r = runCase(c);
    return { id: c.id, cohort: c.cohort, ...r };
  });
  const passed = results.filter(r => r.pass).length;
  const report = {
    harnessKind: 'agent_composition',
    total: CASES.length,
    passed,
    failed: CASES.length - passed,
    accuracy: CASES.length ? passed / CASES.length : 0,
    results,
    note: 'Composition harness over findingsMerger / grounding / verdict / MODE_CONFIGS. Soft unless AGENT_HARNESS_ENFORCE=1.',
  };
  const out = path.join(__dirname, 'last-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.AGENT_HARNESS_ENFORCE === '1' && report.failed > 0) process.exit(1);
  // Hard-fail only when enforce is on; otherwise exit 0 for soft CI visibility.
  // Mirror replay's hard gate once suite is trusted — for now soft like eval.
}

main();
