#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                if let Some(widget) = window.app_handle().get_webview_window("timer-widget") {
                    let _ = widget.close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ChronoDesk");
}
