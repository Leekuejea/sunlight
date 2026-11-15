// Sentence memos. The model follows Hancom Office HWP's memo field, observed in its memo_preset.hwp and
// resources (see README, "메모"):
//   - the anchor is a marked text range in the body, carrying only the memo's id and metadata;
//   - the memo text lives in a separate list keyed by that id, never inside the body;
//   - a "memo shape" gives each memo a fill colour and a stronger colour while it is the active one.
// Here the anchor is a run of source sentences on a page, stored with its text so it can be found again
// when sentence numbering changes; memos are saved per document, apart from the translation cache.

const MAX_LENGTH = 2000; // characters per memo; the textarea enforces it for typing and pasting
const COUNTER_FROM = 1600;
const SAVE_DELAY_MS = 500;
const RETRY_DELAY_MS = 5000;
const COLORS = ['yellow', 'orange'];
const COLOR_LABEL = { yellow: '노랑', orange: '주황' };
const OPEN_CLASS = 'sunlight-memos-open';
const MARK_LAYER = 'sunlight-memo-layer';
const SENTENCE_SELECTOR = '.browser-layout-translation-sentence';
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"。，、]+$/;

const pendingSaves = new Map(); // docKey -> Promise: a new reader waits for the previous one's last save

// Splits memo text into plain runs and web links ("www.x.y" gets https://).
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    const start = match.index ?? 0;
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let valid = raw.length > 4;
    try {
      valid = valid && new URL(href).hostname.includes('.');
    } catch {
      valid = false;
    }
    if (!valid) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// Finds the memo's sentences on its page: the saved indices when their text still matches, otherwise the
// first run of sentences with the same text. Returns null when the text is no longer on the page.
export function resolveAnchor(memo, sentenceTexts) {
  const join = (members) => members.map((i) => sentenceTexts[i] ?? '').join(' ');
  if (memo.members.every((i) => i < sentenceTexts.length) && join(memo.members) === memo.anchor) return memo.members;
  for (let start = 0; start < sentenceTexts.length; start++) {
    const members = [];
    let length = -1;
    for (let i = start; i < sentenceTexts.length && length < memo.anchor.length; i++) {
      members.push(i);
      length += sentenceTexts[i].length + 1;
    }
    if (length === memo.anchor.length && join(members) === memo.anchor) return members;
  }
  return null;
}

