//! Debugging with VS Code `launch.json` configurations.
//!
//! The frontend reads launch.json, substitutes `${…}` variables and maps
//! each configuration's `type` onto one of Sable's adapters
//! (src/lib/debug/launchRequest.ts). What arrives here is the resolved
//! DAP launch/attach request plus an [`AdapterSpec`] saying which adapter
//! to run it with; this module starts that adapter and runs the usual
//! handshake (debug.rs `start_session`).
//!
//! Sessions started here are *named* (`session`): every event they emit
//! carries `"sableSession": <name>`, so several can run at once (a
//! launch.json `compound`). One of them — the *focused* session — sits in
//! the window's [`DebugManager`], where the existing debug commands
//! (`debug_request`, `debug_stop`) drive it; the others wait in the
//! background until the frontend focuses them (`debug_config_focus`
//! swaps them in).

use crate::debug::{self, Adapter, Breakpoints, DebugEvents, DebugManager, DebugSession, LaunchPlan, Transport};
use crate::lsp::resolve_binary;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

/// Which adapter runs a resolved configuration, and what it needs.
#[derive(serde::Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AdapterSpec {
    /// "debugpy", "js-debug", "go", "lldb" or "java".
    pub kind: String,
    /// debugpy: the interpreter that runs the adapter.
    pub python: Option<String>,
    /// java: the port java-debug (inside jdtls) listens on.
    pub port: Option<u16>,
    /// go: run Delve in a terminal tab (the program reads keyboard input).
    pub terminal: bool,
    /// lldb: build with `cargo <args>` first and debug what it built
    /// (CodeLLDB's `cargo` property).
    pub cargo: Option<Vec<String>>,
    /// lldb: CodeLLDB's `cargo.filter` (`{name?, kind?}`) to pick the artifact.
    pub cargo_filter: Option<Value>,
    /// Where builds run.
    pub cwd: Option<String>,
}

/// Adds `"sableSession": <name>` to everything a session emits.
struct TaggedEvents {
    inner: Arc<dyn DebugEvents>,
    session: String,
}

impl DebugEvents for TaggedEvents {
    fn emit(&self, event: &str, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("sableSession".into(), json!(self.session));
        }
        self.inner.emit(event, payload);
    }
}

/// One window's (or the agent's) named sessions.
#[derive(Default)]
struct Scope {
    /// The named session in the window's DebugManager, if any.
    focused: Option<String>,
    /// Sessions running in the background (compounds).
    background: HashMap<String, DebugSession>,
}

static SCOPES: LazyLock<AsyncMutex<HashMap<String, Scope>>> = LazyLock::new(Default::default);

/// A program by name: as given when it's a path, else Sable's usual
/// locations, else PATH.
fn find_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        return Some(PathBuf::from(name));
    }
    resolve_binary(name).or_else(|| {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
        })
    })
}

fn is_local(host: &str) -> bool {
    matches!(host, "" | "localhost" | "127.0.0.1" | "::1")
}

