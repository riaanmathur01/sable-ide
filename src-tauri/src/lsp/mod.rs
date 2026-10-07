//! Language Server Protocol plumbing.
//!
//! Rust owns the language-server child process; the frontend never spawns
//! anything. The split:
//!   - `start_language_server` spawns the server for a file's language and
//!     performs the `initialize` / `initialized` handshake (which must
//!     complete before any feature request is valid).
//!   - A background reader task decodes framed messages from the server's
//!     stdout and forwards them to the frontend as `lsp:message` events.
//!   - `lsp_request` / `lsp_notify` (added in later sub-phases) write
//!     framed messages to the server's stdin.
//!
//! Everything except `server_for_extension` is language-agnostic, so
//! adding a language (phase 6e) is a single entry in that function.

// Shared with the DAP debug module — the Content-Length framing is
// protocol-agnostic (LSP and DAP use the same wire format).
pub(crate) mod framing;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

/// JSON-RPC id used for the internal `initialize` request. A string id
/// keeps it from ever colliding with the numeric ids the frontend mints
/// for its own requests.
const INITIALIZE_ID: &str = "sable-initialize";

/// How to launch the server for a language.
struct ServerSpec {
    /// Stable id used as the per-language key in the manager's map, so
    /// several servers (e.g. Pyright + jdtls) run side by side. Multiple
    /// extensions can share one id (ts/tsx/js → "typescript").
    id: String,
    /// Human name for status messages.
    name: String,
    /// Binary to launch (resolved against PATH and common dirs).
    binary: String,
    args: Vec<String>,
    /// Install hint shown if the binary is missing.
    install_hint: String,
}

/// Map a file extension to its server id (the routing key). This is the
/// one place languages are registered; everything else is generic.
fn server_id_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "py" | "pyi" => Some("pyright"),
        "java" => Some("java"),
        "rs" => Some("rust-analyzer"),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => Some("typescript"),
        "go" => Some("gopls"),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => Some("clangd"),
        // JS/TS intelligence is provided by Monaco's built-in language
        // service; a typescript-language-server entry can be added here
        // when we want full LSP for it.
        _ => None,
    }
}

/// jdtls needs a writable, per-project workspace data directory (it caches
/// its index there). Derive a stable one under the OS temp dir from the
/// project root.
fn jdtls_data_dir(root: &str) -> String {
    let sanitized: String = root
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let dir = std::env::temp_dir().join("sable-jdtls").join(sanitized);
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().into_owned()
}

/// Full launch spec for the server handling `extension`. `root` is the
/// workspace folder — used as the project root and (for jdtls) to place
/// the data directory.
fn server_for_extension(extension: &str, root: &str) -> Option<ServerSpec> {
    let id = server_id_for_extension(extension)?;
    Some(match id {
        // basedpyright (a Pyright fork) when installed — it adds semantic
        // highlighting (parameters, self, builtins, …); plain Pyright
        // otherwise. Same id either way: one Python server.
        "pyright" => {
            let based = resolve_binary("basedpyright-langserver").is_some();
            ServerSpec {
                id: id.into(),
                name: if based { "basedpyright" } else { "Pyright" }.into(),
                binary: if based { "basedpyright-langserver" } else { "pyright-langserver" }.into(),
                args: vec!["--stdio".into()],
                install_hint: "Pyright not found — run `npm install -g pyright`".into(),
            }
        }
        // TypeScript/JavaScript through tsserver: understands the project
        // (tsconfig, node_modules), unlike Monaco's in-browser service.
        "typescript" => ServerSpec {
            id: id.into(),
            name: "TypeScript".into(),
            binary: "typescript-language-server".into(),
            args: vec!["--stdio".into()],
            install_hint: "typescript-language-server not found — run \
                `npm install -g typescript-language-server typescript`"
                .into(),
        },
        // jdtls is the Eclipse JDT server; the Homebrew wrapper figures out
        // the equinox launcher + config_mac, so we only pass `-data`. It
        // runs on the system JDK and indexes the project on startup, so the
        // first completions can lag several seconds.
        "java" => ServerSpec {
            id: id.into(),
            name: "Java (jdtls)".into(),
            binary: "jdtls".into(),
            args: vec!["-data".into(), jdtls_data_dir(root)],
            install_hint: "jdtls not found — run `brew install jdtls` \
                (requires a JDK on PATH)"
                .into(),
        },
        "rust-analyzer" => ServerSpec {
            id: id.into(),
            name: "rust-analyzer".into(),
            binary: "rust-analyzer".into(),
            args: vec![],
            install_hint: "rust-analyzer not found — run `rustup component add rust-analyzer`"
                .into(),
        },
        "gopls" => ServerSpec {
            id: id.into(),
            name: "gopls".into(),
            binary: "gopls".into(),
            args: vec![],
            install_hint:
                "gopls not found — run `go install golang.org/x/tools/gopls@latest`".into(),
        },
        "clangd" => ServerSpec {
            id: id.into(),
            name: "clangd".into(),
            binary: "clangd".into(),
            args: vec!["--background-index".into()],
            install_hint: "clangd not found — run `brew install llvm` \
                (or install the Xcode Command Line Tools)"
                .into(),
        },
        _ => return None,
    })
}

