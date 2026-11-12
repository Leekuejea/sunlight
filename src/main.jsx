import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import 'katex/dist/katex.min.css';
import './layout/layout.css';
import './app.css';
import { openReader, renderThumbnail } from './reader.js';
import { L10N } from './layout/layoutTranslation.js';

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
];

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
    if (!toast) return;
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
    for (const f of files) {
      const res = await fetch('/api/library', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      if (!res.ok) setError(`${f.name}: PDF 파일만 올릴 수 있어요.`);
      else last = await res.json();
    }
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
          <p className="body muted center">PDF를 이 창에 끌어다 놓거나 “PDF 업로드”를 눌러 시작하세요.</p>
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
        <p className="body muted-dark">{storage ? `번역본 ${storage.files ?? 0}개 · 문서/Sunlight/Translations` : ''}</p>
        <div className="cta-row">
          <button className="pill primary" onClick={() => onNavigate('translations')}>
            번역본 관리
          </button>
        </div>
      </section>
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
    await api(`/exports/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
    setToast({ text: `${formatBytes(f.bytes)}를 비웠어요.` });
    reload();
  };
  const removeAll = async () => {
    if (!data.files.length || !(await askConfirm(`번역본 ${data.files.length}개를 모두 삭제할까요? (${formatBytes(storage?.exportsBytes)})`))) return;
    for (const f of data.files) await api(`/exports/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
    setToast({ text: '번역본을 모두 삭제했어요.' });
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
          <button className="text-link utility" onClick={() => api('/exports/reveal', { method: 'POST' })}>
            Finder에서 열기
          </button>
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
                <button className="text-link" onClick={() => api(`/exports/${encodeURIComponent(f.name)}/open`, { method: 'POST' })}>
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
  const reload = () => fn().then(setValue);
  useEffect(() => void reload(), deps);
  return [value, reload];
}

function GeneralTab({ prefs, setPrefs }) {
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
          if (m.error) return setPull({ model, status: m.error, error: true });
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
            {!models ? '확인 중…' : models.running ? `실행 중 · ${settings.local.baseUrl}` : 'Ollama가 실행 중이 아니에요. Ollama 앱을 켠 뒤 새로고침하세요.'}
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
            setTest(await api('/llm/test', { method: 'POST' }));
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
    const r = await api(`/models?provider=${provider.id}`);
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
            await update({ key: { provider: provider.id, value } });
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
      <p className="caption muted">키는 macOS 키체인으로 암호화해 이 Mac에만 저장하며, 화면에는 끝 4자리만 표시합니다. 키를 저장하면 번역 엔진에서 해당 모델을 고를 수 있습니다.</p>
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
          {tab === 'general' && <GeneralTab prefs={prefs} setPrefs={setPrefs} />}
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

function Reader({ doc, settings, language, setLanguage, setToast, openSettings }) {
  const mainRef = useRef(null);
  const viewerRef = useRef(null);
  const readerRef = useRef(null);
  const [state, setState] = useState({ page: 1, pages: 0, scale: 'auto', layoutActive: false, progress: null });
  const [pageInput, setPageInput] = useState('1');
  const [exporting, setExporting] = useState('');

  useEffect(() => {
    let cancelled = false;
    let reader;
    api(`/library/${doc.id}`, json('PATCH', { lastOpenedAt: Date.now() })).catch(() => {});
    openReader({ mainContainer: mainRef.current, viewerContainer: viewerRef.current, doc, language, onState: setState }).then(
      (r) => {
        if (cancelled) return r.destroy();
        reader = readerRef.current = r;
      },
      (err) => !cancelled && setToast({ text: `PDF를 열지 못했어요: ${err?.message ?? err}` }),
    );
    return () => {
      cancelled = true;
      if (readerRef.current === reader) readerRef.current = null;
      reader?.destroy();
    };
  }, [doc.id, language]);

  useEffect(() => setPageInput(String(state.page)), [state.page]);

  async function exportPdf() {
    const r = readerRef.current;
    if (!r || exporting) return;
    try {
      const saved = await r.exportPdf(({ completed, total }) => setExporting(`${completed}/${total}`));
      const failed = saved.failedPageIndices.length ? ` · 번역 실패 ${saved.failedPageIndices.map((i) => i + 1).join(', ')}쪽` : '';
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
          <div className="segmented" title="확대/축소 · 트랙패드 핀치, ⌘+ / ⌘− / ⌘0">
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
              readerRef.current?.goToPage(Number(pageInput));
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
        />
      ) : page === 'translations' ? (
        <Translations setToast={setToast} />
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
