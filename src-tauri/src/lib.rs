// Sable — application entry point for the Rust backend.
//
// All OS-level functionality (filesystem, terminal PTY, search, watching,
// settings, AI provider calls)
// lives behind Tauri commands registered here. The frontend never touches
// the OS directly; it calls these commands via `invoke()`.

// The workspace half (files, search, git, terminals, language servers,
// running code) also builds without the desktop parts, as the remote
// agent (agent/) that serves it over SSH, WSL or a
// container.
pub mod acp;
pub mod agent;
mod commands;
pub mod events;
mod lsp;
pub mod notebook;
pub mod database;
pub mod github;
mod watcher;

mod debug;
mod launch_config;
#[cfg(feature = "desktop")]
mod plugins;
#[cfg(feature = "desktop")]
mod remote;
#[cfg(feature = "desktop")]
mod vscode;
#[cfg(feature = "desktop")]
mod vscode_theme;
#[cfg(feature = "desktop")]
mod devcontainer;
#[cfg(feature = "desktop")]
mod plugin_node;
#[cfg(feature = "desktop")]
mod windows;
// Claude Code (Anthropic's CLI) connects to Sable as its IDE.
#[cfg(feature = "desktop")]
mod claude_code;
#[cfg(all(test, feature = "desktop"))]
mod ui_bridge;

#[cfg(feature = "desktop")]
pub use remote::askpass_client;


#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Updates: signed builds from the GitHub releases (see README).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Web links (Markdown preview) open in the default browser.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Sable's private tools folder (e.g. basedpyright).
            use tauri::Manager;
            if let Ok(data) = app.path().app_data_dir() {
                lsp::set_tools_dir(data.join("tools"));
                commands::history::set_history_dir(data.join("history"));
                plugins::set_plugins_dir(data.join("plugins"));
                // Coding agents from the ACP registry (beside the remote
                // agent's own cache, agents/<version>/).
                acp::commands::set_agents_dir(data.join("agents"));
            }
            Ok(())
        })
        // Each window has its own workspace: its own watcher, terminals,
        // searches, language servers and debug sessions (windows.rs).
        .manage(windows::PerWindow::<watcher::WatcherState>::default())
        .manage(windows::PerWindow::<commands::terminal::TerminalState>::default())
        .manage(windows::PerWindow::<commands::search::SearchState>::default())
        .manage(windows::PerWindow::<lsp::LspManager>::default())
        .manage(windows::PerWindow::<debug::DebugManager>::default())
        .manage(windows::PerWindow::<notebook::NotebookState>::default())
        .manage(windows::PerWindow::<database::DatabaseState>::default())
        .manage(windows::PerWindow::<acp::AcpState>::default())
        .manage(windows::PerWindow::<claude_code::ClaudeCodeState>::default())
        .manage(commands::ai::AiState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                windows::closed(window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_directory,
            commands::history::history_list,
            commands::history::history_read,
            commands::history::history_deleted_files,
            commands::fs::read_file,
            commands::fs::read_file_base64,
            commands::fs::write_file_base64,
            commands::fs::write_file,
            commands::fs::is_directory,
            commands::fs::path_exists,
            commands::fs::real_path,
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
            commands::format::python_formatter,
            commands::format::format_with,
            commands::format::install_ruff,
            commands::refactor::python_refactor,
            commands::refactor::install_rope,
            commands::refactor_deep::python_rope_refactor,
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
            commands::git::git_stage_content,
            commands::git::git_conflict_versions,
            commands::git::git_merge_abort,
            commands::git::git_merge,
            commands::git::git_stash_list,
            commands::git::git_stash_save,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::git::git_cherry_pick,
            commands::git::git_revert_commit,
            commands::git::git_abort,
            commands::git::git_rebase,
            commands::git::git_rebase_interactive,
            commands::git::git_rebase_continue,
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
            lsp::install_typescript_server,
            lsp::install_php_server,
            lsp::python_server_has_semantic_tokens,
            debug::start_debug,
            debug::debug_request,
            debug::debug_stop,
            debug::install_debugpy,
            debug::install_js_debug,
            debug::debug_terminal_started,
            commands::terminal::create_command_terminal,
            debug::install_java_debug,
            debug::java_debug_installed,
            debug::start_java_debug,
            debug::start_attach,
            debug::list_processes,
            debug::jvm_debug_listen,
            debug::jvm_debug_accept,
            debug::jvm_debug_cancel,
            launch_config::debug_config_start,
            launch_config::debug_config_focus,
            launch_config::debug_config_stop,
            launch_config::debug_config_stop_all,
            launch_config::debug_config_terminal_started,
            launch_config::debug_config_environment,
            watcher::watch_workspace,
            plugins::plugin_list,
            plugins::plugin_inspect,
            plugins::plugin_install,
            plugins::plugin_uninstall,
            plugins::plugin_set_enabled,
            plugins::plugin_read_main,
            plugins::plugin_read_theme,
            plugins::plugin_discard,
            plugins::plugin_marketplace,
            plugins::plugin_fetch_readme,
            remote::remote_connect,
            remote::remote_disconnect,
            remote::remote_info,
            remote::remote_call,
            remote::remote_targets,
            remote::remote_forward_port,
            remote::remote_stop_forward,
            remote::remote_forwards,
            remote::remote_askpass_answer,
            devcontainer::devcontainer_exists,
            devcontainer::devcontainer_up,
            plugin_node::plugin_node_available,
            plugin_node::plugin_node_start,
            plugin_node::plugin_node_send,
            windows::new_window,
            windows::window_labels,
            windows::broadcast,
            watcher::watch_folders,
            plugin_node::plugin_node_stop,
            notebook::notebook_kernelspecs,
            notebook::notebook_start,
            notebook::notebook_send,
            notebook::notebook_stop,
            notebook::notebook_install_ipykernel,
            database::database_call,
            github::github_call,
            acp::commands::acp_call,
            acp::commands::acp_registry,
            acp::commands::acp_install,
            acp::commands::acp_link_local,
            acp::commands::acp_providers,
            acp::commands::acp_config,
            acp::commands::acp_set_config,
            acp::commands::acp_set_secret,
            acp::commands::acp_delete_secret,
            acp::commands::acp_secret_status,
            acp::commands::acp_start,
            acp::commands::acp_account_status,
            acp::commands::acp_terminal_spec,
            acp::commands::acp_threads_load,
            acp::commands::acp_threads_save,
            claude_code::claude_code_start,
            claude_code::claude_code_stop,
            claude_code::claude_code_status,
            claude_code::claude_code_set_folders,
            claude_code::claude_code_respond,
            claude_code::claude_code_notify,
            claude_code::claude_code_find_cli,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Quitting: no Claude Code lock file may outlive the app.
            if let tauri::RunEvent::Exit = event {
                claude_code::remove_all_locks();
            }
        });
}
