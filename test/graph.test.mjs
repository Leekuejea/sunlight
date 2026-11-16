import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, cluster, knownTopics, layoutGraph, louvain, normalize, paperText, topicKey } from '../src/graph/paperGraph.js';

test('topics merge across spelling, case and plural', () => {
  assert.equal(topicKey('Diffusion Policies'), 'diffusion policy');
  assert.equal(topicKey('diffusion-policy'), 'diffusion policy');
  assert.equal(topicKey('Graph Analysis'), 'graph analysis'); // "-is" words keep their s
  assert.equal(normalize('  “Attention” Is All You Need! '), 'attention is all you need');
});

test('paper text keeps the opening and the reference list after the last heading', () => {
  const pages = ['Title\nAbstract: we cite references in passing.', 'Body text', 'References\n[1] A. Author. Attention Is All You Need. 2017.'];
  const { head, refs } = paperText(pages);
  assert.match(head, /^Title/);
  assert.equal(refs, 'references 1 a author attention is all you need 2017');
});

const docs = [
  { id: 'a', title: 'a.pdf' },
  { id: 'b', title: 'b.pdf' },
  { id: 'c', title: 'c.pdf' },
];
const papers = {
  a: { title: 'Diffusion Policy for Robot Manipulation', topics: ['robot learning', 'Diffusion Policies'], summary: '', refs: '' },
  b: { title: 'Flow Matching Policies', topics: ['robot learning', 'diffusion policy', 'flow matching'], summary: '', refs: normalize('[3] C. Chi. Diffusion Policy for Robot Manipulation. RSS 2023.') },
  c: { title: 'Short', topics: ['language model'], summary: '', refs: 'short paper cites a short title' },
};

test('papers link through shared topics and through citations found in the reference list', () => {
  const { nodes, edges } = buildGraph(docs, papers);
  assert.equal(nodes.filter((n) => n.kind === 'topic').length, 4);
  assert.equal(nodes.find((n) => n.id === 'topic:diffusion policy').label, 'Diffusion Policies'); // ties: first by name
  const cites = edges.filter((e) => e.relation === 'cites');
  assert.deepEqual(cites, [{ from: 'paper:b', to: 'paper:a', relation: 'cites', confidence: 'EXTRACTED' }]);
});

test('unanalysed papers stay out of the graph', () => {
  const { nodes } = buildGraph([...docs, { id: 'd', title: 'd.pdf' }], papers);
  assert.ok(!nodes.some((n) => n.id === 'paper:d'));
});

test('louvain separates two cliques joined by one bridge, and is deterministic', () => {
  const clique = (p) => {
    const ids = [0, 1, 2, 3, 4].map((i) => `${p}${i}`);
    return ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ from: a, to: b })));
  };
  const edges = [...clique('x'), ...clique('y'), { from: 'x0', to: 'y0' }];
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const parts = louvain(ids, edges).map((c) => c.sort().join(','));
  assert.deepEqual(parts.sort(), ['x0,x1,x2,x3,x4', 'y0,y1,y2,y3,y4']);
  assert.deepEqual(louvain(ids, edges), louvain(ids, edges));
});

test('cluster gives isolates their own community and orders by size', () => {
  const nodes = ['a', 'b', 'c', 'lone'].map((id) => ({ id }));
  const communities = cluster(nodes, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]);
  assert.deepEqual(communities, [['a', 'b', 'c'], ['lone']]);
});

test('layout sizes nodes by degree and names each community after its hub topic', () => {
  const g = layoutGraph(docs, papers);
  const rl = g.nodes.find((n) => n.id === 'topic:robot learning');
  assert.equal(rl.degree, 2);
  assert.equal(rl.size, 10 + 30 * (2 / 4)); // paper b has the top degree: 3 topics + 1 citation
  const c = g.communities[g.nodes.find((n) => n.id === 'paper:c').community];
  assert.equal(c.label, 'language model');
  assert.equal(c.papers, 1);
});

test('the vocabulary sent to the model lists the most used topics first, once each', () => {
  assert.deepEqual(knownTopics(papers), ['Diffusion Policies', 'robot learning', 'flow matching', 'language model']);
});

test('a community of equal-degree topics is named after the topic listed first', () => {
  const g = layoutGraph([{ id: 'x', title: 'x' }], { x: { title: 'X', topics: ['robotics', 'aardvark method'], summary: '', refs: '' } });
  assert.equal(g.communities[0].label, 'robotics');
});
