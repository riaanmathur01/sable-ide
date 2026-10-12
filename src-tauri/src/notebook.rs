//! Jupyter notebooks: kernels, run through a small Python helper
//! (notebook_helper.py, shipped inside the app) that uses `jupyter_client`
//! with the workspace's Python interpreter. The helper relays Jupyter's
//! messaging protocol as JSON lines; here each notebook (keyed by a
//! session id from the frontend) owns one helper process, commands go to
//! its stdin, and what it prints comes back as `notebook:message` events
//! `{session, message}`. Closing a notebook closes the helper's stdin,
//! which shuts its kernel down.
//!
//! Builds into the remote agent too (agent.rs), so notebooks in an SSH,
//! WSL or container workspace run their kernels over there.

use crate::events::{emit, Events};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// The helper script, written to a temp folder on first use.
const HELPER: &str = include_str!("notebook_helper.py");

/// The event each helper line arrives as.
pub const EVENT: &str = "notebook:message";

/// How many of the helper's last stderr lines to keep (for errors).
const STDERR_LINES: usize = 40;

struct Session {
    /// Lines for the helper's stdin; dropping it closes stdin.
    lines: mpsc::UnboundedSender<String>,
    child: Child,
}

/// The running helpers, by session id.
#[derive(Default)]
pub struct NotebookState {
    sessions: tokio::sync::Mutex<HashMap<String, Session>>,
}

/// The interpreter to run: the selected one if it exists, else python3.
fn python_program(python: Option<String>) -> String {
    python.filter(|python| !python.is_empty() && Path::new(python).exists()).unwrap_or_else(|| {
        if cfg!(windows) { "python" } else { "python3" }.to_string()
    })
}

/// The helper on disk (rewritten when Sable's copy changes).
fn helper_path() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("sable-notebook-{}", env!("CARGO_PKG_VERSION")));
    let path = dir.join("sable_kernel_helper.py");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(HELPER) {
        std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
        // Write beside it, then rename: another window may be starting one.
        let temporary = dir.join(format!("helper-{}.tmp", std::process::id()));
        std::fs::write(&temporary, HELPER).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

/// One line the helper printed, as the event payload for the frontend.
/// Anything that isn't a JSON object (a stray print) arrives as a log line.
pub fn relay_line(session: &str, line: &str) -> Option<Value> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let message = match serde_json::from_str::<Value>(line) {
        Ok(value) if value.is_object() => value,
        _ => json!({ "type": "log", "text": line }),
    };
    Some(json!({ "session": session, "message": message }))
}

/// Start `program args…` as session `session`'s helper and relay its
/// output. (The kernel helper in the app; any line-based program in tests.)
pub async fn spawn_helper(
    events: Events,
    state: &NotebookState,
    session: String,
    program: &str,
    args: &[String],
) -> Result<(), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .kill_on_drop(true);
    // Not the workspace: its modules mustn't shadow the helper's.
    if let Some(dir) = helper_path().ok().and_then(|path| path.parent().map(Path::to_path_buf)) {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        // No console window flashing up for the helper.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| format!("Could not run {program}: {error}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Writer: owns stdin; ends (closing it) when the session is dropped.
    let (lines, mut incoming) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = incoming.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    // The last stderr lines, to explain an unexpected exit.
    let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let stderr_tail = tail.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let mut tail = stderr_tail.lock().unwrap();
            if tail.len() == STDERR_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });

    // Reader: every stdout line → an event; then "exited".
    let id = session.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(payload) = relay_line(&id, &line) {
                emit(&events, EVENT, payload);
            }
        }
        // Give the stderr reader a moment to catch the last lines.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let stderr: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
        emit(&events, EVENT, json!({ "session": id, "message": { "type": "exited", "stderr": stderr.join("\n") } }));
    });

    let previous = state.sessions.lock().await.insert(session, Session { lines, child });
    if let Some(previous) = previous {
        finish(previous).await;
    }
    Ok(())
}

/// Start a kernel helper for a notebook, then its kernel (`kernel`: a
/// kernelspec name; `cwd`: the notebook's folder).
pub async fn start(
    events: Events,
    state: &NotebookState,
    session: String,
    python: Option<String>,
    kernel: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let helper = helper_path()?;
    let program = python_program(python);
    let args = vec!["-u".to_string(), helper.to_string_lossy().into_owned()];
    spawn_helper(events, state, session.clone(), &program, &args).await?;
    send(state, session, json!({ "op": "start", "kernel": kernel.unwrap_or_else(|| "python3".into()), "cwd": cwd })).await
}

/// Send a command (`{"op": "execute", …}`, see the helper) to a session.
pub async fn send(state: &NotebookState, session: String, message: Value) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let entry = sessions.get(&session).ok_or("The kernel isn't running")?;
    entry.lines.send(message.to_string()).map_err(|_| "The kernel helper has exited".to_string())
}

