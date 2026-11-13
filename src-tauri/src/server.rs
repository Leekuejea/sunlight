//! Loopback HTTP server: the UI (embedded static files) and its API.
//!
//! The translation endpoint keeps the wire contract observed from Moonlight 3.7.5:
//!   POST /api/ai/translate-page-with-source-v2  {"texts": [...], "target": "ko", "reuseSaved": true}
//!   -> text/plain stream "<|0|>번역\n<|1|>번역\n...<|end|>", header X-Moonlight-Translation-End-Marker: 1
//! A stream that ends without `<|end|>` makes the viewer retry; finished sentences come from cache.

use crate::{
    detect::Detector,
    harness::{self, Fit, SegmentParser},
    llm::{self, Engine, LlmError, Provider, HTTP},
    store::{self, Library, Settings, TranslationCache},
};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Multipart, Path as UrlPath, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

#[derive(rust_embed::RustEmbed)]
#[folder = "../dist"]
struct Assets;

pub struct AppState {
    pub settings: Settings,
    pub library: Library,
    pub cache: TranslationCache,
    pub detector: Detector,
    pub box_dir: PathBuf,
    pub thumb_dir: PathBuf,
    pub exports_dir: PathBuf,
    /// One local generation at a time: the Mac's throughput is fixed, so parallel pages only slow
    /// down the page being read (measured: 2 parallel requests take as long as 2 sequential ones).
    pub local_lock: tokio::sync::Mutex<()>,
    pub port: u16,
}

impl AppState {
    pub fn new(data_dir: &Path, exports_dir: PathBuf, model: PathBuf, port: u16) -> Self {
        let dir = |name: &str| {
            let d = data_dir.join(name);
            let _ = fs::create_dir_all(&d);
            d
        };
        let _ = fs::create_dir_all(&exports_dir);
        Self {
            settings: Settings::load(data_dir.join("settings.json")),
            library: Library::load(data_dir),
            cache: TranslationCache::load(data_dir.join("translations.jsonl")),
            detector: Detector::new(model),
            box_dir: dir("boxes"),
            thumb_dir: dir("thumbs"),
            exports_dir,
            local_lock: tokio::sync::Mutex::new(()),
            port,
        }
    }
}

type S = State<Arc<AppState>>;

fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn text_error(status: u16, message: String) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], message).into_response()
}