/// Live server handle. Holding `child` keeps the process alive. All
/// outgoing frames go through `writer` — a channel drained by a single
/// writer task that owns the child's stdin — so the command path and the
/// reader loop (which must answer the server's own requests) never fight
/// over stdin.
struct LspHandle {
    /// Kept alive while registered; killed by `stop_language_servers`.
    child: Child,
    writer: mpsc::UnboundedSender<String>,
}

/// One language server per server id, so multiple run concurrently
/// (Pyright for .py, jdtls for .java, …). `starting` guards against
/// double-spawning while a slow server (jdtls) is still handshaking — and
/// lets us release the lock during that handshake so other servers stay
/// responsive.
#[derive(Default)]
struct LspState {
    servers: HashMap<String, LspHandle>,
    starting: std::collections::HashSet<String>,
    /// Bumped by `stop_language_servers` (workspace switch). A server whose
    /// handshake began under an older generation is discarded on arrival
    /// instead of being registered against the new workspace.
    generation: u64,
}

#[derive(Default)]
pub struct LspManager(AsyncMutex<LspState>);

/// Resolve a binary that may live outside the PATH inherited by a GUI /
/// spawned process. GUI apps on macOS routinely lack the user's shell
/// PATH, so we also probe the common npm-global locations directly.
/// Sable's private tools folder (an npm prefix in the app data dir), set
/// at startup. Tools Sable installs itself (basedpyright) live here.
static TOOLS_BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Sable's tools folder (the npm prefix), if set.
pub fn tools_dir() -> Option<PathBuf> {
    Some(TOOLS_BIN.get()?.parent()?.parent()?.to_path_buf())
}

/// Record the tools prefix (called once from app setup).
pub fn set_tools_dir(prefix: PathBuf) {
    let _ = TOOLS_BIN.set(prefix.join("node_modules").join(".bin"));
}

pub(crate) fn resolve_binary(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(tools) = TOOLS_BIN.get() {
        candidates.push(tools.join(name));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.npm-global/bin/{name}").into());
        candidates.push(format!("{home}/.npm/bin/{name}").into());
    }
    candidates.push(format!("/usr/local/bin/{name}").into());
    candidates.push(format!("/opt/homebrew/bin/{name}").into());
    // Toolchain-managed servers (rust-analyzer via rustup, gopls via
    // `go install`, clangd via Homebrew LLVM or the Xcode CLT).
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.cargo/bin/{name}").into());
        candidates.push(format!("{home}/go/bin/{name}").into());
    }
    candidates.push(format!("/opt/homebrew/opt/llvm/bin/{name}").into());
    candidates.push(format!("/usr/local/opt/llvm/bin/{name}").into());
    candidates.push(format!("/Library/Developer/CommandLineTools/usr/bin/{name}").into());
    // Windows npm global location.
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(format!("{appdata}\\npm\\{name}.cmd").into());
        candidates.push(format!("{appdata}\\npm\\{name}").into());
    }
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    // Fall back to scanning PATH ourselves (also covers Windows `.cmd`).
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let direct = dir.join(name);
            if direct.exists() {
                return Some(direct);
            }
            let windows_cmd = dir.join(format!("{name}.cmd"));
            if windows_cmd.exists() {
                return Some(windows_cmd);
            }
        }
    }
    None
}

