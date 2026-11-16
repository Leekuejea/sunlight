// Sunlight: layout-preserving translation reader. The UI runs in the system webview and talks
// to the loopback server in `server.rs`; no Tauri IPC commands are exposed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sunlight_lib::run()
}
