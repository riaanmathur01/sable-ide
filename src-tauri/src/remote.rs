//! Remote development: a workspace on an SSH host, in a WSL distro, or in
//! a running container.
//!
//! Sable runs its agent (src/agent.rs) there over the system's own `ssh`,
//! `wsl.exe` or `docker exec`, so `~/.ssh/config`, keys and agents work as
//! they do in a terminal. The first connection to a machine installs the
//! agent for this Sable version in `~/.sable-server/bin/<version>/`:
//! Sable downloads it from the GitHub release (the remote needs no
//! internet access) and copies it over the same connection.
//!
//! While connected, the frontend sends workspace commands through
//! `remote_call` and the agent's events come back as the same Tauri events
//! the local backend emits — terminals, search, language servers and the
//! file watcher work unchanged.

use crate::agent::{AgentInfo, PROTOCOL, READY};
use crate::events::{emit, Events};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const NEED_AGENT: &str = "SABLE-NEED-AGENT ";
const INSTALLED: &str = "SABLE-INSTALLED";
const RELEASES: &str = "https://github.com/riaanmathur01/sable-ide/releases/download";
/// From starting the connection to the agent's ready line.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);

/// Where the workspace is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// A host as you'd pass it to `ssh`: an alias from ~/.ssh/config,
    /// `host`, or `user@host` (with `-p` options in ~/.ssh/config).
    Ssh { host: String },
    /// A WSL distribution (Windows).
    Wsl { distro: String },
    /// A running container, by name or id.
    Container {
        name: String,
        #[serde(default)]
        engine: Option<String>,
        /// Run as this user (a dev container's remoteUser).
        #[serde(default)]
        user: Option<String>,
    },
}

impl Target {
    pub fn label(&self) -> String {
        match self {
            Target::Ssh { host } => format!("SSH: {host}"),
            Target::Wsl { distro } => format!("WSL: {distro}"),
            Target::Container { name, .. } => format!("Container: {name}"),
        }
    }

    fn name(&self) -> &str {
        match self {
            Target::Ssh { host } => host,
            Target::Wsl { distro } => distro,
            Target::Container { name, .. } => name,
        }
    }

    /// A command that runs `script` on the target: with `sh`, or (a
    /// Windows SSH host) with PowerShell.
    fn command(&self, script: &str, windows: bool) -> Command {
        let mut command = match self {
            Target::Ssh { host } => {
                let mut command = Command::new(ssh_program());
                // Passwords, passphrases and codes are asked for by Sable
                // (ssh runs it as its SSH_ASKPASS helper).
                if let Some((address, executable)) = askpass_env() {
                    command
                        .env("SSH_ASKPASS", executable)
                        .env("SSH_ASKPASS_REQUIRE", "force")
                        .env("SABLE_ASKPASS", address)
                        .env("DISPLAY", std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()));
                }
                // Share one login between the connection's steps (and
                // reconnects soon after), so a password is asked once.
                #[cfg(unix)]
                command.args(["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/sable-ssh-%C", "-o", "ControlPersist=300"]);
                command.args([
                    "-T",
                    "-o",
                    "ConnectTimeout=20",
                    "-o",
                    "ServerAliveInterval=15",
                    "-o",
                    "ServerAliveCountMax=4",
                    // Trust a host on first use (as answering "yes" would);
                    // a *changed* key is still refused.
                    "-o",
                    "StrictHostKeyChecking=accept-new",
                    host,
                    // The remote login shell may not be sh (fish, csh) — or
                    // be cmd/PowerShell on Windows, given an encoded script
                    // so nothing needs quoting.
                    &if windows {
                        format!("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}", encode_powershell(script))
                    } else {
                        format!("sh -c {}", shell_quote(script))
                    },
                ]);
                command
            }
            Target::Wsl { distro } => {
                let mut command = Command::new("wsl.exe");
                command.args(["-d", distro, "-e", "sh", "-c", script]);
                command
            }
            Target::Container { name, engine, user } => {
                let engine = engine.clone().unwrap_or_else(|| "docker".to_string());
                let program = crate::lsp::resolve_binary(&engine).map(|path| path.into_os_string()).unwrap_or(engine.into());
                let mut command = Command::new(program);
                command.args(["exec", "-i"]);
                if let Some(user) = user {
                    command.args(["-u", user]);
                }
                command.args([name.as_str(), "sh", "-c", script]);
                command
            }
        };
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }
}

/// `ssh`, or `SABLE_SSH` (used by the tests to stand in for a server).
fn ssh_program() -> String {
    std::env::var("SABLE_SSH").unwrap_or_else(|_| "ssh".to_string())
}

/// `text` as one single-quoted sh word.
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// A PowerShell script for -EncodedCommand (base64 of UTF-16LE).
fn encode_powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Windows SSH hosts seen this run (so the sh attempt is skipped).
static WINDOWS_HOSTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// What cmd or PowerShell says when asked to run `sh`.
fn looks_like_windows(error: &str) -> bool {
    error.contains("is not recognized") || error.contains("CommandNotFoundException")
}

/// The Windows launch: Start-Process keeps the agent on ssh's own
/// stdin/stdout (PowerShell would otherwise re-encode its output).
fn windows_launch_script() -> String {
    format!(
        r#"$d = Join-Path $env:USERPROFILE '.sable-server\bin\{VERSION}'
$a = Join-Path $d 'sable-agent.exe'
if (Test-Path $a) {{ $p = Start-Process -FilePath $a -ArgumentList '--stdio' -NoNewWindow -Wait -PassThru; exit $p.ExitCode }}
[Console]::Out.WriteLine("{NEED_AGENT}Windows $env:PROCESSOR_ARCHITECTURE gzip")"#
    )
}

