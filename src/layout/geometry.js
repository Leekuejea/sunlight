// Ports of Moonlight modules 98209 (rotation geometry), 6065 (safe block width),
// 91173 (links inside translated text) and 59285 (export overlay placement).
import { getLineX } from './sentences.js';

function rotationMatrix(size, rotation) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, size.height, 0];
    case 180:
      return [-1, 0, 0, -1, size.width, size.height];
    case 270:
      return [0, -1, 1, 0, 0, size.width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

const scaled = (v) => `calc(var(--scale-factor) * ${v}px)`;

export function setLayoutLayerGeometry(el, size, rotation) {
  const [a, b, c, d, e, f] = rotationMatrix(size, rotation);
  el.style.width = scaled(size.width);
  el.style.height = scaled(size.height);
  el.style.transformOrigin = '0 0';
  el.style.transform = `translate(${scaled(e)}, ${scaled(f)}) matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`;
}

export function unrotateLayoutPoint(p, size, rotation) {
  const [a, b, c, d, e, f] = rotationMatrix(size, rotation);
  return { x: a * (p.x - e) + b * (p.y - f), y: c * (p.x - e) + d * (p.y - f) };
}

// PDF-space rect (scale 1, unrotated) -> device pixel rect on the rendered page canvas.
export function getLayoutCanvasRect(canvas, rect) {
  const pageWidth = Number(canvas.dataset.browserLayoutPageWidth);
  const rotation = Number(canvas.dataset.browserLayoutRotation ?? 0);
  const swapped = rotation % 180 !== 0;
  const pageHeight = Number(canvas.dataset.browserLayoutPageHeight) || (canvas.height * pageWidth) / canvas.width;
  if (!(pageWidth && pageHeight && canvas.width && canvas.height)) return undefined;
  const k = canvas.width / (swapped ? pageHeight : pageWidth);
  const [a, b, c, d, e, f] = rotationMatrix({ width: pageWidth, height: pageHeight }, rotation);
  const map = (x, y) => ({ x: (a * x + c * y + e) * k, y: (b * x + d * y + f) * k });
  const p0 = map(rect.left, rect.top);
  const p1 = map(rect.left + rect.width, rect.top + rect.height);
  const left = Math.floor(Math.min(p0.x, p1.x));
  const top = Math.floor(Math.min(p0.y, p1.y));
  return { left, top, width: Math.ceil(Math.max(p0.x, p1.x)) - left, height: Math.ceil(Math.max(p0.y, p1.y)) - top };
}

const SAFE_PAD = 2.5;

// A block may use `availableWidth` only if the extra strip is free of detected objects and is
// uniformly the cover colour on the canvas.
export function getSafeBlockWidth(block, canvas, cover, obstacles) {
  const available = block.availableWidth ?? block.width;
  if (available <= block.width) return block.width;
  const strip = { left: block.left + block.width, top: block.top - SAFE_PAD, width: available - block.width + SAFE_PAD + 1, height: block.height + 2 * SAFE_PAD };
  if (obstacles.some((o) => o.left < strip.left + strip.width && o.left + o.width > strip.left && o.top < strip.top + strip.height && o.top + o.height > strip.top)) return block.width;
  const px = getLayoutCanvasRect(canvas, strip);
  const ctx = canvas.getContext('2d');
  const rgb = cover.match(/\d+/g)?.map(Number);
  if (!px || !ctx || !rgb || rgb.length !== 3) return block.width;
  if (px.left < 0 || px.top < 0 || px.left + px.width > canvas.width || px.top + px.height > canvas.height) return block.width;
  try {
    const { data } = ctx.getImageData(px.left, px.top, px.width, px.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== rgb[0] || data[i + 1] !== rgb[1] || data[i + 2] !== rgb[2] || data[i + 3] !== 255) return block.width;
    }
    return data.length > 0 ? available : block.width;
  } catch {
    return block.width;
  }
}

