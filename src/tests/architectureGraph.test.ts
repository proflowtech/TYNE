import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchitectureGraph } from '../quality/architectureGraph';
import { EffectSite } from '../quality/effectDetector';
import { ChangedFileInfo, TyneValidateReviewFinding } from '../validateReviewTypes';

const file = (path: string, additions = 0, deletions = 0): ChangedFileInfo => ({
  path, status: 'modified', additions, deletions,
});

test('an effect node is created only for a detected call site', () => {
  const effects: EffectSite[] = [
    { file: 'src/api.ts', line: 12, kind: 'database', target: 'users', verb: 'queries', evidence: "supabase.from('users')" },
  ];
  const flow = buildArchitectureGraph({ changedFiles: [file('src/api.ts', 10, 2)], effects });

  const db = flow.nodes.find(n => n.kind === 'database');
  assert.ok(db, 'a database node must exist for the detected query');
  assert.equal(db!.label, 'users');
  assert.equal(db!.evidenceFile, 'src/api.ts');
  assert.equal(db!.evidenceLine, 12);

  const edge = flow.edges.find(e => e.to === db!.id);
  assert.ok(edge, 'an edge must connect the file to what it queries');
  assert.equal(edge!.label, 'queries');
  assert.equal(edge!.kind, 'data');
});

test('a file that reaches nothing produces no effect node', () => {
  const flow = buildArchitectureGraph({ changedFiles: [file('src/pure.ts', 4, 1)], effects: [] });
  assert.equal(flow.nodes.filter(n => n.kind === 'database' || n.kind === 'llm' || n.kind === 'external').length, 0);
  assert.equal(flow.generatedBy, 'local_ast');
});

test('an llm touchpoint becomes an llm node with a calls edge', () => {
  const effects: EffectSite[] = [
    { file: 'supabase/functions/review/index.ts', line: 40, functionName: 'enrich', kind: 'llm', target: 'anthropic', verb: 'calls', evidence: 'anthropic.messages.create(...)' },
  ];
  const flow = buildArchitectureGraph({ changedFiles: [file('supabase/functions/review/index.ts', 60, 20)], effects });
  const llm = flow.nodes.find(n => n.kind === 'llm');
  assert.ok(llm, 'an llm node must be created');
  assert.equal(flow.edges.find(e => e.to === llm!.id)!.kind, 'calls');
});

test('two files hitting the same table share one node with two edges', () => {
  const effects: EffectSite[] = [
    { file: 'src/a.ts', line: 3, kind: 'database', target: 'orders', verb: 'queries', evidence: '' },
    { file: 'src/b.ts', line: 9, kind: 'database', target: 'orders', verb: 'queries', evidence: '' },
  ];
  const flow = buildArchitectureGraph({ changedFiles: [file('src/a.ts'), file('src/b.ts')], effects });
  assert.equal(flow.nodes.filter(n => n.kind === 'database').length, 1, 'one node per distinct table');
  assert.equal(flow.edges.filter(e => e.kind === 'data').length, 2, 'each caller keeps its own edge');
});

test('findings bind to their file node and mark it as a fault', () => {
  const findings: TyneValidateReviewFinding[] = [
    { id: 'F1', file: 'src/api.ts', severity: 'high', category: 'correctness', title: 'x', explanation: '', confidence: 'high' } as TyneValidateReviewFinding,
  ];
  const flow = buildArchitectureGraph({ changedFiles: [file('src/api.ts', 5, 0)], effects: [], findings });
  const node = flow.nodes.find(n => n.file === 'src/api.ts')!;
  assert.deepEqual(node.findingIds, ['F1']);
  assert.equal(node.highlighted, true);
  assert.equal(node.verdict, 'wrong');
});

test('the file budget collapses the overflow into one module node', () => {
  const changedFiles = Array.from({ length: 20 }, (_, i) => file('src/f' + i + '.ts', i, 0));
  const flow = buildArchitectureGraph({ changedFiles, effects: [] });
  assert.ok(flow.nodes.length <= 28, 'must respect the node budget');
  const more = flow.nodes.find(n => n.kind === 'module');
  assert.ok(more, 'dropped files collapse into a +N more node');
  assert.match(more!.label, /more file/);
});

test('a switch decision becomes a diamond fanning to one terminal per case', () => {
  const flow = buildArchitectureGraph({
    changedFiles: [file('src/scope.ts', 8, 2)],
    effects: [],
    decisions: [{
      file: 'src/scope.ts', line: 12, functionName: 'resolve', kind: 'switch', condition: 'scope',
      outcomes: [{ label: 'staged', kind: 'normal' }, { label: 'unstaged', kind: 'normal' }],
    }],
  });
  const dec = flow.nodes.find(n => n.kind === 'decision');
  assert.ok(dec, 'a decision diamond must exist');
  assert.equal(dec!.label, 'scope', 'the diamond asks the condition, not the function name');
  assert.equal(dec!.evidenceLine, 12, 'the diamond is clickable to the branch');
  const terminals = flow.nodes.filter(n => n.kind === 'terminal');
  assert.equal(terminals.length, 2);
  assert.deepEqual(terminals.map(t => t.label).sort(), ['staged', 'unstaged']);
});

test('a guard that throws marks its exit terminal as a fault', () => {
  const flow = buildArchitectureGraph({
    changedFiles: [file('src/x.ts', 3, 0)],
    effects: [],
    decisions: [{
      file: 'src/x.ts', line: 5, functionName: 'f', kind: 'guard', condition: '!provider',
      outcomes: [{ label: 'throws', kind: 'error' }],
    }],
  });
  const term = flow.nodes.find(n => n.kind === 'terminal')!;
  assert.equal(term.label, 'throws');
  assert.equal(term.highlighted, true, 'an error exit is a fault path');
});

test('decisions on a dropped file do not dangle', () => {
  const changedFiles = Array.from({ length: 20 }, (_, i) => file('src/f' + i + '.ts', 1, 0));
  const flow = buildArchitectureGraph({
    changedFiles,
    effects: [],
    decisions: [{ file: 'src/f19.ts', line: 2, kind: 'guard', condition: 'x', outcomes: [{ label: 'returns', kind: 'return' }] }],
  });
  assert.ok(!flow.nodes.some(n => n.kind === 'decision'), 'a decision whose file was dropped is dropped too');
});

test('an effect on a dropped file does not dangle', () => {
  const changedFiles = Array.from({ length: 20 }, (_, i) => file('src/f' + i + '.ts', 1, 0));
  // f19 is beyond the 14-file budget; its effect must not create a floating edge.
  const effects: EffectSite[] = [
    { file: 'src/f19.ts', line: 2, kind: 'database', target: 'ghost', verb: 'queries', evidence: '' },
  ];
  const flow = buildArchitectureGraph({ changedFiles, effects });
  const ghost = flow.nodes.find(n => n.label === 'ghost');
  assert.ok(!ghost, 'an effect whose file was dropped must be dropped too');
  flow.edges.forEach(e => {
    assert.ok(flow.nodes.some(n => n.id === e.from), 'every edge source must exist');
    assert.ok(flow.nodes.some(n => n.id === e.to), 'every edge target must exist');
  });
});
