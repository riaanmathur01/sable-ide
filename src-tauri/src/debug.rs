//! Debug Adapter Protocol (DAP) plumbing.
//!
//! Architecturally this is LSP's sibling (see src/lsp): an external adapter
//! process does the real work; Rust spawns it and relays messages to/from
//! the frontend. It reuses the LSP `Content-Length` framing (the wire
//! format is identical) but DAP is a different protocol, so it lives in
//! its own module.
//!
//! Adapters:
//!   - Python         → debugpy (stdio)
//!   - C, C++, Rust   → lldb-dap (stdio); the program is compiled with
//!     debug info first
//!   - JavaScript/TS  → js-debug, VS Code's adapter (TCP); Sable installs
//!     it into its tools folder on first use
//!   - Go             → Delve, `dlv dap` (TCP)
//!   - Java           → java-debug inside jdtls (TCP, port from jdtls)
//!
//! A session is a set of *connections* to the adapter. Most adapters use
//! one; js-debug runs each target as a child session it asks the client to
//! open (the `startDebugging` reverse request), so a second connection is
//! made to the same server. The newest connection is the "active" one the
//! UI drives (threads, stack, stepping).
//!
//! THE LAUNCH HANDSHAKE ORDERING is the easy thing to get subtly wrong and
//! the #1 cause of "breakpoints never hit". Per connection:
//!   1. → initialize request
//!   2. ← initialize response (capabilities)
//!   3. → launch/attach request    (sent now; its response is deferred)
//!   4. ← `initialized` EVENT       (adapter: "ready for configuration")
//!   5. → setBreakpoints (per file) → setExceptionBreakpoints
//!      → configurationDone
//!   6. ← launch response, then the program runs and events stream.
//!
//! `launch` is sent right after the initialize response because it's what
//! *triggers* the `initialized` event for several adapters. Breakpoints are
//! configured when that event arrives, not before. Sending them earlier (or
//! skipping configurationDone) makes the program run straight through.

use crate::lsp::{framing, resolve_binary, tools_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio::sync::Mutex as AsyncMutex;

/// Where a session reports adapter traffic. The app forwards to the
/// frontend as Tauri events; tests collect into a channel.
pub trait DebugEvents: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

impl DebugEvents for AppHandle {
    fn emit(&self, event: &str, payload: Value) {
        let _ = Emitter::emit(self, event, payload);
    }
}

/// A process to run as the debug adapter.
pub struct Adapter {
    program: PathBuf,
    args: Vec<String>,
    /// Prepended to PATH (GUI apps lack the shell's PATH; Delve needs to
    /// find `go`).
    extra_path: Vec<PathBuf>,
}

/// How to talk to the adapter.
pub enum Transport {
    /// Over the adapter process's stdin/stdout.
    Stdio,
    /// The adapter is told to listen on port 0 and prints the address it
    /// chose ("…listening at 127.0.0.1:PORT"); connect there over TCP.
    TcpFromOutput,
    /// An adapter already listening on this local port (Java: jdtls
    /// starts it).
    Tcp(u16),
    /// Sable listens; the adapter is started in a terminal tab and dials
    /// in (`--client-addr`). The program it launches inherits that
    /// terminal, so it can read keyboard input (Delve has no
    /// runInTerminal of its own).
    TerminalDialIn,
}

/// Everything needed to start debugging one program.
pub struct LaunchPlan {
    /// None when the adapter already runs elsewhere (Java).
    adapter: Option<Adapter>,
    transport: Transport,
    adapter_id: &'static str,
    /// The `launch` request's arguments.
    launch: Value,
    /// Filters for setExceptionBreakpoints (e.g. debugpy's "uncaught").
    exception_filters: Vec<&'static str>,
}

/// State shared by every connection of one session.
struct SessionShared {
    events: Arc<dyn DebugEvents>,
    /// Current breakpoints (kept up to date by `setBreakpoints` requests),
    /// replayed into each new connection.
    breakpoints: Mutex<HashMap<String, Vec<i64>>>,
    exception_filters: Vec<&'static str>,
    adapter_id: &'static str,
    /// For child sessions (js-debug): the server to connect to again.
    address: Option<String>,
    /// Open connections' outgoing queues; the last is the active one.
    connections: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    /// `seq` for requests Rust originates.
    seq: AtomicI64,
    /// runInTerminal requests waiting for the frontend to start the
    /// program: id → (the asking connection, the request).
    pending_terminals: Mutex<HashMap<u64, (mpsc::UnboundedSender<String>, Value)>>,
    next_terminal: AtomicI64,
}

/// How to run the program: arguments, environment, working directory,
/// and whether it gets a terminal (so it can read keyboard input).
#[derive(Default, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub terminal: bool,
    /// C/C++/Rust: debug this already-built executable instead of
    /// building the file (e.g. a Cargo test binary).
    pub binary: Option<String>,
    /// Merged into the launch configuration last; a null value removes a
    /// key. E.g. debugging one test: `{"module": "pytest", "program":
    /// null, "args": [...]}` or Delve's `{"mode": "test", …}`.
    pub overrides: Option<Value>,
}

/// Apply run options to a launch configuration, in each adapter's terms.
fn apply_run_options(launch: &mut Value, adapter_id: &str, options: &RunOptions) {
    if let Some(cwd) = options.cwd.as_ref().filter(|cwd| !cwd.is_empty()) {
        launch["cwd"] = json!(cwd);
    }
    if !options.args.is_empty() {
        launch["args"] = json!(options.args);
    }
    if !options.env.is_empty() {
        launch["env"] = if adapter_id == "lldb-dap" {
            // lldb-dap takes "NAME=value" strings.
            json!(options.env.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>())
        } else {
            json!(options.env)
        };
    }
    if options.terminal {
        match adapter_id {
            "lldb-dap" => launch["runInTerminal"] = json!(true),
            _ => launch["console"] = json!("integratedTerminal"),
        }
        if let Some(object) = launch.as_object_mut() {
            // Output goes to the terminal, not (also) the debug console.
            object.remove("outputCapture");
            object.insert("redirectOutput".into(), json!(false));
        }
        if adapter_id != "debugpy" {
            launch.as_object_mut().map(|object| object.remove("redirectOutput"));
        }
    }
}

pub struct DebugSession {
    child: Option<Child>,
    shared: Arc<SessionShared>,
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

/// A synthetic `output` event, so build logs show in the debug console.
fn console_output(events: &dyn DebugEvents, category: &str, text: &str) {
    events.emit(
        "debug:message",
        json!({
            "type": "event",
            "event": "output",
            "body": { "category": category, "output": format!("{text}\n") },
        }),
    );
}

/// The languages Sable can debug, by file extension.
pub fn debug_language(program: &str) -> Option<&'static str> {
    let extension = Path::new(program).extension()?.to_str()?.to_lowercase();
    Some(match extension.as_str() {
        "py" | "pyw" => "python",
        // Node runs TypeScript directly (type stripping keeps line
        // numbers, so breakpoints line up without source maps).
        "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" => "node",
        "go" => "go",
        "c" => "c",
        "cc" | "cpp" | "cxx" | "c++" => "cpp",
        "rs" => "rust",
        _ => return None,
    })
}

/// Run a build step, streaming nothing but reporting failures with the
/// compiler's own message.
async fn run_build(
    events: &dyn DebugEvents,
    program: &Path,
    args: &[String],
    cwd: &Path,
) -> Result<std::process::Output, String> {
    console_output(
        events,
        "console",
        &format!("$ {} {}", program.display(), args.join(" ")),
    );
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not run {}: {error}", program.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        console_output(events, "stderr", stderr.trim_end());
        return Err("Build failed — see the Debug Console".to_string());
    }
    Ok(output)
}

/// A per-program output path for compiled debug binaries. The source
/// path's hash keeps `main.c` and `main.rs` (or two projects' `main.c`)
/// from overwriting each other.
fn debug_binary_path(program: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let stem = program
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "program".into());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    program.hash(&mut hasher);
    let dir = std::env::temp_dir().join("sable-debug");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{stem}-{:x}", hasher.finish()))
}

/// The nearest Cargo.toml at or above `program`, within `root`.
fn cargo_manifest_for(program: &Path, root: &Path) -> Option<PathBuf> {
    let mut directory = program.parent();
    while let Some(dir) = directory {
        let manifest = dir.join("Cargo.toml");
        if manifest.exists() {
            return Some(manifest);
        }
        if dir == root {
            break;
        }
        directory = dir.parent();
    }
    None
}

/// Compile (if needed) and describe how to debug `program`.
pub async fn prepare_launch(
    events: &dyn DebugEvents,
    program: &str,
    cwd: &str,
    python: Option<&str>,
    options: &RunOptions,
) -> Result<LaunchPlan, String> {
    let mut plan = plan_launch(events, program, cwd, python, options.binary.as_deref()).await?;
    apply_run_options(&mut plan.launch, plan.adapter_id, options);
    if let (Some(launch), Some(Value::Object(overrides))) = (plan.launch.as_object_mut(), &options.overrides) {
        for (key, value) in overrides {
            if value.is_null() {
                launch.remove(key);
            } else {
                launch.insert(key.clone(), value.clone());
            }
        }
    }
    if options.terminal && plan.adapter_id == "go" {
        plan.transport = Transport::TerminalDialIn;
        if let Some(object) = plan.launch.as_object_mut() {
            object.remove("console");
        }
    }
    Ok(plan)
}

