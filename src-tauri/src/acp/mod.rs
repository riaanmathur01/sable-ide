//! Coding agents over the Agent Client Protocol (ACP,
//! https://agentclientprotocol.com) — Claude Agent, Codex, Kimi, Cursor and
//! the rest of the ACP registry — the way Zed and JetBrains embed them.
//!
//! The backend's part is the plumbing, agent-agnostic:
//!   registry.rs  the registry and how to install each agent here
//!   install.rs   installing (npm prefix / verified archive / uvx), updating
//!   process.rs   running agents, relaying their JSON-RPC lines
//!   terminal.rs  the terminals agents ask the editor to run
//!   env.rs       sign-in methods and providers → the agent's environment
//!   commands.rs  (app) Tauri commands, keychain secrets, settings, remote
//!
//! The protocol itself (sessions, prompts, tool calls, permissions, file
//! edits through the editor) is the frontend's: src/lib/acp.
//!
//! The workspace-side half (`dispatch`) also builds into the remote agent,
//! so in an SSH/WSL/container window agents are installed and run on the
//! remote machine, next to the code, with the same commands.

pub mod claude_code;
pub mod env;
pub mod install;
pub mod process;
pub mod registry;
pub mod terminal;
#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(test)]
mod real_tests;


use crate::events::{emit, Events};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const INSTALL_EVENT: &str = "acp:install";

/// One window's (or the remote agent's) agents and terminals.
#[derive(Default)]
pub struct AcpState {
    pub processes: process::AcpProcesses,
    pub terminals: terminal::AcpTerminals,
}

impl AcpState {
    pub async fn shutdown(&self) {
        process::stop_all(&self.processes).await;
        terminal::release_all(&self.terminals);
    }
}

/// Where agents are installed on a remote machine.
pub fn remote_root() -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join(".sable").join("agents")
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|error| format!("argument {key}: {error}"))
}

fn ok<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

/// Read an installed agent and turn a request into its command line:
/// its config files are written into its data folder
/// (`<root>/.data/<id>`), which stands in for `${SABLE_AGENT_DATA}`.
pub fn launch(root: &Path, request: &process::SpawnRequest) -> Result<process::LaunchSpec, String> {
    let agent = install::read(root, &request.agent_id).ok_or_else(|| format!("{} isn't installed", request.agent_id))?;
    let data = data_dir(root, &request.agent_id)?;
    write_files(&data, &request.files)?;
    let mut request = request.clone();
    let data_text = data.to_string_lossy();
    for value in request.env.values_mut() {
        if value.contains(env::AGENT_DATA) {
            *value = value.replace(env::AGENT_DATA, &data_text);
        }
    }
    process::launch_spec(&agent, &request)
}

/// An agent's own folder for data Sable keeps for it (not its install
/// folder, which updates replace).
pub fn data_dir(root: &Path, agent_id: &str) -> Result<PathBuf, String> {
    if !registry::valid_id(agent_id) {
        return Err(format!("Invalid agent id {agent_id:?}"));
    }
    Ok(root.join(".data").join(agent_id))
}

/// Write config files into `dir` (private to the user: they name where
/// credentials come from, though never contain them).
fn write_files(dir: &Path, files: &[env::AgentFile]) -> Result<(), String> {
    for file in files {
        let relative = Path::new(&file.path);
        if file.path.is_empty() || relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
            return Err(format!("Refusing to write {:?} outside the agent's folder", file.path));
        }
        let path = dir.join(relative);
        let parent = path.parent().unwrap_or(dir);
        std::fs::create_dir_all(parent).map_err(|error| format!("Couldn't create {}: {error}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        if std::fs::read_to_string(&path).ok().as_deref() == Some(file.contents.as_str()) {
            continue;
        }
        let temporary = path.with_extension("sable-tmp");
        std::fs::write(&temporary, &file.contents).map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&temporary, &path).map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    }
    Ok(())
}

