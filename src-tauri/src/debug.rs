//! Debug Adapter Protocol (DAP) plumbing — debugging via `debugpy`.
//!
//! Architecturally this is LSP's sibling (see src/lsp): an external adapter
//! process does the real work; Rust spawns it and relays messages to/from
//! the frontend. It reuses the LSP `Content-Length` framing (the wire
//! format is identical) but DAP is a different protocol, so it lives in
//! its own module.
//!
//! THE LAUNCH HANDSHAKE ORDERING is the easy thing to get subtly wrong and
//! the #1 cause of "breakpoints never hit". For debugpy it must be:
//!   1. → initialize request
//!   2. ← initialize response (capabilities)
//!   3. → launch request           (sent now; its response is deferred)
//!   4. ← `initialized` EVENT       (adapter: "ready for configuration")
//!   5. → setBreakpoints (per file) → configurationDone
//!   6. ← launch response, then the program runs and events stream.
//! `launch` is sent right after the initialize response because it's what
//! *triggers* the `initialized` event; breakpoints are configured when
//! that event arrives, not before. Sending breakpoints before the
//! `initialized` event (or skipping configurationDone) makes the program
//! run straight through.

use crate::lsp::framing;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::BufReader;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;

pub struct DebugSession {
    child: Child,
    /// Outgoing DAP messages funnel through here (single writer task owns
    /// the adapter's stdin).
    writer: mpsc::UnboundedSender<String>,
    /// Monotonic DAP message `seq` for requests Rust originates.
    seq: Arc<AtomicI64>,
}

#[derive(Default)]
pub struct DebugManager(pub AsyncMutex<Option<DebugSession>>);

/// Build a DAP request envelope.
fn request(seq: i64, command: &str, arguments: Value) -> String {
    json!({
        "seq": seq,
        "type": "request",
        "command": command,
        "arguments": arguments,
    })
    .to_string()
}

