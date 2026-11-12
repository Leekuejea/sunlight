//! Chat engines. Each returns the model's answer as a stream of text deltas.
//!
//! EXAONE, OpenAI and Gemini speak the OpenAI chat-completions SSE format; Claude uses the
//! Anthropic Messages API (raw HTTP: there is no official Rust SDK); local models run on Ollama.

use crate::harness::Message;
use async_stream::try_stream;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};
use std::{pin::Pin, sync::LazyLock, time::Duration};

#[derive(Debug, Clone)]
pub struct LlmError {
    pub status: u16,
    pub message: String,
}

impl LlmError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

impl From<reqwest::Error> for LlmError {
    fn from(e: reqwest::Error) -> Self {
        Self::new(502, format!("네트워크 오류: {e}"))
    }
}

pub type TextStream = Pin<Box<dyn Stream<Item = Result<String, LlmError>> + Send>>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Local,
    Exaone,
    Openai,
    Anthropic,
    Gemini,
}

impl Provider {
    pub const KEYED: [Provider; 4] = [Provider::Exaone, Provider::Openai, Provider::Anthropic, Provider::Gemini];

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "local" => Self::Local,
            "exaone" => Self::Exaone,
            "openai" => Self::Openai,
            "anthropic" => Self::Anthropic,
            "gemini" => Self::Gemini,
            _ => return None,
        })
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Exaone => "exaone",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Local => "Ollama",
            Self::Exaone => "EXAONE API",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Claude API",
            Self::Gemini => "Gemini",
        }
    }

    fn base_url(self) -> &'static str {
        match self {
            Self::Exaone => "https://api.exaone.ai/v1",
            Self::Openai => "https://api.openai.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai",
            Self::Anthropic => "https://api.anthropic.com/v1",
            Self::Local => "",
        }
    }
}

/// Everything needed for one request, snapshotted from the settings.
#[derive(Clone)]
pub struct Engine {
    pub provider: Provider,
    pub model: String,
    pub api_key: String,
    pub effort: String,
    pub local_url: String,
}

impl Engine {
    /// Cache namespace: a different engine or model never reuses another one's translations.
    pub fn id(&self) -> String {
        format!("{}:{}", if self.provider == Provider::Local { "ollama" } else { self.provider.id() }, self.model)
    }
}

pub static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(300)) // max silence between chunks, not a total deadline
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .expect("http client")
});

const ANTHROPIC_VERSION: &str = "2026-10-21";
const MAX_RATE_LIMIT_RETRIES: u32 = 4;
static OPENAI_REASONING_MODEL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(gpt-[5-9]|o\d)").unwrap());

async fn failure(res: reqwest::Response, label: &str) -> LlmError {
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|j| {
            [&j["description"], &j["error"]["message"], &j["error"], &j[0]["error"]["message"]]
                .into_iter()
                .find_map(|v| v.as_str().map(str::to_owned))
        })
        .unwrap_or(body);
    let detail: String = detail.chars().take(300).collect();
    LlmError::new(status, if detail.is_empty() { format!("{label} {status}") } else { format!("{label} {status}: {detail}") })
}

async fn ok(res: reqwest::Response, label: &str) -> Result<reqwest::Response, LlmError> {
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(failure(res, label).await)
    }
}

/// Splits a streaming body into lines (SSE and NDJSON are both line based).
fn lines(res: reqwest::Response) -> impl Stream<Item = Result<String, LlmError>> {
    try_stream! {
        let mut body = res.bytes_stream();
        let mut rest: Vec<u8> = Vec::new();
        while let Some(chunk) = body.next().await {
            rest.extend_from_slice(&chunk?);
            while let Some(at) = rest.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = rest.drain(..=at).collect();
                yield String::from_utf8_lossy(&line).trim_end().to_string();
            }
        }
        if !rest.is_empty() {
            yield String::from_utf8_lossy(&rest).to_string();
        }
    }
}

fn missing_key(provider: Provider) -> LlmError {
    LlmError::new(401, format!("{} API 키가 없어요. 설정 > API 키에서 입력해주세요.", provider.label()))
}

