import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import type { Hop1Result } from '../quality/importGraph';
import type { ReviewPmTaskContext } from '../validateReviewTypes';

// safeCodebaseContextCollector.ts imports `vscode` unconditionally at module
// scope, even though the functions under test here are pure. Stub it the way
// the rest of the suite does (see deviceAuth.test.ts) rather than dragging in
// the real VS Code API for logic that never touches it.
let originalLoad: unknown;
let load: typeof import('../safeCodebaseContextCollector');

before(() => {
  // @ts-expect-error Node internal
  originalLoad = Module._load;
  // @ts-expect-error Node internal
  Module._load = function (request: string, parent: NodeModule, isMain: boolean) {
    if (request === 'vscode') return {};
    // @ts-expect-error Node internal
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve('../safeCodebaseContextCollector')];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load = require('../safeCodebaseContextCollector');
});

after(() => {
  // @ts-expect-error Node internal
  Module._load = originalLoad;
});

const graphNeighborsFromHop1: typeof import('../safeCodebaseContextCollector').graphNeighborsFromHop1 =
  (...args) => load.graphNeighborsFromHop1(...args);
const scorePath: typeof import('../safeCodebaseContextCollector').scorePath =
  (...args) => load.scorePath(...args);
const reasonForPath: typeof import('../safeCodebaseContextCollector').reasonForPath =
  (...args) => load.reasonForPath(...args);
const findNearbyFiles: typeof import('../safeCodebaseContextCollector').findNearbyFiles =
  (...args) => load.findNearbyFiles(...args);
const findPmTaskRelevantFiles: typeof import('../safeCodebaseContextCollector').findPmTaskRelevantFiles =
  (...args) => load.findPmTaskRelevantFiles(...args);

/**
 * Phase A: nearby-file ranking previously used keyword string-matching only,
 * even though the AST-backed import graph (`queryHop1`) is already computed
 * for every review. A file one import away from the change lost to any file
 * that merely shared a word with the ticket title. These tests pin the fix:
 * a graph edge must outrank a loose keyword match, and the reported reason
 * must say which relationship actually applied.
 */

function hop1(importers: string[], importees: string[]): Hop1Result {
  return {
    importers: importers.map((file, i) => ({
      file, line: 1, importedSymbols: ['thing'], fromModule: './target', targetFile: `changed${i}.ts`,
    })),
    importees: importees.map((p, i) => ({ path: p, name: `export${i}`, line: 1 })),
    changedExports: [],
  };
}

test('graphNeighborsFromHop1 tags importers and importees distinctly', () => {
  const neighbors = graphNeighborsFromHop1(hop1(['src/a.ts'], ['src/b.ts']));
  assert.equal(neighbors.get('src/a.ts'), 'importer');
  assert.equal(neighbors.get('src/b.ts'), 'importee');
  assert.equal(neighbors.size, 2);
});

test('graphNeighborsFromHop1 handles an absent hop1 without throwing', () => {
  const neighbors = graphNeighborsFromHop1(undefined);
  assert.equal(neighbors.size, 0);
});

test('graphNeighborsFromHop1 prefers the first-seen relationship on overlap', () => {
  // A file that both imports a changed file AND is imported by one is rare
  // but must not throw; importer is recorded first and wins.
  const neighbors = graphNeighborsFromHop1(hop1(['src/shared.ts'], ['src/shared.ts']));
  assert.equal(neighbors.get('src/shared.ts'), 'importer');
});

test('scorePath: a graph edge outranks a single loose keyword match', () => {
  const changed = new Set(['src/feature.ts']);
  const keywords = ['user'];
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/importer.ts', 'importer']]);

  const graphOnly = scorePath('src/importer.ts', keywords, changed, graphNeighbors);
  const keywordOnly = scorePath('src/user-profile.ts', keywords, changed, graphNeighbors);

  assert.ok(graphOnly > keywordOnly, `graph edge (${graphOnly}) must outrank a bare keyword hit (${keywordOnly})`);
});

test('scorePath: the changed file itself still outranks a graph edge', () => {
  const changed = new Set(['src/feature.ts']);
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/neighbor.ts', 'importee']]);

  const changedScore = scorePath('src/feature.ts', [], changed, graphNeighbors);
  const graphScore = scorePath('src/neighbor.ts', [], changed, graphNeighbors);

  assert.ok(changedScore > graphScore, 'the file under review must still rank first');
});

