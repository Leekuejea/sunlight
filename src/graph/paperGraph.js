// Paper graph: papers and their topics as one graph, grouped into communities.
// Follows graphify's pipeline (graphify 0.9.109, Apache-2.0): an LLM names each document's concepts once
// (server: graph.rs), then the graph is built, clustered with Louvain and labelled by each community's hub,
// and drawn with graphify's vis-network styling. Pure functions, so node tests cover them.

// graphify exporters/base.py COMMUNITY_COLORS
export const COMMUNITY_COLORS = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];

/** Lowercase letters and digits separated by single spaces: the form titles and reference lists are compared in. */
export function normalize(text = '') {
  return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const singular = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !/(ss|is|us)$/.test(w) ? w.slice(0, -1) : w);
/** One key per topic across papers: "Diffusion Policies" and "diffusion policy" are the same node. */
export const topicKey = (topic) => normalize(topic).split(' ').map(singular).join(' ');

const HEAD_CHARS = 6000;
const REFS_CHARS = 60000;
const REFS_HEADING = /\b(references|bibliography)\b|참\s*고\s*문\s*헌/gi;

/**
 * What the server's extraction reads: `head` (title and abstract, for the model) and `refs`
 * (the normalised reference list, kept to find citations between library papers without a model).
 */
export function paperText(pages, numPages = pages.length, headPages = 3) {
  const head = pages.slice(0, Math.min(headPages, numPages)).join('\n').replace(/[ \t]+/g, ' ').slice(0, HEAD_CHARS);
  const all = pages.join('\n');
  let at = -1;
  for (const m of all.matchAll(REFS_HEADING)) at = m.index; // the last heading: "references" also appears in running text
  const refs = normalize(at >= 0 ? all.slice(at) : pages.slice(-4).join('\n')).slice(0, REFS_CHARS);
  return { head, refs };
}

/** The library's topic vocabulary, most used first: sent with each new analysis so papers reuse one wording. */
export function knownTopics(papers, max = 200) {
  const count = new Map();
  for (const p of Object.values(papers)) {
    for (const t of p.topics ?? []) {
      const key = topicKey(t);
      const c = count.get(key) ?? { label: t, n: 0 };
      c.n++;
      count.set(key, c);
    }
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, max).map((c) => c.label);
}

/** Titles this short match too much text by accident, so they never count as a citation. */
const MIN_TITLE_WORDS = 4;

/**
 * docs: library entries; papers: { [docId]: { title, topics, summary, refs } } from /api/graph.
 * Returns graphify-shaped nodes and edges: paper -covers-> topic, paper -cites-> paper.
 */
export function buildGraph(docs, papers) {
  const nodes = [];
  const edges = [];
  const topics = new Map(); // key -> { node, variants: Map<label, count> }
  const analysed = docs.filter((d) => papers[d.id]);
  for (const doc of analysed) {
    const p = papers[doc.id];
    const id = `paper:${doc.id}`;
    nodes.push({ id, kind: 'paper', docId: doc.id, label: p.title || doc.title, summary: p.summary || '', fileTitle: doc.title });
    for (const t of new Set(p.topics.map(topicKey))) {
      if (!t) continue;
      const tid = `topic:${t}`;
      if (!topics.has(t)) {
        const node = { id: tid, kind: 'topic', label: t, rank: Infinity };
        topics.set(t, { node, variants: new Map() });
        nodes.push(node);
      }
      edges.push({ from: id, to: tid, relation: 'covers', confidence: 'EXTRACTED' });
    }
    p.topics.forEach((raw, i) => {
      const entry = topics.get(topicKey(raw));
      if (!entry) return;
      entry.variants.set(raw, (entry.variants.get(raw) ?? 0) + 1);
      entry.node.rank = Math.min(entry.node.rank, i); // the model lists broad fields first
    });
  }
  // The label is the wording most papers used.
  for (const { node, variants } of topics.values()) node.label = [...variants].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? node.label;
  for (const a of analysed) {
    const refs = papers[a.id].refs || '';
    if (!refs) continue;
    for (const b of analysed) {
      if (a === b) continue;
      const title = normalize(papers[b.id].title);
      if (title.split(' ').length >= MIN_TITLE_WORDS && ` ${refs} `.includes(` ${title} `)) {
        edges.push({ from: `paper:${a.id}`, to: `paper:${b.id}`, relation: 'cites', confidence: 'EXTRACTED' });
      }
    }
  }
  return { nodes, edges };
}

