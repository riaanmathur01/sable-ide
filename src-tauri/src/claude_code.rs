//! Claude Code (Anthropic's CLI) IDE integration. Sable runs Anthropic's
//! official, unmodified `claude` CLI in its integrated terminal and acts
//! as the IDE the CLI connects to, the way Anthropic's VS Code and
//! JetBrains integrations do: the CLI opens its proposed edits in Sable's
//! diff view, sees the editor selection, reads diagnostics and open tabs.
//!
//! The protocol (what the current CLI expects — checked against
//! `claude` 2.1.x, Anthropic's docs and the VS Code extension's behavior):
//!
//! - Per window, a WebSocket server on 127.0.0.1 (a random port in
//!   10000–65535) that speaks MCP (JSON-RPC 2.0) with the `mcp`
//!   subprotocol.
//! - A lock file `<config>/ide/<port>.lock`, where `<config>` is
//!   `$CLAUDE_CONFIG_DIR` if set, else `~/.claude` (0600 in a 0700
//!   folder), with `pid`, `workspaceFolders`, `ideName`, `transport: "ws"`
//!   and a random `authToken`. The CLI finds it, and must present the token
//!   in the `X-Claude-Code-Ide-Authorization` header; anything else is
//!   refused.
//! - A CLI started from Sable gets `CLAUDE_CODE_SSE_PORT=<port>` and
//!   `ENABLE_IDE_INTEGRATION=true` so it connects at once; another one can
//!   connect with its `/ide` command.
//! - The CLI calls tools (`tools/call`): openFile, openDiff (blocks until
//!   the user accepts or rejects), getCurrentSelection, getDiagnostics, …
//!   Sable relays each call to its window as a `claude-code:request` event
//!   and the frontend answers with `claude_code_respond`. The frontend
//!   pushes `selection_changed` / `at_mentioned` notifications back through
//!   `claude_code_notify`.
//!
//! Sable never reads, stores or forwards Claude credentials: the CLI
//! signs in through its own `/login`; the token here only authenticates
//! the local socket between the CLI and this window.

use crate::events::{emit, Events};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};

/// How Sable names itself in the lock file (the CLI's `/ide` lists it).
pub const IDE_NAME: &str = "Sable";
const AUTH_HEADER: &str = "x-claude-code-ide-authorization";
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HANDSHAKE: usize = 16 * 1024;
/// A whole file's proposed contents arrive in one message.
const MAX_MESSAGE: usize = 256 * 1024 * 1024;
/// Tools other than openDiff answer at once; give up on a window that doesn't.
const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// Notifications the frontend may push to the CLI.
const NOTIFICATIONS: &[&str] = &["selection_changed", "at_mentioned"];
/// The MCP version answered when the client names none.
const DEFAULT_PROTOCOL: &str = "2025-03-26";

// --- Lock files --------------------------------------------------------------------------

