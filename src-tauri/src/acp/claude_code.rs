//! "Claude Code" in the agent panel: the user's own installed, unmodified
//! `claude` CLI, driven by Sable's ACP adapter (claude_code_adapter.mjs)
//! in headless stream-json mode. It isn't installed by Sable: it's
//! "installed" when a `claude` is found here (or on the remote), and its
//! sign-in is Claude Code's own (`/login` in a terminal running `claude`).
//! Sable never passes auth flags or variables, and never reads credentials.

use super::install::InstalledAgent;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const ID: &str = "claude-code";
const ADAPTER: &str = include_str!("claude_code_adapter.mjs");

/// Where `claude` usually lives, after an explicit override.
pub fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("SABLE_CLAUDE_PATH") {
        out.push(PathBuf::from(path));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        out.push(home.join(".claude/local/claude"));
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".npm-global/bin/claude"));
        out.push(home.join(".bun/bin/claude"));
    }
    for dir in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
        out.push(Path::new(dir).join("claude"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        out.push(Path::new(&appdata).join("npm").join("claude.cmd"));
    }
    // The login shell's PATH (npm globals, version managers).
    for dir in std::env::split_paths(&super::process::search_path(None)) {
        out.push(dir.join(if cfg!(windows) { "claude.exe" } else { "claude" }));
    }
    out
}

/// The `claude` CLI, if installed.
pub fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|path| path.is_file())
}

/// `claude --version` → "2.1.179".
fn version(claude: &Path) -> String {
    let output = std::process::Command::new(claude).arg("--version").stdin(std::process::Stdio::null()).output();
    output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).split_whitespace().next().unwrap_or("").to_string())
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "installed".into())
}

/// Claude Code as an installed agent: the adapter (written into the
/// agents folder) run with Node, pointed at the `claude` found.
pub fn agent(root: &Path) -> Option<InstalledAgent> {
    let claude = find()?;
    let dir = root.join(ID);
    let adapter = dir.join("adapter.mjs");
    if std::fs::read_to_string(&adapter).ok().as_deref() != Some(ADAPTER) {
        std::fs::create_dir_all(&dir).ok()?;
        let temporary = dir.join(format!("adapter-{}.tmp", std::process::id()));
        std::fs::write(&temporary, ADAPTER).ok()?;
        std::fs::rename(&temporary, &adapter).ok()?;
    }
    Some(InstalledAgent {
        id: ID.into(),
        name: "Claude Code".into(),
        version: version(&claude),
        kind: "cli".into(),
        program: adapter.to_string_lossy().into_owned(),
        node: true,
        args: vec![],
        env: BTreeMap::from([("SABLE_CLAUDE_PATH".to_string(), claude.to_string_lossy().into_owned())]),
        dir: dir.to_string_lossy().into_owned(),
        installed_at: 0,
        archive_sha256: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_override_is_tried_first_and_the_adapter_is_written() {
        let _lock = crate::acp::claude_code::tests::LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("sable-cc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude");
        std::fs::write(&fake, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("SABLE_CLAUDE_PATH", &fake);
        assert_eq!(candidates()[0], fake);
        assert_eq!(find().as_deref(), Some(fake.as_path()));
        let root = dir.join("agents");
        let agent = agent(&root).unwrap();
        std::env::remove_var("SABLE_CLAUDE_PATH");
        assert_eq!(agent.id, "claude-code");
        assert!(agent.node);
        #[cfg(unix)]
        assert_eq!(agent.version, "9.9.9");
        assert_eq!(agent.env["SABLE_CLAUDE_PATH"], fake.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&agent.program).unwrap(), ADAPTER);
        let _ = std::fs::remove_dir_all(&dir);
    }

    pub(crate) static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
