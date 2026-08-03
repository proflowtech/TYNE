import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEffects } from '../quality/effectDetector';

/**
 * The whole point of the effect detector is that a database or LLM node in the
 * chart is backed by a real call site, not a filename or a guess. These tests
 * pin both halves: it finds genuine effects, and it does NOT invent them from
 * look-alikes such as `Array.from`.
 */

test('detects a supabase table query', () => {
  const sites = detectEffects('src/api.ts', `
    async function load(id) {
      const { data } = await supabase.from('tyne_pm_task_contexts').select('*').eq('id', id);
      return data;
    }
  `);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'database');
  assert.equal(sites[0].target, 'tyne_pm_task_contexts');
  assert.equal(sites[0].functionName, 'load');
  assert.equal(sites[0].verb, 'queries');
});

test('detects an rpc call as a database effect', () => {
  const sites = detectEffects('src/usage.ts', `const r = await supabase.rpc('record_usage_atomic', { uid });`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'database');
  assert.equal(sites[0].target, 'record_usage_atomic()');
});

test('detects an Anthropic LLM call', () => {
  const sites = detectEffects('supabase/functions/review/index.ts', `
    export async function enrich(ctx) {
      const res = await anthropic.messages.create({ model: 'claude-opus-4', messages });
      return res;
    }
  `);
  assert.equal(sites.length, 1, 'the SDK call and the model arg are the same call — count once');
  assert.equal(sites[0].kind, 'llm');
  assert.equal(sites[0].functionName, 'enrich');
});

test('detects an LLM call by model id and normalises it to the provider', () => {
  const sites = detectEffects('src/gen.ts', `const r = await client.create({ model: 'gpt-4o', input });`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'llm');
  assert.equal(sites[0].target, 'OpenAI', 'model id collapses to a provider node');
});

test('classifies fetch to an LLM host as llm and names the provider', () => {
  const sites = detectEffects('src/x.ts', `await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'llm');
  assert.equal(sites[0].target, 'Anthropic');
});

test('a fetch host and a model id in one function collapse to one provider node', () => {
  const sites = detectEffects('src/byok.ts', `
    async function run() {
      const a = await fetch('https://api.openai.com/v1/chat/completions', { body: JSON.stringify({ model: 'gpt-4o-mini' }) });
      return a;
    }
  `);
  const providers = new Set(sites.filter(s => s.kind === 'llm').map(s => s.target));
  assert.deepEqual([...providers], ['OpenAI'], 'host + model must not become two separate LLM nodes');
});

test('detects a plain external fetch', () => {
  const sites = detectEffects('src/x.ts', `await fetch('https://api.github.com/user');`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'external');
  assert.equal(sites[0].target, 'api.github.com');
});

test('does NOT treat Array.from as a database query', () => {
  const sites = detectEffects('src/x.ts', `const arr = Array.from(items); const set = new Set(Array.from(other));`);
  assert.equal(sites.length, 0, 'Array.from is not a table query');
});

test('does NOT flag an ordinary method named select on a local object', () => {
  const sites = detectEffects('src/x.ts', `dropdown.select(2); menu.update();`);
  assert.equal(sites.length, 0, 'select/update on unknown bases must not be a DB effect');
});

test('a migration file is a database effect on its own', () => {
  const sites = detectEffects('supabase/migrations/0012_add_index.sql', 'create index on foo (bar);');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'database');
  assert.equal(sites[0].verb, 'migrates');
});

test('a CSS-only change yields no effect nodes', () => {
  const sites = detectEffects('media/styles.css', '.btn { color: red; }');
  assert.equal(sites.length, 0);
});

test('changedLines filters out effects the diff did not touch', () => {
  const src = [
    'function a() {',                                        // 1
    "  return supabase.from('old_table').select();",        // 2  (unchanged)
    '}',                                                     // 3
    'function b() {',                                        // 4
    "  return supabase.from('new_table').select();",        // 5  (changed)
    '}',                                                     // 6
  ].join('\n');
  const sites = detectEffects('src/x.ts', src, new Set([5]));
  assert.equal(sites.length, 1, 'only the query on a changed line counts');
  assert.equal(sites[0].target, 'new_table');
});

test('detects a prisma model query', () => {
  const sites = detectEffects('src/x.ts', `const u = await prisma.user.findMany({ where });`);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'database');
  assert.equal(sites[0].target, 'user');
});

test('a sql tagged template is a database effect', () => {
  const sites = detectEffects('src/x.ts', "const rows = await sql`select * from users`;");
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, 'database');
});