/// Close stdin (the helper shuts its kernel down and exits); kill it if
/// it hasn't after a few seconds.
async fn finish(session: Session) {
    let Session { lines, mut child } = session;
    let _ = lines.send(json!({ "op": "shutdown" }).to_string());
    drop(lines);
    if tokio::time::timeout(Duration::from_secs(8), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
}

/// Shut a notebook's kernel down.
pub async fn stop(state: &NotebookState, session: String) -> Result<(), String> {
    let removed = state.sessions.lock().await.remove(&session);
    if let Some(removed) = removed {
        finish(removed).await;
    }
    Ok(())
}

/// Shut every kernel down (the app or agent is going away).
pub async fn stop_all(state: &NotebookState) {
    let all: Vec<Session> = state.sessions.lock().await.drain().map(|(_, session)| session).collect();
    for session in all {
        finish(session).await;
    }
}

/// The kernels the interpreter's Jupyter knows: `{specs: {name:
/// {display_name, language}}, missing: [packages], python}`.
pub async fn kernelspecs(python: Option<String>) -> Result<Value, String> {
    let helper = helper_path()?;
    let program = python_program(python);
    let mut command = Command::new(&program);
    command.arg("-u").arg(&helper).arg("--specs").kill_on_drop(true);
    if let Some(dir) = helper.parent() {
        command.current_dir(dir);
    }
    let output = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .map_err(|_| "Listing kernels took too long".to_string())?
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok().filter(|value| value["type"] == "specs"))
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!("Couldn't list kernels: {}", stderr.trim().lines().last().unwrap_or("no output"))
        })
}

