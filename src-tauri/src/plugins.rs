//! Plugins: finding, installing, enabling and removing them. (Running them
//! is the frontend's job — each plugin runs in its own Web Worker, with
//! only the API and permissions the frontend gives it; see
//! src/lib/plugins/.)
//!
//! A plugin is a folder holding `sable-plugin.json` (its manifest) and one
//! ES module (`main`, usually main.js). Installed plugins live in the app
//! data folder, `plugins/<id>/`; a *linked* plugin (one being developed)
//! stays where it is. `plugins/registry.json` records each plugin's
//! folder, whether it's enabled, and where it came from (for updates).
//!
//! Installing is two steps so the user can see what a plugin asks for
//! first: `plugin_inspect` reads (and for a URL, downloads and unpacks) a
//! plugin and returns its manifest; `plugin_install` then installs it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Where plugins live (set at startup).
static PLUGINS_DIR: OnceLock<PathBuf> = OnceLock::new();
/// One registry writer at a time.
static LOCK: Mutex<()> = Mutex::new(());

pub const MANIFEST_FILE: &str = "sable-plugin.json";
/// What a plugin may ask for; anything else is refused at install.
pub const PERMISSIONS: &[&str] = &["editor", "workspace:read", "workspace:write", "shell", "network"];
const MAX_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 10 * 1024 * 1024;
/// Not copied when installing from a folder.
const SKIPPED: &[&str] = &[".git", "node_modules"];

pub fn set_plugins_dir(dir: PathBuf) {
    let _ = PLUGINS_DIR.set(dir);
}

fn plugins_dir() -> Result<PathBuf, String> {
    PLUGINS_DIR.get().cloned().ok_or_else(|| "Plugins folder unavailable".to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// The ES module to run, relative to the plugin folder.
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// The oldest Sable this plugin works with ("0.3.2").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_sable_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

fn default_main() -> String {
    "main.js".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    path: PathBuf,
    linked: bool,
    enabled: bool,
    /// The URL it was installed from (offered as "Update").
    #[serde(default)]
    source: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Registry {
    plugins: BTreeMap<String, RegistryEntry>,
}

/// An installed plugin, as the frontend sees it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: Manifest,
    pub path: String,
    pub linked: bool,
    pub enabled: bool,
    pub source: Option<String>,
}

/// A plugin ready to install (`plugin_inspect`'s result).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    pub manifest: Manifest,
    /// Its folder: the folder given, or where a download was unpacked.
    pub path: String,
    /// Already installed: that version (an update or reinstall).
    pub installed_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginSource {
    Folder { path: String },
    Url { url: String },
}

fn registry_file() -> Result<PathBuf, String> {
    Ok(plugins_dir()?.join("registry.json"))
}

fn read_registry() -> Result<Registry, String> {
    match std::fs::read_to_string(registry_file()?) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("The plugin registry is damaged: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Registry::default()),
        Err(error) => Err(format!("Could not read the plugin registry: {error}")),
    }
}

fn write_registry(registry: &Registry) -> Result<(), String> {
    let file = registry_file()?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|error| error.to_string())?;
    let temp = file.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    std::fs::write(&temp, text).map_err(|error| format!("Could not save the plugin registry: {error}"))?;
    std::fs::rename(&temp, &file).map_err(|error| format!("Could not save the plugin registry: {error}"))
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().trim_start_matches('v').split(['.', '-', '+']);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Read and check a plugin folder's manifest.
pub fn read_manifest(folder: &Path) -> Result<Manifest, String> {
    let file = folder.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&file)
        .map_err(|_| format!("No {MANIFEST_FILE} in {}", folder.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|error| format!("{MANIFEST_FILE} is invalid: {error}"))?;
    validate(&manifest, folder)?;
    Ok(manifest)
}

fn validate(manifest: &Manifest, folder: &Path) -> Result<(), String> {
    let id = &manifest.id;
    let id_ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !id.contains("..");
    if !id_ok {
        return Err(format!(
            "Plugin id \"{id}\" is invalid — use lowercase letters, digits, '-' and '.' (e.g. \"my-plugin\")"
        ));
    }
    if manifest.name.trim().is_empty() {
        return Err("The plugin has no name".into());
    }
    if parse_version(&manifest.version).is_none() {
        return Err(format!("Plugin version \"{}\" isn't a version like 1.0.0", manifest.version));
    }
    for permission in &manifest.permissions {
        if !PERMISSIONS.contains(&permission.as_str()) {
            return Err(format!(
                "Unknown permission \"{permission}\" (known: {})",
                PERMISSIONS.join(", ")
            ));
        }
    }
    if let Some(minimum) = &manifest.min_sable_version {
        let wanted = parse_version(minimum).ok_or_else(|| format!("minSableVersion \"{minimum}\" isn't a version"))?;
        let ours = parse_version(env!("CARGO_PKG_VERSION")).unwrap_or((0, 0, 0));
        if wanted > ours {
            return Err(format!(
                "This plugin needs Sable {minimum} or newer (this is {})",
                env!("CARGO_PKG_VERSION")
            ));
        }
    }
    let main = Path::new(&manifest.main);
    let inside = main.is_relative() && main.components().all(|part| matches!(part, std::path::Component::Normal(_)));
    if !inside || !(manifest.main.ends_with(".js") || manifest.main.ends_with(".mjs")) {
        return Err(format!("\"main\" must be a .js file inside the plugin folder (got \"{}\")", manifest.main));
    }
    if !folder.join(main).is_file() {
        return Err(format!("The plugin's main file {} is missing", manifest.main));
    }
    Ok(())
}

fn info(manifest: Manifest, entry: &RegistryEntry) -> PluginInfo {
    PluginInfo {
        manifest,
        path: entry.path.to_string_lossy().into_owned(),
        linked: entry.linked,
        enabled: entry.enabled,
        source: entry.source.clone(),
    }
}

/// Every installed plugin. One whose folder or manifest went bad is left
/// out (it can still be uninstalled by id).
#[tauri::command]
pub fn plugin_list() -> Result<Vec<PluginInfo>, String> {
    let registry = read_registry()?;
    Ok(registry
        .plugins
        .values()
        .filter_map(|entry| read_manifest(&entry.path).ok().map(|manifest| info(manifest, entry)))
        .collect())
}

/// A GitHub repository page becomes its source tarball; other URLs are
/// used as they are.
fn download_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() == 2 {
            return format!("https://codeload.github.com/{}/{}/tar.gz/HEAD", parts[0], parts[1]);
        }
        if parts.len() >= 4 && parts[2] == "tree" {
            return format!("https://codeload.github.com/{}/{}/tar.gz/{}", parts[0], parts[1], parts[3..].join("/"));
        }
    }
    trimmed.to_string()
}

fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}

/// Unpack a downloaded archive (.tar.gz or .zip) into `into` and return
/// the folder holding the manifest: `into` itself, or the archive's one
/// top-level folder (GitHub tarballs wrap everything in `repo-ref/`).
pub fn unpack(bytes: &[u8], into: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
    let zip = is_zip(bytes);
    let archive = into.join(if zip { "download.zip" } else { "download.tar.gz" });
    std::fs::write(&archive, bytes).map_err(|error| error.to_string())?;
    let run = |program: &str, args: &[&std::ffi::OsStr]| {
        std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    // bsdtar (macOS, Windows) reads zips too; GNU tar (Linux) doesn't.
    let unpacked = run("tar", &["-xf".as_ref(), archive.as_os_str(), "-C".as_ref(), into.as_os_str()])
        || (zip && run("unzip", &["-q".as_ref(), "-o".as_ref(), archive.as_os_str(), "-d".as_ref(), into.as_os_str()]));
    let _ = std::fs::remove_file(&archive);
    if !unpacked {
        return Err("Couldn't unpack the download — it must be a .zip or .tar.gz holding the plugin".into());
    }
    if into.join(MANIFEST_FILE).is_file() {
        return Ok(into.to_path_buf());
    }
    let folders: Vec<PathBuf> = std::fs::read_dir(into)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    match folders.as_slice() {
        [only] if only.join(MANIFEST_FILE).is_file() => Ok(only.clone()),
        _ => Err(format!("The download has no {MANIFEST_FILE} at its top level")),
    }
}

fn staging_dir() -> Result<PathBuf, String> {
    Ok(plugins_dir()?.join(".staging"))
}

/// Read a plugin before installing it: from a folder, or downloaded and
/// unpacked into the staging folder.
#[tauri::command]
pub async fn plugin_inspect(source: PluginSource) -> Result<Inspected, String> {
    let folder = match source {
        PluginSource::Folder { path } => PathBuf::from(path),
        PluginSource::Url { url } => {
            let url = download_url(&url);
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err("Enter a GitHub repository or a link to a .zip / .tar.gz".into());
            }
            let response = reqwest::get(&url)
                .await
                .and_then(|response| response.error_for_status())
                .map_err(|error| format!("Download failed: {error}"))?;
            if response.content_length().is_some_and(|length| length as usize > MAX_DOWNLOAD_BYTES) {
                return Err("The download is too large for a plugin (over 50 MB)".into());
            }
            let bytes = response.bytes().await.map_err(|error| format!("Download failed: {error}"))?;
            if bytes.len() > MAX_DOWNLOAD_BYTES {
                return Err("The download is too large for a plugin (over 50 MB)".into());
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or(0);
            let into = staging_dir()?.join(format!("{stamp}"));
            tokio::task::spawn_blocking(move || unpack(&bytes, &into))
                .await
                .map_err(|error| error.to_string())??
        }
    };
    let manifest = read_manifest(&folder)?;
    let installed_version = read_registry()?
        .plugins
        .get(&manifest.id)
        .and_then(|entry| read_manifest(&entry.path).ok())
        .map(|installed| installed.version);
    Ok(Inspected { manifest, path: folder.to_string_lossy().into_owned(), installed_version })
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIPPED.iter().any(|skipped| name == *skipped) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), to.join(&name))?;
        }
        // Symlinks aren't followed: a plugin is plain files.
    }
    Ok(())
}

