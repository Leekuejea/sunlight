import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import 'katex/dist/katex.min.css';
import './layout/layout.css';
import './app.css';
import { openReader, paperPages, renderThumbnail } from './reader.js';
import { knownTopics, layoutGraph, paperText } from './graph/paperGraph.js';
import { createGraphView } from './graph/graphView.js';
import { L10N } from './layout/layoutTranslation.js';

// Set on <html> by the app's server in the iOS and Android builds: no Ollama, no in-app update, no folder to reveal.
const MOBILE = document.documentElement.classList.contains('mobile');
const LANGUAGES = { ko: '한국어', en: 'English' };
// Picked by measurement on a 16GB M2 Pro (see README): speed and Korean quality together.
const RECOMMENDED_LOCAL = [
  { name: 'gemma4:e4b', size: '9.5 GB', note: '추천 · 쪽당 약 45초' },
  { name: 'gemma4:12b', size: '7.7 GB', note: '정확도 우선 · 쪽당 약 90초' },
];
const PROVIDERS = [
  { id: 'local', name: '로컬 LLM', sub: 'Ollama · 이 Mac에서 실행' },
  { id: 'exaone', name: 'EXAONE', sub: 'LG AI연구원 K-EXAONE', keyed: true, keyUrl: 'https://docs.exaone.ai/ko/docs/authentication' },
  { id: 'openai', name: 'GPT', sub: 'OpenAI', keyed: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Claude', sub: 'Anthropic', keyed: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Gemini', sub: 'Google AI Studio', keyed: true, keyUrl: 'https://aistudio.google.com/apikey' },
].filter((p) => p.keyed || !MOBILE);

// Errors carry the server's message (JSON `error` or plain text); App shows any that go unhandled as a toast.
async function api(path, init) {
  const r = await fetch(`/api${path}`, init);
  if (r.status === 204) return null;
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!r.ok) throw Object.assign(new Error(body?.error || text || `요청에 실패했어요 (${r.status})`), { toast: true });
  return body;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const formatDate = (t) => (t ? new Date(t).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
const IS_MAC = /Mac/.test(navigator.platform);
const PREFS_KEY = 'sunlightPrefs';
function loadPrefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {}
  return { appearance: p.appearance ?? 'system', comfort: p.comfort ?? false, language: LANGUAGES[p.language] ? p.language : 'ko' };
}
function engineLabel(s) {
  if (!s) return '';
  if (s.provider === 'local') return `로컬 · ${s.local.model || '모델 미선택'}`;
  return `${PROVIDERS.find((p) => p.id === s.provider)?.name} · ${s.models[s.provider] || ''}`;
}

