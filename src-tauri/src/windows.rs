//! Several windows, each with its own workspace (folders, terminals,
//! language servers, searches, debug sessions, remote connection), like
//! VS Code's. Window-scoped backend state lives in a `PerWindow`, keyed by
//! window label; events go to the window that asked (events::for_window);
//! closing a window stops what it was running.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// One `T` per window, made on first use.
pub struct PerWindow<T>(Mutex<HashMap<String, Arc<T>>>);

impl<T> Default for PerWindow<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T: Default> PerWindow<T> {
    pub fn get(&self, label: &str) -> Arc<T> {
        self.0.lock().unwrap().entry(label.to_string()).or_default().clone()
    }

    pub fn remove(&self, label: &str) -> Option<Arc<T>> {
        self.0.lock().unwrap().remove(label)
    }
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(2);

/// Open another window. `query` (e.g. `folder=/path`) tells it what to
/// open; without one it starts empty.
#[tauri::command]
pub fn new_window(app: AppHandle, query: Option<String>) -> Result<String, String> {
    open(&app, query)
}

pub fn open(app: &AppHandle, query: Option<String>) -> Result<String, String> {
    let label = format!("window-{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst));
    let path = match query.filter(|query| !query.is_empty()) {
        Some(query) => format!("index.html?{query}"),
        None => "index.html".to_string(),
    };
    // Offset from the focused window, as new windows usually are.
    let position = app
        .webview_windows()
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .and_then(|window| window.outer_position().ok().zip(window.scale_factor().ok()))
        .map(|(position, scale)| (position.x as f64 / scale + 28.0, position.y as f64 / scale + 28.0));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(path.into()))
        .title("Sable")
        .inner_size(1280.0, 820.0)
        .min_inner_size(640.0, 400.0)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::webview::Color(0x0d, 0x0d, 0x0f, 0xff));
    if let Some((x, y)) = position {
        builder = builder.position(x, y);
    }
    builder.build().map_err(|error| format!("Couldn't open a window: {error}"))?;
    Ok(label)
}

/// The labels of the open windows.
#[tauri::command]
pub fn window_labels(app: AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
}

/// Tell every window (settings or plugins changed in one of them).
#[tauri::command]
pub fn broadcast(app: AppHandle, event: String, payload: serde_json::Value) -> Result<(), String> {
    if !event.starts_with("sable:") {
        return Err("Only sable: events can be broadcast".into());
    }
    app.emit(&event, payload).map_err(|error| error.to_string())
}

/// A window closed: stop everything it was running.
pub fn closed(app: &AppHandle, label: &str) {
    if let Some(watcher) = app.state::<PerWindow<crate::watcher::WatcherState>>().remove(label) {
        watcher.0.lock().unwrap().clear();
    }
    if let Some(terminals) = app.state::<PerWindow<crate::commands::terminal::TerminalState>>().remove(label) {
        crate::commands::terminal::kill_all(&terminals);
    }
    app.state::<PerWindow<crate::commands::search::SearchState>>().remove(label);
    let lsp = app.state::<PerWindow<crate::lsp::LspManager>>().remove(label);
    let debug = app.state::<PerWindow<crate::debug::DebugManager>>().remove(label);
    let notebooks = app.state::<PerWindow<crate::notebook::NotebookState>>().remove(label);
    if let Some(databases) = app.state::<PerWindow<crate::database::DatabaseState>>().remove(label) {
        databases.interrupt_all();
    }
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        if let Some(lsp) = lsp {
            let _ = crate::lsp::stop_all(&lsp).await;
        }
        if let Some(debug) = debug {
            let _ = crate::debug::stop(&debug).await;
        }
        if let Some(notebooks) = notebooks {
            crate::notebook::stop_all(&notebooks).await;
        }
        crate::remote::disconnect(&label).await;
        crate::plugin_node::stop_window(&label);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_window_has_its_own_state() {
        let states: PerWindow<Mutex<Vec<u32>>> = PerWindow::default();
        states.get("main").lock().unwrap().push(1);
        states.get("window-2").lock().unwrap().push(2);
        assert_eq!(*states.get("main").lock().unwrap(), vec![1]);
        assert_eq!(*states.get("window-2").lock().unwrap(), vec![2]);
        // A closed window's state goes; a new one starts empty.
        assert!(states.remove("window-2").is_some());
        assert!(states.get("window-2").lock().unwrap().is_empty());
    }
}
