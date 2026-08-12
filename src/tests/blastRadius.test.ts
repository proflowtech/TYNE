import test from 'node:test';
import assert from 'node:assert/strict';
import { findBlastRadiusSync, resolveRelativeImport, isBlastSkipPath } from '../quality/blastRadius';

test('resolveRelativeImport resolves ./ and ../ paths', () => {
  assert.equal(resolveRelativeImport('src/a/b.ts', './c'), 'src/a/c');
  assert.equal(resolveRelativeImport('src/a/b.ts', '../api'), 'src/api');
  assert.equal(resolveRelativeImport('src/a.ts', 'lodash'), undefined);
});

test('isBlastSkipPath skips node_modules and dist', () => {
  assert.equal(isBlastSkipPath('node_modules/foo/index.ts'), true);
  assert.equal(isBlastSkipPath('src/dist/x.ts'), true);
  assert.equal(isBlastSkipPath('src/api.ts'), false);
});

test('findBlastRadiusSync finds outside importer of a changed module', () => {
  const hits = findBlastRadiusSync({
    changedFiles: [{
      path: 'src/lib/helpers.ts',
      content: 'export function help() { return 1; }\n',
    }],
    candidates: [
      {
        path: 'src/app.ts',
        content: "import { help } from './lib/helpers';\nhelp();\n",
      },
      {
        path: 'src/noise.ts',
        content: "import { x } from './other';\n",
      },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'src/app.ts');
  assert.equal(hits[0].targetFile, 'src/lib/helpers.ts');
  assert.ok(hits[0].line >= 1);
  assert.ok(hits[0].importedSymbols.includes('help'));
});

test('findBlastRadiusSync ignores importers that are themselves changed', () => {
  const hits = findBlastRadiusSync({
    changedFiles: [
      { path: 'src/a.ts', content: 'export const a = 1;\n' },
      { path: 'src/b.ts', content: "import { a } from './a';\n" },
    ],
    candidates: [
      { path: 'src/b.ts', content: "import { a } from './a';\n" },
    ],
  });
  assert.equal(hits.length, 0);
});
