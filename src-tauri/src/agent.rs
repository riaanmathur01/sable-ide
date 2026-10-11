//! The remote agent: Sable's workspace commands served over stdin/stdout,
//! so the app can edit, search, run and version-control a folder on
//! another machine (an SSH host, a WSL distro, a container).
//!
//! The app starts `sable-agent --stdio` (agent/) on the remote (src/remote.rs) and
//! talks JSON lines. After printing its ready line, the agent reads
//!
//!   {"id": 7, "cmd": "read_file", "args": {"path": "/home/me/x.rs"}}
//!
//! and answers `{"id": 7, "ok": <result>}` or `{"id": 7, "err": "..."}`.
//! Streams (terminal output, search results, language-server messages,
//! file changes) arrive as `{"event": "terminal:output", "payload": ...}`,
//! which the app re-emits to the window under the same name — so the
//! frontend works the same locally and remotely. Command names and
//! argument names are the Tauri commands' own (arguments in camelCase).

use crate::commands::{format, fs, git, history, interpreter, refactor, search, shell, terminal};
use crate::events::Events;
use crate::{lsp, watcher};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// What the agent prints, then its info as JSON, when it's ready. The app
/// skips anything before it (login scripts that print a banner).
pub const READY: &str = "SABLE-AGENT-READY ";

/// Sable's version (the agent is installed per version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The agent's protocol version; the app and agent must agree.
pub const PROTOCOL: u32 = 1;

/// The machine the agent runs on, sent with the ready line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub version: String,
    pub protocol: u32,
    pub os: String,
    pub arch: String,
    pub home: String,
    pub hostname: String,
    pub tmp: String,
}

/// Long-lived state: terminals, the file watcher, searches, servers.
#[derive(Default)]
pub struct AgentState {
    terminals: terminal::TerminalState,
    watcher: watcher::WatcherState,
    search: search::SearchState,
    lsp: lsp::LspManager,
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("argument {key}: {error}"))
}

fn ok<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

