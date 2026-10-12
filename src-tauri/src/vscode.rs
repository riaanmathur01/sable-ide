//! Turning a VS Code extension into a Sable plugin.
//!
//! A `.vsix` is a zip with the extension under `extension/`. Its
//! package.json says what it is (name, version, commands, keybindings,
//! settings) and which module to run — `browser` (made for VS Code for the
//! Web, so it needs no Node) if it has one, else `main`. Sable writes a
//! plugin whose main.js is the compatibility layer (vscode_shim.js), every
//! JavaScript module of the extension wrapped as a CommonJS function, and a
//! call that loads the entry module with `require("vscode")` answered by
//! the layer. Extensions that only use the editor, commands, settings and
//! language features (completions, hovers, formatters, diagnostics) work;
//! ones that need Node (files outside the API, child processes, servers)
//! load, and say what's missing when they reach for it.

use crate::plugins::{Keybinding, Manifest};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SHIM: &str = include_str!("vscode_shim.js");
/// The extension's JavaScript, at most (the plugin loader's limit is 10 MB).
const MAX_SOURCES: usize = 9 * 1024 * 1024;
/// Folders never needed at run time.
const SKIP_DIRS: &[&str] = &[".git", "test", "tests", "__tests__", ".vscode", "coverage", ".bin", "docs", "images", "media", "src"];

/// Where a downloaded/unpacked VS Code extension's files are: the
/// `extension/` folder of a vsix, or a folder that is the extension.
pub fn extension_root(folder: &Path) -> Option<PathBuf> {
    [folder.join("extension"), folder.to_path_buf()]
        .into_iter()
        .find(|candidate| is_extension(candidate))
}

fn is_extension(folder: &Path) -> bool {
    std::fs::read_to_string(folder.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|package| package.pointer("/engines/vscode").is_some())
}

/// `publisher.name` → a Sable plugin id.
fn plugin_id(publisher: &str, name: &str) -> String {
    let raw = format!("vscode.{publisher}.{name}").to_lowercase();
    let mut id: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '-' }).collect();
    while id.contains("..") {
        id = id.replace("..", ".");
    }
    id.chars().take(64).collect::<String>().trim_end_matches(['.', '-']).to_string()
}

/// "1.2.3-beta.1" → "1.2.3"; "2.0" → "2.0.0".
fn plain_version(version: &str) -> String {
    let core = version.split(['-', '+']).next().unwrap_or("0.0.0");
    let mut parts: Vec<u64> = core.split('.').map(|part| part.parse().unwrap_or(0)).collect();
    parts.resize(3, 0);
    format!("{}.{}.{}", parts[0], parts[1], parts[2])
}

/// `%key%` strings in package.json come from package.nls.json.
fn localize(value: &str, nls: &Value) -> String {
    match value.strip_prefix('%').and_then(|rest| rest.strip_suffix('%')) {
        Some(key) => nls
            .get(key)
            .and_then(|entry| entry.as_str().or_else(|| entry.get("message").and_then(Value::as_str)))
            .unwrap_or(value)
            .to_string(),
        None => value.to_string(),
    }
}

fn localize_all(value: &mut Value, nls: &Value) {
    match value {
        Value::String(text) if text.starts_with('%') && text.ends_with('%') && text.len() > 2 => *text = localize(text, nls),
        Value::Array(items) => items.iter_mut().for_each(|item| localize_all(item, nls)),
        Value::Object(map) => map.values_mut().for_each(|item| localize_all(item, nls)),
        _ => {}
    }
}

/// The extension's settings and their defaults ("myExt.option" → value).
fn configuration_defaults(package: &Value) -> BTreeMap<String, Value> {
    let mut defaults = BTreeMap::new();
    let sections: Vec<&Value> = match package.pointer("/contributes/configuration") {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(section @ Value::Object(_)) => vec![section],
        _ => Vec::new(),
    };
    for section in sections {
        if let Some(Value::Object(properties)) = section.get("properties") {
            for (key, property) in properties {
                defaults.insert(key.clone(), property.get("default").cloned().unwrap_or(Value::Null));
            }
        }
    }
    defaults
}