/// Where the CLI looks for IDE lock files: `$CLAUDE_CONFIG_DIR/ide` if
/// that's set (as the CLI and Anthropic's extensions do), else
/// `~/.claude/ide`.
pub fn lock_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.to_string_lossy().trim().is_empty()) {
        return Some(PathBuf::from(dir).join("ide"));
    }
    home_dir().map(|home| home.join(".claude").join("ide"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// What a lock file holds (the CLI reads these fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub pid: u32,
    pub workspace_folders: Vec<String>,
    pub ide_name: String,
    pub transport: String,
    pub running_in_windows: bool,
    pub auth_token: String,
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // An existing folder: make it private too (only the lock folder).
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Write `<dir>/<port>.lock` atomically (a private temp file renamed into
/// place, so the CLI never reads half a file), readable by this user only.
pub fn write_lock(dir: &Path, port: u16, lock: &LockFile) -> std::io::Result<PathBuf> {
    create_private_dir(dir)?;
    let path = dir.join(format!("{port}.lock"));
    let temp = dir.join(format!(".{port}.lock.{}.tmp", std::process::id()));
    let body = serde_json::to_vec(lock).map_err(std::io::Error::other)?;
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&body)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written.map(|_| path)
}

/// Lock files this process wrote and hasn't removed yet (removed at exit).
static OUR_LOCKS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn remember_lock(path: &Path) {
    let mut locks = OUR_LOCKS.lock().unwrap();
    if !locks.iter().any(|lock| lock == path) {
        locks.push(path.to_path_buf());
    }
}

fn remove_lock(path: &Path) {
    let _ = std::fs::remove_file(path);
    OUR_LOCKS.lock().unwrap().retain(|lock| lock != path);
}

/// Remove every lock file this process wrote (the app is quitting).
pub fn remove_all_locks() {
    for path in std::mem::take(&mut *OUR_LOCKS.lock().unwrap()) {
        let _ = std::fs::remove_file(path);
    }
}

/// Whether a process is still running.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // Signal 0 checks without signalling; EPERM means it exists (another user's).
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
        // Can't tell: keep the file.
        .unwrap_or(true)
}

/// Remove lock files left by Sable processes that are gone (a crash, a
/// force quit). Other IDEs' lock files, and live Sables', are left alone.
/// Returns how many were removed.
pub fn remove_stale_locks(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let me = std::process::id();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        // Our temp files: ".<port>.lock.<pid>.tmp".
        if name.starts_with('.') && name.ends_with(".tmp") && name.contains(".lock.") {
            let pid = name.trim_end_matches(".tmp").rsplit('.').next().and_then(|pid| pid.parse::<u32>().ok());
            if pid.is_some_and(|pid| pid != me && !process_alive(pid)) && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            continue;
        }
        if !name.ends_with(".lock") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(lock) = serde_json::from_str::<Value>(&text) else { continue };
        if lock["ideName"].as_str() != Some(IDE_NAME) {
            continue;
        }
        let Some(pid) = lock["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()) else { continue };
        if pid != me && !process_alive(pid) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// --- Auth token ----------------------------------------------------------------------------

/// 128 random bits from the OS, as 32 hex digits.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("Couldn't make an auth token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Compare without leaking where they differ through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |difference, (x, y)| difference | (x ^ y)) == 0
}

fn random_port() -> u16 {
    let mut bytes = [0u8; 2];
    let _ = getrandom::fill(&mut bytes);
    10000 + (u16::from_le_bytes(bytes) % (65535 - 10000 + 1))
}

// --- WebSocket (RFC 6455, server side) -------------------------------------------------

/// SHA-1, for the handshake's Sec-WebSocket-Accept only.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut state: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut message = data.to_vec();
    let bit_length = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut words = [0u32; 80];
        for (index, word) in chunk.chunks(4).enumerate() {
            words[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..80 {
            words[index] = (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = state;
        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }
    let mut digest = [0u8; 20];
    for (index, value) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    digest
}

fn accept_key(key: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(sha1(format!("{key}{WEBSOCKET_GUID}").as_bytes()))
}

/// An HTTP upgrade request's method, path and (lowercased) headers.
#[derive(Debug, Default)]
struct UpgradeRequest {
    method: String,
    headers: HashMap<String, String>,
}

impl UpgradeRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

fn parse_request(head: &str) -> Option<UpgradeRequest> {
    let mut lines = head.split("\r\n");
    let method = lines.next()?.split(' ').next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Some(UpgradeRequest { method, headers })
}

/// Read the handshake's head; returns it and any bytes read past it.
async fn read_handshake<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(UpgradeRequest, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
            let rest = buffer[end + 4..].to_vec();
            return parse_request(&head).map(|request| (request, rest)).ok_or_else(|| "bad request".to_string());
        }
        if buffer.len() > MAX_HANDSHAKE {
            return Err("handshake too large".into());
        }
        let read = reader.read(&mut chunk).await.map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("closed during handshake".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

/// What to answer a handshake: Ok((Sec-WebSocket-Accept, speaks "mcp")) or
/// an HTTP status to refuse with.
fn check_handshake(request: &UpgradeRequest, token: &str) -> Result<(String, bool), (u16, &'static str)> {
    let has = |name: &str, value: &str| {
        request.header(name).is_some_and(|header| header.split(',').any(|part| part.trim().eq_ignore_ascii_case(value)))
    };
    if request.method != "GET" || !has("upgrade", "websocket") || !has("connection", "upgrade") {
        return Err((400, "Bad Request"));
    }
    let Some(key) = request.header("sec-websocket-key").filter(|key| !key.is_empty()) else {
        return Err((400, "Bad Request"));
    };
    if request.header("sec-websocket-version") != Some("13") {
        return Err((426, "Upgrade Required"));
    }
    match request.header(AUTH_HEADER) {
        Some(presented) if constant_time_eq(presented.as_bytes(), token.as_bytes()) => {}
        _ => return Err((401, "Unauthorized")),
    }
    Ok((accept_key(key), has("sec-websocket-protocol", "mcp")))
}

#[derive(Debug)]
struct Frame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

fn protocol_error(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_string())
}

/// Read one client frame (clients must mask theirs).
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R, max: usize) -> std::io::Result<Frame> {
    let mut head = [0u8; 2];
    reader.read_exact(&mut head).await?;
    let fin = head[0] & 0x80 != 0;
    if head[0] & 0x70 != 0 {
        return Err(protocol_error("reserved bits set"));
    }
    let opcode = head[0] & 0x0F;
    let masked = head[1] & 0x80 != 0;
    let mut length = u64::from(head[1] & 0x7F);
    if length == 126 {
        let mut bytes = [0u8; 2];
        reader.read_exact(&mut bytes).await?;
        length = u64::from(u16::from_be_bytes(bytes));
    } else if length == 127 {
        let mut bytes = [0u8; 8];
        reader.read_exact(&mut bytes).await?;
        length = u64::from_be_bytes(bytes);
    }
    if !masked {
        return Err(protocol_error("client frames must be masked"));
    }
    if opcode >= 0x8 && (length > 125 || !fin) {
        return Err(protocol_error("bad control frame"));
    }
    if length > max as u64 {
        return Err(protocol_error("message too large"));
    }
    let mut mask = [0u8; 4];
    reader.read_exact(&mut mask).await?;
    let mut payload = vec![0u8; length as usize];
    reader.read_exact(&mut payload).await?;
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Ok(Frame { fin, opcode, payload })
}

/// A server frame (unmasked, unfragmented).
fn encode_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | opcode);
    match payload.len() {
        length @ 0..=125 => frame.push(length as u8),
        length @ 126..=65535 => {
            frame.push(126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(payload);
    frame
}

enum Outgoing {
    Text(String),
    Pong(Vec<u8>),
    Close(Vec<u8>),
}

// --- The MCP server --------------------------------------------------------------------------

/// The tools Sable offers the CLI (the same set as Anthropic's VS Code
/// extension, minus executeCode). The CLI shows the model only
/// getDiagnostics; the rest drive its UI.
fn tool_list() -> Value {
    let schema = |properties: Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
            "$schema": "http://json-schema.org/draft-07/schema#",
        })
    };
    let file_path = json!({ "filePath": { "type": "string", "description": "Path to the file" } });
    json!([
        {
            "name": "openFile",
            "description": "Open a file in the editor and optionally select a range of text",
            "inputSchema": schema(json!({
                "filePath": { "type": "string", "description": "Path to the file to open" },
                "preview": { "type": "boolean", "description": "Whether to open the file in preview mode", "default": false },
                "startText": { "type": "string", "description": "Text pattern to find the start of the selection" },
                "endText": { "type": "string", "description": "Text pattern to find the end of the selection" },
                "selectToEndOfLine": { "type": "boolean", "description": "Extend the selection to the end of the line", "default": false },
                "makeFrontmost": { "type": "boolean", "description": "Make the file the active editor tab", "default": true },
            }), &["filePath"]),
        },
        {
            "name": "openDiff",
            "description": "Open a diff of a proposed change for the user to accept or reject (blocks until they do)",
            "inputSchema": schema(json!({
                "old_file_path": { "type": "string", "description": "Path to the file as it is" },
                "new_file_path": { "type": "string", "description": "Path to the changed file" },
                "new_file_contents": { "type": "string", "description": "The proposed contents" },
                "tab_name": { "type": "string", "description": "Name of the diff tab" },
            }), &["old_file_path", "new_file_path", "new_file_contents", "tab_name"]),
        },
        {
            "name": "getCurrentSelection",
            "description": "Get the current text selection in the active editor",
            "inputSchema": schema(json!({}), &[]),
        },
        {
            "name": "getLatestSelection",
            "description": "Get the most recent text selection (even if not in the active editor)",
            "inputSchema": schema(json!({}), &[]),
        },
        {
            "name": "getOpenEditors",
            "description": "Get the files open in the editor",
            "inputSchema": schema(json!({}), &[]),
        },
        {
            "name": "getWorkspaceFolders",
            "description": "Get the workspace's folders",
            "inputSchema": schema(json!({}), &[]),
        },
        {
            "name": "getDiagnostics",
            "description": "Get language diagnostics (errors, warnings) from Sable",
            "inputSchema": schema(json!({
                "uri": { "type": "string", "description": "File URI to get diagnostics for. If not provided, gets diagnostics for all files." },
            }), &[]),
        },
        {
            "name": "checkDocumentDirty",
            "description": "Check whether a document has unsaved changes",
            "inputSchema": schema(file_path.clone(), &["filePath"]),
        },
        {
            "name": "saveDocument",
            "description": "Save a document with unsaved changes",
            "inputSchema": schema(file_path, &["filePath"]),
        },
        {
            "name": "close_tab",
            "description": "Close a tab by name",
            "inputSchema": schema(json!({ "tab_name": { "type": "string", "description": "Name of the tab to close" } }), &["tab_name"]),
        },
        {
            "name": "closeAllDiffTabs",
            "description": "Close all diff tabs",
            "inputSchema": schema(json!({}), &[]),
        },
    ])
}

fn is_tool(name: &str) -> bool {
    matches!(
        name,
        "openFile"
            | "openDiff"
            | "getCurrentSelection"
            | "getLatestSelection"
            | "getOpenEditors"
            | "getWorkspaceFolders"
            | "getDiagnostics"
            | "checkDocumentDirty"
            | "saveDocument"
            | "close_tab"
            | "closeAllDiffTabs"
    )
}

/// The tool waits for the user (no timeout).
fn is_blocking(name: &str) -> bool {
    name == "openDiff"
}

/// A tool result that is an error, in MCP's shape.
pub fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

struct Client {
    outgoing: mpsc::UnboundedSender<Outgoing>,
    /// From the CLI's `ide_connected` notification.
    pid: Option<u32>,
}

/// A tool call waiting for the frontend's answer.
struct Pending {
    client: u64,
    rpc_id: Value,
    reply: oneshot::Sender<Value>,
}

struct Inner {
    port: u16,
    token: String,
    events: Events,
    lock_dir: PathBuf,
    lock_path: Mutex<Option<PathBuf>>,
    folders: Mutex<Vec<String>>,
    clients: Mutex<HashMap<u64, Client>>,
    pending: Mutex<HashMap<String, Pending>>,
    next_id: AtomicU64,
    shutdown: watch::Receiver<bool>,
}

/// The server's state, for the frontend (status bar, settings).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: Option<u16>,
    pub clients: usize,
    pub client_pids: Vec<u32>,
    pub lock_file: Option<String>,
    pub folders: Vec<String>,
}

