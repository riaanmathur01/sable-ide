//! ACP's client-side terminals (`terminal/create`, `terminal/output`,
//! `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`): a
//! command the agent asks the editor to run, its output kept (up to the
//! agent's byte limit, oldest bytes dropped first) and streamed to the
//! panel as `acp:terminal` events `{terminalId, data}` / `{terminalId, exit}`.

use crate::events::{emit, Events};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

pub const EVENT: &str = "acp:terminal";
/// When the agent gives no limit.
const DEFAULT_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVariable {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminal {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvVariable>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub output_byte_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub output: String,
    pub truncated: bool,
    pub exit_status: Option<ExitStatus>,
}

#[derive(Default)]
struct Buffer {
    text: String,
    truncated: bool,
}

/// Append, keeping at most `limit` bytes: drop from the start, at a
/// character boundary.
fn append_limited(buffer: &mut Buffer, data: &str, limit: usize) {
    buffer.text.push_str(data);
    if buffer.text.len() > limit {
        let mut cut = buffer.text.len() - limit;
        while !buffer.text.is_char_boundary(cut) {
            cut += 1;
        }
        buffer.text.drain(..cut);
        buffer.truncated = true;
    }
}

struct Term {
    buffer: Mutex<Buffer>,
    exit: watch::Receiver<Option<ExitStatus>>,
    kill: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[derive(Default)]
pub struct AcpTerminals {
    terms: Mutex<HashMap<String, Arc<Term>>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn get(state: &AcpTerminals, id: &str) -> Result<Arc<Term>, String> {
    state.terms.lock().unwrap().get(id).cloned().ok_or_else(|| format!("No terminal {id}"))
}

/// Start the command; returns its terminal id.
pub fn create(events: Events, state: &AcpTerminals, request: CreateTerminal) -> Result<String, String> {
    let id = format!("sable-term-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let limit = request.output_byte_limit.unwrap_or(DEFAULT_LIMIT).max(1);
    // A whole command line with no arguments runs in the shell, as typed.
    let mut command = if request.args.is_empty() && request.command.contains(char::is_whitespace) {
        if cfg!(windows) {
            let mut shell = Command::new("cmd.exe");
            shell.args(["/C", &request.command]);
            shell
        } else {
            let mut shell = Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
            shell.args(["-c", &request.command]);
            shell
        }
    } else {
        let mut direct = Command::new(&request.command);
        direct.args(&request.args);
        direct
    };
    command.env("PATH", super::process::search_path(super::install::node().as_deref()));
    for variable in &request.env {
        command.env(&variable.name, &variable.value);
    }
    if let Some(cwd) = request.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|error| format!("Couldn't run {}: {error}", request.command))?;
    let (exit_sender, exit) = watch::channel(None);
    let (kill_sender, kill_receiver) = tokio::sync::oneshot::channel::<()>();
    let term = Arc::new(Term { buffer: Mutex::default(), exit, kill: Mutex::new(Some(kill_sender)) });
    state.terms.lock().unwrap().insert(id.clone(), term.clone());

    let pump = |mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>, term: Arc<Term>, events: Events, id: String| {
        tokio::spawn(async move {
            let mut chunk = vec![0u8; 16 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let read = match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                pending.extend_from_slice(&chunk[..read]);
                // Only whole UTF-8 characters.
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    Err(_) => pending.len(),
                };
                let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                append_limited(&mut term.buffer.lock().unwrap(), &text, limit);
                emit(&events, EVENT, json!({ "terminalId": id, "data": text }));
            }
        })
    };
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let out = pump(Box::new(stdout), term.clone(), events.clone(), id.clone());
    let err = pump(Box::new(stderr), term.clone(), events.clone(), id.clone());
    let terminal_id = id.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = kill_receiver => {
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
        let _ = out.await;
        let _ = err.await;
        let exit = ExitStatus {
            exit_code: status.and_then(|status| status.code()),
            signal: {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    status.and_then(|status| status.signal()).map(|signal| match signal {
                        9 => "SIGKILL".to_string(),
                        15 => "SIGTERM".to_string(),
                        2 => "SIGINT".to_string(),
                        other => format!("signal {other}"),
                    })
                }
                #[cfg(not(unix))]
                {
                    None
                }
            },
        };
        emit(&events, EVENT, json!({ "terminalId": terminal_id, "exit": exit }));
        let _ = exit_sender.send(Some(exit));
    });
    Ok(id)
}