test('scorePath: graph edge and keyword match stack additively', () => {
  const changed = new Set<string>();
  const keywords = ['user'];
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/user-service.ts', 'importer']]);

  const both = scorePath('src/user-service.ts', keywords, changed, graphNeighbors);
  const graphOnly = scorePath('src/other-import.ts', keywords, changed, graphNeighbors.set('src/other-import.ts', 'importer'));
  const keywordOnly = scorePath('src/user-widget.ts', keywords, changed, new Map());

  assert.ok(both > graphOnly, 'stacking a keyword match on a graph edge must score higher than the edge alone');
  assert.ok(both > keywordOnly, 'stacking a graph edge on a keyword match must score higher than the keyword alone');
});

test('scorePath: a file with neither signal scores zero', () => {
  assert.equal(scorePath('src/unrelated.ts', ['user'], new Set(), new Map()), 0);
});

test('reasonForPath: names the graph relationship when it is the only signal', () => {
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/a.ts', 'importer'], ['src/b.ts', 'importee']]);
  assert.equal(reasonForPath('src/a.ts', [], new Set(), graphNeighbors), 'Imports a changed file');
  assert.equal(reasonForPath('src/b.ts', [], new Set(), graphNeighbors), 'Imported by a changed file');
});

test('reasonForPath: combines graph and keyword reasons rather than picking one', () => {
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/user-service.ts', 'importer']]);
  const reason = reasonForPath('src/user-service.ts', ['user'], new Set(), graphNeighbors);
  assert.match(reason, /Imports a changed file/);
  assert.match(reason, /user/);
});

test('reasonForPath: changed-file reason takes precedence over everything', () => {
  const changed = new Set(['src/feature.ts']);
  const graphNeighbors = new Map<string, 'importer' | 'importee'>([['src/feature.ts', 'importer']]);
  assert.equal(reasonForPath('src/feature.ts', ['feature'], changed, graphNeighbors), 'Changed in the current edit scope');
});

test('reasonForPath: falls back to "Nearby file" with no signal at all', () => {
  assert.equal(reasonForPath('src/random.ts', ['user'], new Set(), new Map()), 'Nearby file');
});

test('findNearbyFiles: a graph neighbor with zero keyword overlap beats a same-word file that is not in the graph', () => {
  const paths = ['src/db-connection.ts', 'src/unrelated-user-export.ts'];
  const changedPaths = ['src/feature.ts'];
  const keywords = ['user'];
  const graph = hop1(['src/db-connection.ts'], []);

  const result = findNearbyFiles(paths, changedPaths, keywords, 10, graphNeighborsFromHop1(graph));

  assert.equal(result[0].path, 'src/db-connection.ts', 'the real dependency of the diff must rank first');
  assert.equal(result[0].reason, 'Imports a changed file');
  assert.equal(result[1].path, 'src/unrelated-user-export.ts');
});

test('findNearbyFiles: works unchanged when no graph is available (backward compatible)', () => {
  const paths = ['src/user-a.ts', 'src/user-b.ts'];
  const result = findNearbyFiles(paths, [], ['user'], 10);
  assert.equal(result.length, 2);
  assert.ok(result.every(r => r.reason.startsWith('Matches keyword')));
});

test('findNearbyFiles: test files are still excluded regardless of graph membership', () => {
  const paths = ['src/foo.test.ts'];
  const graph = hop1(['src/foo.test.ts'], []);
  const result = findNearbyFiles(paths, [], [], 10, graphNeighborsFromHop1(graph));
  assert.equal(result.length, 0);
});

test('findPmTaskRelevantFiles: a graph edge lifts a file above a weak keyword-only match', () => {
  const pmTask: ReviewPmTaskContext = {
    source: 'jira',
    title: 'Fix payment retry logic',
    description: '', goal: '', acceptanceCriteria: [], subtasks: [],
  };
  const paths = ['src/retryQueue.ts', 'src/paymentSummaryPageCopy.ts'];
  const graph = graphNeighborsFromHop1(hop1(['src/retryQueue.ts'], []));

  const result = findPmTaskRelevantFiles(paths, pmTask, 10, graph);

  assert.equal(result[0], 'src/retryQueue.ts', 'graph-connected file should outrank a filename-only keyword hit');
});

test('findPmTaskRelevantFiles: works unchanged when no graph is available (backward compatible)', () => {
  const pmTask: ReviewPmTaskContext = {
    source: 'jira',
    title: 'Fix login bug', description: '', goal: '', acceptanceCriteria: [], subtasks: [],
  };
  const result = findPmTaskRelevantFiles(['src/login.ts', 'src/unrelated.ts'], pmTask, 10);
  assert.deepEqual(result, ['src/login.ts']);
});
