// Source PDF viewer (PDF.js 4.5.136, the version Moonlight 3.7.5 ships) + layout translation wiring.
// Legacy builds: the app runs in the system webview (WKWebView / WebView2), which can be older than Chromium.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { createPageBoxes } from './layout/detect.js';
import { createLayoutTranslation } from './layout/layoutTranslation.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads the library from this global
const viewerModule = import('pdfjs-dist/legacy/web/pdf_viewer.mjs');

// First-page preview for library cards.
export async function renderThumbnail(url, width = 320) {
  const task = pdfjsLib.getDocument({ url, cMapUrl: './pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './pdfjs/standard_fonts/' });
  try {
    const page = await (await task.promise).getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * 2) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('thumbnail'))), 'image/jpeg', 0.85));
  } finally {
    task.destroy();
  }
}

const NARROW_CLASS = 'moonlight-viewer-tablet-portrait';
const NARROW_WIDTH = 900;

export async function openReader({ mainContainer, viewerContainer, doc, language, onState }) {
  const pdfjsViewer = await viewerModule;
  const loadingTask = pdfjsLib.getDocument({ url: `/files/${doc.id}.pdf`, cMapUrl: './pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './pdfjs/standard_fonts/' });
  const pdfDocument = await loadingTask.promise;

  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
  const pdfViewer = new pdfjsViewer.PDFViewer({ container: viewerContainer, viewer: viewerContainer.firstElementChild, eventBus, linkService, textLayerMode: 1, annotationMode: 2 });
  linkService.setViewer(pdfViewer);

  const pageBoxes = createPageBoxes({ apiBase: '/api', docKey: doc.id, pdfDocument });
  eventBus.on('pagerendered', ({ pageNumber }) => pageBoxes.ensure(pageNumber - 1));

  const layout = createLayoutTranslation({
    pdfjsViewer,
    pdfDocument,
    source: { pdfViewer, eventBus, linkService, container: viewerContainer },
    mainContainer,
    pageBoxes,
    getLanguage: () => language,
    requestTranslation: (body, signal) => fetch('/api/ai/translate-page-with-source-v2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }),
    onStateChange: (active) => emit({ layoutActive: active }),
    onProgress: (progress) => emit({ progress }),
  });

  // Trackpad pinch arrives as ctrl+wheel; zoom around the pointer, accumulating small deltas
  // (PDF.js rounds the scale to 2 decimals). Each pane zooms on its own.
  const listeners = new AbortController();
  const { signal } = listeners;
  let pinch = 1;
  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    pinch *= Math.exp(-e.deltaY / 100);
    if (Math.abs(pinch - 1) < 0.02) return;
    layout.zoomViewer(!!e.target.closest?.('#browser-layout-translation-panel')).updateScale({ drawingDelay: 400, scaleFactor: pinch, origin: [e.clientX, e.clientY] });
    pinch = 1;
  };
  mainContainer.addEventListener('wheel', onWheel, { passive: false, signal });
  // WebKit (macOS webview) reports pinch as gesture events instead of ctrl+wheel.
  let gesture = null;
  const onGestureStart = (e) => {
    e.preventDefault();
    const viewer = layout.zoomViewer(!!e.target.closest?.('#browser-layout-translation-panel'));
    gesture = { viewer, scale: viewer.currentScale, last: 1 };
  };
  const onGestureChange = (e) => {
    e.preventDefault();
    if (!gesture || Math.abs(e.scale / gesture.last - 1) < 0.03) return;
    gesture.last = e.scale;
    gesture.viewer.updateScale({ drawingDelay: 400, scaleFactor: (gesture.scale * e.scale) / gesture.viewer.currentScale, origin: [e.clientX, e.clientY] });
  };
  const onGestureEnd = (e) => {
    e.preventDefault();
    gesture = null;
  };
  mainContainer.addEventListener('gesturestart', onGestureStart, { signal });
  mainContainer.addEventListener('gesturechange', onGestureChange, { signal });
  mainContainer.addEventListener('gestureend', onGestureEnd, { signal });
  const onKey = (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === '=' || e.key === '+') pdfViewer.increaseScale();
    else if (e.key === '-') pdfViewer.decreaseScale();
    else if (e.key === '0') pdfViewer.currentScaleValue = 'auto';
    else return;
    layout.syncScale();
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey, { signal });

  const state = { page: 1, pages: pdfDocument.numPages, scale: 'auto', layoutActive: false, progress: null };
  const emit = (patch) => {
    Object.assign(state, patch);
    onState({ ...state });
  };
  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = 'auto';
    layout.restore();
  });
  eventBus.on('pagechanging', ({ pageNumber }) => emit({ page: pageNumber }));
  eventBus.on('scalechanging', ({ presetValue, scale }) => emit({ scale: presetValue || String(scale) }));

  const onResize = () => document.documentElement.classList.toggle(NARROW_CLASS, window.innerWidth < NARROW_WIDTH);
  onResize();
  window.addEventListener('resize', onResize, { signal });

  linkService.setDocument(pdfDocument, null);
  pdfViewer.setDocument(pdfDocument);
  emit({});

  return {
    numPages: pdfDocument.numPages,
    toggleLayout() {
      layout.toggle();
      if (layout.isActive()) fetch('/api/local/warm', { method: 'POST' }).catch(() => {}); // preload the local model
    },
    setScale(v) {
      pdfViewer.currentScaleValue = v;
      layout.syncScale();
    },
    zoom(dir) {
      dir > 0 ? pdfViewer.increaseScale() : pdfViewer.decreaseScale();
      layout.syncScale();
    },
    goToPage: (n) => (pdfViewer.currentPageNumber = Math.min(Math.max(1, n), pdfDocument.numPages)),
    // Renders the translated PDF and stores it in the shared translations folder (server side).
    async exportPdf(onProgress) {
      const { exportLayoutTranslationPdf } = await import('./layout/exportPdf.js'); // html2canvas + pdf-lib load on first export
      const { blob, failedPageIndices } = await exportLayoutTranslationPdf({ pdfDocument, support: layout.printSupport, onProgress }).catch((err) => {
        throw listeners.signal.aborted ? new Error('문서를 닫아 번역본 저장을 멈췄어요.') : err;
      });
      const res = await fetch(`/api/exports?docId=${encodeURIComponent(doc.id)}&lang=${encodeURIComponent(language)}`, { method: 'POST', body: blob });
      if (!res.ok) throw new Error('번역본을 저장하지 못했어요.');
      return { ...(await res.json()), bytes: blob.size, failedPageIndices };
    },
    destroy() {
      listeners.abort();
      layout.destroy();
      pdfViewer.setDocument(null);
      loadingTask.destroy();
    },
  };
}
