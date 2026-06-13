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

mod framing;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

/// JSON-RPC id used for the internal `initialize` request. A string id
/// keeps it from ever colliding with the numeric ids the frontend mints
/// for its own requests.
const INITIALIZE_ID: &str = "sable-initialize";

/// How to launch the server for a language.
struct ServerSpec {
    /// Human name for status messages.
    name: &'static str,
    /// Binary to launch (resolved against PATH and npm-global dirs).
    binary: &'static str,
    args: &'static [&'static str],
    /// Install hint shown if the binary is missing.
    install_hint: &'static str,
}

/// The one place that maps a file extension to a language server. Phase
/// 6e adds languages here and nowhere else.
fn server_for_extension(extension: &str) -> Option<ServerSpec> {
    match extension {
        "py" | "pyi" => Some(ServerSpec {
            name: "Pyright",
            binary: "pyright-langserver",
            args: &["--stdio"],
            install_hint: "Pyright not found — run `npm install -g pyright`",
        }),
        _ => None,
    }
}

/// Live server handle, held behind the manager's mutex. Holding `child`
/// keeps the process alive; `stdin` is written under the same lock so
/// outgoing frames never interleave.
struct LspHandle {
    #[allow(dead_code)] // kept alive intentionally; killed on shutdown
    child: Child,
    #[allow(dead_code)] // written to starting in phase 6b (didOpen/didChange)
    stdin: ChildStdin,
    extension: String,
}

#[derive(Default)]
pub struct LspManager {
    inner: AsyncMutex<Option<LspHandle>>,
}

/// Resolve a binary that may live outside the PATH inherited by a GUI /
/// spawned process. GUI apps on macOS routinely lack the user's shell
/// PATH, so we also probe the common npm-global locations directly.
fn resolve_binary(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.npm-global/bin/{name}").into());
        candidates.push(format!("{home}/.npm/bin/{name}").into());
    }
    candidates.push(format!("/usr/local/bin/{name}").into());
    candidates.push(format!("/opt/homebrew/bin/{name}").into());
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
/// the three features Sable wires up (sync, completion, hover, and
/// receiving diagnostics) so later sub-phases need no re-handshake.
fn initialize_params(root_path: &str) -> Value {
    let root_uri = path_to_uri(root_path);
    json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
        "capabilities": {
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
                "publishDiagnostics": {
                    "relatedInformation": false
                }
            }
        }
    })
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
    let mut guard = manager.inner.lock().await;
    // Already have a server for this language — nothing to do.
    if let Some(handle) = guard.as_ref() {
        if handle.extension == extension {
            return Ok(());
        }
    }

    let spec = server_for_extension(&extension)
        .ok_or_else(|| format!("No language server configured for .{extension}"))?;

    let binary = resolve_binary(spec.binary)
        .ok_or_else(|| spec.install_hint.to_string())?;

    let mut child = Command::new(&binary)
        .args(spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            format!("Could not start {}: {error}", spec.name)
        })?;

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
        "params": initialize_params(&root_path),
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
                return Err(format!("{} exited during handshake", spec.name))
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

    // Persistent reader: from here, every server message becomes an event.
    let reader_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = reader;
        loop {
            match framing::read_message(&mut reader).await {
                Ok(Some(payload)) => {
                    if let Ok(message) = serde_json::from_str::<Value>(&payload) {
                        let _ = reader_app.emit("lsp:message", message);
                    }
                }
                Ok(None) | Err(_) => {
                    let _ = reader_app.emit(
                        "lsp:status",
                        json!({ "state": "disconnected" }),
                    );
                    break;
                }
            }
        }
    });

    *guard = Some(LspHandle {
        child,
        stdin,
        extension,
    });

    let _ = app.emit(
        "lsp:status",
        json!({
            "state": "connected",
            "server": spec.name,
            "capabilities": capabilities,
        }),
    );
    Ok(())
}