/// The adapter and transport for a resolved configuration.
pub async fn plan_for(events: &dyn DebugEvents, spec: &AdapterSpec, mut launch: Value) -> Result<LaunchPlan, String> {
    let request = launch["request"].as_str().unwrap_or("launch").to_string();
    match spec.kind.as_str() {
        "debugpy" => {
            let python = spec.python.clone().filter(|python| !python.is_empty()).unwrap_or_else(|| "python3".into());
            let has_debugpy = Command::new(&python)
                .args(["-c", "import debugpy"])
                .output()
                .await
                .map(|output| output.status.success())
                .unwrap_or(false);
            if has_debugpy {
                return Ok(LaunchPlan {
                    adapter: Some(Adapter {
                        program: PathBuf::from(&python),
                        args: vec!["-m".into(), "debugpy.adapter".into()],
                        extra_path: vec![],
                    }),
                    transport: Transport::Stdio,
                    adapter_id: "debugpy",
                    launch,
                    exception_filters: vec!["uncaught"],
                });
            }
            // Attaching to `python -m debugpy --listen PORT` on this
            // machine needs no local debugpy: its adapter is in the program.
            let connect = &launch["connect"];
            if request == "attach" && is_local(connect["host"].as_str().unwrap_or("")) {
                if let Some(port) = connect["port"].as_u64() {
                    return Ok(LaunchPlan {
                        adapter: None,
                        transport: Transport::Tcp(port as u16),
                        adapter_id: "debugpy",
                        launch,
                        exception_filters: vec!["uncaught"],
                    });
                }
            }
            Err(format!("debugpy-missing:{python}"))
        }
        "js-debug" => {
            let node = find_program("node").ok_or_else(|| "node not found — install Node.js".to_string())?;
            let server = debug::js_debug_server().ok_or_else(|| "js-debug-missing".to_string())?;
            let is_node = launch["type"] == "pwa-node";
            if request == "launch" && is_node {
                // GUI apps don't get the shell's PATH: name the runtime
                // (node, npm, yarn…) by its full path.
                match launch["runtimeExecutable"].as_str() {
                    None | Some("") | Some("node") => launch["runtimeExecutable"] = json!(node.to_string_lossy()),
                    Some(name) => {
                        if let Some(path) = find_program(name) {
                            launch["runtimeExecutable"] = json!(path.to_string_lossy());
                        }
                    }
                }
            }
            Ok(LaunchPlan {
                adapter: Some(Adapter {
                    program: node.clone(),
                    args: vec![server.to_string_lossy().into_owned(), "0".into(), "127.0.0.1".into()],
                    extra_path: node.parent().map(Path::to_path_buf).into_iter().collect(),
                }),
                transport: Transport::TcpFromOutput,
                adapter_id: "js-debug",
                launch,
                exception_filters: vec!["uncaught"],
            })
        }
        "go" => {
            let dlv = find_program("dlv").ok_or_else(|| {
                "Delve not found — run `brew install delve` (or `go install github.com/go-delve/delve/cmd/dlv@latest`)".to_string()
            })?;
            let go = find_program("go").ok_or_else(|| "go not found — run `brew install go`".to_string())?;
            if request == "launch" {
                debug::console_output(events, "console", "Building with Delve…");
            }
            Ok(LaunchPlan {
                adapter: Some(Adapter {
                    program: dlv,
                    args: vec!["dap".into(), "--listen=127.0.0.1:0".into()],
                    extra_path: go.parent().map(Path::to_path_buf).into_iter().collect(),
                }),
                transport: if spec.terminal && request == "launch" { Transport::TerminalDialIn } else { Transport::TcpFromOutput },
                adapter_id: "go",
                launch,
                exception_filters: vec![],
            })
        }
        "lldb" => {
            let adapter = find_program("lldb-dap").filter(|path| path.exists()).ok_or_else(|| {
                "lldb-dap not found — install the Xcode Command Line Tools (`xcode-select --install`) or LLVM (`brew install llvm`)"
                    .to_string()
            })?;
            if let Some(args) = &spec.cargo {
                let cwd = spec.cwd.clone().unwrap_or_else(|| ".".into());
                let binary = cargo_build(events, args, spec.cargo_filter.as_ref(), Path::new(&cwd)).await?;
                launch["program"] = json!(binary.to_string_lossy());
            }
            // lldb-dap takes the environment as "NAME=value" strings.
            if let Some(env) = launch["env"].as_object() {
                let pairs: Vec<String> = env
                    .iter()
                    .map(|(name, value)| format!("{name}={}", value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())))
                    .collect();
                launch["env"] = json!(pairs);
            }
            Ok(LaunchPlan {
                adapter: Some(Adapter { program: adapter, args: vec![], extra_path: vec![] }),
                transport: Transport::Stdio,
                adapter_id: "lldb-dap",
                launch,
                exception_filters: vec![],
            })
        }
        "java" => {
            let port = spec.port.ok_or_else(|| "The Java debugger didn't start".to_string())?;
            Ok(debug::java_plan(port, launch))
        }
        other => Err(format!("Sable has no debug adapter for “{other}”")),
    }
}