/// Convert an absolute filesystem path to a `file://` URI. LSP identifies
/// every document by such a URI. Windows paths use backslashes and a
/// drive letter, which become `file:///C:/...`.
pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    // Percent-encode the few characters that would break a URI. Full RFC
    // 3986 encoding is overkill for filesystem paths; spaces and a couple
    // of delimiters are what actually bite.
    let encoded: String = normalized
        .chars()
        .map(|character| match character {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '%' => "%25".to_string(),
            other => other.to_string(),
        })
        .collect();
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        // Windows drive path: needs the extra leading slash.
        format!("file:///{encoded}")
    }
}

/// Build the `initialize` request params. Capabilities are declared for
/// the features Sable wires up (sync, completion, hover, definition,
/// signature help, code actions / quick fixes, and diagnostics).
/// The java-debug plugin jar (installed by `install_java_debug`). jdtls
/// loads it as a bundle, which adds the commands that start a Java debug
/// session.
pub fn java_debug_bundle() -> Option<PathBuf> {
    let jar = tools_dir()?.join("java-debug").join("com.microsoft.java.debug.plugin.jar");
    jar.exists().then_some(jar)
}

pub(crate) fn initialize_params(root_path: &str, server_id: &str) -> Value {
    let mut params = base_initialize_params(root_path);
    // gopls only sends semantic tokens (packages, exported names, …) when
    // asked.
    if server_id == "gopls" {
        params["initializationOptions"] = json!({ "semanticTokens": true });
    }
    if server_id == "java" {
        if let Some(jar) = java_debug_bundle() {
            params["initializationOptions"] = json!({ "bundles": [jar.to_string_lossy()] });
        }
    }
    params
}

fn base_initialize_params(root_path: &str) -> Value {
    let root_uri = path_to_uri(root_path);
    json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
        "capabilities": {
            "workspace": {
                // Declaring these lets the server pull settings from us via
                // `workspace/configuration` — which is how we switch Pyright
                // into whole-workspace analysis (diagnostics for every file,
                // not just open ones).
                "configuration": true,
                // Servers may push edits (e.g. after running a quick-fix
                // command); the frontend applies them.
                "applyEdit": true,
                // File operations let a rename move the file too (a Java
                // class's file follows the class).
                "workspaceEdit": {
                    "documentChanges": true,
                    "resourceOperations": ["create", "rename", "delete"]
                },
                "didChangeConfiguration": { "dynamicRegistration": true },
                // Sable reports files it changes on disk (e.g. a rename
                // editing unopened files).
                "didChangeWatchedFiles": { "dynamicRegistration": false }
            },
            "textDocument": {
                "synchronization": {
                    "dynamicRegistration": false,
                    "didSave": true
                },
                "completion": {
                    "completionItem": {
                        "snippetSupport": false,
                        "documentationFormat": ["markdown", "plaintext"]
                    }
                },
                "hover": {
                    "contentFormat": ["markdown", "plaintext"]
                },
                "definition": { "linkSupport": true },
                "signatureHelp": {
                    "signatureInformation": {
                        "documentationFormat": ["markdown", "plaintext"],
                        "parameterInformation": { "labelOffsetSupport": true }
                    }
                },
                // F2 / Shift+F6: the server says what's renameable first.
                "rename": {
                    "prepareSupport": true,
                    "prepareSupportDefaultBehavior": 1
                },
                "codeAction": {
                    "codeActionLiteralSupport": {
                        "codeActionKind": {
                            "valueSet": [
                                "", "quickfix", "refactor", "refactor.extract",
                                "refactor.inline", "refactor.rewrite", "source",
                                "source.organizeImports", "source.fixAll"
                            ]
                        }
                    },
                    "isPreferredSupport": true,
                    "dataSupport": true,
                    "resolveSupport": { "properties": ["edit"] }
                },
                // Semantic tokens: what each name *is* (parameter, self,
                // class, builtin, …), for JetBrains-style highlighting.
                "semanticTokens": {
                    "requests": { "full": true, "range": false },
                    "tokenTypes": [
                        "namespace", "type", "class", "enum", "interface", "struct",
                        "typeParameter", "parameter", "variable", "property", "enumMember",
                        "event", "function", "method", "macro", "keyword", "modifier",
                        "comment", "string", "number", "regexp", "operator", "decorator"
                    ],
                    "tokenModifiers": [
                        "declaration", "definition", "readonly", "static", "deprecated",
                        "abstract", "async", "modification", "documentation", "defaultLibrary"
                    ],
                    "formats": ["relative"],
                    "multilineTokenSupport": false,
                    "overlappingTokenSupport": false
                },
                "publishDiagnostics": {
                    "relatedInformation": false,
                    // Unnecessary (unused) / deprecated code renders faded
                    // / struck through.
                    "tagSupport": { "valueSet": [1, 2] },
                    "codeDescriptionSupport": true
                }
            }
        }
    })
}