/// Only this app's own pages may call the API: blocks other websites (CSRF) and DNS rebinding.
async fn guard(State(s): S, req: Request, next: Next) -> Response {
    let authority = format!("127.0.0.1:{}", s.port);
    let allowed = {
        let header = |name: header::HeaderName| req.headers().get(name).and_then(|v| v.to_str().ok());
        header(header::HOST) == Some(authority.as_str()) && header(header::ORIGIN).map_or(true, |o| o == format!("http://{authority}"))
    };
    if allowed {
        next.run(req).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

// ---------- translation ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateRequest {
    texts: Vec<String>,
    target: String,
    #[serde(default)]
    reuse_saved: bool,
}

const LOCAL_CHUNK_SEGMENTS: usize = 12;
const LOCAL_CHUNK_CHARS: usize = 1600;

/// Local models get a page in small batches: first sentences show up sooner and the prompt always
/// fits the context window. API models take the whole page in one request.
fn batches(engine: &Engine, missing: &[usize], texts: &[String]) -> Vec<Vec<usize>> {
    if missing.is_empty() {
        return vec![]; // fully cached: no request, so a cached page also opens offline
    }
    if engine.provider != Provider::Local {
        return vec![missing.to_vec()];
    }
    let mut out: Vec<Vec<usize>> = vec![];
    let mut chars = 0;
    for &i in missing {
        let len = texts[i].chars().count();
        if out.last().map_or(true, |b| b.len() >= LOCAL_CHUNK_SEGMENTS || chars + len > LOCAL_CHUNK_CHARS) {
            out.push(vec![]);
            chars = 0;
        }
        out.last_mut().unwrap().push(i);
        chars += len;
    }
    out
}

/// Applies the layout length budget to one fresh translation.
async fn fit_to_box(engine: &Engine, source: &str, translation: String, target: &str) -> String {
    match harness::check_fit(source, &translation, target) {
        Fit::Keep => translation,
        Fit::UseSource => source.to_owned(),
        Fit::Condense(budget) => match llm::collect(llm::chat(engine, harness::condense_messages(&translation, budget, target))).await {
            Ok(shorter) => {
                let shorter = harness::clean_segment(&shorter);
                if !shorter.is_empty() && harness::visible_length(&shorter) < harness::visible_length(&translation) {
                    shorter
                } else {
                    translation
                }
            }
            Err(_) => translation, // keep the long version; the viewer still shrinks it to fit
        },
    }
}

async fn run_translation(s: Arc<AppState>, req: TranslateRequest, tx: mpsc::Sender<Result<String, LlmError>>) {
    let engine = s.settings.engine();
    let engine_id = engine.id();
    let TranslateRequest { texts, target, reuse_saved } = req;
    let keys: Vec<String> = texts.iter().map(|t| TranslationCache::key(&engine_id, &target, t)).collect();
    let mut out: Vec<Option<String>> = texts
        .iter()
        .zip(&keys)
        .map(|(text, key)| if harness::keep_verbatim(text) { Some(text.clone()) } else if reuse_saved { s.cache.get(key).map(|t| harness::clean_segment(&t)).filter(|t| !t.is_empty()) } else { None })
        .collect();
    let missing: Vec<usize> = (0..texts.len()).filter(|&i| out[i].is_none()).collect();
    let mut sent = 0;

    macro_rules! flush {
        () => {
            while sent < out.len() {
                let Some(text) = &out[sent] else { break };
                if tx.send(Ok(format!("<|{sent}|>{text}\n"))).await.is_err() {
                    return; // the viewer went away: dropping the upstream request cancels it
                }
                sent += 1;
            }
        };
    }

    // The viewer gives up on a request when the page is closed, the language or engine changes, or it
    // retries: stop waiting and drop the upstream request right away so the next one is not held up.
    let _local = if engine.provider == Provider::Local && !missing.is_empty() {
        tokio::select! {
            _ = tx.closed() => return,
            guard = s.local_lock.lock() => Some(guard),
        }
    } else {
        None
    };
    let mut started = missing.is_empty(); // hold cached lines until the engine answers, so setup errors keep their status
    for batch in batches(&engine, &missing, &texts) {
        let sources: Vec<&str> = batch.iter().map(|&i| texts[i].as_str()).collect();
        let mut stream = llm::chat(&engine, harness::build_messages(&sources, &target));
        let mut parser = SegmentParser::new(sources.len());
        loop {
            let next = tokio::select! {
                _ = tx.closed() => return,
                next = stream.next() => next,
            };
            let (segments, done) = match next {
                Some(Ok(chunk)) => (parser.push(&chunk), false),
                Some(Err(err)) => {
                    eprintln!("[translate] {}", err.message);
                    if !started {
                        let _ = tx.send(Err(err)).await;
                    }
                    return; // no end marker: the viewer retries, finished sentences come from cache
                }
                None => (parser.finish(), true),
            };
            started = true;
            for segment in segments {
                let i = batch[segment.index];
                out[i] = Some(match segment.text {
                    Some(text) => {
                        let text = fit_to_box(&engine, &texts[i], text, &target).await;
                        s.cache.put(keys[i].clone(), text.clone());
                        text
                    }
                    None => texts[i].clone(), // skipped by the model: show the source, don't cache it
                });
            }
            flush!();
            if done {
                break;
            }
        }
    }
    flush!();
    let _ = tx.send(Ok("<|end|>".into())).await;
}

/// How long a request waits for the first line before the response starts. Setup errors (missing key,
/// model not installed) arrive within it and keep their HTTP status.
const FIRST_LINE_WAIT: Duration = Duration::from_secs(10);
/// WebKit drops a request after 60 s without data, which a cold local model or a long first sentence
/// exceeds: a blank line keeps the stream alive (the viewer's parser ignores it).
const HEARTBEAT: Duration = Duration::from_secs(15);

async fn translate(State(s): S, Json(req): Json<TranslateRequest>) -> Response {
    let (tx, mut rx) = mpsc::channel(64);
    tokio::spawn(run_translation(s, req, tx));
    let first = match tokio::time::timeout(FIRST_LINE_WAIT, rx.recv()).await {
        Ok(Some(Err(err))) => return text_error(err.status, err.message),
        Ok(Some(Ok(line))) => Some(line),
        Ok(None) => return text_error(502, "번역을 시작하지 못했어요.".into()),
        Err(_) => None,
    };
    let body = async_stream::stream! {
        if let Some(line) = first {
            yield line;
        }
        loop {
            match tokio::time::timeout(HEARTBEAT, rx.recv()).await {
                Ok(Some(Ok(line))) => yield line,
                // An error after the response started: "<|error|>status|message", read by the viewer.
                Ok(Some(Err(err))) => {
                    yield format!("<|error|>{}|{}", err.status, err.message);
                    break;
                }
                Ok(None) => break,
                Err(_) => yield "\n".to_string(),
            }
        }
    }
    .map(Ok::<_, std::convert::Infallible>);
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::HeaderName::from_static("x-moonlight-translation-end-marker"), "1")], Body::from_stream(body)).into_response()
}

