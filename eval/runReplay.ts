/**
 * Deterministic replay of grounding + verdict (zero LLM).
 * Usage: npm run test:replay
 */

import * as fs from 'fs';
import * as path from 'path';
import { groundReviewFindings, emptyGroundingStats } from '../src/services/findingGrounding';
import { postProcessReviewFindings } from '../src/services/findingsMerger';
import { verdictFromFindings } from '../src/validateReviewTypes';

interface ReplayFixture {
  id: string;
  description?: string;
  changedFiles: Array<{ path?: string; file?: string; status?: string }>;
  rawFindings: Array<Record<string, unknown>>;
  expect: {
    droppedIds?: string[];
    keptFiles?: string[];
    verdict?: string;
    minDropped?: number;
  };
}

const ROOT = path.join(__dirname, 'replay');

function loadFixtures(): ReplayFixture[] {
  if (!fs.existsSync(ROOT)) { return []; }
  return fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) as ReplayFixture);
}

function runFixture(fx: ReplayFixture): { pass: boolean; reason: string } {
  const stats = emptyGroundingStats();
  const grounded = groundReviewFindings(
    fx.rawFindings as any[],
    fx.changedFiles,
    stats,
  );
  const processed = postProcessReviewFindings(grounded as any[], {
    changedFiles: fx.changedFiles,
  });
  const verdict = verdictFromFindings(processed as any[]);
  const keptIds = new Set(processed.map((f: any) => String(f.id || '')));
  const keptFiles = processed.map((f: any) => String(f.file || ''));

  if (fx.expect.droppedIds) {
    for (const id of fx.expect.droppedIds) {
      if (keptIds.has(id)) {
        return { pass: false, reason: `expected finding ${id} to be dropped` };
      }
    }
  }
  if (typeof fx.expect.minDropped === 'number' && stats.droppedUngroundedCount < fx.expect.minDropped) {
    return {
      pass: false,
      reason: `expected ≥${fx.expect.minDropped} dropped, got ${stats.droppedUngroundedCount}`,
    };
  }
  if (fx.expect.keptFiles) {
    for (const file of fx.expect.keptFiles) {
      if (!keptFiles.includes(file)) {
        return { pass: false, reason: `expected kept file ${file}, got ${keptFiles.join(',')}` };
      }
    }
  }
  if (fx.expect.verdict && verdict !== fx.expect.verdict) {
    return { pass: false, reason: `expected verdict ${fx.expect.verdict}, got ${verdict}` };
  }
  return { pass: true, reason: 'ok' };
}

function main(): void {
  const fixtures = loadFixtures();
  if (!fixtures.length) {
    console.error('No replay fixtures under eval/replay/');
    process.exit(1);
  }
  let failed = 0;
  for (const fx of fixtures) {
    const result = runFixture(fx);
    const mark = result.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${fx.id}${result.pass ? '' : ` — ${result.reason}`}`);
    if (!result.pass) { failed += 1; }
  }
  console.log(`\n${fixtures.length - failed}/${fixtures.length} replay fixtures passed`);
  process.exit(failed ? 1 : 0);
}

main();
