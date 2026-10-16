//! Installing agents from the registry into Sable's agents folder (the
//! app's data folder locally, `~/.sable/agents` on a remote):
//!
//!   agents/<id>/sable-agent.json     what's installed and how to run it
//!   agents/<id>/<version>/           the files (npm prefix or unpacked archive)
//!
//! npm packages are installed with the user's own Node into a private
//! prefix (never globally); archives are downloaded, checked against the
//! registry's sha256 when it gives one, and unpacked; uvx agents run
//! through the user's uv.

use super::registry::{self, AgentEntry, BinaryTarget, Method, PackageDistribution};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const MANIFEST: &str = "sable-agent.json";

/// An installed agent, and how to start it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    /// "npx", "binary" or "uvx".
    pub kind: String,
    /// The program; for `node: true`, the script Node runs.
    pub program: String,
    /// Run `program` with the user's Node (npm packages: no reliance on a
    /// `#!/usr/bin/env node` finding Node on an app's minimal PATH).
    #[serde(default)]
    pub node: bool,
    /// The agent's ACP arguments (`acp`, `--acp`…) from the registry.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The version's folder (where it runs from, for relative paths).
    pub dir: String,
    #[serde(default)]
    pub installed_at: u64,
    /// SHA-256 of the downloaded archive (pinned on first download when the
    /// registry gives none: the same version must download the same bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
}

/// Progress for the UI: a message and, when known, a fraction 0–1.
pub type Progress<'a> = &'a (dyn Fn(&str, Option<f64>) + Send + Sync);

pub fn agent_root(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !registry::valid_id(id) {
        return Err(format!("Invalid agent id {id:?}"));
    }
    Ok(root.join(id))
}

