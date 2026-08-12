import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The other architecture-flow tests assert on source strings, which is how a
 * renderer that stacked every node at one x-position passed a check labelled
 * "must render as a branching flowchart". These tests execute the real
 * renderer and assert on the geometry it emits.
 */
function loadFlowRenderer(): {
  renderFlowSvg: (flow: unknown, report?: unknown, viewState?: unknown) => string;
  buildArchitectureFlowFromDiff: (report: unknown) => any;
  renderArchitectureBoard: (flow: unknown) => string;
} {
  const src = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.js'), 'utf8');
  const start = src.indexOf('function inferClientArchitectureLayer');
  const end = src.indexOf('function normalizeReviewMarkdown');
  assert.ok(start > 0 && end > start, 'architecture flow section must be locatable in media/tyne.js');

  const factory = new Function(`
    const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    ${src.slice(start, end)}
    return { renderFlowSvg, buildArchitectureFlowFromDiff, renderArchitectureBoard };
  `);
  return factory();
}

/**
 * Nodes are label-sized and shape-varying (rect / polygon / path / ellipse), so
 * anchor geometry on the one element every node emits exactly once: its label.
 */
function nodeAnchors(svg: string): Array<{ x: number; y: number; text: string }> {
  return [...svg.matchAll(/class="vr-flow-svg-label" x="([\d.-]+)" y="([\d.-]+)"[^>]*>([^<]*)</g)].map(m => ({
    x: Number(m[1]),
    y: Number(m[2]),
    text: m[3],
  }));
}

const siblingFlow = {
  layers: [{ id: 'extension', title: 'Application' }],
  nodes: [
    { id: 'anchor', label: 'Application', kind: 'service', layer: 'extension' },
    { id: 'a', label: 'a.ts', kind: 'ui', layer: 'extension', file: 'src/a.ts', changed: true },
    { id: 'b', label: 'b.ts', kind: 'ui', layer: 'extension', file: 'src/b.ts', changed: true },
  ],
  edges: [{ from: 'anchor', to: 'a' }, { from: 'anchor', to: 'b' }],
};

test('siblings render side by side, not stacked in one column', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const anchors = nodeAnchors(renderFlowSvg(siblingFlow));
  assert.equal(anchors.length, 3, 'all three nodes must be drawn');
  assert.ok(new Set(anchors.map(a => a.x)).size > 1, 'branching graph must not collapse to a single x position');
});

test('a child sits on a lower row than its parent', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const anchors = nodeAnchors(renderFlowSvg(siblingFlow));
  const rows = [...new Set(anchors.map(a => a.y))].sort((p, q) => p - q);
  assert.equal(rows.length, 2, 'parent and its two siblings must occupy exactly two rows');
  assert.equal(anchors.filter(a => a.y === rows[0]).length, 1, 'only the anchor belongs on the top row');
});

test('a small fan-out spreads across columns rather than stacking in one column', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const kids = ['a', 'b', 'c'];
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'root', label: 'Root', kind: 'service', layer: 'extension' },
      ...kids.map(id => ({ id, label: id + '.ts', kind: 'ui', layer: 'extension', file: 'src/' + id + '.ts' })),
    ],
    edges: kids.map(id => ({ from: 'root', to: id })),
  });

  const anchors = nodeAnchors(svg);
  const rows = [...new Set(anchors.map(a => a.y))].sort((p, q) => p - q);
  assert.equal(rows.length, 2, 'three children fit one row under the root');
  const childRow = anchors.filter(a => a.y === rows[1]);
  assert.equal(new Set(childRow.map(a => a.x)).size, 3, 'siblings must not collapse into a single column');
});