fn windows_install_script() -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$d = Join-Path $env:USERPROFILE '.sable-server\bin\{VERSION}'
New-Item -ItemType Directory -Force -Path $d | Out-Null
$part = Join-Path $d 'sable-agent.part'
$out = [IO.File]::Create($part)
$gz = New-Object IO.Compression.GZipStream([Console]::OpenStandardInput(), [IO.Compression.CompressionMode]::Decompress)
$gz.CopyTo($out)
$out.Close()
Move-Item -Force $part (Join-Path $d 'sable-agent.exe')
[Console]::Out.WriteLine('{INSTALLED}')"#
    )
}

/// Start the agent if it's installed; otherwise say what's needed.
fn launch_script() -> String {
    format!(
        r#"D="${{HOME:-/tmp}}/.sable-server/bin/{VERSION}"
if [ -x "$D/sable-agent" ]; then exec "$D/sable-agent" --stdio; fi
if command -v gzip >/dev/null 2>&1; then Z=gzip; else Z=raw; fi
echo "{NEED_AGENT}$(uname -s) $(uname -m) $Z""#
    )
}

/// Install the agent from stdin (gzipped or not).
fn install_script(gzipped: bool) -> String {
    let unpack = if gzipped { "gzip -dc" } else { "cat" };
    format!(
        r#"D="${{HOME:-/tmp}}/.sable-server/bin/{VERSION}"
mkdir -p "$D" && {unpack} > "$D/sable-agent.part" && chmod +x "$D/sable-agent.part" && mv -f "$D/sable-agent.part" "$D/sable-agent" && echo {INSTALLED}"#
    )
}

/// `uname -s` / `uname -m` → the agent's platform name.
fn platform(os: &str, arch: &str) -> Result<String, String> {
    let os = match os {
        "Linux" => "linux",
        "Darwin" => "macos",
        "Windows" => "windows",
        other => return Err(format!("Sable's remote agent doesn't run on {other} yet (Linux, macOS and Windows do)")),
    };
    let arch = match arch {
        "x86_64" | "amd64" | "AMD64" => "x86_64",
        "aarch64" | "arm64" | "ARM64" => "aarch64",
        other => return Err(format!("Sable's remote agent doesn't run on {other} processors yet (x86_64 and ARM64 do)")),
    };
    Ok(format!("{os}-{arch}"))
}

/// This machine's platform name, in the same form.
fn local_platform() -> String {
    let os = if cfg!(target_os = "macos") { "macos" } else { std::env::consts::OS };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// The agent binary for `platform`, and whether it's gzipped. In order:
/// `SABLE_AGENT_DIR` (development), one built next to this app for its
/// own platform, the download cache, then the GitHub release.
async fn agent_binary(cache: &std::path::Path, platform: &str, progress: &(dyn Fn(&str) + Sync)) -> Result<(Vec<u8>, bool), String> {
    if let Some(dir) = std::env::var_os("SABLE_AGENT_DIR") {
        let dir = PathBuf::from(dir);
        for (name, gzipped) in [(format!("sable-agent-{platform}"), false), (format!("sable-agent-{platform}.gz"), true)] {
            if let Ok(bytes) = std::fs::read(dir.join(&name)) {
                return Ok((bytes, gzipped));
            }
        }
    }
    if platform == local_platform() {
        if let Some(beside) = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("sable-agent"))) {
            if let Ok(bytes) = std::fs::read(&beside) {
                return Ok((bytes, false));
            }
        }
    }
    let file = format!("sable-agent-{platform}.gz");
    let cache = cache.join(VERSION);
    if let Ok(bytes) = std::fs::read(cache.join(&file)) {
        return Ok((bytes, true));
    }
    progress(&format!("Downloading Sable's agent for {platform}…"));
    let url = format!("{RELEASES}/v{VERSION}/{file}");
    let response = reqwest::get(&url)
        .await
        .map_err(|error| format!("Couldn't download Sable's remote agent: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Sable {VERSION} has no remote agent for {platform} ({url} isn't there)"));
    }
    let bytes = response
        .error_for_status()
        .map_err(|error| format!("Couldn't download Sable's remote agent: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Couldn't download Sable's remote agent: {error}"))?
        .to_vec();
    let _ = std::fs::create_dir_all(&cache);
    let _ = std::fs::write(cache.join(&file), &bytes);
    Ok((bytes, true))
}

/// The last lines a process wrote to stderr.
type Tail = Arc<Mutex<VecDeque<String>>>;

fn keep_stderr(child: &mut Child, label: String) -> Tail {
    let tail: Tail = Arc::default();
    if let Some(stderr) = child.stderr.take() {
        let tail = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[{label}] {line}");
                let mut tail = tail.lock().unwrap();
                if tail.len() == 12 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });
    }
    tail
}

/// Why a connection failed, in words, from what ssh/wsl/docker said.
fn explain(target: &Target, tail: &Tail, fallback: &str) -> String {
    let lines: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
    let text = lines.join("\n");
    let last = lines.iter().rev().find(|line| !line.trim().is_empty()).map(|line| line.trim().to_string());
    match target {
        Target::Ssh { host } if text.contains("Permission denied") => format!(
            "{host} refused the login (wrong password, or cancelled). To skip passwords, set up a key with `ssh-copy-id {host}` in a terminal."
        ),
        Target::Ssh { host } if text.contains("Could not resolve hostname") => {
            format!("Couldn't find the host {host}. Check the name, or add it to ~/.ssh/config.")
        }
        Target::Ssh { host } if text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || text.contains("Host key verification failed") => format!(
            "{host}'s host key doesn't match the one in ~/.ssh/known_hosts. If the server was reinstalled, remove the old key with `ssh-keygen -R {host}`."
        ),
        Target::Container { name, .. } if text.contains("No such container") || text.contains("is not running") => {
            format!("The container {name} isn't running.")
        }
        _ => last.map(|line| format!("{fallback}: {line}")).unwrap_or_else(|| fallback.to_string()),
    }
}

