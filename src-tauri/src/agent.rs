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
use crate::{debug, lsp, notebook, watcher};
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

/// Long-lived state: terminals, the file watcher, searches, servers,
/// port tunnels.
#[derive(Default)]
pub struct AgentState {
    terminals: terminal::TerminalState,
    watcher: watcher::WatcherState,
    search: search::SearchState,
    lsp: lsp::LspManager,
    debug: debug::DebugManager,
    notebooks: notebook::NotebookState,
    tunnels: std::sync::Mutex<std::collections::HashMap<u64, mpsc::UnboundedSender<Vec<u8>>>>,
    watching_ports: std::sync::atomic::AtomicBool,
}

// --- Ports: what's listening here, and tunnels to it --------------------------------------

/// A TCP port something listens on (on this machine's loopback or all
/// interfaces — the ones a browser on the other end would want).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct ListeningPort {
    pub port: u16,
}

/// Listening ports from /proc/net/tcp{,6} (Linux) or lsof (macOS).
pub fn listening_ports() -> Vec<ListeningPort> {
    let mut ports = std::collections::BTreeSet::new();
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // local_address is "ADDR:PORT" in hex; state 0A is LISTEN.
            if fields.len() < 4 || fields[3] != "0A" {
                continue;
            }
            let Some((address, port)) = fields[1].split_once(':') else { continue };
            let reachable = matches!(
                address,
                "0100007F" | "00000000" | "00000000000000000000000000000000" | "00000000000000000000000001000000"
            );
            if let (true, Ok(port)) = (reachable, u16::from_str_radix(port, 16)) {
                ports.insert(port);
            }
        }
    }
    if ports.is_empty() && cfg!(windows) {
        // "  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING"
        if let Ok(output) = std::process::Command::new("netstat").args(["-an", "-p", "tcp"]).output() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() >= 4 && fields[3] == "LISTENING" {
                    let local = fields[1];
                    let reachable = local.starts_with("127.0.0.1:") || local.starts_with("0.0.0.0:");
                    if let (true, Some(port)) = (reachable, local.rsplit(':').next().and_then(|port| port.parse().ok())) {
                        ports.insert(port);
                    }
                }
            }
        }
    }
    if ports.is_empty() && cfg!(target_os = "macos") {
        if let Ok(output) = std::process::Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]).output() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let Some(name) = line.strip_prefix('n') else { continue };
                let local = name.starts_with("*:") || name.starts_with("127.0.0.1:") || name.starts_with("[::1]:") || name.starts_with("[::]:");
                if let (true, Some(port)) = (local, name.rsplit(':').next().and_then(|port| port.parse().ok())) {
                    ports.insert(port);
                }
            }
        }
    }
    ports.into_iter().map(|port| ListeningPort { port }).collect()
}

/// Tell the app whenever the set of listening ports changes.
fn watch_ports(state: &AgentState, events: &Events) {
    if state.watching_ports.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let events = events.clone();
    tokio::spawn(async move {
        let mut last: Option<Vec<ListeningPort>> = None;
        loop {
            let ports = tokio::task::spawn_blocking(listening_ports).await.unwrap_or_default();
            if last.as_ref() != Some(&ports) {
                crate::events::emit(&events, "ports:changed", &ports);
                last = Some(ports);
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

/// Connect tunnel `id` to `port` here; its bytes go back as
/// `tunnel:data` events (base64), and `tunnel:close` when it ends.
async fn open_tunnel(state: &AgentState, events: &Events, id: u64, port: u16) -> Result<(), String> {
    use base64::Engine;
    use tokio::io::AsyncReadExt;
    let stream = match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
        Ok(stream) => stream,
        Err(_) => tokio::net::TcpStream::connect(("::1", port))
            .await
            .map_err(|error| format!("Nothing answers on port {port}: {error}"))?,
    };
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    let (sender, mut incoming) = mpsc::unbounded_channel::<Vec<u8>>();
    state.tunnels.lock().unwrap().insert(id, sender);
    tokio::spawn(async move {
        while let Some(bytes) = incoming.recv().await {
            if bytes.is_empty() || writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });
    let events = events.clone();
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buffer[..count]);
                    crate::events::emit(&events, "tunnel:data", json!({ "id": id, "data": data }));
                }
            }
        }
        crate::events::emit(&events, "tunnel:close", json!({ "id": id }));
    });
    Ok(())
}

