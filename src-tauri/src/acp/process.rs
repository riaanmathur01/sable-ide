//! Running agents: one process per agent connection, speaking ACP
//! (JSON-RPC 2.0, one message per line) on its stdin/stdout. Lines are
//! relayed untouched as `acp:message` events `{instance, line}` — the
//! frontend (src/lib/acp) owns the protocol; lines from the frontend go to
//! stdin. The agent's stderr arrives as `acp:stderr`, its end as `acp:exit`.

use super::install::{self, InstalledAgent};
use crate::events::{emit, Events};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

pub const MESSAGE: &str = "acp:message";
pub const STDERR: &str = "acp:stderr";
pub const EXIT: &str = "acp:exit";
const STDERR_LINES: usize = 60;

/// What to run: an installed agent (by id), its environment, and
/// optionally other arguments (a login command) in place of its own.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub agent_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Variables taken out of the inherited environment.
    #[serde(default)]
    pub unset: Vec<String>,
    /// Replace the agent's ACP arguments (terminal sign-in, status checks).
    #[serde(default)]
    pub args: Option<Vec<String>>,
    /// Arguments added after the agent's own.
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// Files (its config) written into the agent's data folder first.
    #[serde(default)]
    pub files: Vec<super::env::AgentFile>,
}

/// A program line: program, its arguments, environment.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub unset: Vec<String>,
}

struct Running {
    lines: mpsc::UnboundedSender<String>,
    child: Arc<tokio::sync::Mutex<Child>>,
}

/// The agent processes a window (or the remote agent) is running.
#[derive(Default)]
pub struct AcpProcesses {
    running: Mutex<HashMap<u64, Running>>,
}

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

/// The user's login-shell PATH (apps started from the Dock get a minimal
/// one; agents run the user's tools), read once.
fn login_path() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            if cfg!(windows) {
                return None;
            }
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let output = std::process::Command::new(shell)
                    .args(["-l", "-c", "printf '%s' \"$PATH\""])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output();
                let _ = sender.send(output.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()));
            });
            receiver.recv_timeout(Duration::from_secs(4)).ok().flatten().filter(|path| !path.is_empty())
        })
        .clone()
}

/// PATH for agents and their tools: Node's folder, the login shell's PATH,
/// this process's PATH and the usual install folders.
pub fn search_path(node: Option<&Path>) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.and_then(Path::parent) {
        dirs.push(dir.to_path_buf());
    }
    for source in [login_path(), std::env::var("PATH").ok()].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&source));
    }
    if !cfg!(windows) {
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            dirs.push(extra.into());
        }
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// The command line for an installed agent and a request.
pub fn launch_spec(agent: &InstalledAgent, request: &SpawnRequest) -> Result<LaunchSpec, String> {
    let mut args: Vec<String> = Vec::new();
    let program = if agent.node {
        let node = install::node().ok_or(install::NODE_MISSING)?;
        args.push(agent.program.clone());
        node.to_string_lossy().into_owned()
    } else {
        agent.program.clone()
    };
    match &request.args {
        Some(replacement) => args.extend(replacement.iter().cloned()),
        None => args.extend(agent.args.iter().cloned()),
    }
    args.extend(request.extra_args.iter().cloned());
    let mut env = agent.env.clone();
    env.extend(request.env.clone());
    let node = install::node();
    env.insert("PATH".into(), search_path(node.as_deref()).to_string_lossy().into_owned());
    // What's set explicitly isn't also removed.
    let unset = request.unset.iter().filter(|name| !env.contains_key(*name)).cloned().collect();
    Ok(LaunchSpec { program, args, cwd: request.cwd.clone().or_else(|| Some(agent.dir.clone())), env, unset })
}

