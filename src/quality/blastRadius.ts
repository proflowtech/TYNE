/**
 * Partial codebase brain: find workspace files *outside* the diff that import
 * symbols (or modules) exported by changed TS/JS files.
 *
 * Honesty: every hit carries file + line evidence. Caps keep this cheap —
 * no persistent index, no full-repo graph.
 */

import { extractFileFacts } from './astFacts';

export interface BlastImporter {
  /** Workspace-relative path of the outside-diff caller. */
  file: string;
  /** 1-based import line. */
  line: number;
  importedSymbols: string[];
  /** The import module string as written in source. */
  fromModule: string;
  /** Changed file being imported (workspace-relative). */
  targetFile: string;
}

const MAX_CANDIDATES = 24;
const MAX_GHOSTS = 12;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git|\.next|out)(\/|$)/i;

export function isBlastSkipPath(rel: string): boolean {
  return SKIP_DIR.test(rel.replace(/\\/g, '/'));
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
}

function baseNoExt(p: string): string {
  const base = norm(p).split('/').pop() || p;
  return stripExt(base);
}

/** Resolve a relative import from `fromFile` to a path key without extension. */
export function resolveRelativeImport(fromFile: string, moduleSpec: string): string | undefined {
  const spec = moduleSpec.trim();
  if (!spec.startsWith('.')) { return undefined; }
  const from = norm(fromFile);
  const parts = from.split('/');
  parts.pop();
  const segs = spec.split('/');
  for (const seg of segs) {
    if (seg === '.' || seg === '') { continue; }
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return stripExt(parts.join('/'));
}

function moduleAliasesForChanged(path: string): string[] {
  const n = norm(path);
  const noExt = stripExt(n);
  const aliases = new Set<string>([noExt, baseNoExt(n)]);
  if (/\/index$/i.test(noExt)) {
    aliases.add(noExt.replace(/\/index$/i, ''));
  }
  return [...aliases];
}

function importHitsChanged(
  fromFile: string,
  moduleSpec: string,
  changedByAlias: Map<string, string>,
): string | undefined {
  const rel = resolveRelativeImport(fromFile, moduleSpec);
  if (rel && changedByAlias.has(rel)) { return changedByAlias.get(rel); }
  // Bare / alias path ending: match basename only when unique among changed files.
  const bare = stripExt(norm(moduleSpec).replace(/^@\//, '').replace(/^~\//, ''));
  if (bare && changedByAlias.has(bare)) { return changedByAlias.get(bare); }
  const base = bare.split('/').pop();
  if (base && changedByAlias.has(base)) { return changedByAlias.get(base); }
  return undefined;
}

/**
 * Sync core used by host + tests. Pass already-filtered candidate contents;
 * caller enforces MAX_CANDIDATES before calling if desired.
 */
export function findBlastRadiusSync(input: {
  changedFiles: Array<{ path: string; content: string }>;
  candidates: Array<{ path: string; content: string }>;
}): BlastImporter[] {
  const changedSet = new Set(input.changedFiles.map(f => norm(f.path)));
  const changedByAlias = new Map<string, string>();
  for (const f of input.changedFiles) {
    const p = norm(f.path);
    if (!/\.[tj]sx?$/i.test(p)) { continue; }
    for (const alias of moduleAliasesForChanged(p)) {
      // First writer wins — ambiguous basenames stay first-changed.
      if (!changedByAlias.has(alias)) { changedByAlias.set(alias, p); }
    }
  }

  const hits: BlastImporter[] = [];
  const seenFileTarget = new Set<string>();

  for (const cand of input.candidates) {
    if (hits.length >= MAX_GHOSTS) { break; }
    const rel = norm(cand.path);
    if (changedSet.has(rel) || isBlastSkipPath(rel)) { continue; }
    if (!/\.[tj]sx?$/i.test(rel)) { continue; }

    const facts = extractFileFacts(rel, cand.content || '');
    for (const imp of facts.imports) {
      const target = importHitsChanged(rel, imp.module, changedByAlias);
      if (!target) { continue; }
      const key = rel + '->' + target;
      if (seenFileTarget.has(key)) { continue; }
      seenFileTarget.add(key);

      const symbols = (imp.raw.match(/\{([^}]+)\}/) || [])[1]
        ? (imp.raw.match(/\{([^}]+)\}/) || ['', ''])[1].split(',').map(s => s.trim().split(/\s+as\s+/i)[0].trim()).filter(Boolean)
        : [];

      hits.push({
        file: rel,
        line: imp.line || 1,
        importedSymbols: symbols.slice(0, 8),
        fromModule: imp.module,
        targetFile: target,
      });
      if (hits.length >= MAX_GHOSTS) { break; }
    }
  }

  return hits;
}

export const BLAST_RADIUS_CAPS = { maxCandidates: MAX_CANDIDATES, maxGhosts: MAX_GHOSTS };