/// CodeLLDB's `cargo`: build, then debug the executable it reports.
async fn cargo_build(events: &dyn DebugEvents, args: &[String], filter: Option<&Value>, cwd: &Path) -> Result<PathBuf, String> {
    let cargo = find_program("cargo").ok_or_else(|| "cargo not found".to_string())?;
    let mut args = args.to_vec();
    if !args.iter().any(|arg| arg.starts_with("--message-format")) {
        args.push("--message-format=json-render-diagnostics".into());
    }
    let output = debug::run_build(events, &cargo, &args, cwd).await?;
    let wanted_name = filter.and_then(|filter| filter["name"].as_str());
    let wanted_kind = filter.and_then(|filter| filter["kind"].as_str());
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|message| message["reason"] == "compiler-artifact")
        .filter(|message| wanted_name.is_none_or(|name| message["target"]["name"] == name))
        .filter(|message| {
            wanted_kind.is_none_or(|kind| message["target"]["kind"].as_array().is_some_and(|kinds| kinds.iter().any(|k| k == kind)))
        })
        .filter_map(|message| message["executable"].as_str().map(PathBuf::from))
        .next_back()
        .ok_or_else(|| "cargo built no executable to debug — check the configuration's cargo.args / cargo.filter".to_string())
}

/// Start a named session. In the foreground it replaces the window's
/// current session; in the background it runs alongside (compounds).
#[allow(clippy::too_many_arguments)]
pub async fn start(
    scope: &str,
    events: Arc<dyn DebugEvents>,
    manager: &DebugManager,
    session: String,
    spec: AdapterSpec,
    launch: Value,
    breakpoints: Breakpoints,
    background: bool,
) -> Result<(), String> {
    let tagged: Arc<dyn DebugEvents> = Arc::new(TaggedEvents { inner: events, session: session.clone() });
    // Anything with the same name (a restart) goes first.
    stop_session(scope, manager, &session).await;
    if !background {
        if let Some(old) = manager.0.lock().await.take() {
            old.shutdown().await;
        }
        SCOPES.lock().await.entry(scope.to_string()).or_default().focused = None;
    }
    let plan = plan_for(tagged.as_ref(), &spec, launch).await?;
    let started = debug::start_session(tagged, plan, breakpoints).await?;
    let mut scopes = SCOPES.lock().await;
    let entry = scopes.entry(scope.to_string()).or_default();
    if background {
        entry.background.insert(session, started);
    } else {
        *manager.0.lock().await = Some(started);
        entry.focused = Some(session);
    }
    Ok(())
}

/// Make a background session the one the debug commands drive; the
/// previously focused one moves to the background.
pub async fn focus(scope: &str, manager: &DebugManager, session: &str) -> Result<(), String> {
    let mut scopes = SCOPES.lock().await;
    let entry = scopes.entry(scope.to_string()).or_default();
    if entry.focused.as_deref() == Some(session) {
        return Ok(());
    }
    let next = entry.background.remove(session).ok_or_else(|| format!("No debug session “{session}”"))?;
    let mut slot = manager.0.lock().await;
    if let Some(previous) = slot.take() {
        match entry.focused.take() {
            Some(name) => {
                entry.background.insert(name, previous);
            }
            None => previous.shutdown().await,
        }
    }
    *slot = Some(next);
    entry.focused = Some(session.to_string());
    Ok(())
}

