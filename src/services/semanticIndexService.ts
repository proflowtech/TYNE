/**
 * Workspace-wide fingerprint index for semantic duplication detection.
 *
 * Without this, the detector only ever sees the ~24-file window that safe
 * context collection already loaded — which means it can only find duplication
 * against files that happen to be near the diff. The whole premise ("you
 * already have this helper somewhere in the repo") needs repo-wide reach.
 *
 * Three constraints shape the design:
 *
 *   Cost. Fingerprinting a large repo is seconds of CPU. It is paid once, on a
 *   background build, then amortised: subsequent reviews re-fingerprint only
 *   files whose mtime/size changed.
 *
 *   Budget. A review must never block on indexing. Every entry point is capped
 *   by file count and wall clock, and a partial index is always usable — it
 *   simply matches against fewer files.
 *
 *   Privacy. The cache stores fingerprints (hashes, token counts, control-flow
 *   numbers) plus a short snippet per function for finding evidence. It never
 *   leaves the machine, and nothing here is sent to any model — the detector
 *   that consumes it is fully local.
 */

import * as vscode from 'vscode';
import {
  deserializeFingerprint,
  extractContractNames,
  fingerprintSource,
  serializeFingerprint,
  type FunctionFingerprint,
  type SerializedFingerprint,
} from '../quality/semantic/fingerprint';
import { FingerprintIndex } from '../quality/semantic/fingerprintIndex';
import { extractFileGraph, queryHop1, type FileGraphEntry, type FileGraphImport, type Hop1Result } from '../quality/importGraph';

const CACHE_VERSION = 2;
const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go}';
const IGNORE_GLOB = '**/{node_modules,dist,build,out,.next,coverage,.git,vendor,third_party}/**';

const DEFAULT_MAX_FILES = 3000;
const DEFAULT_BUILD_BUDGET_MS = 12_000;
const DEFAULT_REFRESH_BUDGET_MS = 2_500;
/** Files above this size are almost always generated; fingerprints are noise. */
const MAX_FILE_BYTES = 400_000;
/** Yield to the extension host every N files so the UI never stalls. */
const YIELD_EVERY = 40;

interface CachedFile {
  /** Workspace-relative path. */
  path: string;
  mtime: number;
  size: number;
  fingerprints: SerializedFingerprint[];
  contractNames: string[];
  imports?: FileGraphImport[];
  exports?: Array<{ name: string; line: number }>;
}

interface CacheDocument {
  version: number;
  workspace: string;
  builtAt: number;
  files: CachedFile[];
}

export interface IndexBuildStats {
  totalFiles: number;
  fingerprinted: number;
  reusedFromCache: number;
  skipped: number;
  functions: number;
  elapsedMs: number;
  /** True when a cap stopped the build before every file was visited. */
  partial: boolean;
}

export interface SemanticIndexOptions {
  maxFiles?: number;
  budgetMs?: number;
}