/// The settings Sable feeds Pyright.
///   - `diagnosticMode: "workspace"` makes Pyright analyze every file in
///     the project, so errors surface in the explorer before a file is
///     opened.
///   - `exclude` keeps that workspace scan off heavy/irrelevant trees.
///     Without it, a project with a `.venv` makes Pyright analyze the
///     hundreds of installed-package files on every change — pegging the
///     CPU and starving the rest of the app (terminal included).
///   - `typeCheckingMode: "off"` (VS Code's default) reports genuine
///     breakage — syntax errors, undefined names, bad imports — without
///     the type-inference noise that flags working dynamic code or calls
///     into untyped third-party libraries.
fn python_settings() -> Value {
    let mut settings = json!({
        "analysis": {
            "diagnosticMode": "workspace",
            "typeCheckingMode": "off",
            // Genuine breakage stays visible regardless of mode (and of
            // which server runs: basedpyright's "off" drops these, Pyright
            // only warns). Both crash at runtime, so they're errors.
            "diagnosticSeverityOverrides": {
                "reportUndefinedVariable": "error",
                "reportMissingImports": "error",
                "reportMissingModuleSource": "warning"
            },
            "useLibraryCodeForTypes": true,
            "exclude": [
                "**/.*",
                "**/node_modules",
                "**/__pycache__",
                "**/venv",
                "**/env",
                "**/site-packages",
                "**/dist",
                "**/build"
            ]
        }
    });
    // The interpreter selected in Sable, so imports resolve against *its*
    // site-packages (e.g. the project's .venv) rather than whatever
    // python happens to be first on PATH.
    if let Some(python) = PYTHON_PATH.read().unwrap().clone() {
        settings["pythonPath"] = json!(python);
    }
    settings
}

/// The Python interpreter Pyright should analyze against (set from the
/// frontend's interpreter picker).
static PYTHON_PATH: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Answer to a `workspace/configuration` request, which asks for settings
/// per "section". We return our Python settings for the python sections
/// and null (server default) for anything else.
fn config_for_section(section: &str) -> Value {
    match section {
        "python" => python_settings(),
        // basedpyright reads its analysis settings from its own section.
        "python.analysis" | "basedpyright.analysis" => python_settings()["analysis"].clone(),
        "basedpyright" => json!({ "analysis": python_settings()["analysis"] }),
        _ => Value::Null,
    }
}