// ---------- Louvain (networkx louvain_communities: graphify's fallback when Leiden is not installed) ----------

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function addWeight(adj, a, b, w) {
  adj[a].set(b, (adj[a].get(b) ?? 0) + w);
  if (a !== b) adj[b].set(a, (adj[b].get(a) ?? 0) + w);
}

const degreeOf = (adj, u) => {
  let d = 0;
  for (const [v, w] of adj[u]) d += v === u ? 2 * w : w; // a self-loop counts twice, as in networkx
  return d;
};

function totalWeight(adj) {
  let m = 0;
  adj.forEach((nb, u) => nb.forEach((w, v) => v >= u && (m += w)));
  return m;
}

function modularity(adj, communities, m, resolution) {
  let q = 0;
  for (const c of communities) {
    let inside = 0;
    let degree = 0;
    for (const u of c) {
      degree += degreeOf(adj, u);
      for (const [v, w] of adj[u]) if (v >= u && c.has(v)) inside += w;
    }
    q += inside / m - resolution * (degree / (2 * m)) ** 2;
  }
  return q;
}

function oneLevel(adj, m, partition, members, resolution, rand) {
  const n = adj.length;
  const node2com = Array.from({ length: n }, (_, i) => i);
  const inner = Array.from({ length: n }, (_, i) => new Set([i]));
  const part = partition.map((s) => new Set(s));
  const degrees = adj.map((_, u) => degreeOf(adj, u));
  const stot = degrees.slice();
  const order = shuffle([...Array(n).keys()], rand);
  let improved = false;
  for (let moves = 1; moves > 0; ) {
    moves = 0;
    for (const u of order) {
      let bestGain = 0;
      let best = node2com[u];
      const toCom = new Map();
      for (const [v, w] of adj[u]) if (v !== u) toCom.set(node2com[v], (toCom.get(node2com[v]) ?? 0) + w);
      const deg = degrees[u];
      stot[best] -= deg;
      const removeCost = -(toCom.get(best) ?? 0) / m + (resolution * stot[best] * deg) / (2 * m * m);
      for (const [c, w] of toCom) {
        const gain = removeCost + w / m - (resolution * stot[c] * deg) / (2 * m * m);
        if (gain > bestGain) {
          bestGain = gain;
          best = c;
        }
      }
      stot[best] += deg;
      if (best !== node2com[u]) {
        for (const o of members[u]) part[node2com[u]].delete(o);
        inner[node2com[u]].delete(u);
        for (const o of members[u]) part[best].add(o);
        inner[best].add(u);
        node2com[u] = best;
        improved = true;
        moves++;
      }
    }
  }
  return [part.filter((s) => s.size), inner.filter((s) => s.size), improved];
}

function aggregate(adj, inner, members) {
  const com = [];
  inner.forEach((set, i) => set.forEach((u) => (com[u] = i)));
  const next = inner.map(() => new Map());
  adj.forEach((nb, u) => nb.forEach((w, v) => v >= u && addWeight(next, com[u], com[v], w)));
  return { adj: next, members: inner.map((set) => [...set].flatMap((u) => members[u])) };
}

/** networkx louvain_communities(seed=42, threshold=1e-4, resolution, max_level=10) over an undirected simple graph. */
export function louvain(nodeIds, edges, { resolution = 1, threshold = 1e-4, seed = 42, maxLevel = 10 } = {}) {
  const ids = [...nodeIds].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  let adj = ids.map(() => new Map());
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) continue;
    adj[a].set(b, 1); // a simple graph: a repeated pair is one edge, as in nx.Graph
    adj[b].set(a, 1);
  }
  const m = totalWeight(adj);
  if (!m) return ids.map((id) => [id]);
  const rand = mulberry32(seed);
  let members = ids.map((_, i) => [i]);
  let mod = modularity(adj, ids.map((_, i) => new Set([i])), m, resolution);
  let [part, inner, improved] = oneLevel(adj, m, ids.map((_, i) => new Set([i])), members, resolution, rand);
  let result = part;
  for (let level = 1; ; level++) {
    result = part;
    if (level >= maxLevel) break;
    const next = modularity(adj, inner, m, resolution);
    if (next - mod <= threshold) break;
    mod = next;
    ({ adj, members } = aggregate(adj, inner, members));
    [part, inner, improved] = oneLevel(adj, m, part, members, resolution, rand);
    if (!improved) break;
  }
  return result.map((s) => [...s].map((i) => ids[i]));
}