/// Languages the extension adds (with their language-configuration.json),
/// and TextMate grammars (JSON ones) for them.
fn contributed_languages(root: &Path, package: &Value, nls: &Value) -> (Vec<Value>, Vec<Value>) {
    let read_json = |relative: &str| -> Option<Value> {
        let path = root.join(relative.trim_start_matches("./"));
        let text = std::fs::read_to_string(path).ok()?;
        crate::devcontainer::parse_jsonc(&text).ok()
    };
    let languages = match package.pointer("/contributes/languages") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|language| {
                let id = language.get("id")?.as_str()?;
                let aliases: Vec<String> = language
                    .get("aliases")
                    .and_then(Value::as_array)
                    .map(|aliases| aliases.iter().filter_map(Value::as_str).map(|alias| localize(alias, nls)).collect())
                    .unwrap_or_default();
                Some(json!({
                    "id": id,
                    "extensions": language.get("extensions").cloned().unwrap_or(json!([])),
                    "filenames": language.get("filenames").cloned().unwrap_or(json!([])),
                    "aliases": aliases,
                    "configuration": language.get("configuration").and_then(Value::as_str).and_then(read_json),
                }))
            })
            .collect(),
        _ => Vec::new(),
    };
    let grammars = match package.pointer("/contributes/grammars") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|grammar| {
                let language = grammar.get("language")?.as_str()?;
                let path = grammar.get("path")?.as_str()?;
                // JSON grammars only (plist/YAML ones aren't read yet).
                if !path.ends_with(".json") {
                    return None;
                }
                Some(json!({ "language": language, "grammar": read_json(path)? }))
            })
            .collect(),
        _ => Vec::new(),
    };
    (languages, grammars)
}

/// The module file for `main`/`browser` ("./out/extension" → "out/extension.js").
fn entry_module(root: &Path, entry: &str) -> Option<String> {
    let clean = entry.trim_start_matches("./").trim_start_matches('/');
    [clean.to_string(), format!("{clean}.js"), format!("{clean}.cjs"), format!("{clean}/index.js")]
        .into_iter()
        .find(|candidate| root.join(candidate).is_file())
}

/// Every .js/.cjs/.json module under the extension, as relative paths.
fn collect_modules(root: &Path) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    let mut total = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                // "src" is skipped only at the top (compiled code is in out/ or dist/).
                let top = dir == root;
                if !(SKIP_DIRS.contains(&name.as_str()) && (top || name != "src")) {
                    stack.push(path);
                }
                continue;
            }
            let wanted = name.ends_with(".js") || name.ends_with(".cjs") || name.ends_with(".json");
            if !wanted || name.ends_with(".min.js.map") || name == "package-lock.json" || name.ends_with(".d.ts") {
                continue;
            }
            let size = entry.metadata().map(|metadata| metadata.len() as usize).unwrap_or(0);
            total += size;
            if total > MAX_SOURCES {
                return Err("The extension's code is too large for a Sable plugin (over 9 MB)".into());
            }
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?.to_string_lossy().replace('\\', "/");
            found.push(relative);
        }
    }
    found.sort();
    Ok(found)
}

