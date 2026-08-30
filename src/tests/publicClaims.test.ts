import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const adapters = readFileSync(join(root, 'src/taskProviderAdapters.ts'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

/**
 * Public claims must match shipped behaviour. VS Code renders every
 * `contributes.configuration` entry in the Settings UI and on the Marketplace
 * listing, so a setting is a public claim just as much as a README line is.
 *
 * The specific drift these guard: Asana, Notion and Monday adapters have stub
 * `pullTasks` implementations that return `[]`, so no task can ever reach the
 * UI through them — while their API-key settings were described as though the
 * integration worked.
 */

/** Providers whose adapter cannot pull tasks, so cannot drive the task UI. */
function stubbedProviders(): string[] {
  const out: string[] = [];
  for (const m of adapters.matchAll(/class (\w+)TaskAdapter[\s\S]*?\n\}/g)) {
    const [body, name] = [m[0], m[1]];
    const pull = body.match(/async pullTasks\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/);
    if (!pull) continue;
    // Strip the shared connection guard; what remains is the real body.
    const meat = pull[1]
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('if (!') && !l.startsWith('//'))
      .join(' ');
    if (meat === 'return [];') out.push(name.toLowerCase());
  }
  return out;
}

describe('public claims match shipped code', () => {
  it('detects which PM adapters are stubs', () => {
    const stubs = stubbedProviders();
    // Guards the detector itself: if these ever become real, this test should
    // fail loudly so the claims can be upgraded deliberately.
    assert.deepEqual(stubs.sort(), ['asana', 'monday', 'notion']);
  });

  it('never advertises a stubbed provider as a working integration', () => {
    const stubs = stubbedProviders();
    const config = pkg.contributes?.configuration?.properties || {};
    for (const [key, value] of Object.entries<Record<string, string>>(config)) {
      const provider = key.match(/^tyne\.(\w+)\./)?.[1]?.toLowerCase();
      if (!provider || !stubs.includes(provider)) continue;
      const text = String(value.markdownDescription || value.description || '');
      assert.match(
        text,
        /experimental|not a supported integration|has no effect/i,
        `Setting "${key}" advertises ${provider}, whose adapter cannot pull tasks. `
          + 'Either implement pullTasks or mark the setting experimental.',
      );
    }
  });

  it('README lists only integrations that can actually pull tasks as Live', () => {
    const stubs = stubbedProviders();
    // The integrations table marks working providers with "Live".
    const liveRows = [...readme.matchAll(/^\|\s*(\w[\w ]*?)\s*\|\s*Live[^|]*\|/gm)]
      .map(m => m[1].trim().toLowerCase());
    for (const stub of stubs) {
      assert.ok(
        !liveRows.includes(stub),
        `README marks "${stub}" as Live, but its adapter returns no tasks.`,
      );
    }
    // Sanity: the table is being parsed at all.
    assert.ok(liveRows.includes('jira'), `expected Jira in the Live table, parsed: ${liveRows.join(', ')}`);
  });
});
