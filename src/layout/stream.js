// Port of Moonlight module 16267: parser for the translate-page-with-source-v2 text stream.
// Wire format: "<|0|>translation 0\n<|1|>translation 1\n...<|end|>"  (or "<|stopped|>")
// Header X-Moonlight-Translation-End-Marker: 1 announces that a terminal marker will be sent.

export const TRANSLATION_END_MARKER_HEADER = 'X-Moonlight-Translation-End-Marker';

const MARKER = /<\|#?(\d+)(?:\|>|\|(?!>)|(?=[^\d|>]))/g;
const SENTENCE_END = /[.?!:。！？]["')\]]?\s*$/;
const BOLD_SEARCH_FACTOR = 3;
const BOLD_SEARCH_MIN = 20;
const END = '<|end|>';
const STOPPED = '<|stopped|>';
const PARTIAL_MARKER_AT_END = /<\|#?[a-z\d]*\|?$/;
const PARTIAL_TAIL = /<(?:\|#?[a-z\d]*\|?)?$/;
const STRAY_MARKER = /<\|#?\d+\|?>?/g;

// Drops a trailing formula the model appended after a source ending with ":".
export function trimAppendedFormula(source, translation) {
  return /[:：]\s*$/.test(source) ? translation.replace(/([:：])\s*(?:\$\$[^$]+\$\$|\$[^$]+\$)\s*$/, '$1') : translation;
}

function trimStopped(text) {
  if (PARTIAL_MARKER_AT_END.test(text)) return text.replace(PARTIAL_MARKER_AT_END, '');
  const last = [...text.matchAll(MARKER)].pop();
  if (!last) return '';
  const clean = text.replace(/<$/, '');
  const tail = clean.slice(last.index + last[0].length);
  return SENTENCE_END.test(tail) ? clean : text.slice(0, last.index);
}

export function splitCompletedStream(text) {
  if (text.endsWith(END)) return { text: text.slice(0, -END.length), isFinal: true, stoppedEarly: false };
  if (text.endsWith(STOPPED)) return { text: trimStopped(text.slice(0, -STOPPED.length)), isFinal: true, stoppedEarly: true };
  return { text: text.replace(PARTIAL_TAIL, ''), isFinal: false, stoppedEarly: false };
}

// Only segments followed by the next marker (or all, when final) are resolved. Segments equal to
// the source are dropped, so that sentence keeps its original rendering.
// Sunlight: Moonlight drops the whole page when a marker repeats or goes backwards. A model that writes
// "<|4\n<|4|>" would then leave a fully translated page in the original, so a repeated marker replaces the
// earlier one and an out-of-order or out-of-range marker is ignored.
export function parseTranslatedSegments(text, sources, isFinal) {
  const all = [...text.matchAll(MARKER)].map((m) => ({ index: Number(m[1]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const markers = [];
  for (const marker of all) {
    const last = markers[markers.length - 1];
    if (marker.index >= sources.length || (last && marker.index < last.index)) continue;
    if (last && marker.index === last.index) markers.pop();
    markers.push(marker);
  }
  const raw = markers.flatMap((m, i) => {
    const next = markers[i + 1];
    const cut = all.find((x) => x.start >= m.end); // an ignored marker still ends this segment
    const body = text.slice(m.end, cut ? cut.start : undefined).replace(STRAY_MARKER, '').trim();
    return (!next && !isFinal) || !body ? [] : [{ index: m.index, nextIndex: Math.min(next ? next.index : sources.length, sources.length), text: body }];
  });
  return {
    segments: raw
      .filter((s) => s.text !== sources[s.index].trim())
      .map((s) => ({ members: [s.index], text: trimAppendedFormula(sources[s.index], s.text) })),
    resolvedCount: isFinal ? sources.length : raw[raw.length - 1]?.nextIndex ?? 0,
  };
}

// Length of the translated bold run-in prefix ("1.2 Method." -> "1.2 방법.").
export function getTranslatedBoldPrefixLength(translated, boldPrefix) {
  if (!boldPrefix) return 0;
  if (translated.startsWith(boldPrefix)) return boldPrefix.length;
  const last = boldPrefix[boldPrefix.length - 1];
  if (!/[.:)]/.test(last)) return 0;
  const window = Math.max(BOLD_SEARCH_MIN, BOLD_SEARCH_FACTOR * boldPrefix.length);
  const i = translated.slice(0, window).indexOf(last);
  return i === -1 ? 0 : i + 1;
}

const RETRY_DELAYS = [2000, 6000];
const RETRYABLE_STATUS = new Set([408, 429]);

// Port of module 16089.
export function isRetryableTranslationFailure(err) {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const status = err?.status;
  return typeof status !== 'number' || status >= 500 || RETRYABLE_STATUS.has(status);
}

export const getTranslationRetryDelayMs = (attempt) => RETRY_DELAYS[attempt];