const TEST_LIMIT: Duration = Duration::from_secs(40);

async fn llm_test(State(s): S) -> Json<Value> {
    let engine = s.settings.engine();
    let source = "Flow-matching policies have become capable generalist priors for robot manipulation.";
    let started = Instant::now();
    let run = async {
        let _local = if engine.provider == Provider::Local { Some(s.local_lock.lock().await) } else { None };
        llm::collect(llm::chat(&engine, harness::build_messages(&[source], "ko"))).await
    };
    // Answer well inside WebKit's 60 s request limit, whatever the engine is doing.
    let result = tokio::time::timeout(TEST_LIMIT, run).await.unwrap_or_else(|_| {
        Err(LlmError::new(
            504,
            if engine.provider == Provider::Local {
                "40초 안에 답이 없어요. 다른 쪽을 번역하는 중이거나 모델을 처음 불러오는 중일 수 있어요. 잠시 후 다시 시도해주세요."
            } else {
                "40초 안에 답이 없어요. 요청 한도(429)에 걸렸거나 네트워크가 느릴 수 있어요. 잠시 후 다시 시도해주세요."
            },
        ))
    });
    match result {
        Ok(reply) => {
            let mut parser = SegmentParser::new(1);
            let mut segments = parser.push(&reply);
            segments.extend(parser.finish());
            let text = segments.into_iter().find_map(|s| s.text).unwrap_or_else(|| harness::clean_segment(&reply));
            Json(json!({ "ok": true, "text": text, "ms": started.elapsed().as_millis() as u64, "engine": engine.id() }))
        }
        Err(err) => Json(json!({ "ok": false, "error": err.message })),
    }
}

// ---------- settings & models ----------

async fn get_settings(State(s): S) -> Json<Value> {
    Json(s.settings.public())
}

async fn put_settings(State(s): S, Json(patch): Json<Value>) -> Response {
    match s.settings.update(&patch) {
        Ok(()) => Json(s.settings.public()).into_response(),
        Err(message) => text_error(500, message),
    }
}

/// Lists a provider's models with the saved key (doubles as the key check) and settles a default.
async fn models(State(s): S, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(provider) = q.get("provider").and_then(|p| Provider::parse(p)).filter(|p| *p != Provider::Local) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match llm::list_models(provider, &s.settings.key_of(provider)).await {
        Ok(ids) => {
            if !ids.is_empty() && !ids.contains(&s.settings.model_of(provider)) {
                if let Some(id) = llm::default_model(provider, &ids) {
                    let _ = s.settings.update(&json!({ "model": { "provider": provider.id(), "id": id } }));
                }
            }
            Json(json!({ "ok": true, "models": ids, "selected": s.settings.model_of(provider) })).into_response()
        }
        Err(err) => Json(json!({ "ok": false, "error": err.message, "models": [] })).into_response(),
    }
}

