//! On-disk state: settings (+ API keys in the OS keychain), the PDF library and the translation cache.

use crate::llm::{Engine, Provider};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub fn sha1_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha1::new();
    for p in parts {
        h.update(p);
    }
    hex::encode(h.finalize())
}

/// Writes through a temp file + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

pub fn dir_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir).map(|d| d.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()).unwrap_or(0)
}

// ---------- settings ----------

const KEYCHAIN_SERVICE: &str = "app.sunlight.reader";
const DEFAULT_LOCAL_MODEL: &str = "gemma4:e4b"; // measured: fastest with good Korean (README)

#[derive(Serialize, Deserialize, Clone)]
#[serde(default, rename_all = "camelCase")]
struct SettingsData {
    provider: String,
    effort: String,
    local_url: String,
    local_model: String,
    models: HashMap<String, String>,
    /// provider -> "••••abcd". The key itself lives in the OS keychain.
    key_hints: HashMap<String, String>,
}

impl Default for SettingsData {
    fn default() -> Self {
        Self {
            provider: "local".into(),
            effort: "low".into(),
            local_url: "http://127.0.0.1:11434".into(),
            local_model: DEFAULT_LOCAL_MODEL.into(),
            models: HashMap::from([("exaone".into(), "k-exaone_v2.5".into()), ("anthropic".into(), "claude-opus-5-5".into())]),
            key_hints: HashMap::new(),
        }
    }
}

pub struct Settings {
    file: PathBuf,
    data: Mutex<SettingsData>,
    /// Keys read from the keychain once per run (each read can prompt on unsigned builds).
    keys: Mutex<HashMap<String, String>>,
}

impl Settings {
    pub fn load(file: PathBuf) -> Self {
        let mut data: SettingsData = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if Provider::parse(&data.provider).is_none() {
            data.provider = "local".into();
        }
        if data.local_model.is_empty() {
            data.local_model = DEFAULT_LOCAL_MODEL.into();
        }
        Self { file, data: Mutex::new(data), keys: Mutex::new(HashMap::new()) }
    }

    fn save(&self, data: &SettingsData) {
        let _ = write_atomic(&self.file, &serde_json::to_vec_pretty(data).unwrap_or_default());
    }

    pub fn key_of(&self, provider: Provider) -> String {
        let id = provider.id();
        if !self.data.lock().unwrap().key_hints.contains_key(id) {
            return String::new();
        }
        if let Some(k) = self.keys.lock().unwrap().get(id) {
            return k.clone();
        }
        let key = keyring::Entry::new(KEYCHAIN_SERVICE, id).and_then(|e| e.get_password()).unwrap_or_default();
        self.keys.lock().unwrap().insert(id.into(), key.clone());
        key
    }

    /// What the UI may see: never a key, only whether one is saved and its last 4 characters.
    pub fn public(&self) -> Value {
        let d = self.data.lock().unwrap();
        let keys: serde_json::Map<String, Value> = Provider::KEYED
            .iter()
            .map(|p| (p.id().to_string(), d.key_hints.get(p.id()).map_or(json!({ "saved": false }), |hint| json!({ "saved": true, "hint": hint }))))
            .collect();
        let models: serde_json::Map<String, Value> =
            Provider::KEYED.iter().map(|p| (p.id().to_string(), json!(d.models.get(p.id()).cloned().unwrap_or_default()))).collect();
        json!({ "provider": d.provider, "effort": d.effort, "local": { "baseUrl": d.local_url, "model": d.local_model }, "models": models, "keys": keys })
    }

    pub fn update(&self, patch: &Value) -> Result<(), String> {
        let mut d = self.data.lock().unwrap();
        if let Some(p) = patch["provider"].as_str().filter(|p| Provider::parse(p).is_some()) {
            d.provider = p.into();
        }
        if let Some(e) = patch["effort"].as_str().filter(|e| ["low", "medium", "high"].contains(e)) {
            d.effort = e.into();
        }
        if let (Some(p), Some(value)) = (patch["key"]["provider"].as_str().and_then(Provider::parse).filter(|p| *p != Provider::Local), patch["key"]["value"].as_str()) {
            let value = value.trim();
            let entry = keyring::Entry::new(KEYCHAIN_SERVICE, p.id()).map_err(|e| format!("키체인을 열지 못했어요: {e}"))?;
            if value.is_empty() {
                let _ = entry.delete_credential();
                d.key_hints.remove(p.id());
                self.keys.lock().unwrap().remove(p.id());
            } else {
                entry.set_password(value).map_err(|e| format!("키체인에 저장하지 못했어요: {e}"))?;
                let tail: String = value.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                d.key_hints.insert(p.id().into(), format!("••••{tail}"));
                self.keys.lock().unwrap().insert(p.id().into(), value.into());
            }
        }
        if let (Some(p), Some(id)) = (patch["model"]["provider"].as_str().and_then(Provider::parse), patch["model"]["id"].as_str()) {
            d.models.insert(p.id().into(), id.trim().into());
        }
        if let Some(m) = patch["localModel"].as_str().map(str::trim).filter(|m| !m.is_empty()) {
            d.local_model = m.into();
        }
        if let Some(u) = patch["localBaseUrl"].as_str().filter(|u| u.starts_with("http://") || u.starts_with("https://")) {
            d.local_url = u.trim_end_matches('/').into();
        }
        self.save(&d);
        Ok(())
    }