/// Handle a server→client request (it has both an `id` and a `method`)
/// and produce the `result` value to reply with. Unknown requests get a
/// null result so the server never stalls waiting on us.
fn server_request_result(method: &str, message: &Value) -> Value {
    match method {
        "workspace/configuration" => {
            let items = message
                .get("params")
                .and_then(|params| params.get("items"))
                .and_then(Value::as_array);
            let results = items
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            let section = item
                                .get("section")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            config_for_section(section)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Value::Array(results)
        }
        // The frontend applies the edit (forwarded by the reader loop).
        "workspace/applyEdit" => json!({ "applied": true }),
        // registerCapability, workDoneProgress/create, etc. — just ack.
        _ => Value::Null,
    }
}

/// Start (or no-op if already running for this language) the language
/// server for `extension`, completing the LSP handshake before returning.
#[tauri::command]
pub async fn start_language_server(
    app: AppHandle,
    manager: State<'_, LspManager>,
    extension: String,
    root_path: String,
) -> Result<(), String> {
    let spec = server_for_extension(&extension, &root_path)
        .ok_or_else(|| format!("No language server configured for .{extension}"))?;
    let server_id = spec.id.clone();

    // Reserve this server id (or bail if it's already running / starting),
    // then release the lock so the — possibly slow — handshake below
    // doesn't block other servers' requests.
    let generation = {
        let mut state = manager.0.lock().await;
        if state.servers.contains_key(&server_id)
            || state.starting.contains(&server_id)
        {
            return Ok(());
        }
        state.starting.insert(server_id.clone());
        state.generation
    };

    // From here, on any early return we must clear the `starting` flag.
    let result =
        spawn_and_handshake(&app, &spec, &root_path).await;
    match result {
        Ok((mut child, writer)) => {
            let mut state = manager.0.lock().await;
            if state.generation != generation {
                // The workspace changed mid-handshake; this server is
                // rooted at the old folder. Drop it.
                let _ = child.kill().await;
                return Ok(());
            }
            state.starting.remove(&server_id);
            state
                .servers
                .insert(server_id, LspHandle { child, writer });
            Ok(())
        }
        Err(error) => {
            let mut state = manager.0.lock().await;
            if state.generation == generation {
                state.starting.remove(&server_id);
            }
            Err(error)
        }
    }
}