fn command_for(spec: &LaunchSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    for name in &spec.unset {
        command.env_remove(name);
    }
    command.envs(&spec.env);
    if let Some(cwd) = spec.cwd.as_deref().filter(|cwd| Path::new(cwd).is_dir()) {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

/// One stdout line → the event payload (None for blank lines). The line
/// stays a string: the frontend parses and validates JSON-RPC.
pub fn relay_line(instance: u64, line: &str) -> Option<Value> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() {
        return None;
    }
    Some(json!({ "instance": instance, "line": line }))
}

/// Start an agent; returns the instance its events carry.
pub async fn spawn(events: Events, state: &AcpProcesses, spec: LaunchSpec) -> Result<u64, String> {
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::SeqCst);
    let mut command = command_for(&spec);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| format!("Couldn't start {}: {error}", spec.program))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let (lines, mut incoming) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = incoming.recv().await {
            let mut bytes = line.into_bytes();
            bytes.retain(|byte| *byte != b'\n' && *byte != b'\r');
            bytes.push(b'\n');
            if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });

    let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    {
        let tail = tail.clone();
        let events = events.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            while matches!(reader.read_until(b'\n', &mut buffer).await, Ok(n) if n > 0) {
                let line = String::from_utf8_lossy(&buffer).trim_end().to_string();
                buffer.clear();
                if line.is_empty() {
                    continue;
                }
                {
                    let mut tail = tail.lock().unwrap();
                    if tail.len() == STDERR_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
                }
                emit(&events, STDERR, json!({ "instance": instance, "line": line }));
            }
        });
    }
    let child = Arc::new(tokio::sync::Mutex::new(child));
    {
        let child = child.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            while matches!(reader.read_until(b'\n', &mut buffer).await, Ok(n) if n > 0) {
                let line = String::from_utf8_lossy(&buffer).into_owned();
                buffer.clear();
                if let Some(payload) = relay_line(instance, &line) {
                    emit(&events, MESSAGE, payload);
                }
            }
            let code = {
                let mut child = child.lock().await;
                tokio::time::timeout(Duration::from_secs(5), child.wait()).await.ok().and_then(|status| status.ok()).and_then(|status| status.code())
            };
            tokio::time::sleep(Duration::from_millis(50)).await;
            let stderr: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
            emit(&events, EXIT, json!({ "instance": instance, "code": code, "stderr": stderr.join("\n") }));
        });
    }
    state.running.lock().unwrap().insert(instance, Running { lines, child });
    Ok(instance)
}

pub fn send(state: &AcpProcesses, instance: u64, line: String) -> Result<(), String> {
    let running = state.running.lock().unwrap();
    let process = running.get(&instance).ok_or("The agent isn't running")?;
    process.lines.send(line).map_err(|_| "The agent has exited".to_string())
}

