import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';

import {
  classifyFindingAction,
  looksLikeCodePatch,
  mayAutoApply,
  buildAgentPrompt,
} from '../actionEngine';
import { qualityFindingsToReviewFindings } from '../quality/qualityEngine';
import type { QualityFinding } from '../quality/qualityTypes';

test('looksLikeCodePatch rejects prose advice', () => {
  assert.equal(looksLikeCodePatch('Prefer async fs.promises APIs.'), false);
  assert.equal(looksLikeCodePatch('Finish the real implementation or remove the stub before merge.'), false);
  assert.equal(looksLikeCodePatch('Remove console.log before merge.'), false);
});

test('looksLikeCodePatch accepts drop-in code', () => {
  assert.equal(looksLikeCodePatch('const x = 1;\nreturn x;'), true);
  assert.equal(looksLikeCodePatch('```ts\nexport function ok() { return true; }\n```'), true);
});

test('prose suggestedFix classifies as guidance and cannot auto-apply', () => {
  const classified = classifyFindingAction({
    file: 'src/a.ts',
    line: 10,
    title: 'Stub body',
    explanation: 'TODO left in place',
    suggestedFix: 'Finish the real implementation or remove the stub before merge.',
    category: 'vibe_code',
    confidence: 'high',
  });
  assert.equal(classified.actionClass, 'guidance');
  assert.equal(classified.suggestedFix, undefined);
  assert.equal(mayAutoApply({ ...classified, file: 'src/a.ts', line: 10, category: 'vibe_code' }), false);
});

test('code patch classifies as applyable and may auto-apply', () => {
  const classified = classifyFindingAction({
    file: 'src/a.ts',
    line: 10,
    endLine: 11,
    title: 'Use const',
    explanation: 'mutable let',
    suggestedFix: 'const value = compute();\nreturn value;',
    category: 'correctness',
    confidence: 'high',
  });
  assert.equal(classified.actionClass, 'applyable');
  assert.ok(classified.suggestedFix?.includes('const value'));
  assert.equal(mayAutoApply({ ...classified, file: 'src/a.ts', line: 10, category: 'correctness' }), true);
});

test('security findings are agent class and never auto-apply', () => {
  const classified = classifyFindingAction({
    file: 'src/a.ts',
    line: 4,
    title: 'Hardcoded secret',
    explanation: 'secret in source',
    suggestedFix: 'const key = process.env.API_KEY;',
    category: 'security',
    confidence: 'high',
  });
  assert.equal(classified.actionClass, 'agent');
  assert.equal(classified.suggestedFix, undefined);
  assert.equal(mayAutoApply({ ...classified, category: 'security', file: 'src/a.ts', line: 4 }), false);
  assert.ok(buildAgentPrompt({
    file: 'src/a.ts',
    line: 4,
    title: 'Hardcoded secret',
    explanation: 'secret in source',
    remediation: 'Move to env',
  }).includes('## Finding'));
});

test('qualityFindingsToReviewFindings reclassifies prose suggestedFix', () => {
  const findings: QualityFinding[] = [{
    id: 'q1',
    ruleId: 'VIBE_STUB',
    subcategory: 'placeholder',
    category: 'vibe_code',
    severity: 'high',
    confidence: 'high',
    title: 'Stub',
    explanation: 'empty body',
    file: 'src/x.ts',
    line: 3,
    evidence: 'TODO',
    suggestedFix: 'Finish the real implementation or remove the stub before merge.',
    detectedBy: 'ast_rule',
    blocking: false,
  }];
  const mapped = qualityFindingsToReviewFindings(findings);
  assert.equal(mapped[0].actionClass, 'guidance');
  assert.equal(mapped[0].suggestedFix, undefined);
  assert.ok(String(mapped[0].agentPrompt || '').includes('src/x.ts'));
});

test('autoApplyPolicy never blocks even applyable patches', () => {
  const finding = {
    file: 'src/a.ts',
    line: 1,
    suggestedFix: 'const a = 1;',
    category: 'correctness',
    confidence: 'high',
    actionClass: 'applyable' as const,
  };
  assert.equal(mayAutoApply(finding, 'applyable_only'), true);
  assert.equal(mayAutoApply(finding, 'never'), false);
});

test('honest action engine wiring exists across host, UI, edge, and diagnostics', () => {
  const host = fs.readFileSync(path.join(process.cwd(), 'src', 'TyneSidebarProvider.ts'), 'utf8');
  const ui = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.js'), 'utf8');
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase', 'functions', 'tyne-validate-review', 'index.ts'), 'utf8');
  const diag = fs.readFileSync(path.join(process.cwd(), 'src', 'reviewDiagnosticsService.ts'), 'utf8');
  const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');

  assert.ok(host.includes("case 'agentFix'"), 'host must route Agent Fix');
  assert.ok(host.includes('mayAutoApply'), 'host must gate WorkspaceEdit apply');
  assert.ok(host.includes('_logApplyAudit'), 'host must audit apply/agent events');
  assert.ok(ui.includes('Fix in IDE'), 'UI must expose Fix in IDE');
  assert.ok(ui.includes("actionClass === 'applyable'"), 'UI must require applyable for Fix');
  assert.ok(host.includes('_handoffPromptToIdeAgent'), 'host must hand off prompts into the IDE agent');
  assert.ok(edge.includes('function classifyFindingAction'), 'edge must classify findings');
  assert.ok(diag.includes('mayAutoApply'), 'diagnostics quick-fix must share apply gate');
  assert.ok(pkg.includes('tyne.actionEngine.autoApplyPolicy'), 'org policy setting must be contributed');
});
