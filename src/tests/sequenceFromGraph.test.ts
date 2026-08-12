import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchitectureSequence } from '../quality/sequenceFromGraph';

test('sequence requires at least two chain messages', () => {
  const none = buildArchitectureSequence({
    nodes: [
      { id: 'a', label: 'A', changed: true },
      { id: 'b', label: 'B', kind: 'database' },
    ],
    edges: [{ from: 'a', to: 'b', kind: 'data', label: 'queries' }],
  });
  assert.equal(none, undefined);
});

test('sequence emits messages and mermaid when a chain exists', () => {
  const seq = buildArchitectureSequence({
    nodes: [
      { id: 'ui', label: 'panel.tsx', changed: true, kind: 'ui' },
      { id: 'api', label: 'api.ts', changed: true, kind: 'api' },
      { id: 'db', label: 'users', kind: 'database' },
    ],
    edges: [
      { from: 'ui', to: 'api', kind: 'imports', label: 'imports' },
      { from: 'api', to: 'db', kind: 'data', label: 'queries' },
    ],
  });
  assert.ok(seq);
  assert.ok(seq!.sequence.messages.length >= 2);
  assert.match(seq!.mermaid, /sequenceDiagram/);
  assert.match(seq!.mermaid, /queries|imports/);
});