/// Spawn the server and complete the handshake, returning its child +
/// writer channel. Factored out of the command so the manager lock can be
/// released during the (sometimes slow) handshake.
async fn spawn_and_handshake(
    app: &AppHandle,
    spec: &ServerSpec,
    root_path: &str,
) -> Result<(Child, mpsc::UnboundedSender<String>), String> {
    let _ = app.emit(
        "lsp:status",
        json!({ "state": "starting", "server": spec.name, "id": spec.id }),
    );

    let binary = resolve_binary(&spec.binary)
        .ok_or_else(|| spec.install_hint.clone())?;

    let mut child = Command::new(&binary)
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!("Could not start {}: {error}", spec.name)
        })?;

    // Surface the server's stderr to the dev log — the single most useful
    // diagnostic when a server (jdtls especially) fails to start or reply.
    if let Some(stderr) = child.stderr.take() {
        let name = spec.name.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[lsp {name}] {line}");
            }
        });
    }

    let is_pyright = spec.id == "pyright";
    let server_id = spec.id.clone();
    let server_name = spec.name.clone();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Language server has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Language server has no stdout".to_string())?;
    let mut reader = BufReader::new(stdout);

    // --- Handshake step 1: send `initialize` and await its response. ---
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": INITIALIZE_ID,
        "method": "initialize",
        "params": initialize_params(&root_path, &spec.id),
    });
    framing::write_message(&mut stdin, &initialize.to_string())
        .await
        .map_err(|error| format!("Failed to send initialize: {error}"))?;

    // Read until we see the response to our initialize id. The server may
    // emit notifications (logs, progress) first; forward those as events
    // and keep waiting for the matching response.
    let capabilities = loop {
        match framing::read_message(&mut reader).await {
            Ok(Some(payload)) => {
                let message: Value = match serde_json::from_str(&payload) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if message.get("id").and_then(Value::as_str) == Some(INITIALIZE_ID) {
                    if let Some(error) = message.get("error") {
                        return Err(format!("Server rejected initialize: {error}"));
                    }
                    break message
                        .get("result")
                        .and_then(|result| result.get("capabilities"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                // Pre-initialize notification — relay it to the frontend.
                let _ = app.emit("lsp:message", message);
            }
            Ok(None) => {
                return Err(format!("{server_name} exited during handshake"))
            }
            Err(error) => {
                return Err(format!("Handshake read error: {error}"))
            }
        }
    };

    // --- Handshake step 2: confirm with the `initialized` notification. ---
    let initialized = json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {},
    });
    framing::write_message(&mut stdin, &initialized.to_string())
        .await
        .map_err(|error| format!("Failed to send initialized: {error}"))?;

    // Writer task: the sole owner of the child's stdin. Everything that
    // sends to the server (feature requests, document sync, and the
    // reader's own request replies) funnels through this channel, so
    // frames never interleave.
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        let mut stdin = stdin;
        while let Some(payload) = writer_rx.recv().await {
            if framing::write_message(&mut stdin, &payload).await.is_err() {
                break; // server's stdin closed
            }
        }
    });

    // Pyright-only: push settings so it does workspace-wide analysis.
    // (It also pulls them back via workspace/configuration, which the
    // reader answers below.) Other servers use their defaults.
    if is_pyright {
        let _ = writer_tx.send(
            json!({
                "jsonrpc": "2.0",
                "method": "workspace/didChangeConfiguration",
                "params": { "settings": {
                    "python": python_settings(),
                    "basedpyright": { "analysis": python_settings()["analysis"] },
                } },
            })
            .to_string(),
        );
    }

    // Persistent reader. It distinguishes three kinds of message:
    //   - server→client REQUEST  (has id AND method): we must reply.
    //   - response               (has id, no method): forward to frontend.
    //   - notification           (method, no id): forward to frontend.
    let reader_app = app.clone();
    let reader_tx = writer_tx.clone();
    let reader_server_name = server_name.clone();
    let reader_server_id = server_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = reader;
        loop {
            match framing::read_message(&mut reader).await {
                Ok(Some(payload)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&payload)
                    else {
                        continue;
                    };
                    let method =
                        message.get("method").and_then(Value::as_str);
                    let id = message.get("id").cloned();
                    match (id, method) {
                        (Some(id), Some(method)) => {
                            // Server-pushed edits are applied by the
                            // frontend, so it needs to see this request.
                            if method == "workspace/applyEdit" {
                                let _ = reader_app.emit("lsp:message", message.clone());
                            }
                            // Server is asking us something — reply by id.
                            let result =
                                server_request_result(method, &message);
                            let _ = reader_tx.send(
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": result,
                                })
                                .to_string(),
                            );
                        }
                        _ => {
                            // Response or notification — let the frontend
                            // correlate / dispatch it.
                            let _ = reader_app.emit("lsp:message", message);
                        }
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = reader_app.emit(
                        "lsp:status",
                        json!({
                            "state": "disconnected",
                            "server": reader_server_name,
                            "id": reader_server_id,
                        }),
                    );
                    break;
                }
            }
        }
    });

    let _ = app.emit(
        "lsp:status",
        json!({
            "state": "connected",
            "server": server_name,
            "id": server_id,
            "capabilities": capabilities,
        }),
    );
    Ok((child, writer_tx))
}

/// Send a JSON-RPC *notification* (no id, no response) to the server that
/// handles `extension` — used for document sync (`didOpen`/`didChange`/
/// `didClose`). A no-op if that server isn't running.
#[tauri::command]
pub async fn lsp_notify(
    manager: State<'_, LspManager>,
    extension: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    let Some(server_id) = server_id_for_extension(&extension) else {
        return Ok(());
    };
    let state = manager.0.lock().await;
    let Some(handle) = state.servers.get(server_id) else {
        return Ok(()); // server for this language not running
    };
    let message = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    handle
        .writer
        .send(message.to_string())
        .map_err(|error| format!("Failed to send {method}: {error}"))?;
    Ok(())
}