test('a wide fan-out wraps into a grid instead of overflowing the sidebar', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const kids = Array.from({ length: 12 }, (_, i) => 'f' + i);
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'root', label: 'Application', kind: 'service', layer: 'extension' },
      ...kids.map(id => ({ id, label: id + '-module.ts', kind: 'file', layer: 'extension', file: 'src/' + id + '.ts' })),
    ],
    edges: kids.map(id => ({ from: 'root', to: id })),
  }, {}, { maxWidth: 360 });

  const width = Number(svg.match(/<svg viewBox="0 0 (\d+)/)![1]);
  assert.ok(width <= 400, `a 12-way fan must wrap to fit the sidebar, got width ${width}`);

  // The twelve children must occupy several rows, not one very wide row.
  const childRows = [...new Set(nodeAnchors(svg).map(a => a.y))];
  assert.ok(childRows.length >= 4, 'a wide fan must grow downward across multiple rows');

  // And it must not force a horizontal scroll (no fixed pixel width attribute).
  assert.ok(!/<svg[^>]*\swidth="\d+"/.test(svg), 'a wrapped chart must not pin a scrollable pixel width');
});

test('layout terminates on a cyclic graph', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'a', label: 'a.ts', layer: 'extension', file: 'src/a.ts' },
      { id: 'b', label: 'b.ts', layer: 'extension', file: 'src/b.ts' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  });
  assert.equal(nodeAnchors(svg).length, 2, 'a cycle must still render both nodes');
});

test('an edge spanning several ranks is routed as a polyline, not a straight cut', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id + '.ts', layer: 'extension', file: 'src/' + id + '.ts' })),
    // a -> d spans three ranks alongside the a -> b -> c -> d chain.
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'a', to: 'd' }],
  });

  const paths = [...svg.matchAll(/class="vr-flow-svg-edge[^"]*" d="([^"]+)"/g)].map(m => m[1]);
  const longest = paths.map(d => (d.match(/[LQM]/g) || []).length).sort((p, q) => q - p)[0];
  assert.ok(longest >= 4, `multi-rank edge must bend through dummy points, got ${longest} segments`);
});

test('node kinds render distinct shapes', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'e', label: 'Start', kind: 'entry', layer: 'extension' },
      { id: 'd', label: 'Ok?', kind: 'decision', layer: 'extension' },
      { id: 'db', label: 'users', kind: 'database', layer: 'extension' },
      { id: 'f', label: 'plain.ts', kind: 'file', layer: 'extension' },
    ],
    edges: [{ from: 'e', to: 'd' }, { from: 'd', to: 'db' }, { from: 'db', to: 'f' }],
  });

  const groups = [...svg.matchAll(/<g class="vr-flow-svg-node[^"]*" data-node-id="([^"]+)">(.*?)<\/g>/gs)];
  const byId = Object.fromEntries(groups.map(m => [m[1], m[2]]));

  assert.ok(/<polygon/.test(byId['d']), 'a decision must be a diamond');
  assert.ok(/<ellipse/.test(byId['db']), 'a database must be a cylinder');
  assert.ok(/<rect/.test(byId['f']) && !/<polygon|<ellipse/.test(byId['f']), 'a plain file must be a rect');
  // A stadium is a rect whose corner radius is half its height.
  const stadium = byId['e'].match(/<rect[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(stadium, 'entry must render a rect');
  assert.equal(Number(stadium![2]), Number(stadium![1]) / 2, 'entry must be fully rounded');
});

test('a long label is truncated rather than overflowing the node', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [{
      id: 'a',
      label: 'an-extremely-long-module-name-that-would-otherwise-spill-past-the-edge.ts',
      kind: 'file',
      layer: 'extension',
    }],
    edges: [],
  });

  const [anchor] = nodeAnchors(svg);
  assert.ok(anchor, 'the node must render');
  assert.ok(anchor.text.length <= 32, `label must be truncated, got ${anchor.text.length} chars`);
  assert.ok(anchor.text.endsWith('…'), 'truncation must be marked with an ellipsis');
});

test('edge labels render a background plate behind the text', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'a', label: 'a.ts', layer: 'extension' },
      { id: 'b', label: 'b.ts', layer: 'extension' },
    ],
    edges: [{ from: 'a', to: 'b', label: 'calls' }],
  });

  const plate = svg.match(/class="vr-flow-svg-edge-label-bg"[^>]*width="([\d.]+)"/);
  assert.ok(plate, 'an edge label must sit on a background plate so it does not collide with the line');
  assert.ok(svg.includes('class="vr-flow-svg-edge-label"'), 'the label text must render');
  assert.ok(Number(plate![1]) > 'calls'.length * 4, 'the plate must be at least as wide as its text');
});

