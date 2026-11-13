// Port of Moonlight 3.7.5 "browser layout translation":
//   module 55993 (panel, page pipeline, block rendering & fitting), 70850 (hover matching),
//   25739 (open-state memory), 99181 (view mode).
// A second PDF.js viewer renders the same document next to the source; on every rendered page
// a translation layer covers each translatable text block with its translation, typeset to fit
// the original box.
import katex from 'katex';
import { buildLayoutBlocks, resolveFontFamily, getSourceTextPieces, isFigureInternalText, isTableCellText, isHeadingText, isLegibleFit } from './layoutBlocks.js';
import { buildPageSentences, composeBlockParts, getPartsSignature, getSentenceRects, containsPoint } from './sentences.js';
import { TRANSLATION_END_MARKER_HEADER, splitCompletedStream, parseTranslatedSegments, getTranslatedBoldPrefixLength, isRetryableTranslationFailure, getTranslationRetryDelayMs } from './stream.js';
import { setLayoutLayerGeometry, unrotateLayoutPoint, getLayoutCanvasRect, getSafeBlockWidth, getBlockLink, locateTranslatedLinks, bindLayoutLink } from './geometry.js';
import { BOX_CLASS } from './detect.js';

export const L10N = {
  'button-text': '레이아웃 유지 번역',
  'back-to-original': '원본으로 돌아가기',
  'split-view': '나란히 보기',
  'translated-only': '번역만 보기',
  'loading-title': '레이아웃 유지 번역을 만들고 있어요',
  'failed-body': '레이아웃 유지 번역을 완료하지 못했어요. 다시 시도해주세요.',
  'failed-network-body': '번역 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.',
  retry: '다시 시도',
};

const ACTIVE_CLASS = 'browser-layout-translate-active';
const TRANSLATED_ONLY_CLASS = 'browser-layout-translated-only';
const NARROW_CLASS = 'moonlight-viewer-tablet-portrait';
const VIEW_MODE_KEY = 'browserLayoutTranslateViewMode';
const OPEN_DOCS_KEY = 'browserLayoutTranslationOpenDocuments';
const MAX_REMEMBERED = 200;
const PANEL_ID = 'browser-layout-translation-panel';
const STREAM_ERROR = '<|error|>'; // Sunlight server: an engine error after the response started
const CONTAINER_ID = 'browser-layout-translation-viewer-container';
const LAYER_CLASS = 'browser-layout-translation-layer';
const SOURCE_TEXT_CLASS = 'browser-layout-source-text';
const SENTENCE_CLASS = 'browser-layout-translation-sentence';
const MATCH_LAYER_CLASS = 'browser-layout-source-match-layer';
const PRESET_SCALES = new Set(['auto', 'page-actual', 'page-fit', 'page-height', 'page-width']);

const MATH_FONT = /CMMI|CMSY|CMEX|MSAM|MSBM|EUSM|EUFM|RSFS|STIXMath|Math|[tp]x(?:sy|mi|ex)|MT(?:SY|MI|EX)/i;
const BOLD_FONT = /bold|black|heavy|medi|demi|CMBX|CMSSBX/i;
const MONO_FONT = /Courier|Mono|Consolas|Menlo|CMTT|SFTT|Typewriter/i;
const ITALIC_FONT = /ital|obli|slant|CMTI|CMSL|-It$/i;

const MIN_FIT_SCALE = 0.45;
const FIT_ITERATIONS = 7;
const MIN_LINE_HEIGHT = 1.12;
const MAX_LINE_HEIGHT = 1.6;
const LINE_HEIGHT_SLACK = 1.05;
const PENDING_PHASE_MS = 100;
const PENDING_PHASES = 16;
const SCROLL_EPSILON = 2;
const USER_SCROLL_HOLD_MS = 300;
const TITLE_MAX_LINES = 2;

const scaled = (v) => `calc(var(--scale-factor) * ${v.toFixed(2)}px)`;

function readList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function getViewMode() {
  return document.documentElement.classList.contains(TRANSLATED_ONLY_CLASS) ? 'translated-only' : 'split';
}

function applyViewMode(mode, { remember = true } = {}) {
  document.documentElement.classList.toggle(TRANSLATED_ONLY_CLASS, mode === 'translated-only');
  if (!remember) return;
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {}
}

const preferredViewMode = () => {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'translated-only' ? 'translated-only' : 'split';
  } catch {
    return 'split';
  }
};
const isNarrow = () => document.documentElement.classList.contains(NARROW_CLASS);

