// Port of Moonlight modules 50356/74751 + the box-detection driver (module around "detection configured").
// On every rendered page of the source viewer the page is posted to /detect as a PNG; the boxes
// (DocLayout-YOLO classes) are cached per document+page and published through `pageBoxes`.
// The PNG is rendered off screen at a fixed size, not taken from the viewer canvas: that canvas is
// cleared on zoom and its resolution follows the zoom level, and the boxes are cached for good.

export const BOX_CLASS = {
  TITLE: 0,
  PLAIN_TEXT: 1,
  ABANDON: 2,
  FIGURE: 3,
  FIGURE_CAPTION: 4,
  TABLE: 5,
  TABLE_CAPTION: 6,
  TABLE_FOOTNOTE: 7,
  ISOLATE_FORMULA: 8,
  FORMULA_CAPTION: 9,
};

const DETECTION_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const DETECT_LONG_SIDE = 2048; // the detector letterboxes to 1024; render above that and let it downsample

async function pagePng(pdfDocument, pageIndex) {
  const page = await pdfDocument.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: DETECT_LONG_SIDE / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('page image');
    return blob;
  } finally {
    canvas.width = canvas.height = 0; // release the bitmap now (WebKit caps total canvas memory)
  }
}

export function createPageBoxes({ apiBase, docKey, pdfDocument }) {
  const boxes = {};
  const resolvers = {};
  const promises = {};
  const attempts = new Map();
  const inflight = new Map();

  const promiseFor = (i) => (promises[i] ??= new Promise((r) => (resolvers[i] = r)));
  const set = (i, list) => {
    boxes[i] = list.map((b, id) => ({ ...b, id: String(id) }));
    promiseFor(i);
    resolvers[i]();
  };

  async function detect(pageIndex) {
    const cacheUrl = `${apiBase}/boxes/${encodeURIComponent(docKey)}/${pageIndex}`;
    const cached = await fetch(cacheUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (cached) return set(pageIndex, cached), true;
    const n = attempts.get(pageIndex) ?? 0;
    if (n >= MAX_ATTEMPTS) return set(pageIndex, []), true;
    attempts.set(pageIndex, n + 1);
    const ctrl = new AbortController();
    let timer;
    try {
      const form = new FormData();
      form.append('file', new File([await pagePng(pdfDocument, pageIndex)], `page-${pageIndex}.png`, { type: 'image/png' }));
      timer = setTimeout(() => ctrl.abort(), DETECTION_TIMEOUT_MS);
      const res = await fetch(`${apiBase}/detect?url=${encodeURIComponent(docKey)}&page_index=${pageIndex}`, { method: 'POST', body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(`detect ${res.status}`);
      const list = await res.json();
      fetch(cacheUrl, { method: 'PUT', body: JSON.stringify(list) }).catch(() => {});
      set(pageIndex, list);
      return true;
    } catch {
      set(pageIndex, []); // unblock consumers; a later render retries once more
      if (n + 1 < MAX_ATTEMPTS) delete boxes[pageIndex];
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    boxes,
    promise: promiseFor,
    // Called from the source viewer's "pagerendered" event.
    ensure(pageIndex) {
      if (boxes[pageIndex] || inflight.has(pageIndex)) return;
      const p = detect(pageIndex).finally(() => inflight.delete(pageIndex));
      inflight.set(pageIndex, p);
    },
    rectsOf(pageIndex, size, cls) {
      return (boxes[pageIndex] ?? [])
        .filter((b) => b.box_cls === cls)
        .map(({ box_xywhn: [cx, cy, w, h] }) => ({ left: (cx - w / 2) * size.width, top: (cy - h / 2) * size.height, width: w * size.width, height: h * size.height }));
    },
  };
}
