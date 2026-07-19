import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFileFacts, extractFileFactsAsync } from '../quality/astFacts';

const TS_FIXTURE = `
import { createClient } from '@supabase/supabase-js';
export interface User { id: string; email: string }
export type Role = 'admin' | 'user';
export async function saveUser(user: User): Promise<void> {
  const db = createClient('x', 'y');
  await db.from('users').insert(user);
}
export const handler = async (req: Request) => {
  return new Response('ok');
};
`;

const PY_FIXTURE = `
from flask import Flask
def create_app():
    app = Flask(__name__)
    return app

class Store:
    def save(self, item):
        return item
`;

describe('AST facts', () => {
  test('TypeScript compiler extracts functions, imports, signatures', () => {
    const facts = extractFileFacts('src/user.ts', TS_FIXTURE);
    assert.equal(facts.parser, 'typescript');
    assert.ok(facts.functions.some(f => f.name === 'saveUser'));
    assert.ok(facts.imports.some(i => i.module === '@supabase/supabase-js'));
    assert.ok(facts.signatures?.some(s => s.kind === 'interface' && s.name === 'User'));
    assert.ok(facts.signatures?.some(s => s.name === 'saveUser'));
    assert.ok(facts.exports.some(e => e.name === 'saveUser'));
  });

  test('Python uses regex fallback with functions/imports', () => {
    const facts = extractFileFacts('app.py', PY_FIXTURE);
    assert.equal(facts.parser, 'regex');
    assert.ok(facts.functions.some(f => f.name === 'create_app'));
    assert.ok(facts.imports.some(i => i.module.includes('flask') || i.raw.includes('flask')));
  });

  test('async path falls back when Tree-Sitter WASM grammars absent', async () => {
    const facts = await extractFileFactsAsync('src/user.ts', TS_FIXTURE);
    assert.ok(facts.parser === 'typescript' || facts.parser === 'tree-sitter');
    assert.ok(facts.functions.some(f => f.name === 'saveUser'));
  });
});
