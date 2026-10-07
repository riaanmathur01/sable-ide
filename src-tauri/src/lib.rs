// Sable — application entry point for the Rust backend.
//
// All OS-level functionality (filesystem, terminal PTY, search, watching,
// settings, AI provider calls)
// lives behind Tauri commands registered here. The frontend never touches
// the OS directly; it calls these commands via `invoke()`.

mod commands;
mod debug;
mod lsp;
mod watcher;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Sable's private tools folder (e.g. basedpyright).
            use tauri::Manager;
            if let Ok(data) = app.path().app_data_dir() {
                lsp::set_tools_dir(data.join("tools"));
            }
            Ok(())
        })
        .manage(watcher::WatcherState(Mutex::new(None)))
        .manage(commands::terminal::TerminalState(Mutex::new(
            HashMap::new(),
        )))
        .manage(commands::search::SearchState(Arc::new(AtomicU64::new(0))))
        .manage(lsp::LspManager::default())
        .manage(debug::DebugManager::default())
        .manage(commands::ai::AiState::default())
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
            commands::search::search_text,
            commands::search::files_with_matches,
            commands::fonts::list_monospace_fonts,
            commands::settings::settings_path,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::shell::run_shell,
            commands::ai::ai_set_api_key,
            commands::ai::ai_delete_api_key,
            commands::ai::ai_key_status,
            commands::ai::ai_complete,
            commands::ai::ai_list_models,
            commands::ai::ai_stream,
            commands::ai::ai_cancel,
            commands::ai::load_chats,
            commands::ai::save_chats,
            commands::git::git_status,
            commands::git::git_file_diff,
            commands::git::git_log,
            commands::git::git_commit_files,
            commands::git::git_commit_file_diff,
            commands::git::git_blame,
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
            lsp::stop_language_servers,
            lsp::lsp_set_python_path,
            lsp::install_basedpyright,
            lsp::python_server_has_semantic_tokens,
            debug::start_debug,
            debug::debug_request,
            debug::debug_stop,
            debug::install_debugpy,
            debug::install_js_debug,
            debug::install_java_debug,
            debug::java_debug_installed,
            debug::start_java_debug,
            watcher::watch_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