impl Status {
    fn stopped() -> Self {
        Status { running: false, port: None, clients: 0, client_pids: Vec::new(), lock_file: None, folders: Vec::new() }
    }
}

/// One window's IDE server. Stopped (lock file removed) when dropped.
pub struct IdeServer {
    inner: Arc<Inner>,
    shutdown: watch::Sender<bool>,
}

impl IdeServer {
    /// Listen on 127.0.0.1 and write the lock file into `lock_dir`.
    pub async fn start(events: Events, folders: Vec<String>, lock_dir: PathBuf) -> Result<IdeServer, String> {
        remove_stale_locks(&lock_dir);
        let token = new_token()?;
        let listener = bind_listener().await?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let inner = Arc::new(Inner {
            port,
            token,
            events,
            lock_dir,
            lock_path: Mutex::new(None),
            folders: Mutex::new(folders),
            clients: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            shutdown: shutdown_receiver,
        });
        inner.write_lock().map_err(|error| format!("Couldn't write the Claude Code lock file: {error}"))?;
        tokio::spawn(accept_loop(inner.clone(), listener));
        Ok(IdeServer { inner, shutdown })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn port(&self) -> u16 {
        self.inner.port
    }

    pub fn lock_path(&self) -> Option<PathBuf> {
        self.inner.lock_path.lock().unwrap().clone()
    }

    /// The workspace's folders changed: rewrite the lock file.
    pub fn set_folders(&self, folders: Vec<String>) -> Result<(), String> {
        if *self.inner.folders.lock().unwrap() == folders {
            return Ok(());
        }
        *self.inner.folders.lock().unwrap() = folders;
        self.inner.write_lock().map_err(|error| format!("Couldn't update the Claude Code lock file: {error}"))
    }

    pub fn status(&self) -> Status {
        let clients = self.inner.clients.lock().unwrap();
        Status {
            running: !*self.shutdown.borrow(),
            port: Some(self.inner.port),
            clients: clients.len(),
            client_pids: clients.values().filter_map(|client| client.pid).collect(),
            lock_file: self.lock_path().map(|path| path.to_string_lossy().into_owned()),
            folders: self.inner.folders.lock().unwrap().clone(),
        }
    }

    /// The frontend's answer to a relayed tool call. False if the call is
    /// no longer waiting (the CLI cancelled it or went away).
    pub fn respond(&self, id: &str, result: Value) -> bool {
        let pending = self.inner.pending.lock().unwrap().remove(id);
        match pending {
            Some(pending) => pending.reply.send(result).is_ok(),
            None => false,
        }
    }

    /// Push a notification (selection_changed, at_mentioned) to every
    /// connected CLI; returns how many got it.
    pub fn notify(&self, method: &str, params: Value) -> Result<usize, String> {
        if !NOTIFICATIONS.contains(&method) {
            return Err(format!("Not a notification Sable sends: {method}"));
        }
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let clients = self.inner.clients.lock().unwrap();
        Ok(clients.values().filter(|client| client.outgoing.send(Outgoing::Text(message.clone())).is_ok()).count())
    }

    /// Stop listening, disconnect the CLIs and remove the lock file.
    pub fn stop(&self) {
        if let Some(path) = self.inner.lock_path.lock().unwrap().take() {
            remove_lock(&path);
        }
        if *self.shutdown.borrow() {
            return;
        }
        let _ = self.shutdown.send(true);
        for (_, client) in self.inner.clients.lock().unwrap().drain() {
            let _ = client.outgoing.send(Outgoing::Close(1001u16.to_be_bytes().to_vec()));
        }
        let pending: Vec<String> = self.inner.pending.lock().unwrap().drain().map(|(id, _)| id).collect();
        for id in pending {
            emit(&self.inner.events, "claude-code:cancel", json!({ "id": id }));
        }
        emit(&self.inner.events, "claude-code:clients", json!({ "clients": 0, "pids": [] }));
    }
}

impl Drop for IdeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn bind_listener() -> Result<TcpListener, String> {
    // A random port in 10000–65535, as the CLI and Anthropic's extensions expect.
    for _ in 0..64 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", random_port())).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| format!("Couldn't start the Claude Code IDE server: {error}"))
}

impl Inner {
    fn write_lock(&self) -> std::io::Result<()> {
        let lock = LockFile {
            pid: std::process::id(),
            workspace_folders: self.folders.lock().unwrap().clone(),
            ide_name: IDE_NAME.to_string(),
            transport: "ws".to_string(),
            running_in_windows: cfg!(windows),
            auth_token: self.token.clone(),
        };
        let path = write_lock(&self.lock_dir, self.port, &lock)?;
        remember_lock(&path);
        *self.lock_path.lock().unwrap() = Some(path);
        Ok(())
    }

