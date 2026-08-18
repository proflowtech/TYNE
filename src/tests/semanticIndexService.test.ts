import test, { before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/**
 * The workspace index is the piece that makes duplication detection repo-wide
 * rather than window-wide, so the properties under test are the ones that
 * decide whether a second review is cheap and correct: cached files are
 * reused, stale files are re-read, deleted files disappear, and the files
 * under review are never matched against their own fingerprints.
 */
describe('SemanticWorkspaceIndex', () => {
  let originalLoad: unknown;
  let load: typeof import('../services/semanticIndexService');

  /** In-memory workspace: path -> { content, mtime }. */
  const disk = new Map<string, { content: string; mtime: number }>();
  /** In-memory global storage for the persisted cache. */
  const storage = new Map<string, string>();
  let readCount = 0;

  const uriFor = (fsPath: string) => ({ fsPath, path: fsPath, toString: () => fsPath });

  before(() => {
    const vscodeStub = {
      Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) =>
          uriFor([base.fsPath, ...parts].join('/')),
        file: (p: string) => uriFor(p),
      },
      RelativePattern: class {
        constructor(public base: unknown, public pattern: string) {}
      },
      workspace: {
        findFiles: async () => [...disk.keys()].map(p => uriFor(`/repo/${p}`)),
        asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace(/^\/repo\//, ''),
        fs: {
          stat: async (uri: { fsPath: string }) => {
            const rel = uri.fsPath.replace(/^\/repo\//, '');
            const entry = disk.get(rel);
            if (!entry) throw new Error('ENOENT');
            return { mtime: entry.mtime, size: entry.content.length, type: 1, ctime: 0 };
          },
          readFile: async (uri: { fsPath: string }) => {
            const rel = uri.fsPath.replace(/^\/repo\//, '');
            const entry = disk.get(rel);
            if (entry) {
              readCount++;
              return Buffer.from(entry.content, 'utf8');
            }
            const cached = storage.get(uri.fsPath);
            if (cached !== undefined) return Buffer.from(cached, 'utf8');
            throw new Error('ENOENT');
          },
          writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => {
            storage.set(uri.fsPath, Buffer.from(bytes).toString('utf8'));
          },
          createDirectory: async () => undefined,
        },
      },
    };

    // @ts-expect-error Node internal
    originalLoad = Module._load;
    // @ts-expect-error Node internal
    Module._load = function (request: string, parent: NodeModule, isMain: boolean) {
      if (request === 'vscode') return vscodeStub;
      // @ts-expect-error Node internal
      return originalLoad(request, parent, isMain);
    };
    delete require.cache[require.resolve('../services/semanticIndexService')];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    load = require('../services/semanticIndexService');
  });

  after(() => {
    // @ts-expect-error Node internal
    Module._load = originalLoad;
  });

  const HELPER = `
export function slugifyTitle(title: string): string {
  if (!title) { return ''; }
  const trimmed = title.trim().toLowerCase();
  const replaced = trimmed.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-{2,}/g, '-');
  return collapsed.replace(/^-|-$/g, '');
}
`;

  const ADAPTER_CONTRACT = `
export interface PmAdapter {
  isConnected(): boolean;
  listProjects(): Promise<string[]>;
}
`;

  function fakeContext() {
    return { globalStorageUri: uriFor('/storage') } as never;
  }

  const folder = { uri: uriFor('/repo'), name: 'repo', index: 0 } as never;

  beforeEach(() => {
    disk.clear();
    storage.clear();
    readCount = 0;
    load.resetSemanticWorkspaceIndexes();
  });

  test('builds an index over the workspace', async () => {
    disk.set('src/util/text.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    const stats = await index.ensureFresh();

    assert.equal(stats.totalFiles, 1);
    assert.equal(stats.fingerprinted, 1);
    assert.ok(stats.functions >= 1, 'should fingerprint at least one function');
    assert.equal(stats.partial, false);
    assert.ok(index.toFingerprintIndex().size >= 1);
  });

  test('reuses unchanged files and re-reads changed ones', async () => {
    disk.set('src/a.ts', { content: HELPER, mtime: 1 });
    disk.set('src/b.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);

    const first = await index.ensureFresh();
    assert.equal(first.fingerprinted, 2);
    const readsAfterBuild = readCount;

    // Nothing changed — a second pass must not re-read any file.
    const second = await index.ensureFresh();
    assert.equal(second.fingerprinted, 0);
    assert.equal(second.reusedFromCache, 2);
    assert.equal(readCount, readsAfterBuild, 'unchanged files must not be re-read');

    // Touch one file — only that one is re-read.
    disk.set('src/b.ts', { content: `${HELPER}\n// edited`, mtime: 2 });
    const third = await index.ensureFresh();
    assert.equal(third.fingerprinted, 1);
    assert.equal(third.reusedFromCache, 1);
    assert.equal(readCount, readsAfterBuild + 1);
  });

  test('drops files that no longer exist', async () => {
    disk.set('src/a.ts', { content: HELPER, mtime: 1 });
    disk.set('src/gone.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();
    assert.equal(index.fileCount, 2);

    disk.delete('src/gone.ts');
    await index.ensureFresh();
    assert.equal(index.fileCount, 1, 'deleted files must leave the index');
  });

  test('excludes the files under review from the corpus', async () => {
    disk.set('src/util/text.ts', { content: HELPER, mtime: 1 });
    disk.set('src/feature/new.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();

    const full = index.toFingerprintIndex();
    const excluded = index.toFingerprintIndex(['src/feature/new.ts']);
    assert.ok(excluded.size < full.size, 'changed files must not be in their own corpus');
    assert.ok(excluded.all().every(fp => fp.file !== 'src/feature/new.ts'));
  });

  test('queryHop1 finds an outside-diff importer from the persisted graph', async () => {
    disk.set('src/api.ts', {
      content: 'export function help(user: string) { return user; }\n',
      mtime: 1,
    });
    disk.set('src/caller.ts', {
      content: "import { help } from './api';\nhelp('x');\n",
      mtime: 1,
    });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();
    const hop = index.queryHop1(['src/api.ts']);
    assert.equal(hop.importers.some(i => i.file === 'src/caller.ts'), true);
  });

  test('carries interface contract names into the detector index', async () => {
    disk.set('src/pmAdapter.ts', { content: ADAPTER_CONTRACT, mtime: 1 });
    disk.set('src/util/text.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();

    const fpIndex = index.toFingerprintIndex();
    assert.equal(fpIndex.isContractName('isConnected'), true);
    assert.equal(fpIndex.isContractName('listProjects'), true);
    assert.equal(fpIndex.isContractName('slugifyTitle'), false);
  });

  test('contract names survive even when the declaring file is excluded', async () => {
    disk.set('src/pmAdapter.ts', { content: ADAPTER_CONTRACT, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();
    // The interface file itself is under review — its contract still applies.
    assert.equal(index.toFingerprintIndex(['src/pmAdapter.ts']).isContractName('isConnected'), true);
  });

  test('persists the cache and restores it into a fresh instance', async () => {
    disk.set('src/util/text.ts', { content: HELPER, mtime: 1 });
    const first = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await first.ensureFresh();
    assert.ok(storage.size > 0, 'cache should be written to global storage');

    // A new session: same disk, no in-memory state.
    load.resetSemanticWorkspaceIndexes();
    readCount = 0;
    const second = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    const stats = await second.ensureFresh();

    assert.equal(stats.fingerprinted, 0, 'a warm cache means no re-fingerprinting');
    assert.equal(stats.reusedFromCache, 1);
    assert.ok(second.toFingerprintIndex().size >= 1, 'restored index is usable');
  });

  test('invalidate forces one file to be re-read', async () => {
    disk.set('src/a.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    await index.ensureFresh();

    index.invalidate('src/a.ts');
    const stats = await index.ensureFresh();
    assert.equal(stats.fingerprinted, 1);
  });

  test('a zero budget yields a partial but usable index', async () => {
    for (let i = 0; i < 5; i++) disk.set(`src/f${i}.ts`, { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    const stats = await index.ensureFresh({ budgetMs: -1 });

    assert.equal(stats.partial, true);
    assert.equal(stats.fingerprinted, 0);
    // A truncated pass must not delete entries it never got around to visiting.
    assert.doesNotThrow(() => index.toFingerprintIndex());
  });

  test('survives a workspace with no readable files', async () => {
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    const stats = await index.ensureFresh();
    assert.equal(stats.totalFiles, 0);
    assert.equal(index.toFingerprintIndex().size, 0);
  });

  test('concurrent ensureFresh calls share one build', async () => {
    disk.set('src/a.ts', { content: HELPER, mtime: 1 });
    const index = load.getSemanticWorkspaceIndex(fakeContext(), folder);
    const [a, b] = await Promise.all([index.ensureFresh(), index.ensureFresh()]);
    assert.equal(a, b, 'both callers receive the same build result');
    assert.equal(readCount, 1, 'the file is read once, not twice');
  });
});
