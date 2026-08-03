import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDecisions } from '../quality/branchDetector';

test('detects an early-return guard that throws', () => {
  const sites = detectDecisions('src/x.ts', `
    function verify(provider) {
      if (!provider) { throw new Error('missing'); }
      return provider.ok;
    }
  `);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'guard');
  assert.equal(sites[0].condition, '!provider');
  assert.equal(sites[0].functionName, 'verify');
  assert.equal(sites[0].outcomes[0].label, 'throws');
  assert.equal(sites[0].outcomes[0].kind, 'error');
});

test('detects a bare early return guard', () => {
  const sites = detectDecisions('src/x.ts', `function f(x) { if (x === undefined) return; work(x); }`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].outcomes[0].label, 'returns');
});

test('detects a switch with its case labels', () => {
  const sites = detectDecisions('src/x.ts', `
    function route(status) {
      switch (status) {
        case 'connected': return verify();
        case 'disconnected': return noop();
        default: return null;
      }
    }
  `);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'switch');
  assert.equal(sites[0].condition, 'status');
  assert.deepEqual(sites[0].outcomes.map(o => o.label), ['connected', 'disconnected', 'default']);
});

test('does NOT promote a plain if/else with no clear exit', () => {
  const sites = detectDecisions('src/x.ts', `function f(x) { if (x) { a(); } else { b(); } }`);
  assert.equal(sites.length, 0, 'we cannot say where each arm flows, so we do not guess');
});

test('does NOT promote a deeply nested guard', () => {
  const sites = detectDecisions('src/x.ts', `
    function f(a, b) {
      if (a) {
        for (const x of b) {
          if (!x) { return; }   // depth 2 — too deep to stay legible
        }
      }
    }
  `);
  assert.equal(sites.length, 0);
});

test('changedLines filters branches the diff did not touch', () => {
  const src = [
    'function f(a, b) {',                 // 1
    '  if (!a) { throw new Error(); }',   // 2 (unchanged)
    '  if (!b) { return; }',              // 3 (changed)
    '  return a + b;',                    // 4
    '}',                                  // 5
  ].join('\n');
  const sites = detectDecisions('src/x.ts', src, new Set([3]));
  assert.equal(sites.length, 1, 'only the guard on a changed line counts');
  assert.equal(sites[0].condition, '!b');
});

test('a non-code file yields no decisions', () => {
  assert.equal(detectDecisions('media/x.css', '.a{if:0}').length, 0);
});
