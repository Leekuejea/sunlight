// Port of Moonlight 3.7.5 pdfScript.js webpack module 53724 (browser layout block builder).
// Turns PDF.js textContent items into line objects, groups lines into paragraph blocks and
// classifies blocks that must stay untranslated (equations, bibliography, code, ...).
// All thresholds are the shipped constants; names are reconstructed.

const LINE_TOP = 0.8; // line top = baseline - 0.8 * fontSize
const LINE_BOTTOM = 0.22; // line bottom = baseline + 0.22 * fontSize
const MAX_TEXT_ANGLE = 0.05;
const SAME_BASELINE = 0.45;
const MAX_ITEM_GAP = 1.5;
const RTL_MIN_LETTERS = 10;
const RTL_OVERLAP = 0.3;
const SPACE_GAP = 0.15;
const MIN_LINE_ADVANCE = 0.3;
const DEFAULT_PARAGRAPH_ADVANCE = 1.75;
const ADVANCE_SLACK = 1.25;
const MAX_LINE_ADVANCE = 2.8;
const FONT_SIZE_TOLERANCE = 0.12;
const INDENT = 0.8;
const SHORT_LINE_GAP = 2;
const MIN_LETTERS = 6;
const MIN_LETTER_RATIO = 0.6;
const MATH_HEAVY_RATIO = 0.3;
const MATH_HEAVY_MAX_WORDS = 12;
const LINE_OVERHANG = 0.5;
const HEADING_MAX_LINES = 3;
const HEADING_MAX_WORDS = 14;
const EQUATION_NUMBER_TAIL = /\((?:[A-Z]\.?)?\d{1,3}(?:\.\d{1,3})?[a-z]?\)\s*$/;
const NUMBERED_EQUATION_MAX_WORDS = 12;
const EQUATION_MAX_WORDS = 12;
const PROSE_MIN_WORDS = 3;
const PROSE_LETTER_SHARE = 0.5;
const WORD_RE = /\p{L}[\p{L}\p{M}]+/gu;
const CENTERED_TOLERANCE = 0.6;
const BOLD_HEADING_SIZE = 1.4;
const SCRIPT_SIZE = 0.85;
const SCRIPT_RISE = 1.3;
const SMALL_FONT_A = 0.8;
const SMALL_WORDS_A = 2;
const SMALL_FONT_B = 0.75;
const SMALL_WORDS_B = 6;
const BOLD_SHARE = 0.8;
const EQUATION_COVER = 0.3;
const BESIDE_MAX_LINES = 3;
const BESIDE_GAP = 1;
const BESIDE_OVERLAP = 0.5;
const BESIDE_HEIGHT_RATIO = 1.5;
const EQUATION_MIN_AREA = 200;
const EQUATION_REASONS = ['equation', 'math-heavy', 'low-letter-ratio'];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/gu;
const CJK_PER_WORD = 2;

export function countWords(text, minLetters = 1) {
  const cjk = (text.match(CJK) ?? []).length;
  const words = text.replace(CJK, ' ').match(new RegExp(`\\p{L}{${minLetters},}`, 'gu')) ?? [];
  return words.length + Math.ceil(cjk / CJK_PER_WORD);
}

const visibleLength = (s) => s.replace(/\s/g, '').length;
const roundHalf = (v) => Math.round(2 * v) / 2;

function isScriptItem(line, item) {
  const mid = item.baseline - 0.4 * item.fontSize;
  return (
    (item.fontSize < SCRIPT_SIZE * line.fontSize || item.isMath) &&
    mid >= line.baseline - SCRIPT_RISE * line.fontSize &&
    mid <= line.baseline + SAME_BASELINE * line.fontSize
  );
}

const NUMBERING_PREFIX = /^\s*\(?(?:\d{1,2}|[ivx]{1,4}|[A-Z])\)?(?:\.\d{1,2})*\.?\s*$/u;
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾';
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉₊₋₍₎';
const SCRIPT_SOURCE = '0123456789+−()';
const SCRIPT_SHIFT = 0.15;

function scriptKind(line, item) {
  const d = line.baseline - item.baseline;
  return d > SCRIPT_SHIFT * line.fontSize ? 'super' : d < -SCRIPT_SHIFT * line.fontSize ? 'sub' : undefined;
}

function continuesLine(line, item, isScript) {
  const size = Math.max(line.fontSize, item.fontSize);
  const gap = item.left - line.right;
  const sameBaseline = Math.abs(item.baseline - line.baseline) <= SAME_BASELINE * size;
  return (isScript || sameBaseline) && gap >= -size && gap <= MAX_ITEM_GAP * size;
}

