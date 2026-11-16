//! iOS and Android. Same loopback server and UI as the desktop app, without what only a desktop has:
//! in-app updates (the stores do that), single-instance handover, Ollama and "show in folder".

use crate::{bind_port, server};
use std::{
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{async_runtime::JoinHandle, AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Stands in for the `open` crate, which has no mobile backend: `server.rs` calls it unchanged.
/// A web address opens in the browser; a file (a saved translation) goes to the system share sheet.
pub mod open {
    use super::*;

    pub fn that_detached(target: impl AsRef<std::ffi::OsStr>) -> std::io::Result<()> {
        let target = target.as_ref().to_string_lossy().into_owned();
        let Some(app) = APP.get() else { return Ok(()) };
        if target.starts_with("http://") || target.starts_with("https://") {
            app.opener().open_url(target, None::<&str>).map_err(std::io::Error::other)
        } else {
            share(app, target);
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
fn share(_app: &AppHandle, path: String) {
    use tauri::wry::prelude::{dispatch, find_class};
    dispatch(move |env, activity, _webview| {
        let mut run = || -> jni::errors::Result<()> {
            let class = find_class(env, activity, "app/sunlight/reader/Share".into())?;
            let path = env.new_string(&path)?;
            env.call_static_method(&class, "pdf", "(Landroid/app/Activity;Ljava/lang/String;)V", &[jni::objects::JValue::Object(activity), (&path).into()])?;
            Ok(())
        };
        if run().is_err() {
            let _ = env.exception_clear(); // a pending Java exception would crash the next JNI call
        }
    });
}

#[cfg(target_os = "ios")]
fn share(app: &AppHandle, path: String) {
    use objc2::{class, msg_send, runtime::AnyObject};
    use objc2_foundation::{NSArray, NSRect, NSString, NSURL};
    let Some(window) = app.get_webview_window("main") else { return };
    // Runs on the main thread, where UIKit must be called.
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.view_controller() as *mut AnyObject;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        let items = NSArray::from_retained_slice(&[url]);
        let sheet: *mut AnyObject = msg_send![class!(UIActivityViewController), alloc];
        let sheet: *mut AnyObject = msg_send![sheet, initWithActivityItems: &*items, applicationActivities: std::ptr::null::<AnyObject>()];
        // iPad shows the sheet as a popover, which must be anchored: the middle of the screen.
        let popover: *mut AnyObject = msg_send![sheet, popoverPresentationController];
        if !popover.is_null() {
            let view: *mut AnyObject = msg_send![controller, view];
            let bounds: NSRect = msg_send![view, bounds];
            let anchor = NSRect::new(objc2_foundation::NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0), objc2_foundation::NSSize::new(0.0, 0.0));
            let _: () = msg_send![popover, setSourceView: view];
            let _: () = msg_send![popover, setSourceRect: anchor];
        }
        let _: () = msg_send![controller, presentViewController: sheet, animated: true, completion: None::<&block2::Block<dyn Fn()>>];
        let _: () = msg_send![sheet, release];
    });
}

/// The running server: kept so it can be started again after the OS took its socket away.
struct Served {
    state: Arc<server::AppState>,
    port: u16,
    task: JoinHandle<()>,
}
static SERVED: Mutex<Option<Served>> = Mutex::new(None);

/// iOS can reclaim a suspended app's listening socket; the page would then get no answer from its own server.
/// When the app comes back and the port no longer accepts connections, the server is started again on it.
fn revive_server() {
    let mut served = SERVED.lock().unwrap();
    let Some(s) = served.as_mut() else { return };
    let addr = SocketAddr::from(([127, 0, 0, 1], s.port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        return;
    }
    s.task.abort();
    match TcpListener::bind(addr).and_then(|l| l.set_nonblocking(true).map(|()| l)) {
        Ok(listener) => s.task = tauri::async_runtime::spawn(server::serve(listener, s.state.clone())),
        Err(err) => eprintln!("[server] could not restart on {addr}: {err}"),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let _ = APP.set(app.handle().clone());
            let data_dir = app.path().app_data_dir()?;
            // The app's own Documents folder: on iOS it shows up in the Files app.
            let exports_dir = app.path().document_dir().unwrap_or_else(|_| data_dir.clone()).join("Translations");
            std::fs::create_dir_all(&data_dir)?;

            let listener = bind_port()?;
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            // The detection model is compiled into the binary on mobile (detect.rs), so there is no model path.
            let state = Arc::new(server::AppState::new(&data_dir, exports_dir, PathBuf::new(), port));
            let task = tauri::async_runtime::spawn(server::serve(listener, state.clone()));
            *SERVED.lock().unwrap() = Some(Served { state, port, task });

            let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("http://127.0.0.1:{port}/").parse()?))
                // Anything outside the app (links in PDFs) opens in the default browser.
                .on_navigation(move |url| {
                    let own = url.host_str() == Some("127.0.0.1") && url.port() == Some(port);
                    if !own && matches!(url.scheme(), "http" | "https") {
                        let _ = open::that_detached(url.as_str());
                    }
                    own
                })
                .build()?;
            #[cfg(debug_assertions)]
            let _ = server::DEBUG_WEBVIEW.set(_window);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Sunlight")
        .run(|_app, event| {
            if matches!(event, RunEvent::Resumed) {
                revive_server();
            }
        });
}
