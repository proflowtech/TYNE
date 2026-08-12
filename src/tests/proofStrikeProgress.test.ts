import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('validation streams proof_strike_progress and webview animates strikes', () => {
  const perf = read('src', 'reviewPerformance.ts');
  const service = read('src', 'validateReviewService.ts');
  const js = read('media', 'tyne.js');
  const css = read('media', 'tyne.css');

  assert.match(perf, /proof_strike_progress/, 'progress event type must exist');
  assert.match(service, /type: 'proof_strike_progress'/, 'AC pass must emit proof strikes');
  assert.match(js, /msg\.type === 'proof_strike_progress'/, 'webview must handle live strikes');
  assert.match(js, /function startProofLive/, 'live proof mode required');
  assert.match(js, /function finalizeProofLiveFromResult/, 'final done\/not-done required');
  assert.match(js, /buildProofLiveList/, 'summary must list proof points');
  assert.match(js, /valFullReportBtn/, 'must keep open full report');
  assert.match(css, /text-decoration:\s*line-through/, 'full-text strikethrough required');
  assert.match(css, /\.proof-live/, 'live proof list styles required');
  assert.match(js, /valPanelState === 'running'/, 'running review must gate checklist visibility');
  assert.match(js, /pendingMetTexts/, 'AC strikes buffered until review completes');
  assert.match(js, /list\.classList\.add\('hidden'\)/, 'proof checklist hidden while reviewing');
});