/// The commands a remote workspace needs. `None`: not a remote command.
pub async fn dispatch(state: &AgentState, events: &Events, command: &str, args: &Value) -> Option<Result<Value, String>> {
    let result: Result<Result<Value, String>, Fail> = async {
        Ok(match command {
            // --- Files -------------------------------------------------------------
            "read_directory" => ok(fs::read_directory(arg(args, "path")?)),
            "read_file" => ok(fs::read_file(arg(args, "path")?)),
            "read_file_base64" => ok(fs::read_file_base64(arg(args, "path")?)),
            "write_file" => ok(fs::write_file(arg(args, "path")?, arg(args, "contents")?)),
            "is_directory" => ok(fs::is_directory(arg(args, "path")?)),
            "path_exists" => ok(Ok(fs::path_exists(arg(args, "path")?))),
            "real_path" => ok(fs::real_path(arg(args, "path")?)),
            "create_file" => ok(fs::create_file(arg(args, "path")?)),
            "create_directory" => ok(fs::create_directory(arg(args, "path")?)),
            "delete_path" => ok(fs::delete_path(arg(args, "path")?)),
            "rename_path" => ok(fs::rename_path(arg(args, "path")?, arg(args, "newName")?)),
            "move_path" => ok(fs::move_path(arg(args, "source")?, arg(args, "targetDirectory")?)),
            "watch_workspace" => ok(watcher::watch(events.clone(), &state.watcher, arg(args, "path")?)),
            "history_list" => ok(Ok(history::history_list(arg(args, "path")?))),
            "history_read" => ok(history::history_read(arg(args, "path")?, arg(args, "id")?)),
            "history_deleted_files" => ok(Ok(history::history_deleted_files(arg(args, "root")?))),

            // --- Search --------------------------------------------------------------
            "list_workspace_files" => ok(search::list_workspace_files(arg(args, "root")?)),
            "search_workspace" => ok(search::search(
                events.clone(),
                &state.search,
                arg(args, "root")?,
                arg(args, "query")?,
                arg(args, "searchId")?,
                arg(args, "options")?,
            )),
            "search_text" => ok(search::search_text(
                arg(args, "root")?,
                arg(args, "query")?,
                arg(args, "isRegex")?,
                arg(args, "maxResults")?,
            )),
            "files_with_matches" => {
                ok(search::files_with_matches(arg(args, "root")?, arg(args, "query")?, arg(args, "options")?).await)
            }

            // --- Terminals and running things ------------------------------------------
            "create_terminal" => ok(terminal::open_terminal(
                events.clone(),
                &state.terminals,
                arg(args, "id")?,
                arg(args, "cols")?,
                arg(args, "rows")?,
                arg(args, "cwd")?,
            )),
            "create_command_terminal" => ok(terminal::open_command_terminal(
                events.clone(),
                &state.terminals,
                arg(args, "id")?,
                arg(args, "args")?,
                arg(args, "cwd")?,
                arg(args, "env")?,
                arg(args, "cols")?,
                arg(args, "rows")?,
            )),
            "write_terminal" => ok(terminal::write_to_terminal(&state.terminals, arg(args, "id")?, arg(args, "data")?)),
            "resize_terminal" => {
                ok(terminal::resize(&state.terminals, arg(args, "id")?, arg(args, "cols")?, arg(args, "rows")?))
            }
            "kill_terminal" => ok(terminal::kill(&state.terminals, arg(args, "id")?)),
            "run_shell" => {
                ok(shell::run_shell(arg(args, "command")?, arg(args, "cwd")?, arg(args, "timeoutSecs")?).await)
            }

            // --- Language servers, formatting, refactoring -------------------------------
            "start_language_server" => {
                ok(lsp::start(events.clone(), &state.lsp, arg(args, "extension")?, arg(args, "rootPath")?).await)
            }
            "lsp_notify" => ok(lsp::notify(&state.lsp, arg(args, "extension")?, arg(args, "method")?, arg(args, "params")?).await),
            "lsp_request" => ok(lsp::request(
                &state.lsp,
                arg(args, "extension")?,
                arg(args, "method")?,
                arg(args, "params")?,
                arg(args, "id")?,
            )
            .await),
            "stop_language_servers" => ok(lsp::stop_all(&state.lsp).await),
            "lsp_set_python_path" => ok(lsp::set_python_path(&state.lsp, arg(args, "path")?).await),
            "install_basedpyright" => ok(lsp::install_basedpyright().await),
            "install_typescript_server" => ok(lsp::install_typescript_server().await),
            "install_php_server" => ok(lsp::install_php_server().await),
            "python_server_has_semantic_tokens" => ok(Ok(lsp::python_server_has_semantic_tokens())),
            "python_formatter" => ok(Ok(format::python_formatter(arg(args, "python")?).await)),
            "format_with" => ok(format::format_with(arg(args, "formatter")?, arg(args, "path")?, arg(args, "text")?).await),
            "install_ruff" => ok(format::install_ruff().await),
            "python_refactor" => ok(refactor::python_refactor(
                arg(args, "python")?,
                arg(args, "root")?,
                arg(args, "file")?,
                arg(args, "kind")?,
                arg(args, "start")?,
                arg(args, "end")?,
                arg(args, "name")?,
            )
            .await),
            "install_rope" => ok(refactor::install_rope(arg(args, "python")?).await),
            "discover_python_interpreters" => ok(Ok(interpreter::discover_python_interpreters(arg(args, "root")?))),
            "create_python_venv" => ok(interpreter::create_python_venv(arg(args, "base")?, arg(args, "targetDir")?)),

            // --- Git -------------------------------------------------------------------
            "git_status" => ok(git::git_status(arg(args, "path")?)),
            "git_stage" => ok(git::git_stage(arg(args, "root")?, arg(args, "file")?)),
            "git_unstage" => ok(git::git_unstage(arg(args, "root")?, arg(args, "file")?)),
            "git_stage_all" => ok(git::git_stage_all(arg(args, "root")?)),
            "git_unstage_all" => ok(git::git_unstage_all(arg(args, "root")?)),
            "git_stage_content" => ok(git::git_stage_content(arg(args, "root")?, arg(args, "file")?, arg(args, "content")?)),
            "git_commit" => ok(git::git_commit(arg(args, "root")?, arg(args, "message")?)),
            "git_conflict_versions" => ok(git::git_conflict_versions(arg(args, "root")?, arg(args, "file")?)),
            "git_merge_abort" => ok(git::git_merge_abort(arg(args, "root")?)),
            "git_merge" => ok(git::git_merge(arg(args, "root")?, arg(args, "branch")?).await),
            "git_file_diff" => ok(git::git_file_diff(arg(args, "root")?, arg(args, "file")?, arg(args, "staged")?)),
            "git_log" => ok(git::git_log(arg(args, "root")?, arg(args, "limit")?, arg(args, "skip")?, arg(args, "branch")?)),
            "git_stash_list" => ok(git::git_stash_list(arg(args, "root")?)),
            "git_stash_save" => {
                ok(git::git_stash_save(arg(args, "root")?, arg(args, "message")?, arg(args, "includeUntracked")?).await)
            }
            "git_stash_apply" => ok(git::git_stash_apply(arg(args, "root")?, arg(args, "index")?, arg(args, "pop")?).await),
            "git_stash_drop" => ok(git::git_stash_drop(arg(args, "root")?, arg(args, "index")?).await),
            "git_cherry_pick" => ok(git::git_cherry_pick(arg(args, "root")?, arg(args, "hash")?).await),
            "git_revert_commit" => ok(git::git_revert_commit(arg(args, "root")?, arg(args, "hash")?).await),
            "git_abort" => ok(git::git_abort(arg(args, "root")?).await),
            "git_rebase" => ok(git::git_rebase(arg(args, "root")?, arg(args, "onto")?).await),
            "git_rebase_interactive" => {
                ok(git::git_rebase_interactive(arg(args, "root")?, arg(args, "base")?, arg(args, "steps")?).await)
            }
            "git_rebase_continue" => ok(git::git_rebase_continue(arg(args, "root")?, arg(args, "skip")?).await),
            "git_commit_files" => ok(git::git_commit_files(arg(args, "root")?, arg(args, "hash")?)),
            "git_commit_file_diff" => ok(git::git_commit_file_diff(arg(args, "root")?, arg(args, "hash")?, arg(args, "file")?)),
            "git_blame" => ok(git::git_blame(arg(args, "root")?, arg(args, "file")?)),
            "git_branches" => ok(git::git_branches(arg(args, "root")?)),
            "git_create_branch" => ok(git::git_create_branch(arg(args, "root")?, arg(args, "name")?)),
            "git_switch_branch" => ok(git::git_switch_branch(arg(args, "root")?, arg(args, "name")?)),
            "git_delete_branch" => ok(git::git_delete_branch(arg(args, "root")?, arg(args, "name")?)),
            "git_ahead_behind" => ok(git::git_ahead_behind(arg(args, "root")?)),
            "git_set_identity" => ok(git::git_set_identity(arg(args, "name")?, arg(args, "email")?)),
            "git_fetch" => ok(git::git_fetch(arg(args, "root")?).await),
            "git_pull" => ok(git::git_pull(arg(args, "root")?).await),
            "git_push" => ok(git::git_push(arg(args, "root")?).await),

            _ => return Err(Fail::Unknown),
        })
    }
    .await;
    match result {
        Ok(value) => Some(value),
        Err(Fail::Argument(error)) => Some(Err(error)),
        Err(Fail::Unknown) => None,
    }
}

