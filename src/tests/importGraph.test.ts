import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileGraph,
  queryHop1,
  packCodegraphNeighborhood,
  neighborhoodFileList,
} from '../quality/importGraph';

const API = `
export function help(user: string) {
  return user;
}
`;

const CALLER = `
import { help } from './api';
help('x');
`;

test('queryHop1 finds importer of a changed export without scanning extra files', () => {
  const api = extractFileGraph('src/api.ts', API);
  const caller = extractFileGraph('src/caller.ts', CALLER);
  const hop = queryHop1([api, caller], ['src/api.ts']);
  assert.equal(hop.importers.length, 1);
  assert.equal(hop.importers[0].file, 'src/caller.ts');
  assert.equal(hop.importers[0].targetFile, 'src/api.ts');
  assert.ok(hop.importers[0].importedSymbols.includes('help'));
});

test('packCodegraphNeighborhood is capped and lists importers', () => {
  const hop = queryHop1(
    [extractFileGraph('src/api.ts', API), extractFileGraph('src/caller.ts', CALLER)],
    ['src/api.ts'],
  );
  const pack = packCodegraphNeighborhood({
    importers: hop.importers,
    importees: hop.importees,
    changed: hop.changedExports,
    similar: [{ path: 'src/util/text.ts', name: 'slugify', startLine: 1 }],
  });
  assert.match(pack.text, /IMPORTERS: src\/caller\.ts/);
  assert.match(pack.text, /SIMILAR: src\/util\/text\.ts slugify/);
  assert.ok(pack.text.length <= 8000);
  assert.ok(neighborhoodFileList(pack).includes('src/caller.ts'));
  assert.ok(neighborhoodFileList(pack).includes('src/util/text.ts'));
});