// ---------- graphify cluster.cluster() ----------

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;
const COHESION_SPLIT_THRESHOLD = 0.05;
const COHESION_SPLIT_MIN_SIZE = 50;

/** Undirected simple-graph view: neighbour sets keyed by node id. */
export function neighbours(nodes, edges) {
  const nb = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    if (!nb.has(e.from) || !nb.has(e.to)) continue;
    nb.get(e.from).add(e.to);
    nb.get(e.to).add(e.from);
  }
  return nb;
}

function cohesion(nb, members) {
  const n = members.length;
  if (n <= 1) return 1;
  const set = new Set(members);
  let inside = 0;
  for (const u of members) for (const v of nb.get(u)) if (v !== u && set.has(v)) inside++;
  return inside / 2 / ((n * (n - 1)) / 2);
}

function split(nb, members) {
  const set = new Set(members);
  const edges = [];
  for (const u of members) for (const v of nb.get(u)) if (set.has(v) && u < v) edges.push({ from: u, to: v });
  if (!edges.length) return members.map((n) => [n]);
  const parts = louvain(members, edges);
  return parts.length > 1 ? parts : [members];
}

/** Returns communities as arrays of node ids, largest first (index = community id). */
export function cluster(nodes, edges) {
  if (!nodes.length) return [];
  const nb = neighbours(nodes, edges);
  const isolates = nodes.filter((n) => nb.get(n.id).size === 0).map((n) => n.id);
  const connected = nodes.filter((n) => nb.get(n.id).size > 0).map((n) => n.id);
  const connectedSet = new Set(connected);
  const raw = connected.length ? louvain(connected, edges.filter((e) => connectedSet.has(e.from) && connectedSet.has(e.to))) : [];
  raw.push(...isolates.map((id) => [id]));
  const maxSize = Math.max(MIN_SPLIT_SIZE, Math.floor(nodes.length * MAX_COMMUNITY_FRACTION));
  const sized = raw.flatMap((c) => (c.length > maxSize ? split(nb, c) : [c]));
  const final = sized.flatMap((c) => (c.length >= COHESION_SPLIT_MIN_SIZE && cohesion(nb, c) < COHESION_SPLIT_THRESHOLD ? split(nb, c) : [c]));
  const sorted = final.map((c) => [...c].sort());
  sorted.sort((a, b) => b.length - a.length || (a.join('\0') < b.join('\0') ? -1 : a.join('\0') > b.join('\0') ? 1 : 0));
  return sorted;
}

/**
 * graphify label_communities_by_hub: each community is named after its highest-degree member (ties by id).
 * Here the hub is chosen among topics when the community has any, so a group reads as a subject, not a title,
 * and degree ties go to the topic listed earliest (the broad field) rather than the alphabetically first.
 */
export function labelCommunities(nodes, communities, nb) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return communities.map((members) => {
    const topics = members.filter((id) => byId.get(id)?.kind === 'topic');
    const pool = topics.length ? topics : members;
    const rank = (id) => byId.get(id)?.rank ?? Infinity;
    const hub = [...pool].sort((a, b) => nb.get(b).size - nb.get(a).size || rank(a) - rank(b) || (a < b ? -1 : 1))[0];
    return byId.get(hub)?.label ?? '';
  });
}

/** Everything the view and the sidebar need, with graphify's to_html sizing and edge styling. */
export function layoutGraph(docs, papers) {
  const { nodes, edges } = buildGraph(docs, papers);
  const nb = neighbours(nodes, edges);
  const communities = cluster(nodes, edges);
  const labels = labelCommunities(nodes, communities, nb);
  const communityOf = new Map();
  communities.forEach((members, cid) => members.forEach((id) => communityOf.set(id, cid)));
  const maxDegree = Math.max(1, ...nodes.map((n) => nb.get(n.id).size));
  for (const n of nodes) {
    const degree = nb.get(n.id).size;
    n.degree = degree;
    n.community = communityOf.get(n.id) ?? 0;
    n.color = COMMUNITY_COLORS[n.community % COMMUNITY_COLORS.length];
    n.size = Math.round((10 + 30 * (degree / maxDegree)) * 10) / 10;
    // graphify labels only nodes with at least 15% of the top degree; papers are what the reader is here for, so they always are.
    n.showLabel = n.kind === 'paper' || degree >= maxDegree * 0.15;
  }
  return {
    nodes,
    edges,
    communities: communities.map((members, cid) => ({ cid, label: labels[cid], color: COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length], count: members.length, papers: members.filter((id) => id.startsWith('paper:')).length })),
  };
}
