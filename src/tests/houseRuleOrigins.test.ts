import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { parseHouseRules, type HouseRule } from '../quality/learningsStore';

/**
 * House-rule findings are the model judging natural-language conventions —
 * the only detector in the pipeline that cannot ground its own output. These
 * tests pin the guards that make that acceptable: capped volume, capped
 * confidence, and no fabricated attributions.
 */

let originalLoad: unknown;
let attach: (findings: Array<Record<string, unknown>>, rules: HouseRule[]) => Array<Record<string, unknown>>;

before(() => {
  // validateReviewService imports vscode at module scope; the method under
  // test is pure, so stub it the way the rest of the suite does.
  // @ts-expect-error Node internal
  originalLoad = Module._load;
  // @ts-expect-error Node internal
  Module._load = function (request: string, parent: NodeModule, isMain: boolean) {
    if (request === 'vscode') {
      return {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
        window: {},
        Uri: { joinPath: () => ({}), file: () => ({}) },
      };
    }
    // @ts-expect-error Node internal
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve('../validateReviewService')];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../validateReviewService');
  const instance = Object.create(mod.ValidateReviewService.prototype);
  attach = instance._attachHouseRuleOrigins.bind(instance);
});

after(() => {
  // @ts-expect-error Node internal
  Module._load = originalLoad;
});

const RULES = () => parseHouseRules([
  '## Require',
  '- Use Result<T,E> instead of throwing (src/core/**)',
  '- Every exported function needs a JSDoc block',
].join('\n'));

test('attaches provenance pointing at the exact rule line', () => {
  const [finding] = attach([{ id: '1', title: 'Throws instead of Result', ruleId: 'HR1' }], RULES());
  assert.equal((finding.houseRule as Record<string, unknown>).id, 'HR1');
  assert.equal((finding.houseRule as Record<string, unknown>).source, '.tyne/learnings.md:2');
  assert.match(String((finding.houseRule as Record<string, unknown>).text), /Result<T,E>/);
});

test('matches the rule id case-insensitively', () => {
  const [finding] = attach([{ id: '1', title: 'Missing JSDoc', ruleId: 'hr2' }], RULES());
  assert.equal((finding.houseRule as Record<string, unknown>).id, 'HR2');
});

test('leaves ordinary engine findings completely untouched', () => {
  const [finding] = attach([{ id: '1', title: 'Console left in code', ruleId: 'VIBE_CONSOLE', confidence: 'high', severity: 'critical' }], RULES());
  assert.equal(finding.houseRule, undefined);
  assert.equal(finding.confidence, 'high', 'a deterministic finding must keep its confidence');
  assert.equal(finding.severity, 'critical', 'and its severity');
});

test('a finding with no ruleId at all passes through', () => {
  const out = attach([{ id: '1', title: 'Some finding' }], RULES());
  assert.equal(out.length, 1);
  assert.equal(out[0].houseRule, undefined);
});

test('SAFETY: caps confidence — a house rule is judgment, never proof', () => {
  const [finding] = attach([{ id: '1', title: 'x', ruleId: 'HR1', confidence: 'high' }], RULES());
  assert.equal(finding.confidence, 'medium');
});

test('SAFETY: caps severity — a team convention is never critical', () => {
  const [finding] = attach([{ id: '1', title: 'x', ruleId: 'HR1', severity: 'critical' }], RULES());
  assert.equal(finding.severity, 'high');
});

test('SAFETY: drops a fabricated rule citation that was never sent', () => {
  // The model inventing "HR9" would otherwise render as a real finding with
  // bogus provenance. Engine ruleIds must still pass through.
  const out = attach([
    { id: '1', title: 'Engine finding', ruleId: 'VIBE_CONSOLE' },
    { id: '2', title: 'Real rule hit', ruleId: 'HR1' },
    { id: '3', title: 'Fabricated citation', ruleId: 'HR9' },
  ], RULES());
  assert.deepEqual(out.map(f => f.id), ['1', '2']);
});

test('SAFETY: caps how many findings one review may attribute to house rules', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, title: 'x', ruleId: 'HR1' }));
  const out = attach(many, RULES());
  assert.ok(out.length <= 8, `one vague rule must not flood a review, got ${out.length}`);
});

test('does nothing at all when the team has no house rules', () => {
  const findings = [{ id: '1', title: 'x', ruleId: 'HR1', confidence: 'high' }];
  const out = attach(findings, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'high', 'with no rules loaded, nothing is reinterpreted');
});
