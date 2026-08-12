/**
 * Builds the architecture flow locally from things the diff proves — changed
 * files, their real line counts, the findings on them, DB/LLM/external call
 * sites, intra-diff imports, and outside-diff importers (blast radius).
 * The LLM only ever contributes the narrative (title/summary); structure is
 * never guessed.
 */

import {
  ChangedFileInfo,
  TyneValidateReviewArchitectureFlow,
  TyneValidateReviewArchitectureFlowNode,
  TyneValidateReviewArchitectureFlowEdge,
  TyneArchitectureFlowLayerId,
  TyneArchitectureFlowNodeKind,
  TyneValidateReviewFinding,
  TyneArchitectureReadingOrderCohort,
  TyneArchitectureSectionId,
} from '../validateReviewTypes';
import { EffectSite } from './effectDetector';
import { DecisionSite } from './branchDetector';
import { BlastImporter, resolveRelativeImport } from './blastRadius';
import { ImportFact } from './astFacts';
import { buildArchitectureSequence } from './sequenceFromGraph';

const MAX_FILE_NODES = 18;
const MAX_NODES = 40;
const MAX_EDGES = 48;
const MAX_DECISIONS = 4;
const MAX_DECISIONS_PER_FILE = 2;
const MAX_GHOST_NODES = 12;

const SECTION_TITLE: Record<TyneArchitectureSectionId, string> = {
  callers: 'Outside callers',
  extension: 'App & UI',
  backend: 'API & services',
  database: 'Data & schema',
  effects: 'External & LLM',
  tests: 'Tests',
};

const SECTION_SHORT: Record<string, string> = {
  callers: 'Callers',
  extension: 'App',
  backend: 'API',
  database: 'Database',
  effects: 'External',
  tests: 'Tests',
};

/** Assign the Architecture board section for a node (single source of truth). */
export function sectionIdForNode(n: TyneValidateReviewArchitectureFlowNode): TyneArchitectureSectionId {
  if (n.note === 'outside diff') { return 'callers'; }
  if (n.kind === 'database' || n.layer === 'database' || (!!n.file && /\/migrations?\/|\/schema\/|\.sql$/i.test(n.file))) {
    return 'database';
  }
  if (n.kind === 'llm' || n.kind === 'external') { return 'effects'; }
  if (n.kind === 'test') { return 'tests'; }
  if (n.kind === 'api' || n.kind === 'service' || n.kind === 'auth' || n.layer === 'backend') {
    return 'backend';
  }
  // Decisions/terminals inherit their file layer (already covered above when
  // layer is database/backend; remaining cases land in App & UI).
  return 'extension';
}

function assignSections(nodes: TyneValidateReviewArchitectureFlowNode[]): TyneValidateReviewArchitectureFlowNode[] {
  return nodes.map(n => ({ ...n, section: sectionIdForNode(n) }));
}