/// Run `script` on the target and return the first stdout line that
/// starts with one of `markers` (or an explanation of what went wrong),
/// along with the still-running child.
async fn first_marker(
    target: &Target,
    script: &str,
    windows: bool,
    stdin_bytes: Option<Vec<u8>>,
    markers: &[&str],
) -> Result<(String, Child, BufReader<tokio::process::ChildStdout>, Tail), String> {
    let mut child = target
        .command(script, windows)
        .spawn()
        .map_err(|error| match target {
            Target::Ssh { .. } => format!("Couldn't run ssh: {error}. Is OpenSSH installed?"),
            Target::Wsl { .. } => format!("Couldn't run wsl.exe: {error}"),
            Target::Container { .. } => format!("Couldn't run the container engine: {error}"),
        })?;
    let tail = keep_stderr(&mut child, target.label());
    let mut stdin = child.stdin.take();
    if let Some(bytes) = stdin_bytes {
        let mut pipe = stdin.take().ok_or("No stdin")?;
        tokio::spawn(async move {
            let _ = pipe.write_all(&bytes).await;
            let _ = pipe.shutdown().await;
        });
    }
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut reader = BufReader::new(stdout);
    let found = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return None,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if markers.iter().any(|marker| trimmed.starts_with(marker)) {
                        return Some(trimmed.to_string());
                    }
                    // Anything else is a login banner: skip it.
                }
            }
        }
    })
    .await;
    // Put stdin back for the agent session.
    if let Some(stdin) = stdin {
        child.stdin = Some(stdin);
    }
    match found {
        Ok(Some(line)) => Ok((line, child, reader, tail)),
        Ok(None) => {
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            Err(explain(target, &tail, &format!("Couldn't connect to {}", target.name())))
        }
        Err(_) => Err(format!("{} didn't answer within {} seconds", target.label(), CONNECT_TIMEOUT.as_secs())),
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Connection {
    target: Target,
    info: AgentInfo,
    writer: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    child: tokio::sync::Mutex<Option<Child>>,
    session: u64,
}

/// Each window's connection, by window label (a window is local or on
/// one remote; several windows can be on different remotes).
static CONNECTIONS: Mutex<Option<HashMap<String, Arc<Connection>>>> = Mutex::new(None);
static SESSIONS: AtomicU64 = AtomicU64::new(1);

fn current(owner: &str) -> Option<Arc<Connection>> {
    CONNECTIONS.lock().unwrap().get_or_insert_with(HashMap::new).get(owner).cloned()
}

/// What the frontend learns about a connection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub target: Target,
    pub label: String,
    pub agent: AgentInfo,
}

fn status(events: &Events, state: &str, target: &Target, message: Option<String>) {
    emit(
        events,
        "remote:status",
        json!({ "state": state, "label": target.label(), "target": target, "message": message }),
    );
}

/// Connect to `target` (installing the agent if needed); this replaces
/// any previous connection.
#[tauri::command]
pub async fn remote_connect(window: tauri::WebviewWindow, target: Target) -> Result<RemoteInfo, String> {
    let cache = window.path().app_data_dir().map_err(|error| error.to_string())?.join("agents");
    connect(crate::events::for_window(&window), &cache, target, window.label()).await
}

/// `remote_connect` for the window `owner`, with events sent to `events`
/// and downloaded agents kept in `cache`.
pub async fn connect(events: Events, cache: &std::path::Path, target: Target, owner: &str) -> Result<RemoteInfo, String> {
    disconnect(owner).await;
    let owner = owner.to_string();
    *ASKPASS_EVENTS.lock().unwrap() = Some(events.clone());
    let progress = |message: &str| status(&events, "connecting", &target, Some(message.to_string()));
    progress(&format!("Connecting to {}…", target.name()));

    let markers = [READY, NEED_AGENT];
    let ssh_host = match &target {
        Target::Ssh { host } => Some(host.clone()),
        _ => None,
    };
    let mut windows = ssh_host.as_ref().is_some_and(|host| WINDOWS_HOSTS.lock().unwrap().contains(host));
    let launch = |windows: bool| if windows { windows_launch_script() } else { launch_script() };
    let first = match first_marker(&target, &launch(windows), windows, None, &markers).await {
        // cmd/PowerShell answered: a Windows host.
        Err(error) if !windows && ssh_host.is_some() && looks_like_windows(&error) => {
            windows = true;
            if let Some(host) = &ssh_host {
                WINDOWS_HOSTS.lock().unwrap().push(host.clone());
            }
            first_marker(&target, &launch(true), true, None, &markers).await
        }
        other => other,
    };
    let (mut line, mut child, mut reader, mut tail) = first?;
    if let Some(rest) = line.strip_prefix(NEED_AGENT) {
        let parts: Vec<&str> = rest.split_whitespace().collect();
        let (os, arch, has_gzip) = match parts.as_slice() {
            [os, arch, zip] => (*os, *arch, *zip == "gzip"),
            _ => return Err(format!("Unexpected answer from {}: {rest}", target.name())),
        };
        let platform = platform(os, arch)?;
        // It exits by itself (killing it could end a shared ssh login).
        if tokio::time::timeout(Duration::from_secs(10), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        let (mut bytes, mut gzipped) = agent_binary(cache, &platform, &progress).await?;
        if gzipped && !has_gzip {
            bytes = gunzip(&bytes)?;
            gzipped = false;
        }
        // Windows unpacks with .NET's GZipStream: always send it gzipped.
        if windows && !gzipped {
            bytes = gzip(&bytes)?;
            gzipped = true;
        }
        progress(&format!("Installing Sable's agent on {}…", target.name()));
        let installer_script = if windows { windows_install_script() } else { install_script(gzipped) };
        let (_, mut installer, _, _) = first_marker(&target, &installer_script, windows, Some(bytes), &[INSTALLED])
            .await
            .map_err(|error| format!("Couldn't install Sable's agent: {error}"))?;
        let _ = installer.wait().await;
        progress(&format!("Starting Sable on {}…", target.name()));
        (line, child, reader, tail) = first_marker(&target, &launch(windows), windows, None, &[READY]).await?;
    }

    let info: AgentInfo = serde_json::from_str(line.strip_prefix(READY).unwrap_or(""))
        .map_err(|error| format!("Unexpected answer from Sable's agent: {error}"))?;
    if info.protocol != PROTOCOL {
        return Err(format!(
            "The agent on {} speaks a different protocol (Sable {} vs {VERSION}). Delete ~/.sable-server there and reconnect.",
            target.name(),
            info.version
        ));
    }

    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let (writer, mut outgoing) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = outgoing.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    let pending: Pending = Arc::default();
    let session = SESSIONS.fetch_add(1, Ordering::SeqCst);
    let connection = Arc::new(Connection {
        target: target.clone(),
        info: info.clone(),
        writer,
        pending: pending.clone(),
        next_id: AtomicU64::new(1),
        child: tokio::sync::Mutex::new(Some(child)),
        session,
    });
    CONNECTIONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(owner.clone(), connection);

    // Replies resolve calls; events go to the window as if local.
    let reader_events = events.clone();
    let reader_target = target.clone();
    tokio::spawn(async move {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim_end()) else { continue };
            if let Some(event) = message.get("event").and_then(Value::as_str) {
                let payload = message.get("payload").cloned().unwrap_or(Value::Null);
                // Forwarded-port traffic stays here; everything else is the window's.
                if !tunnel_event(event, &payload) {
                    reader_events(event, payload);
                }
                continue;
            }
            let Some(id) = message.get("id").and_then(Value::as_u64) else { continue };
            let reply = match (message.get("ok"), message.get("err")) {
                (_, Some(error)) => Err(error.as_str().map(str::to_string).unwrap_or_else(|| error.to_string())),
                (Some(value), _) => Ok(value.clone()),
                _ => Ok(Value::Null),
            };
            if let Some(sender) = pending.lock().unwrap().remove(&id) {
                let _ = sender.send(reply);
            }
        }
        // The connection ended. Fail what's waiting, and say so unless
        // it was closed on purpose (a newer session replaced it).
        let reason = explain(&reader_target, &tail, "The connection was lost");
        for (_, sender) in pending.lock().unwrap().drain() {
            let _ = sender.send(Err(format!("Lost the connection to {}", reader_target.name())));
        }
        let mut connections = CONNECTIONS.lock().unwrap();
        let connections = connections.get_or_insert_with(HashMap::new);
        if connections.get(&owner).is_some_and(|current| current.session == session) {
            connections.remove(&owner);
            status(&reader_events, "disconnected", &reader_target, Some(reason));
        }
    });

    status(&events, "connected", &target, None);
    Ok(RemoteInfo { label: target.label(), target, agent: info })
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())
}

