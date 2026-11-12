// Port of Moonlight module 20777: export the layout translation as a PDF. Each translated block is
// drawn off-screen, rasterised with html2canvas and stamped as a PNG over the original page with
// pdf-lib (or over a JPEG of the page when the source PDF can't be re-saved).
import html2canvas from 'html2canvas';
import { PDFDocument, degrees } from 'pdf-lib';
import { getTranslationOverlayPlacement } from './geometry.js';

const HOST_CLASS = 'browser-layout-export-host';
const LAYOUT_SCALE = 2;
const RASTER_SCALE = 1.5;
const REBUILD_DPI = 150;
const COVER_PAD = 2.5;

const toBuffer = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b.arrayBuffer()) : reject(new Error('Failed to encode'))), type, quality));

async function cropOverlay(raster, blockEl) {
  const pad = COVER_PAD * LAYOUT_SCALE;
  const left = blockEl.offsetLeft - pad;
  const top = blockEl.offsetTop - pad;
  const width = blockEl.offsetWidth + 2 * pad;
  const height = blockEl.offsetHeight + 2 * pad;
  const c = document.createElement('canvas');
  c.width = Math.ceil(width * RASTER_SCALE);
  c.height = Math.ceil(height * RASTER_SCALE);
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = getComputedStyle(blockEl).getPropertyValue('--browser-layout-cover') || '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(raster, left * RASTER_SCALE, top * RASTER_SCALE, c.width, c.height, 0, 0, c.width, c.height);
  const png = await toBuffer(c, 'image/png');
  c.width = c.height = 0;
  return { png, region: { left: left / LAYOUT_SCALE, top: top / LAYOUT_SCALE, width: width / LAYOUT_SCALE, height: height / LAYOUT_SCALE } };
}

async function renderPageOverlays(pdfDocument, support, pageIndex, host, rebuild) {
  const page = await pdfDocument.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const vp = rebuild ? page.getViewport({ scale: REBUILD_DPI / 72 }) : base;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.dataset.browserLayoutPageWidth = String(base.width);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const [state] = await Promise.all([support.waitForPage(pageIndex), page.render({ canvasContext: ctx, viewport: vp, ...(rebuild ? { intent: 'print' } : {}) }).promise]);
  const frame = document.createElement('div');
  frame.style.cssText = `position:relative;overflow:hidden;width:${base.width * LAYOUT_SCALE}px;height:${base.height * LAYOUT_SCALE}px;--scale-factor:${LAYOUT_SCALE};`;
  const layer = document.createElement('div');
  layer.className = 'browser-layout-translation-layer';
  frame.append(layer);
  host.append(frame);
  try {
    support.drawBlocks(layer, state, canvas, pageIndex);
    const blocks = [...layer.querySelectorAll('.browser-layout-translation-block')];
    const failed = state.status === 'failed';
    const pageSize = { width: base.width, height: base.height };
    const pageImage = rebuild ? await toBuffer(canvas, 'image/jpeg', 0.92) : undefined;
    if (blocks.length === 0) return { overlays: [], failed, pageImage, pageSize };
    await document.fonts?.ready;
    support.refitBlocks(layer, state);
    const raster = await html2canvas(frame, { backgroundColor: null, scale: RASTER_SCALE, logging: false, ignoreElements: (el) => el.parentElement === document.body && el !== host });
    const overlays = await Promise.all(blocks.map((b) => cropOverlay(raster, b)));
    raster.width = raster.height = 0;
    return { overlays, failed, pageImage, pageSize };
  } finally {
    canvas.width = canvas.height = 0;
    frame.remove();
  }
}

const normalize = ({ x, y, width, height }) => ({ x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) });

function visiblePageBox(page) {
  const media = normalize(page.getMediaBox());
  const crop = normalize(page.getCropBox());
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const w = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const h = Math.min(crop.y + crop.height, media.y + media.height) - y;
  return w <= 0 || h <= 0 ? media : { x, y, width: w, height: h };
}

async function stampPage(out, pageIndex, result, rebuild) {
  const { width, height } = result.pageSize;
  const page = rebuild ? out.addPage([width, height]) : out.getPage(pageIndex);
  if (rebuild && result.pageImage) page.drawImage(await out.embedJpg(result.pageImage), { x: 0, y: 0, width, height });
  const box = rebuild ? { x: 0, y: 0, width, height } : visiblePageBox(page);
  const rotation = rebuild ? 0 : page.getRotation().angle;
  for (const o of result.overlays) {
    const { rotateDegrees, ...rect } = getTranslationOverlayPlacement(box, rotation, o.region);
    page.drawImage(await out.embedPng(o.png), { ...rect, rotate: degrees(rotateDegrees) });
  }
}

export async function exportLayoutTranslationPdf({ pdfDocument, support, signal, onProgress }) {
  const total = pdfDocument.numPages;
  let out;
  let rebuild = false;
  try {
    out = await PDFDocument.load(await pdfDocument.getData());
  } catch {
    out = await PDFDocument.create();
    rebuild = true;
  }
  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  document.body.append(host);
  const failedPageIndices = [];
  support.setPrinting(true);
  try {
    for (let i = 0; i < total; i++) support.waitForPage(i).catch(() => {});
    onProgress?.({ completed: 0, total });
    let chain = Promise.resolve();
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError');
      const result = await renderPageOverlays(pdfDocument, support, i, host, rebuild);
      if (result.failed) failedPageIndices.push(i);
      chain = chain.then(async () => {
        await stampPage(out, i, result, rebuild);
        onProgress?.({ completed: i + 1, total });
      });
    }
    await chain;
    return { blob: new Blob([await out.save()], { type: 'application/pdf' }), failedPageIndices };
  } finally {
    host.remove();
    support.setPrinting(false);
  }
}
