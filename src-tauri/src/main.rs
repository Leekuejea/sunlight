// Sunlight: layout-preserving translation reader. The UI runs in the system webview and talks
// to the loopback server in `server.rs`; no Tauri IPC commands are exposed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detect;
mod harness;
mod llm;
mod server;
mod store;

use std::{net::TcpListener, path::PathBuf, sync::Arc};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Fixed port keeps the UI's origin (and so its localStorage: theme, language, open state) stable.
const PORT: u16 = 47613;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Sunlight");
            let exports_dir = dirs::document_dir().unwrap_or_else(|| data_dir.clone()).join("Sunlight").join("Translations");
            std::fs::create_dir_all(&data_dir)?;
            let bundled = app.path().resource_dir().map(|d| d.join("doclayout.onnx")).unwrap_or_default();
            let model = if bundled.is_file() { bundled } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/doclayout.onnx") };

            let listener = TcpListener::bind(("127.0.0.1", PORT)).or_else(|_| TcpListener::bind(("127.0.0.1", 0)))?;
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            let state = Arc::new(server::AppState::new(&data_dir, exports_dir, model, port));
            tauri::async_runtime::spawn(server::serve(listener, state));

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("http://127.0.0.1:{port}/").parse()?))
                .title("Sunlight")
                .inner_size(1440.0, 920.0)
                .min_inner_size(760.0, 520.0)
                // Anything outside the app (links in PDFs) opens in the default browser.
                .on_navigation(move |url| {
                    let own = url.host_str() == Some("127.0.0.1") && url.port() == Some(port);
                    if !own && matches!(url.scheme(), "http" | "https") {
                        let _ = open::that_detached(url.as_str());
                    }
                    own
                });
            #[cfg(target_os = "macos")]
            let window = window.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            let _window = window.build()?;
            #[cfg(debug_assertions)]
            let _ = server::DEBUG_WEBVIEW.set(_window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Sunlight");
}