    fn send(&self, client: u64, message: Value) {
        if let Some(client) = self.clients.lock().unwrap().get(&client) {
            let _ = client.outgoing.send(Outgoing::Text(message.to_string()));
        }
    }

    fn clients_changed(&self) {
        let (count, pids) = {
            let clients = self.clients.lock().unwrap();
            (clients.len(), clients.values().filter_map(|client| client.pid).collect::<Vec<_>>())
        };
        emit(&self.events, "claude-code:clients", json!({ "clients": count, "pids": pids }));
    }

    /// Drop a client's waiting calls (it cancelled them or went away).
    fn cancel_pending(&self, matches: impl Fn(&Pending) -> bool) {
        let cancelled: Vec<String> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<String> = pending.iter().filter(|(_, call)| matches(call)).map(|(id, _)| id.clone()).collect();
            for id in &ids {
                pending.remove(id);
            }
            ids
        };
        for id in cancelled {
            emit(&self.events, "claude-code:cancel", json!({ "id": id }));
        }
    }
}

async fn accept_loop(inner: Arc<Inner>, listener: TcpListener) {
    let mut shutdown = inner.shutdown.clone();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, address)) = accepted else { continue };
                // 127.0.0.1 only (the bind already ensures it).
                if !address.ip().is_loopback() {
                    continue;
                }
                tokio::spawn(serve_connection(inner.clone(), stream));
            }
        }
    }
}

async fn write_http_error<W: AsyncWrite + Unpin>(writer: &mut W, status: u16, reason: &str) {
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = writer.write_all(response.as_bytes()).await;
    let _ = writer.shutdown().await;
}

async fn serve_connection(inner: Arc<Inner>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let (mut reader, mut writer) = stream.into_split();
    let Ok(Ok((request, rest))) = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_handshake(&mut reader)).await else {
        write_http_error(&mut writer, 400, "Bad Request").await;
        return;
    };
    let (accept, mcp) = match check_handshake(&request, &inner.token) {
        Ok(accepted) => accepted,
        Err((status, reason)) => {
            write_http_error(&mut writer, status, reason).await;
            return;
        }
    };
    let protocol = if mcp { "Sec-WebSocket-Protocol: mcp\r\n" } else { "" };
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{protocol}\r\n"
    );
    if writer.write_all(response.as_bytes()).await.is_err() {
        return;
    }

    let client = inner.next_id.fetch_add(1, Ordering::SeqCst);
    let (outgoing, mut queue) = mpsc::unbounded_channel::<Outgoing>();
    inner.clients.lock().unwrap().insert(client, Client { outgoing: outgoing.clone(), pid: None });
    inner.clients_changed();

    // Writer: queued messages, and a ping now and then (keeps the
    // connection's liveness checked on both ends).
    let writer_task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        ping.tick().await;
        loop {
            let frame = tokio::select! {
                message = queue.recv() => match message {
                    Some(Outgoing::Text(text)) => encode_frame(OP_TEXT, text.as_bytes()),
                    Some(Outgoing::Pong(payload)) => encode_frame(OP_PONG, &payload),
                    Some(Outgoing::Close(payload)) => {
                        let _ = writer.write_all(&encode_frame(OP_CLOSE, &payload)).await;
                        break;
                    }
                    None => break,
                },
                _ = ping.tick() => encode_frame(OP_PING, b""),
            };
            if writer.write_all(&frame).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    let mut input = BufReader::new(std::io::Cursor::new(rest).chain(reader));
    let mut shutdown = inner.shutdown.clone();
    let mut message: Vec<u8> = Vec::new();
    let mut fragmented = false;
    loop {
        let frame = tokio::select! {
            _ = shutdown.changed() => break,
            frame = read_frame(&mut input, MAX_MESSAGE) => match frame {
                Ok(frame) => frame,
                Err(_) => break,
            },
        };
        match frame.opcode {
            OP_TEXT | OP_BINARY | OP_CONTINUATION => {
                if (frame.opcode == OP_CONTINUATION) != fragmented {
                    break; // a continuation without a start, or a new message mid-message
                }
                message.extend_from_slice(&frame.payload);
                if message.len() > MAX_MESSAGE {
                    break;
                }
                fragmented = !frame.fin;
                if frame.fin {
                    let text = String::from_utf8_lossy(&std::mem::take(&mut message)).into_owned();
                    handle_text(&inner, client, &text);
                }
            }
            OP_PING => {
                let _ = outgoing.send(Outgoing::Pong(frame.payload));
            }
            OP_PONG => {}
            OP_CLOSE => {
                let _ = outgoing.send(Outgoing::Close(frame.payload.get(..2).map(<[u8]>::to_vec).unwrap_or_default()));
                break;
            }
            _ => break,
        }
    }

    let removed = inner.clients.lock().unwrap().remove(&client);
    drop(removed);
    drop(outgoing);
    inner.cancel_pending(|call| call.client == client);
    inner.clients_changed();
    let _ = tokio::time::timeout(Duration::from_secs(2), writer_task).await;
}