// window.confirm shows nothing in the Tauri webview and returns false, so confirmations are drawn by the app.
let openConfirm;
const askConfirm = (text) => new Promise((resolve) => openConfirm({ text, resolve }));
function ConfirmHost() {
  const [req, setReq] = useState(null);
  useEffect(() => {
    openConfirm = (next) =>
      setReq((prev) => {
        prev?.resolve(false);
        return next;
      });
  }, []);
  useEffect(() => {
    if (!req) return;
    // Capture phase: Escape answers this dialog only, not the settings modal underneath.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      done(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req]);
  if (!req) return null;
  function done(v) {
    req.resolve(v);
    setReq(null);
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="modal confirm" role="alertdialog" aria-modal="true">
        <p className="body">{req.text}</p>
        <div className="cta-row">
          <button className="pill secondary small" onClick={() => done(false)}>
            취소
          </button>
          <button className="pill primary small" autoFocus onClick={() => done(true)}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

// Downloads and installs the new version, then the app restarts itself. onStatus gets readable progress text.
// With `prefetch` it only downloads; the app installs it when it quits, and the last status is { ready, version }.
async function installUpdate(onStatus, { prefetch = false } = {}) {
  try {
    const res = await fetch(prefetch ? '/api/update/prefetch' : '/api/update/install', { method: 'POST' });
    const ndjson = (res.headers.get('content-type') ?? '').includes('ndjson');
    if (!ndjson) return onStatus({ error: (await res.json().catch(() => ({})))?.error ?? '업데이트를 시작하지 못했어요.' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.error) return onStatus({ error: m.error });
        if (m.ready || m.none) return onStatus(m);
        onStatus({ text: m.pct != null ? `${m.status} ${m.pct}%` : m.status, done: m.done });
      }
    }
  } catch {
    // The connection drops when the app restarts into the new version (or the Windows installer closes it).
    if (!prefetch) onStatus({ text: '다시 시작하는 중', done: true });
  }
}

function UpdateRow() {
  const [state, setState] = useState(null); // { checking } | check result | { installing, text } | { error }
  const check = () => {
    setState({ checking: true });
    api('/update').then(setState, (err) => setState({ ok: false, error: err.message }));
  };
  const install = () => {
    setState({ installing: true, text: '시작하는 중' });
    installUpdate((s) => setState(s.error ? { ok: false, error: s.error } : { installing: true, text: s.text }));
  };
  if (state?.installing) return <span className="caption muted">업데이트 · {state.text}</span>;
  return (
    <>
      {state?.ok && state.available && (
        <button className="pill primary small" onClick={install}>
          {state.ready ? `다시 시작해서 ${state.version} 적용` : `${state.version}으로 업데이트`}
        </button>
      )}
      {state?.ok && !state.available && <span className="caption muted">최신 버전이에요.</span>}
      {state?.ok === false && <span className="caption error">{state.error}</span>}
      {!state?.available && (
        <button className="text-link caption" onClick={check} disabled={state?.checking}>
          {state?.checking ? '확인 중…' : '업데이트 확인'}
        </button>
      )}
    </>
  );
}

function SunMark({ size = 18 }) {
  return (
    <svg className="sun-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.6" fill="currentColor" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <rect key={a} x="11.1" y="1.2" width="1.8" height="4" rx="0.9" fill="currentColor" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

function GlobalNav({ page, onNavigate, onSettings }) {
  const links = [
    ['graph', '그래프'],
    ['library', '라이브러리'],
    ['translations', '번역본'],
  ];
  return (
    <nav className="global-nav" data-tauri-drag-region>
      <button className="wordmark" onClick={() => onNavigate('library')}>
        <SunMark size={15} /> Sunlight
      </button>
      <div className="global-links">
        {links.map(([id, label]) => (
          <button key={id} className={page === id ? 'current' : ''} onClick={() => onNavigate(id)}>
            {label}
          </button>
        ))}
        <button onClick={onSettings}>설정</button>
      </div>
    </nav>
  );
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast || toast.sticky) return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.action && (
        <button className="text-link" onClick={toast.action.run}>
          {toast.action.label}
        </button>
      )}
      {toast.sticky && toast.action && (
        <button className="text-link muted" onClick={onClose} aria-label="닫기">
          나중에
        </button>
      )}
    </div>
  );
}

// First-page preview: rendered once, then served from the app's cache folder.
function Thumbnail({ doc }) {
  const [src, setSrc] = useState(`/api/thumbs/${doc.id}`);
  const render = async () => {
    try {
      const blob = await renderThumbnail(`/files/${doc.id}.pdf`);
      setSrc(URL.createObjectURL(blob));
      fetch(`/api/thumbs/${doc.id}`, { method: 'PUT', body: blob });
    } catch {
      setSrc('');
    }
  };
  return <div className="thumb">{src ? <img src={src} alt="" onError={src.startsWith('/api/') ? render : undefined} /> : <div className="thumb-blank" />}</div>;
}

function Library({ onOpen, onNavigate }) {
  const [docs, setDocs] = useState([]);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [storage, setStorage] = useState(null);
  const fileInput = useRef(null);
  const reload = () => Promise.all([api('/library'), api('/storage'), api('/exports')]).then(([d, st, e]) => (setDocs(d), setStorage({ ...st, files: e.files.length })));
  useEffect(() => void reload(), []);

  async function upload(files) {
    setError('');
    let last;
    const failed = [];
    for (const f of files) {
      try {
        const res = await fetch('/api/library', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
        if (res.ok) last = await res.json();
        else failed.push(res.status === 400 ? `${f.name}: PDF 파일만 올릴 수 있어요.` : `${f.name}: 저장하지 못했어요. 디스크 공간을 확인해주세요.`);
      } catch {
        failed.push(`${f.name}: 올리지 못했어요. 앱을 다시 시작해보세요.`);
      }
    }
    setError(failed.join(' '));
    await reload();
    if (files.length === 1 && last) onOpen(last);
  }

  const remove = async (doc) => {
    if (!(await askConfirm(`“${doc.title}”을 라이브러리에서 지울까요?`))) return;
    setDocs((ds) => ds.filter((d) => d.id !== doc.id));
    await api(`/library/${doc.id}`, { method: 'DELETE' }).finally(reload);
  };
  const shown = docs.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <main
      className={`page ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setDragging(true))}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload([...e.dataTransfer.files]);
      }}
    >
      <section className="tile tile-light hero">
        <h1 className="hero-display">Sunlight</h1>
        <p className="lead">논문을 레이아웃 그대로, 읽는 언어로.</p>
        <div className="cta-row">
          <button className="pill primary" onClick={() => fileInput.current.click()}>
            PDF 업로드
          </button>
          <button className="pill secondary" onClick={() => onNavigate('translations')}>
            번역본 보기
          </button>
        </div>
        <input ref={fileInput} type="file" accept="application/pdf" multiple hidden onChange={(e) => upload([...e.target.files])} />
        {error && <p className="caption error">{error}</p>}
      </section>

      <section className="tile tile-parchment">
        <div className="section-head">
          <h2 className="display-md">최근 열어본 논문</h2>
          <input className="search-input" placeholder="라이브러리 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {docs.length === 0 ? (
          <p className="body muted center">{MOBILE ? '“PDF 업로드”를 눌러 시작하세요.' : 'PDF를 이 창에 끌어다 놓거나 “PDF 업로드”를 눌러 시작하세요.'}</p>
        ) : shown.length === 0 ? (
          <p className="body muted center">“{query}”에 맞는 논문이 없어요.</p>
        ) : (
          <div className="card-grid">
            {shown.map((d) => (
              <article key={d.id} className="utility-card" onClick={() => onOpen(d)}>
                <Thumbnail doc={d} />
                <h3 className="body-strong clamp">{d.title}</h3>
                <p className="caption muted">{formatDate(d.lastOpenedAt ?? d.addedAt)}</p>
                <button
                  className="text-link caption"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(d);
                  }}
                >
                  라이브러리에서 삭제
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="tile tile-dark center">
        <p className="tagline muted-dark">번역본 저장 공간</p>
        <h2 className="display-lg">{storage ? formatBytes(storage.exportsBytes) : '—'}</h2>
        <p className="body muted-dark">{storage ? `번역본 ${storage.files ?? 0}개${MOBILE ? '' : ' · 문서/Sunlight/Translations'}` : ''}</p>
        <div className="cta-row">
          <button className="pill primary" onClick={() => onNavigate('translations')}>
            번역본 관리
          </button>
        </div>
      </section>
    </main>
  );
}

// Paper graph: every library paper and its topics, grouped into communities (see src/graph/paperGraph.js).
// Analysing a paper costs a model call, so it only runs when the reader asks; results are cached per paper.
function Graph({ onOpen, setToast, language, engine, openSettings }) {
  const [data, setData] = useState(null);
  const [run, setRun] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState(() => new Set());
  const canvas = useRef(null);
  const view = useRef(null);
  const stop = useRef(null);
  const load = () =>
    api('/graph')
      .then(setData)
      .catch((e) => setToast({ text: e.message }));
  useEffect(() => {
    load();
    return () => stop.current?.abort();
  }, []);

  const graph = useMemo(() => (data ? layoutGraph(data.docs, data.papers) : null), [data]);
  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const missing = data ? data.docs.filter((d) => !data.papers[d.id]) : [];
  useEffect(() => {
    setHidden(new Set());
    setSelected((id) => (byId.has(id) ? id : null));
    if (!graph?.nodes.length) return;
    let live = true;
    let made;
    createGraphView(canvas.current, graph, {
      onSelect: setSelected,
      onOpen: (id) => {
        const doc = data.docs.find((d) => d.id === id);
        if (doc) onOpen(doc);
      },
    })
      .then((v) => {
        made = v;
        if (live) view.current = v;
        else v.destroy();
      })
      .catch(() => setToast({ text: '그래프를 그리지 못했어요. 앱을 다시 시작해보세요.' }));
    return () => {
      live = false;
      made?.destroy();
      view.current = null;
    };
  }, [graph]);

  async function analyse(docs, papersSoFar = data.papers) {
    const ctrl = new AbortController();
    stop.current = ctrl;
    const done = { ...papersSoFar };
    const failed = [];
    let streak = 0;
    for (const [i, doc] of docs.entries()) {
      setRun({ done: i, total: docs.length, title: doc.title });
      try {
        let text;
        try {
          const { pages, numPages } = await paperPages(`/files/${doc.id}.pdf`);
          text = paperText(pages, numPages);
        } catch {
          throw new Error('PDF를 읽지 못했어요.');
        }
        const res = await api(`/graph/${doc.id}`, { ...json('POST', { ...text, target: language, known: knownTopics(done) }), signal: ctrl.signal });
        if (!res?.ok) throw new Error(res?.error || '주제를 찾지 못했어요.');
        streak = 0;
        done[doc.id] = res.paper;
        setData((d) => ({ ...d, papers: { ...d.papers, [doc.id]: res.paper } }));
      } catch (e) {
        if (ctrl.signal.aborted) break;
        failed.push({ title: doc.title, error: e.message });
        // Two failures in a row are almost always the engine (no key, Ollama off), not the papers.
        if (++streak >= 2 && i < docs.length - 1) {
          failed.push(...docs.slice(i + 1).map((d) => ({ title: d.title, skipped: true })));
          break;
        }
      }
    }
    if (stop.current === ctrl) stop.current = null;
    setRun(null);
    if (ctrl.signal.aborted || !failed.length) return;
    const first = failed.find((f) => f.error);
    setToast({
      text: failed.length === 1 ? `“${first.title}”의 주제를 찾지 못했어요. ${first.error}` : `논문 ${failed.length}편을 분석하지 못했어요. ${first.error}`,
      action: { label: '설정 열기', run: openSettings },
    });
  }

  const restart = async () => {
    if (!(await askConfirm('모든 논문의 주제를 처음부터 다시 찾을까요? 지금 엔진으로 논문마다 한 번씩 요청해요.'))) return;
    await api('/graph', { method: 'DELETE' });
    const fresh = await api('/graph');
    setData(fresh);
    analyse(fresh.docs, {});
  };
  const focus = (id) => {
    setSelected(id);
    view.current?.focus(id);
  };
  const toggle = (cid) =>
    setHidden((h) => {
      const next = new Set(h);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      view.current?.setHidden(next);
      return next;
    });
  const toggleAll = () => {
    const next = hidden.size ? new Set() : new Set(graph.communities.map((c) => c.cid));
    view.current?.setHidden(next);
    setHidden(next);
  };

  const node = byId.get(selected);
  const linked = (kind) => (node ? graph.edges.filter((e) => (e.from === node.id || e.to === node.id) && (kind === 'topic' ? e.relation === 'covers' : e.relation === 'cites')) : []);
  const matches = query.trim() ? (graph?.nodes ?? []).filter((n) => n.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20) : [];
  const papers = graph ? graph.nodes.filter((n) => n.kind === 'paper').length : 0;
  const community = node && graph.communities[node.community];

  return (
    <main className="page graph-page">
      <header className="sub-nav">
        <span className="tagline">그래프</span>
        <div className="sub-nav-actions">
          {run ? (
            <>
              <div className="progress-pill" title={run.title}>
                <span className="caption">
                  주제 찾는 중 {run.done}/{run.total}편
                </span>
                <progress max={run.total} value={run.done} />
              </div>
              <button className="pill secondary small" onClick={() => stop.current?.abort()}>
                중지
              </button>
            </>
          ) : (
            <>
              <button className="caption muted engine text-button" onClick={openSettings} title="분석에 쓰는 엔진 (설정에서 바꾸기)">
                {engine}
              </button>
              {papers > 0 && (
                <button className="pill secondary small" onClick={restart}>
                  다시 분석
                </button>
              )}
              {missing.length > 0 && (
                <button className="pill primary small" onClick={() => analyse(missing)}>
                  주제 찾기 · {missing.length}편
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {!data ? null : data.docs.length === 0 ? (
        <section className="tile tile-parchment center graph-empty">
          <p className="body muted">라이브러리에 논문을 추가하면, 주제와 인용으로 이어진 그래프가 여기에 그려져요.</p>
        </section>
      ) : papers === 0 ? (
        <section className="tile tile-parchment center graph-empty">
          <h2 className="display-md">논문 {data.docs.length}편을 주제로 엮어볼까요?</h2>
          <p className="body muted">“주제 찾기”를 누르면 지금 엔진({engine})이 논문마다 앞부분을 한 번 읽고 주제를 찾아요. 결과는 저장되어 다음부터는 바로 열려요.</p>
        </section>
      ) : (
        <div className="graph-body">
          <div className="graph-canvas" ref={canvas} />
          <aside className="graph-sidebar">
            <div className="graph-search">
              <input className="search-input" placeholder="그래프에서 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
              {matches.length > 0 && (
                <div className="graph-results">
                  {matches.map((n) => (
                    <button key={n.id} style={{ borderLeftColor: n.color }} onClick={() => (focus(n.id), setQuery(''))}>
                      {n.kind === 'paper' ? '▪ ' : ''}
                      {n.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <section className="graph-info">
              {!node ? (
                <p className="caption muted">점(주제)이나 네모(논문)를 누르면 자세히 보여요. 논문을 두 번 누르면 바로 열려요.</p>
              ) : node.kind === 'paper' ? (
                <>
                  <h3 className="body-strong">{node.label}</h3>
                  {node.fileTitle !== node.label && <p className="caption muted">{node.fileTitle}</p>}
                  {node.summary && <p className="caption">{node.summary}</p>}
                  <p className="caption muted">묶음 · {community?.label}</p>
                  <div className="graph-chips">
                    {linked('topic').map((e) => (
                      <button key={e.to} className="graph-chip" onClick={() => focus(e.to)}>
                        {byId.get(e.to)?.label}
                      </button>
                    ))}
                  </div>
                  {linked('cites').map((e) => {
                    const other = byId.get(e.from === node.id ? e.to : e.from);
                    return (
                      <button key={`${e.from}>${e.to}`} className="graph-link caption" onClick={() => focus(other.id)}>
                        {e.from === node.id ? '인용함 → ' : '인용됨 ← '}
                        {other.label}
                      </button>
                    );
                  })}
                  <button className="pill primary small" onClick={() => onOpen(data.docs.find((d) => d.id === node.docId))}>
                    논문 열기
                  </button>
                </>
              ) : (
                <>
                  <h3 className="body-strong">{node.label}</h3>
                  <p className="caption muted">
                    논문 {node.degree}편 · 묶음 · {community?.label}
                  </p>
                  {linked('topic').map((e) => (
                    <button key={e.from} className="graph-link caption" onClick={() => focus(e.from)}>
                      {byId.get(e.from)?.label}
                    </button>
                  ))}
                </>
              )}
            </section>
            <section className="graph-legend">
              <label className="caption muted">
                <input type="checkbox" checked={hidden.size === 0} ref={(el) => el && (el.indeterminate = hidden.size > 0 && hidden.size < graph.communities.length)} onChange={toggleAll} />
                묶음 {graph.communities.length}개
              </label>
              {graph.communities.map((c) => (
                <label key={c.cid} className={`caption ${hidden.has(c.cid) ? 'dimmed' : ''}`} title={c.label}>
                  <input type="checkbox" checked={!hidden.has(c.cid)} onChange={() => toggle(c.cid)} />
                  <span className="graph-dot" style={{ background: c.color }} />
                  <span className="graph-legend-label">{c.label}</span>
                  <span className="muted">{c.papers ? `${c.papers}편` : c.count}</span>
                </label>
              ))}
            </section>
            <p className="caption muted graph-stats">
              논문 {papers}편 · 주제 {graph.nodes.length - papers}개 · 인용 {graph.edges.filter((e) => e.relation === 'cites').length}개
              {missing.length > 0 && ` · 미분석 ${missing.length}편`}
            </p>
          </aside>
        </div>
      )}
    </main>
  );
}

function Translations({ setToast }) {
  const [data, setData] = useState({ files: [], dir: '' });
  const [storage, setStorage] = useState(null);
  const reload = () => Promise.all([api('/exports').then(setData), api('/storage').then(setStorage)]);
  useEffect(() => void reload(), []);

  const remove = async (f) => {
    if (!(await askConfirm(`“${f.name}”을 삭제할까요? (${formatBytes(f.bytes)})`))) return;
    try {
      await api(`/exports/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      setToast({ text: `${formatBytes(f.bytes)}를 비웠어요.` });
    } catch {
      setToast({ text: `“${f.name}”을 삭제하지 못했어요. 이미 지워졌거나 다른 앱에서 열려 있어요.` });
    }
    reload();
  };
  const open = (f) =>
    api(`/exports/${encodeURIComponent(f.name)}/open`, { method: 'POST' }).catch(() => {
      setToast({ text: `“${f.name}”을 찾을 수 없어요. 폴더에서 옮기거나 지운 파일이에요.` });
      reload();
    });
  const removeAll = async () => {
    if (!data.files.length || !(await askConfirm(`번역본 ${data.files.length}개를 모두 삭제할까요? (${formatBytes(storage?.exportsBytes)})`))) return;
    let failed = 0;
    for (const f of data.files) await api(`/exports/${encodeURIComponent(f.name)}`, { method: 'DELETE' }).catch(() => failed++);
    setToast({ text: failed ? `번역본 ${failed}개는 삭제하지 못했어요. 다른 앱에서 열려 있는지 확인해주세요.` : '번역본을 모두 삭제했어요.' });
    reload();
  };
  const clearCache = async () => {
    if (!(await askConfirm('번역 캐시와 레이아웃 감지 결과를 비울까요? 다음에 열 때 다시 번역합니다.'))) return;
    await api('/cache', { method: 'DELETE' });
    setToast({ text: '번역 캐시를 비웠어요.' });
    reload();
  };

  return (
    <main className="page">
      <header className="sub-nav">
        <span className="tagline">번역본</span>
        <div className="sub-nav-actions">
          {!MOBILE && (
            <button className="text-link utility" onClick={() => api('/exports/reveal', { method: 'POST' })}>
              {IS_MAC ? 'Finder에서 열기' : '폴더 열기'}
            </button>
          )}
          <button className="pill secondary small" onClick={removeAll} disabled={!data.files.length}>
            모두 삭제
          </button>
        </div>
      </header>

      <section className="tile tile-light center">
        <h1 className="display-lg">{storage ? formatBytes(storage.exportsBytes) : '—'}</h1>
        <p className="lead">번역본이 사용하는 공간</p>
        <div className="usage">
          <div>
            <span className="caption muted">번역본 PDF</span>
            <strong className="body-strong">{formatBytes(storage?.exportsBytes)}</strong>
          </div>
          <div>
            <span className="caption muted">원본 라이브러리</span>
            <strong className="body-strong">{formatBytes(storage?.libraryBytes)}</strong>
          </div>
          <div>
            <span className="caption muted">번역 캐시</span>
            <strong className="body-strong">{formatBytes(storage?.cacheBytes)}</strong>
            <button className="text-link caption" onClick={clearCache}>
              비우기
            </button>
          </div>
        </div>
        <p className="caption muted">{data.dir}</p>
      </section>

      <section className="tile tile-parchment">
        {data.files.length === 0 ? (
          <p className="body muted center">아직 저장한 번역본이 없어요. 논문에서 “번역 PDF 저장”을 누르면 이 폴더에 모입니다.</p>
        ) : (
          <ul className="file-list">
            {data.files.map((f) => (
              <li key={f.name} className="utility-card row">
                <div className="file-meta">
                  <span className="body-strong clamp">{f.name}</span>
                  <span className="caption muted">
                    {formatBytes(f.bytes)} · {formatDate(f.modifiedAt)}
                  </span>
                </div>
                <button className="text-link" onClick={() => open(f)}>
                  열기
                </button>
                <button className="text-link" onClick={() => remove(f)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Chip({ selected, onClick, children, disabled }) {
  return (
    <button className={`option-chip ${selected ? 'selected' : ''}`} onClick={onClick} aria-pressed={selected} disabled={disabled}>
      {children}
    </button>
  );
}

function useAsync(fn, deps) {
  const [value, setValue] = useState(null);
  const reload = () => fn().then(setValue, (err) => setValue({ ok: false, error: err.message, models: [] }));
  useEffect(() => void reload(), deps);
  return [value, reload];
}

function GeneralTab({ prefs, setPrefs, version }) {
  return (
    <div className="settings-section">
      <h3 className="body-strong">화면 모드</h3>
      <div className="chip-row compact">
        {[
          ['system', '시스템 설정'],
          ['light', '라이트'],
          ['dark', '다크'],
        ].map(([v, l]) => (
          <Chip key={v} selected={prefs.appearance === v} onClick={() => setPrefs({ appearance: v })}>
            {l}
          </Chip>
        ))}
      </div>
      <h3 className="body-strong">보기 편한 모드</h3>
      <div className="chip-row compact">
        <Chip selected={prefs.comfort} onClick={() => setPrefs({ comfort: !prefs.comfort })}>
          <strong>{prefs.comfort ? '켜짐' : '꺼짐'}</strong>
          <span>PDF를 따뜻한 종이 색으로 바꾸고 화면 대비를 낮춰 오래 읽어도 눈이 덜 피로합니다.</span>
        </Chip>
      </div>
      <h3 className="body-strong">번역 언어</h3>
      <div className="chip-row compact">
        {Object.entries(LANGUAGES).map(([v, l]) => (
          <Chip key={v} selected={prefs.language === v} onClick={() => setPrefs({ language: v })}>
            {l}
          </Chip>
        ))}
      </div>
      <p className="caption muted">영어 논문은 한국어로, 한국어 논문은 영어로 번역합니다.</p>
      <h3 className="body-strong">버전</h3>
      <p className="caption muted inline">
        Sunlight {version ?? '—'} {!MOBILE && <UpdateRow />}
      </p>
    </div>
  );
}

function EngineTab({ settings, update, goKeys }) {
  const keyed = PROVIDERS.find((p) => p.id === settings.provider)?.keyed;
  const [models, reloadModels] = useAsync(() => (keyed ? api(`/models?provider=${settings.provider}`) : api('/local/models')), [settings.provider]);
  const [customModel, setCustomModel] = useState('');
  const [pull, setPull] = useState(null);
  const [test, setTest] = useState(null);

  async function download(model) {
    setPull({ model, status: '시작하는 중' });
    try {
      const res = await fetch('/api/local/pull', json('POST', { model }));
      if (!res.ok) return setPull({ model, status: 'Ollama에 연결하지 못했어요.', error: true });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        const lines = rest.split('\n');
        rest = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const m = JSON.parse(line);
          if (m.error) {
            const missing = /manifest|not found|does not exist/i.test(m.error);
            return setPull({ model, status: missing ? '이 이름의 모델을 찾을 수 없어요. ollama.com/library에서 정확한 이름을 확인해주세요.' : m.error, error: true });
          }
          setPull({ model, status: m.status, pct: m.total ? Math.round((100 * (m.completed ?? 0)) / m.total) : undefined });
        }
      }
    } catch {
      return setPull({ model, status: '내려받기가 중단됐어요. Ollama가 실행 중인지 확인하세요.', error: true });
    }
    setPull(null);
    await update({ localModel: model });
    reloadModels();
  }
  const installed = new Set(keyed ? [] : (models?.models ?? []).map((m) => m.name));

  return (
    <div className="settings-section">
      <h3 className="body-strong">번역 엔진</h3>
      <div className="chip-row">
        {PROVIDERS.map((p) => {
          const missingKey = p.keyed && !settings.keys[p.id]?.saved;
          return (
            <Chip key={p.id} selected={settings.provider === p.id} onClick={() => (missingKey ? goKeys() : update({ provider: p.id }))}>
              <strong>{p.name}</strong>
              <span>{missingKey ? 'API 키 필요' : p.sub}</span>
            </Chip>
          );
        })}
      </div>

      {keyed ? (
        <>
          <h3 className="body-strong">모델</h3>
          {!models ? (
            <p className="caption muted">모델 목록을 불러오는 중…</p>
          ) : models.ok ? (
            <select className="select-pill" value={settings.models[settings.provider]} onChange={(e) => update({ model: { provider: settings.provider, id: e.target.value } })}>
              {models.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <p className="caption error">{models.error}</p>
          )}
          <h3 className="body-strong">추론 강도</h3>
          <div className="chip-row compact">
            {[
              ['low', '낮음 · 빠름'],
              ['medium', '보통'],
              ['high', '높음 · 느림'],
            ].map(([v, l]) => (
              <Chip key={v} selected={settings.effort === v} onClick={() => update({ effort: v })}>
                {l}
              </Chip>
            ))}
          </div>
          <p className="caption muted">논문 번역에는 “낮음”이면 충분합니다. 추론 모델에서 속도와 비용을 크게 줄입니다.</p>
        </>
      ) : (
        <>
          <h3 className="body-strong">Ollama</h3>
          <p className={`caption ${models?.running === false ? 'error' : 'muted'}`}>
            {!models ? '확인 중…' : models.running ? `실행 중 · ${settings.local.baseUrl}` : 'Ollama가 실행 중이 아니에요. Ollama 앱을 켠 뒤 새로고침하세요. 아직 설치하지 않았다면 '}
            {models?.running === false && (
              <a className="text-link caption" href="https://ollama.com/download" target="_blank" rel="noreferrer">
                ollama.com/download
              </a>
            )}
            {models?.running === false && '에서 받을 수 있어요.'}
            {models?.running === false && (
              <button className="text-link caption" onClick={reloadModels}>
                {' '}
                새로고침
              </button>
            )}
          </p>
          <h3 className="body-strong">모델</h3>
          <div className="chip-row compact">
            {[...new Set([...RECOMMENDED_LOCAL.map((m) => m.name), ...installed])].map((name) => {
              const rec = RECOMMENDED_LOCAL.find((m) => m.name === name);
              const have = installed.has(name);
              return (
                <Chip key={name} selected={settings.local.model === name} disabled={!!pull && !pull.error} onClick={() => (have ? update({ localModel: name }) : download(name))}>
                  <strong>{name}</strong>
                  <span>{have ? `설치됨${rec ? ` · ${rec.note}` : ''}` : `내려받기 · ${rec?.size ?? ''}`}</span>
                </Chip>
              );
            })}
          </div>
          <div className="inline">
            <input className="search-input" placeholder="다른 Ollama 모델 이름 (예: qwen3:8b)" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
            <button
              className="pill secondary small"
              disabled={!customModel.trim() || (!!pull && !pull.error)}
              onClick={() => (installed.has(customModel.trim()) ? update({ localModel: customModel.trim() }) : download(customModel.trim()))}
            >
              {installed.has(customModel.trim()) ? '사용' : '내려받기'}
            </button>
          </div>
          {pull && (
            <div className="progress">
              <span className={`caption ${pull.error ? 'error' : 'muted'}`}>
                {pull.model} · {pull.status}
                {pull.pct !== undefined ? ` ${pull.pct}%` : ''}
              </span>
              {pull.pct !== undefined && <progress max="100" value={pull.pct} />}
            </div>
          )}
        </>
      )}

      <div className="test-row">
        <button
          className="pill secondary small"
          disabled={test?.running}
          onClick={async () => {
            setTest({ running: true });
            setTest(await api('/llm/test', { method: 'POST' }).catch((err) => ({ ok: false, error: `연결 테스트를 마치지 못했어요: ${err.message}` })));
          }}
        >
          {test?.running ? '번역해 보는 중…' : '연결 테스트'}
        </button>
        {test && !test.running && <span className={`caption ${test.ok ? '' : 'error'}`}>{test.ok ? `${test.text} (${(test.ms / 1000).toFixed(1)}초)` : test.error}</span>}
      </div>
    </div>
  );
}

function KeyRow({ provider, state, update }) {
  const [value, setValue] = useState('');
  const [check, setCheck] = useState(null);
  const verify = async () => {
    setCheck({ running: true });
    const r = await api(`/models?provider=${provider.id}`).catch((err) => ({ ok: false, error: `키를 확인하지 못했어요: ${err.message}` }));
    setCheck(r.ok ? { ok: true, text: `확인됨 · 사용 가능한 모델 ${r.models.length}개` } : { ok: false, text: r.error });
  };
  return (
    <li className="utility-card key-row">
      <div className="key-head">
        <div>
          <span className="body-strong">{provider.name}</span>
          <span className="caption muted"> · {provider.sub}</span>
        </div>
        <span className={`caption ${state?.saved ? '' : 'muted'}`}>{state?.saved ? `저장됨 ${state.hint}` : '없음'}</span>
      </div>
      <div className="inline">
        <input className="search-input" type="password" autoComplete="off" placeholder={state?.saved ? '새 키로 바꾸기' : 'API 키 붙여넣기'} value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          className="pill primary small"
          disabled={!value.trim()}
          onClick={async () => {
            try {
              await update({ key: { provider: provider.id, value: value.trim() } });
            } catch (err) {
              return setCheck({ ok: false, text: `키를 저장하지 못했어요: ${err.message}` });
            }
            setValue('');
            verify();
          }}
        >
          저장
        </button>
      </div>
      <div className="key-actions">
        {state?.saved && (
          <>
            <button className="text-link caption" onClick={verify} disabled={check?.running}>
              {check?.running ? '확인 중…' : '키 확인'}
            </button>
            <button className="text-link caption" onClick={async () => (await askConfirm(`${provider.name} API 키를 삭제할까요?`)) && update({ key: { provider: provider.id, value: '' } }).then(() => setCheck(null))}>
              삭제
            </button>
          </>
        )}
        <a className="text-link caption" href={provider.keyUrl} target="_blank" rel="noreferrer">
          키 발급 페이지
        </a>
        {check && !check.running && <span className={`caption ${check.ok ? '' : 'error'}`}>{check.text}</span>}
      </div>
    </li>
  );
}

function KeysTab({ settings, update }) {
  return (
    <div className="settings-section">
      <h3 className="body-strong">API 키</h3>
      <p className="caption muted">키는 {IS_MAC ? 'macOS 키체인' : 'Windows 자격 증명 관리자'}에 암호화해 이 컴퓨터에만 저장하며, 화면에는 끝 4자리만 표시합니다. 키를 저장하면 번역 엔진에서 해당 모델을 고를 수 있습니다.</p>
      <ul className="key-list">
        {PROVIDERS.filter((p) => p.keyed).map((p) => (
          <KeyRow key={p.id} provider={p} state={settings.keys[p.id]} update={update} />
        ))}
      </ul>
    </div>
  );
}

function SettingsModal({ tab, setTab, onClose, settings, setSettings, prefs, setPrefs }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!settings) return null;
  const update = (patch) => api('/settings', json('PUT', patch)).then(setSettings);
  const tabs = [
    ['general', '일반'],
    ['engine', '번역 엔진'],
    ['keys', 'API 키'],
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="설정">
        <aside className="modal-tabs">
          <h2 className="tagline">설정</h2>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? 'current' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </aside>
        <div className="modal-body">
          <button className="modal-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
          {tab === 'general' && <GeneralTab prefs={prefs} setPrefs={setPrefs} version={settings.version} />}
          {tab === 'engine' && <EngineTab settings={settings} update={update} goKeys={() => setTab('keys')} />}
          {tab === 'keys' && <KeysTab settings={settings} update={update} />}
        </div>
      </div>
    </div>
  );
}

function TranslationProgress({ progress }) {
  if (!progress) return null;
  const { done, failed, total } = progress;
  const finished = done + failed >= total;
  return (
    <div className="progress-pill" title={failed ? `${failed}쪽은 번역하지 못했어요` : undefined}>
      <span className="caption">
        {finished ? '번역 완료' : '번역 중'} {done}/{total}쪽{failed ? ` · 실패 ${failed}` : ''}
      </span>
      <progress max={total} value={done} />
    </div>
  );
}

function Reader({ doc, settings, language, setLanguage, setToast, openSettings, onClose }) {
  const mainRef = useRef(null);
  const viewerRef = useRef(null);
  const readerRef = useRef(null);
  const [state, setState] = useState({ page: 1, pages: 0, scale: 'auto', layoutActive: false, progress: null });
  const [pageInput, setPageInput] = useState('1');
  const [exporting, setExporting] = useState('');
  const pageRef = useRef(1);
  pageRef.current = state.page;
  // A new engine or model gets a fresh reader: in-flight requests to the old one are cancelled and every
  // page is translated again (each engine has its own cache), keeping the page being read.
  const engine = settings ? engineLabel(settings) : '';

  useEffect(() => {
    let cancelled = false;
    let reader;
    api(`/library/${doc.id}`, json('PATCH', { lastOpenedAt: Date.now() })).catch(() => {});
    // One notice per distinct cause (missing key, Ollama off, model not installed), not one per failed page.
    let lastFailure = '';
    const onTranslationFailure = (message) => {
      if (cancelled || !message || message === lastFailure || /^translation \d+$|stream ended early|Failed to fetch|Load failed/.test(message)) return;
      lastFailure = message;
      setToast({ text: message, action: { label: '설정 열기', run: openSettings } });
    };
    openReader({ mainContainer: mainRef.current, viewerContainer: viewerRef.current, doc, language, initialPage: pageRef.current, onState: setState, onTranslationFailure, onNotice: (text, action) => !cancelled && setToast({ text, action }) }).then(
      (r) => {
        if (cancelled) return r.destroy();
        reader = readerRef.current = r;
      },
      (err) => {
        if (cancelled) return;
        const reason =
          err?.name === 'PasswordException'
            ? '암호가 걸린 PDF는 열 수 없어요. 암호를 푼 파일을 올려주세요.'
            : err?.name === 'InvalidPDFException'
              ? '파일이 손상됐거나 PDF가 아니에요.'
              : err?.name === 'MissingPDFException' || err?.status === 404
                ? '원본 파일을 찾을 수 없어요. 라이브러리에서 삭제한 뒤 다시 올려주세요.'
                : `PDF를 열지 못했어요: ${err?.message ?? err}`;
        setToast({ text: reason });
        onClose();
      },
    );
    return () => {
      cancelled = true;
      if (readerRef.current === reader) readerRef.current = null;
      reader?.destroy();
    };
  }, [doc.id, language, engine]);

  useEffect(() => setPageInput(String(state.page)), [state.page]);

  async function exportPdf() {
    const r = readerRef.current;
    if (!r || exporting) return;
    const failedNow = state.progress?.failed ?? 0;
    if (failedNow && !(await askConfirm(`${failedNow}쪽은 번역하지 못했어요. 그래도 저장할까요? 번역하지 못한 쪽은 원문 그대로 저장됩니다.`))) return;
    try {
      const saved = await r.exportPdf(({ completed, total }) => setExporting(`${completed}/${total}`));
      const pages = saved.failedPageIndices.map((i) => i + 1);
      const failed = pages.length === 0 ? '' : pages.length > 5 ? ` · ${pages.length}쪽은 원문 그대로` : ` · ${pages.join(', ')}쪽은 원문 그대로`;
      setToast({ text: `번역본을 저장했어요 · ${formatBytes(saved.bytes)}${failed}`, action: { label: '열기', run: () => api(`/exports/${encodeURIComponent(saved.name)}/open`, { method: 'POST' }) } });
    } catch (err) {
      setToast({ text: err.message });
    } finally {
      setExporting('');
    }
  }

  const scaleOptions = { auto: '자동', 'page-fit': '페이지 맞춤', 'page-width': '너비 맞춤', 1: '100%', 1.5: '150%', 2: '200%' };
  return (
    <div className="reader">
      <header className="sub-nav reader-nav">
        <span className="tagline clamp" title={doc.title}>
          {doc.title}
        </span>
        <div className="sub-nav-actions">
          <div className="segmented" title={IS_MAC ? '확대/축소 · 트랙패드 핀치, ⌘+ / ⌘− / ⌘0' : '확대/축소 · Ctrl+휠, Ctrl + / Ctrl − / Ctrl 0'}>
            <button onClick={() => readerRef.current?.zoom(-1)} aria-label="축소">
              −
            </button>
            <select value={scaleOptions[state.scale] ? state.scale : ''} onChange={(e) => readerRef.current?.setScale(e.target.value)} aria-label="배율">
              {!scaleOptions[state.scale] && <option value="">{Math.round(Number(state.scale) * 100)}%</option>}
              {Object.entries(scaleOptions).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <button onClick={() => readerRef.current?.zoom(1)} aria-label="확대">
              +
            </button>
          </div>
          <form
            className="segmented page-box"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Math.round(Number(pageInput));
              if (n >= 1 && n <= state.pages) readerRef.current?.goToPage(n);
              else {
                setPageInput(String(state.page));
                setToast({ text: `1부터 ${state.pages} 사이의 쪽 번호를 입력해주세요.` });
              }
            }}
          >
            <input value={pageInput} onChange={(e) => setPageInput(e.target.value)} inputMode="numeric" aria-label="페이지" />
            <span>/ {state.pages}</span>
          </form>
          <div className="segmented">
            <select value={language} aria-label="번역 언어" onChange={(e) => setLanguage(e.target.value)}>
              {Object.entries(LANGUAGES).map(([v, l]) => (
                <option key={v} value={v}>
                  → {l}
                </option>
              ))}
            </select>
          </div>
          <button className="caption muted engine text-button" onClick={openSettings} title="번역 엔진 바꾸기">
            {engineLabel(settings)}
          </button>
          {state.layoutActive && <TranslationProgress progress={state.progress} />}
          {state.layoutActive && (
            <button className="pill secondary small" onClick={exportPdf} disabled={!!exporting}>
              {exporting ? `저장 중 ${exporting}` : '번역 PDF 저장'}
            </button>
          )}
          <button className={`pill small ${state.layoutActive ? 'secondary' : 'primary'}`} onClick={() => readerRef.current?.toggleLayout()}>
            {state.layoutActive ? L10N['back-to-original'] : L10N['button-text']}
          </button>
        </div>
      </header>
      <div id="mainContainer" ref={mainRef}>
        <div id="viewerContainer" ref={viewerRef} tabIndex={0}>
          <div className="pdfViewer" />
        </div>
      </div>
    </div>
  );
}

// Applies appearance (light/dark/system) and comfort mode to <html>.
function usePrefs() {
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPrefs = (patch) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = prefs.appearance === 'dark' || (prefs.appearance === 'system' && media.matches);
      document.documentElement.dataset.appearance = dark ? 'dark' : 'light';
      document.documentElement.classList.toggle('comfort', prefs.comfort);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [prefs.appearance, prefs.comfort]);
  return [prefs, setPrefs];
}

function App() {
  const [page, setPage] = useState('library');
  const [doc, setDoc] = useState(null);
  const [settings, setSettings] = useState(null);
  const [toast, setToast] = useState(null);
  const [settingsTab, setSettingsTab] = useState(null);
  const [prefs, setPrefs] = usePrefs();
  useEffect(() => void api('/settings').then(setSettings), []);
  // Once per launch, a few seconds in: download a newer version in the background. It installs when the app
  // quits; the toast only offers to restart sooner.
  useEffect(() => {
    if (MOBILE) return; // the App Store and Play Store update the app
    const t = setTimeout(
      () =>
        installUpdate(
          (s) =>
            s.ready &&
            setToast({
              text: `새 버전 ${s.version}을 받아뒀어요. 앱을 닫으면 적용돼요.`,
              action: {
                label: '지금 다시 시작',
                run: () => {
                  setToast({ text: '업데이트 · 설치하는 중', sticky: true });
                  installUpdate((s) => setToast(s.error ? { text: s.error } : { text: `업데이트 · ${s.text}`, sticky: true }));
                },
              },
              sticky: true,
            }),
          { prefetch: true },
        ),
      4000,
    );
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const onRejection = (e) => e.reason?.toast && setToast({ text: e.reason.message });
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);
  const navigate = (p) => {
    setDoc(null);
    setPage(p);
  };
  const openSettings = (tab = 'general') => {
    api('/settings').then(setSettings);
    setSettingsTab(tab);
  };
  return (
    <div className="app">
      <GlobalNav page={doc ? 'reader' : page} onNavigate={navigate} onSettings={() => openSettings()} />
      {doc ? (
        <Reader
          key={doc.id}
          doc={doc}
          settings={settings}
          language={prefs.language}
          setLanguage={(language) => setPrefs({ language })}
          setToast={setToast}
          openSettings={() => openSettings('engine')}
          onClose={() => setDoc(null)}
        />
      ) : page === 'translations' ? (
        <Translations setToast={setToast} />
      ) : page === 'graph' ? (
        <Graph onOpen={setDoc} setToast={setToast} language={prefs.language} engine={settings ? engineLabel(settings) : ''} openSettings={() => openSettings('engine')} />
      ) : (
        <Library onOpen={setDoc} onNavigate={navigate} />
      )}
      {settingsTab && (
        <SettingsModal tab={settingsTab} setTab={setSettingsTab} onClose={() => setSettingsTab(null)} settings={settings} setSettings={setSettings} prefs={prefs} setPrefs={setPrefs} />
      )}
      <ConfirmHost />
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

document.documentElement.classList.toggle('is-mac', /Mac/.test(navigator.platform));
// Links that leave the app (PDF link annotations, key pages) open in the default browser.
document.addEventListener(
  'click',
  (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || !/^https?:/.test(a.href) || a.origin === location.origin) return;
    e.preventDefault();
    fetch('/api/open-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: a.href }) });
  },
  true,
);

createRoot(document.getElementById('root')).render(<App />);
