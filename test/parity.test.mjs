// Parity check against Moonlight 3.7.5: the sentence lists Moonlight's client sent to
// /ai/translate-page-with-source-v2 for pages 1-4 of arXiv:2611.08654v1 (captured live) must be
// reproduced exactly by the ported block builder + sentence splitter.
// Also checks the stream parser on the captured server responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildLayoutBlocks } from '../src/layout/layoutBlocks.js';
import { buildPageSentences, composeBlockParts } from '../src/layout/sentences.js';
import { splitCompletedStream, parseTranslatedSegments } from '../src/layout/stream.js';

const MATH = /CMMI|CMSY|CMEX|MSAM|MSBM|EUSM|EUFM|RSFS|STIXMath|Math|[tp]x(?:sy|mi|ex)|MT(?:SY|MI|EX)/i;
const BOLD = /bold|black|heavy|medi|demi|CMBX|CMSSBX/i;
const MONO = /Courier|Mono|Consolas|Menlo|CMTT|SFTT|Typewriter/i;
const ITALIC = /ital|obli|slant|CMTI|CMSL|-It$/i;

// Same steps as loadPageBlocks() in layoutTranslation.js, minus the DOM.
async function pageSentences(doc, pageIndex) {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  await page.getOperatorList();
  const content = await page.getTextContent();
  const items = content.items.filter((i) => typeof i.str === 'string');
  const name = (id) => (page.commonObjs.has(id) && page.commonObjs.get(id)?.name) || '';
  const ids = [...new Set(items.map((i) => i.fontName))];
  const pick = (re) => new Set(ids.filter((id) => re.test(name(id))));
  const blocks = buildLayoutBlocks(items, {
    viewportTransform: viewport.transform,
    pageWidth: viewport.width,
    mathFontNames: pick(MATH),
    boldFontNames: pick(BOLD),
    italicFontNames: pick(ITALIC),
    monospaceFontNames: new Set(ids.filter((id) => MONO.test(name(id)) || content.styles[id]?.fontFamily === 'monospace')),
  }).filter((b) => b.translatable);
  return { blocks, sentences: buildPageSentences(blocks) };
}

// The paper is not redistributed in this repository: fetched from arXiv once, then kept locally (gitignored).
const PDF_URL = 'https://arxiv.org/pdf/2611.08654v1';
const PDF_SHA256 = 'd796131e23c25c662c00dff1908ac7a6196da8cbeafcab0c256cf209ca523761';
async function fixturePdf() {
  const file = new URL('./fixtures/cspi-2611.08654v1.pdf', import.meta.url);
  if (!fs.existsSync(file)) {
    const res = await fetch(PDF_URL);
    assert.ok(res.ok, `download ${PDF_URL}: ${res.status}`);
    fs.writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  }
  const data = new Uint8Array(fs.readFileSync(file));
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), PDF_SHA256, 'fixture PDF changed');
  return data;
}

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/moonlight-cspi-requests.json', import.meta.url)));

test('sentence lists match Moonlight for pages 1-4', async () => {
  const data = await fixturePdf();
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  for (let i = 0; i < 4; i++) {
    const { sentences } = await pageSentences(doc, i);
    const mine = sentences.map((s) => s.text);
    const theirs = captured.find((c) => c.texts[0] === mine[0])?.texts;
    assert.ok(theirs, `page ${i + 1}: no captured request starts with ${JSON.stringify(mine[0])}`);
    assert.deepEqual(mine, theirs, `page ${i + 1}`);
  }
});

test('stream parser resolves every captured segment', () => {
  for (const { texts, response } of captured) {
    const { text, isFinal } = splitCompletedStream(response);
    assert.ok(isFinal);
    const { segments, resolvedCount } = parseTranslatedSegments(text, texts, true);
    assert.equal(resolvedCount, texts.length);
    // Unchanged segments (author line, venue) are dropped so they keep the original rendering.
    assert.ok(segments.length > 0 && segments.length <= texts.length);
  }
});

test('partial stream only resolves segments followed by the next marker', () => {
  const texts = ['A one.', 'B two.', 'C three.'];
  const partial = splitCompletedStream('<|0|>가 하나.\n<|1|>나 둘');
  const { segments, resolvedCount } = parseTranslatedSegments(partial.text, texts, false);
  assert.deepEqual(segments, [{ members: [0], text: '가 하나.' }]);
  assert.equal(resolvedCount, 1);
  const blocks = composeBlockParts([{ blockIndex: 0, text: 'A one.' }, { blockIndex: 1, text: 'B two.' }, { blockIndex: 1, text: 'C three.' }], segments, resolvedCount);
  assert.deepEqual([...blocks.keys()], [0]); // block 1 still streaming -> not rendered yet
});