test('legacy reports with all-zero counts render no +0/-0 badges', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  // Every report written before the numstat fix looks like this.
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'a', label: 'a.ts', layer: 'extension', file: 'src/a.ts', changed: true, additions: 0, deletions: 0 },
      { id: 'b', label: 'b.ts', layer: 'extension', file: 'src/b.ts', changed: true, additions: 0, deletions: 0 },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });

  assert.equal(nodeAnchors(svg).length, 2, 'legacy nodes must still render');
  assert.ok(!svg.includes('+0'), 'must not print a wall of +0 badges');
  assert.ok(!svg.includes('class="vr-flow-svg-sub"'), 'no sub line at all when there are no real counts');
});

test('a node with no kind still renders', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  // Rows persisted before the kind enum was extended.
  const svg = renderFlowSvg({
    nodes: [{ id: 'a', label: 'legacy.ts' }],
    edges: [],
  });
  assert.equal(nodeAnchors(svg).length, 1, 'an unknown/absent kind must fall back to a rect');
});

test('the visualDiff fallback hangs files off a layer anchor, not off each other', () => {
  const { buildArchitectureFlowFromDiff } = loadFlowRenderer();
  const flow = buildArchitectureFlowFromDiff({
    visualDiff: [
      { file: 'src/ui/one.tsx', additions: 3, deletions: 1 },
      { file: 'src/ui/two.tsx', additions: 4, deletions: 0 },
      { file: 'src/ui/three.tsx', additions: 5, deletions: 2 },
    ],
    findings: [],
  });

  assert.ok(flow.edges.length > 0, 'fallback must produce edges');
  flow.edges.forEach((edge: { from: string; to: string }) => {
    assert.ok(
      edge.from.startsWith('layer_'),
      `diff order is not call order: edge ${edge.from} -> ${edge.to} invents a dependency`,
    );
  });
});

test('a chart that fits caps its own width rather than upscaling to fill the pane', () => {
  const { renderFlowSvg } = loadFlowRenderer();
  const svg = renderFlowSvg({
    layers: [{ id: 'extension', title: 'Application' }],
    nodes: [
      { id: 'a', label: 'a.ts', layer: 'extension' },
      { id: 'b', label: 'b.ts', layer: 'extension' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });

  // A small chart must not be pinned to a fixed pixel width (which would scroll)
  // and must cap its own max-width so it isn't blown up to the full pane.
  assert.ok(!/<svg[^>]*\swidth="\d+"/.test(svg), 'a fitting chart must not pin a scroll width');
  assert.ok(/max-width:\s*\d+px/.test(svg), 'a fitting chart must cap its own max-width');
});

test('architecture board groups API and Database into labeled sections with cross links', () => {
  const { renderArchitectureBoard } = loadFlowRenderer();
  const html = renderArchitectureBoard({
    nodes: [
      { id: 'api', label: 'handler.ts', kind: 'api', layer: 'backend', section: 'backend', file: 'src/api/handler.ts', changed: true },
      { id: 'db', label: 'orders', kind: 'database', layer: 'database', section: 'database', evidenceFile: 'src/api/handler.ts', evidenceLine: 4 },
    ],
    edges: [{ from: 'api', to: 'db', kind: 'data', label: 'queries' }],
  });
  assert.ok(html.includes('vr-arch-band'), 'board must render section bands');
  assert.ok(html.includes('data-section="backend"'), 'must show API/services band');
  assert.ok(html.includes('data-section="database"'), 'must show Database band');
  assert.ok(html.includes('vr-arch-links'), 'cross-section links must render');
  assert.ok(html.includes('queries'), 'edge verb must appear on the link row');
});

test('default architecture section prefers board and hides graph behind a toggle', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.js'), 'utf8');
  assert.ok(src.includes('renderArchitectureBoard(flow)'), 'section must render the board');
  assert.ok(src.includes('vr-arch-graph-toggle'), 'graph view must be behind a details toggle');
  const sectionFn = src.slice(src.indexOf('function renderArchitectureFlowSection'), src.indexOf('function renderReadingOrderStrip'));
  assert.ok(sectionFn.indexOf('renderArchitectureBoard') < sectionFn.indexOf('vr-arch-graph-toggle'), 'board comes before graph toggle');
});