/// Bytes from the app for tunnel `id` (handled in order, not as a task).
fn write_tunnel(state: &AgentState, args: &Value) {
    use base64::Engine;
    let Some(id) = args.get("id").and_then(Value::as_u64) else { return };
    let data = args.get("data").and_then(Value::as_str).unwrap_or("");
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default();
    let tunnels = state.tunnels.lock().unwrap();
    if let Some(sender) = tunnels.get(&id) {
        // Empty means "the app closed it".
        let _ = sender.send(bytes);
    }
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
            "write_file_base64" => ok(fs::write_file_base64(arg(args, "path")?, arg(args, "data")?)),
            "is_directory" => ok(fs::is_directory(arg(args, "path")?)),
            "path_exists" => ok(Ok(fs::path_exists(arg(args, "path")?))),
            "real_path" => ok(fs::real_path(arg(args, "path")?)),
            "create_file" => ok(fs::create_file(arg(args, "path")?)),
            "create_directory" => ok(fs::create_directory(arg(args, "path")?)),
            "delete_path" => ok(fs::delete_path(arg(args, "path")?)),
            "rename_path" => ok(fs::rename_path(arg(args, "path")?, arg(args, "newName")?)),
            "move_path" => ok(fs::move_path(arg(args, "source")?, arg(args, "targetDirectory")?)),
            "watch_workspace" => ok(watcher::watch(events.clone(), &state.watcher, arg(args, "path")?)),
            "watch_folders" => ok(watcher::watch_all(events.clone(), &state.watcher, arg(args, "paths")?)),
            "history_list" => ok(Ok(history::history_list(arg(args, "path")?))),
            "history_read" => ok(history::history_read(arg(args, "path")?, arg(args, "id")?)),
            "history_deleted_files" => ok(Ok(history::history_deleted_files(arg(args, "root")?))),

            // --- Search --------------------------------------------------------------
            "list_workspace_files" => ok(search::list_workspace_files(arg(args, "root")?)),
            "search_workspace" => ok(search::search(
                events.clone(),
                &state.search,
                args.get("roots")
                    .and_then(|roots| serde_json::from_value::<Vec<String>>(roots.clone()).ok())
                    .filter(|roots| !roots.is_empty())
                    .map_or_else(|| arg(args, "root").map(|root| vec![root]), Ok)?,
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
            "ports_list" => ok(Ok(listening_ports())),
            "ports_watch" => {
                watch_ports(state, events);
                ok(Ok(()))
            }
            "tunnel_open" => ok(open_tunnel(state, events, arg(args, "id")?, arg(args, "port")?).await),
            "tunnel_close" => {
                let id: u64 = arg(args, "id")?;
                if let Some(sender) = state.tunnels.lock().unwrap().remove(&id) {
                    let _ = sender.send(Vec::new());
                }
                ok(Ok(()))
            }
            "run_shell" => {
                ok(shell::run_shell(arg(args, "command")?, arg(args, "cwd")?, arg(args, "timeoutSecs")?).await)
            }

            // --- Language servers, formatting, refactoring -------------------------------
            "start_language_server" => {
                let folders: Option<Vec<String>> = args.get("workspaceFolders").and_then(|value| serde_json::from_value(value.clone()).ok());
                ok(lsp::start_with_folders(events.clone(), &state.lsp, arg(args, "extension")?, arg(args, "rootPath")?, folders.unwrap_or_default()).await)
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

            // --- Debugging ---------------------------------------------------------------
            "start_debug" => ok(debug::launch(
                debug_events(events),
                &state.debug,
                arg(args, "program")?,
                arg(args, "cwd")?,
                arg(args, "python")?,
                arg(args, "breakpoints")?,
                arg(args, "options")?,
            )
            .await),
            "start_attach" => ok(debug::attach(debug_events(events), &state.debug, arg(args, "target")?, arg(args, "breakpoints")?).await),
            "start_java_debug" => ok(debug::launch_java(
                debug_events(events),
                &state.debug,
                arg(args, "port")?,
                arg(args, "launch")?,
                arg(args, "breakpoints")?,
            )
            .await),
            "debug_request" => ok(debug::send_request(&state.debug, arg(args, "seq")?, arg(args, "command")?, arg(args, "arguments")?).await),
            "debug_stop" => ok(debug::stop(&state.debug).await),
            "debug_terminal_started" => {
                ok(debug::terminal_started(&state.debug, arg(args, "id")?, arg(args, "processId")?, arg(args, "error")?).await)
            }
            "install_debugpy" => ok(debug::install_debugpy(arg(args, "python")?).await),
            "install_js_debug" => ok(debug::install_js_debug().await),
            "install_java_debug" => ok(debug::install_java_debug().await),
            "java_debug_installed" => ok(Ok(debug::java_debug_installed())),
            "list_processes" => ok(debug::list_processes().await),
            "jvm_debug_listen" => ok(debug::jvm_debug_listen().await),
            "jvm_debug_accept" => ok(debug::jvm_debug_accept(arg(args, "port")?, arg(args, "timeoutSecs")?).await),
            "jvm_debug_cancel" => {
                debug::jvm_debug_cancel(arg(args, "port")?);
                ok(Ok(()))
            }

            // --- Notebooks (Jupyter kernels) --------------------------------------------
            "notebook_kernelspecs" => ok(notebook::kernelspecs(arg(args, "python")?).await),
            "notebook_start" => ok(notebook::start(
                events.clone(),
                &state.notebooks,
                arg(args, "session")?,
                arg(args, "python")?,
                arg(args, "kernel")?,
                arg(args, "cwd")?,
            )
            .await),
            "notebook_send" => ok(notebook::send(&state.notebooks, arg(args, "session")?, arg(args, "message")?).await),
            "notebook_stop" => ok(notebook::stop(&state.notebooks, arg(args, "session")?).await),
            "notebook_install_ipykernel" => ok(notebook::install_ipykernel(arg(args, "python")?).await),

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

fn debug_events(events: &Events) -> Arc<dyn debug::DebugEvents> {
    Arc::new(debug::SinkEvents(events.clone()))
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
/// The user's home folder (USERPROFILE on Windows).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

pub fn info() -> AgentInfo {
    let home = home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_else(|| "/".to_string());
    let hostname = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
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
    home_dir().unwrap_or_else(std::env::temp_dir).join(".sable-server").join("data")
}

/// Serve on stdin/stdout until stdin closes (the app disconnected).
/// Remove agents of other Sable versions (~/.sable-server/bin/<version>).
/// A running one keeps working: Unix only unlinks the file.
fn remove_old_agents() {
    let Some(bin) = data_dir().parent().map(|server| server.join("bin")) else { return };
    let Ok(entries) = std::fs::read_dir(&bin) else { return };
    for entry in entries.flatten() {
        if entry.file_name() != VERSION && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub async fn serve_stdio() {
    let data = data_dir();
    tokio::task::spawn_blocking(remove_old_agents);
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
        // Tunnel bytes keep their order: handled here, with no reply.
        if command == "tunnel_write" {
            write_tunnel(&state, &args);
            continue;
        }
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

    // The app went away: stop servers, debuggers and terminals with us.
    let _ = debug::stop(&state.debug).await;
    let _ = lsp::stop_all(&state.lsp).await;
    notebook::stop_all(&state.notebooks).await;
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
