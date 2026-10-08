//! Integrated terminal backend. Each session is a real PTY (portable-pty)
//! running the user's shell. Output streams to the frontend as
//! `terminal:output` events from a dedicated reader thread; input and
//! resize come back in as commands. Sessions are keyed by id so multiple
//! terminals are possible later.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct TerminalState(pub Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    id: String,
    data: String,
}

/// The user's actual shell, not a hardcoded one.
fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[tauri::command]
pub fn create_terminal(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    if sessions.contains_key(&id) {
        return Ok(());
    }
    let mut shell_command = CommandBuilder::new(default_shell());
    shell_command.env("TERM", "xterm-256color");
    if let Some(directory) = cwd {
        shell_command.cwd(directory);
    }
    spawn_session(&app, &mut sessions, id, cols, rows, shell_command).map(|_| ())
}

/// A terminal running one program instead of a shell — e.g. a program
/// being debugged, so it can read keyboard input. Returns its process id.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // each is a separate argument from the frontend
pub fn create_command_terminal(
    app: AppHandle,
    state: State<TerminalState>,
    id: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, Option<String>>>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let (program, rest) = args.split_first().ok_or("Nothing to run")?;
    let mut command = CommandBuilder::new(program);
    command.args(rest);
    command.env("TERM", "xterm-256color");
    if let Some(directory) = cwd.filter(|directory| !directory.is_empty()) {
        command.cwd(directory);
    }
    // DAP: a null value removes the variable.
    for (name, value) in env.unwrap_or_default() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        }
    }
    let mut sessions = state.0.lock().unwrap();
    spawn_session(&app, &mut sessions, id, cols, rows, command)
}

/// Start `command` in a new PTY and stream its output. Returns the
/// process id (0 if the platform doesn't report one).
fn spawn_session(
    app: &AppHandle,
    sessions: &mut HashMap<String, PtySession>,
    id: String,
    cols: u16,
    rows: u16,
    command: CommandBuilder,
) -> Result<u32, String> {
    let pty_pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not open a terminal: {error}"))?;

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start: {error}"))?;
    let process_id = child.process_id().unwrap_or(0);
    // The slave end belongs to the child now; dropping our handle lets
    // the reader see EOF when the shell exits.
    drop(pty_pair.slave);

    let mut output_reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read from the terminal: {error}"))?;
    let input_writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write to the terminal: {error}"))?;

    // Reader thread: PTY bytes → frontend events. Reads can split
    // multi-byte UTF-8 sequences, so an incomplete tail is carried over
    // to the next chunk instead of being emitted as garbage.
    let app_handle = app.clone();
    let session_id = id.clone();
    std::thread::spawn(move || {
        let mut read_buffer = [0u8; 8192];
        let mut carry_over: Vec<u8> = Vec::new();
        loop {
            match output_reader.read(&mut read_buffer) {
                Ok(0) | Err(_) => {
                    let _ = app_handle.emit("terminal:exit", session_id.clone());
                    break;
                }
                Ok(byte_count) => {
                    carry_over.extend_from_slice(&read_buffer[..byte_count]);
                    let valid_length = match std::str::from_utf8(&carry_over) {
                        Ok(_) => carry_over.len(),
                        Err(error) => error.valid_up_to(),
                    };
                    if valid_length > 0 {
                        let text = String::from_utf8_lossy(&carry_over[..valid_length])
                            .into_owned();
                        carry_over.drain(..valid_length);
                        let _ = app_handle.emit(
                            "terminal:output",
                            TerminalOutput {
                                id: session_id.clone(),
                                data: text,
                            },
                        );
                    }
                }
            }
        }
    });

    sessions.insert(
        id,
        PtySession {
            master: pty_pair.master,
            writer: input_writer,
            child,
        },
    );
    Ok(process_id)
}

#[tauri::command]
pub fn write_terminal(
    state: State<TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("Could not write to the terminal: {error}"))
}

#[tauri::command]
pub fn resize_terminal(
    state: State<TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Could not resize the terminal: {error}"))
}

#[tauri::command]
pub fn kill_terminal(state: State<TerminalState>, id: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