async fn plan_launch(
    events: &dyn DebugEvents,
    program: &str,
    cwd: &str,
    python: Option<&str>,
    prebuilt: Option<&str>,
) -> Result<LaunchPlan, String> {
    let language = debug_language(program).ok_or_else(|| {
        "Debugging supports Python, JavaScript/TypeScript, Go, C, C++, and Rust files".to_string()
    })?;
    let program_path = Path::new(program);
    let cwd_path = Path::new(cwd);

    if language == "python" {
        let python = python.unwrap_or("python3");
        // debugpy must be importable by the interpreter we run it with.
        let check = Command::new(python)
            .args(["-c", "import debugpy"])
            .output()
            .await;
        if !check.map(|out| out.status.success()).unwrap_or(false) {
            return Err(format!("debugpy-missing:{python}"));
        }
        return Ok(LaunchPlan {
            adapter: Some(Adapter {
                program: PathBuf::from(python),
                args: vec!["-m".into(), "debugpy.adapter".into()],
                extra_path: vec![],
            }),
            transport: Transport::Stdio,
            adapter_id: "debugpy",
            launch: json!({
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
            exception_filters: vec!["uncaught"],
        });
    }

    if language == "node" {
        return node_plan(program, cwd);
    }
    if language == "go" {
        return go_plan(events, program, cwd);
    }

    // Native code: build with debug info, then debug the binary with
    // lldb-dap.
    let adapter = resolve_binary("lldb-dap").ok_or_else(|| {
        "lldb-dap not found — install the Xcode Command Line Tools \
         (`xcode-select --install`) or LLVM (`brew install llvm`)"
            .to_string()
    })?;
    let binary = match (language, prebuilt) {
        (_, Some(prebuilt)) => PathBuf::from(prebuilt),
        _ => build_native(events, language, program, program_path, cwd_path).await?,
    };
    native_plan(events, adapter, binary, cwd)
}

/// Compile a C/C++/Rust file (or its Cargo project) with debug info.
async fn build_native(
    events: &dyn DebugEvents,
    language: &str,
    program: &str,
    program_path: &Path,
    cwd_path: &Path,
) -> Result<PathBuf, String> {
    console_output(events, "console", "Building with debug info…");
    Ok(match language {
        "c" | "cpp" => {
            let compiler = if language == "c" { "clang" } else { "clang++" };
            let compiler = resolve_binary(compiler)
                .ok_or_else(|| format!("{compiler} not found — install the Xcode Command Line Tools"))?;
            let output = debug_binary_path(program_path);
            let mut args = vec!["-g".into(), "-O0".into()];
            if language == "cpp" {
                args.push("-std=c++20".into());
            }
            args.extend([program.to_string(), "-o".into(), output.to_string_lossy().into_owned()]);
            run_build(events, &compiler, &args, cwd_path).await?;
            output
        }
        _ => {
            // Rust: a Cargo project builds its binary target; a lone .rs
            // file builds with rustc.
            let cargo_dir = cargo_manifest_for(program_path, cwd_path)
                .and_then(|manifest| manifest.parent().map(Path::to_path_buf));
            if let Some(project) = cargo_dir {
                let cargo = resolve_binary("cargo").ok_or_else(|| "cargo not found".to_string())?;
                let output = run_build(
                    events,
                    &cargo,
                    &["build".into(), "--message-format=json-render-diagnostics".into()],
                    &project,
                )
                .await?;
                // The last binary artifact cargo reports is the program.
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|message| message["reason"] == "compiler-artifact")
                    .filter_map(|message| message["executable"].as_str().map(PathBuf::from))
                    .next_back()
                    .ok_or_else(|| "cargo built no binary to debug (is this a library?)".to_string())?
            } else {
                let rustc = resolve_binary("rustc").ok_or_else(|| "rustc not found".to_string())?;
                let output = debug_binary_path(program_path);
                run_build(
                    events,
                    &rustc,
                    &[
                        "-g".into(),
                        program.to_string(),
                        "-o".into(),
                        output.to_string_lossy().into_owned(),
                    ],
                    cwd_path,
                )
                .await?;
                output
            }
        }
    })
}

/// lldb-dap on a built executable.
fn native_plan(events: &dyn DebugEvents, adapter: PathBuf, binary: PathBuf, cwd: &str) -> Result<LaunchPlan, String> {
    console_output(events, "console", &format!("Debugging {}", binary.display()));
    Ok(LaunchPlan {
        adapter: Some(Adapter { program: adapter, args: vec![], extra_path: vec![] }),
        transport: Transport::Stdio,
        adapter_id: "lldb-dap",
        launch: json!({
            "name": "Sable: Debug",
            "type": "lldb-dap",
            "request": "launch",
            "program": binary.to_string_lossy(),
            "cwd": cwd,
            "args": [],
            "stopOnEntry": false,
        }),
        exception_filters: vec![],
    })
}

/// js-debug's DAP server script inside Sable's tools folder.
fn js_debug_server() -> Option<PathBuf> {
    let script = tools_dir()?.join("js-debug").join("src").join("dapDebugServer.js");
    script.exists().then_some(script)
}

/// Node/TypeScript via js-debug (`pwa-node`).
fn node_plan(program: &str, cwd: &str) -> Result<LaunchPlan, String> {
    let node = resolve_binary("node").ok_or_else(|| "node not found — install Node.js".to_string())?;
    let server = js_debug_server().ok_or_else(|| "js-debug-missing".to_string())?;
    Ok(LaunchPlan {
        adapter: Some(Adapter {
            program: node.clone(),
            // Port 0: the server picks a free port and prints it.
            args: vec![server.to_string_lossy().into_owned(), "0".into(), "127.0.0.1".into()],
            extra_path: node.parent().map(Path::to_path_buf).into_iter().collect(),
        }),
        transport: Transport::TcpFromOutput,
        adapter_id: "js-debug",
        launch: json!({
            "name": "Sable: Debug",
            "type": "pwa-node",
            "request": "launch",
            "program": program,
            "cwd": cwd,
            "runtimeExecutable": node.to_string_lossy(),
            "console": "internalConsole",
            "outputCapture": "std",
            "skipFiles": ["<node_internals>/**"],
            "sourceMaps": true,
        }),
        exception_filters: vec!["uncaught"],
    })
}

/// Go via Delve's DAP server.
fn go_plan(events: &dyn DebugEvents, program: &str, cwd: &str) -> Result<LaunchPlan, String> {
    let dlv = resolve_binary("dlv").ok_or_else(|| {
        "Delve not found — run `brew install delve` (or `go install github.com/go-delve/delve/cmd/dlv@latest`)"
            .to_string()
    })?;
    let go = resolve_binary("go").ok_or_else(|| "go not found — run `brew install go`".to_string())?;
    // Inside a module, debug the package (all files of package main);
    // a lone file builds on its own.
    let path = Path::new(program);
    let in_module = path
        .ancestors()
        .skip(1)
        .take_while(|dir| dir.starts_with(cwd) || Path::new(cwd).starts_with(dir))
        .any(|dir| dir.join("go.mod").exists());
    let target = if in_module {
        path.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_else(|| program.into())
    } else {
        program.to_string()
    };
    console_output(events, "console", "Building with Delve…");
    Ok(LaunchPlan {
        adapter: Some(Adapter {
            program: dlv,
            args: vec!["dap".into(), "--listen=127.0.0.1:0".into()],
            extra_path: go.parent().map(Path::to_path_buf).into_iter().collect(),
        }),
        transport: Transport::TcpFromOutput,
        adapter_id: "go",
        launch: json!({
            "name": "Sable: Debug",
            "type": "go",
            "request": "launch",
            "mode": "debug",
            "program": target,
            "cwd": cwd,
            "stopOnEntry": false,
        }),
        exception_filters: vec![],
    })
}

/// Java: java-debug is already listening (jdtls started it and resolved
/// the main class and classpath — see the frontend's Java launcher).
pub fn java_plan(port: u16, launch: Value) -> LaunchPlan {
    LaunchPlan {
        adapter: None,
        transport: Transport::Tcp(port),
        adapter_id: "java",
        launch,
        exception_filters: vec!["uncaught"],
    }
}

/// Wait for the adapter to print the address it's listening on.
async fn listening_address<R: AsyncRead + Unpin + Send + 'static>(
    events: Arc<dyn DebugEvents>,
    output: R,
) -> Result<String, String> {
    let mut lines = BufReader::new(output).lines();
    let pattern = |line: &str| -> Option<String> {
        let start = line.find("127.0.0.1:").or_else(|| line.find("localhost:"))?;
        let address: String = line[start..]
            .chars()
            .take_while(|character| !character.is_whitespace())
            .collect();
        Some(address.replace("localhost", "127.0.0.1"))
    };
    let found = tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(address) = pattern(&line) {
                return Some(address);
            }
            console_output(events.as_ref(), "console", &line);
        }
        None
    })
    .await
    .map_err(|_| "Debug adapter didn't start listening in time".to_string())?
    .ok_or_else(|| "Debug adapter exited before listening".to_string())?;
    // Keep draining (and showing) its output so the pipe never fills.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            console_output(events.as_ref(), "console", &line);
        }
    });
    Ok(found)
}