/// Stop one named session, wherever it is.
pub async fn stop_session(scope: &str, manager: &DebugManager, session: &str) {
    let mut scopes = SCOPES.lock().await;
    let entry = scopes.entry(scope.to_string()).or_default();
    if entry.focused.as_deref() == Some(session) {
        entry.focused = None;
        if let Some(focused) = manager.0.lock().await.take() {
            focused.shutdown().await;
        }
    } else if let Some(background) = entry.background.remove(session) {
        background.shutdown().await;
    }
}

/// Stop every session (focused and background).
pub async fn stop_all(scope: &str, manager: &DebugManager) {
    let sessions: Vec<DebugSession> = {
        let mut scopes = SCOPES.lock().await;
        let entry = scopes.entry(scope.to_string()).or_default();
        entry.focused = None;
        entry.background.drain().map(|(_, session)| session).collect()
    };
    for session in sessions {
        session.shutdown().await;
    }
    if let Some(focused) = manager.0.lock().await.take() {
        focused.shutdown().await;
    }
}

/// A named session's runInTerminal program started (or couldn't).
pub async fn terminal_started(
    scope: &str,
    manager: &DebugManager,
    session: &str,
    id: u64,
    process_id: Option<u32>,
    error: Option<String>,
) -> Result<(), String> {
    let scopes = SCOPES.lock().await;
    let entry = scopes.get(scope);
    match entry.and_then(|entry| entry.background.get(session)) {
        Some(background) => background.complete_terminal(id, process_id, error),
        None => {
            drop(scopes);
            debug::terminal_started(manager, id, process_id, error).await?;
        }
    }
    Ok(())
}

/// What `${env:…}`, `${userHome}` and `${pathSeparator}` resolve to.
pub fn environment() -> Value {
    let env: HashMap<String, String> = std::env::vars().collect();
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    json!({
        "env": env,
        "userHome": home,
        "pathSeparator": std::path::MAIN_SEPARATOR.to_string(),
        "platform": std::env::consts::OS,
    })
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|error| format!("argument {key}: {error}"))
}

/// The `debug_config_*` commands, for the UI test bridge and the remote
/// agent (`None`: not one of them).
pub async fn dispatch(
    scope: &str,
    events: Arc<dyn DebugEvents>,
    manager: &DebugManager,
    command: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    let result = match command {
        "debug_config_start" => async {
            start(
                scope,
                events,
                manager,
                arg(args, "session")?,
                arg(args, "adapter")?,
                arg(args, "launch")?,
                arg(args, "breakpoints")?,
                arg::<Option<bool>>(args, "background")?.unwrap_or(false),
            )
            .await
            .map(|_| Value::Null)
        }
        .await,
        "debug_config_focus" => async { focus(scope, manager, &arg::<String>(args, "session")?).await.map(|_| Value::Null) }.await,
        "debug_config_stop" => async {
            stop_session(scope, manager, &arg::<String>(args, "session")?).await;
            Ok(Value::Null)
        }
        .await,
        "debug_config_stop_all" => {
            stop_all(scope, manager).await;
            Ok(Value::Null)
        }
        "debug_config_terminal_started" => async {
            terminal_started(
                scope,
                manager,
                &arg::<String>(args, "session")?,
                arg(args, "id")?,
                arg(args, "processId")?,
                arg(args, "error")?,
            )
            .await
            .map(|_| Value::Null)
        }
        .await,
        "debug_config_environment" => Ok(environment()),
        _ => return None,
    };
    Some(result)
}

// --- Tauri commands ----------------------------------------------------------

#[cfg(feature = "desktop")]
mod commands {
    use super::*;
    use tauri::State;

    type Managers<'a> = State<'a, crate::windows::PerWindow<DebugManager>>;