fn openai_compat(engine: Engine, messages: Vec<Message>) -> TextStream {
    Box::pin(try_stream! {
        let Engine { provider, model, api_key, effort, .. } = engine;
        if api_key.is_empty() {
            Err(missing_key(provider))?;
        }
        let mut body = json!({ "model": model, "messages": messages, "stream": true });
        match provider {
            Provider::Exaone => {
                body["max_tokens"] = json!(32768);
                body["temperature"] = json!(1.0);
                body["top_p"] = json!(0.95);
                body["reasoning_effort"] = json!(effort);
            }
            Provider::Openai => {
                body["max_completion_tokens"] = json!(32768);
                if OPENAI_REASONING_MODEL.is_match(&model) {
                    body["reasoning_effort"] = json!(effort);
                }
            }
            _ => {
                body["max_tokens"] = json!(32768);
                body["reasoning_effort"] = json!(effort);
            }
        }
        // 429 ("service is busy" on EXAONE, rate limits elsewhere): honour retry-after, else 3s..48s.
        let mut attempt = 0;
        let res = loop {
            let res = HTTP.post(format!("{}/chat/completions", provider.base_url())).bearer_auth(&api_key).json(&body).send().await?;
            if res.status().as_u16() != 429 || attempt == MAX_RATE_LIMIT_RETRIES {
                break res;
            }
            let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<f64>().ok());
            let wait_ms = header("retry-after-ms").or(header("retry-after").map(|s| s * 1000.0)).unwrap_or(3000.0 * f64::from(1u32 << attempt));
            tokio::time::sleep(Duration::from_millis(wait_ms.clamp(500.0, 60_000.0) as u64)).await;
            attempt += 1;
        };
        let lines = lines(ok(res, provider.label()).await?);
        futures_util::pin_mut!(lines);
        while let Some(line) = lines.next().await {
            let line = line?;
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                break;
            }
            // reasoning_content deltas are ignored: only the answer is used
            if let Some(delta) = serde_json::from_str::<Value>(data).ok().and_then(|j| j["choices"][0]["delta"]["content"].as_str().map(str::to_owned)) {
                if !delta.is_empty() {
                    yield delta;
                }
            }
        }
    })
}

fn claude(engine: Engine, messages: Vec<Message>) -> TextStream {
    Box::pin(try_stream! {
        let Engine { model, api_key, effort, .. } = engine;
        if api_key.is_empty() {
            Err(missing_key(Provider::Anthropic))?;
        }
        let system = messages.first().filter(|m| m.role == "system").map(|m| m.content.clone()).unwrap_or_default();
        let turns: Vec<&Message> = messages.iter().filter(|m| m.role != "system").collect();
        let mut body = json!({ "model": model, "max_tokens": 32000, "stream": true, "system": system, "messages": turns, "output_config": { "effort": effort } });
        let mut req = HTTP.post("https://api.anthropic.com/v1/messages").header("x-api-key", &api_key).header("anthropic-version", ANTHROPIC_VERSION);
        // Opus/Sonnet 5.5 and Fable can decline a request: let the API re-run it on its recommended fallback.
        if model.starts_with("claude-opus-5") || model.starts_with("claude-sonnet-5-5") || model.starts_with("claude-fable") {
            body["fallbacks"] = json!("default");
            req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let res = req.json(&body).send().await?;
        let lines = lines(ok(res, "Claude API").await?);
        futures_util::pin_mut!(lines);
        while let Some(line) = lines.next().await {
            let line = line?;
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
            match event["type"].as_str() {
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        yield text.to_owned();
                    }
                }
                Some("message_delta") if event["delta"]["stop_reason"] == "refusal" => {
                    Err(LlmError::new(422, "Claude가 이 쪽의 번역을 거절했어요."))?;
                }
                Some("error") => Err(LlmError::new(502, format!("Claude API: {}", event["error"]["message"].as_str().unwrap_or("stream error"))))?,
                _ => {}
            }
        }
    })
}

/// Context window for local runs. Kept constant: Ollama reloads the model whenever it changes.
pub const LOCAL_NUM_CTX: u32 = 8192;

