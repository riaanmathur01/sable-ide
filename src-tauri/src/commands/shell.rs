//! Non-interactive command execution for the AI agent (`run_command`,
//! `git`, `github` tools). Unlike the integrated terminal this captures
//! output and returns it, with a hard timeout.
//!
//! Commands run through the user's *login* shell so the PATH matches
//! their terminal (GUI apps on macOS otherwise lack Homebrew, nvm, …),
//! with stdin closed and pagers/prompts disabled so nothing can block
//! waiting for input.

use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// Per-stream cap so a runaway command can't flood the agent context.
const OUTPUT_LIMIT: usize = 200_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

fn truncate(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= OUTPUT_LIMIT {
        return text.into_owned();
    }
    let mut end = OUTPUT_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [output truncated]", &text[..end])
}

fn shell_command(command: &str) -> Command {
    if cfg!(windows) {
        let mut shell = Command::new("powershell.exe");
        shell.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        shell
    } else {
        let shell_path =
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut shell = Command::new(shell_path);
        shell.args(["-l", "-c", command]);
        shell
    }
}

#[tauri::command]
pub async fn run_shell(
    command: String,
    cwd: String,
    timeout_secs: Option<u64>,
) -> Result<ShellOutput, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120).clamp(1, 1800));
    let mut process = shell_command(&command);
    process
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("PAGER", "cat")
        .env("GIT_PAGER", "cat")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .kill_on_drop(true);
    // Own process group, so a timeout can kill the whole tree (e.g. a
    // dev server the shell spawned), not just the shell.
    #[cfg(unix)]
    process.process_group(0);

    let child = process
        .spawn()
        .map_err(|error| format!("Could not start command: {error}"))?;
    let pid = child.id();

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(ShellOutput {
            stdout: truncate(&output.stdout),
            stderr: truncate(&output.stderr),
            exit_code: output.status.code(),
            timed_out: false,
        }),
        Ok(Err(error)) => Err(format!("Command failed: {error}")),
        Err(_) => {
            // The dropped future already killed the shell (kill_on_drop);
            // take its process group down with it.
            #[cfg(unix)]
            if let Some(pid) = pid {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &format!("-{pid}")])
                    .status();
            }
            #[cfg(not(unix))]
            let _ = pid;
            Ok(ShellOutput {
                stdout: String::new(),
                stderr: format!("Command timed out after {}s", timeout.as_secs()),
                exit_code: None,
                timed_out: true,
            })
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let output = run_shell("echo hi; echo err >&2; exit 3".into(), "/tmp".into(), Some(10))
            .await
            .unwrap();
        assert_eq!(output.stdout.trim(), "hi");
        assert_eq!(output.stderr.trim(), "err");
        assert_eq!(output.exit_code, Some(3));
        assert!(!output.timed_out);
    }

    #[tokio::test]
    async fn timeout_kills_the_whole_process_group() {
        let marker = std::env::temp_dir().join(format!("sable-shell-test-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        // A background child that would create the marker after 3s; the
        // timeout must kill it along with the shell.
        let command = format!("(sleep 3; touch {}) & sleep 30", marker.display());
        let started = std::time::Instant::now();
        let output = run_shell(command, "/tmp".into(), Some(1)).await.unwrap();
        assert!(output.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!marker.exists(), "background child survived the timeout");
    }

    #[tokio::test]
    async fn stdin_is_closed() {
        // `cat` with no stdin must exit immediately instead of hanging.
        let output = run_shell("cat".into(), "/tmp".into(), Some(5)).await.unwrap();
        assert!(!output.timed_out);
    }
}
