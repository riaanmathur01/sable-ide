//! Workspace file watcher. Watches the open folder recursively and tells
//! the frontend which *directories* changed so it can re-read just those
//! listings. Events are debounced so a burst of disk activity (git
//! checkout, npm install) becomes a handful of UI refreshes, not
//! thousands.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(300);

/// Holds the active watcher. Replacing it drops the previous watcher,
/// which closes its channel and ends the old forwarding thread.
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Start (or restart) watching a workspace root. Changed paths are
/// collapsed to their parent directories and emitted to the frontend as
/// an `fs:changed` event carrying `Vec<String>` of directory paths.
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: State<WatcherState>,
    path: String,
) -> Result<(), String> {
    let (event_sender, event_receiver) = std::sync::mpsc::channel();

    let mut watcher = notify::recommended_watcher(event_sender)
        .map_err(|error| format!("Could not create file watcher: {error}"))?;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch {path}: {error}"))?;

    // Swap in the new watcher; dropping the old one disconnects its
    // channel and the old thread below exits on `Disconnected`.
    *state.0.lock().unwrap() = Some(watcher);

    std::thread::spawn(move || {
        let mut changed_directories: HashSet<String> = HashSet::new();
        let mut last_flush = Instant::now();
        loop {
            match event_receiver.recv_timeout(DEBOUNCE_WINDOW) {
                Ok(Ok(event)) => {
                    for changed_path in event.paths {
                        // A created/deleted/renamed entry means its parent's
                        // listing is stale.
                        if let Some(parent) = changed_path.parent() {
                            changed_directories
                                .insert(parent.to_string_lossy().into_owned());
                        }
                    }
                }
                Ok(Err(_)) => {} // per-event watcher error; ignore
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !changed_directories.is_empty()
                && last_flush.elapsed() >= DEBOUNCE_WINDOW
            {
                let directories: Vec<String> =
                    changed_directories.drain().collect();
                let _ = app.emit("fs:changed", directories);
                last_flush = Instant::now();
            }
        }
    });

    Ok(())
}