/// One or more JSON-RPC messages from a client.
fn handle_text(inner: &Arc<Inner>, client: u64, text: &str) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        inner.send(client, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
        return;
    };
    match value {
        Value::Array(messages) => messages.into_iter().for_each(|message| handle_message(inner, client, message)),
        message => handle_message(inner, client, message),
    }
}

fn handle_message(inner: &Arc<Inner>, client: u64, message: Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return; // a response to something we never ask
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = message.get("id").cloned().filter(|id| !id.is_null()) else {
        handle_notification(inner, client, method, &params);
        return;
    };
    let reply = |result: Value| inner.send(client, json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match method {
        "initialize" => {
            let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL);
            reply(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": true }, "logging": {} },
                "serverInfo": { "name": "sable", "version": env!("CARGO_PKG_VERSION") },
            }));
        }
        "ping" | "logging/setLevel" => reply(json!({})),
        "tools/list" => reply(json!({ "tools": tool_list() })),
        "prompts/list" => reply(json!({ "prompts": [] })),
        "resources/list" => reply(json!({ "resources": [] })),
        "resources/templates/list" => reply(json!({ "resourceTemplates": [] })),
        "tools/call" => relay_tool_call(inner, client, id, &params),
        _ => inner.send(
            client,
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } }),
        ),
    }
}

fn handle_notification(inner: &Arc<Inner>, client: u64, method: &str, params: &Value) {
    match method {
        "ide_connected" => {
            let pid = params.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok());
            if let Some(entry) = inner.clients.lock().unwrap().get_mut(&client) {
                entry.pid = pid;
            }
            inner.clients_changed();
        }
        "notifications/cancelled" => {
            if let Some(request) = params.get("requestId") {
                inner.cancel_pending(|call| call.client == client && &call.rpc_id == request);
            }
        }
        _ => {}
    }
}

/// Hand a tool call to the window; answer the CLI when it replies.
fn relay_tool_call(inner: &Arc<Inner>, client: u64, rpc_id: Value, params: &Value) {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    if !is_tool(&name) {
        inner.send(
            client,
            json!({ "jsonrpc": "2.0", "id": rpc_id, "error": { "code": -32602, "message": format!("Unknown tool: {name}") } }),
        );
        return;
    }
    let arguments = params.get("arguments").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let id = format!("{client}:{}", inner.next_id.fetch_add(1, Ordering::SeqCst));
    let (reply, answer) = oneshot::channel();
    inner.pending.lock().unwrap().insert(id.clone(), Pending { client, rpc_id: rpc_id.clone(), reply });
    emit(&inner.events, "claude-code:request", json!({ "id": id, "tool": name, "arguments": arguments }));
    let inner = inner.clone();
    tokio::spawn(async move {
        let answered = if is_blocking(&name) {
            answer.await.ok()
        } else {
            tokio::time::timeout(TOOL_TIMEOUT, answer).await.ok().and_then(Result::ok)
        };
        let result = match answered {
            Some(result) => result,
            None => {
                // Still waiting (timed out): give up on it. Otherwise it was
                // cancelled, and a cancelled request gets no answer.
                if inner.pending.lock().unwrap().remove(&id).is_none() {
                    return;
                }
                emit(&inner.events, "claude-code:cancel", json!({ "id": id }));
                tool_error("Sable didn't answer in time")
            }
        };
        inner.send(client, json!({ "jsonrpc": "2.0", "id": rpc_id, "result": result }));
    });
}

// --- Finding the CLI -------------------------------------------------------------------------

/// The installed `claude` CLI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub path: String,
    pub version: Option<String>,
    /// The user's login shell (unix), to start `claude` with their PATH.
    pub shell: Option<String>,
}

fn login_shell() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    std::env::var("SHELL").ok().filter(|shell| !shell.is_empty())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Where Anthropic's installers put `claude` (native installer, the old
/// local install, Homebrew, npm global bins), after PATH.
fn cli_candidates() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(names.iter().map(|name| dir.join(name)));
        }
    }
    if let Some(home) = home_dir() {
        for dir in [".local/bin", ".claude/local", ".npm-global/bin", ".volta/bin", ".bun/bin", "bin"] {
            candidates.extend(names.iter().map(|name| home.join(dir).join(name)));
        }
        // Node version managers' global bins.
        for versions in [".nvm/versions/node", ".local/share/fnm/node-versions"] {
            if let Ok(entries) = std::fs::read_dir(home.join(versions)) {
                for entry in entries.flatten() {
                    candidates.push(entry.path().join("bin/claude"));
                    candidates.push(entry.path().join("installation/bin/claude"));
                }
            }
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
        }
    } else {
        for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"] {
            candidates.push(Path::new(dir).join("claude"));
        }
    }
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

/// `claude --version`'s first line (it prints e.g. "2.1.179 (Claude Code)").
async fn cli_version(path: &Path) -> Option<String> {
    let mut command = tokio::process::Command::new(path);
    command.arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string)
}

/// Find the `claude` CLI: `override_path` (Settings) if given, else PATH
/// and Anthropic's standard install locations. Ok(None) if it isn't installed.
pub async fn find_cli(override_path: Option<String>) -> Result<Option<CliInfo>, String> {
    if let Some(path) = override_path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty()) {
        let expanded = match path.strip_prefix("~/") {
            Some(rest) => home_dir().map(|home| home.join(rest)).unwrap_or_else(|| PathBuf::from(&path)),
            None => PathBuf::from(&path),
        };
        if !is_executable(&expanded) {
            return Err(format!("No claude program at {path} (Settings → Claude Code)"));
        }
        let version = cli_version(&expanded).await;
        return Ok(Some(CliInfo { path: expanded.to_string_lossy().into_owned(), version, shell: login_shell() }));
    }
    for candidate in cli_candidates() {
        if is_executable(&candidate) {
            let version = cli_version(&candidate).await;
            return Ok(Some(CliInfo { path: candidate.to_string_lossy().into_owned(), version, shell: login_shell() }));
        }
    }
    Ok(None)
}

// --- One server per window ---------------------------------------------------------------------

/// A window's IDE server, started on first use.
#[derive(Default)]
pub struct ClaudeCodeState(tokio::sync::Mutex<Option<IdeServer>>);

