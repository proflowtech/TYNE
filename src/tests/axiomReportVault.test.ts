import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AxiomReportVault,
  mergeAxiomReports,
} from '../axiomReportVault';
import type { TyneValidateReviewResult } from '../validateReviewTypes';

function minimalReport(partial: Partial<TyneValidateReviewResult> & { id?: string }): TyneValidateReviewResult {
  return {
    id: partial.id,
    scope: 'staged_changes',
    status: 'needs_work',
    score: 72,
    riskLevel: 'medium',
    vibeCodeRisk: 'low',
    summary: 'Test report.',
    findings: [],
    completedGoals: [],
    pendingGoals: [],
    missingTests: [],
    nextActions: [],
    visualDiff: [],
    createdAt: partial.createdAt || new Date().toISOString(),
    ...partial,
  } as TyneValidateReviewResult;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tyne-axiom-vault-'));
}

test('axiom vault round-trips encrypt/decrypt and lists newest first', async () => {
  const root = await tempRoot();
  const vault = new AxiomReportVault({ rootDir: root });
  const a = await vault.saveReport(minimalReport({
    id: 'rep-a',
    summary: 'Older',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const b = await vault.saveReport(minimalReport({
    id: 'rep-b',
    summary: 'Newer',
    createdAt: '2026-06-01T00:00:00.000Z',
  }));
  assert.equal(a.id, 'rep-a');
  assert.equal(b.id, 'rep-b');

  const got = await vault.getReport('rep-a');
  assert.ok(got);
  assert.equal(got!.summary, 'Older');
  assert.equal(got!.score, 72);

  const listed = await vault.listReports(10);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, 'rep-b');
  assert.equal(listed[1].id, 'rep-a');

  // On-disk blobs are not plaintext JSON.
  const files = await fs.readdir(path.join(root, 'axiom-reports'));
  const enc = files.find(f => f.endsWith('.json.enc'));
  assert.ok(enc);
  const raw = await fs.readFile(path.join(root, 'axiom-reports', enc!));
  assert.equal(raw.includes(Buffer.from('Older')), false);
});

test('axiom vault assigns id when missing', async () => {
  const root = await tempRoot();
  const vault = new AxiomReportVault({ rootDir: root });
  const saved = await vault.saveReport(minimalReport({ id: undefined, summary: 'No id' }));
  assert.ok(saved.id);
  const listed = await vault.listReports();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, saved.id);
});

test('mergeAxiomReports prefers newer createdAt and keeps local-only rows', () => {
  const local = [
    minimalReport({ id: 'only-local', createdAt: '2026-07-01T00:00:00.000Z', summary: 'local' }),
    minimalReport({ id: 'shared', createdAt: '2026-05-01T00:00:00.000Z', summary: 'local-old' }),
  ];
  const cloud = [
    minimalReport({ id: 'shared', createdAt: '2026-06-01T00:00:00.000Z', summary: 'cloud-new' }),
    minimalReport({ id: 'only-cloud', createdAt: '2026-04-01T00:00:00.000Z', summary: 'cloud' }),
  ];
  const merged = mergeAxiomReports(local, cloud, 50);
  assert.equal(merged.length, 3);
  const shared = merged.find(r => r.id === 'shared');
  assert.equal(shared?.summary, 'cloud-new');
  assert.ok(merged.some(r => r.id === 'only-local'));
  assert.ok(merged.some(r => r.id === 'only-cloud'));
});

test('controller and service wire local vault save + list merge', () => {
  const fsSync = require('fs') as typeof import('fs');
  const pathMod = require('path') as typeof import('path');
  const controller = fsSync.readFileSync(
    pathMod.join(process.cwd(), 'src/sidebar/validateReviewController.ts'),
    'utf8',
  );
  const service = fsSync.readFileSync(
    pathMod.join(process.cwd(), 'src/validateReviewService.ts'),
    'utf8',
  );
  assert.match(controller, /getAxiomReportVault\(\)\.saveReport/);
  assert.match(service, /mergeAxiomReports/);
  assert.match(service, /getAxiomReportVault\(\)\.listReports/);
  assert.ok(
    !service.includes("Authentication token is required to load report history"),
    'listReports must not require auth when local vault exists',
  );
});