function newLine(item) {
  return {
    text: '',
    left: item.left,
    right: item.right,
    baseline: item.baseline,
    fontSize: item.fontSize,
    fontName: item.textItem.fontName,
    mathChars: 0,
    raisedArrowCount: 0,
    monoChars: 0,
    boldChars: 0,
    boldPrefix: '',
    isBoldPrefixOpen: true,
    startsBold: false,
    endsBold: false,
    italicChars: 0,
    startsItalic: false,
    endsItalic: false,
    runs: [],
    sizeWeights: new Map(),
  };
}

function appendItem(line, item, isScript) {
  const { textItem, fontSize } = item;
  const chars = visibleLength(textItem.str);
  const bucket = roundHalf(fontSize);
  const weight = line.sizeWeights.get(bucket) ?? { weight: 0, fontName: textItem.fontName };
  weight.weight += chars;
  line.sizeWeights.set(bucket, weight);
  const dominant = [...line.sizeWeights.entries()].sort((a, b) => b[1].weight - a[1].weight)[0];
  if (dominant[0] === bucket && !(isScript && item.isMath)) {
    line.fontSize = fontSize;
    line.fontName = dominant[1].fontName;
    line.baseline = item.baseline;
  }
  const kind = isScript ? scriptKind(line, item) : undefined;
  let str = textItem.str.replace(/\s+/g, ' ');
  if (kind && /\d/.test(str)) {
    const table = kind === 'super' ? SUPERSCRIPTS : SUBSCRIPTS;
    str = str.replace(/[0-9+−()]/g, (c) => {
      const i = SCRIPT_SOURCE.indexOf(c);
      return i >= 0 ? table[i] : c;
    });
  }
  const text = line.text === '' || line.text.endsWith(' ') ? str.replace(/^ /, '') : str;
  line.runs.push({
    offset: line.text.length,
    length: text.length,
    left: item.left,
    right: item.right,
    itemIndex: item.itemIndex,
    skip: str.length - text.length,
  });
  line.text += text;
  if (isScript && kind === 'super') line.raisedArrowCount += (text.match(/←/g) ?? []).length;
  line.right = Math.max(line.right, item.right);
  if (item.isMath) line.mathChars += chars;
  if (item.isMono) line.monoChars += chars;
  if (chars > 0) {
    if (visibleLength(line.text) === chars) {
      line.startsItalic = item.isItalic;
      line.startsBold = item.isBold;
    }
    line.endsBold = item.isBold;
    line.endsItalic = item.isItalic;
    if (item.isItalic) line.italicChars += chars;
  }
  if (item.isBold) {
    line.boldChars += chars;
    if (line.isBoldPrefixOpen) line.boldPrefix = line.text;
  } else if (!NUMBERING_PREFIX.test(line.text)) {
    line.isBoldPrefixOpen = false;
  }
}

const GUTTER_MARGIN = 0.1;
const GUTTER_MIN_LINES = 8;
const GUTTER_NUMBER = /^\d{1,4}$/;

const horizontalOverlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
const isAllBold = (line) => line.boldChars > 0 && line.boldChars === visibleLength(line.text);
const SECTION_NUMBER = /^(?:\d{1,2}(?:\.\d{1,2}){1,3}\.?|[A-Z]\.)\s+\p{Lu}/u;
const isAllItalic = (line) => line.italicChars > 0 && line.italicChars === visibleLength(line.text);
const EQUATION_NUMBER = /^\((?:[A-Z]\.?)?\d{1,3}(?:\.\d{1,3}){0,2}[a-z]?\)$/;
const RELATION = /[=≤≥≈∝≡]|∼/;
const RELATION_MAX_WORDS = 2;
const CENTER_INSET = 1.5;

const isRelationLine = (line) => RELATION.test(line.text) && countWords(line.text, 3) <= RELATION_MAX_WORDS;
function isInsetWithin(inner, outer, fontSize) {
  const inset = CENTER_INSET * fontSize;
  return inner.left > outer.left + inset && inner.right < outer.right - inset;
}