// Most frequent colour in a 1px column just left of the block: the paper colour to paint over.
function sampleCoverColor(canvas, block) {
  const ctx = canvas.getContext('2d');
  const px = getLayoutCanvasRect(canvas, { left: Math.max(0, block.left - 2), top: Math.max(0, block.top), width: 0, height: block.height });
  if (!ctx || !px) return 'rgb(255, 255, 255)';
  const x = Math.min(canvas.width - 1, Math.max(0, px.left));
  const y = Math.min(canvas.height - 1, Math.max(0, px.top));
  let data;
  try {
    ({ data } = ctx.getImageData(x, y, Math.min(canvas.width - x, Math.max(1, px.width)), Math.min(canvas.height - y, Math.max(1, px.height))));
  } catch {
    return 'rgb(255, 255, 255)';
  }
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = `${data[i]}, ${data[i + 1]}, ${data[i + 2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [rgb = '255, 255, 255'] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return `rgb(${rgb})`;
}

const isDark = (rgb) => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};

// Binary search the largest font size (between 45% and 100% of the source) that fits the box.
function fitFontSize(blockEl, textEl, block) {
  const fits = () => textEl.scrollWidth <= blockEl.clientWidth + 1 && (block.lineCount === 1 || textEl.offsetHeight <= blockEl.clientHeight + 1);
  const set = (v) => blockEl.style.setProperty('font-size', scaled(v));
  set(block.fontSize);
  if (fits()) return block.fontSize;
  let lo = block.fontSize * MIN_FIT_SCALE;
  let hi = block.fontSize;
  for (let i = 0; i < FIT_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;
    set(mid);
    if (fits()) lo = mid;
    else hi = mid;
  }
  set(lo);
  return lo;
}

// If the fitted text leaves vertical room, open the line height back toward the source spacing.
function relaxLineHeight(blockEl, textEl, block) {
  if (block.lineCount === 1) return;
  const source = block.lineHeight / block.fontSize;
  const current = Number.parseFloat(blockEl.style.lineHeight);
  if (!(source > current)) return;
  const room = blockEl.clientHeight / Math.max(1, textEl.offsetHeight);
  if (room <= LINE_HEIGHT_SLACK) return;
  blockEl.style.lineHeight = Math.min(source, current * room).toFixed(3);
  if (textEl.offsetHeight > blockEl.clientHeight + 1) blockEl.style.lineHeight = current.toFixed(3);
}

function renderSentenceContent(span, text, boldPrefix, inlineDisplayMath) {
  const boldLength = getTranslatedBoldPrefixLength(text, boldPrefix);
  if (boldLength > 0) {
    const strong = document.createElement('strong');
    strong.className = 'bold';
    strong.textContent = text.slice(0, boldLength);
    span.append(strong);
  }
  text
    .slice(boldLength)
    .split(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/g)
    .forEach((piece) => {
      const m = piece.match(/^\$\$?([^$]+)\$\$?$/);
      if (!m) return void span.append(piece);
      const holder = document.createElement('span');
      const display = piece.startsWith('$$');
      try {
        try {
          katex.render(m[1], holder, { displayMode: display && !inlineDisplayMath, throwOnError: true });
        } catch (err) {
          if (!display || !inlineDisplayMath) throw err;
          katex.render(m[1], holder, { displayMode: true, throwOnError: true });
        }
      } catch {
        span.dataset.mathFailed = 'true';
        holder.textContent = m[1];
      }
      span.append(holder);
    });
}

function linkifySentence(span, links, linkService) {
  let remaining = links;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest('.katex')) nodes.push(n);
  nodes.forEach((node) => {
    const hits = locateTranslatedLinks(node.data, remaining);
    remaining = remaining.filter((l) => !hits.some((h) => h.id === l.id));
    [...hits].reverse().forEach(({ id, start, end }) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const a = document.createElement('a');
      a.className = 'browser-layout-translation-link';
      a.draggable = false;
      a.dataset.elementId = id;
      const link = links.find((l) => l.id === id);
      if (link && linkService) bindLayoutLink(a, link, linkService);
      range.surroundContents(a);
    });
  });
}

export function createLayoutTranslation(ctx) {
  const { pdfjsViewer, pdfDocument, source, mainContainer, pageBoxes, requestTranslation, getLanguage, onStateChange, onProgress } = ctx;
  const pages = new Map(); // pageIndex -> state
  const loading = new Map(); // pageIndex -> Promise<state>
  const queue = [];
  const retrying = new Set();
  const waitingForBoxes = new Set();
  let running = 0;
  const lifetime = new AbortController(); // aborted on destroy: stops queued and in-flight requests
  const { signal } = lifetime; // also removes every DOM listener on destroy
  let concurrency = 2;
  let translated; // { eventBus, linkService, pdfViewer }
  let syncedScroll; // { container, scrollTop }
  let linked = true; // true: the translated panel follows the source zoom; false after a pinch on one side
  let holdSourceUntil = 0;
  let pointerDown = false;
  let narrow = false;
  let hoverEpoch = 0;
  let match; // { pageIndex, key }

  const isActive = () => document.documentElement.classList.contains(ACTIVE_CLASS);
  const translatedContainer = () => document.getElementById(CONTAINER_ID);
  const fingerprint = () => pdfDocument.fingerprints?.[0];

  // ---------- page blocks ----------
  async function loadPageBlocks(pageIndex) {
    const page = await pdfDocument.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    await page.getOperatorList(); // loads fonts into commonObjs so real font names are known
    const content = await page.getTextContent();
    const items = content.items.filter((i) => typeof i.str === 'string');
    const fontName = (id) => {
      try {
        return (page.commonObjs.has(id) && page.commonObjs.get(id)?.name) || '';
      } catch {
        return '';
      }
    };
    const fontIds = [...new Set(items.map((i) => i.fontName))];
    const withFont = (re) => new Set(fontIds.filter((id) => re.test(fontName(id))));
    const styles = content.styles;
    const hasSerifFlags = Object.values(styles).some((s) => s.fontFamily === 'serif');
    const blocks = buildLayoutBlocks(items, {
      viewportTransform: viewport.transform,
      pageWidth: viewport.width,
      mathFontNames: withFont(MATH_FONT),
      boldFontNames: withFont(BOLD_FONT),
      italicFontNames: withFont(ITALIC_FONT),
      monospaceFontNames: new Set(fontIds.filter((id) => MONO_FONT.test(fontName(id)) || styles[id]?.fontFamily === 'monospace')),
    });
    const links = (await page.getAnnotations())
      .filter((a) => a.subtype === 'Link')
      .map((a) => {
        const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(a.rect);
        return { id: a.id, url: a.url, dest: a.dest, action: a.action, rect: { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) } };
      });
    return {
      excludedBlocks: blocks.filter((b) => !b.translatable),
      blocks: blocks.filter((b) => b.translatable).map((b) => ({ ...b, fontFamily: resolveFontFamily({ name: fontName(b.fontName), pdfjsFamily: styles[b.fontName]?.fontFamily, hasSerifFlags }) })),
      links,
      size: { width: viewport.width, height: viewport.height },
    };
  }

  function linksBySentence(blocks, sentences, links) {
    const out = new Map();
    blocks.forEach((block, bi) => {
      links
        .map((l) => getBlockLink(block, l))
        .filter((l) => l !== null)
        .sort((a, b) => a.start - b.start)
        .forEach((l) => {
          const si = sentences.findIndex((s) => s.blockIndex === bi && l.start >= s.start && l.start < s.end);
          if (si !== -1) out.set(si, [...(out.get(si) ?? []), l]);
        });
    });
    return out;
  }

  function pageState(pageIndex) {
    let p = loading.get(pageIndex);
    if (!p) {
      p = loadPageBlocks(pageIndex).then(({ blocks, excludedBlocks, links, size }) => {
        const sentences = buildPageSentences(blocks);
        let resolveSettled = () => {};
        const state = {
          settled: new Promise((r) => (resolveSettled = r)),
          resolveSettled,
          blocks,
          excludedBlocks,
          sentences,
          parts: new Map(),
          sentenceLinks: linksBySentence(blocks, sentences, links),
          size,
          status: blocks.length > 0 ? 'translating' : 'done',
          failedAttempts: 0,
          failureIsTransient: true,
          quietRetry: false,
        };
        pages.set(pageIndex, state);
        if (blocks.length > 0) enqueue(pageIndex);
        else resolveSettled();
        reportProgress();
        return state;
      });
      loading.set(pageIndex, p);
    }
    return p;
  }

  // ---------- translation queue ----------
  async function translatePage(pageIndex, state, controller) {
    const texts = state.sentences.map((s) => s.text);
    const res = await requestTranslation({ texts, target: getLanguage(), reuseSaved: true, everySegment: true }, controller.signal);
    if (!res.ok) throw Object.assign(new Error((await res.text().catch(() => '')) || `translation ${res.status}`), { status: res.status });
    if (!res.body) throw new Error('Page translation is unavailable');
    const hasEndMarker = res.headers.get(TRANSLATION_END_MARKER_HEADER) === '1';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let raw = '';
    const base = state.parts;
    let signature = getPartsSignature(base);
    for (;;) {
      const { done, value } = await reader.read();
      if (!done) raw += decoder.decode(value, { stream: true });
      const failure = raw.indexOf(STREAM_ERROR);
      if (failure !== -1) {
        if (!done) continue; // the server ends the stream right after the error line
        const [, status, message] = raw.slice(failure + STREAM_ERROR.length).match(/^(\d+)\|([\s\S]*)$/) ?? [];
        throw Object.assign(new Error(message || 'translation failed'), { status: Number(status) || 502 });
      }
      const split = splitCompletedStream(raw);
      const complete = !hasEndMarker || split.isFinal;
      const { segments, resolvedCount } = parseTranslatedSegments(split.text, texts, done && complete);
      state.parts = new Map([...base, ...composeBlockParts(state.sentences, segments, resolvedCount)]);
      const next = getPartsSignature(state.parts);
      if (next !== signature) {
        signature = next;
        renderPage(pageIndex);
      }
      if (done) {
        if (!complete) throw new Error('Page translation stream ended early');
        return;
      }
    }
  }

  function pump() {
    while (running < concurrency && queue.length > 0 && !lifetime.signal.aborted) {
      const pageIndex = queue.splice(nextQueued(), 1)[0];
      const state = pages.get(pageIndex);
      if (!state) continue;
      running += 1;
      translatePage(pageIndex, state, lifetime)
        .then(() => {
          state.status = 'done';
          reportProgress();
          state.quietRetry = false;
          state.resolveSettled();
        })
        .catch((err) => {
          if (lifetime.signal.aborted) return;
          const retryable = isRetryableTranslationFailure(err);
          const delay = retryable ? getTranslationRetryDelayMs(state.failedAttempts) : undefined;
          state.failedAttempts += 1;
          if (delay !== undefined) {
            retrying.add(pageIndex);
            setTimeout(() => enqueue(pageIndex), delay);
            return;
          }
          state.status = 'failed';
          reportProgress();
          state.quietRetry = false;
          state.failureIsTransient = retryable;
          state.errorMessage = err.message;
          state.resolveSettled();
          console.error('Browser layout translation failed', err);
        })
        .finally(() => {
          running -= 1;
          if (!retrying.delete(pageIndex)) renderPage(pageIndex);
          pump();
        });
    }
  }

  // Sunlight addition: progress over the whole document (Moonlight only translates rendered pages).
  function reportProgress() {
    let done = 0;
    let failed = 0;
    pages.forEach((s) => (s.status === 'done' ? done++ : s.status === 'failed' && failed++));
    onProgress?.({ done, failed, total: pdfDocument.numPages });
  }

  // Queue every page in reading order.
  async function translateAll() {
    for (let i = 0; i < pdfDocument.numPages; i++) {
      if (!isActive()) return;
      await pageState(i).catch(() => {});
    }
  }

  // Moonlight pops the most recently rendered page (LIFO). With the whole document queued, Sunlight
  // instead takes the first page at or after the one being read, then wraps to earlier pages.
  function nextQueued() {
    const current = (source.pdfViewer.currentPageNumber || 1) - 1;
    let best = 0;
    queue.forEach((page, k) => {
      const score = (p) => (p >= current ? p - current : 1e6 + p);
      if (score(page) < score(queue[best])) best = k;
    });
    return best;
  }

  function enqueue(pageIndex) {
    queue.push(pageIndex);
    pump();
  }

  function retryFailed(pageIndex) {
    const state = pages.get(pageIndex);
    if (!state || state.status !== 'failed') return;
    state.status = 'translating';
    state.quietRetry = true;
    state.failedAttempts = 0;
    state.settled = new Promise((r) => (state.resolveSettled = r));
    renderPage(pageIndex);
    enqueue(pageIndex);
  }

  // ---------- rendering ----------
  function createBlockElement(block, parts, sentenceLinks, sources, inlineDisplayMath = false) {
    const el = document.createElement('div');
    el.className = 'browser-layout-translation-block';
    el.style.left = scaled(block.left - 1);
    el.style.top = scaled(block.top);
    el.style.width = scaled(block.width + 2);
    el.style.height = scaled(block.height);
    if (!parts) {
      el.classList.add('pending');
      return { element: el, text: null };
    }
    const text = document.createElement('div');
    text.className = 'browser-layout-translation-text';
    el.style.textAlign = block.align;
    el.style.lineHeight = Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, block.lineHeight / block.fontSize)).toFixed(3);
    if (block.isBold) el.classList.add('bold');
    if (block.fontFamily === 'sans-serif') el.classList.add('sans');
    if (block.fontFamily === 'monospace') el.classList.add('mono');
    if (block.lineCount === 1) el.classList.add('single-line');
    parts.forEach((part, i) => {
      const span = document.createElement('span');
      span.className = SENTENCE_CLASS;
      span.dataset.members = part.members.join(',');
      span.dataset.translated = String(part.translated);
      span.dataset.sourceText = part.members.map((m) => sources[m] ?? '').join(' ');
      renderSentenceContent(span, part.text, i === 0 ? block.boldPrefix : '', inlineDisplayMath);
      if (part.translated) {
        const links = part.members.flatMap((m) => sentenceLinks.get(m) ?? []);
        if (links.length > 0) {
          span.dataset.linkTokens = links.map((l) => `${l.id}=${l.text}`).join('|');
          linkifySentence(span, links, translated?.linkService);
        }
      }
      text.append(span, ' ');
    });
    el.append(text);
    return { element: el, text };
  }

  function drawBlocks(layer, state, canvas, pageIndex, { rememberFit = true } = {}) {
    const skipRules = [
      { reason: 'figure', rects: pageBoxes.rectsOf(pageIndex, state.size, BOX_CLASS.FIGURE), applies: isFigureInternalText },
      { reason: 'table', rects: pageBoxes.rectsOf(pageIndex, state.size, BOX_CLASS.TABLE), applies: isTableCellText },
      { reason: 'title', rects: pageBoxes.rectsOf(pageIndex, state.size, BOX_CLASS.TITLE), applies: (b) => b.lineCount <= TITLE_MAX_LINES && isHeadingText(b.text) },
    ];
    const dropped = [];
    const obstacles = [BOX_CLASS.FIGURE, BOX_CLASS.TABLE, BOX_CLASS.ISOLATE_FORMULA].flatMap((c) => pageBoxes.rectsOf(pageIndex, state.size, c));
    const sources = state.sentences.map((s) => s.text);
    state.blocks.forEach((block, bi) => {
      const parts = state.parts.get(bi);
      if (!parts && (state.status !== 'translating' || state.quietRetry)) return;
      const cover = sampleCoverColor(canvas, block);
      const b = { ...block, width: getSafeBlockWidth(block, canvas, cover, obstacles) };
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const rule = skipRules.find(({ rects, applies }) => applies(b) && rects.some((r) => cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height));
      if (rule) return void dropped.push(`${bi}:${rule.reason}`);
      const translation = parts?.map((p) => p.text).join(' ');
      const reuseFit = b.fitted !== undefined && b.fitted.translation === translation && b.fitted.width === b.width;
      let fontSize;
      let { element, text } = createBlockElement(b, parts, state.sentenceLinks, sources, reuseFit && b.fitted?.inlineDisplayMath);
      element.dataset.blockIndex = String(bi);
      if (!parts) element.style.animationDelay = `-${(PENDING_PHASES - 1 - (bi % PENDING_PHASES)) * PENDING_PHASE_MS}ms`;
      layer.append(element);
      if (!text || !parts) return;
      element.style.setProperty('--browser-layout-cover', cover);
      element.style.color = isDark(cover) ? '#f5f5f5' : '#1a1a1a';
      if (reuseFit && b.fitted) {
        fontSize = b.fitted.fontSize;
        element.style.setProperty('font-size', scaled(fontSize));
      } else {
        fontSize = fitFontSize(element, text, b);
        let inline = false;
        // Display math that forces an illegible size is retried inline.
        if (!isLegibleFit(b, fontSize) && /\$\$[^$]+\$\$/.test(translation ?? '')) {
          const alt = createBlockElement(b, parts, state.sentenceLinks, sources, true);
          if (alt.text) {
            alt.element.dataset.blockIndex = String(bi);
            alt.element.style.setProperty('--browser-layout-cover', cover);
            alt.element.style.color = element.style.color;
            element.replaceWith(alt.element);
            ({ element, text } = alt);
            fontSize = fitFontSize(element, alt.text, b);
            inline = true;
          }
        }
        if (rememberFit && translation !== undefined) block.fitted = { translation, fontSize, inlineDisplayMath: inline, width: b.width };
      }
      relaxLineHeight(element, text, b);
      const failure = element.querySelector('[data-math-failed]') ? 'math' : isLegibleFit(b, fontSize) ? undefined : 'illegible';
      if (failure) {
        element.remove();
        dropped.push(`${bi}:${failure}`);
      }
    });
    layer.dataset.droppedBlocks = dropped.join(',');
  }

  // Transparent source text for every block that shows the original, so it stays selectable.
  function drawSourceText(layer, state, viewportScale) {
    const byIndex = new Map([...layer.querySelectorAll('.browser-layout-translation-block[data-block-index]')].map((el) => [Number(el.dataset.blockIndex), el]));
    const firstItem = (b) => b.lines[0]?.runs[0]?.itemIndex ?? Number.MAX_SAFE_INTEGER;
    const ordered = [...state.excludedBlocks.map((block) => ({ block, element: undefined })), ...state.blocks.map((block, i) => ({ block, element: byIndex.get(i) }))].sort(
      (a, b) => firstItem(a.block) - firstItem(b.block),
    );
    const spans = [];
    ordered.forEach(({ block, element }) => {
      if (element) return void layer.append(element);
      const host = document.createElement('div');
      host.className = `${SOURCE_TEXT_CLASS}-host`;
      getSourceTextPieces(block).forEach(({ line, pieces }) => {
        pieces.forEach((piece) => {
          const span = document.createElement('span');
          span.className = SOURCE_TEXT_CLASS;
          span.textContent = piece.text;
          span.style.left = scaled(piece.left);
          span.style.top = scaled(line.top);
          span.style.fontSize = scaled(block.fontSize);
          span.style.lineHeight = scaled(line.bottom - line.top);
          host.append(span);
          spans.push({ span, width: (piece.right - piece.left) * viewportScale });
        });
        const br = document.createElement('br');
        br.className = `${SOURCE_TEXT_CLASS}-break`;
        host.append(br);
      });
      layer.append(host);
    });
    spans.forEach(({ span, width }) => {
      const w = span.offsetWidth;
      if (w > 0 && width > 0) span.style.transform = `scaleX(${(width / w).toFixed(4)})`;
    });
  }

  function failureNotice(pageIndex, state) {
    const box = document.createElement('div');
    box.className = 'browser-layout-translation-failure';
    box.setAttribute('role', 'status');
    box.setAttribute('data-html2canvas-ignore', 'true');
    const msg = document.createElement('span');
    if (state.quietRetry) {
      msg.textContent = L10N['loading-title'];
      box.append(msg);
      return box;
    }
    msg.textContent = state.failureIsTransient ? L10N['failed-network-body'] : L10N['failed-body'];
    if (state.errorMessage && !/^translation \d+$|stream ended early/.test(state.errorMessage)) {
      const detail = document.createElement('small');
      detail.textContent = state.errorMessage; // e.g. missing API key, model not installed
      msg.append(document.createElement('br'), detail);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = L10N.retry;
    btn.addEventListener('click', () => retryFailed(pageIndex));
    box.append(msg, btn);
    return box;
  }

  // PDF link annotations under a translation block would steal clicks from the translated text.
  function updateLinkPointerEvents(pageDiv) {
    const rects = [...pageDiv.querySelectorAll(`.${LAYER_CLASS} .browser-layout-translation-block`)].map((el) => el.getBoundingClientRect());
    pageDiv.querySelectorAll('.annotationLayer .linkAnnotation').forEach((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      el.style.pointerEvents = rects.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) ? 'none' : '';
    });
  }

  function renderPage(pageIndex) {
    const state = pages.get(pageIndex);
    const view = translated?.pdfViewer._pages?.[pageIndex];
    const canvas = view?.canvas;
    if (!(isActive() && state && view?.div && canvas)) return;
    canvas.dataset.browserLayoutPageWidth = String(state.size.width);
    canvas.dataset.browserLayoutPageHeight = String(state.size.height);
    view.div.querySelector(`.${LAYER_CLASS}`)?.remove();
    const layer = document.createElement('div');
    layer.className = LAYER_CLASS;
    setLayoutLayerGeometry(layer, state.size, translated.pdfViewer.pagesRotation ?? 0);
    view.div.append(layer);
    if (!pageBoxes.boxes[pageIndex]?.length && !waitingForBoxes.has(pageIndex)) {
      waitingForBoxes.add(pageIndex);
      pageBoxes.ensure(pageIndex);
      pageBoxes.promise(pageIndex).then(() => renderPage(pageIndex));
    }
    drawBlocks(layer, state, canvas, pageIndex);
    drawSourceText(layer, state, view.viewport.scale);
    clearMatch();
    if (state.status === 'failed' || state.quietRetry) layer.append(failureNotice(pageIndex, state));
    updateLinkPointerEvents(view.div);
  }

  // ---------- scroll / scale sync ----------
  function syncGeometry() {
    const src = source.pdfViewer;
    if (!translated) return;
    const rotation = src.pagesRotation ?? 0;
    if (translated.pdfViewer.pagesRotation !== rotation) {
      translated.pdfViewer.pagesRotation = rotation;
      pages.forEach((_, i) => renderPage(i));
    }
    if (linked && translated.pdfViewer.currentScale !== src.currentScale) translated.pdfViewer.currentScale = src.currentScale;
  }

  // Pinch zooms only the pane under the pointer in side-by-side mode; scroll sync maps by page fraction, so scales may differ.
  function zoomViewer(onTranslated) {
    const independent = isActive() && getViewMode() !== 'translated-only';
    linked = !independent;
    if (independent && onTranslated && translated) {
      holdSource(); // the scroll that keeps the pinch point in place must not be undone by the source
      return translated.pdfViewer;
    }
    return source.pdfViewer;
  }
  function syncScale() {
    linked = true;
    syncGeometry();
  }

  // One wheel handler for both panes: scroll the pane under the pointer and its mirror in the same frame (a scroll
  // event round trip would leave the mirror a frame behind).
  let wheelPane;
  let wheelDy = 0;
  let wheelFrame = 0;
  function onWheelPane(e) {
    if (e.ctrlKey || !isActive() || getViewMode() === 'translated-only') return;
    e.preventDefault();
    const el = e.currentTarget;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    el.scrollLeft += e.deltaX * unit;
    wheelPane = el;
    wheelDy += e.deltaY * unit;
    wheelFrame ||= requestAnimationFrame(() => {
      wheelFrame = 0;
      wheelPane.scrollTop += wheelDy;
      wheelDy = 0;
      syncScroll(wheelPane === source.container ? 'to-translated' : 'to-source');
    });
  }

  function scrollAnchor(container, views) {
    const index = Math.max(0, views.findIndex(({ div }) => div.offsetTop + div.offsetHeight > container.scrollTop));
    const { div } = views[index];
    return { index, fraction: (container.scrollTop - div.offsetTop) / div.offsetHeight };
  }

  function syncScroll(direction) {
    const src = source.container;
    const dst = translatedContainer();
    const srcPages = source.pdfViewer._pages ?? [];
    const dstPages = translated?.pdfViewer._pages ?? [];
    if (!src || !dst || !isActive() || srcPages.length === 0 || srcPages.length !== dstPages.length) return;
    const toTranslated = direction === 'to-translated';
    const anchor = toTranslated ? scrollAnchor(src, srcPages) : scrollAnchor(dst, dstPages);
    const div = (toTranslated ? dstPages : srcPages)[anchor.index].div;
    const target = toTranslated ? dst : src;
    const top = div.offsetTop + anchor.fraction * div.offsetHeight;
    if (Math.abs(target.scrollTop - top) <= SCROLL_EPSILON) return;
    target.scrollTop = top;
    syncedScroll = { container: target, scrollTop: target.scrollTop };
  }

  const isEcho = (el) => el === syncedScroll?.container && Math.abs(el.scrollTop - syncedScroll.scrollTop) <= SCROLL_EPSILON;
  const holdSource = () => (holdSourceUntil = Date.now() + USER_SCROLL_HOLD_MS);
  function onSourceScroll() {
    if (!isEcho(source.container)) syncScroll('to-translated');
  }
  function onTranslatedScroll() {
    const el = translatedContainer();
    if (el && isEcho(el)) return;
    if (pointerDown || Date.now() < holdSourceUntil) {
      holdSource();
      syncScroll('to-source');
    } else {
      syncScroll('to-translated');
    }
  }

  function relayout() {
    const src = source.pdfViewer;
    const value = src.currentScaleValue;
    if (PRESET_SCALES.has(value)) src.currentScaleValue = value; // recompute fit for the new width
    src.update?.();
    if (isActive()) {
      syncGeometry();
      translated?.pdfViewer.update?.();
      syncScroll('to-translated');
    }
  }
  const scheduleRelayout = () => {
    requestAnimationFrame(relayout);
    setTimeout(relayout, 220);
  };

  // ---------- hover matching (module 70850) ----------
  function sourcePageDiv(pageIndex) {
    return source.pdfViewer._pages?.[pageIndex]?.div;
  }
  const pageIndexOf = (el) => {
    const n = el?.closest('.page')?.dataset.pageNumber;
    return n ? Number(n) - 1 : undefined;
  };
  const sentenceRects = (state, i) => getSentenceRects(state.blocks, state.sentences, i);

  function clearMatch() {
    hoverEpoch += 1;
    if (!match) return;
    translated?.pdfViewer._pages?.[match.pageIndex]?.div.querySelectorAll(`.${SENTENCE_CLASS}.active`).forEach((el) => el.classList.remove('active'));
    sourcePageDiv(match.pageIndex)?.querySelector(`.${MATCH_LAYER_CLASS}`)?.remove();
    match = undefined;
  }

  function showMatch(pageIndex, members) {
    const key = members.join(',');
    if (match?.pageIndex === pageIndex && match.key === key) return;
    clearMatch();
    const state = pages.get(pageIndex);
    const srcDiv = sourcePageDiv(pageIndex);
    if (!state || !srcDiv) return;
    const spans = [...(translated?.pdfViewer._pages?.[pageIndex]?.div.querySelectorAll(`.${SENTENCE_CLASS}`) ?? [])].filter((el) => el.dataset.members === key);
    if (spans.length === 0) return;
    match = { pageIndex, key };
    spans.forEach((el) => el.classList.add('active'));
    const layer = document.createElement('div');
    layer.className = MATCH_LAYER_CLASS;
    setLayoutLayerGeometry(layer, state.size, source.pdfViewer.pagesRotation ?? 0);
    members
      .flatMap((m) => sentenceRects(state, m))
      .forEach((r) => {
        const el = document.createElement('div');
        el.className = 'browser-layout-source-match';
        el.style.left = scaled(r.left);
        el.style.top = scaled(r.top);
        el.style.width = scaled(r.width);
        el.style.height = scaled(r.height);
        layer.append(el);
      });
    srcDiv.append(layer);
  }

  function attachInteractions(container) {
    let frame;
    container.addEventListener('mouseover', (e) => {
      if (!isActive()) return;
      hoverEpoch += 1;
      const span = e.target?.closest?.(`.${SENTENCE_CLASS}[data-translated="true"]`);
      const pageIndex = pageIndexOf(span ?? null);
      if (span && pageIndex !== undefined) showMatch(pageIndex, (span.dataset.members ?? '').split(',').map(Number));
      else clearMatch();
    }, { signal });
    container.addEventListener('mouseleave', clearMatch, { signal });
    container.addEventListener('scroll', clearMatch, { passive: true, signal });
    const src = source.container;
    src.addEventListener('mousemove', (e) => {
      if (!isActive() || frame !== undefined) return;
      const epoch = hoverEpoch;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!isActive() || epoch !== hoverEpoch) return;
        const pageDiv = e.target?.closest?.('.page');
        const pageIndex = pageIndexOf(pageDiv ?? null);
        const state = pageIndex === undefined ? undefined : pages.get(pageIndex);
        const scale = pageIndex === undefined ? undefined : source.pdfViewer._pages?.[pageIndex]?.viewport?.scale;
        if (!pageDiv || pageIndex === undefined || !state || !scale) return void clearMatch();
        const box = pageDiv.getBoundingClientRect();
        const { x, y } = unrotateLayoutPoint(
          { x: (e.clientX - box.left - pageDiv.clientLeft) / scale, y: (e.clientY - box.top - pageDiv.clientTop) / scale },
          state.size,
          source.pdfViewer.pagesRotation ?? 0,
        );
        const part = [...state.parts.values()].flat().filter((p) => p.translated).find((p) => p.members.some((m) => sentenceRects(state, m).some((r) => containsPoint(r, x, y))));
        if (part) showMatch(pageIndex, part.members);
        else clearMatch();
      });
    }, { signal });
    src.addEventListener('mouseleave', clearMatch, { signal });
    src.addEventListener('scroll', clearMatch, { passive: true, signal });
  }

  // ---------- panel ----------
  function syncModeButtons(panel) {
    const mode = getViewMode();
    panel.querySelectorAll('.layout-translated-pdf-mode-button').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `<div id="${CONTAINER_ID}" tabindex="0"><div class="pdfViewer"></div></div>`;
    const controls = document.createElement('div');
    controls.className = 'layout-translated-pdf-controls';
    controls.setAttribute('data-html2canvas-ignore', 'true');
    [
      { mode: 'split', label: L10N['split-view'] },
      { mode: 'translated-only', label: L10N['translated-only'] },
    ].forEach(({ mode, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layout-translated-pdf-mode-button';
      b.dataset.mode = mode;
      b.textContent = label;
      b.addEventListener('click', () => {
        if (getViewMode() === mode) return;
        applyViewMode(mode);
        syncModeButtons(panel);
        clearMatch();
        scheduleRelayout();
      });
      controls.append(b);
    });
    panel.prepend(controls);
    mainContainer.append(panel);
    return panel;
  }

  function ensureTranslatedViewer() {
    if (translated) return translated;
    const panel = document.getElementById(PANEL_ID) ?? createPanel();
    const container = panel.querySelector(`#${CONTAINER_ID}`);
    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({ eventBus, ignoreDestinationZoom: true });
    const pdfViewer = new pdfjsViewer.PDFViewer({
      container,
      viewer: container.firstElementChild,
      eventBus,
      linkService,
      textLayerMode: 0,
      annotationMode: 1, // AnnotationMode.ENABLE: links only
      removePageBorders: false,
    });
    linkService.setViewer(pdfViewer);
    const goTo = linkService.goToDestination.bind(linkService);
    linkService.goToDestination = async (dest) => {
      await goTo(dest);
      holdSource();
      syncScroll('to-source');
    };
    eventBus.on('pagesinit', () => {
      syncGeometry();
      syncScroll('to-translated');
    });
    eventBus.on('annotationlayerrendered', ({ pageNumber }) => {
      const div = pdfViewer._pages?.[pageNumber - 1]?.div;
      if (div) updateLinkPointerEvents(div);
    });
    eventBus.on('pagerendered', ({ pageNumber, cssTransform }) => {
      const i = pageNumber - 1;
      const canvas = pdfViewer._pages?.[i]?.canvas;
      if (canvas && !cssTransform) canvas.dataset.browserLayoutRotation = String(pdfViewer.pagesRotation ?? 0);
      pageState(i)
        .then(() => renderPage(i))
        .catch((e) => console.error('Browser layout blocks failed', e));
    });
    source.container.addEventListener('scroll', onSourceScroll, { passive: true, signal });
    container.addEventListener('scroll', onTranslatedScroll, { passive: true, signal });
    container.addEventListener('wheel', onWheelPane, { passive: false, signal });
    source.container.addEventListener('wheel', onWheelPane, { passive: false, signal });
    container.addEventListener('click', (e) => e.target instanceof Element && e.target.closest('a') && holdSource(), { capture: true, signal });
    ['wheel', 'touchstart', 'touchmove', 'keydown'].forEach((t) => container.addEventListener(t, holdSource, { passive: true, signal }));
    container.addEventListener('pointerdown', () => (pointerDown = true), { signal });
    ['pointerup', 'pointercancel'].forEach((t) => window.addEventListener(t, () => (pointerDown = false), { signal }));
    source.eventBus.on('scalechanging', () => {
      clearMatch();
      if (isActive()) requestAnimationFrame(syncGeometry);
    });
    source.eventBus.on('rotationchanging', () => {
      clearMatch();
      if (isActive()) {
        syncGeometry();
        syncScroll('to-translated');
      }
    });
    window.addEventListener('resize', () => isActive() && scheduleRelayout(), { signal });
    document.fonts?.addEventListener('loadingdone', () => {
      if (!isActive()) return;
      pages.forEach((state, i) => {
        const stale = state.blocks.filter((b) => b.fitted?.translation.includes('$'));
        if (stale.length === 0) return;
        stale.forEach((b) => (b.fitted = undefined));
        renderPage(i);
      });
    }, { signal });
    window.addEventListener('online', () => isActive() && pages.forEach((s, i) => s.status === 'failed' && retryFailed(i)), { signal });
    translated = { eventBus, linkService, pdfViewer };
    attachInteractions(container);
    linkService.setDocument(pdfDocument, null);
    pdfViewer.setDocument(pdfDocument);
    return translated;
  }

  function applyNarrowMode() {
    if (isNarrow()) applyViewMode('translated-only', { remember: false });
    else applyViewMode(preferredViewMode());
    const panel = document.getElementById(PANEL_ID);
    if (panel) syncModeButtons(panel);
  }

  const classObserver = new MutationObserver(() => {
    const n = isNarrow();
    if (n === narrow) return;
    narrow = n;
    applyNarrowMode();
    scheduleRelayout();
  });

  function rememberOpenState(open) {
    const fp = fingerprint();
    if (!fp) return;
    const list = readList(OPEN_DOCS_KEY).filter((x) => x !== fp);
    if (open) list.push(fp);
    try {
      localStorage.setItem(OPEN_DOCS_KEY, JSON.stringify(list.slice(-MAX_REMEMBERED)));
    } catch {}
  }

  function toggle() {
    const root = document.documentElement;
    root.classList.toggle(ACTIVE_CLASS);
    rememberOpenState(isActive());
    if (isActive()) {
      linked = true;
      ensureTranslatedViewer();
      applyNarrowMode();
      narrow = isNarrow();
      classObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
      pages.forEach((_, i) => renderPage(i));
      reportProgress();
      translateAll();
    } else {
      classObserver.disconnect();
      clearMatch();
      applyViewMode('split', { remember: false });
    }
    scheduleRelayout();
    onStateChange?.(isActive());
  }

  // Source page clicked "show original" while in translated-only (port of registerBrowserLayoutSourceReveal).
  function showSource() {
    if (!isActive() || getViewMode() !== 'translated-only') return;
    if (isNarrow()) toggle();
    else {
      applyViewMode('split');
      const panel = document.getElementById(PANEL_ID);
      if (panel) syncModeButtons(panel);
    }
    clearMatch();
    relayout();
  }

  function destroy() {
    lifetime.abort();
    pages.forEach((state) => state.resolveSettled()); // a running export stops waiting (waitForPage then throws)
    classObserver.disconnect();
    document.documentElement.classList.remove(ACTIVE_CLASS, TRANSLATED_ONLY_CLASS);
    cancelAnimationFrame(wheelFrame);
    translated?.pdfViewer.setDocument(null);
    document.getElementById(PANEL_ID)?.remove();
    translated = undefined;
  }

  const wasOpen = () => {
    const fp = fingerprint();
    return fp !== undefined && readList(OPEN_DOCS_KEY).includes(fp);
  };

  return {
    toggle,
    isActive,
    zoomViewer,
    syncScale,
    showSource,
    destroy,
    restore: () => !isActive() && wasOpen() && toggle(),
    // used by the PDF exporter (module 20777)
    printSupport: {
      async waitForPage(i) {
        pageBoxes.ensure(i);
        await pageBoxes.promise(i);
        const state = await pageState(i);
        retryFailed(i);
        await state.settled;
        if (signal.aborted) throw new Error('closed');
        return state;
      },
      drawBlocks: (layer, state, canvas, i) => drawBlocks(layer, state, canvas, i, { rememberFit: false }),
      refitBlocks(layer, state) {
        layer.querySelectorAll('.browser-layout-translation-block').forEach((el) => {
          const block = state.blocks[Number(el.dataset.blockIndex)];
          const text = el.querySelector('.browser-layout-translation-text');
          if (block && text) {
            fitFontSize(el, text, block);
            relaxLineHeight(el, text, block);
          }
        });
      },
      setPrinting(on) {
        concurrency = on ? 5 : 2;
        pump();
      },
    },
  };
}
