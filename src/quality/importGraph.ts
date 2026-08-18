/**
 * Persistent import/export graph query — 1-hop neighborhood of a change.
 * No VS Code, no file IO: fill from SemanticWorkspaceIndex or tests.
 */

import { extractFileFacts } from './astFacts';
import { resolveRelativeImport, type BlastImporter } from './blastRadius';
import { fingerprintSource } from './semantic/fingerprint';
import type { FingerprintIndex } from './semantic/fingerprintIndex';

export interface FileGraphImport {
  module: string;
  line: number;
  raw: string;
  resolved?: string;
}

export interface FileGraphEntry {
  path: string;
  imports: FileGraphImport[];
  exports: Array<{ name: string; line: number }>;
}

export interface Hop1Result {
  importers: BlastImporter[];
  importees: Array<{ path: string; name: string; line: number }>;
  changedExports: Array<{ path: string; name: string; line: number }>;
}

export interface CodegraphSimilarHit {
  path: string;
  name: string;
  startLine: number;
}

export interface CodegraphNeighborhood {
  importers: BlastImporter[];
  importees: Array<{ path: string; name: string; line: number }>;
  similar: CodegraphSimilarHit[];
  text: string;
}

const MAX_IMPORTERS = 12;
const MAX_CALLEES = 16;
const MAX_SIMILAR = 5;
const TEXT_CAP = 8_000;

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function stripExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
}

function importedSymbols(raw: string): string[] {
  const inner = (raw.match(/\{([^}]+)\}/) || [])[1];
  if (!inner) { return []; }
  return inner.split(',').map(s => s.trim().split(/\s+as\s+/i)[0].trim()).filter(Boolean).slice(0, 8);
}

function aliasesFor(path: string): string[] {
  const n = norm(path);
  const noExt = stripExt(n);
  const aliases = new Set<string>([noExt, path.split('/').pop()?.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '') || '']);
  if (/\/index$/i.test(noExt)) { aliases.add(noExt.replace(/\/index$/i, '')); }
  return [...aliases].filter(Boolean);
}

export function extractFileGraph(path: string, content: string): FileGraphEntry {
  const rel = norm(path);
  const facts = extractFileFacts(rel, content);
  return {
    path: rel,
    imports: facts.imports.map(imp => ({
      module: imp.module,
      line: imp.line,
      raw: imp.raw,
      resolved: resolveRelativeImport(rel, imp.module),
    })),
    exports: facts.exports.map(e => ({ name: e.name, line: e.line })),
  };
}