/// The installed agent `id`, if any.
pub fn read(root: &Path, id: &str) -> Option<InstalledAgent> {
    if id == super::claude_code::ID {
        return super::claude_code::agent(root);
    }
    let text = std::fs::read_to_string(agent_root(root, id).ok()?.join(MANIFEST)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Every installed agent.
pub fn list(root: &Path) -> Vec<InstalledAgent> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut agents: Vec<InstalledAgent> = entries
        .flatten()
        .filter(|entry| entry.file_name() != super::claude_code::ID)
        .filter_map(|entry| read(root, &entry.file_name().to_string_lossy()))
        .collect();
    // Claude Code: the user's own CLI, when it's here.
    agents.extend(super::claude_code::agent(root));
    agents.sort_by(|a, b| a.id.cmp(&b.id));
    agents
}

pub fn uninstall(root: &Path, id: &str) -> Result<(), String> {
    if id == super::claude_code::ID {
        return Err("Claude Code is your own installation of the claude CLI; Sable doesn't remove it.".into());
    }
    let dir = agent_root(root, id)?;
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|error| format!("Couldn't remove {}: {error}", dir.display()))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Install `entry` (the version the registry names), replacing what was there.
pub async fn install(root: &Path, entry: &AgentEntry, platform: Option<&str>, progress: Progress<'_>) -> Result<InstalledAgent, String> {
    let method = registry::method(entry, platform)?;
    let agent_dir = agent_root(root, &entry.id)?;
    let version_name = sanitize_version(&entry.version);
    let partial = agent_dir.join(format!("{version_name}.partial"));
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).map_err(|error| format!("Couldn't create {}: {error}", partial.display()))?;
    // A version downloaded before must download the same bytes again.
    let pinned = read(root, &entry.id).filter(|old| old.version == entry.version).and_then(|old| old.archive_sha256);
    let mut archive_sha256 = None;
    let result = match &method {
        Method::Npx(package) => install_npm(&partial, package, progress).await,
        Method::Binary(target) => match install_binary(&partial, target, pinned.as_deref(), progress).await {
            Ok((found, sha)) => {
                archive_sha256 = Some(sha);
                Ok(found)
            }
            Err(error) => Err(error),
        },
        Method::Uvx(package) => install_uvx(package),
    };
    let (program, node, args, env) = match result {
        Ok(found) => found,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(error);
        }
    };
    // Move into place: <id>/<version>, then forget older versions.
    let final_dir = agent_dir.join(&version_name);
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&partial, &final_dir).map_err(|error| format!("Couldn't finish installing: {error}"))?;
    let rebase = |path: String| -> String {
        Path::new(&path)
            .strip_prefix(&partial)
            .map(|relative| final_dir.join(relative).to_string_lossy().into_owned())
            .unwrap_or(path)
    };
    let installed = InstalledAgent {
        id: entry.id.clone(),
        name: entry.name.clone(),
        version: entry.version.clone(),
        kind: method.kind().to_string(),
        program: rebase(program),
        node,
        args,
        env,
        dir: final_dir.to_string_lossy().into_owned(),
        installed_at: now(),
        archive_sha256,
    };
    let manifest = serde_json::to_string_pretty(&installed).map_err(|error| error.to_string())?;
    std::fs::write(agent_dir.join(MANIFEST), manifest).map_err(|error| error.to_string())?;
    if let Ok(entries) = std::fs::read_dir(&agent_dir) {
        for old in entries.flatten() {
            let path = old.path();
            if path.is_dir() && path != final_dir {
                // A running agent on Windows keeps its files: try again next time.
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    progress(&format!("Installed {} {}", entry.name, entry.version), Some(1.0));
    Ok(installed)
}

fn sanitize_version(version: &str) -> String {
    let clean: String = version.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+') { c } else { '_' }).collect();
    if clean.is_empty() || clean.starts_with('.') {
        format!("v{clean}")
    } else {
        clean
    }
}

type Found = (String, bool, Vec<String>, BTreeMap<String, String>);

// --- npm ------------------------------------------------------------------------------------

/// Node.js, if installed.
pub fn node() -> Option<PathBuf> {
    crate::lsp::resolve_binary("node")
}

fn npm(node: &Path) -> Option<PathBuf> {
    let beside = node.parent().map(|dir| dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" }));
    beside.filter(|path| path.exists()).or_else(|| crate::lsp::resolve_binary("npm"))
}

pub const NODE_MISSING: &str = "This agent needs Node.js 18 or later, and Node.js isn't installed. Install it from https://nodejs.org (the LTS version), then try again.";

async fn install_npm(dir: &Path, package: &PackageDistribution, progress: Progress<'_>) -> Result<Found, String> {
    let node = node().ok_or(NODE_MISSING)?;
    let npm = npm(&node).ok_or("npm wasn't found beside Node.js. Reinstall Node.js from https://nodejs.org.")?;
    progress(&format!("Installing {} with npm…", package.package), None);
    let mut command = tokio::process::Command::new(&npm);
    command
        .args(["install", "--prefix"])
        .arg(dir)
        .args(["--no-audit", "--no-fund", "--loglevel=error", "--omit=dev", "--no-package-lock"])
        .arg(&package.package)
        .current_dir(dir)
        .env("PATH", super::process::search_path(Some(&node)))
        .env("npm_config_update_notifier", "false")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(900), command.output())
        .await
        .map_err(|_| "npm took more than 15 minutes".to_string())?
        .map_err(|error| format!("Couldn't run npm: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail: Vec<&str> = stderr.lines().filter(|line| !line.trim().is_empty()).rev().take(6).collect();
        return Err(format!("npm couldn't install {}: {}", package.package, detail.into_iter().rev().collect::<Vec<_>>().join("\n")));
    }
    let (name, _) = registry::split_package(&package.package);
    if let Some(required) = required_node_version(&dir.join("node_modules").join(name)) {
        if let Some(have) = node_version(&node) {
            if have < required {
                return Err(format!(
                    "{} needs Node.js {}.{} or later, and this computer has Node.js {}.{}. Install the current LTS from https://nodejs.org, then try again.",
                    package.package, required.0, required.1, have.0, have.1
                ));
            }
        }
    }
    // npm skips an optional dependency it fails to fetch without saying so;
    // agents ship their native program that way (Codex's codex binary).
    for (package, spec) in missing_platform_packages(&dir.join("node_modules")) {
        progress(&format!("Installing {package} (this platform's build)…"), None);
        let output = tokio::process::Command::new(&npm)
            .args(["install", "--prefix"])
            .arg(dir)
            .args(["--no-audit", "--no-fund", "--loglevel=error", "--omit=dev", "--no-package-lock", "--no-save"])
            .arg(format!("{package}@{spec}"))
            .current_dir(dir)
            .env("PATH", super::process::search_path(Some(&node)))
            .env("npm_config_update_notifier", "false")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(Duration::from_secs(900), output)
            .await
            .map_err(|_| "npm took more than 15 minutes".to_string())?
            .map_err(|error| format!("Couldn't run npm: {error}"))?;
        if !output.status.success() || !dir.join("node_modules").join(&package).join("package.json").exists() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm couldn't install {package}, which {} needs on this platform: {}", package_name_for_error(name), stderr.lines().rev().take(4).collect::<Vec<_>>().join(" / ")));
        }
    }
    let bin = npm_bin(dir, name)?;
    let node_script = is_node_script(&bin);
    Ok((bin.to_string_lossy().into_owned(), node_script, package.args.clone(), package.env.clone()))
}

fn package_name_for_error(name: &str) -> &str {
    name
}

/// The npm os/cpu words for this machine (`darwin`, `arm64`).
fn npm_platform() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    (os, arch)
}

/// Per-platform optional dependencies (`<pkg>-darwin-arm64`) that npm
/// should have installed for this machine but didn't: (name, version spec).
pub fn missing_platform_packages(node_modules: &Path) -> Vec<(String, String)> {
    missing_platform_packages_for(node_modules, npm_platform())
}

fn missing_platform_packages_for(node_modules: &Path, (os, arch): (&str, &str)) -> Vec<(String, String)> {
    let mut manifests = Vec::new();
    let Ok(entries) = std::fs::read_dir(node_modules) else { return Vec::new() };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('@') {
            for scoped in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                manifests.push(scoped.path().join("package.json"));
            }
        } else {
            manifests.push(path.join("package.json"));
        }
    }
    let matches = |name: &str| {
        let words: Vec<&str> = name.rsplit('/').next().unwrap_or(name).split('-').collect();
        words.contains(&os) && words.contains(&arch) && !words.contains(&"musl")
    };
    let mut missing = Vec::new();
    for manifest in manifests {
        let Ok(text) = std::fs::read_to_string(&manifest) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(optional) = json["optionalDependencies"].as_object() else { continue };
        let platform_specific = optional.keys().filter(|name| ["darwin", "linux", "win32"].iter().any(|word| name.contains(word))).count() >= 2;
        if !platform_specific {
            continue;
        }
        let ours: Vec<(&String, &serde_json::Value)> = optional.iter().filter(|(name, _)| matches(name)).collect();
        if ours.is_empty() || ours.iter().any(|(name, _)| node_modules.join(name).join("package.json").exists()) {
            continue;
        }
        let (name, spec) = ours[0];
        if let Some(spec) = spec.as_str() {
            if !missing.iter().any(|(other, _): &(String, String)| other == name) {
                missing.push((name.clone(), spec.to_string()));
            }
        }
    }
    missing
}