/// Install an inspected plugin. `link`: run it from its folder (for
/// developing it) instead of copying it in. Replaces an installed version.
#[tauri::command]
pub fn plugin_install(path: String, link: bool, source: Option<String>) -> Result<PluginInfo, String> {
    let folder = PathBuf::from(&path);
    let manifest = read_manifest(&folder)?;
    let dir = plugins_dir()?;
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut registry = read_registry()?;
    let previous = registry.plugins.get(&manifest.id).cloned();
    let staging = staging_dir()?;
    let target = if link {
        std::fs::canonicalize(&folder).map_err(|error| error.to_string())?
    } else {
        let target = dir.join(&manifest.id);
        let replacing = target.exists();
        let temp = dir.join(format!(".installing-{}", manifest.id));
        let _ = std::fs::remove_dir_all(&temp);
        if folder.starts_with(&staging) {
            std::fs::rename(&folder, &temp)
        } else {
            copy_dir(&folder, &temp)
        }
        .map_err(|error| format!("Could not install {}: {error}", manifest.name))?;
        if replacing {
            std::fs::remove_dir_all(&target).map_err(|error| format!("Could not replace the old version: {error}"))?;
        }
        std::fs::rename(&temp, &target).map_err(|error| format!("Could not install {}: {error}", manifest.name))?;
        target
    };
    // Unpacked downloads are done with.
    let _ = std::fs::remove_dir_all(&staging);
    let entry = RegistryEntry {
        path: target,
        linked: link,
        // An update keeps the plugin's on/off state.
        enabled: previous.as_ref().is_none_or(|previous| previous.enabled),
        source: source.or_else(|| previous.and_then(|previous| previous.source)),
    };
    registry.plugins.insert(manifest.id.clone(), entry.clone());
    write_registry(&registry)?;
    Ok(info(manifest, &entry))
}

/// Remove a plugin (a linked plugin's own folder is left alone).
#[tauri::command]
pub fn plugin_uninstall(id: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut registry = read_registry()?;
    let entry = registry.plugins.remove(&id).ok_or_else(|| format!("No plugin {id}"))?;
    if !entry.linked && entry.path.starts_with(plugins_dir()?) {
        std::fs::remove_dir_all(&entry.path).map_err(|error| format!("Could not remove {id}: {error}"))?;
    }
    write_registry(&registry)
}

#[tauri::command]
pub fn plugin_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut registry = read_registry()?;
    registry.plugins.get_mut(&id).ok_or_else(|| format!("No plugin {id}"))?.enabled = enabled;
    write_registry(&registry)
}

/// A plugin's main module source (the frontend runs it in a worker).
#[tauri::command]
pub fn plugin_read_main(id: String) -> Result<String, String> {
    let registry = read_registry()?;
    let entry = registry.plugins.get(&id).ok_or_else(|| format!("No plugin {id}"))?;
    let manifest = read_manifest(&entry.path)?;
    let file = entry.path.join(&manifest.main);
    if std::fs::metadata(&file).map(|metadata| metadata.len()).unwrap_or(0) > MAX_SOURCE_BYTES {
        return Err(format!("{} is too large (over 10 MB)", manifest.main));
    }
    std::fs::read_to_string(&file).map_err(|error| format!("Could not read {}: {error}", manifest.main))
}