/// The extension's files, for Node (at most 300 MB).
fn copy_extension(from: &Path, to: &Path) -> Result<(), String> {
    const MAX_BYTES: u64 = 300 * 1024 * 1024;
    fn walk(from: &Path, to: &Path, total: &mut u64) -> Result<(), String> {
        std::fs::create_dir_all(to).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(from).map_err(|error| error.to_string())?.flatten() {
            let name = entry.file_name();
            if name == ".git" {
                continue;
            }
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                walk(&entry.path(), &to.join(&name), total)?;
            } else if kind.is_file() {
                *total += entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                if *total > MAX_BYTES {
                    return Err("The extension is too large to install (over 300 MB)".into());
                }
                std::fs::copy(entry.path(), to.join(&name)).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
    walk(from, to, &mut 0)
}

/// Whether a module is an ES module (import/export at the top level),
/// which the CommonJS loader can't run.
fn is_es_module(source: &str) -> bool {
    source.lines().any(|line| {
        let line = line.trim_start();
        (line.starts_with("import ") && (line.contains(" from ") || line.ends_with(';') || line.starts_with("import {")))
            || line.starts_with("export ")
            || line.starts_with("export{")
    })
}

/// Convert the extension at `root` into a Sable plugin in `out`.
pub fn convert(root: &Path, out: &Path) -> Result<Manifest, String> {
    let mut package: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("package.json")).map_err(|error| format!("The extension has no package.json: {error}"))?,
    )
    .map_err(|error| format!("The extension's package.json is invalid: {error}"))?;
    let nls: Value = std::fs::read_to_string(root.join("package.nls.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    // "%key%" strings anywhere (view names, setting descriptions…) → words.
    localize_all(&mut package, &nls);
    let text = |key: &str| package.get(key).and_then(Value::as_str).map(|value| localize(value, &nls)).unwrap_or_default();

    let publisher = text("publisher");
    let name = text("name");
    if name.is_empty() {
        return Err("The extension's package.json has no name".into());
    }
    let display_name = Some(text("displayName")).filter(|value| !value.is_empty()).unwrap_or_else(|| name.clone());
    let version = plain_version(&text("version"));
    let themes = crate::vscode_theme::contributed_themes(root, &package, &plugin_id(&publisher, &name));

    let entry_field = package.get("browser").and_then(Value::as_str).or_else(|| package.get("main").and_then(Value::as_str));
    let Some(entry_field) = entry_field else {
        if themes.is_empty() {
            return Err(format!(
                "{display_name} has no code to run and no color themes (it only adds grammars, snippets or icons, which Sable doesn't import yet)"
            ));
        }
        return convert_themes(root, out, &package, &nls, themes);
    };
    let entry = entry_module(root, entry_field).ok_or_else(|| format!("{display_name}'s code ({entry_field}) isn't in the package"))?;
    // `main` is what VS Code on the desktop runs, in Node: Sable does the
    // same when Node.js is installed (the extension folder kept as is,
    // dependencies and all). The sandbox runs the `browser` build if there
    // is one (made for VS Code for the Web), else `main` as far as it can.
    let node_entry = package.get("main").and_then(Value::as_str).and_then(|main| entry_module(root, main));

    let (languages, grammars) = contributed_languages(root, &package, &nls);

    // Commands shown in the palette, by id → title.
    let mut commands = serde_json::Map::new();
    if let Some(Value::Array(list)) = package.pointer("/contributes/commands") {
        for command in list {
            if let Some(id) = command.get("command").and_then(Value::as_str) {
                let title = localize(command.get("title").and_then(Value::as_str).unwrap_or(id), &nls);
                let category = command.get("category").and_then(Value::as_str).map(|category| localize(category, &nls));
                let shown = match category {
                    Some(category) if category != display_name => format!("{category}: {title}"),
                    _ => title,
                };
                commands.insert(id.to_string(), json!(shown));
            }
        }
    }
    let keybindings: Vec<Keybinding> = match package.pointer("/contributes/keybindings") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|binding| {
                let command = binding.get("command")?.as_str()?;
                let key = binding.get("key")?.as_str()?;
                commands.contains_key(command).then(|| Keybinding {
                    command: command.to_string(),
                    key: key.to_string(),
                    mac: binding.get("mac").and_then(Value::as_str).map(str::to_string),
                })
            })
            .collect(),
        _ => Vec::new(),
    };

    // The modules, each wrapped as a CommonJS function.
    // (Too big for the sandbox is fine when Node runs it.)
    let modules = match collect_modules(root) {
        Ok(modules) => modules,
        Err(_) if node_entry.is_some() => Vec::new(),
        Err(error) => return Err(error),
    };
    let sandbox_fits = !modules.is_empty() || node_entry.is_none();
    let mut uses_network = false;
    let mut bundle = String::with_capacity(SHIM.len() + 1024 * 1024);
    bundle.push_str("// Converted from a VS Code extension by Sable (see README.md).\n");
    bundle.push_str("const __sableVscode = (() => {\n");
    bundle.push_str(SHIM);
    bundle.push_str("\nreturn { activate: __activate, deactivate: __deactivate };\n})();\n\n");
    bundle.push_str("const __modules = {\n");
    for module in &modules {
        let source = std::fs::read_to_string(root.join(module)).unwrap_or_default();
        let key = serde_json::to_string(module).map_err(|error| error.to_string())?;
        if module.ends_with(".json") {
            // Only valid JSON (some .json files are comments-allowed configs).
            if serde_json::from_str::<Value>(&source).is_ok() {
                bundle.push_str(&format!("{key}: function (module) {{ module.exports = {source}; }},\n"));
            }
            continue;
        }
        if module == &entry && is_es_module(&source) {
            return Err(format!(
                "{display_name} is built as an ES module; Sable converts extensions built as CommonJS (most are)"
            ));
        }
        if source.contains("fetch(") || source.contains("XMLHttpRequest") {
            uses_network = true;
        }
        let body = source.strip_prefix("#!").map(|rest| rest.split_once('\n').map(|(_, body)| body).unwrap_or("")).unwrap_or(&source);
        bundle.push_str(&format!(
            "{key}: function (module, exports, require, __filename, __dirname) {{\n{body}\n}},\n"
        ));
    }
    bundle.push_str("};\n\n");
    let extension = json!({
        "id": format!("{publisher}.{name}"),
        "name": display_name,
        "entry": entry,
        "commands": commands,
        "configuration": configuration_defaults(&package),
        "languages": languages,
        "grammars": grammars,
        // All of it: extensions read their own fields (repository, version…).
        "packageJSON": package,
    });
    bundle.push_str(&format!("const __extension = {};\n\n", serde_json::to_string(&extension).map_err(|error| error.to_string())?));
    if sandbox_fits {
        bundle.push_str("/** @param {any} sable */\nexport async function activate(sable) {\n  await __sableVscode.activate(sable, __modules, __extension);\n}\n\n");
    } else {
        bundle.push_str("export async function activate() {\n  throw new Error(\"This extension needs Node.js: install it (nodejs.org) and reload the plugin.\");\n}\n\n");
    }
    bundle.push_str("export async function deactivate() {\n  await __sableVscode.deactivate();\n}\n");

    let mut permissions = vec!["editor".to_string(), "workspace:read".to_string(), "workspace:write".to_string()];
    if node_entry.is_some() {
        // Node extensions have the run of the computer, as in VS Code.
        permissions.insert(0, "node".to_string());
    } else {
        if uses_network {
            permissions.push("network".to_string());
        }
        if modules.iter().any(|module| std::fs::read_to_string(root.join(module)).is_ok_and(|source| source.contains("createTerminal"))) {
            permissions.push("shell".to_string());
        }
    }
    let description = text("description");
    let repository = match package.get("repository") {
        Some(Value::String(url)) => Some(url.clone()),
        Some(Value::Object(repository)) => repository.get("url").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
    .map(|url| url.trim_start_matches("git+").trim_end_matches(".git").to_string())
    .filter(|url| url.starts_with("https://"));
    let manifest = Manifest {
        id: plugin_id(&publisher, &name),
        name: display_name.clone(),
        version: version.clone(),
        description: if description.is_empty() { format!("{display_name}, converted from VS Code") } else { description.clone() },
        author: publisher.clone(),
        main: "main.js".into(),
        permissions,
        min_sable_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        homepage: repository,
        keybindings,
        runtime: node_entry.as_ref().map(|_| "node".to_string()),
        themes: themes.iter().map(|(contribution, _)| contribution.clone()).collect(),
    };

    std::fs::create_dir_all(out).map_err(|error| error.to_string())?;
    std::fs::write(out.join("main.js"), bundle).map_err(|error| error.to_string())?;
    write_themes(out, &themes)?;
    if let Some(node_entry) = &node_entry {
        // The extension as shipped, for the Node host (src/plugin_node.rs).
        copy_extension(root, &out.join("extension"))?;
        let mut node_extension = extension.clone();
        node_extension["nodeEntry"] = json!(format!("extension/{node_entry}"));
        std::fs::write(out.join("extension.json"), serde_json::to_string(&node_extension).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    std::fs::write(
        out.join(crate::plugins::MANIFEST_FILE),
        serde_json::to_string_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    copy_licenses(root, out);
    let command_list: String = commands
        .values()
        .filter_map(Value::as_str)
        .map(|title| format!("- {display_name}: {title}\n"))
        .collect();
    let original = std::fs::read_to_string(root.join("README.md")).unwrap_or_default();
    let readme = format!(
        "> Converted from the VS Code extension **{publisher}.{name}** {} by Sable. \
         It runs through Sable's VS Code compatibility layer{}.\n\n{}{}",
        text("version"),
        if node_entry.is_some() { ", in Node.js as in VS Code" } else { ", in Sable's sandbox" },
        if command_list.is_empty() { String::new() } else { format!("Commands (⇧⌘P):\n\n{command_list}\n") },
        original
    );
    std::fs::write(out.join("README.md"), readme).map_err(|error| error.to_string())?;
    Ok(manifest)
}

/// Licenses travel with what's converted.
fn copy_licenses(root: &Path, out: &Path) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.to_uppercase().starts_with("LICENSE") || file.to_uppercase().starts_with("LICENCE") {
                let _ = std::fs::copy(entry.path(), out.join(&file));
            }
        }
    }
}

fn write_themes(out: &Path, themes: &[(crate::plugins::ThemeContribution, Value)]) -> Result<(), String> {
    for (contribution, theme) in themes {
        let file = out.join(&contribution.path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&file, serde_json::to_string_pretty(theme).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// A theme extension (no code): a plugin of its themes alone.
fn convert_themes(
    root: &Path,
    out: &Path,
    package: &Value,
    nls: &Value,
    themes: Vec<(crate::plugins::ThemeContribution, Value)>,
) -> Result<Manifest, String> {
    let text = |key: &str| package.get(key).and_then(Value::as_str).map(|value| localize(value, nls)).unwrap_or_default();
    let (publisher, name) = (text("publisher"), text("name"));
    let display_name = Some(text("displayName")).filter(|value| !value.is_empty()).unwrap_or_else(|| name.clone());
    let description = text("description");
    let repository = match package.get("repository") {
        Some(Value::String(url)) => Some(url.clone()),
        Some(Value::Object(repository)) => repository.get("url").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
    .map(|url| url.trim_start_matches("git+").trim_end_matches(".git").to_string())
    .filter(|url| url.starts_with("https://"));
    let manifest = Manifest {
        id: plugin_id(&publisher, &name),
        name: display_name.clone(),
        version: plain_version(&text("version")),
        description: if description.is_empty() { format!("{display_name} color themes, from VS Code") } else { description },
        author: publisher.clone(),
        main: String::new(),
        permissions: Vec::new(),
        min_sable_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        homepage: repository,
        keybindings: Vec::new(),
        runtime: None,
        themes: themes.iter().map(|(contribution, _)| contribution.clone()).collect(),
    };
    std::fs::create_dir_all(out).map_err(|error| error.to_string())?;
    write_themes(out, &themes)?;
    // No "main": the manifest says it has no code.
    let mut written = serde_json::to_value(&manifest).map_err(|error| error.to_string())?;
    written.as_object_mut().map(|object| object.remove("main"));
    std::fs::write(out.join(crate::plugins::MANIFEST_FILE), serde_json::to_string_pretty(&written).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    copy_licenses(root, out);
    let theme_list: String = themes.iter().map(|(contribution, _)| format!("- {}\n", contribution.label)).collect();
    let original = std::fs::read_to_string(root.join("README.md")).unwrap_or_default();
    let readme = format!(
        "> Converted from the VS Code extension **{publisher}.{name}** {} by Sable. \
         Choose a theme in Settings → Editor Appearance → Color Theme, or with \"Color Theme: …\" in the command palette (⇧⌘P).\n\n\
         Themes:\n\n{theme_list}\n{original}",
        text("version"),
    );
    std::fs::write(out.join("README.md"), readme).map_err(|error| error.to_string())?;
    Ok(manifest)
}

/// What to download for a VS Code extension reference, via Open VSX (the
/// open registry VS Code-compatible editors use): `publisher.name`, an
/// open-vsx.org link, or a Marketplace link (looked up on Open VSX).
pub fn open_vsx_reference(text: &str) -> Option<(String, String)> {
    let text = text.trim();
    let id = if let Some(rest) = text.strip_prefix("https://open-vsx.org/extension/") {
        let mut parts = rest.split('/');
        format!("{}.{}", parts.next()?, parts.next()?)
    } else if text.starts_with("https://marketplace.visualstudio.com/") {
        text.split("itemName=").nth(1)?.split('&').next()?.to_string()
    } else if text.starts_with("vscode:") {
        text.trim_start_matches("vscode:").trim_start_matches("extension/").to_string()
    } else {
        text.to_string()
    };
    let (publisher, name) = id.split_once('.')?;
    let valid = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (valid(publisher) && valid(name) && !text.contains(' ') && (text.contains('/') || !text.contains(':')) && !text.ends_with(".vsix"))
        .then(|| (publisher.to_string(), name.to_string()))
}

/// The download URL of an extension's latest .vsix on Open VSX.
pub async fn open_vsx_download(publisher: &str, name: &str) -> Result<String, String> {
    let url = format!("https://open-vsx.org/api/{publisher}/{name}");
    let response = reqwest::get(&url).await.map_err(|error| format!("Couldn't reach Open VSX: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "{publisher}.{name} isn't on Open VSX. Download its .vsix (e.g. from the VS Code Marketplace page's \"Download Extension\") and convert that file instead."
        ));
    }
    let info: Value = response
        .error_for_status()
        .map_err(|error| format!("Open VSX: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Open VSX: {error}"))?;
    info.pointer("/files/download")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Open VSX has no download for {publisher}.{name}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references() {
        assert_eq!(open_vsx_reference("wmaurer.change-case"), Some(("wmaurer".into(), "change-case".into())));
        assert_eq!(open_vsx_reference("https://open-vsx.org/extension/Tyriar/sort-lines"), Some(("Tyriar".into(), "sort-lines".into())));
        assert_eq!(
            open_vsx_reference("https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode&ssr=false"),
            Some(("esbenp".into(), "prettier-vscode".into()))
        );
        assert_eq!(open_vsx_reference("https://github.com/someone/plugin"), None);
        assert_eq!(open_vsx_reference("/Users/me/thing.vsix"), None);
        assert_eq!(open_vsx_reference("my plugin.zip"), None);
        assert_eq!(plugin_id("Tyriar", "sort-lines"), "vscode.tyriar.sort-lines");
        assert_eq!(plain_version("1.2.3-beta.4"), "1.2.3");
        assert_eq!(plain_version("2.0"), "2.0.0");
    }

    #[test]
    fn converts_an_extension() {
        let base = std::env::temp_dir().join(format!("sable-vscode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("extension");
        std::fs::create_dir_all(root.join("out")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/left-pad")).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"shout","publisher":"Acme","displayName":"%display%","version":"1.4.0-pre","engines":{"vscode":"^1.80.0"},
               "main":"./out/extension","contributes":{"commands":[{"command":"shout.upper","title":"Shout","category":"Text"}],
               "keybindings":[{"command":"shout.upper","key":"ctrl+alt+u","mac":"cmd+alt+u"},{"command":"other","key":"x"}],
               "configuration":{"properties":{"shout.suffix":{"type":"string","default":"!"}}}}}"#,
        )
        .unwrap();
        std::fs::write(root.join("package.nls.json"), r#"{"display":"Shout It"}"#).unwrap();
        std::fs::write(root.join("out/extension.js"), "const vscode = require('vscode');\nconst pad = require('left-pad');\nexports.activate = () => {};\n").unwrap();
        std::fs::write(root.join("node_modules/left-pad/package.json"), r#"{"main":"index.js"}"#).unwrap();
        std::fs::write(root.join("node_modules/left-pad/index.js"), "module.exports = (s) => s;").unwrap();
        std::fs::write(root.join("LICENSE"), "MIT").unwrap();

        assert_eq!(extension_root(&base), Some(root.clone()));
        let out = base.join("plugin");
        let manifest = convert(&root, &out).unwrap();
        assert_eq!(manifest.id, "vscode.acme.shout");
        assert_eq!(manifest.name, "Shout It");
        assert_eq!(manifest.version, "1.4.0");
        assert_eq!(manifest.keybindings, vec![Keybinding { command: "shout.upper".into(), key: "ctrl+alt+u".into(), mac: Some("cmd+alt+u".into()) }]);
        let main = std::fs::read_to_string(out.join("main.js")).unwrap();
        assert!(main.contains("\"out/extension.js\": function (module, exports, require, __filename, __dirname)"));
        assert!(main.contains("\"node_modules/left-pad/index.js\""));
        assert!(main.contains(r#""shout.upper":"Text: Shout""#));
        assert!(main.contains(r#""shout.suffix":"!""#));
        assert!(main.contains("export async function activate(sable)"));
        assert!(out.join("LICENSE").exists());
        assert!(std::fs::read_to_string(out.join("README.md")).unwrap().contains("Acme.shout"));
        // The result is a valid Sable plugin.
        assert_eq!(crate::plugins::read_manifest(&out).unwrap().id, "vscode.acme.shout");
        let _ = std::fs::remove_dir_all(&base);
    }
}