/// The executable an installed npm package declares (`bin`).
pub fn npm_bin(prefix: &Path, name: &str) -> Result<PathBuf, String> {
    let package_dir = prefix.join("node_modules").join(name);
    let text = std::fs::read_to_string(package_dir.join("package.json")).map_err(|error| format!("{name} didn't install: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let short = name.rsplit('/').next().unwrap_or(name);
    let relative = match &manifest["bin"] {
        serde_json::Value::String(path) => path.clone(),
        serde_json::Value::Object(bins) => bins
            .get(short)
            .or_else(|| bins.get(name))
            .or_else(|| bins.values().next())
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("{name} has no program to run"))?
            .to_string(),
        _ => return Err(format!("{name} has no program to run (no \"bin\" in its package.json)")),
    };
    let path = package_dir.join(relative.trim_start_matches("./"));
    if !path.exists() {
        return Err(format!("{name}'s program {} is missing", path.display()));
    }
    Ok(path)
}

/// The lowest Node major version a package's `engines.node` accepts
/// (">=22", ">=22.19.0", "^20 || >=22" → its first number).
pub fn required_node_major(package_dir: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(package_dir.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_min_major(manifest["engines"]["node"].as_str()?)
}

/// The lowest Node version (major, minor) a package's `engines.node` accepts.
pub fn required_node_version(package_dir: &Path) -> Option<(u32, u32)> {
    let text = std::fs::read_to_string(package_dir.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_min_version(manifest["engines"]["node"].as_str()?)
}

/// ">=22.19.0" → (22, 19); "v24.16.0" → (24, 16); "^20 || >=22" → (20, 0).
fn parse_min_version(range: &str) -> Option<(u32, u32)> {
    let start = range.find(|c: char| c.is_ascii_digit())?;
    let mut parts = range[start..].split(|c: char| c != '.' && !c.is_ascii_digit()).next()?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|minor| minor.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// A Node.js binary's version (major, minor).
pub fn node_version(node: &Path) -> Option<(u32, u32)> {
    let output = std::process::Command::new(node).arg("--version").output().ok()?;
    parse_min_version(String::from_utf8_lossy(&output.stdout).trim())
}

fn parse_min_major(range: &str) -> Option<u32> {
    let start = range.find(|c: char| c.is_ascii_digit())?;
    range[start..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// The major version of a Node.js binary.
pub fn node_major(node: &Path) -> Option<u32> {
    let output = std::process::Command::new(node).arg("--version").output().ok()?;
    parse_min_major(String::from_utf8_lossy(&output.stdout).trim())
}

/// A JavaScript file (run it with Node) rather than a native program.
fn is_node_script(path: &Path) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if matches!(extension.as_str(), "js" | "cjs" | "mjs") {
        return true;
    }
    let mut head = [0u8; 128];
    let read = std::fs::File::open(path).and_then(|mut file| std::io::Read::read(&mut file, &mut head)).unwrap_or(0);
    let head = String::from_utf8_lossy(&head[..read]);
    head.starts_with("#!") && head.lines().next().is_some_and(|line| line.contains("node"))
}

// --- uvx ------------------------------------------------------------------------------------

fn install_uvx(package: &PackageDistribution) -> Result<Found, String> {
    let uvx = crate::lsp::resolve_binary("uvx").ok_or("This agent runs with uv, which isn't installed. Install it from https://docs.astral.sh/uv/, then try again.")?;
    let mut args = vec![package.package.clone()];
    args.extend(package.args.iter().cloned());
    Ok((uvx.to_string_lossy().into_owned(), false, args, package.env.clone()))
}

// --- Archives ---------------------------------------------------------------------------------

async fn install_binary(dir: &Path, target: &BinaryTarget, pinned: Option<&str>, progress: Progress<'_>) -> Result<(Found, String), String> {
    let file_name = target
        .archive
        .split(['?', '#'])
        .next()
        .and_then(|url| url.rsplit('/').next())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("download")
        .to_string();
    let archive = dir.join(&file_name);
    download(&target.archive, &archive, progress).await?;
    progress("Checking the download…", None);
    let actual = sha256_file(&archive)?;
    if let Some(expected) = &target.sha256 {
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            return Err(format!("The download's checksum doesn't match the registry's (expected {expected}, got {actual}); nothing was installed."));
        }
    } else if let Some(pinned) = pinned {
        if !actual.eq_ignore_ascii_case(pinned) {
            return Err(format!("This version downloaded different bytes than the first time (SHA-256 {pinned}, now {actual}); nothing was installed."));
        }
    }
    progress("Unpacking…", None);
    let unpack_into = dir.to_path_buf();
    let archive_path = archive.clone();
    tokio::task::spawn_blocking(move || extract(&archive_path, &unpack_into))
        .await
        .map_err(|error| error.to_string())??;
    if is_archive(&file_name) {
        let _ = std::fs::remove_file(&archive);
    }
    let program = resolve_cmd(dir, &target.cmd)?;
    make_executable(&program);
    Ok(((program.to_string_lossy().into_owned(), false, target.args.clone(), target.env.clone()), actual))
}

// --- A CLI the user installed themselves ---------------------------------------------------------

/// Where an agent's own installer puts its CLI (Cursor: `~/.local/bin`,
/// pointing into `~/.local/share/cursor-agent`), then the login shell's PATH.
pub fn find_local_cli(id: &str) -> Option<PathBuf> {
    let names: &[&str] = match id {
        "cursor" => &["cursor-agent", "agent"],
        _ => return None,
    };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)?;
    let mut candidates: Vec<PathBuf> = names.iter().map(|name| home.join(".local/bin").join(name)).collect();
    for dir in std::env::split_paths(&super::process::search_path(None)) {
        candidates.push(dir.join(if cfg!(windows) { "cursor-agent.cmd" } else { "cursor-agent" }));
    }
    let ours = home.join(".local/share/cursor-agent");
    candidates.into_iter().find(|path| {
        let Ok(real) = std::fs::canonicalize(path) else { return false };
        // A plain `agent` could be anything: only Cursor's own install.
        real.is_file() && (path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("cursor-agent")) || real.starts_with(&ours))
    })
}

/// Use the user's own CLI for `entry` instead of downloading it.
pub fn link_local(root: &Path, entry: &AgentEntry, program: &Path) -> Result<InstalledAgent, String> {
    let output = std::process::Command::new(program).arg("--version").stdin(std::process::Stdio::null()).output();
    let version = output
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|version| !version.is_empty() && version.len() < 60)
        .unwrap_or_else(|| "installed".into());
    let args = registry::method(entry, registry::platform().as_deref())
        .ok()
        .map(|method| match method {
            Method::Binary(target) => target.args.clone(),
            Method::Npx(package) | Method::Uvx(package) => package.args.clone(),
        })
        .unwrap_or_else(|| vec!["acp".into()]);
    let agent_dir = agent_root(root, &entry.id)?;
    std::fs::create_dir_all(&agent_dir).map_err(|error| error.to_string())?;
    let installed = InstalledAgent {
        id: entry.id.clone(),
        name: entry.name.clone(),
        version,
        kind: "cli".into(),
        program: program.to_string_lossy().into_owned(),
        node: false,
        args,
        env: BTreeMap::new(),
        dir: agent_dir.to_string_lossy().into_owned(),
        installed_at: now(),
        archive_sha256: None,
    };
    std::fs::write(agent_dir.join(MANIFEST), serde_json::to_string_pretty(&installed).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(installed)
}

async fn download(url: &str, to: &Path, progress: Progress<'_>) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;
    progress("Downloading…", Some(0.0));
    let response = reqwest::get(url).await.map_err(|error| format!("Couldn't download {url}: {error}"))?;
    let response = response.error_for_status().map_err(|error| format!("Couldn't download {url}: {error}"))?;
    let total = response.content_length();
    let mut file = std::fs::File::create(to).map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_report = 0.0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("The download failed: {error}"))?;
        file.write_all(&chunk).map_err(|error| error.to_string())?;
        received += chunk.len() as u64;
        if let Some(total) = total.filter(|total| *total > 0) {
            let fraction = received as f64 / total as f64;
            if fraction - last_report >= 0.02 {
                last_report = fraction;
                progress(&format!("Downloading… {:.0} of {:.0} MB", received as f64 / 1e6, total as f64 / 1e6), Some(fraction * 0.9));
            }
        }
    }
    file.flush().map_err(|error| error.to_string())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| error.to_string())?;
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn is_archive(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar"].iter().any(|suffix| name.ends_with(suffix))
}