/// Close its stdin (agents exit on EOF), then kill it if it lingers.
pub async fn stop(state: &AcpProcesses, instance: u64) {
    let removed = state.running.lock().unwrap().remove(&instance);
    if let Some(Running { lines, child }) = removed {
        drop(lines);
        let mut child = child.lock().await;
        if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}

pub async fn stop_all(state: &AcpProcesses) {
    let all: Vec<u64> = state.running.lock().unwrap().keys().copied().collect();
    for instance in all {
        stop(state, instance).await;
    }
}

/// Run an agent's program to completion (a status check), with a timeout.
pub async fn exec(spec: LaunchSpec, timeout: Duration) -> Result<Value, String> {
    let mut command = command_for(&spec);
    command.stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("{} took too long", spec.program))?
        .map_err(|error| format!("Couldn't run {}: {error}", spec.program))?;
    Ok(json!({
        "code": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    fn collector() -> (Events, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let events: Events = Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_string(), payload)));
        (events, seen)
    }

    async fn wait_for(seen: &Arc<Mutex<Vec<(String, Value)>>>, done: impl Fn(&[(String, Value)]) -> bool) {
        for _ in 0..500 {
            if done(&seen.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out: {:?}", seen.lock().unwrap());
    }

    #[test]
    fn relays_lines_as_they_are() {
        assert_eq!(relay_line(3, "{\"jsonrpc\":\"2.0\",\"id\":1}\n").unwrap(), json!({ "instance": 3, "line": "{\"jsonrpc\":\"2.0\",\"id\":1}" }));
        assert_eq!(relay_line(3, "not json\r\n").unwrap()["line"], "not json");
        assert!(relay_line(3, "  \n").is_none());
    }

    #[test]
    fn launch_specs() {
        let agent = InstalledAgent {
            id: "x".into(),
            name: "X".into(),
            version: "1".into(),
            kind: "binary".into(),
            program: "/agents/x/1/x".into(),
            node: false,
            args: vec!["acp".into()],
            env: BTreeMap::from([("A".into(), "1".into())]),
            dir: "/agents/x/1".into(),
            installed_at: 0,
            archive_sha256: None,
        };
        let spec = launch_spec(&agent, &SpawnRequest { agent_id: "x".into(), cwd: Some("/w".into()), env: BTreeMap::from([("B".into(), "2".into())]), ..Default::default() }).unwrap();
        assert_eq!(spec.program, "/agents/x/1/x");
        assert_eq!(spec.args, vec!["acp"]);
        assert_eq!(spec.env["A"], "1");
        assert_eq!(spec.env["B"], "2");
        assert!(spec.env.contains_key("PATH"));
        // Sign-in replaces the ACP arguments.
        let login = launch_spec(&agent, &SpawnRequest { agent_id: "x".into(), args: Some(vec!["login".into()]), ..Default::default() }).unwrap();
        assert_eq!(login.args, vec!["login"]);
        assert_eq!(login.cwd.as_deref(), Some("/agents/x/1"));
    }

    /// A stand-in agent (sh): JSON-RPC lines in, answers out, stderr and
    /// exit reported, stdin closed on stop.
    #[cfg(unix)]
    #[tokio::test]
    async fn relays_json_rpc_both_ways() {
        let (events, seen) = collector();
        let state = AcpProcesses::default();
        let script = r#"echo starting >&2; while IFS= read -r line; do printf '{"jsonrpc":"2.0","id":1,"result":{"echo":%s}}\n' "$line"; done; echo bye >&2"#;
        let spec = LaunchSpec { program: "sh".into(), args: vec!["-c".into(), script.into()], cwd: None, env: BTreeMap::new(), unset: vec![] };
        let instance = spawn(events, &state, spec).await.unwrap();
        send(&state, instance, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#.into()).unwrap();
        wait_for(&seen, |seen| seen.iter().any(|(name, _)| name == MESSAGE)).await;
        let message = seen.lock().unwrap().iter().find(|(name, _)| name == MESSAGE).cloned().unwrap().1;
        assert_eq!(message["instance"], instance);
        let parsed: Value = serde_json::from_str(message["line"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["result"]["echo"]["method"], "initialize");
        // A line with an embedded newline still goes as one line.
        send(&state, instance, "{\"a\":\n1}".into()).unwrap();
        wait_for(&seen, |seen| seen.iter().filter(|(name, _)| name == MESSAGE).count() == 2).await;

        stop(&state, instance).await;
        wait_for(&seen, |seen| seen.iter().any(|(name, _)| name == EXIT)).await;
        let seen = seen.lock().unwrap();
        let exit = seen.iter().find(|(name, _)| name == EXIT).unwrap();
        assert!(exit.1["stderr"].as_str().unwrap().contains("starting"));
        assert!(seen.iter().any(|(name, payload)| name == STDERR && payload["line"] == "starting"));
        assert!(send(&state, instance, "x".into()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_status_command() {
        let spec = LaunchSpec { program: "sh".into(), args: vec!["-c".into(), "echo '{\"loggedIn\":true}'; exit 0".into()], cwd: None, env: BTreeMap::new(), unset: vec![] };
        let result = exec(spec, Duration::from_secs(10)).await.unwrap();
        assert_eq!(result["code"], 0);
        assert!(result["stdout"].as_str().unwrap().contains("loggedIn"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unset_variables_are_removed() {
        std::env::set_var("SABLE_ACP_TEST_UNSET", "present");
        let spec = LaunchSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "printf '%s|%s' \"${SABLE_ACP_TEST_UNSET:-gone}\" \"$KEPT\"".into()],
            cwd: None,
            env: BTreeMap::from([("KEPT".into(), "yes".into())]),
            unset: vec!["SABLE_ACP_TEST_UNSET".into()],
        };
        let result = exec(spec, Duration::from_secs(10)).await.unwrap();
        assert_eq!(result["stdout"], "gone|yes");
    }
}
