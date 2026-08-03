import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';

import {
  classifyFindingAction,
  looksLikeCodePatch,
  mayAutoApply,
  buildAgentPrompt,
  buildBatchAgentPrompt,
  partitionFindingsByActionClass,
  sortFindingsBySeverity,
  BATCH_AGENT_PROMPT_MAX,
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

test('buildAgentPrompt includes codeSnippet evidence and structured fix diff', () => {
  const prompt = buildAgentPrompt({
    file: 'src/a.ts',
    line: 12,
    title: 'Token is logged',
    explanation: 'Secrets in logs can be replayed.',
    codeSnippet: "console.log('auth', accessToken);",
    fix: { diff: "- console.log('auth', accessToken);\n+ console.log('auth ok');" },
  });
  assert.ok(prompt.includes("console.log('auth', accessToken);"), 'evidence must come from codeSnippet');
  assert.ok(prompt.includes('## Proposed fix'), 'structured fix diff must be included');
  assert.ok(prompt.includes('line numbers may have drifted'), 'must warn about line drift when evidence exists');
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

test('partitionFindingsByActionClass splits applyable, agent, and guidance', () => {
  const part = partitionFindingsByActionClass([
    {
      id: 'a1',
      file: 'src/a.ts',
      line: 10,
      suggestedFix: 'const value = compute();\nreturn value;',
      category: 'correctness',
      confidence: 'high',
    },
    {
      id: 's1',
      file: 'src/a.ts',
      line: 4,
      suggestedFix: 'const key = process.env.API_KEY;',
      category: 'security',
      confidence: 'high',
    },
    {
      id: 'g1',
      file: 'src/a.ts',
      line: 8,
      suggestedFix: 'Finish the real implementation or remove the stub before merge.',
      category: 'vibe_code',
      confidence: 'high',
    },
  ]);
  assert.equal(part.applyable.length, 1);
  assert.equal(part.applyable[0].id, 'a1');
  assert.equal(part.agent.length, 1);
  assert.equal(part.agent[0].id, 's1');
  assert.equal(part.guidance.length, 1);
  assert.equal(part.guidance[0].id, 'g1');
  assert.equal(mayAutoApply(part.applyable[0]), true);
  assert.equal(mayAutoApply(part.agent[0]), false);
  assert.equal(mayAutoApply(part.guidance[0]), false);
});

test('buildBatchAgentPrompt includes ids, severity order, and shared rules', () => {
  const prompt = buildBatchAgentPrompt([
    {
      id: 'low-1',
      file: 'src/b.ts',
      line: 2,
      title: 'Minor nit',
      severity: 'low',
      category: 'style',
      codeSnippet: 'let x = 1;',
      remediation: 'Prefer const',
    },
    {
      id: 'crit-1',
      file: 'src/a.ts',
      line: 9,
      title: 'Null deref',
      severity: 'critical',
      category: 'correctness',
      explanation: 'user may be undefined',
      codeSnippet: 'user.name',
      fix: { diff: '- user.name\n+ user?.name' },
    },
  ]);
  assert.ok(prompt.includes('2 Tyne Validate & Review finding'));
  assert.ok(prompt.includes('[crit-1]'));
  assert.ok(prompt.includes('[low-1]'));
  assert.ok(prompt.includes('no drive-by refactors'));
  assert.ok(prompt.includes('fixed IDs, skipped IDs'));
  const critAt = prompt.indexOf('[crit-1]');
  const lowAt = prompt.indexOf('[low-1]');
  assert.ok(critAt >= 0 && lowAt > critAt, 'critical finding must appear before low');
});

test('buildBatchAgentPrompt caps at BATCH_AGENT_PROMPT_MAX and notes omission', () => {
  const many = Array.from({ length: BATCH_AGENT_PROMPT_MAX + 3 }, (_, i) => ({
    id: `f-${i}`,
    file: 'src/a.ts',
    line: i + 1,
    title: `Finding ${i}`,
    severity: 'medium',
    category: 'correctness',
    codeSnippet: `const n${i} = ${i};`,
  }));
  const prompt = buildBatchAgentPrompt(many);
  assert.ok(prompt.includes(`You are fixing ${BATCH_AGENT_PROMPT_MAX} Tyne`));
  assert.ok(prompt.includes('were omitted from this prompt'));
  assert.ok(prompt.includes('[f-0]'));
  assert.equal(prompt.includes(`[f-${BATCH_AGENT_PROMPT_MAX}]`), false);
});

test('sortFindingsBySeverity is stable for equal severity', () => {
  const sorted = sortFindingsBySeverity([
    { id: 'a', severity: 'medium' },
    { id: 'b', severity: 'critical' },
    { id: 'c', severity: 'medium' },
  ]);
  assert.deepEqual(sorted.map(f => f.id), ['b', 'a', 'c']);
});

test('honest action engine wiring exists across host, UI, edge, and diagnostics', () => {
  const host = fs.readFileSync(path.join(process.cwd(), 'src', 'TyneSidebarProvider.ts'), 'utf8')
    + '\n' + fs.readFileSync(path.join(process.cwd(), 'src', 'sidebar', 'findingFixController.ts'), 'utf8')
    + '\n' + fs.readFileSync(path.join(process.cwd(), 'src', 'sidebar', 'messageRouter.ts'), 'utf8');
  const ui = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.js'), 'utf8');
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase', 'functions', 'tyne-validate-review', 'index.ts'), 'utf8');
  const diag = fs.readFileSync(path.join(process.cwd(), 'src', 'reviewDiagnosticsService.ts'), 'utf8');
  const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');

  assert.ok(host.includes("case 'agentFix'"), 'host must route Agent Fix');
  assert.ok(host.includes("case 'applyFixesBatch'"), 'host must route batch Apply');
  assert.ok(host.includes("case 'agentFixBatch'"), 'host must route batch Agent Fix');
  assert.ok(host.includes("case 'fixSelectedBatch'"), 'host must route Fix selected');
  assert.ok(host.includes('buildBatchAgentPrompt'), 'host must build batch agent prompts');
  assert.ok(host.includes('mayAutoApply'), 'host must gate WorkspaceEdit apply');
  assert.ok(host.includes('logApplyAudit'), 'host must audit apply/agent events');
  assert.ok(ui.includes('Fix in IDE'), 'UI must expose Fix in IDE');
  assert.ok(ui.includes("actionClass === 'applyable'"), 'UI must require applyable for Fix');
  assert.ok(ui.includes('batch_fix_selected'), 'UI must expose Fix selected');
  assert.ok(ui.includes('batch_apply_safe'), 'UI must expose Apply N safe');
  assert.ok(ui.includes('batch_agent_fix'), 'UI must expose Send M to agent');
  assert.ok(ui.includes('vr-batch-check'), 'UI must expose batch checkboxes');
  assert.ok(ui.includes('syncBatchFixBarDom'), 'UI must update batch bar without full re-render');
  assert.ok(host.includes('handoffPromptToIdeAgent'), 'host must hand off prompts into the IDE agent');
  assert.ok(edge.includes('function classifyFindingAction'), 'edge must classify findings');
  assert.ok(diag.includes('mayAutoApply'), 'diagnostics quick-fix must share apply gate');
  assert.ok(pkg.includes('tyne.actionEngine.autoApplyPolicy'), 'org policy setting must be contributed');
});
