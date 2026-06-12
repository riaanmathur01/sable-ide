// Sable — application entry point for the Rust backend.
//
// All OS-level functionality (filesystem, terminal PTY, search, watching)
// lives behind Tauri commands registered here. The frontend never touches
// the OS directly; it calls these commands via `invoke()`.

mod commands;
mod watcher;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::WatcherState(Mutex::new(None)))
        .manage(commands::terminal::TerminalState(Mutex::new(
            HashMap::new(),
        )))
        .manage(commands::search::SearchState(Arc::new(AtomicU64::new(0))))
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_directory,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::is_directory,
            commands::fs::create_file,
            commands::fs::create_directory,
            commands::fs::delete_path,
            commands::fs::rename_path,
            commands::fs::move_path,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::kill_terminal,
            commands::search::search_workspace,
            watcher::watch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