/// Unpack `archive` into `dest`: .zip, .tar.gz/.tgz, .tar, .tar.bz2/.tbz2
/// (with the system's tar), or a bare program (left as it is). Entries
/// that would land outside `dest` are refused.
pub fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    std::fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let open = || std::fs::File::open(archive).map_err(|error| format!("Couldn't open {}: {error}", archive.display()));
    if name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(open()?).map_err(|error| format!("Not a valid zip: {error}"))?;
        for index in 0..zip.len() {
            let mut file = zip.by_index(index).map_err(|error| error.to_string())?;
            let Some(relative) = file.enclosed_name() else {
                return Err(format!("The archive has an unsafe path: {}", file.name()));
            };
            let out = dest.join(relative);
            if file.is_dir() {
                std::fs::create_dir_all(&out).map_err(|error| error.to_string())?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut writer = std::fs::File::create(&out).map_err(|error| error.to_string())?;
            std::io::copy(&mut file, &mut writer).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = file.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777));
            }
        }
        Ok(())
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        unpack_tar(tar::Archive::new(flate2::read::GzDecoder::new(open()?)), dest)
    } else if name.ends_with(".tar") {
        unpack_tar(tar::Archive::new(open()?), dest)
    } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
        let output = std::process::Command::new("tar")
            .arg("-xjf")
            .arg(archive)
            .arg("-C")
            .arg(dest)
            .output()
            .map_err(|error| format!("Couldn't run tar: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("tar couldn't unpack it: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    } else {
        // A raw program: already where it belongs.
        if archive.parent() != Some(dest) {
            std::fs::copy(archive, dest.join(archive.file_name().unwrap_or_default())).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn unpack_tar<R: std::io::Read>(mut archive: tar::Archive<R>, dest: &Path) -> Result<(), String> {
    archive.set_preserve_permissions(true);
    for entry in archive.entries().map_err(|error| format!("Not a valid archive: {error}"))? {
        let mut entry = entry.map_err(|error| format!("Not a valid archive: {error}"))?;
        let path = entry.path().map_err(|error| error.to_string())?.into_owned();
        if path.components().any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
            return Err(format!("The archive has an unsafe path: {}", path.display()));
        }
        entry.unpack_in(dest).map_err(|error| format!("Couldn't unpack {}: {error}", path.display()))?;
    }
    Ok(())
}

/// The registry's `cmd` ("./kimi", "./dist-package\\cursor-agent.cmd")
/// as a path inside `dir`.
pub fn resolve_cmd(dir: &Path, cmd: &str) -> Result<PathBuf, String> {
    let mut path = dir.to_path_buf();
    for part in cmd.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return Err(format!("The agent's command {cmd:?} points outside its folder")),
            part => path.push(part),
        }
    }
    if path == dir {
        return Err(format!("The agent's command {cmd:?} is empty"));
    }
    if !path.exists() {
        return Err(format!("The download doesn't contain {cmd}"));
    }
    Ok(path)
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(permissions.mode() | 0o755);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// What's available for running agents here.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Runtimes {
    pub node: Option<String>,
    pub node_version: Option<String>,
    pub npm: Option<String>,
    pub uvx: Option<String>,
    pub platform: Option<String>,
}

