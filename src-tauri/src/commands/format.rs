//! Formatting through external tools, for languages whose language server
//! doesn't format (Python). Go, Rust, C/C++ and Java format through their
//! servers; TypeScript/JavaScript through Monaco's built-in service.
//!
//! Python uses Ruff (the fast, Black-compatible formatter), else Black:
//! the project's interpreter first (its venv may pin a version), then
//! PATH, then the copy Sable can install into its tools folder.

use crate::lsp::{resolve_binary, tools_dir};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Formatter {
    /// "ruff" or "black", for messages.
    name: String,
    program: String,
    /// Arguments; the file's path is appended (for config lookup and
    /// error messages — the text itself goes through stdin).
    args: Vec<String>,
}

/// Ruff inside Sable's tools folder (installed by `install_ruff`).
fn bundled_ruff() -> Option<PathBuf> {
    let binary = tools_dir()?.join("ruff").join(if cfg!(windows) { "ruff.exe" } else { "ruff" });
    binary.exists().then_some(binary)
}

/// A module the interpreter can run (`python -m ruff`).
async fn has_module(python: &str, module: &str) -> bool {
    Command::new(python)
        .args(["-c", &format!("import {module}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The Python formatter to use, if any is available.
#[tauri::command]
pub async fn python_formatter(python: Option<String>) -> Option<Formatter> {
    let ruff = |program: String| Formatter {
        name: "ruff".into(),
        program,
        args: vec!["format".into(), "--quiet".into(), "-".into(), "--stdin-filename".into()],
    };
    let black = |program: String, prefix: Vec<String>| Formatter {
        name: "black".into(),
        program,
        args: [prefix, vec!["--quiet".into(), "-".into(), "--stdin-filename".into()]].concat(),
    };
    if let Some(python) = python.as_deref().filter(|python| Path::new(python).exists()) {
        // A venv's own tools sit next to its interpreter.
        if let Some(bin) = Path::new(python).parent() {
            let candidate = bin.join(if cfg!(windows) { "ruff.exe" } else { "ruff" });
            if candidate.exists() {
                return Some(ruff(candidate.to_string_lossy().into_owned()));
            }
        }
        if has_module(python, "ruff").await {
            let mut formatter = ruff(python.to_string());
            formatter.args.splice(0..0, ["-m".to_string(), "ruff".to_string()]);
            return Some(formatter);
        }
        if has_module(python, "black").await {
            return Some(black(python.to_string(), vec!["-m".into(), "black".into()]));
        }
    }
    if let Some(program) = resolve_binary("ruff") {
        return Some(ruff(program.to_string_lossy().into_owned()));
    }
    if let Some(program) = bundled_ruff() {
        return Some(ruff(program.to_string_lossy().into_owned()));
    }
    if let Some(program) = resolve_binary("black") {
        return Some(black(program.to_string_lossy().into_owned(), vec![]));
    }
    None
}

/// Format `text` with a formatter: text in on stdin, formatted text out.
#[tauri::command]
pub async fn format_with(formatter: Formatter, path: String, text: String) -> Result<String, String> {
    let cwd = Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default();
    let mut child = Command::new(&formatter.program)
        .args(&formatter.args)
        .arg(&path)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not run {}: {error}", formatter.name))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin.write_all(text.as_bytes()).await.map_err(|error| error.to_string())?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .map_err(|_| format!("{} took too long", formatter.name))?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        // A syntax error just means "can't format yet" — keep it short.
        let first = message.lines().find(|line| !line.trim().is_empty()).unwrap_or("formatting failed");
        return Err(format!("{}: {first}", formatter.name));
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

/// Ruff's release asset for this platform.
fn ruff_asset() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("ruff-aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("ruff-x86_64-apple-darwin")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("ruff-x86_64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("ruff-aarch64-unknown-linux-gnu")
    } else {
        None
    }
}

/// Download Ruff (a single binary) into Sable's tools folder.
#[tauri::command]
pub async fn install_ruff() -> Result<(), String> {
    let asset = ruff_asset().ok_or("Install Ruff with `pip install ruff` on this platform")?;
    let url = format!("https://github.com/astral-sh/ruff/releases/latest/download/{asset}.tar.gz");
    let dir = tools_dir().ok_or("Tools folder unavailable")?.join("ruff");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create tools folder: {error}"))?;
    let bytes = reqwest::get(&url)
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Download failed: {error}"))?
        .bytes()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    let archive = dir.join("ruff.tar.gz");
    std::fs::write(&archive, &bytes).map_err(|error| format!("Could not save Ruff: {error}"))?;
    // The archive holds <asset>/ruff; flatten it into tools/ruff/ruff.
    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(&archive)
        .args(["-C"])
        .arg(&dir)
        .args(["--strip-components", "1"])
        .status()
        .await
        .map_err(|error| format!("Could not unpack Ruff: {error}"))?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() || bundled_ruff().is_none() {
        return Err("Could not unpack Ruff".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn formats_python_with_ruff() {
        // Sable's real tools folder (where the app installs Ruff).
        if let Some(home) = std::env::var_os("HOME") {
            crate::lsp::set_tools_dir(
                PathBuf::from(home).join("Library/Application Support/com.riaanmathur.sable/tools"),
            );
        }
        if std::env::var("SABLE_TEST_INSTALL_RUFF").is_ok() && bundled_ruff().is_none() {
            install_ruff().await.unwrap();
        }
        // Uses whichever formatter is available; skips if none.
        let Some(formatter) = python_formatter(None).await else {
            eprintln!("skipping: no Python formatter");
            return;
        };
        let formatted = format_with(formatter, "/tmp/sample.py".into(), "x=  [1,2 ,3]\ndef f( a ):\n  return a\n".into())
            .await
            .unwrap();
        assert_eq!(formatted, "x = [1, 2, 3]\n\n\ndef f(a):\n    return a\n");
    }
}
