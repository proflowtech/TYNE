/**
 * Build a proven sequence from architecture graph edges.
 * Only emits when there are ≥2 messages in a real calls/data/imports chain.
 * Decorative diagrams with no chain are never invented.
 */

import {
  TyneValidateReviewArchitectureFlowEdge,
  TyneValidateReviewArchitectureFlowNode,
  TyneArchitectureSequence,
} from '../validateReviewTypes';

const CHAIN_KINDS = new Set(['calls', 'data', 'imports']);

export function buildArchitectureSequence(input: {
  nodes: TyneValidateReviewArchitectureFlowNode[];
  edges: TyneValidateReviewArchitectureFlowEdge[];
}): { sequence: TyneArchitectureSequence; mermaid: string } | undefined {
  const byId = new Map(input.nodes.map(n => [n.id, n]));
  const usable = input.edges.filter(e => e.kind && CHAIN_KINDS.has(e.kind) && byId.has(e.from) && byId.has(e.to));
  if (usable.length < 2) { return undefined; }

  // Prefer a path that starts at a changed file and walks outbound.
  const out = new Map<string, TyneValidateReviewArchitectureFlowEdge[]>();
  usable.forEach(e => {
    (out.get(e.from) || out.set(e.from, []).get(e.from)!).push(e);
  });

  const starts = input.nodes.filter(n => n.changed === true || n.note === 'outside diff').map(n => n.id);
  let best: TyneValidateReviewArchitectureFlowEdge[] = [];

  for (const start of starts.length ? starts : input.nodes.map(n => n.id)) {
    const path: TyneValidateReviewArchitectureFlowEdge[] = [];
    const seen = new Set<string>([start]);
    let cur = start;
    // ponytail: greedy longest outbound walk; full longest-path if chains get complex
    while (path.length < 8) {
      const nextEdges = (out.get(cur) || []).filter(e => !seen.has(e.to));
      if (!nextEdges.length) break;
      // Prefer data/calls over imports for the "runtime" story.
      nextEdges.sort((a, b) => {
        const rank = (k?: string) => (k === 'data' || k === 'calls' ? 0 : 1);
        return rank(a.kind) - rank(b.kind);
      });
      const pick = nextEdges[0];
      path.push(pick);
      seen.add(pick.to);
      cur = pick.to;
    }
    if (path.length > best.length) best = path;
  }

  if (best.length < 2) {
    // Fall back: first two usable edges if they share a node (connected pair).
    const connected = usable.slice(0, 6);
    if (connected.length < 2) return undefined;
    best = connected.slice(0, 2);
  }

  if (best.length < 2) return undefined;

  const messages = best.map(e => ({
    fromLabel: byId.get(e.from)?.label || e.from,
    toLabel: byId.get(e.to)?.label || e.to,
    label: e.label,
  }));

  const actors: string[] = [];
  const seenActor = new Set<string>();
  messages.forEach(m => {
    [m.fromLabel, m.toLabel].forEach(a => {
      if (!seenActor.has(a)) { seenActor.add(a); actors.push(a); }
    });
  });

  const mermaidLines = ['sequenceDiagram'];
  actors.forEach(a => {
    mermaidLines.push('  participant ' + sanitizeMermaidId(a) + ' as ' + a.replace(/[#\n]/g, ' ').slice(0, 40));
  });
  messages.forEach(m => {
    const lbl = (m.label || 'calls').replace(/[#\n]/g, ' ').slice(0, 40);
    mermaidLines.push(
      '  ' + sanitizeMermaidId(m.fromLabel) + '->>' + sanitizeMermaidId(m.toLabel) + ': ' + lbl,
    );
  });

  return {
    sequence: { messages },
    mermaid: mermaidLines.join('\n'),
  };
}

function sanitizeMermaidId(label: string): string {
  const s = label.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'n';
  return (s[0].match(/[0-9]/) ? 'n_' + s : s).slice(0, 32);
}