/// Connect over TCP, retrying briefly while the server comes up.
async fn connect(address: &str) -> Result<TcpStream, String> {
    let mut last_error = String::new();
    for _ in 0..50 {
        match TcpStream::connect(address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Could not connect to the debug adapter at {address}: {last_error}"))
}

fn response(request: &Value, success: bool, message: Option<&str>) -> String {
    json!({
        "seq": 0,
        "type": "response",
        "request_seq": request["seq"],
        "command": request["command"],
        "success": success,
        "message": message,
    })
    .to_string()
}

/// Open one DAP connection over `reader`/`writer`: run the handshake,
/// then relay messages until the adapter closes it. `request` is
/// "launch" or "attach" with its arguments. Returns once the adapter has
/// answered `initialize` (or failed to).
fn open_connection<R, W>(
    shared: Arc<SessionShared>,
    reader: R,
    writer: W,
    request_command: String,
    arguments: Value,
    is_root: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    Box::pin(async move {
        // Writer task: the sole owner of the outgoing stream.
        let (sender, mut outgoing) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut writer = writer;
            while let Some(payload) = outgoing.recv().await {
                if framing::write_message(&mut writer, &payload).await.is_err() {
                    break;
                }
            }
        });
        shared.connections.lock().unwrap().push(sender.clone());

        let initialize_seq = shared.seq.fetch_add(1, Ordering::SeqCst);
        let (initialized_tx, initialized_rx) = oneshot::channel::<Result<(), String>>();
        let mut initialized_tx = Some(initialized_tx);

        // Reader task: configure on `initialized`, answer reverse
        // requests, relay everything else.
        let reader_shared = shared.clone();
        let reader_sender = sender.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            loop {
                let payload = match framing::read_message(&mut reader).await {
                    Ok(Some(payload)) => payload,
                    Ok(None) | Err(_) => break,
                };
                let Ok(message) = serde_json::from_str::<Value>(&payload) else {
                    continue;
                };

                if message["type"] == "response"
                    && message["request_seq"] == initialize_seq
                    && message["command"] == "initialize"
                {
                    let outcome = if message["success"] == false {
                        Err(format!(
                            "{} failed to initialize: {}",
                            reader_shared.adapter_id,
                            message["message"].as_str().unwrap_or("unknown error")
                        ))
                    } else {
                        Ok(())
                    };
                    if let Some(tx) = initialized_tx.take() {
                        let _ = tx.send(outcome);
                    }
                }

                if message["type"] == "event" && message["event"] == "initialized" {
                    configure(&reader_shared, &reader_sender);
                }

                if message["type"] == "request" {
                    // Reverse requests from the adapter.
                    if message["command"] == "startDebugging" {
                        let _ = reader_sender.send(response(&message, true, None));
                        let child_request = message["arguments"]["request"]
                            .as_str()
                            .unwrap_or("launch")
                            .to_string();
                        let configuration = message["arguments"]["configuration"].clone();
                        let child_shared = reader_shared.clone();
                        tokio::spawn(async move {
                            let Some(address) = child_shared.address.clone() else { return };
                            match connect(&address).await {
                                Ok(stream) => {
                                    let (read_half, write_half) = stream.into_split();
                                    if let Err(error) = open_connection(
                                        child_shared.clone(),
                                        read_half,
                                        write_half,
                                        child_request,
                                        configuration,
                                        false,
                                    )
                                    .await
                                    {
                                        console_output(child_shared.events.as_ref(), "stderr", &error);
                                    }
                                }
                                Err(error) => {
                                    console_output(child_shared.events.as_ref(), "stderr", &error)
                                }
                            }
                        });
                    } else if message["command"] == "runInTerminal" {
                        // The frontend starts it in a terminal tab and
                        // answers with the process id (complete_terminal).
                        let id = reader_shared.next_terminal.fetch_add(1, Ordering::SeqCst) as u64;
                        let arguments = message["arguments"].clone();
                        reader_shared
                            .pending_terminals
                            .lock()
                            .unwrap()
                            .insert(id, (reader_sender.clone(), message));
                        reader_shared.events.emit(
                            "debug:run-in-terminal",
                            json!({
                                "id": id,
                                "args": arguments["args"],
                                "cwd": arguments["cwd"],
                                "env": arguments["env"],
                                "title": arguments["title"],
                            }),
                        );
                    } else {
                        let _ = reader_sender.send(response(
                            &message,
                            false,
                            Some("Not supported by Sable"),
                        ));
                    }
                    continue;
                }

                reader_shared.events.emit("debug:message", message);
            }

            // Connection closed.
            if let Some(tx) = initialized_tx.take() {
                let _ = tx.send(Err(format!("{} exited during initialize", reader_shared.adapter_id)));
            }
            reader_shared
                .connections
                .lock()
                .unwrap()
                .retain(|connection| !connection.same_channel(&reader_sender));
            if is_root {
                reader_shared
                    .events
                    .emit("debug:status", json!({ "state": "terminated" }));
            }
        });

        // --- 1. initialize → wait for its response. ---
        let _ = sender.send(request(
            initialize_seq,
            "initialize",
            json!({
                "clientID": "sable",
                "clientName": "Sable",
                "adapterID": shared.adapter_id,
                "locale": "en",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                // Programs run in a Sable terminal so they can read input.
                "supportsRunInTerminalRequest": true,
                // js-debug runs targets as child sessions.
                "supportsStartDebuggingRequest": true,
            }),
        ));
        tokio::time::timeout(Duration::from_secs(30), initialized_rx)
            .await
            .map_err(|_| format!("{} didn't answer initialize", shared.adapter_id))?
            .map_err(|_| format!("{} exited during initialize", shared.adapter_id))??;

        // --- 2. launch/attach (deferred response). ---
        let seq = shared.seq.fetch_add(1, Ordering::SeqCst);
        let _ = sender.send(request(seq, &request_command, arguments));
        Ok(())
    })
}

/// On `initialized`: breakpoints, exception filters, configurationDone.
fn configure(shared: &SessionShared, sender: &mpsc::UnboundedSender<String>) {
    let breakpoints = shared.breakpoints.lock().unwrap().clone();
    for (file, lines) in &breakpoints {
        let points: Vec<Value> = lines.iter().map(|line| json!({ "line": line })).collect();
        let seq = shared.seq.fetch_add(1, Ordering::SeqCst);
        let _ = sender.send(request(
            seq,
            "setBreakpoints",
            json!({ "source": { "path": file }, "breakpoints": points }),
        ));
    }
    // Pause on uncaught exceptions where supported, so a crash shows
    // where it happened.
    let seq = shared.seq.fetch_add(1, Ordering::SeqCst);
    let _ = sender.send(request(
        seq,
        "setExceptionBreakpoints",
        json!({ "filters": shared.exception_filters }),
    ));
    let seq = shared.seq.fetch_add(1, Ordering::SeqCst);
    let _ = sender.send(request(seq, "configurationDone", json!({})));
}

/// Start the adapter (if any), connect, and run the launch handshake.
/// `breakpoints` maps an absolute file path to its 1-based line numbers.
pub async fn start_session(
    events: Arc<dyn DebugEvents>,
    plan: LaunchPlan,
    breakpoints: HashMap<String, Vec<i64>>,
) -> Result<DebugSession, String> {
    // The adapter runs in a terminal tab and dials in to us.
    if matches!(plan.transport, Transport::TerminalDialIn) {
        let adapter = plan.adapter.as_ref().ok_or("no debug adapter")?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("Could not listen for the debugger: {error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let mut args = vec![adapter.program.to_string_lossy().into_owned()];
        args.extend(adapter.args.iter().filter(|arg| !arg.starts_with("--listen")).cloned());
        args.extend(["--client-addr".to_string(), address.to_string()]);
        let mut env = serde_json::Map::new();
        if !adapter.extra_path.is_empty() {
            let mut paths = adapter.extra_path.clone();
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                env.insert("PATH".into(), json!(joined.to_string_lossy()));
            }
        }
        // id 0: nothing waits for the process id.
        events.emit(
            "debug:run-in-terminal",
            json!({ "id": 0, "args": args, "cwd": plan.launch["cwd"], "env": env, "title": "Debug" }),
        );
        let (stream, _) = tokio::time::timeout(Duration::from_secs(60), listener.accept())
            .await
            .map_err(|_| format!("{} didn't connect", plan.adapter_id))?
            .map_err(|error| format!("{} didn't connect: {error}", plan.adapter_id))?;
        let shared = Arc::new(SessionShared {
            events,
            breakpoints: Mutex::new(breakpoints),
            exception_filters: plan.exception_filters,
            adapter_id: plan.adapter_id,
            address: None,
            connections: Mutex::new(Vec::new()),
            seq: AtomicI64::new(1),
            pending_terminals: Mutex::new(HashMap::new()),
            next_terminal: AtomicI64::new(1),
        });
        let request_command = plan.launch["request"].as_str().unwrap_or("launch").to_string();
        let (read_half, write_half) = stream.into_split();
        open_connection(shared.clone(), read_half, write_half, request_command, plan.launch, true).await?;
        return Ok(DebugSession { child: None, shared });
    }

    let mut child = match &plan.adapter {
        Some(adapter) => {
            let mut command = Command::new(&adapter.program);
            command.args(&adapter.args).kill_on_drop(true);
            if !adapter.extra_path.is_empty() {
                let mut paths = adapter.extra_path.clone();
                if let Some(existing) = std::env::var_os("PATH") {
                    paths.extend(std::env::split_paths(&existing));
                }
                if let Ok(joined) = std::env::join_paths(paths) {
                    command.env("PATH", joined);
                }
            }
            command
                .stdin(if matches!(plan.transport, Transport::Stdio) { Stdio::piped() } else { Stdio::null() })
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            Some(
                command
                    .spawn()
                    .map_err(|error| format!("Could not start {}: {error}", plan.adapter_id))?,
            )
        }
        None => None,
    };

    let address = match &plan.transport {
        Transport::Stdio => None,
        Transport::Tcp(port) => Some(format!("127.0.0.1:{port}")),
        Transport::TerminalDialIn => unreachable!("handled above"),
        Transport::TcpFromOutput => {
            let stdout = child
                .as_mut()
                .and_then(|child| child.stdout.take())
                .ok_or_else(|| "debug adapter has no output".to_string())?;
            Some(listening_address(events.clone(), stdout).await?)
        }
    };

    let shared = Arc::new(SessionShared {
        events,
        breakpoints: Mutex::new(breakpoints),
        exception_filters: plan.exception_filters,
        adapter_id: plan.adapter_id,
        address: address.clone(),
        connections: Mutex::new(Vec::new()),
        seq: AtomicI64::new(1),
        pending_terminals: Mutex::new(HashMap::new()),
        next_terminal: AtomicI64::new(1),
    });
    let request_command = plan.launch["request"].as_str().unwrap_or("launch").to_string();

    match address {
        None => {
            let child = child.as_mut().ok_or_else(|| "no debug adapter".to_string())?;
            let stdin = child.stdin.take().ok_or_else(|| "debug adapter has no stdin".to_string())?;
            let stdout = child.stdout.take().ok_or_else(|| "debug adapter has no stdout".to_string())?;
            open_connection(shared.clone(), stdout, stdin, request_command, plan.launch, true).await?;
        }
        Some(address) => {
            let stream = connect(&address).await?;
            let (read_half, write_half) = stream.into_split();
            open_connection(shared.clone(), read_half, write_half, request_command, plan.launch, true)
                .await?;
        }
    }
    Ok(DebugSession { child, shared })
}

