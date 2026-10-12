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
use crate::events::{emit, Events};
#[cfg(feature = "desktop")]
use tauri::State;

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(300);

/// Holds the active watchers (one per workspace folder). Replacing them
/// drops the previous ones, which closes their channels and ends the old
/// forwarding threads.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Vec<RecommendedWatcher>>);

/// Start (or restart) watching a workspace root. Changed paths are
/// collapsed to their parent directories and emitted to the frontend as
/// an `fs:changed` event carrying `Vec<String>` of directory paths.
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn watch_workspace(
    window: tauri::WebviewWindow,
    states: State<crate::windows::PerWindow<WatcherState>>,
    path: String,
) -> Result<(), String> {
    watch_all(crate::events::for_window(&window), &states.get(window.label()), vec![path])
}

/// Watch every folder of a multi-root workspace (replacing what was watched).
#[cfg(feature = "desktop")]
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn watch_folders(
    window: tauri::WebviewWindow,
    states: State<crate::windows::PerWindow<WatcherState>>,
    paths: Vec<String>,
) -> Result<(), String> {
    watch_all(crate::events::for_window(&window), &states.get(window.label()), paths)
}

pub fn watch(events: Events, state: &WatcherState, path: String) -> Result<(), String> {
    watch_all(events, state, vec![path])
}

pub fn watch_all(events: Events, state: &WatcherState, paths: Vec<String>) -> Result<(), String> {
    let mut watchers = Vec::new();
    for path in paths {
        watchers.push(start(events.clone(), &path)?);
    }
    // Swap in the new watchers; dropping the old ones disconnects their
    // channels and their threads exit on `Disconnected`.
    *state.0.lock().unwrap() = watchers;
    Ok(())
}

fn start(events: Events, path: &str) -> Result<RecommendedWatcher, String> {
    let (event_sender, event_receiver) = std::sync::mpsc::channel();

    let mut watcher = notify::recommended_watcher(event_sender)
        .map_err(|error| format!("Could not create file watcher: {error}"))?;
    watcher
        .watch(Path::new(path), RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch {path}: {error}"))?;

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
                emit(&events, "fs:changed", directories);
                last_flush = Instant::now();
            }
        }
    });

    Ok(watcher)
}