/// Send a JSON-RPC *request* (has an id, expects a response) to the
/// server. The id is minted by the frontend; the server's response comes
/// back through the reader loop as an `lsp:message` event, which the
/// frontend correlates by that id.
#[tauri::command]
pub async fn lsp_request(
    manager: State<'_, LspManager>,
    extension: String,
    method: String,
    params: Value,
    id: i64,
) -> Result<(), String> {
    let server_id = server_id_for_extension(&extension)
        .ok_or_else(|| format!("No language server for .{extension}"))?;
    let state = manager.0.lock().await;
    let Some(handle) = state.servers.get(server_id) else {
        return Err(format!("Language server for .{extension} not running"));
    };
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    handle
        .writer
        .send(message.to_string())
        .map_err(|error| format!("Failed to send {method}: {error}"))?;
    Ok(())
}

/// Shut down every running language server. Called when the workspace
/// changes: servers are rooted at the folder they were started in, so
/// they must restart for the new one. Servers still mid-handshake are
/// discarded when they finish (see `generation`).
#[tauri::command]
pub async fn stop_language_servers(
    manager: State<'_, LspManager>,
) -> Result<(), String> {
    let handles: Vec<LspHandle> = {
        let mut state = manager.0.lock().await;
        state.generation += 1;
        state.starting.clear();
        state.servers.drain().map(|(_, handle)| handle).collect()
    };
    for mut handle in handles {
        let _ = handle.writer.send(
            json!({ "jsonrpc": "2.0", "id": "sable-shutdown", "method": "shutdown" })
                .to_string(),
        );
        let _ = handle.writer.send(
            json!({ "jsonrpc": "2.0", "method": "exit" }).to_string(),
        );
        // Give the polite exit a moment, then make sure it's gone.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = handle.child.kill().await;
    }
    Ok(())
}

/// Point Pyright at the selected Python interpreter. Pyright re-reads its
/// configuration on `didChangeConfiguration` (pulling `python.pythonPath`
/// via `workspace/configuration`) and re-resolves every import.
#[tauri::command]
pub async fn lsp_set_python_path(
    manager: State<'_, LspManager>,
    path: Option<String>,
) -> Result<(), String> {
    *PYTHON_PATH.write().unwrap() = path;
    let state = manager.0.lock().await;
    if let Some(handle) = state.servers.get("pyright") {
        let _ = handle.writer.send(
            json!({
                "jsonrpc": "2.0",
                "method": "workspace/didChangeConfiguration",
                "params": { "settings": {
                    "python": python_settings(),
                    "basedpyright": { "analysis": python_settings()["analysis"] },
                } },
            })
            .to_string(),
        );
    }
    Ok(())
}

/// Install basedpyright into Sable's private tools folder (an npm
/// prefix — a global install would clash with Pyright's `pyright`
/// command). Language servers restart afterwards to pick it up.
#[tauri::command]
pub async fn install_basedpyright() -> Result<(), String> {
    let bin = TOOLS_BIN.get().ok_or_else(|| "Tools folder unavailable".to_string())?;
    let prefix = bin
        .parent()
        .and_then(|modules| modules.parent())
        .ok_or_else(|| "Tools folder unavailable".to_string())?;
    std::fs::create_dir_all(prefix).map_err(|error| format!("Could not create tools folder: {error}"))?;
    let npm = resolve_binary("npm").ok_or_else(|| "npm not found — install Node.js first".to_string())?;
    let output = Command::new(&npm)
        .args(["install", "--prefix"])
        .arg(prefix)
        .args(["basedpyright", "--no-fund", "--no-audit"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not run npm: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "npm install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Whether the Python server would be basedpyright (semantic highlighting).
#[tauri::command]
pub fn python_server_has_semantic_tokens() -> bool {
    resolve_binary("basedpyright-langserver").is_some()
}