function inferLayer(path: string): TyneArchitectureFlowLayerId {
  const p = path.replace(/\\/g, '/');
  if (/\/migrations?\/|\/schema\/|\.sql$|prisma|drizzle|typeorm/.test(p)) return 'database';
  if (/oauth|stripe|dodo|twilio|sendgrid|webhook/.test(p)) return 'external';
  if (/\/(functions|api|routes|controllers|handlers|server)\//.test(p) || /supabase\/functions\//.test(p)) return 'backend';
  return 'extension';
}

function inferKind(path: string): TyneArchitectureFlowNodeKind {
  const p = path.replace(/\\/g, '/');
  if (/\/migrations?\/|\/schema\/|\.sql$/.test(p)) return 'database';
  if (/\.(test|spec)\.[tj]sx?$/.test(p)) return 'test';
  if (/\/(components|pages|views)\/|\.(tsx|vue|svelte)$/.test(p)) return 'ui';
  if (/oauth|auth/.test(p)) return 'auth';
  if (/supabase\/functions\/|\/(api|routes|handlers)\//.test(p)) return 'api';
  if (/\/(services|lib|utils)\//.test(p)) return 'service';
  return 'file';
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

/**
 * A label that stays unique. `index.ts`, `mod.rs`, `__init__.py` etc. are
 * meaningless on their own — and Tyne's own tree has a dozen `index.ts` — so
 * carry the parent directory for generic names or when two kept files collide.
 */
function labelFor(path: string, counts: Map<string, number>): string {
  const clean = path.replace(/\\/g, '/');
  const base = baseName(clean);
  const generic = /^(index|mod|main|__init__|route|handler)\.[a-z]+$/i.test(base);
  if (!generic && (counts.get(base) || 0) <= 1) return base;
  const parts = clean.split('/');
  return parts.length >= 2 ? parts.slice(-2).join('/') : base;
}

function effectNodeId(kind: string, target: string): string {
  return 'fx_' + kind + '_' + target.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
}

function effectLayer(kind: EffectSite['kind']): TyneArchitectureFlowLayerId {
  return kind === 'database' ? 'database' : 'external';
}

function stripExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
}

export interface FileImportHint {
  file: string;
  imports: ImportFact[];
  /** Lines in this file that belong to the diff (1-based), when known. */
  changedLines?: Set<number>;
}

export interface BuildArchitectureGraphInput {
  changedFiles: ChangedFileInfo[];
  effects: EffectSite[];
  decisions?: DecisionSite[];
  findings?: TyneValidateReviewFinding[];
  /** Imports extracted from changed files — drives proven intra-diff edges. */
  fileImports?: FileImportHint[];
  /** Outside-diff importers of changed modules (blast radius). */
  blastImporters?: BlastImporter[];
  /** Narrative-only fields carried over from the LLM, never structure. */
  narrative?: { title?: string; summary?: string; whatWentRight?: string[]; whatWentWrong?: string[] };
}

/**
 * Produces a flow where every node and edge is backed by the diff or a proven
 * workspace import: file nodes, effect nodes, intra-diff imports, ghost
 * outside-diff callers, and a reading-order walkthrough.
 */
export function buildArchitectureGraph(input: BuildArchitectureGraphInput): TyneValidateReviewArchitectureFlow {
  const findings = input.findings || [];
  const findingsByFile = new Map<string, string[]>();
  findings.forEach(f => {
    if (!f.file) return;
    const key = f.file.replace(/\\/g, '/');
    (findingsByFile.get(key) || findingsByFile.set(key, []).get(key)!).push(f.id);
  });

  // Biggest / most-findings-heavy files first, so the budget keeps what matters.
  const ranked = input.changedFiles.slice().sort((a, b) => {
    const fa = (findingsByFile.get(a.path.replace(/\\/g, '/'))?.length || 0);
    const fb = (findingsByFile.get(b.path.replace(/\\/g, '/'))?.length || 0);
    if (fa !== fb) return fb - fa;
    return (b.additions + b.deletions) - (a.additions + a.deletions);
  });

  const kept = ranked.slice(0, MAX_FILE_NODES);
  const dropped = ranked.length - kept.length;

  const baseCounts = new Map<string, number>();
  kept.forEach(f => {
    const b = baseName(f.path);
    baseCounts.set(b, (baseCounts.get(b) || 0) + 1);
  });

  const nodes: TyneValidateReviewArchitectureFlowNode[] = [];
  const edges: TyneValidateReviewArchitectureFlowEdge[] = [];
  const fileNodeId = new Map<string, string>();
  const changedPathByNoExt = new Map<string, string>();

  kept.forEach((file, i) => {
    const path = file.path.replace(/\\/g, '/');
    const id = 'file_' + i;
    fileNodeId.set(path, id);
    changedPathByNoExt.set(stripExt(path), path);
    const fids = findingsByFile.get(path) || [];
    nodes.push({
      id,
      label: labelFor(path, baseCounts),
      kind: inferKind(path),
      layer: inferLayer(path),
      file: path,
      additions: file.additions,
      deletions: file.deletions,
      changed: true,
      highlighted: fids.length > 0,
      verdict: fids.length > 0 ? 'wrong' : 'right',
      findingIds: fids.length ? fids : undefined,
    });
  });

  if (dropped > 0) {
    nodes.push({
      id: 'more_files',
      label: '+' + dropped + ' more file' + (dropped === 1 ? '' : 's'),
      kind: 'module',
      layer: 'extension',
      changed: false,
      note: 'overflow',
    });
  }

  // Proven imports between changed files.
  const edgeSeen = new Set<string>();
  (input.fileImports || []).forEach(hint => {
    const fromPath = hint.file.replace(/\\/g, '/');
    const fromId = fileNodeId.get(fromPath);
    if (!fromId) return;
    for (const imp of hint.imports || []) {
      const resolved = resolveRelativeImport(fromPath, imp.module);
      if (!resolved) continue;
      const targetPath = changedPathByNoExt.get(resolved);
      if (!targetPath) continue;
      const toId = fileNodeId.get(targetPath);
      if (!toId || toId === fromId) continue;
      const edgeKey = 'imp:' + fromId + '->' + toId;
      if (edgeSeen.has(edgeKey)) continue;
      edgeSeen.add(edgeKey);
      const onChangedLine = hint.changedLines ? hint.changedLines.has(imp.line) : false;
      edges.push({
        from: fromId,
        to: toId,
        label: 'imports',
        kind: 'imports',
        changed: onChangedLine,
      });
    }
  });

  // One node per distinct touchpoint; edge from each file that reaches it.
  const effectNodes = new Map<string, TyneValidateReviewArchitectureFlowNode>();
  input.effects.forEach(site => {
    const path = site.file.replace(/\\/g, '/');
    const fromId = fileNodeId.get(path);
    if (!fromId) return; // its file was dropped from the budget
    const toId = effectNodeId(site.kind, site.target);
    if (!effectNodes.has(toId)) {
      effectNodes.set(toId, {
        id: toId,
        label: site.target,
        kind: site.kind,
        layer: effectLayer(site.kind),
        changed: false,
        note: site.evidence,
        evidenceFile: path,
        evidenceLine: site.line,
      });
    }
    const edgeKey = fromId + '->' + toId;
    if (!edgeSeen.has(edgeKey)) {
      edgeSeen.add(edgeKey);
      edges.push({
        from: fromId,
        to: toId,
        label: site.verb,
        kind: site.kind === 'database' ? 'data' : 'calls',
      });
    }
  });

  effectNodes.forEach(node => nodes.push(node));

  // Outside-diff importers (blast radius ghosts).
  let ghostCount = 0;
  (input.blastImporters || []).forEach((hit, gi) => {
    if (ghostCount >= MAX_GHOST_NODES) return;
    const targetPath = hit.targetFile.replace(/\\/g, '/');
    const toId = fileNodeId.get(targetPath);
    if (!toId) return;
    const caller = hit.file.replace(/\\/g, '/');
    const ghostId = 'ghost_' + gi;
    ghostCount++;
    nodes.push({
      id: ghostId,
      label: baseName(caller) + ' (outside diff)',
      kind: 'module',
      layer: inferLayer(caller),
      file: caller,
      changed: false,
      note: 'outside diff',
      evidenceFile: caller,
      evidenceLine: hit.line,
      symbol: hit.importedSymbols[0],
    });
    const edgeKey = ghostId + '->' + toId;
    if (!edgeSeen.has(edgeKey)) {
      edgeSeen.add(edgeKey);
      edges.push({
        from: ghostId,
        to: toId,
        label: hit.importedSymbols[0] ? 'imports ' + hit.importedSymbols[0] : 'imports',
        kind: 'imports',
      });
    }
  });

  // Changed control-flow branch points: a diamond hung off its file, with a
  // stadium terminal per outcome (guard exit, or each switch case).
  const perFile = new Map<string, number>();
  let decisionCount = 0;
  (input.decisions || []).forEach((site, di) => {
    if (decisionCount >= MAX_DECISIONS) return;
    const path = site.file.replace(/\\/g, '/');
    const fromId = fileNodeId.get(path);
    if (!fromId) return;
    const used = perFile.get(path) || 0;
    if (used >= MAX_DECISIONS_PER_FILE) return;
    perFile.set(path, used + 1);
    decisionCount++;

    const decId = 'dec_' + di;
    nodes.push({
      id: decId,
      label: site.condition,
      kind: 'decision',
      layer: inferLayer(path),
      changed: true,
      evidenceFile: path,
      evidenceLine: site.line,
      note: site.functionName ? 'in ' + site.functionName + '()' : undefined,
    });
    edges.push({ from: fromId, to: decId, kind: 'branch', label: site.functionName });

    site.outcomes.slice(0, 3).forEach((outcome, oi) => {
      const termId = decId + '_o' + oi;
      nodes.push({
        id: termId,
        label: outcome.label,
        kind: 'terminal',
        layer: inferLayer(path),
        changed: false,
        highlighted: outcome.kind === 'error',
        verdict: outcome.kind === 'error' ? 'wrong' : 'neutral',
        evidenceFile: path,
        evidenceLine: site.line,
      });
      edges.push({ from: decId, to: termId, kind: 'branch' });
    });
  });

  const clippedNodes = assignSections(nodes.slice(0, MAX_NODES));
  const clippedIds = new Set(clippedNodes.map(n => n.id));
  const clippedEdges = edges.filter(e => clippedIds.has(e.from) && clippedIds.has(e.to)).slice(0, MAX_EDGES);

  const totalAdditions = input.changedFiles.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = input.changedFiles.reduce((s, f) => s + (f.deletions || 0), 0);

  const readingOrder = deriveReadingOrder(clippedNodes);
  const seq = buildArchitectureSequence({ nodes: clippedNodes, edges: clippedEdges });
  const pathSummary = summariseSectionPath(clippedNodes, clippedEdges);
  const effectSummary = summariseEffects(input.effects);
  const ghostN = clippedNodes.filter(n => n.note === 'outside diff').length;
  const defaultSummary = [
    pathSummary || effectSummary || `${input.changedFiles.length} changed file${input.changedFiles.length === 1 ? '' : 's'}`,
    ghostN ? `${ghostN} outside caller${ghostN === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  return {
    title: input.narrative?.title || 'Architecture Flow',
    summary: input.narrative?.summary || defaultSummary,
    nodes: clippedNodes,
    edges: clippedEdges,
    readingOrder,
    sequence: seq?.sequence,
    mermaid: seq?.mermaid,
    totalAdditions,
    totalDeletions,
    whatWentRight: input.narrative?.whatWentRight || [],
    whatWentWrong: input.narrative?.whatWentWrong || [],
    generatedBy: 'local_ast',
  };
}

/** Schema → backend → UI → effects → tests → outside callers. */
export function deriveReadingOrder(nodes: TyneValidateReviewArchitectureFlowNode[]): TyneArchitectureReadingOrderCohort[] {
  const order: TyneArchitectureSectionId[] = ['database', 'backend', 'extension', 'effects', 'tests', 'callers'];
  const cohorts: TyneArchitectureReadingOrderCohort[] = [];
  for (const id of order) {
    const ids = nodes.filter(n => (n.section || sectionIdForNode(n)) === id).map(n => n.id);
    if (!ids.length) continue;
    cohorts.push({
      id,
      title: SECTION_TITLE[id],
      nodeIds: ids,
      summary: ids.length + ' node' + (ids.length === 1 ? '' : 's'),
    });
  }
  return cohorts;
}

/** e.g. "App → API → Database" from which board sections are present + linked. */
function summariseSectionPath(
  nodes: TyneValidateReviewArchitectureFlowNode[],
  edges: TyneValidateReviewArchitectureFlowEdge[],
): string {
  const pathOrder: TyneArchitectureSectionId[] = ['extension', 'backend', 'database', 'effects'];
  const present = new Set(nodes.map(n => n.section || sectionIdForNode(n)));
  const chain = pathOrder.filter(s => present.has(s));
  if (chain.length < 2) { return ''; }
  const cross = edges.filter(e => e.kind === 'imports' || e.kind === 'calls' || e.kind === 'data').length;
  return chain.map(s => SECTION_SHORT[s] || s).join(' → ') +
    (cross ? ` (${cross} link${cross === 1 ? '' : 's'})` : '');
}

function summariseEffects(effects: EffectSite[]): string {
  if (!effects.length) return '';
  const db = new Set(effects.filter(e => e.kind === 'database').map(e => e.target));
  const llm = effects.some(e => e.kind === 'llm');
  const ext = new Set(effects.filter(e => e.kind === 'external').map(e => e.target));
  const parts: string[] = [];
  if (db.size) parts.push(db.size + ' database touchpoint' + (db.size === 1 ? '' : 's'));
  if (llm) parts.push('an LLM call');
  if (ext.size) parts.push(ext.size + ' external service' + (ext.size === 1 ? '' : 's'));
  return parts.length ? 'Changed code reaches ' + parts.join(', ') + '.' : '';
}