impl DebugSession {
    /// Send a DAP request (caller-chosen `seq`, for correlation) to the
    /// active connection. Breakpoint changes are also remembered, so child
    /// sessions that start later get them.
    pub fn send(&self, seq: i64, command: &str, arguments: Value) -> Result<(), String> {
        if command == "setBreakpoints" {
            if let Some(file) = arguments["source"]["path"].as_str() {
                let lines: Vec<i64> = arguments["breakpoints"]
                    .as_array()
                    .map(|points| points.iter().filter_map(|point| point["line"].as_i64()).collect())
                    .unwrap_or_default();
                self.shared.breakpoints.lock().unwrap().insert(file.to_string(), lines);
            }
        }
        let connections = self.shared.connections.lock().unwrap();
        let active = connections.last().ok_or_else(|| "Debug session ended".to_string())?;
        active
            .send(request(seq, command, arguments))
            .map_err(|error| format!("Failed to send {command}: {error}"))
    }

    /// Answer a runInTerminal request: the program started (with its
    /// process id) or couldn't.
    pub fn complete_terminal(&self, id: u64, process_id: Option<u32>, error: Option<String>) {
        let Some((sender, request)) = self.shared.pending_terminals.lock().unwrap().remove(&id) else {
            return;
        };
        let mut reply = json!({
            "seq": 0,
            "type": "response",
            "request_seq": request["seq"],
            "command": "runInTerminal",
            "success": error.is_none(),
            "body": {},
        });
        if let Some(pid) = process_id {
            reply["body"]["processId"] = json!(pid);
        }
        if let Some(message) = error {
            reply["message"] = json!(message);
        }
        let _ = sender.send(reply.to_string());
    }

    /// Ask every connection to disconnect+terminate, then stop the adapter.
    pub async fn shutdown(mut self) {
        let connections: Vec<_> = self.shared.connections.lock().unwrap().iter().rev().cloned().collect();
        for connection in connections {
            let seq = self.shared.seq.fetch_add(1, Ordering::SeqCst);
            let _ = connection.send(request(seq, "disconnect", json!({ "terminateDebuggee": true })));
        }
        // Give the messages a moment to flush before killing the adapter.
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill().await;
        }
    }
}

/// Start debugging `program`. `python` is the interpreter for Python
/// programs. Build output and adapter traffic arrive as `debug:message`
/// events.
#[tauri::command]
pub async fn start_debug(
    app: AppHandle,
    manager: State<'_, DebugManager>,
    program: String,
    cwd: String,
    python: Option<String>,
    breakpoints: HashMap<String, Vec<i64>>,
    options: Option<RunOptions>,
) -> Result<(), String> {
    // Tear down any previous session first.
    if let Some(old) = manager.0.lock().await.take() {
        old.shutdown().await;
    }
    let plan = prepare_launch(&app, &program, &cwd, python.as_deref(), &options.unwrap_or_default()).await?;
    let session = start_session(Arc::new(app.clone()), plan, breakpoints).await?;
    *manager.0.lock().await = Some(session);
    Ok(())
}

/// Start debugging Java: jdtls (with the java-debug plugin) is already
/// listening on `port`; `launch` is the resolved launch configuration
/// (main class, project, classpath).
#[tauri::command]
pub async fn start_java_debug(
    app: AppHandle,
    manager: State<'_, DebugManager>,
    port: u16,
    launch: Value,
    breakpoints: HashMap<String, Vec<i64>>,
) -> Result<(), String> {
    if let Some(old) = manager.0.lock().await.take() {
        old.shutdown().await;
    }
    let session = start_session(Arc::new(app.clone()), java_plan(port, launch), breakpoints).await?;
    *manager.0.lock().await = Some(session);
    Ok(())
}

/// The frontend started a runInTerminal program (or couldn't).
#[tauri::command]
pub async fn debug_terminal_started(
    manager: State<'_, DebugManager>,
    id: u64,
    process_id: Option<u32>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(session) = manager.0.lock().await.as_ref() {
        session.complete_terminal(id, process_id, error);
    }
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
    let session = guard.as_ref().ok_or_else(|| "No debug session".to_string())?;
    session.send(seq, &command, arguments)
}

/// Stop debugging: disconnect + terminate the debuggee, then the adapter.
#[tauri::command]
pub async fn debug_stop(manager: State<'_, DebugManager>) -> Result<(), String> {
    let session = manager.0.lock().await.take();
    if let Some(session) = session {
        session.shutdown().await;
    }
    Ok(())
}

/// Download js-debug (VS Code's JavaScript debugger) into Sable's tools
/// folder. Release assets are versioned; this pins a known-good one.
#[tauri::command]
pub async fn install_js_debug() -> Result<(), String> {
    const URL: &str = "https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz";
    let tools = tools_dir().ok_or_else(|| "Tools folder unavailable".to_string())?;
    std::fs::create_dir_all(&tools).map_err(|error| format!("Could not create tools folder: {error}"))?;
    let archive = tools.join("js-debug.tar.gz");
    let bytes = reqwest::get(URL)
        .await
        .map_err(|error| format!("Download failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Download failed: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    std::fs::write(&archive, &bytes).map_err(|error| format!("Could not save js-debug: {error}"))?;
    // Replace any previous copy, then unpack (the archive holds js-debug/).
    let _ = std::fs::remove_dir_all(tools.join("js-debug"));
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&tools)
        .status()
        .await
        .map_err(|error| format!("Could not unpack js-debug: {error}"))?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() || js_debug_server().is_none() {
        return Err("Could not unpack js-debug".to_string());
    }
    Ok(())
}

// --- Debugging a JVM started by a build tool (Java tests) ---------------------
//
// Maven/Gradle start the test JVM themselves. Rather than have it listen
// on a fixed port (and guess when it's up — Surefire hides its "Listening"
// line), the JVM connects *to Sable* (`server=n`) as soon as it starts.
// Sable then relays that connection to java-debug, which attaches to the
// relay as if to the JVM.

/// Listeners waiting for a test JVM, by port.
static JVM_LISTENERS: std::sync::LazyLock<Mutex<HashMap<u16, tokio::net::TcpListener>>> =
    std::sync::LazyLock::new(Default::default);

/// Start waiting for a JVM; returns the port for its
/// `-agentlib:jdwp=transport=dt_socket,server=n,address=localhost:<port>`.
#[tauri::command]
pub async fn jvm_debug_listen() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not listen for the JVM: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    JVM_LISTENERS.lock().unwrap().insert(port, listener);
    Ok(port)
}

/// Wait for the JVM to connect; returns the port java-debug attaches to.
#[tauri::command]
pub async fn jvm_debug_accept(port: u16, timeout_secs: u64) -> Result<u16, String> {
    let listener = JVM_LISTENERS
        .lock()
        .unwrap()
        .remove(&port)
        .ok_or("Not waiting for a JVM on that port")?;
    let (mut jvm, _) = tokio::time::timeout(Duration::from_secs(timeout_secs), listener.accept())
        .await
        .map_err(|_| "The test JVM didn't start in time — see the terminal".to_string())?
        .map_err(|error| format!("The test JVM couldn't connect: {error}"))?;
    let relay = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not listen for the debugger: {error}"))?;
    let relay_port = relay.local_addr().map_err(|error| error.to_string())?.port();
    tokio::spawn(async move {
        if let Ok(Ok((mut debugger, _))) =
            tokio::time::timeout(Duration::from_secs(120), relay.accept()).await
        {
            let _ = tokio::io::copy_bidirectional(&mut debugger, &mut jvm).await;
        }
    });
    Ok(relay_port)
}

