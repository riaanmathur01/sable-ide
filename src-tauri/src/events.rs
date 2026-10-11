//! Where backend events go. In the app they're Tauri events to the
//! window; in the remote agent they're lines on stdout that the app turns
//! back into the same Tauri events. Code that streams (terminals, search,
//! the file watcher, language servers) emits through an `Events` and works
//! in both.

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub type Events = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Send `payload` as event `name`.
pub fn emit(events: &Events, name: &str, payload: impl Serialize) {
    if let Ok(value) = serde_json::to_value(payload) {
        events(name, value);
    }
}

/// Events for the app's window.
#[cfg(feature = "desktop")]
pub fn for_app(app: &tauri::AppHandle) -> Events {
    use tauri::Emitter;
    let app = app.clone();
    Arc::new(move |name, payload| {
        let _ = app.emit(name, payload);
    })
}