    fn events(window: &tauri::WebviewWindow) -> Arc<dyn DebugEvents> {
        Arc::new(debug::SinkEvents(crate::events::for_window(window)))
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn debug_config_start(
        window: tauri::WebviewWindow,
        managers: Managers<'_>,
        session: String,
        adapter: AdapterSpec,
        launch: Value,
        breakpoints: Breakpoints,
        background: Option<bool>,
    ) -> Result<(), String> {
        let manager = managers.get(window.label());
        start(window.label(), events(&window), &manager, session, adapter, launch, breakpoints, background.unwrap_or(false)).await
    }

    #[tauri::command]
    pub async fn debug_config_focus(window: tauri::WebviewWindow, managers: Managers<'_>, session: String) -> Result<(), String> {
        focus(window.label(), &managers.get(window.label()), &session).await
    }

    #[tauri::command]
    pub async fn debug_config_stop(window: tauri::WebviewWindow, managers: Managers<'_>, session: String) -> Result<(), String> {
        stop_session(window.label(), &managers.get(window.label()), &session).await;
        Ok(())
    }

    #[tauri::command]
    pub async fn debug_config_stop_all(window: tauri::WebviewWindow, managers: Managers<'_>) -> Result<(), String> {
        stop_all(window.label(), &managers.get(window.label())).await;
        Ok(())
    }

    #[tauri::command]
    pub async fn debug_config_terminal_started(
        window: tauri::WebviewWindow,
        managers: Managers<'_>,
        session: String,
        id: u64,
        process_id: Option<u32>,
        error: Option<String>,
    ) -> Result<(), String> {
        terminal_started(window.label(), &managers.get(window.label()), &session, id, process_id, error).await
    }

    #[tauri::command]
    pub fn debug_config_environment() -> Value {
        environment()
    }
}

#[cfg(feature = "desktop")]
pub use commands::*;

#[cfg(test)]
mod tests {
    use super::*;

    struct Collect(std::sync::Mutex<Vec<(String, Value)>>);
    impl DebugEvents for Collect {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[test]
    fn tags_every_event_with_its_session() {
        let inner = Arc::new(Collect(Default::default()));
        let tagged = TaggedEvents { inner: inner.clone(), session: "s1".into() };
        tagged.emit("debug:message", json!({ "type": "event", "event": "stopped" }));
        tagged.emit("debug:status", json!({ "state": "terminated" }));
        let seen = inner.0.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|(_, payload)| payload["sableSession"] == "s1"));
    }

    #[test]
    fn environment_has_home_and_separator() {
        let environment = environment();
        assert!(environment["env"].is_object());
        assert_eq!(environment["pathSeparator"], std::path::MAIN_SEPARATOR.to_string());
    }

    #[tokio::test]
    async fn unknown_adapters_and_missing_ports_are_errors() {
        let events = Collect(Default::default());
        let error = plan_for(&events, &AdapterSpec { kind: "php".into(), ..Default::default() }, json!({})).await.err().unwrap();
        assert!(error.contains("php"), "{error}");
        let error = plan_for(&events, &AdapterSpec { kind: "java".into(), ..Default::default() }, json!({})).await.err().unwrap();
        assert!(error.contains("Java"), "{error}");
    }

    #[tokio::test]
    async fn python_without_debugpy_is_reported_as_missing() {
        let events = Collect(Default::default());
        let spec = AdapterSpec { kind: "debugpy".into(), python: Some("/nonexistent/python".into()), ..Default::default() };
        let error = plan_for(&events, &spec, json!({ "request": "launch" })).await.err().unwrap();
        assert_eq!(error, "debugpy-missing:/nonexistent/python");
        // …but attaching to a local `debugpy --listen` needs no local debugpy.
        let plan = plan_for(&events, &spec, json!({ "request": "attach", "connect": { "host": "localhost", "port": 5678 } })).await.unwrap();
        assert!(matches!(plan.transport, Transport::Tcp(5678)));
    }

    #[tokio::test]
    async fn stopping_unknown_sessions_is_harmless() {
        let manager = DebugManager::default();
        stop_session("test-scope", &manager, "nothing").await;
        assert!(focus("test-scope", &manager, "nothing").await.is_err());
        stop_all("test-scope", &manager).await;
    }
}