    pub fn model_of(&self, provider: Provider) -> String {
        self.data.lock().unwrap().models.get(provider.id()).cloned().unwrap_or_default()
    }

    pub fn local_url(&self) -> String {
        self.data.lock().unwrap().local_url.clone()
    }

    pub fn engine(&self) -> Engine {
        let (provider, effort, local_url, local_model) = {
            let d = self.data.lock().unwrap();
            (Provider::parse(&d.provider).unwrap_or(Provider::Local), d.effort.clone(), d.local_url.clone(), d.local_model.clone())
        };
        if provider == Provider::Local {
            Engine { provider, model: local_model, api_key: String::new(), effort, local_url }
        } else {
            Engine { provider, model: self.model_of(provider), api_key: self.key_of(provider), effort, local_url }
        }
    }
}

// ---------- library ----------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub added_at: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_opened_at: Option<u64>,
}

pub struct Library {
    pub dir: PathBuf,
    index: PathBuf,
    docs: Mutex<Vec<Doc>>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Library {
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("library");
        let _ = fs::create_dir_all(&dir);
        let index = data_dir.join("library.json");
        let docs = fs::read(&index).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { dir, index, docs: Mutex::new(docs) }
    }

    fn save(&self, docs: &[Doc]) {
        let _ = write_atomic(&self.index, &serde_json::to_vec_pretty(docs).unwrap_or_default());
    }

    pub fn pdf_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.pdf"))
    }

    pub fn list(&self) -> Vec<Doc> {
        let mut docs = self.docs.lock().unwrap().clone();
        docs.sort_by_key(|d| std::cmp::Reverse(d.last_opened_at.unwrap_or(d.added_at)));
        docs
    }

    pub fn get(&self, id: &str) -> Option<Doc> {
        self.docs.lock().unwrap().iter().find(|d| d.id == id).cloned()
    }

    pub fn add(&self, bytes: &[u8], file_name: &str) -> std::io::Result<Doc> {
        let id = sha1_hex(&[bytes])[..16].to_string();
        let mut docs = self.docs.lock().unwrap();
        if let Some(doc) = docs.iter().find(|d| d.id == id) {
            return Ok(doc.clone());
        }
        write_atomic(&self.pdf_path(&id), bytes)?;
        let title = file_name.strip_suffix(".pdf").or(file_name.strip_suffix(".PDF")).unwrap_or(file_name).to_string();
        let doc = Doc { id, title, file_name: file_name.into(), added_at: now_ms(), last_opened_at: None };
        docs.push(doc.clone());
        self.save(&docs);
        Ok(doc)
    }

    pub fn patch(&self, id: &str, patch: &Value) -> Option<Doc> {
        let mut docs = self.docs.lock().unwrap();
        let doc = docs.iter_mut().find(|d| d.id == id)?;
        if let Some(t) = patch["title"].as_str() {
            doc.title = t.into();
        }
        if let Some(t) = patch["lastOpenedAt"].as_u64() {
            doc.last_opened_at = Some(t);
        }
        let out = doc.clone();
        self.save(&docs);
        Some(out)
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut docs = self.docs.lock().unwrap();
        let before = docs.len();
        docs.retain(|d| d.id != id);
        if docs.len() == before {
            return false;
        }
        self.save(&docs);
        let _ = fs::remove_file(self.pdf_path(id));
        true
    }
}

// ---------- translation cache ----------

/// Sentence-level cache keyed by engine + language + source text. Append-only log on disk: each new
/// translation is one appended line, so saving is O(1) and a crash loses at most the last line.
pub struct TranslationCache {
    file: PathBuf,
    map: Mutex<HashMap<String, String>>,
    log: Mutex<Option<BufWriter<File>>>,
}

impl TranslationCache {
    pub fn load(file: PathBuf) -> Self {
        let mut map = HashMap::new();
        if let Ok(f) = File::open(&file) {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if let Ok((k, v)) = serde_json::from_str::<(String, String)>(&line) {
                    map.insert(k, v);
                }
            }
        }
        Self { file, map: Mutex::new(map), log: Mutex::new(None) }
    }

    pub fn key(engine_id: &str, target: &str, text: &str) -> String {
        sha1_hex(&[engine_id.as_bytes(), b"\0", target.as_bytes(), b"\0", text.as_bytes()])
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }

    pub fn put(&self, key: String, value: String) {
        let mut log = self.log.lock().unwrap();
        if log.is_none() {
            *log = OpenOptions::new().create(true).append(true).open(&self.file).ok().map(BufWriter::new);
        }
        if let Some(w) = log.as_mut() {
            if let Ok(line) = serde_json::to_string(&(&key, &value)) {
                let _ = writeln!(w, "{line}").and_then(|()| w.flush());
            }
        }
        self.map.lock().unwrap().insert(key, value);
    }

    pub fn bytes(&self) -> u64 {
        fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0)
    }

    pub fn clear(&self) {
        *self.log.lock().unwrap() = None;
        self.map.lock().unwrap().clear();
        let _ = fs::remove_file(&self.file);
    }
}