// ---------- local LLM (Ollama) ----------

async fn local_models(State(s): S) -> Json<Value> {
    let res = HTTP.get(format!("{}/api/tags", s.settings.local_url())).timeout(Duration::from_secs(3)).send().await;
    let Ok(body) = (match res {
        Ok(r) if r.status().is_success() => r.json::<Value>().await,
        _ => return Json(json!({ "running": false, "models": [] })),
    }) else {
        return Json(json!({ "running": false, "models": [] }));
    };
    let models: Vec<Value> = body["models"].as_array().map(|a| a.iter().map(|m| json!({ "name": m["name"], "bytes": m["size"] })).collect()).unwrap_or_default();
    Json(json!({ "running": true, "models": models }))
}

/// Downloads a model; Ollama's NDJSON progress lines are passed through.
async fn local_pull(State(s): S, Json(body): Json<Value>) -> Response {
    let Some(model) = body["model"].as_str() else { return StatusCode::BAD_REQUEST.into_response() };
    match HTTP.post(format!("{}/api/pull", s.settings.local_url())).json(&json!({ "model": model, "stream": true })).send().await {
        Ok(res) if res.status().is_success() => ([(header::CONTENT_TYPE, "application/x-ndjson")], Body::from_stream(res.bytes_stream())).into_response(),
        _ => text_error(503, "Ollama에 연결하지 못했어요.".into()),
    }
}

/// Loads the local model into memory ahead of the first page (a cold load costs ~12s on a 16GB
/// M2 Pro). Uses the same context size as real requests, otherwise Ollama would reload the model.
async fn local_warm(State(s): S) -> StatusCode {
    let engine = s.settings.engine();
    if engine.provider == Provider::Local {
        tokio::spawn(async move {
            let _ = HTTP
                .post(format!("{}/api/chat", engine.local_url))
                .json(&json!({ "model": engine.model, "messages": [], "stream": false, "keep_alive": "30m", "options": { "num_ctx": llm::LOCAL_NUM_CTX } }))
                .send()
                .await;
        });
    }
    StatusCode::NO_CONTENT
}

// ---------- layout detection ----------

