#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager, WindowEvent};

fn state_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    Ok((
        directory.join("state.json"),
        directory.join("state.backup.json"),
        directory.join("state.tmp.json"),
    ))
}

fn is_valid_state_json(contents: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(contents) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("projects").is_some_and(serde_json::Value::is_array)
        && object.get("tasks").is_some_and(serde_json::Value::is_array)
        && object.get("sessions").is_some_and(serde_json::Value::is_array)
        && object.get("settings").is_some_and(serde_json::Value::is_object)
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let (primary, backup, _) = state_paths(&app)?;
    let mut found_file = false;

    for path in [&primary, &backup] {
        if !path.exists() {
            continue;
        }
        found_file = true;
        if let Ok(contents) = fs::read_to_string(path) {
            if is_valid_state_json(&contents) {
                return Ok(Some(contents));
            }
        }
    }

    if found_file {
        Err("本地数据文件损坏，已停止写入以避免覆盖数据".to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn save_state(app: AppHandle, state: String) -> Result<(), String> {
    if !is_valid_state_json(&state) {
        return Err("拒绝保存无效的数据格式".to_string());
    }

    let (primary, backup, temporary) = state_paths(&app)?;
    fs::write(&temporary, state).map_err(|error| format!("无法写入临时数据文件: {error}"))?;

    if primary.exists() {
        fs::copy(&primary, &backup).map_err(|error| format!("无法创建数据备份: {error}"))?;
        fs::remove_file(&primary).map_err(|error| format!("无法替换旧数据文件: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, &primary) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法提交本地数据文件: {error}"));
    }

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![load_state, save_state])
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