/// Unpack the agent here when the remote has no gzip.
fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut unpacked = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes), &mut unpacked)
        .map_err(|error| format!("Sable's remote agent download is damaged: {error}"))?;
    Ok(unpacked)
}

/// Close the window `owner`'s connection, if it has one.
pub async fn disconnect(owner: &str) {
    stop_all_forwards(owner);
    let connection = CONNECTIONS.lock().unwrap().get_or_insert_with(HashMap::new).remove(owner);
    if let Some(connection) = connection {
        // Closing stdin ends the agent (and its servers and terminals).
        if let Some(mut child) = connection.child.lock().await.take() {
            drop(child.stdin.take());
            if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
    }
}

/// Close the remote connection (the window goes back to local).
#[tauri::command]
pub async fn remote_disconnect(window: tauri::WebviewWindow) -> Result<(), String> {
    let target = current(window.label()).map(|connection| connection.target.clone());
    disconnect(window.label()).await;
    if let Some(target) = target {
        status(&crate::events::for_window(&window), "closed", &target, None);
    }
    Ok(())
}

/// The window's connection, if any.
#[tauri::command]
pub fn remote_info(window: tauri::WebviewWindow) -> Option<RemoteInfo> {
    current(window.label()).map(|connection| RemoteInfo {
        target: connection.target.clone(),
        label: connection.target.label(),
        agent: connection.info.clone(),
    })
}

/// Run a workspace command on the window's remote.
#[tauri::command]
pub async fn remote_call(window: tauri::WebviewWindow, cmd: String, args: Value) -> Result<Value, String> {
    call(window.label(), cmd, args).await
}

/// Run a command on the remote of the window `owner`.
pub async fn call(owner: &str, cmd: String, args: Value) -> Result<Value, String> {
    let connection = current(owner).ok_or("Not connected to a remote")?;
    let id = connection.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    connection.pending.lock().unwrap().insert(id, sender);
    if connection.writer.send(json!({ "id": id, "cmd": cmd, "args": args }).to_string()).is_err() {
        connection.pending.lock().unwrap().remove(&id);
        return Err(format!("Lost the connection to {}", connection.target.name()));
    }
    receiver
        .await
        .unwrap_or_else(|_| Err(format!("Lost the connection to {}", connection.target.name())))
}

// --- Passwords: Sable as ssh's SSH_ASKPASS helper ------------------------------------------
//
// ssh runs this app's own executable to ask for a password, passphrase or
// one-time code (SABLE_ASKPASS tells it where to ask). That process
// connects to a local socket here, with a per-launch token; the window
// shows the prompt; the answer goes back the same way.

struct Askpass {
    address: String,
    token: String,
}

static ASKPASS: std::sync::OnceLock<Option<Askpass>> = std::sync::OnceLock::new();
static ASKPASS_EVENTS: Mutex<Option<Events>> = Mutex::new(None);
static ASKPASS_PENDING: Mutex<Option<HashMap<u64, oneshot::Sender<Option<String>>>>> = Mutex::new(None);
static ASKPASS_IDS: AtomicU64 = AtomicU64::new(1);
/// How long a prompt waits for an answer.
const ASKPASS_TIMEOUT: Duration = Duration::from_secs(300);

/// A token no other local process can guess.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut token = String::new();
    for round in 0..4u64 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(round);
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0));
        hasher.write_u32(std::process::id());
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// Start the askpass listener (once); `(SABLE_ASKPASS value, executable)`.
fn askpass_env() -> Option<(String, std::path::PathBuf)> {
    let askpass = ASKPASS.get_or_init(|| {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        let address = format!("127.0.0.1:{} {}", listener.local_addr().ok()?.port(), random_token());
        let token = address.split(' ').nth(1)?.to_string();
        listener.set_nonblocking(true).ok()?;
        let listener = tokio::net::TcpListener::from_std(listener).ok()?;
        let expected = token.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(answer_askpass(stream, expected.clone()));
            }
        });
        Some(Askpass { address, token })
    });
    let askpass = askpass.as_ref()?;
    let _ = &askpass.token;
    Some((askpass.address.clone(), std::env::current_exe().ok()?))
}