pub async fn runtimes() -> Runtimes {
    let node = node();
    let mut node_version = None;
    if let Some(node) = &node {
        let output = tokio::time::timeout(Duration::from_secs(10), tokio::process::Command::new(node).arg("--version").kill_on_drop(true).output()).await;
        if let Ok(Ok(output)) = output {
            node_version = Some(String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|v| !v.is_empty());
        }
    }
    Runtimes {
        npm: node.as_deref().and_then(npm).map(|path| path.to_string_lossy().into_owned()),
        node: node.map(|path| path.to_string_lossy().into_owned()),
        node_version,
        uvx: crate::lsp::resolve_binary("uvx").map(|path| path.to_string_lossy().into_owned()),
        platform: registry::platform(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sable-acp-{name}-{}-{}", std::process::id(), now()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A .tar.gz with `bin/agent` (executable) and `README`.
    fn fixture_tar_gz(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
        let mut add = |name: &str, body: &[u8], mode: u32| {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(mode);
            header.set_cksum();
            builder.append_data(&mut header, name, body).unwrap();
        };
        add("dist/agent", b"#!/bin/sh\necho agent\n", 0o755);
        add("dist/README", b"hello", 0o644);
        builder.into_inner().unwrap().finish().unwrap();
    }

    fn fixture_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, body) in entries {
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).unix_permissions(0o755);
            zip.start_file(*name, options).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extracts_tar_gz_and_zip() {
        let dir = temp("extract");
        let archive = dir.join("agent.tar.gz");
        fixture_tar_gz(&archive);
        let out = dir.join("out");
        extract(&archive, &out).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("dist/README")).unwrap(), "hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(std::fs::metadata(out.join("dist/agent")).unwrap().permissions().mode() & 0o111, 0);
        }

        let zip_path = dir.join("agent.zip");
        fixture_zip(&zip_path, &[("pkg/run.cmd", b"@echo off"), ("pkg/lib/x.txt", b"x")]);
        let zout = dir.join("zout");
        extract(&zip_path, &zout).unwrap();
        assert_eq!(std::fs::read_to_string(zout.join("pkg/lib/x.txt")).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_archives_that_escape() {
        let dir = temp("escape");
        let zip_path = dir.join("evil.zip");
        fixture_zip(&zip_path, &[("../evil.txt", b"x")]);
        assert!(extract(&zip_path, &dir.join("out")).is_err());
        assert!(!dir.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_registry_commands_inside_the_folder() {
        let dir = temp("cmd");
        std::fs::create_dir_all(dir.join("dist-package")).unwrap();
        std::fs::write(dir.join("dist-package/cursor-agent.cmd"), "").unwrap();
        std::fs::write(dir.join("kimi"), "").unwrap();
        assert_eq!(resolve_cmd(&dir, "./kimi").unwrap(), dir.join("kimi"));
        assert_eq!(resolve_cmd(&dir, "./dist-package\\cursor-agent.cmd").unwrap(), dir.join("dist-package").join("cursor-agent.cmd"));
        assert!(resolve_cmd(&dir, "../etc/passwd").is_err());
        assert!(resolve_cmd(&dir, "./missing").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn node_versions_with_minor() {
        assert_eq!(parse_min_version(">=22.19.0"), Some((22, 19)));
        assert_eq!(parse_min_version("v22.12.1"), Some((22, 12)));
        assert_eq!(parse_min_version(">=18"), Some((18, 0)));
        assert!(parse_min_version("v22.12.1").unwrap() < parse_min_version(">=22.19.0").unwrap(), "22.12 is too old for Kimi Code");
    }

    #[test]
    fn finds_platform_packages_npm_skipped() {
        let dir = temp("optional");
        let modules = dir.join("node_modules");
        let write = |path: &str, json: &str| {
            std::fs::create_dir_all(modules.join(path)).unwrap();
            std::fs::write(modules.join(path).join("package.json"), json).unwrap();
        };
        write(
            "@openai/codex",
            r#"{"name":"@openai/codex","optionalDependencies":{"@openai/codex-linux-x64":"npm:@openai/codex@1.0.0-linux-x64","@openai/codex-darwin-arm64":"npm:@openai/codex@1.0.0-darwin-arm64","@openai/codex-darwin-x64":"npm:@openai/codex@1.0.0-darwin-x64"}}"#,
        );
        // Not platform packages (an ordinary optional dependency).
        write("tool", r#"{"name":"tool","optionalDependencies":{"node-pty":"^1"}}"#);
        // Present already: nothing to do.
        write("@x/clip", r#"{"name":"@x/clip","optionalDependencies":{"@x/clip-darwin-arm64":"1.0.0","@x/clip-linux-x64-gnu":"1.0.0","@x/clip-linux-x64-musl":"1.0.0"}}"#);
        write("@x/clip-darwin-arm64", r#"{"name":"@x/clip-darwin-arm64"}"#);
        let missing = missing_platform_packages_for(&modules, ("darwin", "arm64"));
        assert_eq!(missing, vec![("@openai/codex-darwin-arm64".to_string(), "npm:@openai/codex@1.0.0-darwin-arm64".to_string())]);
        // Linux: glibc builds, never musl ones.
        let linux = missing_platform_packages_for(&modules, ("linux", "x64"));
        assert!(linux.contains(&("@x/clip-linux-x64-gnu".to_string(), "1.0.0".to_string())) && linux.iter().all(|(name, _)| !name.contains("musl")), "{linux:?}");
        write("@openai/codex-darwin-arm64", r#"{"name":"@openai/codex"}"#);
        assert!(missing_platform_packages_for(&modules, ("darwin", "arm64")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn node_engine_ranges() {
        assert_eq!(parse_min_major(">=22"), Some(22));
        assert_eq!(parse_min_major(">=22.19.0"), Some(22));
        assert_eq!(parse_min_major("^20 || >=22"), Some(20));
        assert_eq!(parse_min_major("v24.16.0"), Some(24));
        assert_eq!(parse_min_major("*"), None);
    }

    #[test]
    fn checksums() {
        let dir = temp("sha");
        std::fs::write(dir.join("empty"), b"").unwrap();
        assert_eq!(sha256_file(&dir.join("empty")).unwrap(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_an_npm_packages_program() {
        let dir = temp("npmbin");
        let package = dir.join("node_modules/@scope/agent");
        std::fs::create_dir_all(package.join("dist")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"@scope/agent","bin":{"agent":"dist/index.js","other":"x.js"}}"#).unwrap();
        std::fs::write(package.join("dist/index.js"), "#!/usr/bin/env node\n").unwrap();
        let bin = npm_bin(&dir, "@scope/agent").unwrap();
        assert_eq!(bin, package.join("dist/index.js"));
        assert!(is_node_script(&bin));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole binary install, from a local server: download, sha256,
    /// unpack, executable bit, manifest, listing, uninstall.
    #[tokio::test]
    async fn installs_a_binary_agent_from_an_archive() {
        let dir = temp("install");
        let archive = dir.join("fixture.tar.gz");
        fixture_tar_gz(&archive);
        let bytes = std::fs::read(&archive).unwrap();
        let sha = sha256_file(&archive).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = bytes.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut stream, _)) = listener.accept().await {
                let body = served.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 2048];
                    let _ = stream.read(&mut buffer).await;
                    let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(header.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        let entry_json = |sha: &str| {
            format!(
                r#"{{"id":"fake","name":"Fake","version":"1.2.3","distribution":{{"binary":{{"darwin-aarch64":{{"archive":"http://127.0.0.1:{port}/fake.tar.gz","cmd":"./dist/agent","args":["acp"],"sha256":"{sha}"}}}}}}}}"#
            )
        };
        let root = dir.join("agents");
        let quiet = |_: &str, _: Option<f64>| {};
        // A wrong checksum installs nothing.
        let bad: AgentEntry = serde_json::from_str(&entry_json("00")).unwrap();
        let error = install(&root, &bad, Some("darwin-aarch64"), &quiet).await.unwrap_err();
        assert!(error.contains("checksum"), "{error}");
        assert!(read(&root, "fake").is_none());

        let entry: AgentEntry = serde_json::from_str(&entry_json(&sha)).unwrap();
        let installed = install(&root, &entry, Some("darwin-aarch64"), &quiet).await.unwrap();
        assert_eq!(installed.kind, "binary");
        assert_eq!(installed.args, vec!["acp"]);
        assert!(installed.program.ends_with("1.2.3/dist/agent"), "{}", installed.program);
        assert!(Path::new(&installed.program).exists());
        assert!(!Path::new(&installed.dir).join("fake.tar.gz").exists(), "the archive is removed");
        let mine = |root: &Path| list(root).into_iter().filter(|agent| agent.id != "claude-code").collect::<Vec<_>>();
        assert_eq!(mine(&root), vec![installed.clone()]);
        assert_eq!(installed.archive_sha256.as_deref(), Some(sha.as_str()), "the archive's hash is recorded");
        // Without a registry checksum, the same version must download the
        // same bytes as the first time.
        let unpinned: AgentEntry = serde_json::from_str(&entry_json(&sha).replace(&format!(",\"sha256\":\"{sha}\""), "")).unwrap();
        assert!(unpinned.distribution.binary.as_ref().unwrap()["darwin-aarch64"].sha256.is_none());
        install(&root, &unpinned, Some("darwin-aarch64"), &quiet).await.unwrap();
        let mut manifest = read(&root, "fake").unwrap();
        manifest.archive_sha256 = Some("00".repeat(32));
        std::fs::write(root.join("fake").join(MANIFEST), serde_json::to_string(&manifest).unwrap()).unwrap();
        let changed = install(&root, &unpinned, Some("darwin-aarch64"), &quiet).await.unwrap_err();
        assert!(changed.contains("different bytes"), "{changed}");
        install(&root, &entry, Some("darwin-aarch64"), &quiet).await.unwrap();
        // Reinstalling another version replaces the first.
        let newer: AgentEntry = serde_json::from_str(&entry_json(&sha).replace("1.2.3", "1.3.0")).unwrap();
        let updated = install(&root, &newer, Some("darwin-aarch64"), &quiet).await.unwrap();
        assert_eq!(updated.version, "1.3.0");
        assert!(!Path::new(&installed.dir).exists(), "the old version is gone");
        uninstall(&root, "fake").unwrap();
        assert!(mine(&root).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