const MONO_SHARE = 0.8;
function isCodeLine(line) {
  const n = visibleLength(line.text);
  if (!(n > 0 && line.monoChars / n >= MONO_SHARE)) return false;
  const t = line.text;
  return (
    /:-|"\s*[\w-]+\s*"\s*:/.test(t) ||
    /^\s*<\s*\/?\s*[A-Za-z][^>]*>/.test(t) ||
    /^(?:[\w.]+:\s*)?[a-z_]\w*\([^)]*\)\s*\./.test(t) ||
    /^\s*(?:def|class|function|if|for|while|return)\b.*[:;{]\s*$/.test(t) ||
    /^\s*(?:import\s+[\w.]+|from\s+[\w.]+\s+import)\b/.test(t) ||
    /^\s*(?:await\s+)?[a-zA-Z_]\w*(?:\.\w+)*\([^\n]*\)\s*[;.]?\s*$/.test(t) ||
    /^\s*(?:return|yield|raise|throw)\s+[a-zA-Z_]\w*(?:\.\w+)*(?:\([^\n]*\))?\s*;?\s*$/.test(t) ||
    /^\s*SELECT\b[\s\S]*\bFROM\b/.test(t) ||
    /\b(?:JOIN\s+\w+(?:\s+\w+)?\s+ON|GROUP\s+BY|ORDER\s+BY)\b/.test(t) ||
    /^\S+\s+--?\w+\b/.test(t)
  );
}

function isPseudoCode(text, raisedArrows) {
  return (
    (text.match(/←|:=/g) ?? []).length - raisedArrows >= 2 ||
    /^for\s+\w+\s*=.+\bto\b.+\bdo\s*$/.test(text) ||
    /^if\s+.+\bthen\s+(?:Wait|Return|Continue|Break)\b/.test(text)
  );
}

const PROSE_MIN_LINE_WORDS = 6;
const PROSE_MAX_MATH = 0.2;
const SPACING_TOLERANCE = 0.15;
const SPACING_MIN_SHARE = 0.6;
const SPACING_MIN_COUNT = 5;

function isProseLine(line) {
  const n = visibleLength(line.text);
  if (n === 0 || line.mathChars > PROSE_MAX_MATH * n) return false;
  return (line.text.match(/\p{L}/gu) ?? []).length / n >= MIN_LETTER_RATIO && countWords(line.text) >= PROSE_MIN_LINE_WORDS;
}

