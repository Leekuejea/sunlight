//! Paper graph, server half: the user's engine reads the opening of each paper once and names its title,
//! topics and contribution. This is graphify's semantic pass, with one cached JSON file per document keyed
//! by the document's content hash (its id) and the prompt version. Building, clustering and drawing the
//! graph happen in the page (src/graph/).

use crate::{
    harness::Message,
    llm::{self, Provider},
    server::{text_error, AppState},
    store::{self, Doc},
};
use axum::{
    body::Body,
    extract::{Path as UrlPath, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};

/// Bump when the prompt or the stored shape changes: older files are read as "not analysed yet".
const PROMPT_VERSION: u64 = 1;
const HEAD_LIMIT: usize = 8_000;
const REFS_LIMIT: usize = 80_000;
const MAX_TOPICS: usize = 10;
/// A whitespace line this often keeps the request alive past WebKit's 60 s idle limit; JSON.parse skips it.
const HEARTBEAT: Duration = Duration::from_secs(15);
const TOTAL_LIMIT: Duration = Duration::from_secs(300);

type S = axum::extract::State<Arc<AppState>>;

fn file_of(s: &AppState, doc: &str) -> Option<PathBuf> {
    crate::server::blob_path(&s.graph_dir, &[doc], "json")
}

fn read(s: &AppState, doc: &str) -> Option<Value> {
    let v: Value = serde_json::from_slice(&fs::read(file_of(s, doc)?).ok()?).ok()?;
    (v["version"].as_u64() == Some(PROMPT_VERSION)).then_some(v)
}

/// GET /api/graph: the library plus every paper's cached analysis.
pub async fn get_graph(State(s): S) -> Json<Value> {
    let docs = s.library.list();
    let papers: serde_json::Map<String, Value> = docs.iter().filter_map(|d| Some((d.id.clone(), read(&s, &d.id)?))).collect();
    Json(json!({ "docs": docs, "papers": papers }))
}

/// DELETE /api/graph: forget every analysis, so the next run reads all papers again (e.g. with a better model).
pub async fn clear_graph(State(s): S) -> StatusCode {
    let _ = fs::remove_dir_all(&s.graph_dir);
    match fs::create_dir_all(&s.graph_dir) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub fn remove(s: &AppState, doc: &str) {
    if let Some(path) = file_of(s, doc) {
        let _ = fs::remove_file(path);
    }
}

#[derive(Deserialize)]
pub struct ExtractRequest {
    head: String,
    #[serde(default)]
    refs: String,
    #[serde(default)]
    target: String,
    /// Topics other papers already use. Each paper is read alone, so without this list the same field comes back
    /// worded differently every time ("robotics", "robot learning") and papers never meet in the graph.
    #[serde(default)]
    known: Vec<String>,
}

const MAX_KNOWN: usize = 200;

fn clip(s: &str, max: usize) -> &str {
    s.char_indices().nth(max).map_or(s, |(i, _)| &s[..i])
}

fn messages(doc: &Doc, req: &ExtractRequest) -> Vec<Message> {
    let language = if req.target == "en" { "English" } else { "Korean" };
    let system = format!(
        "You index research papers for a knowledge graph. Read the opening of one paper and reply with exactly one JSON object and nothing else (no prose, no code fences):\n\
         {{\"title\": \"...\", \"topics\": [\"...\"], \"summary\": \"...\"}}\n\
         - title: the paper's real title as printed on its first page, not the file name.\n\
         - topics: 5 to 8 research topics in English, lowercase, singular noun phrases of 1 to 4 words. First the 1 or 2 broad research fields \
         (for example \"robot learning\", \"natural language processing\"), then the specific methods, tasks, models or datasets the paper is about \
         (for example \"diffusion policy\", \"imitation learning\"). Use the most common standard name for each, so the same topic is spelled the same \
         way in every paper. No author names, venues, or generic words such as \"method\", \"experiment\" or \"results\".\n\
         - summary: one sentence in {language} on what the paper contributes."
    );
    let known: Vec<String> = req.known.iter().take(MAX_KNOWN).map(|t| format!("- {}", clip(t.trim(), 60))).collect();
    let vocabulary = if known.is_empty() {
        String::new()
    } else {
        format!(
            "Topics already used for other papers in this library. Reuse the exact wording whenever one fits this paper, \
             especially for the broad fields; add a new topic only for what none of these covers:\n{}\n\n",
            known.join("\n")
        )
    };
    vec![
        Message { role: "system", content: system },
        Message { role: "user", content: format!("{vocabulary}File name: {}\n\n{}", doc.file_name, clip(&req.head, HEAD_LIMIT)) },
    ]
}

/// Reads the model's object even when it is wrapped in prose or a code fence. None when there are no topics.
fn parse(reply: &str) -> Option<(String, Vec<String>, String)> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    let v: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let text = |key: &str, max: usize| clip(v[key].as_str().unwrap_or("").trim(), max).to_string();
    let mut topics: Vec<String> = vec![];
    for t in v["topics"].as_array()?.iter().filter_map(Value::as_str) {
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if (2..=60).contains(&t.chars().count()) && !topics.contains(&t) {
            topics.push(t);
        }
    }
    topics.truncate(MAX_TOPICS);
    (!topics.is_empty()).then(|| (text("title", 300), topics, text("summary", 400)))
}

async fn analyse(s: &AppState, doc: &Doc, req: &ExtractRequest) -> Result<Value, String> {
    let path = file_of(s, &doc.id).ok_or("논문을 찾지 못했어요.")?;
    let engine = s.settings.engine();
    let run = async {
        let _local = if engine.provider == Provider::Local { Some(s.local_lock.lock().await) } else { None };
        llm::collect(llm::chat(&engine, messages(doc, req))).await
    };
    let reply = tokio::time::timeout(TOTAL_LIMIT, run)
        .await
        .map_err(|_| "5분 안에 답이 없어요. 모델이 바쁘거나 응답이 느려요. 잠시 후 다시 시도해주세요.".to_string())?
        .map_err(|e| e.message)?;
    let (title, topics, summary) = parse(&reply).ok_or("모델의 답에서 주제를 읽지 못했어요. 다시 시도하거나 설정에서 다른 모델을 골라보세요.")?;
    let paper = json!({
        "version": PROMPT_VERSION,
        "docId": doc.id,
        "engine": engine.id(),
        "title": if title.is_empty() { doc.title.clone() } else { title },
        "topics": topics,
        "summary": summary,
        "refs": clip(&req.refs, REFS_LIMIT),
        "extractedAt": store::now_ms(),
    });
    fs::create_dir_all(&s.graph_dir).and_then(|()| store::write_atomic(&path, paper.to_string().as_bytes())).map_err(|e| format!("분석 결과를 저장하지 못했어요: {e}"))?;
    Ok(paper)
}

/// POST /api/graph/:doc {head, refs, target}: analyses one paper. The answer is `{ok, paper}` or `{ok:false, error}`,
/// preceded by heartbeat newlines while the model works. Closing the request stops the work.
pub async fn extract(State(s): S, UrlPath(id): UrlPath<String>, Json(req): Json<ExtractRequest>) -> Response {
    let Some(doc) = s.library.get(&id) else { return text_error(404, "라이브러리에 없는 논문이에요.".into()) };
    if req.head.trim().is_empty() {
        return Json(json!({ "ok": false, "error": "PDF에서 글자를 읽지 못했어요. 스캔한 이미지로만 된 PDF일 수 있어요." })).into_response();
    }
    let stream = async_stream::stream! {
        let work = analyse(&s, &doc, &req);
        tokio::pin!(work);
        loop {
            tokio::select! {
                result = &mut work => {
                    yield match result {
                        Ok(paper) => json!({ "ok": true, "paper": paper }).to_string(),
                        Err(error) => json!({ "ok": false, "error": error }).to_string(),
                    };
                    break;
                }
                _ = tokio::time::sleep(HEARTBEAT) => yield "\n".to_string(),
            }
        }
    };
    let body = Body::from_stream(futures_util::StreamExt::map(stream, Ok::<_, std::convert::Infallible>));
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reply_is_read_through_fences_and_cleaned() {
        let reply = "Sure!\n```json\n{\"title\": \"FlowNet\", \"topics\": [\"Robot Learning\", \" diffusion  policy.\", \"robot learning\", \"x\"], \"summary\": \"요약\"}\n```";
        let (title, topics, summary) = parse(reply).unwrap();
        assert_eq!(title, "FlowNet");
        assert_eq!(topics, vec!["robot learning", "diffusion policy"]);
        assert_eq!(summary, "요약");
    }

    #[test]
    fn reply_without_topics_is_rejected() {
        assert!(parse("{\"title\": \"A\", \"topics\": []}").is_none());
        assert!(parse("no json here").is_none());
    }
}
