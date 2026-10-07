//! User settings persistence. Settings live in a plain `settings.json` in
//! the OS app-config directory (e.g. ~/Library/Application Support/
//! com.riaanmathur.sable on macOS) so they survive reinstalls and can be
//! edited by hand. The frontend owns the schema and defaults; Rust only
//! reads and writes the file.
//!
//! API keys are deliberately NOT stored here — see `ai.rs` (OS keychain).

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("No config directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

/// Absolute path of settings.json (for "Open settings.json").
#[tauri::command]
pub fn settings_path(app: AppHandle) -> Result<String, String> {
    Ok(settings_file(&app)?.to_string_lossy().into_owned())
}

/// Read the user's settings. A missing file is an empty object (all
/// defaults); malformed JSON is an error so the UI can say so instead of
/// silently discarding the user's file.
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Value, String> {
    let path = settings_file(&app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(Default::default()))
        }
        Err(error) => return Err(format!("Could not read settings: {error}")),
    };
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("settings.json is not valid JSON: {error}"))
}

/// Write settings atomically (temp file + rename) so a crash mid-write
/// can never leave a truncated settings.json behind.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    let path = settings_file(&app)?;
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, format!("{text}\n"))
        .map_err(|error| format!("Could not write settings: {error}"))?;
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("Could not save settings: {error}"))
}