// ---- links (module 91173) ----
const LINK_TOKEN = /\p{N}+(?:\.\p{N}+)*|\p{L}+/gu;
const LINK_MIN_OVERLAP = 0.3;
const SCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which token of the block a PDF link annotation sits on (e.g. citation "[12]", "Fig. 3").
export function getBlockLink(block, link) {
  const cy = link.rect.top + link.rect.height / 2;
  const line = block.lines.find((l) => cy >= l.top && cy <= l.bottom);
  if (!line) return null;
  const text = block.text.slice(line.start, line.end);
  const right = link.rect.left + link.rect.width;
  const candidates = [...text.matchAll(LINK_TOKEN)]
    .map((m) => {
      const off = m.index ?? 0;
      const x0 = getLineX(block, line, off);
      const x1 = getLineX(block, line, off + m[0].length);
      const overlap = Math.min(x1, right) - Math.max(x0, link.rect.left);
      return { text: m[0], offset: off, ratio: overlap / Math.max(1, Math.min(x1 - x0, link.rect.width)) };
    })
    .filter((c) => c.ratio >= LINK_MIN_OVERLAP);
  const numeric = candidates.filter((c) => /\p{N}/u.test(c.text));
  const [best] = (numeric.length > 0 ? numeric : candidates).sort((a, b) => b.ratio - a.ratio);
  if (!best) return null;
  return {
    id: link.id,
    ...(link.url ? { url: link.url } : {}),
    ...(link.dest ? { dest: link.dest } : {}),
    ...(link.action ? { action: link.action } : {}),
    text: best.text,
    start: line.start + best.offset,
    end: line.start + best.offset + best.text.length,
  };
}

// Finds the source link tokens again inside the translated text (in order, non-overlapping).
export function locateTranslatedLinks(text, links) {
  const found = [];
  let from = 0;
  links.forEach((link) => {
    const plain = link.text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/gu, (c) => String(SCRIPT_DIGITS.indexOf(c) % 10));
    const variants = plain === link.text ? [link.text] : [link.text, plain];
    const re = new RegExp(`(?<![A-Za-z\\p{N}.])(?:${variants.map(escapeRe).join('|')})(?![A-Za-z\\p{N}]|\\.\\p{N})`, 'gu');
    re.lastIndex = from;
    const m =
      re.exec(text) ??
      [...text.matchAll(re)].find((x) => !found.some((f) => (x.index ?? 0) < f.end && (x.index ?? 0) + x[0].length > f.start));
    if (m && m.index !== undefined) {
      found.push({ id: link.id, start: m.index, end: m.index + m[0].length });
      from = Math.max(from, m.index + m[0].length);
    }
  });
  return found.sort((a, b) => a.start - b.start);
}

export function bindLayoutLink(a, link, linkService) {
  if (link.url) {
    a.href = link.url;
    a.target = '_blank'; // the Electron window-open handler sends it to the default browser
    a.rel = 'noopener noreferrer';
  } else if (link.dest) {
    a.href = linkService.getDestinationHash(link.dest);
    a.onclick = () => (linkService.goToDestination(link.dest), false);
  } else if (link.action) {
    a.href = '#';
    a.onclick = () => (linkService.executeNamedAction(link.action), false);
  }
}

// ---- export placement (module 59285) ----
export function getTranslationOverlayPlacement(box, rotation, region) {
  const r = (((90 * Math.round(rotation / 90)) % 360) + 360) % 360;
  let p = box;
  if (region) {
    const { left, top, width, height } = region;
    p =
      r === 90
        ? { x: box.x + top, y: box.y + left, width: height, height: width }
        : r === 180
          ? { x: box.x + box.width - left - width, y: box.y + top, width, height }
          : r === 270
            ? { x: box.x + box.width - top - height, y: box.y + box.height - left - width, width: height, height: width }
            : { x: box.x + left, y: box.y + box.height - top - height, width, height };
  }
  const right = p.x + p.width;
  const bottom = p.y + p.height;
  if (r === 90) return { x: right, y: p.y, width: p.height, height: p.width, rotateDegrees: r };
  if (r === 180) return { x: right, y: bottom, width: p.width, height: p.height, rotateDegrees: r };
  if (r === 270) return { x: p.x, y: bottom, width: p.height, height: p.width, rotateDegrees: r };
  return { ...p, rotateDegrees: 0 };
}
