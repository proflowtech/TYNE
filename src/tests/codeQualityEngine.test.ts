import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runLocalQualityEngine } from '../quality/qualityEngine';
import { scanVibeCode } from '../quality/vibeCodeScanner';
import { estimateComplexity } from '../quality/complexityMetrics';
import { detectClones } from '../quality/cloneDetector';
import { scanArchitecture, layerOf } from '../quality/architectureRules';
import { extractFileFacts } from '../quality/astFacts';
import { scoreQuality } from '../quality/qualityScoring';
import { sanitizeValidateReviewPayload } from '../privacy/payloadSanitizer';

const VIBE_DIFF = [
  'diff --git a/src/service.ts b/src/service.ts',
  '--- a/src/service.ts',
  '+++ b/src/service.ts',
  '@@ -1,0 +1,6 @@',
  '+export function save() {',
  '+  // TODO: implement',
  '+  try { doWork(); } catch (e) {}',
  '+  console.log("debug");',
  '+  return true; // fake for now',
  '+}',
].join('\n');

test('vibe scanner detects placeholder, empty catch, console', () => {
  const findings = scanVibeCode({ diff: VIBE_DIFF, fileFacts: [] });
  assert.ok(findings.some(f => f.ruleId === 'VIBE_PLACEHOLDER' || f.subcategory === 'placeholder'));
  assert.ok(findings.some(f => f.category === 'vibe_code'));
});

test('complexity heuristic counts branches', () => {
  const body = 'function x(){ if(a){} else if(b){} for(;;){} while(c){} }';
  assert.ok(estimateComplexity(body) >= 4);
});

test('clone detector flags similar nearby block', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,0 +1,5 @@',
    '+function normalizeUserEmail(value) {',
    '+  const trimmed = String(value || "").trim().toLowerCase();',
    '+  if (!trimmed.includes("@")) return "";',
    '+  return trimmed;',
    '+}',
  ].join('\n');
  const nearby = [{
    path: 'b.ts',
    content: `
function normalizeUserEmail(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed.includes("@")) return "";
  return trimmed;
}
`,
  }];
  const clones = detectClones({ diff, nearbyContents: nearby });
  assert.ok(clones.length >= 1);
  assert.equal(clones[0].subcategory, 'clone');
});

test('architecture rules detect data importing ui', () => {
  const facts = extractFileFacts('src/data/repo.ts', `import { Widget } from '../components/Widget';\nexport const x = 1;\n`);
  const findings = scanArchitecture([facts]);
  assert.ok(layerOf('src/data/repo.ts') === 'data');
  assert.ok(findings.some(f => f.ruleId === 'QUALITY_LAYER_VIOLATION') || layerOf('src/components/Widget.tsx') === 'ui');
});

test('quality engine returns scorecard and egress summary', async () => {
  const ctx = await runLocalQualityEngine({
    diff: VIBE_DIFF,
    changedFiles: [{ path: 'src/service.ts' }],
    fileContents: [{
      path: 'src/service.ts',
      content: 'export function save() {\n  // TODO\n  try { x(); } catch (e) {}\n  console.log(1);\n}\n',
    }],
  });
  assert.ok(typeof ctx.qualityScore === 'number');
  assert.ok(ctx.scorecard);
  assert.ok(ctx.egressSummary.findingTitles);
  assert.ok(ctx.metrics.debtMinutes >= 0);
  assert.ok(['low', 'medium', 'high'].includes(ctx.vibeCodeRisk));
});

test('python and go facts extract functions', () => {
  const py = extractFileFacts('a.py', 'def foo(x):\n  if x:\n    return 1\n');
  assert.ok(py.functions.some(f => f.name === 'foo'));
  const go = extractFileFacts('a.go', 'func Bar() int {\n  return 1\n}\n');
  assert.ok(go.functions.some(f => f.name === 'Bar'));
});

