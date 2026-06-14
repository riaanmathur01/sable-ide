//! Interpreter discovery and environment creation.
//!
//! Currently Python-focused (the one language Sable runs that has many
//! interpreters), but the command shapes are generic enough that other
//! languages needing an interpreter can be added later.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    /// Absolute path to the interpreter binary — what Run executes.
    path: String,
    /// Human label, e.g. "Python 3.12.10" or "PyPy 7.3 · .venv".
    label: String,
    version: String,
    /// "pypy" | "cpython" | "venv" — used for the default-pick ordering.
    kind: String,
}

/// The python binary inside a virtualenv, per-OS.
fn venv_python(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    }
}

/// Run `<path> --version` and return the trimmed version string. Python
/// historically printed the version to stderr, modern versions to stdout,
/// so we check both.
fn version_of(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    let text = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        String::from_utf8_lossy(&output.stderr)
    };
    let version = text.trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn make_interpreter(path: PathBuf, version: String, is_venv: bool) -> Interpreter {
    let kind = if version.to_lowercase().contains("pypy") {
        "pypy"
    } else if is_venv {
        "venv"
    } else {
        "cpython"
    };
    let label = if is_venv {
        format!("{version} · .venv")
    } else {
        version.clone()
    };
    Interpreter {
        path: path.to_string_lossy().into_owned(),
        label,
        version,
        kind: kind.to_string(),
    }
}

/// Directories to scan for interpreter binaries, beyond `$PATH`.
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    // python.org framework installs keep each version under Versions/X.Y/bin.
    let framework = Path::new("/Library/Frameworks/Python.framework/Versions");
    if let Ok(entries) = std::fs::read_dir(framework) {
        for entry in entries.flatten() {
            dirs.push(entry.path().join("bin"));
        }
    }
    dirs
}

/// Discover Python interpreters: the workspace's virtualenv(s) first
/// (so a project's own deps resolve), then CPython/PyPy on the system.
/// The frontend picks the default (the latest Python version); PyPy is
/// listed as a selectable option but isn't the default.
#[tauri::command]
pub fn discover_python_interpreters(root: Option<String>) -> Vec<Interpreter> {
    let mut found: Vec<Interpreter> = Vec::new();
    // Dedupe system interpreters by their real path (python3 and
    // python3.12 are often the same binary). Venvs are kept separate even
    // when they symlink to a system python.
    let mut seen_real_paths: HashSet<PathBuf> = HashSet::new();

    // 1. Workspace virtualenvs — always listed, never deduped away.
    if let Some(root) = &root {
        for name in [".venv", "venv", "env"] {
            let python = venv_python(&Path::new(root).join(name));
            if python.exists() {
                if let Some(version) = version_of(&python) {
                    found.push(make_interpreter(python, version, true));
                }
            }
        }
    }

    // 2. System interpreters from PATH + common locations.
    let binary_names = [
        "pypy3", "pypy", "python3", "python3.13", "python3.12", "python3.11",
        "python",
    ];
    let mut search_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    search_dirs.extend(extra_search_dirs());

    for dir in &search_dirs {
        for name in &binary_names {
            let candidate = dir.join(name);
            if !candidate.exists() {
                continue;
            }
            // Resolve symlinks so duplicates collapse.
            let real = std::fs::canonicalize(&candidate).unwrap_or(candidate.clone());
            if seen_real_paths.contains(&real) {
                continue;
            }
            if let Some(version) = version_of(&candidate) {
                seen_real_paths.insert(real);
                found.push(make_interpreter(candidate, version, false));
            }
        }
    }

    // Display order: workspace venvs first, then system CPython, then
    // PyPy last. (The default selection — latest version — is computed
    // on the frontend, independent of this order.)
    found.sort_by_key(|interpreter| match interpreter.kind.as_str() {
        "venv" => 0,
        "cpython" => 1,
        _ => 2,
    });
    found
}

/// Create a new virtualenv at `target_dir` using `base` as the base
/// interpreter, and return the new interpreter. If the venv already
/// exists, `python -m venv` reuses it harmlessly.
#[tauri::command]
pub fn create_python_venv(
    base: String,
    target_dir: String,
) -> Result<Interpreter, String> {
    let output = Command::new(&base)
        .args(["-m", "venv", &target_dir])
        .output()
        .map_err(|error| format!("Could not run {base}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Creating environment failed: {}", stderr.trim()));
    }
    let python = venv_python(Path::new(&target_dir));
    if !python.exists() {
        return Err("Environment created but no python binary found".to_string());
    }
    let version = version_of(&python).unwrap_or_else(|| "Python".to_string());
    Ok(make_interpreter(python, version, true))
}