/// The workspace-side commands (`acp_…`), with agents installed in `root`.
/// `None`: not one of them.
pub async fn dispatch(state: &AcpState, events: &Events, root: &Path, command: &str, args: &Value) -> Option<Result<Value, String>> {
    let run = async {
        Ok::<_, String>(match command {
            "acp_runtimes" => ok(Ok(install::runtimes().await)),
            "acp_installed" => ok(Ok(install::list(root))),
            "acp_install_entry" => {
                let entry: registry::AgentEntry = arg(args, "entry")?;
                let id = entry.id.clone();
                let progress_events = events.clone();
                let progress = move |message: &str, fraction: Option<f64>| {
                    emit(&progress_events, INSTALL_EVENT, json!({ "id": id, "message": message, "fraction": fraction }));
                };
                let platform = registry::platform();
                ok(install::install(root, &entry, platform.as_deref(), &progress).await)
            }
            "acp_uninstall" => ok(install::uninstall(root, &arg::<String>(args, "id")?)),
            "acp_find_local" => ok(Ok(install::find_local_cli(&arg::<String>(args, "id")?).map(|path| path.to_string_lossy().into_owned()))),
            "acp_link_local" => {
                let entry: registry::AgentEntry = arg(args, "entry")?;
                let program = install::find_local_cli(&entry.id).ok_or_else(|| format!("No {} CLI was found on this machine", entry.name))?;
                ok(install::link_local(root, &entry, &program))
            }
            "acp_launch_spec" => ok(launch(root, &arg(args, "request")?)),
            "acp_spawn" => {
                let spec = launch(root, &arg(args, "request")?)?;
                ok(process::spawn(events.clone(), &state.processes, spec).await)
            }
            "acp_send" => ok(process::send(&state.processes, arg(args, "instance")?, arg(args, "line")?)),
            "acp_stop" => {
                process::stop(&state.processes, arg(args, "instance")?).await;
                Ok(Value::Null)
            }
            "acp_exec" => {
                let spec = launch(root, &arg(args, "request")?)?;
                let timeout: Option<u64> = arg(args, "timeoutSecs")?;
                process::exec(spec, Duration::from_secs(timeout.unwrap_or(20).clamp(1, 600))).await
            }
            "acp_terminal_create" => ok(terminal::create(events.clone(), &state.terminals, arg(args, "request")?).map(|id| json!({ "terminalId": id }))),
            "acp_terminal_output" => ok(terminal::output(&state.terminals, &arg::<String>(args, "terminalId")?)),
            "acp_terminal_wait" => ok(terminal::wait_for_exit(&state.terminals, &arg::<String>(args, "terminalId")?).await),
            "acp_terminal_kill" => ok(terminal::kill(&state.terminals, &arg::<String>(args, "terminalId")?)),
            "acp_terminal_release" => ok(terminal::release(&state.terminals, &arg::<String>(args, "terminalId")?)),
            _ => return Err(String::from("\u{0}unknown")),
        })
    };
    match run.await {
        Ok(result) => Some(result),
        Err(error) if error == "\u{0}unknown" => None,
        Err(error) => Some(Err(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn dispatches_workspace_commands() {
        let state = AcpState::default();
        let events: Events = Arc::new(|_, _| {});
        let root = std::env::temp_dir().join(format!("sable-acp-dispatch-{}", std::process::id()));
        assert!(dispatch(&state, &events, &root, "not_ours", &json!({})).await.is_none());
        let installed = dispatch(&state, &events, &root, "acp_installed", &json!({})).await.unwrap().unwrap();
        assert!(installed.as_array().unwrap().iter().all(|agent| agent["id"] == "claude-code"), "{installed}");
        let error = dispatch(&state, &events, &root, "acp_spawn", &json!({ "request": { "agentId": "claude-acp" } })).await.unwrap().unwrap_err();
        assert!(error.contains("isn't installed"), "{error}");
        let error = dispatch(&state, &events, &root, "acp_send", &json!({ "instance": 999, "line": "{}" })).await.unwrap().unwrap_err();
        assert!(error.contains("isn't running"));
    }

    /// Config files land in the agent's data folder (never outside it), and
    /// `${SABLE_AGENT_DATA}` in its environment points there.
    #[test]
    fn launch_writes_config_files() {
        let root = std::env::temp_dir().join(format!("sable-acp-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("codex-acp").join("1.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = install::InstalledAgent {
            id: "codex-acp".into(),
            name: "Codex".into(),
            version: "1.0.0".into(),
            kind: "binary".into(),
            program: "/bin/sh".into(),
            node: false,
            args: vec![],
            env: Default::default(),
            dir: dir.to_string_lossy().into_owned(),
            installed_at: 0,
            archive_sha256: None,
        };
        std::fs::write(root.join("codex-acp").join(install::MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        let built = env::build("codex-acp", &env::AgentConfig { provider: Some("local".into()), values: [("local.model".to_string(), "gpt-oss:20b".to_string())].into(), env: Default::default() }, &|_| None).unwrap();
        let request = process::SpawnRequest { agent_id: "codex-acp".into(), env: built.env, files: built.files, ..Default::default() };
        let spec = launch(&root, &request).unwrap();
        let home = root.join(".data").join("codex-acp").join("codex-home");
        assert_eq!(spec.env["CODEX_HOME"], home.to_string_lossy());
        let written = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(written.contains("model_provider = \"ollama\""), "{written}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(home.join("config.toml")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(install::list(&root).iter().all(|agent| agent.id != ".data"), "the data folder isn't an agent");
        let escape = process::SpawnRequest { agent_id: "codex-acp".into(), files: vec![env::AgentFile { path: "../../evil".into(), contents: "x".into() }], ..Default::default() };
        assert!(launch(&root, &escape).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An installed (hand-made) agent through dispatch: spawn, relay, stop.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawns_an_installed_agent() {
        let root = std::env::temp_dir().join(format!("sable-acp-spawn-{}", std::process::id()));
        let dir = root.join("echo").join("1.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("agent.sh");
        std::fs::write(&program, "#!/bin/sh\nwhile IFS= read -r line; do echo \"$line\"; done\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let manifest = install::InstalledAgent {
            id: "echo".into(),
            name: "Echo".into(),
            version: "1.0.0".into(),
            kind: "binary".into(),
            program: program.to_string_lossy().into_owned(),
            node: false,
            args: vec![],
            env: Default::default(),
            dir: dir.to_string_lossy().into_owned(),
            installed_at: 0,
            archive_sha256: None,
        };
        std::fs::write(root.join("echo").join(install::MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = seen.clone();
        let events: Events = Arc::new(move |name, payload| {
            if name == process::MESSAGE {
                sink.lock().unwrap().push(payload);
            }
        });
        let state = AcpState::default();
        let instance = dispatch(&state, &events, &root, "acp_spawn", &json!({ "request": { "agentId": "echo", "cwd": root } })).await.unwrap().unwrap();
        dispatch(&state, &events, &root, "acp_send", &json!({ "instance": instance, "line": "{\"jsonrpc\":\"2.0\",\"method\":\"x\"}" })).await.unwrap().unwrap();
        for _ in 0..200 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(seen.lock().unwrap()[0]["line"], "{\"jsonrpc\":\"2.0\",\"method\":\"x\"}");
        state.shutdown().await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