fn ollama(engine: Engine, messages: Vec<Message>) -> TextStream {
    Box::pin(try_stream! {
        let Engine { model, local_url, .. } = engine;
        let body = json!({
            "model": model, "messages": messages, "stream": true, "think": false, "keep_alive": "30m",
            "options": { "num_ctx": LOCAL_NUM_CTX, "num_predict": 4096, "temperature": 0.2 }
        });
        let res = HTTP
            .post(format!("{local_url}/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|_| LlmError::new(503, format!("로컬 LLM(Ollama, {local_url})에 연결하지 못했어요. Ollama가 실행 중인지 확인해주세요.")))?;
        if res.status().as_u16() == 404 {
            Err(LlmError::new(404, format!("로컬 모델 \"{model}\"이 없어요. 설정 > 번역 엔진에서 내려받아주세요.")))?;
        }
        let lines = lines(ok(res, "Ollama").await?);
        futures_util::pin_mut!(lines);
        while let Some(line) = lines.next().await {
            let line = line?;
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(error) = event["error"].as_str() {
                Err(LlmError::new(500, format!("Ollama: {error}")))?;
            }
            if let Some(text) = event["message"]["content"].as_str() {
                if !text.is_empty() {
                    yield text.to_owned();
                }
            }
            if event["done"] == true {
                break;
            }
        }
    })
}

pub fn chat(engine: &Engine, messages: Vec<Message>) -> TextStream {
    match engine.provider {
        Provider::Local => ollama(engine.clone(), messages),
        Provider::Anthropic => claude(engine.clone(), messages),
        _ => openai_compat(engine.clone(), messages),
    }
}

pub async fn collect(mut stream: TextStream) -> Result<String, LlmError> {
    let mut out = String::new();
    while let Some(chunk) = stream.next().await {
        out.push_str(&chunk?);
    }
    Ok(out)
}

// ---------- model lists (listing with a key also validates it) ----------

fn usable(provider: Provider, id: &str) -> bool {
    static OPENAI: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^(gpt-[4-9]|o\d)").unwrap());
    static OPENAI_NO: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"audio|realtime|transcribe|tts|image|search|embedding|instruct|codex|oss|moderation").unwrap());
    static GEMINI_NO: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"embedding|image|tts|live|audio|vision|aqa").unwrap());
    static CLAUDE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^claude-(fable|opus|sonnet|haiku)-5").unwrap());
    match provider {
        Provider::Openai => OPENAI.is_match(id) && !OPENAI_NO.is_match(id),
        Provider::Gemini => id.starts_with("gemini-") && !GEMINI_NO.is_match(id),
        Provider::Anthropic => CLAUDE.is_match(id),
        _ => true,
    }
}

pub async fn list_models(provider: Provider, api_key: &str) -> Result<Vec<String>, LlmError> {
    if api_key.is_empty() {
        return Err(LlmError::new(401, "API 키가 없어요."));
    }
    let res = match provider {
        Provider::Exaone => {
            // No model list endpoint is documented; a 1-token call validates the key. The shared
            // endpoint is often busy, so a timeout or 429 still counts as "not rejected".
            let call = HTTP
                .post("https://api.exaone.ai/v1/chat/completions")
                .bearer_auth(api_key)
                .timeout(Duration::from_secs(20))
                .json(&json!({ "model": "k-exaone_v2.5", "messages": [{ "role": "user", "content": "hi" }], "max_tokens": 1, "reasoning_effort": "low" }))
                .send()
                .await;
            if let Ok(res) = call {
                if matches!(res.status().as_u16(), 401 | 403) {
                    return Err(failure(res, "EXAONE API").await);
                }
            }
            return Ok(vec!["k-exaone_v2.5".into()]);
        }
        Provider::Anthropic => {
            HTTP.get("https://api.anthropic.com/v1/models?limit=1000").header("x-api-key", api_key).header("anthropic-version", ANTHROPIC_VERSION).send().await?
        }
        _ => HTTP.get(format!("{}/models", provider.base_url())).bearer_auth(api_key).send().await?,
    };
    if !res.status().is_success() {
        return Err(failure(res, provider.label()).await);
    }
    let body: Value = res.json().await?;
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str()).map(|id| id.trim_start_matches("models/").to_owned()).filter(|id| usable(provider, id)).collect())
        .unwrap_or_default();
    ids.sort_by(|a, b| b.cmp(a));
    Ok(ids)
}

/// Default pick when the user hasn't chosen: fast models suited to bulk translation.
pub fn default_model(provider: Provider, ids: &[String]) -> Option<String> {
    let prefer: &[&str] = match provider {
        Provider::Openai => &[r"^gpt-[5-9][.\d]*-mini$", r"^gpt-[5-9][.\d]*-(luna|nano)$", r"^gpt-[5-9]"],
        Provider::Gemini => &[r"^gemini-[\d.]+-flash$", r"^gemini-[\d.]+-flash", r"flash"],
        Provider::Anthropic => &[r"^claude-opus-5-5$", r"^claude-opus", r"^claude-sonnet"],
        _ => &[],
    };
    prefer
        .iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .find_map(|re| ids.iter().find(|id| re.is_match(id)).cloned())
        .or_else(|| ids.first().cloned())
}
