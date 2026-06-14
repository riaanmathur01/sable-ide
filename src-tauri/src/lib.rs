// Sable — application entry point for the Rust backend.
//
// All OS-level functionality (filesystem, terminal PTY, search, watching)
// lives behind Tauri commands registered here. The frontend never touches
// the OS directly; it calls these commands via `invoke()`.

mod commands;
mod lsp;
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
        .manage(lsp::LspManager::default())
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
            commands::search::list_workspace_files,
            commands::git::git_status,
            commands::git::git_file_diff,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_stage_all,
            commands::git::git_unstage_all,
            commands::git::git_commit,
            commands::git::git_set_identity,
            commands::git::git_branches,
            commands::git::git_create_branch,
            commands::git::git_switch_branch,
            commands::git::git_delete_branch,
            commands::git::git_ahead_behind,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::interpreter::discover_python_interpreters,
            commands::interpreter::create_python_venv,
            lsp::start_language_server,
            lsp::lsp_notify,
            lsp::lsp_request,
            watcher::watch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