/// `python -m pip install ipykernel` (which brings jupyter_client) for
/// the selected interpreter.
pub async fn install_ipykernel(python: Option<String>) -> Result<(), String> {
    let program = python_program(python);
    let output = Command::new(&program)
        .args(["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "ipykernel"])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("externally-managed-environment") {
        return Err(format!(
            "{program} is managed by the system and won't take pip installs. Create a virtual environment (status bar → Python interpreter → Create venv) and select it."
        ));
    }
    let last = stderr.trim().lines().filter(|line| !line.trim().is_empty()).last().unwrap_or("pip failed");
    Err(format!("Installing ipykernel failed: {last}"))
}

// --- Tauri commands ------------------------------------------------------------------------

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notebook_kernelspecs(python: Option<String>) -> Result<Value, String> {
    kernelspecs(python).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notebook_start(
    window: tauri::WebviewWindow,
    states: tauri::State<'_, crate::windows::PerWindow<NotebookState>>,
    session: String,
    python: Option<String>,
    kernel: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    start(crate::events::for_window(&window), &states.get(window.label()), session, python, kernel, cwd).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notebook_send(
    window: tauri::WebviewWindow,
    states: tauri::State<'_, crate::windows::PerWindow<NotebookState>>,
    session: String,
    message: Value,
) -> Result<(), String> {
    send(&states.get(window.label()), session, message).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notebook_stop(
    window: tauri::WebviewWindow,
    states: tauri::State<'_, crate::windows::PerWindow<NotebookState>>,
    session: String,
) -> Result<(), String> {
    stop(&states.get(window.label()), session).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn notebook_install_ipykernel(python: Option<String>) -> Result<(), String> {
    install_ipykernel(python).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Events, collected.
    fn collector() -> (Events, Arc<Mutex<Vec<(String, Value)>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let events: Events = Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_string(), payload)));
        (events, seen)
    }

    async fn wait_for(seen: &Arc<Mutex<Vec<(String, Value)>>>, done: impl Fn(&[(String, Value)]) -> bool, secs: u64) {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if done(&seen.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out; events: {:?}", seen.lock().unwrap());
    }

    fn messages(seen: &[(String, Value)], session: &str) -> Vec<Value> {
        seen.iter()
            .filter(|(name, payload)| name == EVENT && payload["session"] == session)
            .map(|(_, payload)| payload["message"].clone())
            .collect()
    }

    #[test]
    fn relays_json_lines_and_wraps_the_rest() {
        let payload = relay_line("nb-1", r#"{"type":"status","state":"idle"}"#).unwrap();
        assert_eq!(payload, json!({ "session": "nb-1", "message": { "type": "status", "state": "idle" } }));
        let payload = relay_line("nb-1", "Traceback (most recent call last):").unwrap();
        assert_eq!(payload["message"], json!({ "type": "log", "text": "Traceback (most recent call last):" }));
        // A JSON value that isn't an object is a log line too.
        assert_eq!(relay_line("nb-1", "42").unwrap()["message"]["type"], "log");
        assert!(relay_line("nb-1", "   ").is_none());
    }

    #[test]
    fn helper_is_written_to_disk() {
        let path = helper_path().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HELPER);
        assert_eq!(helper_path().unwrap(), path);
    }

    /// The relay with a stand-in helper: commands in on stdin, lines out
    /// as events, "exited" when it ends, and stop() closing stdin.
    #[cfg(unix)]
    #[tokio::test]
    async fn relays_a_session_and_stops_it() {
        let (events, seen) = collector();
        let state = NotebookState::default();
        // Echo each command back as {"type":"echo","got":<line>}, print a
        // stray line, and exit when stdin closes.
        let script = r#"while IFS= read -r line; do printf '{"type":"echo","got":%s}\n' "$line"; echo "not json"; done; echo '{"type":"bye"}'"#;
        spawn_helper(events, &state, "s1".into(), "sh", &["-c".into(), script.into()]).await.unwrap();
        send(&state, "s1".into(), json!({ "op": "execute", "req": "r1", "code": "1+1" })).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "s1").iter().any(|m| m["type"] == "log"), 10).await;
        let got = messages(&seen.lock().unwrap(), "s1");
        assert_eq!(got[0], json!({ "type": "echo", "got": { "op": "execute", "req": "r1", "code": "1+1" } }));
        assert_eq!(got[1], json!({ "type": "log", "text": "not json" }));

        stop(&state, "s1".into()).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "s1").iter().any(|m| m["type"] == "exited"), 10).await;
        let got = messages(&seen.lock().unwrap(), "s1");
        // The helper was told to shut down, then saw stdin close.
        assert!(got.iter().any(|m| m["type"] == "echo" && m["got"]["op"] == "shutdown"));
        assert!(got.iter().any(|m| m["type"] == "bye"));
        assert!(send(&state, "s1".into(), json!({ "op": "interrupt" })).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_stderr_when_the_helper_dies() {
        let (events, seen) = collector();
        let state = NotebookState::default();
        spawn_helper(events, &state, "s2".into(), "sh", &["-c".into(), "echo boom >&2; exit 3".into()]).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "s2").iter().any(|m| m["type"] == "exited"), 10).await;
        let exited = messages(&seen.lock().unwrap(), "s2").into_iter().find(|m| m["type"] == "exited").unwrap();
        assert_eq!(exited["stderr"], "boom");
        stop_all(&state).await;
    }

    /// The interpreter for the real-kernel tests: SABLE_TEST_JUPYTER_PYTHON,
    /// or python3 if it has jupyter_client and ipykernel.
    fn jupyter_python() -> Option<String> {
        let python = std::env::var("SABLE_TEST_JUPYTER_PYTHON").unwrap_or_else(|_| "python3".into());
        let ok = std::process::Command::new(&python)
            .args(["-c", "import jupyter_client, ipykernel"])
            .output()
            .is_ok_and(|output| output.status.success());
        if ok {
            Some(python)
        } else {
            eprintln!("skipping: {python} lacks jupyter_client/ipykernel (set SABLE_TEST_JUPYTER_PYTHON)");
            None
        }
    }

    #[tokio::test]
    async fn kernelspecs_report_missing_packages_or_python3() {
        // Whatever python3 has: either the python3 kernel, or what's missing.
        let Ok(specs) = kernelspecs(None).await else { return };
        let missing = specs["missing"].as_array().cloned().unwrap_or_default();
        assert!(!missing.is_empty() || specs["specs"]["python3"].is_object(), "{specs}");
    }

    /// End to end with a real kernel: run code, read its outputs.
    #[tokio::test]
    async fn runs_code_on_a_real_kernel() {
        let Some(python) = jupyter_python() else { return };
        let specs = kernelspecs(Some(python.clone())).await.unwrap();
        assert!(specs["specs"]["python3"].is_object(), "{specs}");

        let (events, seen) = collector();
        let state = NotebookState::default();
        start(events, &state, "k1".into(), Some(python), None, None).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "k1").iter().any(|m| m["type"] == "started"), 120).await;
        send(&state, "k1".into(), json!({ "op": "execute", "req": "a", "code": "print('hi')\n6*7" })).await.unwrap();
        wait_for(
            &seen,
            |seen| messages(seen, "k1").iter().any(|m| m["type"] == "status" && m["state"] == "idle" && m["req"] == "a"),
            60,
        )
        .await;
        let got = messages(&seen.lock().unwrap(), "k1");
        let of = |kind: &str| got.iter().find(|m| m["req"] == "a" && m["msg_type"] == kind).cloned().unwrap();
        assert_eq!(of("stream")["content"]["text"], "hi\n");
        assert_eq!(of("execute_result")["content"]["data"]["text/plain"], "42");
        assert_eq!(of("execute_reply")["content"]["status"], "ok");

        // An error, then a completion.
        send(&state, "k1".into(), json!({ "op": "execute", "req": "b", "code": "1/0" })).await.unwrap();
        send(&state, "k1".into(), json!({ "op": "complete", "req": "c", "code": "import o", "cursor_pos": 8 })).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "k1").iter().any(|m| m["msg_type"] == "complete_reply"), 60).await;
        let got = messages(&seen.lock().unwrap(), "k1");
        let error = got.iter().find(|m| m["req"] == "b" && m["msg_type"] == "error").unwrap();
        assert_eq!(error["content"]["ename"], "ZeroDivisionError");
        let completion = got.iter().find(|m| m["msg_type"] == "complete_reply").unwrap();
        assert!(completion["content"]["matches"].as_array().unwrap().iter().any(|m| m == "os"));

        stop(&state, "k1".into()).await.unwrap();
        wait_for(&seen, |seen| messages(seen, "k1").iter().any(|m| m["type"] == "exited"), 20).await;
    }
}