/// Start the window's server (or update its folders) and return its state.
pub async fn start(events: Events, state: &ClaudeCodeState, folders: Vec<String>) -> Result<Status, String> {
    start_in(events, state, folders, lock_dir().ok_or("Couldn't find your home folder")?).await
}

pub async fn start_in(events: Events, state: &ClaudeCodeState, folders: Vec<String>, dir: PathBuf) -> Result<Status, String> {
    let mut server = state.0.lock().await;
    if let Some(running) = server.as_ref() {
        running.set_folders(folders)?;
        return Ok(running.status());
    }
    let started = IdeServer::start(events, folders, dir).await?;
    let status = started.status();
    *server = Some(started);
    Ok(status)
}

pub async fn stop(state: &ClaudeCodeState) {
    if let Some(server) = state.0.lock().await.take() {
        server.stop();
    }
}

pub async fn status(state: &ClaudeCodeState) -> Status {
    state.0.lock().await.as_ref().map_or_else(Status::stopped, IdeServer::status)
}

pub async fn set_folders(state: &ClaudeCodeState, folders: Vec<String>) -> Result<(), String> {
    match state.0.lock().await.as_ref() {
        Some(server) => server.set_folders(folders),
        None => Ok(()),
    }
}

pub async fn respond(state: &ClaudeCodeState, id: String, result: Value) -> Result<bool, String> {
    Ok(state.0.lock().await.as_ref().is_some_and(|server| server.respond(&id, result)))
}

pub async fn notify(state: &ClaudeCodeState, method: String, params: Value) -> Result<usize, String> {
    match state.0.lock().await.as_ref() {
        Some(server) => server.notify(&method, params),
        None => Ok(0),
    }
}

// --- Commands ------------------------------------------------------------------------------------

#[cfg(feature = "desktop")]
mod commands {
    use super::*;
    use crate::windows::PerWindow;
    use tauri::State;

    #[tauri::command]
    pub async fn claude_code_start(
        window: tauri::WebviewWindow,
        states: State<'_, PerWindow<ClaudeCodeState>>,
        folders: Vec<String>,
    ) -> Result<Status, String> {
        start(crate::events::for_window(&window), &states.get(window.label()), folders).await
    }

    #[tauri::command]
    pub async fn claude_code_stop(window: tauri::WebviewWindow, states: State<'_, PerWindow<ClaudeCodeState>>) -> Result<(), String> {
        stop(&states.get(window.label())).await;
        Ok(())
    }

    #[tauri::command]
    pub async fn claude_code_status(window: tauri::WebviewWindow, states: State<'_, PerWindow<ClaudeCodeState>>) -> Result<Status, String> {
        Ok(status(&states.get(window.label())).await)
    }

    #[tauri::command]
    pub async fn claude_code_set_folders(
        window: tauri::WebviewWindow,
        states: State<'_, PerWindow<ClaudeCodeState>>,
        folders: Vec<String>,
    ) -> Result<(), String> {
        set_folders(&states.get(window.label()), folders).await
    }

    #[tauri::command]
    pub async fn claude_code_respond(
        window: tauri::WebviewWindow,
        states: State<'_, PerWindow<ClaudeCodeState>>,
        id: String,
        result: Value,
    ) -> Result<bool, String> {
        respond(&states.get(window.label()), id, result).await
    }

    #[tauri::command]
    pub async fn claude_code_notify(
        window: tauri::WebviewWindow,
        states: State<'_, PerWindow<ClaudeCodeState>>,
        method: String,
        params: Value,
    ) -> Result<usize, String> {
        notify(&states.get(window.label()), method, params).await
    }

    #[tauri::command]
    pub async fn claude_code_find_cli(path: Option<String>) -> Result<Option<CliInfo>, String> {
        find_cli(path).await
    }
}

#[cfg(feature = "desktop")]
pub use commands::*;