/// Start a debug session: spawn debugpy, run the launch handshake, and set
/// the given breakpoints. `breakpoints` maps an absolute file path to its
/// 1-based line numbers.
#[tauri::command]
pub async fn start_debug(
    app: AppHandle,
    manager: State<'_, DebugManager>,
    python: String,
    program: String,
    cwd: String,
    breakpoints: HashMap<String, Vec<i64>>,
) -> Result<(), String> {
    // Tear down any previous session first.
    if let Some(mut old) = manager.0.lock().await.take() {
        let _ = old.child.kill().await;
    }

    // debugpy must be importable by the interpreter we run the adapter with.
    let check = Command::new(&python)
        .args(["-c", "import debugpy"])
        .output()
        .await;
    if !check.map(|out| out.status.success()).unwrap_or(false) {
        return Err("debugpy not found — run `pip install debugpy`".to_string());
    }

    let mut child = Command::new(&python)
        .args(["-m", "debugpy.adapter"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start debugpy: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "debug adapter has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "debug adapter has no stdout".to_string())?;
    let mut reader = BufReader::new(stdout);

    let seq = Arc::new(AtomicI64::new(1));

    // --- 1. initialize → wait for its response. ---
    let initialize_seq = seq.fetch_add(1, Ordering::SeqCst);
    framing::write_message(
        &mut stdin,
        &request(
            initialize_seq,
            "initialize",
            json!({
                "clientID": "sable",
                "clientName": "Sable",
                "adapterID": "debugpy",
                "locale": "en",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsRunInTerminalRequest": false,
            }),
        ),
    )
    .await
    .map_err(|error| format!("Failed to send initialize: {error}"))?;

    loop {
        match framing::read_message(&mut reader).await {
            Ok(Some(payload)) => {
                let Ok(message) = serde_json::from_str::<Value>(&payload) else {
                    continue;
                };
                let is_init_response = message["type"] == "response"
                    && message["command"] == "initialize";
                let _ = app.emit("debug:message", message);
                if is_init_response {
                    break;
                }
            }
            Ok(None) => {
                return Err("debugpy exited during initialize".to_string())
            }
            Err(error) => return Err(format!("Handshake read error: {error}")),
        }
    }

    // Writer task owns stdin from here; everything outgoing goes through it.
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        let mut stdin = stdin;
        while let Some(payload) = writer_rx.recv().await {
            if framing::write_message(&mut stdin, &payload).await.is_err() {
                break;
            }
        }
    });

    // --- 2. launch (deferred response). Triggers the `initialized` event. ---
    let launch_seq = seq.fetch_add(1, Ordering::SeqCst);
    let _ = writer_tx.send(request(
        launch_seq,
        "launch",
        json!({
            "name": "Sable: Debug",
            "type": "python",
            "request": "launch",
            "program": program,
            "console": "internalConsole",
            "cwd": cwd,
            "stopOnEntry": false,
            "justMyCode": true,
            "redirectOutput": true,
        }),
    ));

    // --- Reader task: configures breakpoints on `initialized`, relays all. ---
    let reader_app = app.clone();
    let reader_writer = writer_tx.clone();
    let reader_seq = seq.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = reader;
        loop {
            match framing::read_message(&mut reader).await {
                Ok(Some(payload)) => {
                    let Ok(message) = serde_json::from_str::<Value>(&payload)
                    else {
                        continue;
                    };

                    // 3. On the `initialized` event, set breakpoints then
                    //    signal configuration is done — the program then runs.
                    if message["type"] == "event"
                        && message["event"] == "initialized"
                    {
                        for (file, lines) in &breakpoints {
                            let points: Vec<Value> = lines
                                .iter()
                                .map(|line| json!({ "line": line }))
                                .collect();
                            let bp_seq =
                                reader_seq.fetch_add(1, Ordering::SeqCst);
                            let _ = reader_writer.send(request(
                                bp_seq,
                                "setBreakpoints",
                                json!({
                                    "source": { "path": file },
                                    "breakpoints": points,
                                }),
                            ));
                        }
                        let done_seq =
                            reader_seq.fetch_add(1, Ordering::SeqCst);
                        let _ = reader_writer.send(request(
                            done_seq,
                            "configurationDone",
                            json!({}),
                        ));
                    }

                    let _ = reader_app.emit("debug:message", message);
                }
                Ok(None) | Err(_) => {
                    let _ = reader_app
                        .emit("debug:status", json!({ "state": "terminated" }));
                    break;
                }
            }
        }
    });

    *manager.0.lock().await = Some(DebugSession {
        child,
        writer: writer_tx,
        seq,
    });
    Ok(())
}

/// Send an arbitrary DAP request (stackTrace, step controls, etc.). The
/// frontend supplies the `seq` so it can correlate the response by
/// `request_seq`; frontend seqs start high enough never to collide with
/// the handshake seqs above.
#[tauri::command]
pub async fn debug_request(
    manager: State<'_, DebugManager>,
    seq: i64,
    command: String,
    arguments: Value,
) -> Result<(), String> {
    let guard = manager.0.lock().await;
    let session = guard
        .as_ref()
        .ok_or_else(|| "No debug session".to_string())?;
    session
        .writer
        .send(request(seq, &command, arguments))
        .map_err(|error| format!("Failed to send {command}: {error}"))
}

/// Stop debugging: ask the adapter to disconnect+terminate, then kill it.
#[tauri::command]
pub async fn debug_stop(
    manager: State<'_, DebugManager>,
) -> Result<(), String> {
    let session = manager.0.lock().await.take();
    if let Some(mut session) = session {
        let seq = session.seq.fetch_add(1, Ordering::SeqCst);
        let _ = session.writer.send(request(
            seq,
            "disconnect",
            json!({ "terminateDebuggee": true }),
        ));
        // Give the message a moment to flush before killing the adapter.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let _ = session.child.kill().await;
    }
    Ok(())
}