/// Why `dispatch` couldn't run a command.
enum Fail {
    /// Not a remote command.
    Unknown,
    /// An argument that didn't parse.
    Argument(String),
}

impl From<String> for Fail {
    fn from(error: String) -> Self {
        Fail::Argument(error)
    }
}

/// This machine, for the ready line.
pub fn info() -> AgentInfo {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let hostname = std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .unwrap_or_default();
    AgentInfo {
        version: VERSION.to_string(),
        protocol: PROTOCOL,
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home,
        hostname,
        tmp: std::env::temp_dir().to_string_lossy().into_owned(),
    }
}

/// The agent's data folder (local history, installed tools), beside the
/// agent binaries: ~/.sable-server/data.
fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".sable-server").join("data")
}

/// Serve on stdin/stdout until stdin closes (the app disconnected).
pub async fn serve_stdio() {
    let data = data_dir();
    lsp::set_tools_dir(data.join("tools"));
    history::set_history_dir(data.join("history"));

    // One writer owns stdout, so lines never interleave.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    let ready = format!("{READY}{}", serde_json::to_string(&info()).unwrap_or_default());
    let _ = out_tx.send(ready);

    let event_tx = out_tx.clone();
    let events: Events = Arc::new(move |name, payload| {
        let _ = event_tx.send(json!({ "event": name, "payload": payload }).to_string());
    });
    let state = Arc::new(AgentState::default());

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let command = request.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
        let args = request.get("args").cloned().unwrap_or(Value::Null);
        let state = state.clone();
        let events = events.clone();
        let out_tx = out_tx.clone();
        // Each request on its own task: a slow one (a language server's
        // handshake, git push) mustn't hold up the rest.
        tokio::spawn(async move {
            let reply = match dispatch(&state, &events, &command, &args).await {
                Some(Ok(value)) => json!({ "id": id, "ok": value }),
                Some(Err(error)) => json!({ "id": id, "err": error }),
                None => json!({ "id": id, "err": format!("The remote agent doesn't support {command}") }),
            };
            let _ = out_tx.send(reply.to_string());
        });
    }

    // The app went away: stop servers and terminals with us.
    let _ = lsp::stop_all(&state.lsp).await;
    drop(out_tx);
    drop(events);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    /// The frontend routes exactly the commands the agent serves
    /// (src/lib/backend.ts REMOTE_COMMANDS).
    #[test]
    fn frontend_routes_what_the_agent_serves() {
        let source = include_str!("agent.rs");
        let table = &source[source.find("pub async fn dispatch").unwrap()..source.find("_ => return Err(Fail::Unknown)").unwrap()];
        let mut served: Vec<&str> = table
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\" =>").map(|(name, _)| name))
            .collect();
        let frontend = include_str!("../../src/lib/backend.ts");
        let set = &frontend[frontend.find("REMOTE_COMMANDS = new Set([").unwrap()..];
        let set = &set[..set.find("]);").unwrap()];
        let mut routed: Vec<&str> = set
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
            .collect();
        served.sort_unstable();
        routed.sort_unstable();
        assert!(served.len() > 70, "found only {} commands", served.len());
        assert_eq!(served, routed);
    }
}