// Decides whether `line` starts a new block after `group` (array of lines).
function startsNewBlock(line, group, maxAdvance = DEFAULT_PARAGRAPH_ADVANCE) {
  const prev = group[group.length - 1];
  if (EQUATION_NUMBER.test(line.text.trim()) || EQUATION_NUMBER.test(prev.text.trim())) return true;
  const size = prev.fontSize;
  const advance = line.baseline - prev.baseline;
  if (advance < MIN_LINE_ADVANCE * size || advance > maxAdvance * size) return true;
  if (Math.abs(line.fontSize - size) / size > FONT_SIZE_TOLERANCE) return true;
  const pseudo = isPseudoCode(
    group.map((l) => l.text).join(' '),
    group.reduce((s, l) => s + l.raisedArrowCount, 0),
  );
  if (!pseudo) {
    const allBold = group.every(isAllBold);
    const styleBreak =
      (allBold && !line.startsBold) ||
      (isAllBold(line) && !prev.endsBold && !allBold) ||
      (group.every(isAllItalic) && SECTION_NUMBER.test(group[0].text) && !line.startsItalic) ||
      (isAllItalic(line) && SECTION_NUMBER.test(line.text) && !prev.endsItalic);
    if (styleBreak) return true;
  }
  if (isCodeLine(line) !== isCodeLine(prev)) return true;
  const span = { left: Math.min(...group.map((l) => l.left)), right: Math.max(...group.map((l) => l.right)) };
  const narrower = Math.min(line.right - line.left, span.right - span.left);
  if (horizontalOverlap(line, span) < 0.5 * narrower) return true;
  if (!pseudo) {
    const { fontSize } = group[group.length - 1];
    const lineIsEquation = isRelationLine(line) && isInsetWithin(line, span, fontSize);
    const groupIsEquation = group.every(isRelationLine) && group.some((l) => isInsetWithin(l, line, fontSize));
    if (lineIsEquation || groupIsEquation) return true;
  }
  if (group.length < 2) return false;
  if (line.right > span.right + LINE_OVERHANG * (span.right - span.left)) return true;
  const leftGap = line.left - span.left;
  const rightGap = span.right - line.right;
  const indented =
    !(Math.abs(leftGap - rightGap) < CENTERED_TOLERANCE * size) &&
    line.left > span.left + INDENT * size &&
    prev.left <= span.left + (INDENT / 2) * size;
  const prevEndedShort = prev.right < span.right - SHORT_LINE_GAP * size && /[.?!:]["')\]]?\s*$/.test(prev.text);
  return indented || prevEndedShort;
}

const BIB_MIN_WORDS = 40;
const BIB_MARKER_SHARE = 0.1;

function looksLikeCitation(text) {
  return (
    /(?:\b\d+(?:\s*\(\d+(?:[–-]\d+)?\))?\s*[:,]\s*[eE]?\d{2,}|\bpp?\.\s*\d+\s*[–-]\s*\d+|\barXiv\b|出版社|株式会社|\(\d{4}\)\s+\d{2,})/i.test(text) ||
    /\b[A-Z]{2,},\s*(?:19|20)\d{2}/.test(text)
  );
}

function isBibliography(text) {
  const years = (text.match(/\b(?:19|20)\d{2}[a-z]?\b/g) ?? []).length;
  const initials = (text.match(/(?<![\p{L}.])\p{Lu}\.(?=[\s,-]|\p{Lu}\.)/gu) ?? []).length;
  const numbered = /^\s*(?:\[\s*\d+\s*\]|\d{1,3}\.)\s+/u.test(text);
  const body = text.replace(/[˙¨¸]/g, '').replace(/^\s*(?:\[\s*\d+\s*\]|\d{1,3}\.)\s+/, '');
  const authorsFirst =
    !/^(?:The|This|These|Those|Our|We|In|On|At|For|From|With|If)\s/.test(body) &&
    (/^(?:\p{Lu}\.\s*)+\p{Lu}[\p{L}'’−-]+|^\p{Lu}[\p{L}'’−-]+(?:,?\s+\p{Lu}\.)+|^(?:\p{Lu}[\p{L}\p{M}'’−-]*\s+){1,5}\p{Lu}[\p{L}\p{M}'’−-]*(?=\.|,\s*(?:and\s+)?[´‘’]?\p{Lu}|\s+and\s+(?:[´‘’]?\p{Lu}[\p{L}\p{M}’\x27-]*\s+(?:(?:van|von|de|den|der|del)\s+)?){1,4}\p{Lu}[\p{L}\p{M}’\x27-]*[.,])|^(?:\p{Lu}\.-?)+\s*\p{Lu}[\p{L}'’−-]+|^[^:：]{2,40}[:：]\s*[“「『"]/u.test(body) ||
      /^\p{Lu}[\p{L}'’-]+\s+(?:(?:van|von|de|den|der|del)\s+)+\p{Lu}[\p{L}'’-]+[.,]/u.test(body));
  const words = countWords(text);
  const dense = words < BIB_MIN_WORDS || (years + initials) / words >= BIB_MARKER_SHARE;
  return numbered
    ? (authorsFirst ||
        (looksLikeCitation(text) && /^[\p{Script=Han}、,\s]{2,40}[:：]/u.test(body)) ||
        (/^\[/.test(text.trim()) &&
          /^(?:\p{Lu}[\p{L}]+\s+)*(?:Office|Institute|University|Department|Organization|Collaboration)\b/u.test(body) &&
          /https?:\/\//.test(text))) &&
        (years >= 1 || initials >= 2)
    : years >= 1 && dense && (initials >= 3 || (authorsFirst && looksLikeCitation(text)));
}

const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const LINK_MAX_WORDS = 3;

// "Reads like a sentence": enough lowercase words relative to numbers/symbols.
export function isProse(text) {
  const cjk = text.match(CJK) ?? [];
  const latin = text.replace(CJK, ' ');
  const lowerWords = [...latin.matchAll(WORD_RE)]
    .filter((m) => /^[\p{Ll}\p{Lo}][\p{Ll}\p{Lo}\p{M}]+$/u.test(m[0]) && !/^\(/u.test(latin.slice(m.index + m[0].length)))
    .map((m) => m[0]);
  const threeWordRun = /(?:\p{L}+\s+){2}\p{L}+/u.test(latin);
  const numbers = text.match(/\p{N}+(?:[.,]\p{N}+)*/gu) ?? [];
  const wordWeight = lowerWords.length + cjk.length / CJK_PER_WORD;
  const nonNumeric = visibleLength(text.replace(/\p{N}+(?:[.,]\p{N}+)*/gu, ''));
  return (
    ((lowerWords.length >= PROSE_MIN_WORDS && threeWordRun) || cjk.length >= 4 * PROSE_MIN_WORDS) &&
    (numbers.length <= wordWeight || (lowerWords.length >= 6 && lowerWords.join('').length / visibleLength(text) >= PROSE_LETTER_SHARE)) &&
    (lowerWords.join('').length + cjk.length) / Math.max(1, nonNumeric) >= PROSE_LETTER_SHARE
  );
}

function isCaption(text) {
  return /^(?:fig(?:ure)?s?|tab(?:le)?|abb(?:ildung)?|tabelle|tabla|figura|tableau|図|圖|图|表|그림|표)\.?\s*[A-Z]?\d+[a-z]?(?:[.:：]|\s)/iu.test(text);
}

export function isHeadingText(text) {
  return !(isCaption(text) || (/[.?!。！？．]["'”’)\]]?\s*$/u.test(text) && isProse(text)));
}

function alignment(lines, pageWidth) {
  const size = lines[0].fontSize;
  const centers = lines.map((l) => (l.left + l.right) / 2);
  const lefts = lines.map((l) => l.left);
  if (lines.length === 1) {
    return Math.abs(centers[0] - pageWidth / 2) < 0.02 * pageWidth && lefts[0] > 0.15 * pageWidth ? 'center' : 'left';
  }
  const centerSpread = Math.max(...centers) - Math.min(...centers);
  const leftSpread = Math.max(...lefts) - Math.min(...lefts);
  return centerSpread < size && leftSpread > 2 * size ? 'center' : lines.length >= 3 ? 'justify' : 'left';
}

const WIDEN_LEFT_MATCH = 2.5;
const WIDEN_MIN_GAIN = 1;

// PDF.js items -> visual lines. Reorders reversed (right-to-left emitted) runs and lines.
function buildLines(items, { viewportTransform: vt, mathFontNames, boldFontNames, italicFontNames, monospaceFontNames }) {
  const scale = Math.hypot(vt[0], vt[1]);
  const lines = [];
  let line = null;
  for (const [itemIndex, textItem] of orderItems(items, vt)) {
    const m = multiply(vt, textItem.transform);
    if (Math.abs(Math.atan2(m[1], m[0])) > MAX_TEXT_ANGLE) continue;
    if (textItem.str.trim() === '') {
      if (line && textItem.str !== '' && !line.text.endsWith(' ')) line.text += ' ';
      continue;
    }
    const item = {
      textItem,
      itemIndex,
      left: m[4],
      right: m[4] + textItem.width * scale,
      baseline: m[5],
      fontSize: Math.hypot(m[2], m[3]),
      isMath: mathFontNames?.has(textItem.fontName) === true,
      isBold: boldFontNames?.has(textItem.fontName) === true,
      isItalic: italicFontNames?.has(textItem.fontName) === true,
      isMono: monospaceFontNames?.has(textItem.fontName) === true,
    };
    const isScript = line !== null && isScriptItem(line, item);
    if (!line || !continuesLine(line, item, isScript)) {
      line = newLine(item);
      lines.push(line);
      appendItem(line, item, false);
      continue;
    }
    const size = Math.max(line.fontSize, item.fontSize);
    if (item.left - line.right > SPACE_GAP * size && !line.text.endsWith(' ') && !textItem.str.startsWith(' ')) line.text += ' ';
    appendItem(line, item, isScript);
  }
  return reorderReversedLines(lines.filter((l) => l.text.trim() !== ''));
}

function orderItems(items, vt) {
  const entries = [...items.entries()];
  const geom = ([, item]) => {
    const m = multiply(vt, item.transform);
    const scale = Math.hypot(vt[0], vt[1]);
    return { left: m[4], right: m[4] + item.width * scale, baseline: m[5], fontSize: Math.hypot(m[2], m[3]) };
  };
  const out = [];
  let run = [];
  const isReversed = (r) => {
    if (r.length < 2) return false;
    const letters = r.reduce((s, [, it]) => s + (it.str.match(/\p{L}/gu) ?? []).length, 0);
    if (letters < RTL_MIN_LETTERS) return false;
    return r.every(([, it], i) => {
      if (i === 0) return true;
      const a = geom(r[i - 1]);
      const b = geom(r[i]);
      return it.str.trim() !== '' && b.right <= a.left + RTL_OVERLAP * b.fontSize;
    });
  };
  const flush = () => {
    out.push(...(isReversed(run) ? run.reverse() : run));
    run = [];
  };
  entries.forEach((entry) => {
    const last = run[run.length - 1];
    if (last) {
      const a = geom(last);
      const b = geom(entry);
      if (!(Math.abs(b.baseline - a.baseline) <= SAME_BASELINE * Math.max(a.fontSize, b.fontSize) && entry[1].str.trim() !== '')) flush();
    }
    run.push(entry);
  });
  flush();
  return out;
}

function reorderReversedLines(lines) {
  const out = [];
  let run = [];
  const goesUp = (prev, cur) => {
    const d = prev.baseline - cur.baseline;
    return (
      isProseLine(prev) &&
      isProseLine(cur) &&
      Math.abs(cur.fontSize - prev.fontSize) / prev.fontSize <= FONT_SIZE_TOLERANCE &&
      d >= LINE_TOP * prev.fontSize &&
      d <= MAX_LINE_ADVANCE * prev.fontSize &&
      horizontalOverlap(cur, prev) > 0
    );
  };
  const flush = () => {
    out.push(...(run.length > 1 ? run.reverse() : run));
    run = [];
  };
  lines.forEach((l) => {
    const prev = run[run.length - 1];
    if (prev && !goesUp(prev, l)) flush();
    run.push(l);
  });
  flush();
  return out;
}

function splitGutter(lines, pageWidth) {
  const isGutter = (l) => GUTTER_NUMBER.test(l.text.trim()) && (l.right <= GUTTER_MARGIN * pageWidth || l.left >= (1 - GUTTER_MARGIN) * pageWidth);
  const gutter = lines.filter(isGutter);
  return gutter.length < GUTTER_MIN_LINES ? { lines, gutterLines: [] } : { lines: lines.filter((l) => !isGutter(l)), gutterLines: gutter };
}

// Typical body line spacing (in font sizes) -> max advance allowed inside a paragraph.
function paragraphAdvance(lines) {
  const ratios = [];
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (!prev || !isProseLine(prev) || !isProseLine(l)) return;
    if (Math.abs(l.fontSize - prev.fontSize) > 0.5) return;
    const r = (l.baseline - prev.baseline) / prev.fontSize;
    if (r >= 1 && r <= MAX_LINE_ADVANCE) ratios.push(r);
  });
  let best = { ratio: DEFAULT_PARAGRAPH_ADVANCE, count: 0 };
  for (const r of ratios) {
    const count = ratios.filter((x) => Math.abs(x - r) <= SPACING_TOLERANCE).length;
    if (count > best.count) best = { ratio: r, count };
  }
  if (best.count < SPACING_MIN_COUNT || best.count < SPACING_MIN_SHARE * ratios.length) return DEFAULT_PARAGRAPH_ADVANCE;
  return Math.min(Math.max(DEFAULT_PARAGRAPH_ADVANCE, best.ratio * ADVANCE_SLACK), MAX_LINE_ADVANCE);
}

function dominantFontSize(lines) {
  const weights = new Map();
  lines.forEach((l) => {
    const k = roundHalf(l.fontSize);
    weights.set(k, (weights.get(k) ?? 0) + visibleLength(l.text));
  });
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

function joinLines(lines) {
  let text = '';
  const out = [];
  for (const l of lines) {
    const t = l.text.trimEnd();
    const last = out[out.length - 1];
    if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) {
      text = text.slice(0, -1);
      last.end -= 1;
      last.hyphenJoined = true;
    } else if (text) {
      text += ' ';
    }
    out.push({
      start: text.length,
      end: text.length + t.length,
      top: l.baseline - LINE_TOP * l.fontSize,
      bottom: l.baseline + LINE_BOTTOM * l.fontSize,
      runs: l.runs,
    });
    text += t;
  }
  return { text, lines: out };
}

function excludeReasonFor(text, mathChars, fontSize, bodyFontSize, raisedArrows) {
  const chars = visibleLength(text);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const numberedEquation = text.includes('=') && EQUATION_NUMBER_TAIL.test(text) && countWords(text, 3) <= NUMBERED_EQUATION_MAX_WORDS;
  const equation = numberedEquation || (text.includes('=') && countWords(text, 3) <= EQUATION_MAX_WORDS && !isProse(text));
  const withoutLinks = text.replace(URL_OR_EMAIL, ' ');
  const link = withoutLinks !== text && countWords(withoutLinks, 2) <= LINK_MAX_WORDS;
  const words = countWords(text);
  const smallFragment =
    (fontSize < SMALL_FONT_A * bodyFontSize && words <= SMALL_WORDS_A) || (fontSize < SMALL_FONT_B * bodyFontSize && words <= SMALL_WORDS_B);
  if (isPseudoCode(text, raisedArrows)) return 'pseudo-code';
  if (isBibliography(text)) return 'bibliography';
  if (smallFragment) return 'small-fragment';
  if (equation) return 'equation';
  if (link) return 'link';
  if (letters < MIN_LETTERS || !/\p{L}{3}/u.test(text)) return 'too-few-letters';
  if (letters / chars < MIN_LETTER_RATIO && !isProse(text)) return 'low-letter-ratio';
  if (mathChars / chars > MATH_HEAVY_RATIO && words < MATH_HEAVY_MAX_WORDS) return 'math-heavy';
  return undefined;
}

function buildBlock(lines, pageWidth, bodyFontSize) {
  const left = Math.min(...lines.map((l) => l.left));
  const right = Math.max(...lines.map((l) => l.right));
  const first = lines[0];
  const last = lines[lines.length - 1];
  const top = first.baseline - LINE_TOP * first.fontSize;
  const bottom = last.baseline + LINE_BOTTOM * last.fontSize;
  const { text, lines: blockLines } = joinLines(lines);
  const mathChars = lines.reduce((s, l) => s + l.mathChars, 0);
  const monoChars = lines.reduce((s, l) => s + l.monoChars, 0);
  const boldChars = lines.reduce((s, l) => s + l.boldChars, 0);
  const bold =
    first.fontSize >= BOLD_HEADING_SIZE * bodyFontSize || boldChars / visibleLength(text) >= BOLD_SHARE
      ? { isBold: true, boldPrefix: '' }
      : { isBold: false, boldPrefix: first.boldPrefix.trim() };
  const heading =
    (bold.isBold || (lines.every(isAllItalic) && SECTION_NUMBER.test(first.text))) &&
    lines.length <= HEADING_MAX_LINES &&
    countWords(text, 2) <= HEADING_MAX_WORDS &&
    isHeadingText(text)
      ? 'heading'
      : undefined;
  const code = monoChars / Math.max(1, visibleLength(text)) >= MONO_SHARE && lines.some(isCodeLine) ? 'code' : undefined;
  const reason =
    excludeReasonFor(text, mathChars, first.fontSize, bodyFontSize, lines.reduce((s, l) => s + l.raisedArrowCount, 0)) ?? heading ?? code;
  return {
    text,
    left,
    top,
    width: right - left,
    height: bottom - top,
    fontSize: first.fontSize,
    fontName: first.fontName,
    ...bold,
    lineCount: lines.length,
    lines: blockLines,
    lineHeight: lines.length > 1 ? (last.baseline - first.baseline) / (lines.length - 1) : 1.2 * first.fontSize,
    align: alignment(lines, pageWidth),
    translatable: reason === undefined,
    excludeReason: reason,
  };
}

const intersects = (a, b) =>
  Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left) && Math.min(a.top + a.height, b.top + b.height) > Math.max(a.top, b.top);

export function buildLayoutBlocks(items, options) {
  const { lines, gutterLines } = splitGutter(buildLines(items, options), options.pageWidth);
  const maxAdvance = paragraphAdvance(lines);
  const groups = [];
  for (const line of lines) {
    const group = groups[groups.length - 1];
    if (!group || startsNewBlock(line, group, maxAdvance)) groups.push([line]);
    else group.push(line);
  }
  gutterLines.forEach((l) => groups.push([l]));
  const bodyFontSize = dominantFontSize(groups.flat());
  const blocks = groups.map((g) => buildBlock(g, options.pageWidth, bodyFontSize));
  const equations = blocks.filter((b) => b.excludeReason !== undefined && EQUATION_REASONS.includes(b.excludeReason) && b.width * b.height >= EQUATION_MIN_AREA);

  const classified = blocks.map((b, i) => {
    if (
      b.translatable &&
      equations.some((eq) => {
        const w = Math.min(b.left + b.width, eq.left + eq.width) - Math.max(b.left, eq.left);
        const h = Math.min(b.top + b.height, eq.top + eq.height) - Math.max(b.top, eq.top);
        return w > 0 && h > 0 && (w * h) / (eq.width * eq.height) > EQUATION_COVER;
      })
    )
      return { ...b, translatable: false, excludeReason: 'covers-equation' };
    if (
      b.translatable &&
      b.lineCount <= BESIDE_MAX_LINES &&
      equations.some((eq) => {
        const gap = Math.max(b.left - (eq.left + eq.width), eq.left - (b.left + b.width));
        const vOverlap = Math.min(b.top + b.height, eq.top + eq.height) - Math.max(b.top, eq.top);
        const ratio = b.height / eq.height;
        return gap <= BESIDE_GAP * b.fontSize && vOverlap >= BESIDE_OVERLAP * Math.min(b.height, eq.height) && (ratio >= BESIDE_HEIGHT_RATIO || ratio <= 1 / BESIDE_HEIGHT_RATIO);
      })
    )
      return { ...b, translatable: false, excludeReason: 'beside-equation' };
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    const citation = looksLikeCitation(b.text);
    const near = (o) =>
      Math.min(o.left + o.width, b.left + b.width) > Math.max(o.left, b.left) &&
      Math.max(b.top - o.top - o.height, o.top - b.top - b.height) <= 3 * b.lineHeight;
    return b.translatable &&
      prev !== undefined &&
      next !== undefined &&
      (!isProse(b.text) || citation) &&
      ((next.top >= b.top + b.height - b.lineHeight && near(next)) || (citation && b.left + b.width <= next.left && b.top > next.top)) &&
      ((prev.top < b.top && near(prev)) || (citation && prev.left + prev.width <= b.left && prev.top > b.top)) &&
      [prev, next].every((o) => isBibliography(o.text) && roundHalf(o.fontSize) === roundHalf(b.fontSize))
      ? { ...b, translatable: false, excludeReason: 'between-bibliography' }
      : b;
  });

  // Single-line left-aligned blocks may grow to the paragraph column width when nothing is in the way.
  const paragraphs = classified.filter((b) => b.translatable && b.lineCount >= 2);
  return classified.map((b) => {
    if (!b.translatable || b.lineCount !== 1 || b.align !== 'left') return b;
    const right = b.left + b.width;
    const columnRight = Math.max(
      right,
      ...paragraphs.filter((p) => b.left >= p.left - 0.5 * b.fontSize && b.left <= p.left + WIDEN_LEFT_MATCH * b.fontSize).map((p) => p.left + p.width),
    );
    if (columnRight - right < WIDEN_MIN_GAIN * b.fontSize) return b;
    const blocked = classified.some(
      (o) => o !== b && o.left < columnRight && o.left + o.width > right && o.top < b.top + b.height && o.top + o.height > b.top,
    );
    return blocked ? b : { ...b, availableWidth: columnRight - b.left };
  });
}

const SERIF = /Times|Nimbus ?Rom|Roman|CMR\d|CMTI|CMBX|CMSL|Georgia|Garamond|Minion|Palatino|Palladio|Bookman|Century|Charter|Libertin|STIX|Cambria|Serif|Utopia|Caslon|Baskerville/i;
const SANS = /Helvetica|Arial|Nimbus ?San|Sans|Gothic|Univers|Frutiger|Futura|Calibri|Verdana|Tahoma|CMSS|Myriad|Optima|Roboto|OpenSans|Lato/i;
const MONO = /Courier|Mono|Consolas|Menlo|CMTT|SFTT|Typewriter/i;

export function resolveFontFamily({ name, pdfjsFamily, hasSerifFlags }) {
  if (MONO.test(name) || pdfjsFamily === 'monospace') return 'monospace';
  if (SANS.test(name)) return 'sans-serif';
  if (SERIF.test(name) || pdfjsFamily === 'serif') return 'serif';
  return pdfjsFamily === 'sans-serif' && hasSerifFlags ? 'sans-serif' : 'serif';
}

// Visible pieces of source text per line (runs + the gaps between them), for the selectable text layer.
export function getSourceTextPieces(block) {
  return block.lines.map((line) => {
    const pieces = [];
    line.runs.forEach((run, i) => {
      const start = line.start + run.offset;
      const prev = line.runs[i - 1];
      if (prev) {
        const gap = block.text.slice(line.start + prev.offset + prev.length, start);
        if (gap) pieces.push({ text: gap, left: prev.right, right: run.left });
      }
      const end = Math.min(start + run.length, line.end);
      const hyphen = i === line.runs.length - 1 && line.hyphenJoined === true;
      pieces.push({ text: block.text.slice(start, end) + (hyphen ? '-' : ''), left: run.left, right: run.right });
    });
    return { line, pieces };
  });
}

const TABLE_CELL_MAX_WORDS = 25;
const FIGURE_TEXT_MAX_LINES = 2;
const FIGURE_TEXT_MAX_WORDS = 8;

export const isTableCellText = (b) => !isCaption(b.text) && countWords(b.text, 2) < TABLE_CELL_MAX_WORDS;
export const isFigureInternalText = (b) => !isCaption(b.text) && b.lineCount <= FIGURE_TEXT_MAX_LINES && countWords(b.text, 2) <= FIGURE_TEXT_MAX_WORDS;

const MIN_SINGLE_LINE_SCALE = 0.65;
const MIN_MULTI_LINE_SCALE = 0.6;
const MIN_FONT_PX = 5.5;

export function isLegibleFit(block, fontSize) {
  if (fontSize >= block.fontSize) return true;
  if (block.lineCount > 1) return fontSize >= MIN_MULTI_LINE_SCALE * block.fontSize;
  return fontSize >= MIN_SINGLE_LINE_SCALE * block.fontSize && fontSize >= MIN_FONT_PX;
}