export class SemanticWorkspaceIndex {
  private readonly files = new Map<string, CachedFile>();
  private lastStats: IndexBuildStats | null = null;
  private building: Promise<IndexBuildStats> | null = null;
  /**
   * Tracked explicitly rather than inferred from `files.size`: an empty map
   * also happens after `invalidate()` clears the last entry, and reloading the
   * cache then would restore exactly the entry we were told to discard.
   */
  private cacheLoaded = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
  ) {}

  static create(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
  ): SemanticWorkspaceIndex {
    return new SemanticWorkspaceIndex(context, folder);
  }

  get stats(): IndexBuildStats | null {
    return this.lastStats;
  }

  get fileCount(): number {
    return this.files.size;
  }

  /**
   * Ensure the index is current. Safe to call on every review: the first call
   * builds, later calls only re-fingerprint files that actually changed.
   * Concurrent callers share one build rather than racing.
   */
  async ensureFresh(options: SemanticIndexOptions = {}): Promise<IndexBuildStats> {
    if (this.building) return this.building;
    this.building = this.refresh(options).finally(() => { this.building = null; });
    return this.building;
  }

  private async refresh(options: SemanticIndexOptions): Promise<IndexBuildStats> {
    const started = Date.now();
    if (!this.cacheLoaded) {
      this.cacheLoaded = true;
      await this.loadCache();
    }

    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const budgetMs = options.budgetMs
      ?? (this.files.size === 0 ? DEFAULT_BUILD_BUDGET_MS : DEFAULT_REFRESH_BUDGET_MS);

    const stats: IndexBuildStats = {
      totalFiles: 0, fingerprinted: 0, reusedFromCache: 0, skipped: 0,
      functions: 0, elapsedMs: 0, partial: false,
    };

    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.folder, SOURCE_GLOB),
        IGNORE_GLOB,
        maxFiles,
      );
    } catch {
      stats.elapsedMs = Date.now() - started;
      this.lastStats = stats;
      return stats;
    }

    stats.totalFiles = uris.length;
    const seen = new Set<string>();
    let processed = 0;

    for (const uri of uris) {
      const relative = vscode.workspace.asRelativePath(uri, false);
      seen.add(relative);

      if (Date.now() - started > budgetMs) {
        stats.partial = true;
        // Everything already cached stays usable; we simply stop extending.
        break;
      }

      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        stats.skipped++;
        continue;
      }

      if (stat.size > MAX_FILE_BYTES) {
        stats.skipped++;
        continue;
      }

      const cached = this.files.get(relative);
      if (cached && cached.mtime === stat.mtime && cached.size === stat.size && cached.imports) {
        stats.reusedFromCache++;
        stats.functions += cached.fingerprints.length;
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        const fingerprints = fingerprintSource(relative, content).map(serializeFingerprint);
        const graph = extractFileGraph(relative, content);
        this.files.set(relative, {
          path: relative,
          mtime: stat.mtime,
          size: stat.size,
          fingerprints,
          contractNames: extractContractNames(relative, content),
          imports: graph.imports,
          exports: graph.exports,
        });
        stats.fingerprinted++;
        stats.functions += fingerprints.length;
      } catch {
        stats.skipped++;
      }

      if (++processed % YIELD_EVERY === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Drop entries for files that no longer exist — but only on a complete
    // pass, since a budget-truncated scan has not seen every file.
    if (!stats.partial) {
      for (const path of [...this.files.keys()]) {
        if (!seen.has(path)) this.files.delete(path);
      }
    }

    stats.elapsedMs = Date.now() - started;
    this.lastStats = stats;
    if (stats.fingerprinted > 0) void this.saveCache();
    return stats;
  }

  queryHop1(changedPaths: string[]): Hop1Result {
    const entries: FileGraphEntry[] = [];
    for (const file of this.files.values()) {
      entries.push({
        path: file.path,
        imports: file.imports || [],
        exports: file.exports || [],
      });
    }
    return queryHop1(entries, changedPaths);
  }

  /**
   * Materialize a detector-ready index. `excludePaths` drops the files being
   * reviewed, so changed code is never matched against its own stale
   * fingerprints from the last build.
   */
  toFingerprintIndex(excludePaths: Iterable<string> = []): FingerprintIndex {
    const exclude = new Set(excludePaths);
    const index = new FingerprintIndex();
    for (const entry of this.files.values()) {
      // Contract names are collected even from excluded files: an interface
      // declaration is worth knowing about wherever it lives.
      index.addContractNames(entry.contractNames);
      if (exclude.has(entry.path)) continue;
      for (const row of entry.fingerprints) {
        try {
          index.add(deserializeFingerprint(row));
        } catch { /* skip a corrupt row rather than lose the index */ }
      }
    }
    return index;
  }

  /** Invalidate one file (e.g. on save) so the next review re-reads it. */
  invalidate(relativePath: string): void {
    this.files.delete(relativePath);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private cacheUri(): vscode.Uri {
    const key = Buffer.from(this.folder.uri.fsPath).toString('base64url').slice(0, 48);
    return vscode.Uri.joinPath(this.context.globalStorageUri, `semantic-index-${key}.json`);
  }

  private async loadCache(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.cacheUri());
      const doc = JSON.parse(Buffer.from(bytes).toString('utf8')) as CacheDocument;
      if (doc.version !== CACHE_VERSION) return;
      if (doc.workspace !== this.folder.uri.fsPath) return;
      for (const file of doc.files || []) {
        if (file?.path) this.files.set(file.path, file);
      }
    } catch {
      /* no cache yet, or unreadable — a rebuild is the correct fallback */
    }
  }

  private async saveCache(): Promise<void> {
    const doc: CacheDocument = {
      version: CACHE_VERSION,
      workspace: this.folder.uri.fsPath,
      builtAt: Date.now(),
      files: [...this.files.values()],
    };
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      await vscode.workspace.fs.writeFile(
        this.cacheUri(),
        Buffer.from(JSON.stringify(doc), 'utf8'),
      );
    } catch {
      /* cache is an optimization; failing to persist must not fail a review */
    }
  }
}

// ── Module-level accessor ───────────────────────────────────────────────────

const instances = new Map<string, SemanticWorkspaceIndex>();

/** One index per workspace folder, reused across reviews. */
export function getSemanticWorkspaceIndex(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder,
): SemanticWorkspaceIndex {
  const key = folder.uri.fsPath;
  let existing = instances.get(key);
  if (!existing) {
    existing = SemanticWorkspaceIndex.create(context, folder);
    instances.set(key, existing);
  }
  return existing;
}

/** Test seam — drops cached instances. */
export function resetSemanticWorkspaceIndexes(): void {
  instances.clear();
}
