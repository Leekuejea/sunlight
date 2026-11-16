// Sunlight: layout-preserving translation reader. The UI runs in the system webview and talks
// to the loopback server in `server.rs`; no Tauri IPC commands are exposed.
mod detect;
mod graph;
mod harness;
mod llm;
mod server;
mod store;
#[cfg(desktop)]
mod update;
#[cfg(mobile)]
mod mobile;

use std::{net::TcpListener, time::Duration};
#[cfg(desktop)]
use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::SystemTime,
};
#[cfg(desktop)]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Fixed port keeps the UI's origin (and so its localStorage: theme, language, open state) stable.
const PORT: u16 = 47613;

#[cfg(desktop)]
/// Identity of the executable this process started from: its path, size and modification time.
type ExeStamp = (PathBuf, u64, Option<SystemTime>);
#[cfg(desktop)]
static STARTED_FROM: OnceLock<Option<ExeStamp>> = OnceLock::new();

#[cfg(desktop)]
fn stamp(path: &Path) -> Option<ExeStamp> {
    let path = path.canonicalize().ok()?;
    let meta = std::fs::metadata(&path).ok()?;
    Some((path, meta.len(), meta.modified().ok()))
}

#[cfg(desktop)]
/// A second launch normally just focuses the running window. When it comes from a different copy of the
/// app, or the running copy's file was replaced by an update, the user asked for that other build: the
/// running one hands over instead of leaving an old version on screen. Returns the executable to start.
fn handover_target(argv: &[String], cwd: &str) -> Option<PathBuf> {
    let started = STARTED_FROM.get()?.as_ref()?;
    let launched = Path::new(argv.first()?);
    let launched = if launched.is_absolute() { launched.to_path_buf() } else { Path::new(cwd).join(launched) };
    let now = stamp(&launched)?;
    (now != *started).then_some(now.0)
}

/// Binds the fixed port, waiting briefly for a previous instance that is still shutting down.
fn bind_port() -> std::io::Result<TcpListener> {
    for _ in 0..30 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) {
            return Ok(listener);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    TcpListener::bind(("127.0.0.1", 0))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    mobile::run();
    #[cfg(desktop)]
    run_desktop();
}

#[cfg(desktop)]
fn run_desktop() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(target) = handover_target(&argv, &cwd) {
                tauri_plugin_single_instance::destroy(app); // release the lock first, or the new copy hands back to us
                if std::process::Command::new(&target).spawn().is_ok() {
                    app.exit(0);
                    return;
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let _ = update::APP.set(app.handle().clone());
            let _ = STARTED_FROM.set(std::env::current_exe().ok().and_then(|p| stamp(&p)));
            let data_dir = dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Sunlight");
            let exports_dir = dirs::document_dir().unwrap_or_else(|| data_dir.clone()).join("Sunlight").join("Translations");
            std::fs::create_dir_all(&data_dir)?;
            let bundled = app.path().resource_dir().map(|d| d.join("doclayout.onnx")).unwrap_or_default();
            let model = if bundled.is_file() { bundled } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/doclayout.onnx") };

            let listener = bind_port()?;
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            let state = Arc::new(server::AppState::new(&data_dir, exports_dir, model, port));
            tauri::async_runtime::spawn(server::serve(listener, state));

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("http://127.0.0.1:{port}/").parse()?))
                .title("Sunlight")
                .inner_size(1440.0, 920.0)
                .min_inner_size(760.0, 520.0)
                // Tauri's native file-drop handler swallows HTML5 drops on Windows; the page handles drops itself.
                .disable_drag_drop_handler()
                // WebKit suspends a covered or minimised window's page; translation and paper analysis keep
                // running while the reader is in another app (macOS 14+; WebView2 keeps network work going).
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
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
        .build(tauri::generate_context!())
        .expect("failed to start Sunlight")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                update::install_pending(); // an update downloaded in the background applies as the app quits
            }
        });
}