/// The commands for the UI test bridge (ui_bridge.rs), on one window's state.
#[cfg(test)]
pub async fn bridge_dispatch(events: Events, state: &ClaudeCodeState, command: &str, args: &Value) -> Option<Result<Value, String>> {
    let arg = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
    let folders = || serde_json::from_value::<Vec<String>>(arg("folders")).map_err(|error| error.to_string());
    let text = |key: &str| arg(key).as_str().unwrap_or("").to_string();
    let json = |value: Result<Value, serde_json::Error>| value.map_err(|error| error.to_string());
    // Tests never touch the real ~/.claude/ide.
    if command == "claude_code_start" && std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
        return Some(Err("The UI bridge runs the Claude Code IDE server only with CLAUDE_CONFIG_DIR set (a temp folder)".into()));
    }
    Some(match command {
        "claude_code_start" => match folders() {
            Ok(folders) => start(events, state, folders).await.and_then(|status| json(serde_json::to_value(status))),
            Err(error) => Err(error),
        },
        "claude_code_stop" => {
            stop(state).await;
            Ok(Value::Null)
        }
        "claude_code_status" => json(serde_json::to_value(status(state).await)),
        "claude_code_set_folders" => match folders() {
            Ok(folders) => set_folders(state, folders).await.map(|_| Value::Null),
            Err(error) => Err(error),
        },
        "claude_code_respond" => respond(state, text("id"), arg("result")).await.map(Value::Bool),
        "claude_code_notify" => notify(state, text("method"), arg("params")).await.map(|count| json!(count)),
        "claude_code_find_cli" => {
            let path = arg("path").as_str().map(str::to_string);
            find_cli(path).await.and_then(|info| json(serde_json::to_value(info)))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sable-claude-{name}-{}-{}", std::process::id(), new_token().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Events collected for checking, and a way to wait for them.
    fn collecting_events() -> (Events, mpsc::UnboundedReceiver<(String, Value)>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let events: Events = Arc::new(move |name, payload| {
            let _ = sender.send((name.to_string(), payload));
        });
        (events, receiver)
    }

    async fn next_event(events: &mut mpsc::UnboundedReceiver<(String, Value)>, name: &str) -> Value {
        loop {
            let (event, payload) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("event in time").expect("events open");
            if event == name {
                return payload;
            }
        }
    }

    #[test]
    fn sha1_and_accept_key() {
        let hex = |digest: [u8; 20]| digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        assert_eq!(hex(sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(sha1(&[b'a'; 1000])), "291e9a6c66994949b57ba5e650361e98fc36b1ba");
        // RFC 6455's example.
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
        assert!(constant_time_eq(a.as_bytes(), a.as_bytes()));
        assert!(!constant_time_eq(a.as_bytes(), b.as_bytes()));
        assert!(!constant_time_eq(a.as_bytes(), &a.as_bytes()[..31]));
    }

    #[test]
    fn lock_file_contents_and_permissions() {
        let dir = temp_dir("lock").join("ide");
        let lock = LockFile {
            pid: 4242,
            workspace_folders: vec!["/work/a".into(), "/work/b".into()],
            ide_name: IDE_NAME.into(),
            transport: "ws".into(),
            running_in_windows: false,
            auth_token: "abc".into(),
        };
        let path = write_lock(&dir, 23456, &lock).unwrap();
        assert_eq!(path, dir.join("23456.lock"));
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written,
            json!({ "pid": 4242, "workspaceFolders": ["/work/a", "/work/b"], "ideName": "Sable", "transport": "ws", "runningInWindows": false, "authToken": "abc" })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        // No temp file left behind; rewriting replaces it.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        write_lock(&dir, 23456, &LockFile { workspace_folders: vec![], ..lock }).unwrap();
        let rewritten: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(rewritten["workspaceFolders"], json!([]));
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn stale_locks_only_ours_and_dead() {
        let dir = temp_dir("stale");
        // A pid that can't be running.
        let dead = 999_999_u32;
        assert!(!process_alive(dead));
        let me = std::process::id();
        let write = |name: &str, body: Value| std::fs::write(dir.join(name), body.to_string()).unwrap();
        write("1.lock", json!({ "pid": dead, "ideName": "Sable", "transport": "ws" }));
        write("2.lock", json!({ "pid": me, "ideName": "Sable", "transport": "ws" }));
        write("3.lock", json!({ "pid": dead, "ideName": "Visual Studio Code", "transport": "ws" }));
        write("4.lock", json!({ "pid": 1, "ideName": "Sable", "transport": "ws" }));
        std::fs::write(dir.join(format!(".5.lock.{dead}.tmp")), "{").unwrap();
        std::fs::write(dir.join("notes.txt"), "keep").unwrap();
        assert_eq!(remove_stale_locks(&dir), 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        // Ours alive (this process, pid 1), another IDE's, and unrelated files stay.
        assert_eq!(left, vec!["2.lock", "3.lock", "4.lock", "notes.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A minimal WebSocket client, as the CLI connects.
    struct TestClient {
        stream: TcpStream,
    }

    impl TestClient {
        async fn connect(port: u16, token: Option<&str>) -> Result<(TestClient, String), String> {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| error.to_string())?;
            let auth = token.map(|token| format!("X-Claude-Code-Ide-Authorization: {token}\r\n")).unwrap_or_default();
            let request = format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mcp\r\n{auth}\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).await.map_err(|error| error.to_string())? == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head).into_owned();
            Ok((TestClient { stream }, head))
        }

        async fn send(&mut self, message: Value) {
            let payload = message.to_string().into_bytes();
            let mask = [0x12u8, 0x34, 0x56, 0x78];
            let mut frame = vec![0x81];
            if payload.len() < 126 {
                frame.push(0x80 | payload.len() as u8);
            } else {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            }
            frame.extend_from_slice(&mask);
            frame.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));
            self.stream.write_all(&frame).await.unwrap();
        }

        /// The next text message (skipping pings).
        async fn receive(&mut self) -> Value {
            loop {
                let mut head = [0u8; 2];
                tokio::time::timeout(Duration::from_secs(5), self.stream.read_exact(&mut head)).await.expect("message in time").unwrap();
                assert_eq!(head[1] & 0x80, 0, "server frames aren't masked");
                let mut length = u64::from(head[1] & 0x7F);
                if length == 126 {
                    let mut bytes = [0u8; 2];
                    self.stream.read_exact(&mut bytes).await.unwrap();
                    length = u64::from(u16::from_be_bytes(bytes));
                } else if length == 127 {
                    let mut bytes = [0u8; 8];
                    self.stream.read_exact(&mut bytes).await.unwrap();
                    length = u64::from_be_bytes(bytes);
                }
                let mut payload = vec![0u8; length as usize];
                self.stream.read_exact(&mut payload).await.unwrap();
                if head[0] & 0x0F == OP_TEXT {
                    return serde_json::from_slice(&payload).unwrap();
                }
            }
        }
    }

    fn read_lock(server: &IdeServer) -> LockFile {
        serde_json::from_str(&std::fs::read_to_string(server.lock_path().unwrap()).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn refuses_connections_without_the_token() {
        let dir = temp_dir("auth");
        let (events, _received) = collecting_events();
        let server = IdeServer::start(events, vec!["/work".into()], dir.clone()).await.unwrap();
        let port = server.port();
        assert!((10000..=65535).contains(&port) || port > 0);
        let token = read_lock(&server).auth_token;
        assert_eq!(token.len(), 32);

        let (_, head) = TestClient::connect(port, None).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
        let (_, head) = TestClient::connect(port, Some("0123456789abcdef0123456789abcdef")).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
        let (_, head) = TestClient::connect(port, Some(&token[..31])).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
        // Plain HTTP isn't a WebSocket.
        let mut plain = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        plain.write_all(format!("GET / HTTP/1.1\r\n{AUTH_HEADER}: {token}\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = String::new();
        let _ = plain.read_to_string(&mut response).await;
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");

        let (_, head) = TestClient::connect(port, Some(&token)).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        assert!(head.contains(&format!("Sec-WebSocket-Accept: {}", accept_key("dGhlIHNhbXBsZSBub25jZQ=="))), "{head}");
        assert!(head.contains("Sec-WebSocket-Protocol: mcp"), "{head}");
        drop(server);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn relays_mcp_messages() {
        let dir = temp_dir("relay");
        let (events, mut received) = collecting_events();
        let state = ClaudeCodeState::default();
        let started = start_in(events, &state, vec!["/work".into()], dir.clone()).await.unwrap();
        let port = started.port.unwrap();
        let lock_path = PathBuf::from(started.lock_file.clone().unwrap());
        assert_eq!(lock_path, dir.join(format!("{port}.lock")));
        let lock: LockFile = serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
        assert_eq!(lock.pid, std::process::id());
        assert_eq!(lock.ide_name, "Sable");
        assert_eq!(lock.workspace_folders, vec!["/work".to_string()]);

        let (mut client, head) = TestClient::connect(port, Some(&lock.auth_token)).await.unwrap();
        assert!(head.starts_with("HTTP/1.1 101"));
        assert_eq!(next_event(&mut received, "claude-code:clients").await["clients"], 1);

        // initialize → the server's capabilities.
        client.send(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "claude-code", "version": "2" } } })).await;
        let initialized = client.receive().await;
        assert_eq!(initialized["id"], 0);
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(initialized["result"]["serverInfo"]["name"], "sable");
        assert!(initialized["result"]["capabilities"]["tools"].is_object());
        client.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        client.send(json!({ "jsonrpc": "2.0", "method": "ide_connected", "params": { "pid": 777 } })).await;
        assert_eq!(next_event(&mut received, "claude-code:clients").await["pids"], json!([777]));

        // tools/list.
        client.send(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
        let tools = client.receive().await;
        let names: Vec<&str> = tools["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
        for name in ["openFile", "openDiff", "getCurrentSelection", "getLatestSelection", "getOpenEditors", "getWorkspaceFolders", "getDiagnostics", "checkDocumentDirty", "saveDocument", "close_tab", "closeAllDiffTabs"] {
            assert!(names.contains(&name), "{name} in {names:?}");
        }

        // A tool call goes to the window; its answer comes back.
        client.send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "getWorkspaceFolders", "arguments": {} } })).await;
        let request = next_event(&mut received, "claude-code:request").await;
        assert_eq!(request["tool"], "getWorkspaceFolders");
        assert_eq!(request["arguments"], json!({}));
        let answer = json!({ "content": [{ "type": "text", "text": "{\"success\":true}" }] });
        assert!(respond(&state, request["id"].as_str().unwrap().to_string(), answer.clone()).await.unwrap());
        let response = client.receive().await;
        assert_eq!(response["id"], 2);
        assert_eq!(response["result"], answer);
        // Answering twice does nothing.
        assert!(!respond(&state, request["id"].as_str().unwrap().to_string(), answer).await.unwrap());

        // Unknown tools and methods are errors.
        client.send(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "rm_rf", "arguments": {} } })).await;
        assert_eq!(client.receive().await["error"]["code"], -32602);
        client.send(json!({ "jsonrpc": "2.0", "id": "x", "method": "nope" })).await;
        let error = client.receive().await;
        assert_eq!((error["id"].clone(), error["error"]["code"].clone()), (json!("x"), json!(-32601)));

        // Notifications reach the CLI.
        assert_eq!(notify(&state, "selection_changed".into(), json!({ "text": "hi" })).await.unwrap(), 1);
        let notification = client.receive().await;
        assert_eq!(notification["method"], "selection_changed");
        assert_eq!(notification["params"]["text"], "hi");
        assert!(notify(&state, "evil".into(), json!({})).await.is_err());

        // A cancelled call is withdrawn from the window and never answered.
        client.send(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "openDiff", "arguments": { "tab_name": "t" } } })).await;
        let diff = next_event(&mut received, "claude-code:request").await;
        client.send(json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 4 } })).await;
        assert_eq!(next_event(&mut received, "claude-code:cancel").await["id"], diff["id"]);
        assert!(!respond(&state, diff["id"].as_str().unwrap().to_string(), json!({})).await.unwrap());

        // A blocking call left waiting is cancelled when the CLI goes away.
        client.send(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "openDiff", "arguments": { "tab_name": "u" } } })).await;
        let waiting = next_event(&mut received, "claude-code:request").await;
        drop(client);
        assert_eq!(next_event(&mut received, "claude-code:cancel").await["id"], waiting["id"]);
        assert_eq!(next_event(&mut received, "claude-code:clients").await["clients"], 0);

        // Folders update the lock file; stopping removes it.
        set_folders(&state, vec!["/work".into(), "/other".into()]).await.unwrap();
        let lock: LockFile = serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
        assert_eq!(lock.workspace_folders, vec!["/work".to_string(), "/other".to_string()]);
        assert!(OUR_LOCKS.lock().unwrap().contains(&lock_path));
        stop(&state).await;
        assert!(!lock_path.exists());
        assert!(!OUR_LOCKS.lock().unwrap().contains(&lock_path));
        assert!(!status(&state).await.running);
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err() || {
            // The listener may take a moment to close.
            tokio::time::sleep(Duration::from_millis(200)).await;
            TcpStream::connect(("127.0.0.1", port)).await.is_err()
        });
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn fragmented_and_large_messages() {
        let dir = temp_dir("frames");
        let (events, mut received) = collecting_events();
        let server = IdeServer::start(events, vec![], dir.clone()).await.unwrap();
        let token = read_lock(&server).auth_token;
        let (mut client, _) = TestClient::connect(server.port(), Some(&token)).await.unwrap();
        // A big openDiff (64-bit length) in two fragments.
        let contents = "x".repeat(70_000);
        let message = json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "openDiff", "arguments": { "new_file_contents": contents } } }).to_string();
        let (first, second) = message.as_bytes().split_at(100);
        let mask = [1u8, 2, 3, 4];
        let frame = |opcode_byte: u8, payload: &[u8]| {
            let mut frame = vec![opcode_byte, 0x80 | 127];
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
            frame.extend_from_slice(&mask);
            frame.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ mask[index % 4]));
            frame
        };
        client.stream.write_all(&frame(0x01, first)).await.unwrap();
        // A ping in between is answered and doesn't break the message.
        client.stream.write_all(&[0x89, 0x80, 0, 0, 0, 0]).await.unwrap();
        client.stream.write_all(&frame(0x80, second)).await.unwrap();
        let request = next_event(&mut received, "claude-code:request").await;
        assert_eq!(request["arguments"]["new_file_contents"].as_str().unwrap().len(), 70_000);
        server.respond(request["id"].as_str().unwrap(), json!({ "content": [{ "type": "text", "text": "FILE_SAVED" }, { "type": "text", "text": contents }] }));
        let response = client.receive().await;
        assert_eq!(response["result"]["content"][1]["text"].as_str().unwrap().len(), 70_000);
        drop(server);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
