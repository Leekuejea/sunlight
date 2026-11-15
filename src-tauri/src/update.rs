//! In-app updates. Downloading the new version here instead of in a browser means the installed copy never
//! carries the quarantine flag, so macOS Gatekeeper does not block every update of this unnotarized app.
//! The package is verified against the public key in tauri.conf.json before it is installed.

use axum::{body::Body, http::header, response::IntoResponse, response::Response, Json};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

pub static APP: OnceLock<AppHandle> = OnceLock::new();
static INSTALLING: AtomicBool = AtomicBool::new(false);

async fn find() -> Result<Option<Update>, String> {
    let app = APP.get().ok_or("앱이 아직 준비되지 않았어요.")?;
    let mut builder = app.updater_builder().timeout(Duration::from_secs(20));
    // For testing an update end to end against a local server; the signature check still applies.
    if let Some(url) = std::env::var("SUNLIGHT_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
}

fn friendly(error: &str) -> String {
    if error.contains("signature") || error.contains("Signature") {
        "업데이트 파일의 서명이 맞지 않아 설치하지 않았어요.".into()
    } else {
        format!("업데이트를 확인하지 못했어요. 인터넷 연결을 확인해주세요. ({error})")
    }
}

/// GET /api/update: whether a newer version is published.
pub async fn check() -> Json<Value> {
    let current = env!("CARGO_PKG_VERSION");
    match find().await {
        Ok(Some(u)) => Json(json!({ "ok": true, "current": current, "available": true, "version": u.version, "notes": u.body })),
        Ok(None) => Json(json!({ "ok": true, "current": current, "available": false })),
        Err(e) => Json(json!({ "ok": false, "current": current, "error": friendly(&e) })),
    }
}

/// POST /api/update/install: streams NDJSON progress, installs, then restarts into the new version.
pub async fn install() -> Response {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Json(json!({ "error": "이미 업데이트를 설치하고 있어요." })).into_response();
    }
    let stream = async_stream::stream! {
        let update = match find().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                INSTALLING.store(false, Ordering::SeqCst);
                yield json!({ "error": "이미 최신 버전이에요." });
                return;
            }
            Err(e) => {
                INSTALLING.store(false, Ordering::SeqCst);
                yield json!({ "error": friendly(&e) });
                return;
            }
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, Option<u64>)>();
        let task = tokio::spawn(async move {
            let mut received = 0u64;
            update
                .download_and_install(
                    move |chunk, total| {
                        received += chunk as u64;
                        let _ = tx.send((received, total));
                    },
                    || {},
                )
                .await
        });
        let mut last_pct = None;
        while let Some((received, total)) = rx.recv().await {
            let pct = total.filter(|t| *t > 0).map(|t| received * 100 / t);
            if pct != last_pct {
                last_pct = pct;
                yield json!({ "status": "내려받는 중", "pct": pct });
            }
        }
        match task.await {
            Ok(Ok(())) => {
                yield json!({ "status": "다시 시작하는 중", "done": true });
                if let Some(app) = APP.get() {
                    let app = app.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(600)).await; // let the last line reach the page
                        app.restart();
                    });
                }
            }
            Ok(Err(e)) => {
                INSTALLING.store(false, Ordering::SeqCst);
                yield json!({ "error": friendly(&e.to_string()) });
            }
            Err(_) => {
                INSTALLING.store(false, Ordering::SeqCst);
                yield json!({ "error": "업데이트를 설치하지 못했어요." });
            }
        }
    };
    let body = Body::from_stream(futures_util::StreamExt::map(stream, |v| Ok::<_, std::convert::Infallible>(format!("{v}\n"))));
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
}