/// Stop waiting (the build ended, or debugging was cancelled).
#[tauri::command]
pub fn jvm_debug_cancel(port: u16) {
    JVM_LISTENERS.lock().unwrap().remove(&port);
}

/// Whether the java-debug plugin is installed (jdtls loads it at start).
#[tauri::command]
pub fn java_debug_installed() -> bool {
    crate::lsp::java_debug_bundle().is_some()
}

/// Download the java-debug plugin (Microsoft's, as used by VS Code) into
/// Sable's tools folder. jdtls must restart to load it.
#[tauri::command]
pub async fn install_java_debug() -> Result<(), String> {
    const URL: &str = "https://repo1.maven.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/0.53.1/com.microsoft.java.debug.plugin-0.53.1.jar";
    let dir = tools_dir()
        .ok_or_else(|| "Tools folder unavailable".to_string())?
        .join("java-debug");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create tools folder: {error}"))?;
    let bytes = reqwest::get(URL)
        .await
        .map_err(|error| format!("Download failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Download failed: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    // A jar is a zip: check the magic number before installing it.
    if !bytes.starts_with(b"PK") {
        return Err("Download failed: not a jar".to_string());
    }
    std::fs::write(dir.join("com.microsoft.java.debug.plugin.jar"), &bytes)
        .map_err(|error| format!("Could not save java-debug: {error}"))
}

/// Install debugpy into an interpreter (the Debug view's one-click fix).
/// Returns pip's output; fails with a clear message for interpreters that
/// refuse package installs (Homebrew/system Pythons, PEP 668).
#[tauri::command]
pub async fn install_debugpy(python: String) -> Result<String, String> {
    let output = Command::new(&python)
        .args(["-m", "pip", "install", "--disable-pip-version-check", "debugpy"])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not run {python}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    if stderr.contains("externally-managed-environment") {
        return Err(
            "This Python is managed by the system/Homebrew and won't accept packages. \
             Create a virtual environment (status bar → interpreter → Create new \
             environment), select it, then install debugpy there."
                .to_string(),
        );
    }
    Err(format!("pip failed: {}", stderr.trim()))
}

#[cfg(test)]
mod tests {
    //! End-to-end: real adapters, real programs, the same handshake the
    //! app uses. Skipped (not failed) when an adapter isn't installed.
    use super::*;
    use std::sync::Mutex;

    /// Stands in for Sable's terminal: runs a program with piped stdio,
    /// types the test's input, and collects what it prints.
    #[derive(Clone, Default)]
    struct TerminalStandIn {
        input: Arc<Mutex<String>>,
        output: Arc<Mutex<String>>,
        children: Arc<Mutex<Vec<std::process::Child>>>,
    }

    impl TerminalStandIn {
        /// Start a runInTerminal request's program; returns its pid.
        fn run(&self, request: &Value) -> u32 {
            use std::io::{Read, Write};
            let args: Vec<String> = request["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap().to_string())
                .collect();
            let mut command = std::process::Command::new(&args[0]);
            command.args(&args[1..]);
            if let Some(cwd) = request["cwd"].as_str().filter(|cwd| !cwd.is_empty()) {
                command.current_dir(cwd);
            }
            if let Some(env) = request["env"].as_object() {
                for (name, value) in env {
                    match value.as_str() {
                        Some(value) => command.env(name, value),
                        None => command.env_remove(name),
                    };
                }
            }
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("start the program");
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(self.input.lock().unwrap().as_bytes()).unwrap();
            drop(stdin);
            let mut stdout = child.stdout.take().unwrap();
            let sink = self.output.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 4096];
                while let Ok(count) = stdout.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    sink.lock().unwrap().push_str(&String::from_utf8_lossy(&buffer[..count]));
                }
            });
            let pid = child.id();
            self.children.lock().unwrap().push(child);
            pid
        }

        fn kill_all(&self) {
            for child in self.children.lock().unwrap().iter_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Collects every event; tests wait on it. Adapters that dial in from
    /// a terminal (id 0) are started right away, as the app does — the
    /// session can't start until they connect.
    struct Recorder(Mutex<mpsc::UnboundedSender<Value>>, TerminalStandIn);
    impl DebugEvents for Recorder {
        fn emit(&self, event: &str, payload: Value) {
            if event == "debug:run-in-terminal" && payload["id"] == 0 {
                self.1.run(&payload);
                return;
            }
            let _ = self.0.lock().unwrap().send(payload);
        }
    }

    struct Harness {
        session: DebugSession,
        incoming: mpsc::UnboundedReceiver<Value>,
        next_seq: i64,
        output: String,
        /// Programs the adapter asked to run in a terminal.
        terminal: TerminalStandIn,
        /// Messages that arrived while waiting for a response.
        backlog: std::collections::VecDeque<Value>,
    }

    impl Harness {
        async fn start(
            program: &Path,
            python: Option<&str>,
            breakpoint_line: i64,
            options: RunOptions,
            input: &str,
        ) -> Option<Harness> {
            let (sender, incoming) = mpsc::unbounded_channel();
            let terminal = TerminalStandIn::default();
            *terminal.input.lock().unwrap() = input.to_string();
            let events = Arc::new(Recorder(Mutex::new(sender), terminal.clone()));
            let program_str = program.to_string_lossy().into_owned();
            let cwd = program.parent().unwrap().to_string_lossy().into_owned();
            let plan = match prepare_launch(events.as_ref(), &program_str, &cwd, python, &options).await {
                Ok(plan) => plan,
                Err(error) => {
                    eprintln!("skipping: {error}");
                    return None;
                }
            };
            let breakpoints = HashMap::from([(program_str, vec![breakpoint_line])]);
            let session = start_session(events, plan, breakpoints).await.unwrap();
            Some(Harness {
                session,
                incoming,
                next_seq: 500_000,
                output: String::new(),
                terminal,
                backlog: Default::default(),
            })
        }

        /// The next adapter message. Answers runInTerminal the way the app
        /// does — start the program, type the input, report its pid — and
        /// collects program output.
        async fn next(&mut self, waiting_for: &str) -> Value {
            loop {
                let message = tokio::time::timeout(Duration::from_secs(30), self.incoming.recv())
                    .await
                    .unwrap_or_else(|_| panic!("timed out waiting for {waiting_for}"))
                    .unwrap_or_else(|| panic!("session ended before {waiting_for}"));
                if std::env::var("SABLE_TRACE").is_ok() {
                    eprintln!("<< {}", message.to_string().chars().take(220).collect::<String>());
                }
                if message.get("args").is_some() && message.get("type").is_none() {
                    self.run_in_terminal(&message);
                    continue;
                }
                if message["event"] == "output" {
                    self.output.push_str(message["body"]["output"].as_str().unwrap_or(""));
                }
                return message;
            }
        }

        fn run_in_terminal(&mut self, request: &Value) {
            let pid = self.terminal.run(request);
            let id = request["id"].as_u64().unwrap();
            self.session.complete_terminal(id, Some(pid), None);
        }

        /// Everything the program printed (debug console or terminal).
        fn all_output(&self) -> String {
            format!("{}{}", self.output, self.terminal.output.lock().unwrap())
        }

        /// Wait for an event, recording program output along the way.
        async fn event(&mut self, name: &str) -> Value {
            loop {
                let message = self.message(name).await;
                if message["type"] == "event" && message["event"] == name {
                    return message;
                }
                if name == "terminated" && message["state"] == "terminated" {
                    return message;
                }
            }
        }

        /// Wait for whichever of several events comes first.
        async fn event_any(&mut self, names: &[&str]) -> Value {
            loop {
                let message = self.message(&format!("{names:?}")).await;
                if message["type"] == "event"
                    && names.iter().any(|name| message["event"] == *name)
                {
                    return message;
                }
                if names.contains(&"terminated") && message["state"] == "terminated" {
                    return json!({ "event": "terminated" });
                }
            }
        }

        /// Send a request and wait for its response.
        async fn request(&mut self, command: &str, arguments: Value) -> Value {
            self.next_seq += 1;
            let seq = self.next_seq;
            self.session.send(seq, command, arguments).unwrap();
            loop {
                let message = self.next(&format!("{command} response")).await;
                if message["type"] == "response" && message["request_seq"] == seq {
                    assert_eq!(message["success"], true, "{command} failed: {message}");
                    return message;
                }
                // An event can arrive before the response (e.g. the
                // program ends before "continue" is answered): keep it
                // for whoever waits for it next.
                self.backlog.push_back(message);
            }
        }

        /// The next message, starting with any that arrived during a
        /// request.
        async fn message(&mut self, waiting_for: &str) -> Value {
            match self.backlog.pop_front() {
                Some(message) => message,
                None => self.next(waiting_for).await,
            }
        }

        /// Stopped → thread, top frame's line, and the named local's value.
        async fn stopped_at(&mut self, local: &str) -> (i64, i64, String) {
            let stopped = self.event("stopped").await;
            let thread_id = stopped["body"]["threadId"].as_i64().unwrap_or(1);
            let trace = self
                .request("stackTrace", json!({ "threadId": thread_id, "levels": 1 }))
                .await;
            let frame = &trace["body"]["stackFrames"][0];
            let line = frame["line"].as_i64().unwrap();
            let scopes = self.request("scopes", json!({ "frameId": frame["id"] })).await;
            let reference = scopes["body"]["scopes"][0]["variablesReference"].clone();
            let variables = self
                .request("variables", json!({ "variablesReference": reference }))
                .await;
            let value = variables["body"]["variables"]
                .as_array()
                .unwrap()
                .iter()
                .find(|variable| variable["name"] == local)
                .map(|variable| variable["value"].as_str().unwrap_or("").to_string())
                .unwrap_or_default();
            (thread_id, line, value)
        }
    }

    fn write_program(name: &str, source: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sable-debug-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, source).unwrap();
        path
    }

    /// Breakpoint hit → inspect a local → step over → continue → exit.
    async fn exercise(program: PathBuf, python: Option<&str>, breakpoint: i64, local: &str, expect: &str) {
        exercise_with(program, python, breakpoint, local, expect, RunOptions::default(), "", "done").await;
    }

    /// `exercise`, with run options (args, env, a terminal) and keyboard
    /// input for the program; `printed` must appear in its output.
    #[allow(clippy::too_many_arguments)]
    async fn exercise_with(
        program: PathBuf,
        python: Option<&str>,
        breakpoint: i64,
        local: &str,
        expect: &str,
        options: RunOptions,
        input: &str,
        printed: &str,
    ) {
        let Some(mut harness) = Harness::start(&program, python, breakpoint, options, input).await else {
            return;
        };
        // Thread ids are adapter-specific (lldb uses real OS thread ids).
        let (thread_id, line, value) = harness.stopped_at(local).await;
        assert_eq!(line, breakpoint, "paused on the wrong line");
        assert!(value.contains(expect), "{local} = {value:?}, expected {expect}");

        harness.request("next", json!({ "threadId": thread_id })).await;
        let stopped = harness.event("stopped").await;
        // A line can map to several addresses (e.g. Rust's println!
        // expansion), so stepping may land on another location of the
        // same breakpoint — reported as "breakpoint" rather than "step".
        let reason = stopped["body"]["reason"].as_str().unwrap_or("");
        assert!(reason == "step" || reason == "breakpoint", "stopped for {reason}");

        // Continue to the end. Remaining locations of a multi-address
        // breakpoint line pause again; keep continuing (bounded).
        let mut resumes = 0;
        loop {
            harness.request("continue", json!({ "threadId": thread_id })).await;
            let next = harness.event_any(&["stopped", "terminated"]).await;
            if next["event"] != "stopped" {
                break;
            }
            resumes += 1;
            assert!(resumes < 5, "kept stopping after continue");
        }
        // Output from a terminal arrives asynchronously; give it a moment.
        for _ in 0..30 {
            // Late output events may still be queued after "terminated".
            while let Ok(message) = harness.incoming.try_recv() {
                if message["event"] == "output" {
                    harness.output.push_str(message["body"]["output"].as_str().unwrap_or(""));
                }
            }
            if harness.all_output().contains(printed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(harness.all_output().contains(printed), "program output missing: {:?}", harness.all_output());
        let Harness { session, terminal, .. } = harness;
        session.shutdown().await;
        terminal.kill_all();
    }

    /// Run options for the input tests: an argument, an environment
    /// variable, and a terminal (so the program can read input).
    fn terminal_options() -> RunOptions {
        RunOptions {
            args: vec!["arg1".into()],
            env: HashMap::from([("SABLE_GREETING".to_string(), "env1".to_string())]),
            cwd: None,
            terminal: true,
            ..RunOptions::default()
        }
    }

    #[tokio::test]
    async fn python_reads_input_args_and_env() {
        let python = std::env::var("SABLE_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
        let program = write_program(
            "input_sample.py",
            "import os, sys\nname = input()\ngreeting = 'hi ' + name + ' ' + sys.argv[1] + ' ' + os.environ['SABLE_GREETING']\nprint('done', greeting)\nfinished = True\n",
        );
        exercise_with(program, Some(&python), 4, "greeting", "hi sable arg1 env1", terminal_options(), "sable\n", "done hi sable arg1 env1").await;
    }

    #[tokio::test]
    async fn javascript_reads_input_args_and_env() {
        use_app_tools().await;
        let program = write_program(
            "input_sample.js",
            "function main() {\n  const name = require('fs').readFileSync(0, 'utf8').trim();\n  const greeting = 'hi ' + name + ' ' + process.argv[2] + ' ' + process.env.SABLE_GREETING;\n  console.log('done', greeting);\n}\nmain();\n",
        );
        exercise_with(program, None, 4, "greeting", "hi sable arg1 env1", terminal_options(), "sable\n", "done hi sable arg1 env1").await;
    }

    #[tokio::test]
    async fn go_reads_input_args_and_env() {
        let program = write_program(
            "input_sample.go",
            "package main\n\nimport (\n\t\"bufio\"\n\t\"fmt\"\n\t\"os\"\n\t\"strings\"\n)\n\nfunc main() {\n\tname, _ := bufio.NewReader(os.Stdin).ReadString('\\n')\n\tgreeting := \"hi \" + strings.TrimSpace(name) + \" \" + os.Args[1] + \" \" + os.Getenv(\"SABLE_GREETING\")\n\tfmt.Println(\"done\", greeting)\n}\n",
        );
        exercise_with(program, None, 13, "greeting", "hi sable arg1 env1", terminal_options(), "sable\n", "done hi sable arg1 env1").await;
    }

    #[tokio::test]
    async fn c_reads_input_args_and_env() {
        let program = write_program(
            "input_sample.c",
            "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\nint main(int argc, char **argv) {\n    char name[64] = {0};\n    fgets(name, sizeof name, stdin);\n    name[strcspn(name, \"\\n\")] = 0;\n    char greeting[256];\n    snprintf(greeting, sizeof greeting, \"hi %s %s %s\", name, argv[1], getenv(\"SABLE_GREETING\"));\n    printf(\"done %s\\n\", greeting);\n    return 0;\n}\n",
        );
        exercise_with(program, None, 11, "greeting", "hi sable arg1 env1", terminal_options(), "sable\n", "done hi sable arg1 env1").await;
    }

    #[tokio::test]
    async fn rust_reads_input_args_and_env() {
        let program = write_program(
            "input_sample.rs",
            "use std::io::BufRead;\n\nfn main() {\n    let mut name = String::new();\n    std::io::stdin().lock().read_line(&mut name).unwrap();\n    let greeting = format!(\"hi {} {} {}\", name.trim(), std::env::args().nth(1).unwrap(), std::env::var(\"SABLE_GREETING\").unwrap());\n    println!(\"done {greeting}\");\n}\n",
        );
        // lldb shows a Rust String's fields, not its text: check the output.
        exercise_with(program, None, 7, "greeting", "", terminal_options(), "sable\n", "done hi sable arg1 env1").await;
    }

    /// Point the tools folder at Sable's real one (where the app installs
    /// js-debug). Optionally install js-debug first.
    async fn use_app_tools() {
        if let Some(home) = std::env::var_os("HOME") {
            crate::lsp::set_tools_dir(
                PathBuf::from(home).join("Library/Application Support/com.riaanmathur.sable/tools"),
            );
        }
        if std::env::var("SABLE_TEST_INSTALL_JS_DEBUG").is_ok() && js_debug_server().is_none() {
            install_js_debug().await.unwrap();
        }
    }

    #[tokio::test]
    async fn javascript_breakpoint_step_continue() {
        use_app_tools().await;
        let program = write_program(
            "sample.js",
            "function total(n) {\n  let acc = 0;\n  for (let i = 0; i < n; i++) acc += i;\n  return acc;\n}\n\nconst result = total(5);\nconsole.log('done', result);\n",
        );
        // Line 4 (`return acc`): acc is 10 there.
        exercise(program, None, 4, "acc", "10").await;
    }

    #[tokio::test]
    async fn typescript_breakpoint_step_continue() {
        use_app_tools().await;
        let program = write_program(
            "sample.ts",
            "function total(n: number): number {\n  let acc: number = 0;\n  for (let i = 0; i < n; i++) acc += i;\n  return acc;\n}\n\nconst result: number = total(5);\nconsole.log('done', result);\n",
        );
        exercise(program, None, 4, "acc", "10").await;
    }

    #[tokio::test]
    async fn go_breakpoint_step_continue() {
        let program = write_program(
            "sample.go",
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n\ttotal := 0\n\tfor i := 0; i < 5; i++ {\n\t\ttotal += i\n\t}\n\tfmt.Println(\"done\", total)\n}\n",
        );
        // Line 10 (Println): total is 10 there.
        exercise(program, None, 10, "total", "10").await;
    }

    /// A bare-bones LSP client for jdtls (the app's lives in the
    /// frontend): requests by id, answers the server's own requests.
    struct Jdtls {
        child: Child,
        writer: tokio::process::ChildStdin,
        responses: mpsc::UnboundedReceiver<Value>,
        replies_rx: mpsc::UnboundedReceiver<String>,
        next_id: i64,
    }

    impl Jdtls {
        async fn start(root: &Path) -> Option<Jdtls> {
            let binary = resolve_binary("jdtls")?;
            let data = std::env::temp_dir().join(format!("sable-jdtls-test-{}", std::process::id()));
            let mut child = Command::new(binary)
                .arg("-data")
                .arg(&data)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .ok()?;
            let writer = child.stdin.take()?;
            let stdout = child.stdout.take()?;
            let (responses_tx, responses) = mpsc::unbounded_channel();
            let (replies, replies_rx) = mpsc::unbounded_channel::<String>();
            let reply_sender = replies;
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                while let Ok(Some(payload)) = framing::read_message(&mut reader).await {
                    let Ok(message) = serde_json::from_str::<Value>(&payload) else { continue };
                    if message.get("method").is_some() && message.get("id").is_some() {
                        // workspace/configuration wants one entry per item.
                        let result = match message["params"]["items"].as_array() {
                            Some(items) => json!(vec![Value::Null; items.len()]),
                            None => Value::Null,
                        };
                        let _ = reply_sender.send(
                            json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }).to_string(),
                        );
                    } else if message.get("id").is_some() {
                        let _ = responses_tx.send(message);
                    }
                }
            });
            let mut client = Jdtls { child, writer, responses, replies_rx, next_id: 0 };
            let root_str = root.to_string_lossy().into_owned();
            client
                .request("initialize", crate::lsp::initialize_params(&root_str, "java"))
                .await?;
            client.notify("initialized", json!({})).await;
            Some(client)
        }

        async fn flush_replies(&mut self) {
            while let Ok(reply) = self.replies_rx.try_recv() {
                let _ = framing::write_message(&mut self.writer, &reply).await;
            }
        }

        async fn notify(&mut self, method: &str, params: Value) {
            let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
            let _ = framing::write_message(&mut self.writer, &message.to_string()).await;
        }

        async fn request(&mut self, method: &str, params: Value) -> Option<Value> {
            self.next_id += 1;
            let id = self.next_id;
            let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            framing::write_message(&mut self.writer, &message.to_string()).await.ok()?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
            loop {
                self.flush_replies().await;
                match tokio::time::timeout(Duration::from_millis(100), self.responses.recv()).await {
                    Ok(Some(response)) if response["id"] == id => {
                        return Some(response["result"].clone());
                    }
                    Ok(None) => return None,
                    _ => {}
                }
                if tokio::time::Instant::now() > deadline {
                    return None;
                }
            }
        }

        async fn execute(&mut self, command: &str, arguments: Value) -> Option<Value> {
            self.request("workspace/executeCommand", json!({ "command": command, "arguments": arguments }))
                .await
        }
    }

    #[tokio::test]
    async fn java_breakpoint_step_continue() {
        use_app_tools().await;
        if std::env::var("SABLE_TEST_INSTALL_JAVA_DEBUG").is_ok()
            && crate::lsp::java_debug_bundle().is_none()
        {
            install_java_debug().await.unwrap();
        }
        if crate::lsp::java_debug_bundle().is_none() {
            eprintln!("skipping: java-debug not installed");
            return;
        }
        let root = std::env::temp_dir().join(format!("sable-java-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let program = root.join("Main.java");
        std::fs::write(
            &program,
            "public class Main {\n    public static void main(String[] args) {\n        int total = 0;\n        for (int i = 0; i < 5; i++) total += i;\n        System.out.println(\"done \" + total);\n    }\n}\n",
        )
        .unwrap();
        let Some(mut jdtls) = Jdtls::start(&root).await else {
            eprintln!("skipping: jdtls unavailable");
            return;
        };
        // Like the editor: open the file (jdtls builds a project for loose
        // files only once one is open).
        let text = std::fs::read_to_string(&program).unwrap();
        jdtls
            .notify(
                "textDocument/didOpen",
                json!({ "textDocument": {
                    "uri": crate::lsp::path_to_uri(&program.to_string_lossy()),
                    "languageId": "java", "version": 1, "text": text,
                }}),
            )
            .await;

        // The project imports in the background; poll for the main class.
        let mut main = Value::Null;
        for _ in 0..60 {
            let found = jdtls
                .execute("vscode.java.resolveMainClass", json!([crate::lsp::path_to_uri(&root.to_string_lossy())]))
                .await
                .unwrap_or(Value::Null);
            if let Some(first) = found.as_array().and_then(|entries| entries.first()) {
                main = first.clone();
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        assert!(!main.is_null(), "jdtls found no main class");
        let main_class = main["mainClass"].clone();
        let project = main["projectName"].clone();
        let paths = jdtls
            .execute("vscode.java.resolveClasspath", json!([main_class, project]))
            .await
            .unwrap();
        let java = jdtls
            .execute("vscode.java.resolveJavaExecutable", json!([main_class, project]))
            .await
            .unwrap_or(Value::Null);
        let port = jdtls
            .execute("vscode.java.startDebugSession", json!([]))
            .await
            .unwrap()
            .as_u64()
            .expect("no debug port") as u16;

        let (sender, incoming) = mpsc::unbounded_channel();
        let events = Arc::new(Recorder(Mutex::new(sender), TerminalStandIn::default()));
        let launch = json!({
            "type": "java",
            "request": "launch",
            "mainClass": main_class,
            "projectName": project,
            "modulePaths": paths[0],
            "classPaths": paths[1],
            "javaExec": java,
            "cwd": root,
            "console": "internalConsole",
        });
        let program_str = program.to_string_lossy().into_owned();
        let breakpoints = HashMap::from([(program_str, vec![5])]);
        let session = start_session(events, java_plan(port, launch), breakpoints).await.unwrap();
        let mut harness = Harness {
            session,
            incoming,
            next_seq: 500_000,
            output: String::new(),
            terminal: TerminalStandIn::default(),
            backlog: Default::default(),
        };

        let (thread_id, line, value) = harness.stopped_at("total").await;
        assert_eq!(line, 5);
        assert!(value.contains("10"), "total = {value:?}");
        harness.request("next", json!({ "threadId": thread_id })).await;
        harness.event("stopped").await;
        harness.request("continue", json!({ "threadId": thread_id })).await;
        harness.event_any(&["terminated", "exited"]).await;
        assert!(harness.output.contains("done 10"), "output: {:?}", harness.output);
        harness.session.shutdown().await;
        let _ = jdtls.child.kill().await;
    }

    #[tokio::test]
    async fn debugs_one_junit_test_with_maven() {
        // Needs Maven: SABLE_TEST_MAVEN=/path/to/mvn.
        let Ok(maven) = std::env::var("SABLE_TEST_MAVEN") else {
            eprintln!("skipping: set SABLE_TEST_MAVEN");
            return;
        };
        debug_junit_test("maven", |root, jvm_port| {
            let mut command = Command::new(&maven);
            command
                .arg(format!(
                    "-Dmaven.surefire.debug=-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=localhost:{jvm_port}"
                ))
                .args(["test", "-Dtest=CalcTest#adds", "-DfailIfNoTests=false", "-Dsurefire.failIfNoSpecifiedTests=false"])
                .current_dir(root);
            command
        })
        .await;
    }

    #[tokio::test]
    async fn debugs_one_junit_test_with_gradle() {
        // Needs Gradle: SABLE_TEST_GRADLE=/path/to/gradle.
        let Ok(gradle) = std::env::var("SABLE_TEST_GRADLE") else {
            eprintln!("skipping: set SABLE_TEST_GRADLE");
            return;
        };
        debug_junit_test("gradle", |root, jvm_port| {
            // The same init script the Tests feature writes.
            let script = root.join("sable-debug.gradle");
            std::fs::write(
                &script,
                format!(
                    "allprojects {{\n  tasks.withType(Test).configureEach {{\n    jvmArgs '-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=localhost:{jvm_port}'\n    outputs.upToDateWhen {{ false }}\n  }}\n}}\n"
                ),
            )
            .unwrap();
            let mut command = Command::new(&gradle);
            command
                .arg("--init-script")
                .arg(&script)
                .args(["test", "--tests", "CalcTest.adds", "-i"])
                .current_dir(root);
            command
        })
        .await;
    }

    /// Debug CalcTest.adds as the Tests feature does: wait for the test
    /// JVM, have the build tool start it, attach java-debug through the
    /// relay, stop at a breakpoint in the test, let it finish.
    async fn debug_junit_test(tool: &str, build_command: impl FnOnce(&Path, u16) -> Command) {
        use_app_tools().await;
        if crate::lsp::java_debug_bundle().is_none() {
            eprintln!("skipping: java-debug not installed");
            return;
        }
        let build_file = if tool == "maven" {
            (
                    "pom.xml",
                    "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>demo</groupId>\n  <artifactId>demo</artifactId>\n  <version>1.0</version>\n  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>\n  <dependencies>\n    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n      <artifactId>junit-jupiter</artifactId>\n      <version>5.11.4</version>\n      <scope>test</scope>\n    </dependency>\n  </dependencies>\n  <build>\n    <plugins>\n      <plugin>\n        <artifactId>maven-surefire-plugin</artifactId>\n        <version>3.5.2</version>\n      </plugin>\n    </plugins>\n  </build>\n</project>\n",
            )
        } else {
            (
                "build.gradle",
                "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies {\n    testImplementation 'org.junit.jupiter:junit-jupiter:5.11.4'\n    testRuntimeOnly 'org.junit.platform:junit-platform-launcher'\n}\ntest {\n    useJUnitPlatform()\n    testLogging { showStandardStreams = true }\n}\n",
            )
        };
        let root = write_project(
            &format!("junit-{tool}"),
            &[
                build_file,
                (
                    "src/test/java/demo/CalcTest.java",
                    "package demo;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass CalcTest {\n    @Test\n    void adds() {\n        int total = 0;\n        for (int i = 0; i < 5; i++) total += i;\n        System.out.println(\"done \" + total);\n        assertEquals(10, total);\n    }\n}\n",
                ),
            ],
        );
        let test_file = root.join("src/test/java/demo/CalcTest.java");

        // As the Tests feature does: Sable waits for the test JVM, the
        // build tool starts it, and it connects to Sable…
        let jvm_port = jvm_debug_listen().await.unwrap();
        let mut build = build_command(&root, jvm_port)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(build.stdout.take().unwrap()).lines();
        let (output_tx, mut output_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = output_tx.send(line);
            }
        });
        let port = jvm_debug_accept(jvm_port, 300).await.expect("the test JVM never connected");

        // …and java-debug (inside jdtls) attaches to it.
        let Some(mut jdtls) = Jdtls::start(&root).await else {
            eprintln!("skipping: jdtls unavailable");
            return;
        };
        let text = std::fs::read_to_string(&test_file).unwrap();
        jdtls
            .notify(
                "textDocument/didOpen",
                json!({ "textDocument": {
                    "uri": crate::lsp::path_to_uri(&test_file.to_string_lossy()),
                    "languageId": "java", "version": 1, "text": text,
                }}),
            )
            .await;
        let debug_port = jdtls
            .execute("vscode.java.startDebugSession", json!([]))
            .await
            .unwrap()
            .as_u64()
            .expect("no debug port") as u16;
        let (sender, incoming) = mpsc::unbounded_channel();
        let events = Arc::new(Recorder(Mutex::new(sender), TerminalStandIn::default()));
        let launch = json!({
            "type": "java",
            "request": "attach",
            "hostName": "localhost",
            "port": port,
            "timeout": 30_000,
        });
        let breakpoints = HashMap::from([(test_file.to_string_lossy().into_owned(), vec![11])]);
        let session = start_session(events, java_plan(debug_port, launch), breakpoints).await.unwrap();
        let mut harness = Harness {
            session,
            incoming,
            next_seq: 600_000,
            output: String::new(),
            terminal: TerminalStandIn::default(),
            backlog: Default::default(),
        };
        let (thread_id, line, value) = harness.stopped_at("total").await;
        assert_eq!(line, 11);
        assert!(value.contains("10"), "total = {value:?}");
        harness.request("continue", json!({ "threadId": thread_id })).await;
        harness.event_any(&["terminated", "exited"]).await;
        harness.session.shutdown().await;

        let status = tokio::time::timeout(Duration::from_secs(120), build.wait()).await.unwrap().unwrap();
        let mut rest = String::new();
        while let Ok(line) = output_rx.try_recv() {
            rest.push_str(&line);
            rest.push('\n');
        }
        assert!(status.success(), "{tool} failed:\n{rest}");
        assert!(rest.contains("done 10"), "test output missing:\n{rest}");
        let _ = jdtls.child.kill().await;
    }

    // --- Debugging one test (the launch settings the Tests feature sends) ---

    /// A project directory for a test-framework sample.
    fn write_project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sable-test-debug-{}-{name}", std::process::id()));
        for (path, contents) in files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, contents).unwrap();
        }
        // The temp dir is behind a symlink on macOS (/var → /private/var);
        // Go rejects a package path that differs from its module's.
        dir.canonicalize().unwrap()
    }

    fn test_options(overrides: Value, binary: Option<String>, args: Vec<String>, cwd: &Path) -> RunOptions {
        RunOptions {
            args,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            terminal: true,
            binary,
            overrides: Some(overrides),
            ..RunOptions::default()
        }
    }

    #[tokio::test]
    async fn debugs_one_pytest_test() {
        // Needs an interpreter with pytest and debugpy.
        let Ok(python) = std::env::var("SABLE_TEST_PYTEST_PYTHON") else {
            eprintln!("skipping: set SABLE_TEST_PYTEST_PYTHON");
            return;
        };
        let dir = write_project(
            "pytest",
            &[("test_sample.py", "def test_total():\n    total = sum(range(5))\n    assert total == 10\n    print('done')\n\n\ndef test_other():\n    assert True\n")],
        );
        let file = dir.join("test_sample.py");
        let overrides = json!({
            "module": "pytest",
            "program": null,
            "args": [format!("{}::test_total", file.display()), "-q", "-s", "-p", "no:cacheprovider"],
        });
        exercise_with(file, Some(&python), 3, "total", "10", test_options(overrides, None, vec![], &dir), "", "done").await;
    }

    #[tokio::test]
    async fn debugs_one_go_test() {
        let dir = write_project(
            "go",
            &[
                ("go.mod", "module demo\n\ngo 1.22\n"),
                (
                    "sample_test.go",
                    "package demo\n\nimport (\n\t\"fmt\"\n\t\"testing\"\n)\n\nfunc TestTotal(t *testing.T) {\n\ttotal := 0\n\tfor i := 0; i < 5; i++ {\n\t\ttotal += i\n\t}\n\tfmt.Println(\"done\", total)\n\tif total != 10 {\n\t\tt.Fatal(total)\n\t}\n}\n",
                ),
            ],
        );
        let file = dir.join("sample_test.go");
        let overrides = json!({ "mode": "test", "program": dir, "args": ["-test.run", "^TestTotal$", "-test.v"] });
        exercise_with(file, None, 13, "total", "10", test_options(overrides, None, vec![], &dir), "", "done").await;
    }

    #[tokio::test]
    async fn debugs_one_cargo_test() {
        let dir = write_project(
            "cargo",
            &[
                ("Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n"),
                (
                    "src/lib.rs",
                    "#[cfg(test)]\nmod tests {\n    #[test]\n    fn total() {\n        let total: i32 = (0..5).sum();\n        println!(\"done {total}\");\n        assert_eq!(total, 10);\n    }\n}\n",
                ),
            ],
        );
        // As the frontend does: build the test binary, find it in Cargo's
        // JSON messages.
        let output = std::process::Command::new(resolve_binary("cargo").unwrap())
            .args(["test", "--no-run", "--message-format=json"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let binary = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|message| message["profile"]["test"] == true && message["executable"].is_string())
            .map(|message| message["executable"].as_str().unwrap().to_string())
            .expect("test binary");
        let file = dir.join("src/lib.rs");
        let args = vec!["total".into(), "--test-threads=1".into(), "--nocapture".into()];
        exercise_with(file, None, 6, "total", "10", test_options(json!({}), Some(binary), args, &dir), "", "done 10").await;
    }

    #[tokio::test]
    async fn debugs_one_vitest_test() {
        // Needs a project with vitest installed (node_modules).
        let Ok(project) = std::env::var("SABLE_TEST_VITEST_DIR") else {
            eprintln!("skipping: set SABLE_TEST_VITEST_DIR");
            return;
        };
        use_app_tools().await;
        let dir = PathBuf::from(project);
        let file = dir.join("debug_sample.test.ts");
        std::fs::write(
            &file,
            "import { expect, test } from \"vitest\";\n\ntest(\"total\", () => {\n  let total = 0;\n  for (let i = 0; i < 5; i++) total += i;\n  console.log(\"done\", total);\n  expect(total).toBe(10);\n});\n",
        )
        .unwrap();
        let overrides = json!({
            "program": dir.join("node_modules/vitest/vitest.mjs"),
            "args": ["run", file, "-t", "^(total$)", "--no-file-parallelism"],
        });
        exercise_with(file.clone(), None, 6, "total", "10", test_options(overrides, None, vec![], &dir), "", "1 passed").await;
        let _ = std::fs::remove_file(file);
    }

    #[tokio::test]
    async fn install_debugpy_explains_externally_managed_pythons() {
        // Homebrew's Python refuses pip installs (PEP 668).
        let python = "/opt/homebrew/bin/python3";
        if !Path::new(python).exists() {
            return;
        }
        if let Err(message) = install_debugpy(python.to_string()).await {
            assert!(message.contains("virtual environment"), "{message}");
        }
    }

    #[tokio::test]
    async fn python_breakpoint_step_continue() {
        let python = std::env::var("SABLE_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
        let program = write_program(
            "sample.py",
            "def total(n):\n    acc = 0\n    for i in range(n):\n        acc += i\n    return acc\n\nresult = total(5)\nprint('done', result)\n",
        );
        // Line 5 (`return acc`): acc is 10 there.
        exercise(program, Some(&python), 5, "acc", "10").await;
    }

    #[tokio::test]
    async fn c_breakpoint_step_continue() {
        let program = write_program(
            "sample.c",
            "#include <stdio.h>\n\nint main(void) {\n    int total = 0;\n    for (int i = 0; i < 5; i++) total += i;\n    printf(\"done %d\\n\", total);\n    return 0;\n}\n",
        );
        // Line 6 (printf): total is 10 there.
        exercise(program, None, 6, "total", "10").await;
    }

    #[tokio::test]
    async fn rust_breakpoint_step_continue() {
        let program = write_program(
            "sample.rs",
            "fn main() {\n    let mut total = 0;\n    for i in 0..5 {\n        total += i;\n    }\n    println!(\"done {total}\");\n}\n",
        );
        // Line 6 (println!): total is 10 there.
        exercise(program, None, 6, "total", "10").await;
    }
}
