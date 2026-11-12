// Port of Moonlight module 59786: sentence splitting, block <-> sentence geometry, part composition.
import { isHeadingText } from './layoutBlocks.js';

const SENTENCE_END = /[.?!]["'”’)\]]*\s+/g;
const NEXT_STARTS_SENTENCE = /^["'“‘([]?[\p{Lu}\d]/u;
const ABBREVIATION = /(?:^|[\s(])(?:Fig|Figs|Eq|Eqs|Sec|Secs|Tab|Ref|Refs|No|Vol|etc|vs|cf|resp|approx|Dr|Prof|Mr|Ms|i\.e|e\.g|\p{Lu})\.$/u;

const round2 = (v) => Math.round(100 * v) / 100;

export function splitSentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const idx = m.index ?? 0;
    const next = idx + m[0].length;
    const end = next - m[0].length + m[0].trimEnd().length;
    const head = text.slice(start, idx + 1);
    const abbreviation = ABBREVIATION.test(head);
    const etAl = /\bal\.$/.test(head) && !/^\p{Lu}\p{Ll}/u.test(text.slice(next));
    if (/^\s*\d+(?:\.\d+)*\.$/.test(head) || /(?:^|\s)\d+(?:\.\d+)+\.$/.test(head) || abbreviation || etAl || !NEXT_STARTS_SENTENCE.test(text.slice(next))) continue;
    out.push({ start, end });
    start = next;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

const NARROW = /[iltfjI.,;:'|![\]() ]/;
const WIDE = /[mwMW]/;
const textWidth = (s) => [...s].reduce((w, c) => w + (NARROW.test(c) ? 0.5 : WIDE.test(c) ? 1.5 : 1), 0);

// Estimated x of a character offset inside a line, interpolated within its PDF.js run.
export function getLineX(block, line, offset) {
  const run = [...line.runs].reverse().find((r) => r.offset <= offset) ?? line.runs[0];
  const s = block.text.slice(line.start + run.offset, line.start + run.offset + run.length);
  const total = textWidth(s) || 1;
  const frac = Math.min(1, textWidth(s.slice(0, offset - run.offset)) / total);
  return run.left + (run.right - run.left) * frac;
}

export function getBlockRangeRects(block, start, end) {
  return block.lines
    .filter((l) => l.start < end && l.end > start)
    .map((l) => {
      const x0 = getLineX(block, l, Math.max(start, l.start) - l.start);
      const x1 = getLineX(block, l, Math.min(end, l.end) - l.start);
      return { left: round2(x0), top: round2(l.top), width: round2(x1 - x0), height: round2(l.bottom - l.top) };
    });
}

export function getBlockTextPosition(block, offset) {
  const line = block.lines.find((l) => offset >= l.start && offset <= l.end) ?? block.lines[block.lines.length - 1];
  const o = Math.min(offset, line.end) - line.start;
  const run = [...line.runs].reverse().find((r) => r.offset <= o) ?? line.runs[0];
  return { itemIndex: run.itemIndex, itemOffset: Math.min(o - run.offset, run.length) + run.skip };
}

export function buildPageSentences(blocks) {
  return blocks.flatMap((block, blockIndex) =>
    splitSentences(block.text).map((s) => ({
      ...s,
      blockIndex,
      text: block.text.slice(s.start, s.end),
      // A bold run-in heading ("3.1 Method.") stays in the source language.
      ...(s.start === 0 && block.boldPrefix && isHeadingText(block.boldPrefix) && s.end <= block.boldPrefix.trimEnd().length + 1 ? { keepSource: true } : {}),
    })),
  );
}

// sentences + translated segments -> Map(blockIndex -> parts[]). Blocks with sentences beyond
// `resolvedCount` (still streaming) are left out so a block only renders once fully known.
export function composeBlockParts(sentences, segments, resolvedCount) {
  const bySentence = new Map();
  segments.forEach(({ members, text }) => {
    if (members.length === 1) bySentence.set(members[0], { text, members, translated: true });
  });
  const parts = new Map();
  sentences.forEach((s, i) => {
    if (i >= resolvedCount) {
      parts.set(s.blockIndex, []);
      return;
    }
    const list = parts.get(s.blockIndex) ?? [];
    parts.set(s.blockIndex, list);
    const t = s.keepSource ? undefined : bySentence.get(i);
    list.push(t ?? { text: s.text, members: [i], translated: false });
  });
  const pending = new Set(sentences.slice(resolvedCount).map((s) => s.blockIndex));
  return new Map([...parts].filter(([b, list]) => !pending.has(b) && list.some((p) => p.translated)));
}

export const getSentenceRects = (blocks, sentences, i) => {
  const s = sentences[i];
  return getBlockRangeRects(blocks[s.blockIndex], s.start, s.end);
};

export const containsPoint = (r, x, y) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;

export const getPartsSignature = (parts) => [...parts].map(([b, list]) => `${b}:${list.map((p) => p.text).join('')}`).join('');
