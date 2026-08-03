/**
 * Builds the architecture flow locally from things the diff proves — changed
 * files, their real line counts, the findings on them, and the DB/LLM/external
 * call sites detected in the changed code. The LLM only ever contributes the
 * narrative (title/summary); structure is never guessed.
 */

import {
  ChangedFileInfo,
  TyneValidateReviewArchitectureFlow,
  TyneValidateReviewArchitectureFlowNode,
  TyneValidateReviewArchitectureFlowEdge,
  TyneArchitectureFlowLayerId,
  TyneArchitectureFlowNodeKind,
  TyneValidateReviewFinding,
} from '../validateReviewTypes';
import { EffectSite } from './effectDetector';
import { DecisionSite } from './branchDetector';

const MAX_FILE_NODES = 14;
const MAX_NODES = 32;
const MAX_EDGES = 40;
const MAX_DECISIONS = 4;
const MAX_DECISIONS_PER_FILE = 2;

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

export interface BuildArchitectureGraphInput {
  changedFiles: ChangedFileInfo[];
  effects: EffectSite[];
  decisions?: DecisionSite[];
  findings?: TyneValidateReviewFinding[];
  /** Narrative-only fields carried over from the LLM, never structure. */
  narrative?: { title?: string; summary?: string; whatWentRight?: string[]; whatWentWrong?: string[] };
}

/**
 * Produces a flow where every node and edge is backed by the diff: a file node
 * per changed file, an effect node per distinct DB/LLM/external touchpoint, and
 * a directional edge from the file that issues the call to what it reaches.
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

  kept.forEach((file, i) => {
    const path = file.path.replace(/\\/g, '/');
    const id = 'file_' + i;
    fileNodeId.set(path, id);
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
    });
  }

  // One node per distinct touchpoint; edge from each file that reaches it.
  const effectNodes = new Map<string, TyneValidateReviewArchitectureFlowNode>();
  const edgeSeen = new Set<string>();
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
    // The diamond asks the question (the condition); the function it lives in is
    // context on the incoming edge, not the node title.
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
      // The terminal carries the outcome label, so the edge to it stays clean.
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

  const totalAdditions = input.changedFiles.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = input.changedFiles.reduce((s, f) => s + (f.deletions || 0), 0);

  const effectSummary = summariseEffects(input.effects);
  return {
    title: input.narrative?.title || 'Architecture Flow',
    summary: input.narrative?.summary || effectSummary || `${input.changedFiles.length} changed file${input.changedFiles.length === 1 ? '' : 's'}.`,
    nodes: nodes.slice(0, MAX_NODES),
    edges: edges.slice(0, MAX_EDGES),
    totalAdditions,
    totalDeletions,
    whatWentRight: input.narrative?.whatWentRight || [],
    whatWentWrong: input.narrative?.whatWentWrong || [],
    generatedBy: 'local_ast',
  };
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