pub fn output(state: &AcpTerminals, id: &str) -> Result<Output, String> {
    let term = get(state, id)?;
    let buffer = term.buffer.lock().unwrap();
    let exit_status = term.exit.borrow().clone();
    Ok(Output { output: buffer.text.clone(), truncated: buffer.truncated, exit_status })
}

pub async fn wait_for_exit(state: &AcpTerminals, id: &str) -> Result<ExitStatus, String> {
    let mut exit = get(state, id)?.exit.clone();
    loop {
        if let Some(status) = exit.borrow().clone() {
            return Ok(status);
        }
        if exit.changed().await.is_err() {
            return exit.borrow().clone().ok_or_else(|| "The terminal went away".to_string());
        }
    }
}

pub fn kill(state: &AcpTerminals, id: &str) -> Result<(), String> {
    if let Some(kill) = get(state, id)?.kill.lock().unwrap().take() {
        let _ = kill.send(());
    }
    Ok(())
}

/// Kill it (if running) and forget it.
pub fn release(state: &AcpTerminals, id: &str) -> Result<(), String> {
    let _ = kill(state, id);
    state.terms.lock().unwrap().remove(id);
    Ok(())
}

pub fn release_all(state: &AcpTerminals) {
    let ids: Vec<String> = state.terms.lock().unwrap().keys().cloned().collect();
    for id in ids {
        let _ = release(state, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> Events {
        Arc::new(|_, _| {})
    }

    #[test]
    fn output_is_limited_from_the_start() {
        let mut buffer = Buffer::default();
        append_limited(&mut buffer, "hello ", 8);
        assert!(!buffer.truncated);
        append_limited(&mut buffer, "world", 8);
        assert_eq!(buffer.text, "lo world");
        assert!(buffer.truncated);
        // Never splits a character.
        let mut buffer = Buffer::default();
        append_limited(&mut buffer, "aé", 2);
        assert_eq!(buffer.text, "é");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_command_and_reports_its_exit() {
        let state = AcpTerminals::default();
        let id = create(quiet(), &state, CreateTerminal { command: "sh".into(), args: vec!["-c".into(), "echo out; echo err >&2; exit 3".into()], env: vec![EnvVariable { name: "X".into(), value: "1".into() }], cwd: None, output_byte_limit: None }).unwrap();
        let exit = wait_for_exit(&state, &id).await.unwrap();
        assert_eq!(exit.exit_code, Some(3));
        let output = output(&state, &id).unwrap();
        assert!(output.output.contains("out") && output.output.contains("err"), "{output:?}");
        assert_eq!(output.exit_status, Some(exit));
        release(&state, &id).unwrap();
        assert!(super::output(&state, &id).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_line_runs_in_the_shell_and_can_be_killed() {
        let state = AcpTerminals::default();
        let id = create(quiet(), &state, CreateTerminal { command: "echo started && sleep 30".into(), args: vec![], env: vec![], cwd: Some("/".into()), output_byte_limit: Some(100) }).unwrap();
        for _ in 0..100 {
            if output(&state, &id).unwrap().output.contains("started") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        kill(&state, &id).unwrap();
        let exit = wait_for_exit(&state, &id).await.unwrap();
        assert!(exit.exit_code.is_none() || exit.exit_code != Some(0), "{exit:?}");
        assert!(output(&state, &id).unwrap().output.contains("started"));
    }
}