function isMemo(m) {
  return (
    m &&
    typeof m.id === 'string' &&
    Number.isInteger(m.page) &&
    m.page >= 0 &&
    Array.isArray(m.members) &&
    m.members.length > 0 &&
    m.members.every((i) => Number.isInteger(i) && i >= 0) &&
    typeof m.anchor === 'string' &&
    typeof m.text === 'string'
  );
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createMemos(ctx) {
  const { docKey, apiBase, host, signal, isActive, pageState, rectsOf, sourcePageDiv, translatedPageDiv, setLayerGeometry, scaled, reveal, relayout, notify } = ctx;
  const root = document.documentElement;
  const memos = new Map(); // id -> memo
  let loaded = false; // nothing is saved before the stored memos are read, so a failed read cannot wipe them
  let loadFailed = false;
  let dirty = false;
  let saveTimer;
  let saveFailed = false;
  let editing; // id
  let active; // id
  let hidden = false; // the reader closed the sidebar; a click on a sentence opens it again
  const expanded = new Set();

  const sidebar = el('aside', 'sunlight-memo-sidebar');
  sidebar.setAttribute('aria-label', '메모');
  const tab = el('button', 'sunlight-memo-tab');
  tab.type = 'button';
  host.parentElement.append(sidebar, tab);

  const ordered = () => [...memos.values()].sort((a, b) => a.page - b.page || a.members[0] - b.members[0] || a.createdAt - b.createdAt);
  const saved = () => ordered().filter((m) => m.text.trim() !== '');
  const formatDate = (t) => new Date(t).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });

  // ---------- storage ----------
  async function load() {
    await pendingSaves.get(docKey)?.catch(() => {});
    try {
      const res = await fetch(`${apiBase}/memos/${encodeURIComponent(docKey)}`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      (Array.isArray(data?.memos) ? data.memos : []).filter(isMemo).forEach((m) => {
        if (memos.has(m.id)) return; // typed before the read finished
        memos.set(m.id, { ...m, text: m.text.slice(0, MAX_LENGTH), color: COLORS.includes(m.color) ? m.color : COLORS[0], createdAt: Number(m.createdAt) || Date.now() });
      });
      loaded = true;
      if (dirty) scheduleSave(0);
      refresh();
    } catch (err) {
      if (signal.aborted) return;
      console.error('Memos could not be read', err);
      loadFailed = true;
      notify('저장된 메모를 불러오지 못했어요. 메모를 덮어쓰지 않도록 이번에는 저장하지 않습니다. 문서를 다시 열어주세요.');
    }
  }

  function save({ keepalive = false } = {}) {
    clearTimeout(saveTimer);
    if (!loaded || !dirty) return Promise.resolve();
    dirty = false;
    const body = JSON.stringify({
      version: 1,
      memos: saved().map(({ id, page, members, anchor, text, color, createdAt, updatedAt }) => ({ id, page, members, anchor, text, color, createdAt, updatedAt })),
    });
    const request = fetch(`${apiBase}/memos/${encodeURIComponent(docKey)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.text().catch(() => '')) || String(res.status));
        saveFailed = false;
      })
      .catch((err) => {
        dirty = true;
        if (!saveFailed) notify(/[가-힣]/.test(err.message) ? err.message : '메모를 저장하지 못했어요. 잠시 후 자동으로 다시 저장합니다.');
        saveFailed = true;
        if (!signal.aborted) scheduleSave(RETRY_DELAY_MS);
      })
      .finally(() => pendingSaves.get(docKey) === request && pendingSaves.delete(docKey));
    pendingSaves.set(docKey, request);
    return request;
  }

  function scheduleSave(delay = SAVE_DELAY_MS) {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, delay);
  }

  // ---------- highlights on the pages ----------
  function anchorOf(memo) {
    const state = pageState(memo.page);
    if (!state) return { state: undefined, members: undefined }; // page not read yet
    return { state, members: resolveAnchor(memo, state.sentences.map((s) => s.text)) };
  }

  function paint(pageIndex) {
    const sourceDiv = sourcePageDiv(pageIndex);
    const translatedDiv = translatedPageDiv(pageIndex);
    sourceDiv?.querySelector(`.${MARK_LAYER}`)?.remove();
    translatedDiv?.querySelectorAll('[data-memo-id]').forEach((span) => {
      span.classList.remove('sunlight-memo-mark', 'active', ...COLORS);
      delete span.dataset.memoId;
    });
    const state = pageState(pageIndex);
    if (!state || !isActive()) return;
    const here = ordered().filter((m) => m.page === pageIndex);
    if (here.length === 0) return;
    here.forEach(noteOrphan);
    const layer = el('div', MARK_LAYER);
    setLayerGeometry(layer, state);
    const spans = [...(translatedDiv?.querySelectorAll(SENTENCE_SELECTOR) ?? [])];
    for (const memo of here) {
      const members = resolveAnchor(memo, state.sentences.map((s) => s.text));
      if (!members) continue;
      const classes = ['sunlight-memo-mark', memo.color, ...(memo.id === active ? ['active'] : [])];
      members
        .flatMap((i) => rectsOf(state, i))
        .forEach((r) => {
          const mark = el('div', classes.join(' '));
          mark.dataset.memoId = memo.id;
          Object.assign(mark.style, { left: scaled(r.left), top: scaled(r.top), width: scaled(r.width), height: scaled(r.height) });
          layer.append(mark);
        });
      spans
        .filter((span) => (span.dataset.members ?? '').split(',').some((i) => members.includes(Number(i))))
        .forEach((span) => {
          span.classList.add(...classes);
          span.dataset.memoId = memo.id;
        });
    }
    sourceDiv?.append(layer);
  }

  const repaintAll = () => new Set([...memos.values()].map((m) => m.page)).forEach(paint);

  // ---------- sidebar ----------
  function applyVisibility() {
    const count = memos.size;
    const open = isActive() && count > 0 && !hidden;
    const changed = root.classList.contains(OPEN_CLASS) !== open;
    root.classList.toggle(OPEN_CLASS, open);
    sidebar.style.top = tab.style.top = `${host.offsetTop}px`;
    tab.hidden = !(isActive() && count > 0 && hidden);
    tab.textContent = `메모 ${saved().length}`;
    if (changed) relayout(); // the panes got narrower or wider: refit the pages
  }

  const orphanNote = () => el('p', 'sunlight-memo-orphan', '원문에서 이 문장을 찾지 못했어요. 메모 내용은 그대로 보관됩니다.');

  // Pages are read one by one; a card drawn before its page was read learns here whether its sentence exists.
  function noteOrphan(memo) {
    const card = [...sidebar.querySelectorAll('.sunlight-memo-card')].find((c) => c.dataset.id === memo.id);
    if (!card) return;
    const { state, members } = anchorOf(memo);
    const note = card.querySelector('.sunlight-memo-orphan');
    if (state && !members && !note) card.querySelector('blockquote').after(orphanNote());
    else if (members && note) note.remove();
  }

  function bodyOf(memo) {
    if (memo.id === editing) {
      const area = el('textarea', 'sunlight-memo-input');
      area.maxLength = MAX_LENGTH;
      area.placeholder = '메모를 입력하세요';
      area.value = memo.text;
      area.rows = 2;
      return area;
    }
    const body = el('div', `sunlight-memo-text${expanded.has(memo.id) ? ' expanded' : ''}`);
    linkify(memo.text).forEach((part) => {
      if (!part.href) return void body.append(part.text);
      const a = el('a', '', part.text);
      a.href = part.href; // opened in the default browser by the app's link handler
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.title = part.href;
      body.append(a);
    });
    return body;
  }

  function footerOf(memo) {
    const footer = el('footer');
    footer.hidden = memo.text.trim() === '';
    COLORS.forEach((color) => {
      const chip = el('button', `sunlight-memo-chip ${color}`);
      chip.type = 'button';
      chip.dataset.color = color;
      chip.title = `${COLOR_LABEL[color]} 형광펜`;
      chip.setAttribute('aria-label', chip.title);
      chip.setAttribute('aria-pressed', String(memo.color === color));
      footer.append(chip);
    });
    const count = el('span', 'sunlight-memo-count');
    count.hidden = memo.text.length < COUNTER_FROM;
    count.textContent = `${memo.text.length}/${MAX_LENGTH}`;
    footer.append(count);
    return footer;
  }

  function renderSidebar() {
    const list = ordered();
    const head = el('header', 'sunlight-memo-head');
    head.append(el('strong', '', `메모 ${saved().length}`));
    const close = el('button', 'sunlight-memo-close', '숨기기');
    close.type = 'button';
    head.append(close);
    const cards = list.map((memo, index) => {
      const card = el('article', `sunlight-memo-card ${memo.color}${memo.id === active ? ' active' : ''}`);
      card.dataset.id = memo.id;
      const top = el('header');
      const { state, members } = anchorOf(memo);
      top.append(el('span', 'sunlight-memo-num', `메모 ${index + 1}`), el('span', 'sunlight-memo-meta', `${memo.page + 1}쪽 · ${formatDate(memo.updatedAt ?? memo.createdAt)}`));
      const remove = el('button', 'sunlight-memo-delete', '✕');
      remove.type = 'button';
      remove.title = '메모 지우기';
      remove.setAttribute('aria-label', remove.title);
      top.append(remove);
      const quote = el('blockquote', '', memo.anchor);
      quote.title = '원문 위치로 이동';
      card.append(top, quote);
      if (state && !members) card.append(orphanNote());
      card.append(bodyOf(memo), footerOf(memo));
      return card;
    });
    sidebar.replaceChildren(head, ...cards);
    cards.forEach((card) => {
      const text = card.querySelector('.sunlight-memo-text:not(.expanded)');
      if (text && text.scrollHeight > text.clientHeight + 2) {
        const more = el('button', 'sunlight-memo-more', '더 보기');
        more.type = 'button';
        text.after(more);
      }
    });
    const area = sidebar.querySelector('.sunlight-memo-input');
    if (area) {
      grow(area);
      area.focus({ preventScroll: true });
      area.setSelectionRange(area.value.length, area.value.length);
      area.closest('.sunlight-memo-card').scrollIntoView({ block: 'nearest' });
    }
  }

  function grow(area) {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`; // capped by max-height in CSS, then it scrolls
  }

  function refresh() {
    applyVisibility();
    renderSidebar();
    repaintAll();
  }

  function setActive(id) {
    if (active === id) return;
    const pagesToPaint = new Set([memos.get(active)?.page, memos.get(id)?.page].filter((p) => p !== undefined));
    active = id;
    sidebar.querySelectorAll('.sunlight-memo-card').forEach((card) => card.classList.toggle('active', card.dataset.id === id));
    pagesToPaint.forEach(paint);
  }

  // ---------- editing ----------
  function finishEditing() {
    const memo = memos.get(editing);
    editing = undefined;
    if (!memo) return;
    memo.text = memo.text.trim().slice(0, MAX_LENGTH);
    if (memo.text === '') {
      // A memo with nothing in it is not kept (and a saved one that was emptied is removed).
      memos.delete(memo.id);
      if (active === memo.id) active = undefined;
      paint(memo.page);
      dirty = true;
    }
    if (dirty) save();
  }

  function edit(id) {
    if (editing === id) return void sidebar.querySelector('.sunlight-memo-input')?.focus();
    finishEditing();
    editing = id;
    active = id;
    hidden = false;
    refresh();
  }

  function open(pageIndex, members) {
    const state = pageState(pageIndex);
    if (!state) return;
    if (loadFailed) return void notify('저장된 메모를 읽지 못해 새 메모를 만들 수 없어요. 문서를 다시 열어주세요.');
    const existing = ordered().find((m) => m.page === pageIndex && resolveAnchor(m, state.sentences.map((s) => s.text))?.some((i) => members.includes(i)));
    if (existing) return void edit(existing.id);
    const anchor = members.map((i) => state.sentences[i]?.text ?? '').join(' ');
    if (anchor.trim() === '') return;
    const now = Date.now();
    const memo = { id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`, page: pageIndex, members: [...members], anchor, text: '', color: COLORS[0], createdAt: now, updatedAt: now };
    memos.set(memo.id, memo);
    edit(memo.id);
  }

  function remove(id) {
    const memo = memos.get(id);
    if (!memo) return;
    if (editing === id) editing = undefined;
    if (active === id) active = undefined;
    memos.delete(id);
    paint(memo.page);
    refresh();
    if (memo.text.trim() === '') return;
    scheduleSave(0);
    notify('메모를 지웠어요.', {
      label: '되돌리기',
      run: () => {
        if (signal.aborted || memos.has(id)) return;
        memos.set(id, memo);
        scheduleSave(0);
        refresh();
      },
    });
  }

  const cardId = (target) => target.closest?.('.sunlight-memo-card')?.dataset.id;

  sidebar.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element) || target.closest('a')) return;
      if (target.closest('.sunlight-memo-close')) {
        finishEditing();
        hidden = true;
        return void refresh();
      }
      const id = cardId(target);
      const memo = memos.get(id);
      if (!memo) return;
      if (target.closest('.sunlight-memo-delete')) return void remove(id);
      const chip = target.closest('.sunlight-memo-chip');
      if (chip) {
        memo.color = chip.dataset.color;
        memo.updatedAt = Date.now();
        scheduleSave();
        const card = chip.closest('.sunlight-memo-card');
        card.classList.remove(...COLORS);
        card.classList.add(memo.color);
        card.querySelectorAll('.sunlight-memo-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        return void paint(memo.page);
      }
      if (target.closest('.sunlight-memo-more')) {
        expanded.add(id);
        return void renderSidebar();
      }
      if (target.closest('.sunlight-memo-text')) return void edit(id);
      if (target.closest('.sunlight-memo-input, footer')) return;
      setActive(id);
      const { state, members } = anchorOf(memo);
      if (state && members) reveal(memo.page, rectsOf(state, members[0])[0]);
      else if (!state) reveal(memo.page);
    },
    { signal },
  );
  sidebar.addEventListener('mouseover', (e) => e.target instanceof Element && cardId(e.target) && setActive(cardId(e.target)), { signal });
  sidebar.addEventListener(
    'input',
    (e) => {
      const area = e.target;
      const memo = memos.get(cardId(area));
      if (!memo || !(area instanceof HTMLTextAreaElement)) return;
      if (area.value.length > MAX_LENGTH) area.value = area.value.slice(0, MAX_LENGTH); // IME composition can pass maxlength
      memo.text = area.value;
      memo.updatedAt = Date.now();
      grow(area);
      const card = area.closest('.sunlight-memo-card');
      card.querySelector('footer').hidden = memo.text.trim() === '';
      const count = card.querySelector('.sunlight-memo-count');
      count.hidden = memo.text.length < COUNTER_FROM;
      count.textContent = `${memo.text.length}/${MAX_LENGTH}`;
      count.classList.toggle('full', memo.text.length >= MAX_LENGTH);
      scheduleSave();
    },
    { signal },
  );
  sidebar.addEventListener(
    'focusout',
    (e) => {
      if (!(e.target instanceof HTMLTextAreaElement) || cardId(e.target) !== editing) return;
      // Colour chips and the delete button of the same card keep the memo open.
      if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.sunlight-memo-card')?.dataset.id === editing) return;
      finishEditing();
      refresh();
    },
    { signal },
  );
  sidebar.addEventListener(
    'keydown',
    (e) => {
      if (!(e.target instanceof HTMLTextAreaElement) || e.isComposing) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        e.target.blur();
      }
    },
    { signal },
  );
  // Pinch over the sidebar must not zoom the whole window: memo text keeps its size at any PDF zoom.
  sidebar.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false, signal });
  ['gesturestart', 'gesturechange'].forEach((type) => sidebar.addEventListener(type, (e) => e.preventDefault(), { signal }));
  tab.addEventListener(
    'click',
    () => {
      hidden = false;
      refresh();
    },
    { signal },
  );
  window.addEventListener('pagehide', () => save({ keepalive: true }), { signal });
  signal.addEventListener('abort', () => {
    finishEditing();
    save();
    clearTimeout(saveTimer);
    root.classList.remove(OPEN_CLASS);
    sidebar.remove();
    tab.remove();
  });

  load();

  return {
    open,
    paint,
    // The translation view was switched on or off.
    sync: refresh,
  };
}