async fn answer_askpass(stream: tokio::net::TcpStream, token: String) {
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    if BufReader::new(reader).read_line(&mut line).await.is_err() {
        return;
    }
    let Ok(request) = serde_json::from_str::<Value>(&line) else { return };
    if request.get("token").and_then(Value::as_str) != Some(token.as_str()) {
        return;
    }
    let prompt = request.get("prompt").and_then(Value::as_str).unwrap_or("Password:").to_string();
    let id = ASKPASS_IDS.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    ASKPASS_PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, sender);
    let events = ASKPASS_EVENTS.lock().unwrap().clone();
    let answer = match events {
        Some(events) => {
            emit(&events, "remote:askpass", json!({ "id": id, "prompt": prompt.trim() }));
            tokio::time::timeout(ASKPASS_TIMEOUT, receiver).await.ok().and_then(Result::ok).flatten()
        }
        None => None,
    };
    ASKPASS_PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
    let reply = match answer {
        Some(answer) => json!({ "answer": answer }),
        None => json!({ "cancel": true }),
    };
    let _ = writer.write_all(format!("{reply}\n").as_bytes()).await;
}

/// The window's answer to an askpass prompt (None: cancelled).
#[tauri::command]
pub fn remote_askpass_answer(id: u64, answer: Option<String>) {
    if let Some(sender) = ASKPASS_PENDING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id) {
        let _ = sender.send(answer);
    }
}

/// The helper side (this executable, run by ssh): ask the app, print the
/// answer for ssh, and exit 0 — or 1 if it was cancelled.
pub fn askpass_client(address: &str, prompt: &str) -> i32 {
    use std::io::{BufRead, Write};
    let Some((socket, token)) = address.split_once(' ') else { return 1 };
    let Ok(mut stream) = std::net::TcpStream::connect(socket) else { return 1 };
    let request = json!({ "token": token, "prompt": prompt });
    if writeln!(stream, "{request}").is_err() {
        return 1;
    }
    let mut line = String::new();
    if std::io::BufReader::new(&stream).read_line(&mut line).is_err() {
        return 1;
    }
    let reply: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    match reply.get("answer").and_then(Value::as_str) {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    }
}

// --- Forwarded ports --------------------------------------------------------------------
//
// A port on the remote, reachable at localhost:<local port> here: Sable
// listens locally and relays each connection through the agent (which
// connects to the port on its side). It works the same for SSH, WSL and
// containers, with no extra ssh connections.

struct Forward {
    local_port: u16,
    listener: tokio::task::JoinHandle<()>,
}

/// Forwarded ports, by window and remote port.
static FORWARDS: Mutex<Option<HashMap<(String, u16), Forward>>> = Mutex::new(None);
/// Open tunnels: id → where the remote's bytes go (None: it closed).
static TUNNELS: Mutex<Option<HashMap<u64, mpsc::UnboundedSender<Option<Vec<u8>>>>>> = Mutex::new(None);
static TUNNEL_IDS: AtomicU64 = AtomicU64::new(1);

/// A `tunnel:*` event from the agent; true if it was one.
fn tunnel_event(event: &str, payload: &Value) -> bool {
    use base64::Engine;
    let Some(kind) = event.strip_prefix("tunnel:") else { return false };
    let Some(id) = payload.get("id").and_then(Value::as_u64) else { return true };
    let mut tunnels = TUNNELS.lock().unwrap();
    let tunnels = tunnels.get_or_insert_with(HashMap::new);
    match kind {
        "data" => {
            let bytes = payload
                .get("data")
                .and_then(Value::as_str)
                .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
                .unwrap_or_default();
            if let Some(sender) = tunnels.get(&id) {
                let _ = sender.send(Some(bytes));
            }
        }
        _ => {
            if let Some(sender) = tunnels.remove(&id) {
                let _ = sender.send(None);
            }
        }
    }
    true
}

/// Send to the agent without waiting for (or wanting) a reply.
fn send_unanswered(owner: &str, cmd: &str, args: Value) {
    if let Some(connection) = current(owner) {
        let _ = connection.writer.send(json!({ "cmd": cmd, "args": args }).to_string());
    }
}

/// Relay one local connection to `remote_port` on the remote.
async fn relay(owner: String, stream: tokio::net::TcpStream, remote_port: u16) {
    use base64::Engine;
    use tokio::io::AsyncReadExt;
    let id = TUNNEL_IDS.fetch_add(1, Ordering::SeqCst);
    let (sender, mut incoming) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
    TUNNELS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, sender);
    if call(&owner, "tunnel_open".into(), json!({ "id": id, "port": remote_port })).await.is_err() {
        TUNNELS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
        return;
    }
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    // Remote → here.
    let to_local = tokio::spawn(async move {
        while let Some(Some(bytes)) = incoming.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });
    // Here → remote.
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => send_unanswered(
                &owner,
                "tunnel_write",
                json!({ "id": id, "data": base64::engine::general_purpose::STANDARD.encode(&buffer[..count]) }),
            ),
        }
    }
    let _ = call(&owner, "tunnel_close".into(), json!({ "id": id })).await;
    let _ = to_local.await;
    TUNNELS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id);
}