test('scoring produces section scores and debt', () => {
  const scored = scoreQuality([
    {
      id: '1', ruleId: 'VIBE_PLACEHOLDER', subcategory: 'placeholder', category: 'vibe_code',
      severity: 'high', confidence: 'high', title: 'Placeholder', explanation: 'x', file: 'a.ts',
      evidence: 'TODO', detectedBy: 'ast_rule', blocking: true, debtMinutes: 45,
    },
  ], { maxComplexity: 12, avgComplexity: 6, maxNesting: 3 });
  assert.ok(scored.qualityScore < 100);
  assert.ok(scored.scorecard.vibe < 100);
  assert.equal(scored.sectionScores.find(s => s.id === 'vibe_code')?.score, scored.scorecard.vibe);
  assert.ok(scored.metrics.rating);
  assert.ok(typeof scored.metrics.debtRatio === 'number');
  assert.equal(scored.debtMinutes, 45);
});

test('scorecard vibe matches vibe section score (no contradiction)', () => {
  const scored = scoreQuality([], { maxComplexity: 2, avgComplexity: 1, maxNesting: 1 });
  assert.equal(scored.scorecard.vibe, 100);
  assert.equal(scored.sectionScores.find(s => s.id === 'vibe_code')?.score, 100);
});

test('industry weights: multiple high vibe findings drop score hard', () => {
  const mk = (i: number): any => ({
    id: String(i), ruleId: 'VIBE_PLACEHOLDER', subcategory: 'placeholder', category: 'vibe_code',
    severity: 'high', confidence: 'high', title: `Placeholder ${i}`, explanation: 'x', file: 'a.ts',
    evidence: 'TODO', detectedBy: 'ast_rule', blocking: false, debtMinutes: 20,
  });
  const scored = scoreQuality([mk(1), mk(2), mk(3)], {});
  assert.ok(scored.scorecard.vibe <= 60);
  assert.equal(scored.vibeCodeRisk, 'medium');
});

test('local_compliance strips quality evidence snippets', () => {
  const { request } = sanitizeValidateReviewPayload({
    editedCode: { diff: VIBE_DIFF, changedFiles: [] },
    qualityReview: {
      qualityScore: 70,
      findings: [{ id: '1', title: 'Placeholder', evidence: 'secret snippet TODO', file: 'a.ts', severity: 'high', category: 'vibe_code' }],
      egressSummary: { findingTitles: [{ title: 'Placeholder', severity: 'high' }] },
    },
  }, { privacyMode: 'local_compliance', dataResidency: 'local_only' });
  assert.equal(request.editedCode.diff, '');
  assert.ok(request.qualityReview);
  assert.equal(request.qualityReview.findings[0].evidence, undefined);
  assert.doesNotMatch(JSON.stringify(request.qualityReview), /secret snippet/);
});

test('wire: service and edge and UI include quality engine', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'src/validateReviewService.ts'), 'utf8');
  assert.match(service, /runLocalQualityEngine/);
  assert.match(service, /qualityReview/);
  assert.match(service, /scanForAiSlop/);
  assert.match(service, /\.aiSlop\s*=\s*aiSlop/);
  assert.match(service, /validateAcceptanceCriteria/);
  assert.match(service, /acValidation/);
  assert.match(service, /reviewFilesInParallel/);
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase/functions/tyne-validate-review/index.ts'), 'utf8');
  assert.match(edge, /mergeQualityFindings/);
  assert.match(edge, /untrusted_quality_engine/);
  const js = fs.readFileSync(path.join(process.cwd(), 'media/tyne.js'), 'utf8');
  assert.match(js, /renderQualityScorecard/);
  assert.match(js, /vr-quality-scorecard/);
  assert.match(js, /renderAiSlopPanel/);
  const gate = fs.readFileSync(path.join(process.cwd(), 'src/qualityGateService.ts'), 'utf8');
  assert.match(gate, /low_quality_score/);
  assert.match(gate, /high_tech_debt/);
  const trends = fs.readFileSync(path.join(process.cwd(), 'src/reviewTrendService.ts'), 'utf8');
  assert.match(trends, /getRecurringVibeTitles/);
  const semgrep = fs.readFileSync(path.join(process.cwd(), 'src/quality/semgrepAdapter.ts'), 'utf8');
  assert.match(semgrep, /collectSemgrepFindings/);
});