/// Throw away an inspected download that wasn't installed.
#[tauri::command]
pub fn plugin_discard(path: String) -> Result<(), String> {
    let staging = staging_dir()?;
    if Path::new(&path).starts_with(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(folder: &Path, manifest: &str, main: Option<&str>) {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join(MANIFEST_FILE), manifest).unwrap();
        if let Some(main) = main {
            std::fs::write(folder.join("main.js"), main).unwrap();
        }
    }

    const GOOD: &str = r#"{ "id": "hello", "name": "Hello", "version": "1.0.0", "permissions": ["editor"] }"#;

    #[test]
    fn manifests_are_checked() {
        let base = std::env::temp_dir().join(format!("sable-plugin-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let check = |name: &str, manifest: &str, main: Option<&str>| {
            let folder = base.join(name);
            write_plugin(&folder, manifest, main);
            read_manifest(&folder)
        };
        let manifest = check("good", GOOD, Some("export function activate() {}")).unwrap();
        assert_eq!(manifest.main, "main.js");
        assert!(check("no-main", GOOD, None).unwrap_err().contains("missing"));
        assert!(check("bad-id", r#"{ "id": "../evil", "name": "x", "version": "1.0.0" }"#, Some("")).unwrap_err().contains("invalid"));
        assert!(check("bad-perm", r#"{ "id": "x", "name": "x", "version": "1.0.0", "permissions": ["root"] }"#, Some("")).unwrap_err().contains("Unknown permission"));
        assert!(check("escape", r#"{ "id": "x", "name": "x", "version": "1.0.0", "main": "../main.js" }"#, Some("")).unwrap_err().contains("inside the plugin folder"));
        assert!(check("future", r#"{ "id": "x", "name": "x", "version": "1.0.0", "minSableVersion": "99.0.0" }"#, Some("")).unwrap_err().contains("needs Sable"));
        assert!(check("bad-version", r#"{ "id": "x", "name": "x", "version": "soon" }"#, Some("")).unwrap_err().contains("version"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn github_urls_become_tarballs() {
        assert_eq!(download_url("https://github.com/me/plugin"), "https://codeload.github.com/me/plugin/tar.gz/HEAD");
        assert_eq!(download_url("https://github.com/me/plugin.git/"), "https://codeload.github.com/me/plugin/tar.gz/HEAD");
        assert_eq!(download_url("https://github.com/me/plugin/tree/v1.2"), "https://codeload.github.com/me/plugin/tar.gz/v1.2");
        assert_eq!(download_url("https://example.com/p.zip"), "https://example.com/p.zip");
    }

    /// Install (copy, then update), link, disable, uninstall, and unpack a
    /// GitHub-style tarball — against a private plugins folder.
    #[test]
    fn installs_links_and_uninstalls() {
        let base = std::env::temp_dir().join(format!("sable-plugins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        set_plugins_dir(base.join("plugins"));
        let dir = plugins_dir().unwrap();
        assert!(dir.starts_with(&base), "another test set the plugins folder first");

        let source = base.join("src/hello");
        write_plugin(&source, GOOD, Some("export function activate() {}"));
        std::fs::create_dir_all(source.join("node_modules/dep")).unwrap();
        let installed = plugin_install(source.to_string_lossy().into_owned(), false, None).unwrap();
        assert_eq!(Path::new(&installed.path), dir.join("hello"));
        assert!(!dir.join("hello/node_modules").exists(), "node_modules isn't copied");
        assert_eq!(plugin_read_main("hello".into()).unwrap(), "export function activate() {}");

        // Disabled stays disabled across an update.
        plugin_set_enabled("hello".into(), false).unwrap();
        write_plugin(&source, &GOOD.replace("1.0.0", "1.1.0"), None);
        let updated = plugin_install(source.to_string_lossy().into_owned(), false, None).unwrap();
        assert_eq!(updated.manifest.version, "1.1.0");
        assert!(!updated.enabled);

        // A linked plugin runs from its own folder; uninstalling leaves it.
        let dev = base.join("dev/linked");
        write_plugin(&dev, &GOOD.replace("hello", "linked"), Some("export function activate() {}"));
        let linked = plugin_install(dev.to_string_lossy().into_owned(), true, None).unwrap();
        assert!(linked.linked);
        assert_eq!(plugin_list().unwrap().len(), 2);
        plugin_uninstall("linked".into()).unwrap();
        assert!(dev.join(MANIFEST_FILE).exists());
        plugin_uninstall("hello".into()).unwrap();
        assert!(!dir.join("hello").exists());
        assert!(plugin_list().unwrap().is_empty());

        // A tarball with one top-level folder, as GitHub serves them.
        let tree = base.join("tree/repo-main");
        write_plugin(&tree, &GOOD.replace("hello", "from-url"), Some("export function activate() {}"));
        let tarball = base.join("repo.tar.gz");
        let status = std::process::Command::new("tar")
            .args(["-czf"])
            .arg(&tarball)
            .args(["-C"])
            .arg(base.join("tree"))
            .arg("repo-main")
            .status()
            .unwrap();
        assert!(status.success());
        let unpacked = unpack(&std::fs::read(&tarball).unwrap(), &staging_dir().unwrap().join("1")).unwrap();
        let from_url = plugin_install(unpacked.to_string_lossy().into_owned(), false, Some("https://github.com/me/repo".into())).unwrap();
        assert_eq!(from_url.source.as_deref(), Some("https://github.com/me/repo"));
        assert!(!staging_dir().unwrap().exists(), "staging is cleaned up");
        let _ = std::fs::remove_dir_all(&base);
    }
}
