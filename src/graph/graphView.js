// Draws a layoutGraph() result with vis-network, using the options graphify's graph.html uses
// (exporters/html.py: forceAtlas2Based physics, stabilise for 200 iterations, then freeze).
// vis-network is loaded on first use, so the library screen does not pay for it.

const ellipsis = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1d1d1f';

export async function createGraphView(container, graph, { onSelect, onOpen }) {
  const { Network, DataSet } = await import('vis-network/standalone');
  const labelColor = ink();
  const visNode = (n, i) => ({
    id: n.id,
    label: n.kind === 'paper' ? ellipsis(n.label, 48) : n.label,
    title: n.kind === 'paper' ? n.label : `${n.label} · 논문 ${n.degree}편`, // a string, so vis renders it as text, never HTML
    size: n.size,
    shape: n.kind === 'paper' ? 'square' : 'dot',
    color: { background: n.color, border: n.color, highlight: { background: '#ffffff', border: n.color }, hover: { background: n.color, border: labelColor } },
    font: { size: n.showLabel ? (n.kind === 'paper' ? 13 : 12) : 0, color: labelColor, face: 'system-ui, -apple-system, sans-serif' },
    // Golden-angle spiral seed, as graphify does, so physics never starts from overlapping points.
    x: 30 * Math.sqrt(i) * Math.cos(i * 2.4),
    y: 30 * Math.sqrt(i) * Math.sin(i * 2.4),
  });
  const nodes = new DataSet(graph.nodes.map(visNode));
  const edges = new DataSet(
    graph.edges.map((e, i) => ({
      id: i,
      from: e.from,
      to: e.to,
      title: e.relation === 'cites' ? '인용' : '주제',
      dashes: e.confidence !== 'EXTRACTED',
      width: e.relation === 'cites' ? 2 : 1,
      color: { color: e.relation === 'cites' ? '#0066cc' : '#8e8e93', opacity: e.relation === 'cites' ? 0.8 : 0.35 },
      arrows: { to: { enabled: e.relation === 'cites', scaleFactor: 0.5 } },
    })),
  );
  const network = new Network(
    container,
    { nodes, edges },
    {
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.005, springLength: 120, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 },
        stabilization: { iterations: 200, fit: true },
      },
      interaction: { hover: true, tooltipDelay: 100, hideEdgesOnDrag: true, navigationButtons: false, keyboard: false },
      nodes: { borderWidth: 1.5 },
      edges: { smooth: { type: 'continuous', roundness: 0.2 }, selectionWidth: 3 },
    },
  );
  network.once('stabilizationIterationsDone', () => network.setOptions({ physics: { enabled: false } }));
  network.on('click', (p) => onSelect(p.nodes[0] ?? null));
  network.on('doubleClick', (p) => {
    const n = graph.nodes.find((x) => x.id === p.nodes[0]);
    if (n?.kind === 'paper') onOpen(n.docId);
  });
  network.on('hoverNode', () => (container.style.cursor = 'pointer'));
  network.on('blurNode', () => (container.style.cursor = 'default'));

  // Labels follow the app's light/dark appearance.
  const appearance = new MutationObserver(() => {
    const color = ink();
    nodes.update(graph.nodes.map((n, i) => ({ id: n.id, font: { ...visNode(n, i).font, color } })));
  });
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] });

  return {
    focus(id) {
      if (!nodes.get(id)) return;
      network.focus(id, { scale: 1.4, animation: true });
      network.selectNodes([id]);
    },
    /** Hides every node whose community is in the set (the legend's checkboxes). */
    setHidden(hidden) {
      nodes.update(graph.nodes.map((n) => ({ id: n.id, hidden: hidden.has(n.community) })));
    },
    fit: () => network.fit({ animation: true }),
    destroy() {
      appearance.disconnect();
      network.destroy();
    },
  };
}
