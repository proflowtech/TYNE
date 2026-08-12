/**
 * LLM-shaped contract smoke — recorded bags through host post-process.
 * No live API by default. Optional EVAL_LLM=1 reserved for future live smoke.
 *
 * Usage: npm run test:llm-smoke
 * Soft by default; set LLM_SMOKE_ENFORCE=1 to fail CI.
 */

import * as fs from 'fs';
import * as path from 'path';
import { emptyGroundingStats } from '../../src/services/findingGrounding';
import { postProcessReviewFindings } from '../../src/services/findingsMerger';
import { verdictFromFindings } from '../../src/validateReviewTypes';

interface SmokeFixture {
  id: string;
  description?: string;
  changedFiles: Array<{ path?: string; file?: string; status?: string }>;
  /** Recorded LLM-shaped JSON finding bag (not live). */
  llmFindings: Array<Record<string, unknown>>;
  expect: {
    /** Paths outside the changed set must not survive post-process (unless deterministic). */
    mustNotKeepFiles?: string[];
    mustKeepFiles?: string[];
    minFindings?: number;
    maxFindings?: number;
    verdict?: string;
    schemaHasFindingsArray?: boolean;
  };
}

const ROOT = path.join(__dirname, 'fixtures');

function loadFixtures(): SmokeFixture[] {
  if (!fs.existsSync(ROOT)) { return []; }
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) as SmokeFixture);
}

function runFixture(fx: SmokeFixture): { pass: boolean; reason: string } {
  if (!Array.isArray(fx.llmFindings)) {
    return { pass: false, reason: 'llmFindings must be an array (schema contract)' };
  }
  const stats = emptyGroundingStats();
  const processed = postProcessReviewFindings(fx.llmFindings as any[], {
    changedFiles: fx.changedFiles,
    groundingStats: stats,
  });
  const files = processed.map((f: any) => String(f.file || ''));
  const verdict = verdictFromFindings(processed as any[]);

  if (fx.expect.schemaHasFindingsArray !== false && !Array.isArray(processed)) {
    return { pass: false, reason: 'post-process must return findings array' };
  }
  if (fx.expect.mustNotKeepFiles) {
    for (const bad of fx.expect.mustNotKeepFiles) {
      if (files.includes(bad)) {
        return { pass: false, reason: `invented/out-of-diff path survived: ${bad}` };
      }
    }
  }
  if (fx.expect.mustKeepFiles) {
    for (const good of fx.expect.mustKeepFiles) {
      if (!files.includes(good)) {
        return { pass: false, reason: `expected kept file ${good}, got ${files.join(',')}` };
      }
    }
  }
  if (fx.expect.minFindings != null && processed.length < fx.expect.minFindings) {
    return { pass: false, reason: `findings ${processed.length} < min ${fx.expect.minFindings}` };
  }
  if (fx.expect.maxFindings != null && processed.length > fx.expect.maxFindings) {
    return { pass: false, reason: `findings ${processed.length} > max ${fx.expect.maxFindings}` };
  }
  if (fx.expect.verdict && verdict !== fx.expect.verdict) {
    return { pass: false, reason: `verdict ${verdict} want ${fx.expect.verdict}` };
  }
  return { pass: true, reason: 'ok' };
}

function main(): void {
  if (process.env.EVAL_LLM === '1') {
    // Optional live path: require an API key and fail closed when EVAL_LLM_REQUIRED=1.
    const key = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.TYNE_EVAL_LLM_KEY;
    if (!key) {
      console.error('EVAL_LLM=1 but no OPENAI_API_KEY / ANTHROPIC_API_KEY / TYNE_EVAL_LLM_KEY set.');
      if (process.env.EVAL_LLM_REQUIRED === '1') { process.exit(1); }
      console.warn('Falling back to recorded contract fixtures.');
    } else {
      console.warn('EVAL_LLM=1 live calls are reserved — running contract fixtures as the release gate.');
    }
  }
  const fixtures = loadFixtures();
  if (!fixtures.length) {
    console.error('No llmSmoke fixtures under eval/llmSmoke/fixtures/');
    process.exit(1);
  }
  let failed = 0;
  for (const fx of fixtures) {
    const r = runFixture(fx);
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`${mark} ${fx.id}${r.pass ? '' : ` — ${r.reason}`}`);
    if (!r.pass) { failed += 1; }
  }
  const report = {
    total: fixtures.length,
    failed,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, 'last-report.json'), JSON.stringify(report, null, 2));
  console.log(`llmSmoke: ${fixtures.length - failed}/${fixtures.length} passed`);
  if (failed > 0 && process.env.LLM_SMOKE_ENFORCE === '1') {
    process.exit(1);
  }
}

main();