/// Stop the window `owner`'s forwards (their open tunnels end with the
/// agent).
fn stop_all_forwards(owner: &str) {
    let mut forwards = FORWARDS.lock().unwrap();
    let forwards = forwards.get_or_insert_with(HashMap::new);
    let ports: Vec<(String, u16)> = forwards.keys().filter(|(window, _)| window == owner).cloned().collect();
    for key in ports {
        if let Some(forward) = forwards.remove(&key) {
            forward.listener.abort();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedPort {
    pub remote_port: u16,
    pub local_port: u16,
}

/// Forward `remote_port` to localhost (the same port number if it's free
/// here, else `local_port` or any free one). Returns the local port.
#[tauri::command]
pub async fn remote_forward_port(window: tauri::WebviewWindow, remote_port: u16, local_port: Option<u16>) -> Result<u16, String> {
    forward_port(window.label(), remote_port, local_port).await
}

pub async fn forward_port(owner: &str, remote_port: u16, local_port: Option<u16>) -> Result<u16, String> {
    let owner = owner.to_string();
    current(&owner).ok_or("Not connected to a remote")?;
    if let Some(forward) = FORWARDS.lock().unwrap().get_or_insert_with(HashMap::new).get(&(owner.clone(), remote_port)) {
        return Ok(forward.local_port);
    }
    let mut listener = None;
    for candidate in [local_port.unwrap_or(remote_port), 0] {
        if let Ok(bound) = tokio::net::TcpListener::bind(("127.0.0.1", candidate)).await {
            listener = Some(bound);
            break;
        }
    }
    let listener = listener.ok_or_else(|| format!("Couldn't listen on a local port for {remote_port}"))?;
    let local = listener.local_addr().map_err(|error| error.to_string())?.port();
    let relay_owner = owner.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            tokio::spawn(relay(relay_owner.clone(), stream, remote_port));
        }
    });
    FORWARDS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert((owner, remote_port), Forward { local_port: local, listener: task });
    Ok(local)
}

/// Stop forwarding `remote_port`.
#[tauri::command]
pub fn remote_stop_forward(window: tauri::WebviewWindow, remote_port: u16) {
    if let Some(forward) = FORWARDS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&(window.label().to_string(), remote_port)) {
        forward.listener.abort();
    }
}

/// The ports being forwarded.
#[tauri::command]
pub fn remote_forwards(window: tauri::WebviewWindow) -> Vec<ForwardedPort> {
    forwards(window.label())
}

pub fn forwards(owner: &str) -> Vec<ForwardedPort> {
    let mut list: Vec<ForwardedPort> = FORWARDS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .iter()
        .filter(|((window, _), _)| window == owner)
        .map(|((_, remote_port), forward)| ForwardedPort { remote_port: *remote_port, local_port: forward.local_port })
        .collect();
    list.sort_by_key(|forward| forward.remote_port);
    list
}

// --- What there is to connect to ----------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub name: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: String,
    pub engine: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Targets {
    pub ssh: Vec<SshHost>,
    pub wsl: Vec<String>,
    pub containers: Vec<ContainerInfo>,
}