export function queryHop1(
  files: Iterable<FileGraphEntry>,
  changedPaths: string[],
): Hop1Result {
  const entries = [...files];
  const byPath = new Map(entries.map(e => [norm(e.path), e]));
  const changedSet = new Set(changedPaths.map(norm));
  const changedByAlias = new Map<string, string>();
  for (const p of changedSet) {
    if (!/\.[tj]sx?$/i.test(p)) { continue; }
    for (const alias of aliasesFor(p)) {
      if (!changedByAlias.has(alias)) { changedByAlias.set(alias, p); }
    }
  }

  const importers: BlastImporter[] = [];
  const seen = new Set<string>();
  for (const file of entries) {
    if (importers.length >= MAX_IMPORTERS) { break; }
    const rel = norm(file.path);
    if (changedSet.has(rel)) { continue; }
    for (const imp of file.imports) {
      const target = (imp.resolved && changedByAlias.get(imp.resolved))
        || changedByAlias.get(stripExt(norm(imp.module).replace(/^@\//, '').replace(/^~\//, '')));
      if (!target) { continue; }
      const key = rel + '->' + target;
      if (seen.has(key)) { continue; }
      seen.add(key);
      importers.push({
        file: rel,
        line: imp.line || 1,
        importedSymbols: importedSymbols(imp.raw),
        fromModule: imp.module,
        targetFile: target,
      });
      if (importers.length >= MAX_IMPORTERS) { break; }
    }
  }

  const importees: Hop1Result['importees'] = [];
  const seenImp = new Set<string>();
  for (const p of changedSet) {
    const entry = byPath.get(p);
    if (!entry) { continue; }
    for (const imp of entry.imports) {
      if (!imp.resolved) { continue; }
      const hit = entries.find(e => stripExt(norm(e.path)) === imp.resolved);
      if (!hit || changedSet.has(hit.path) || seenImp.has(hit.path)) { continue; }
      seenImp.add(hit.path);
      for (const exp of hit.exports.slice(0, 4)) {
        importees.push({ path: hit.path, name: exp.name, line: exp.line });
        if (importees.length >= MAX_CALLEES) { break; }
      }
      if (!hit.exports.length) {
        importees.push({ path: hit.path, name: '', line: 1 });
      }
      if (importees.length >= MAX_CALLEES) { break; }
    }
  }

  const changedExports: Hop1Result['changedExports'] = [];
  for (const p of changedSet) {
    const entry = byPath.get(p);
    if (!entry) { continue; }
    for (const exp of entry.exports.slice(0, 8)) {
      changedExports.push({ path: p, name: exp.name, line: exp.line });
    }
  }

  return { importers, importees, changedExports };
}

export function mergeImporters(base: BlastImporter[], extra: BlastImporter[]): BlastImporter[] {
  const seen = new Set(base.map(i => i.file + '->' + i.targetFile));
  const out = [...base];
  for (const hit of extra) {
    const key = hit.file + '->' + hit.targetFile;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(hit);
    if (out.length >= MAX_IMPORTERS) { break; }
  }
  return out;
}

export function similarFromFingerprints(
  index: FingerprintIndex,
  changed: Array<{ path: string; content: string }>,
  limit = MAX_SIMILAR,
): CodegraphSimilarHit[] {
  const exclude = new Set(changed.map(c => norm(c.path)));
  const hits: CodegraphSimilarHit[] = [];
  const seen = new Set<string>();
  for (const file of changed.slice(0, 8)) {
    for (const fp of fingerprintSource(file.path, file.content).slice(0, 6)) {
      for (const cand of index.candidatesFor(fp, { limit: 8, excludeFiles: exclude })) {
        const key = cand.file + '#' + cand.name;
        if (seen.has(key)) { continue; }
        seen.add(key);
        hits.push({ path: cand.file, name: cand.name, startLine: cand.startLine });
        if (hits.length >= limit) { return hits; }
      }
    }
  }
  return hits;
}

export function packCodegraphNeighborhood(input: {
  importers: BlastImporter[];
  importees: Array<{ path: string; name: string; line: number }>;
  similar?: CodegraphSimilarHit[];
  changed?: Array<{ path: string; name?: string; line?: number }>;
}): CodegraphNeighborhood {
  const similar = (input.similar || []).slice(0, MAX_SIMILAR);
  const lines: string[] = [];
  for (const c of (input.changed || []).slice(0, 12)) {
    lines.push(`CHANGED: ${c.path}${c.name ? ' ' + c.name : ''}${c.line ? ' :' + c.line : ''}`);
  }
  for (const i of input.importers.slice(0, MAX_IMPORTERS)) {
    const sym = i.importedSymbols.length ? `{${i.importedSymbols.join(',')}}` : '';
    lines.push(`IMPORTERS: ${i.file}:${i.line} imports ${sym} ${i.targetFile}`.replace(/\s+/g, ' ').trim());
  }
  for (const c of input.importees.slice(0, MAX_CALLEES)) {
    lines.push(`CALLEES: ${c.path}${c.name ? ' ' + c.name : ''} :${c.line}`);
  }
  for (const s of similar) {
    lines.push(`SIMILAR: ${s.path} ${s.name} :${s.startLine}`);
  }
  return {
    importers: input.importers.slice(0, MAX_IMPORTERS),
    importees: input.importees.slice(0, MAX_CALLEES),
    similar,
    text: lines.join('\n').slice(0, TEXT_CAP),
  };
}

export function neighborhoodFileList(n?: CodegraphNeighborhood): string[] {
  if (!n) { return []; }
  const set = new Set<string>();
  for (const i of n.importers) { set.add(i.file); }
  for (const c of n.importees) { set.add(c.path); }
  for (const s of n.similar) { set.add(s.path); }
  return [...set];
}