async fn detect(State(s): S, mut form: Multipart) -> Response {
    let mut image: Option<Bytes> = None;
    while let Ok(Some(field)) = form.next_field().await {
        if field.name() == Some("file") {
            image = field.bytes().await.ok();
        }
    }
    let Some(image) = image else { return StatusCode::BAD_REQUEST.into_response() };
    match tokio::task::spawn_blocking(move || s.detector.detect(&image)).await {
        Ok(Ok(boxes)) => Json(boxes).into_response(),
        Ok(Err(message)) => {
            eprintln!("[detect] {message}");
            text_error(503, message)
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn blob_path(dir: &Path, parts: &[&str], ext: &str) -> Option<PathBuf> {
    parts.iter().all(|p| safe_id(p)).then(|| dir.join(format!("{}.{ext}", parts.join("-"))))
}

async fn get_blob(path: Option<PathBuf>, content_type: &'static str) -> Response {
    match path.and_then(|p| fs::read(p).ok()) {
        Some(bytes) => ([(header::CONTENT_TYPE, content_type)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn put_blob(path: Option<PathBuf>, body: Bytes) -> StatusCode {
    match path.map(|p| store::write_atomic(&p, &body)) {
        Some(Ok(())) => StatusCode::NO_CONTENT,
        _ => StatusCode::BAD_REQUEST,
    }
}

async fn get_boxes(State(s): S, UrlPath((doc, page)): UrlPath<(String, String)>) -> Response {
    get_blob(blob_path(&s.box_dir, &[&doc, &page], "json"), "application/json").await
}
async fn put_boxes(State(s): S, UrlPath((doc, page)): UrlPath<(String, String)>, body: Bytes) -> StatusCode {
    put_blob(blob_path(&s.box_dir, &[&doc, &page], "json"), body).await
}
async fn get_thumb(State(s): S, UrlPath(id): UrlPath<String>) -> Response {
    get_blob(blob_path(&s.thumb_dir, &[&id], "jpg"), "image/jpeg").await
}
async fn put_thumb(State(s): S, UrlPath(id): UrlPath<String>, body: Bytes) -> StatusCode {
    put_blob(blob_path(&s.thumb_dir, &[&id], "jpg"), body).await
}

// ---------- library ----------

async fn library_list(State(s): S) -> Json<Value> {
    Json(json!(s.library.list()))
}

async fn library_add(State(s): S, headers: HeaderMap, body: Bytes) -> Response {
    if !body.starts_with(b"%PDF-") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "not a PDF" }))).into_response();
    }
    let name = headers.get("x-filename").and_then(|v| v.to_str().ok()).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned()).unwrap_or_else(|| "document.pdf".into());
    match s.library.add(&body, &name) {
        Ok(doc) => Json(json!(doc)).into_response(),
        Err(e) => text_error(500, e.to_string()),
    }
}

async fn library_patch(State(s): S, UrlPath(id): UrlPath<String>, Json(patch): Json<Value>) -> Response {
    s.library.patch(&id, &patch).map_or(StatusCode::NOT_FOUND.into_response(), |d| Json(json!(d)).into_response())
}

async fn library_delete(State(s): S, UrlPath(id): UrlPath<String>) -> StatusCode {
    if s.library.remove(&id) {
        let _ = fs::remove_file(s.thumb_dir.join(format!("{id}.jpg")));
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn pdf_file(State(s): S, UrlPath(name): UrlPath<String>) -> Response {
    let Some(id) = name.strip_suffix(".pdf").filter(|id| safe_id(id)) else { return StatusCode::NOT_FOUND.into_response() };
    match tokio::fs::read(s.library.pdf_path(id)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------- translated PDFs (one user-visible folder) ----------

/// Only plain `*.pdf` basenames inside the exports folder are ever touched.
fn export_path(s: &AppState, name: &str) -> Option<PathBuf> {
    let plain = !name.is_empty() && !name.contains(['/', '\\']) && name != ".." && name.to_lowercase().ends_with(".pdf");
    plain.then(|| s.exports_dir.join(name)).filter(|p| p.is_file())
}

async fn exports_list(State(s): S) -> Json<Value> {
    let mut files: Vec<(u64, Value)> = fs::read_dir(&s.exports_dir)
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".pdf"))
                .filter_map(|e| {
                    let meta = e.metadata().ok()?;
                    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
                    Some((modified, json!({ "name": e.file_name().to_string_lossy(), "bytes": meta.len(), "modifiedAt": modified })))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    Json(json!({ "dir": s.exports_dir, "files": files.into_iter().map(|f| f.1).collect::<Vec<_>>() }))
}

async fn exports_add(State(s): S, Query(q): Query<HashMap<String, String>>, body: Bytes) -> Response {
    let title = q.get("docId").and_then(|id| s.library.get(id)).map_or("document".to_string(), |d| d.title);
    let label = match q.get("lang").map(String::as_str) {
        Some("ko") => "한국어",
        Some("en") => "English",
        _ => "번역",
    };
    let clean: String = title.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { ' ' } else { c }).take(120).collect();
    let base = format!("{} ({label})", clean.trim());
    let mut name = format!("{base}.pdf");
    let mut n = 2;
    while s.exports_dir.join(&name).exists() {
        name = format!("{base} {n}.pdf");
        n += 1;
    }
    let path = s.exports_dir.join(&name);
    match store::write_atomic(&path, &body) {
        Ok(()) => Json(json!({ "name": name, "path": path })).into_response(),
        Err(e) => text_error(500, format!("번역본을 저장하지 못했어요: {e}")),
    }
}

async fn exports_reveal(State(s): S) -> StatusCode {
    let _ = open::that_detached(&s.exports_dir);
    StatusCode::NO_CONTENT
}

async fn export_open(State(s): S, UrlPath(name): UrlPath<String>) -> StatusCode {
    match export_path(&s, &name) {
        Some(p) => {
            let _ = open::that_detached(p);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::NOT_FOUND,
    }
}

async fn export_delete(State(s): S, UrlPath(name): UrlPath<String>) -> StatusCode {
    match export_path(&s, &name).map(fs::remove_file) {
        Some(Ok(())) => StatusCode::NO_CONTENT,
        _ => StatusCode::NOT_FOUND,
    }
}

async fn storage(State(s): S) -> Json<Value> {
    Json(json!({
        "exportsDir": s.exports_dir,
        "exportsBytes": store::dir_bytes(&s.exports_dir),
        "libraryBytes": store::dir_bytes(&s.library.dir),
        "cacheBytes": s.cache.bytes() + store::dir_bytes(&s.box_dir) + store::dir_bytes(&s.thumb_dir),
    }))
}

async fn cache_clear(State(s): S) -> StatusCode {
    s.cache.clear();
    for dir in [&s.box_dir, &s.thumb_dir] {
        let _ = fs::remove_dir_all(dir);
        let _ = fs::create_dir_all(dir);
    }
    StatusCode::NO_CONTENT
}

/// Links inside PDFs open in the default browser, never inside the app.
async fn open_external(Json(body): Json<Value>) -> StatusCode {
    match body["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")) {
        Some(url) => {
            let _ = open::that_detached(url);
            StatusCode::NO_CONTENT
        }
        None => StatusCode::BAD_REQUEST,
    }
}

// ---------- debug builds only: drive the webview from tests ----------

#[cfg(debug_assertions)]
pub static DEBUG_WEBVIEW: std::sync::OnceLock<tauri::WebviewWindow> = std::sync::OnceLock::new();

/// Evaluates the posted JavaScript in the app window. The script can report back by calling
/// `fetch('/api/debug/log', { method: 'POST', body })`, which prints to stderr.
#[cfg(debug_assertions)]
async fn debug_eval(body: String) -> StatusCode {
    match DEBUG_WEBVIEW.get().map(|w| w.eval(&body)) {
        Some(Ok(())) => StatusCode::NO_CONTENT,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[cfg(debug_assertions)]
async fn debug_log(body: String) -> StatusCode {
    eprintln!("[webview] {body}");
    StatusCode::NO_CONTENT
}

// ---------- static UI ----------

async fn static_file(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(if path.is_empty() { "index.html" } else { path }).decode_utf8_lossy().into_owned();
    match Assets::get(&path) {
        Some(file) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            let cache = if path.starts_with("assets/") || path.starts_with("pdfjs/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(header::CONTENT_TYPE, mime.as_ref().to_owned()), (header::CACHE_CONTROL, cache.to_owned())], file.data).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    let router = Router::new();
    #[cfg(debug_assertions)]
    let router = router.route("/api/debug/eval", post(debug_eval)).route("/api/debug/log", post(debug_log));
    router
        .route("/api/ai/translate-page-with-source-v2", post(translate))
        .route("/api/llm/test", post(llm_test))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/models", get(models))
        .route("/api/local/models", get(local_models))
        .route("/api/local/pull", post(local_pull))
        .route("/api/local/warm", post(local_warm))
        .route("/api/detect", post(detect))
        .route("/api/boxes/:doc/:page", get(get_boxes).put(put_boxes))
        .route("/api/thumbs/:id", get(get_thumb).put(put_thumb))
        .route("/api/library", get(library_list).post(library_add))
        .route("/api/library/:id", axum::routing::patch(library_patch).delete(library_delete))
        .route("/files/:name", get(pdf_file))
        .route("/api/exports", get(exports_list).post(exports_add))
        .route("/api/exports/reveal", post(exports_reveal))
        .route("/api/exports/:name", delete(export_delete))
        .route("/api/exports/:name/open", post(export_open))
        .route("/api/storage", get(storage))
        .route("/api/cache", delete(cache_clear))
        .route("/api/open-external", post(open_external))
        .fallback(static_file)
        .layer(DefaultBodyLimit::max(1 << 30)) // PDFs and translated PDFs are uploaded whole
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

pub async fn serve(listener: std::net::TcpListener, state: Arc<AppState>) {
    let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
    if let Err(err) = axum::serve(listener, router(state)).await {
        eprintln!("server stopped: {err}");
    }
}