/// The hosts named in an ssh config (wildcard patterns aren't hosts).
pub fn parse_ssh_config(text: &str, base: &std::path::Path, depth: usize) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((key, value)) => (key.to_ascii_lowercase(), value.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for name in value.split_whitespace() {
                    if name.contains(['*', '?', '!']) {
                        continue;
                    }
                    if let Some(index) = hosts.iter().position(|host| host.name == name) {
                        current.push(index);
                    } else {
                        hosts.push(SshHost { name: name.to_string(), hostname: None, user: None });
                        current.push(hosts.len() - 1);
                    }
                }
            }
            "match" => current.clear(),
            "hostname" => {
                for &index in &current {
                    hosts[index].hostname.get_or_insert_with(|| value.to_string());
                }
            }
            "user" => {
                for &index in &current {
                    hosts[index].user.get_or_insert_with(|| value.to_string());
                }
            }
            "include" if depth < 4 => {
                for pattern in value.split_whitespace() {
                    for file in expand_include(pattern, base) {
                        if let Ok(text) = std::fs::read_to_string(&file) {
                            for host in parse_ssh_config(&text, base, depth + 1) {
                                if !hosts.iter().any(|known| known.name == host.name) {
                                    hosts.push(host);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    hosts
}

/// An `Include` pattern's files: relative to ~/.ssh, `~` expanded, and a
/// `*` in the file name matched.
fn expand_include(pattern: &str, base: &std::path::Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pattern.strip_prefix("~/") {
        base.parent().map(|home| home.join(rest)).unwrap_or_else(|| PathBuf::from(pattern))
    } else if std::path::Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        base.join(pattern)
    };
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains('*') {
        return vec![path];
    }
    let (prefix, suffix) = name.split_once('*').unwrap_or((&name, ""));
    let Some(dir) = path.parent() else { return Vec::new() };
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|file| {
                    let file_name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                    file_name.starts_with(prefix) && file_name.ends_with(suffix) && file.is_file()
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn ssh_hosts() -> Vec<SshHost> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else { return Vec::new() };
    let dir = PathBuf::from(home).join(".ssh");
    std::fs::read_to_string(dir.join("config"))
        .map(|text| parse_ssh_config(&text, &dir, 0))
        .unwrap_or_default()
}

/// Output of a short-lived command, if it ran in time.
async fn output_of(mut command: Command) -> Option<Vec<u8>> {
    command.stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
    output.status.success().then_some(output.stdout)
}

async fn wsl_distros() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut command = Command::new("wsl.exe");
    command.args(["-l", "-q"]);
    let Some(bytes) = output_of(command).await else { return Vec::new() };
    // wsl.exe writes UTF-16LE.
    let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0').to_string())
        .filter(|name| !name.is_empty() && !name.starts_with("docker-desktop"))
        .collect()
}

async fn containers() -> Vec<ContainerInfo> {
    let mut found = Vec::new();
    for engine in ["docker", "podman"] {
        let Some(program) = crate::lsp::resolve_binary(engine) else { continue };
        let mut command = Command::new(program);
        command.args(["ps", "--format", "{{.Names}}\t{{.Image}}"]);
        let Some(bytes) = output_of(command).await else { continue };
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Some((name, image)) = line.split_once('\t') {
                found.push(ContainerInfo { name: name.to_string(), image: image.to_string(), engine: engine.to_string() });
            }
        }
    }
    found
}

/// SSH hosts from ~/.ssh/config, WSL distros, running containers.
#[tauri::command]
pub async fn remote_targets() -> Targets {
    let (wsl, containers) = tokio::join!(wsl_distros(), containers());
    Targets { ssh: ssh_hosts(), wsl, containers }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_hosts() {
        let base = std::env::temp_dir().join(format!("sable-ssh-{}", std::process::id()));
        std::fs::create_dir_all(base.join("config.d")).unwrap();
        std::fs::write(base.join("config.d/work"), "Host build-box\n  HostName 10.0.0.9\n  User ci\n").unwrap();
        let config = "# comment\nHost *\n  ServerAliveInterval 30\nHost dev dev2 !bad\n  HostName dev.example.com\n  User me\nHost=pi\n  HostName=192.168.1.4\nMatch host foo\n  User nobody\nInclude config.d/*\n";
        let hosts = parse_ssh_config(config, &base, 0);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(
            hosts,
            vec![
                SshHost { name: "dev".into(), hostname: Some("dev.example.com".into()), user: Some("me".into()) },
                SshHost { name: "dev2".into(), hostname: Some("dev.example.com".into()), user: Some("me".into()) },
                SshHost { name: "pi".into(), hostname: Some("192.168.1.4".into()), user: None },
                SshHost { name: "build-box".into(), hostname: Some("10.0.0.9".into()), user: Some("ci".into()) },
            ]
        );
    }

    /// The agent binary next to the test binary's folder (built if needed).
    #[cfg(unix)]
    fn agent_path() -> PathBuf {
        let target_dir = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().to_path_buf();
        let agent = target_dir.join("sable-agent");
        let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "-p", "sable-agent"])
            .status()
            .unwrap();
        assert!(status.success() && agent.exists(), "couldn't build sable-agent");
        agent
    }

    #[cfg(unix)]
    async fn wait_for(events: &Arc<Mutex<Vec<(String, Value)>>>, what: impl Fn(&str, &Value) -> bool) -> bool {
        for _ in 0..100 {
            if events.lock().unwrap().iter().any(|(name, payload)| what(name, payload)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    /// Install, connect, call, stream and reconnect — through a fake
    /// `ssh` that runs the remote command locally with its own HOME.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn connects_installs_and_relays() {
        use std::io::Write;
        let base = std::env::temp_dir().join(format!("sable-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let agents = base.join("agents");
        let project = base.join("project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("notes.txt"), "remote needle here\n").unwrap();

        // A login banner first, as some servers print.
        let fake_ssh = base.join("ssh");
        std::fs::write(
            &fake_ssh,
            format!("#!/bin/sh\nfor last; do :; done\necho 'Welcome to the test box'\nexport HOME='{}'\nexec sh -c \"$last\"\n", home.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake_ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&std::fs::read(agent_path()).unwrap()).unwrap();
        std::fs::write(agents.join(format!("sable-agent-{}.gz", local_platform())), gz.finish().unwrap()).unwrap();
        std::env::set_var("SABLE_SSH", &fake_ssh);
        std::env::set_var("SABLE_AGENT_DIR", &agents);

        let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let sink = seen.clone();
        let events: Events = Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_string(), payload)));
        let target = Target::Ssh { host: "test-box".into() };

        let info = connect(events.clone(), &base.join("cache"), target.clone(), "test").await.unwrap();
        assert_eq!(info.label, "SSH: test-box");
        assert_eq!(info.agent.home, home.to_string_lossy());
        assert!(home.join(format!(".sable-server/bin/{VERSION}/sable-agent")).exists());
        let messages = |seen: &Arc<Mutex<Vec<(String, Value)>>>| -> Vec<String> {
            seen.lock().unwrap().iter().filter(|(name, _)| name == "remote:status").map(|(_, p)| p["message"].as_str().unwrap_or(p["state"].as_str().unwrap_or("")).to_string()).collect()
        };
        assert!(messages(&seen).iter().any(|message| message.starts_with("Installing Sable's agent")), "{:?}", messages(&seen));

        // Calls.
        let file = project.join("hello.rs").to_string_lossy().into_owned();
        call("test", "write_file".into(), json!({ "path": file, "contents": "fn main() {}" })).await.unwrap();
        assert_eq!(call("test", "read_file".into(), json!({ "path": file })).await.unwrap(), json!("fn main() {}"));
        let listing = call("test", "read_directory".into(), json!({ "path": project })).await.unwrap();
        assert_eq!(listing.as_array().unwrap().len(), 2);
        assert!(call("test", "read_file".into(), json!({ "path": "/no/such/file" })).await.is_err());
        let unknown = call("test", "plugin_list".into(), json!({})).await.unwrap_err();
        assert!(unknown.contains("doesn't support"), "{unknown}");

        // Streams: a terminal, and a search.
        call("test", "create_terminal".into(), json!({ "id": "t1", "cols": 80, "rows": 24, "cwd": project })).await.unwrap();
        call("test", "write_terminal".into(), json!({ "id": "t1", "data": "echo from-the-remote-$((6*7))\n" })).await.unwrap();
        assert!(
            wait_for(&seen, |name, payload| name == "terminal:output" && payload["data"].as_str().unwrap_or("").contains("from-the-remote-42")).await,
            "no terminal output"
        );
        call("test", "kill_terminal".into(), json!({ "id": "t1" })).await.unwrap();
        call("test", "search_workspace".into(), json!({ "root": project, "query": "needle", "searchId": 5, "options": null })).await.unwrap();
        assert!(wait_for(&seen, |name, payload| name == "search:done" && payload["searchId"] == 5 && payload["total"] == 1).await);

        // Debugging runs there too (here: no session yet).
        assert!(call("test", "java_debug_installed".into(), json!({})).await.unwrap().is_boolean());
        let no_session = call("test", "debug_request".into(), json!({ "seq": 1, "command": "threads", "arguments": {} })).await.unwrap_err();
        assert!(no_session.contains("No debug session"), "{no_session}");

        // Forwarding a port: an echo server stands in for a dev server.
        let echo = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = echo.accept().await {
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buffer = [0u8; 4096];
                    while let Ok(count) = stream.read(&mut buffer).await {
                        if count == 0 || stream.write_all(&buffer[..count]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        call("test", "ports_watch".into(), json!({})).await.unwrap();
        assert!(
            wait_for(&seen, |name, payload| name == "ports:changed"
                && payload.as_array().is_some_and(|ports| ports.iter().any(|port| port["port"] == echo_port)))
            .await,
            "the agent didn't report the listening port"
        );
        let local = forward_port("test", echo_port, None).await.unwrap();
        assert_ne!(local, echo_port, "the remote's port is taken here (same machine), so another is used");
        {
            use tokio::io::AsyncReadExt;
            let mut client = tokio::net::TcpStream::connect(("127.0.0.1", local)).await.unwrap();
            let big: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
            client.write_all(b"hello through the tunnel").await.unwrap();
            let mut reply = vec![0u8; 24];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(&reply, b"hello through the tunnel");
            // A large write arrives whole and in order.
            client.write_all(&big).await.unwrap();
            let mut echoed = vec![0u8; big.len()];
            client.read_exact(&mut echoed).await.unwrap();
            assert!(echoed == big, "large transfer corrupted");
        }
        assert_eq!(forwards("test").len(), 1);
        FORWARDS.lock().unwrap().get_or_insert_with(HashMap::new).remove(&("test".to_string(), echo_port)).map(|forward| forward.listener.abort());
        assert!(forwards("test").is_empty());
        assert!(!seen.lock().unwrap().iter().any(|(name, _)| name.starts_with("tunnel:")), "tunnel traffic leaked to the window");

        // Reconnecting uses the installed agent.
        seen.lock().unwrap().clear();
        connect(events.clone(), &base.join("cache"), target.clone(), "test").await.unwrap();
        assert!(!messages(&seen).iter().any(|message| message.starts_with("Installing")), "{:?}", messages(&seen));
        assert!(current("test").is_some());
        disconnect("test").await;
        assert!(current("test").is_none());
        assert!(call("test", "read_file".into(), json!({ "path": file })).await.is_err());

        // A host that refuses the login says why.
        std::fs::write(&fake_ssh, "#!/bin/sh\necho 'me@test-box: Permission denied (publickey,password).' >&2\nexit 255\n").unwrap();
        let refused = connect(events, &base.join("cache"), target, "test").await.unwrap_err();
        assert!(refused.contains("ssh-copy-id"), "{refused}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Sable as ssh's askpass helper: the window's answer reaches the
    /// helper process, a cancel or a wrong token gets nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn askpass_round_trip() {
        let (address, _) = askpass_env().expect("askpass listener");
        let prompts: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = prompts.clone();
        let events: Events = Arc::new(move |name, payload| {
            if name != "remote:askpass" {
                return;
            }
            let prompt = payload["prompt"].as_str().unwrap_or("").to_string();
            seen.lock().unwrap().push(prompt.clone());
            let id = payload["id"].as_u64().unwrap();
            // Answer passwords, cancel anything else.
            remote_askpass_answer(id, prompt.contains("password").then(|| "hunter2".to_string()));
        });
        *ASKPASS_EVENTS.lock().unwrap() = Some(events);
        let ask = |address: String, prompt: &'static str| tokio::task::spawn_blocking(move || askpass_client(&address, prompt));
        assert_eq!(ask(address.clone(), "me@box's password: ").await.unwrap(), 0);
        assert_eq!(ask(address.clone(), "Verification code: ").await.unwrap(), 1);
        let forged = format!("{} wrong-token", address.split(' ').next().unwrap());
        assert_eq!(ask(forged, "me@box's password: ").await.unwrap(), 1);
        assert_eq!(*prompts.lock().unwrap(), vec!["me@box's password:".to_string(), "Verification code:".to_string()]);
    }

    #[test]
    fn platforms_and_quoting() {
        assert_eq!(platform("Linux", "x86_64").unwrap(), "linux-x86_64");
        assert_eq!(platform("Linux", "arm64").unwrap(), "linux-aarch64");
        assert_eq!(platform("Darwin", "arm64").unwrap(), "macos-aarch64");
        assert_eq!(platform("Windows", "AMD64").unwrap(), "windows-x86_64");
        assert!(looks_like_windows("Couldn't connect to box: 'sh' is not recognized as an internal or external command,"));
        assert!(looks_like_windows("sh : The term 'sh' is not recognized as the name of a cmdlet, function, script file"));
        assert!(!looks_like_windows("Couldn't connect to box: Connection refused"));
        // -EncodedCommand is base64 of UTF-16LE.
        assert_eq!(encode_powershell("dir"), "ZABpAHIA");
        let launch = windows_launch_script();
        assert!(launch.contains(&format!(r".sable-server\bin\{VERSION}")) && launch.contains("Start-Process") && launch.contains(NEED_AGENT));
        assert!(windows_install_script().contains("GZipStream") && windows_install_script().contains(INSTALLED));
        assert!(platform("FreeBSD", "amd64").is_err());
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }
}
