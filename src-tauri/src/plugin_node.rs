//! Plugins that run in Node.js: VS Code extensions made for Node (most of
//! them) run in a Node process — node_host.cjs, with the vscode
//! compatibility layer — so their `fs`, `child_process`, `http` and npm
//! dependencies work, as in VS Code. Without Node installed they run in the
//! sandboxed worker instead (lib/plugins/host.ts decides).
//!
//! The host speaks the worker's protocol (JSON messages) over stdin and
//! stdout; this module relays them as `plugin:node` events
//! `{ id, message }` and sends the frontend's messages back down.

use crate::events::{emit, Events};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

const HOST: &str = include_str!("node_host.cjs");
const SHIM: &str = include_str!("vscode_shim.js");
const PREFIX: &str = "\u{1e}SABLE ";

struct NodePlugin {
    stdin: mpsc::UnboundedSender<String>,
    child: tokio::sync::Mutex<tokio::process::Child>,
}

static RUNNING: Mutex<Option<HashMap<String, std::sync::Arc<NodePlugin>>>> = Mutex::new(None);
/// Each start is a new instance; events carry it, so a stopped process's
/// last events (its exit) can't be mistaken for the new one's.
static INSTANCES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn node() -> Option<PathBuf> {
    crate::lsp::resolve_binary("node")
}

/// Whether Node.js is installed.
#[tauri::command]
pub fn plugin_node_available() -> bool {
    node().is_some()
}

/// The host and the compatibility layer, written beside the plugins.
fn runtime_dir() -> Result<PathBuf, String> {
    let plugins = crate::plugins::plugin_folder_root()?;
    let dir = plugins.join(".runtime");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    std::fs::write(dir.join("node_host.cjs"), HOST).map_err(|error| error.to_string())?;
    let shim = format!(
        "// Sable's VS Code compatibility layer, for the Node host.\nmodule.exports = (() => {{\n{SHIM}\nreturn {{ activate: __activate, activateNode: __activateNode, deactivate: __deactivate }};\n}})();\n"
    );
    std::fs::write(dir.join("vscode_shim.cjs"), shim).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// Start plugin `id` in Node; returns the instance its events carry.
pub async fn start(events: Events, id: String) -> Result<u64, String> {
    stop(&id).await;
    let instance = INSTANCES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let node = node().ok_or("Node.js isn't installed")?;
    let folder = crate::plugins::plugin_folder(&id)?;
    let host = runtime_dir()?.join("node_host.cjs");
    let mut child = Command::new(node)
        // Node's deprecation notices are about the extension's code, not
        // errors: keep them out of the plugin's log.
        .arg("--no-deprecation")
        .arg(host)
        .arg(&folder)
        .current_dir(&folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Couldn't start Node: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let (sender, mut outgoing) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = outgoing.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let log = move |events: &Events, id: &str, level: &str, text: String| {
        emit(events, "plugin:node", json!({ "id": id, "instance": instance, "message": { "type": "log", "level": level, "text": text } }));
    };
    {
        let events = events.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match line.strip_prefix(PREFIX).and_then(|json| serde_json::from_str::<Value>(json).ok()) {
                    Some(message) => emit(&events, "plugin:node", json!({ "id": id, "instance": instance, "message": message })),
                    // Something the extension printed itself.
                    None if !line.trim().is_empty() => log(&events, &id, "log", line),
                    None => {}
                }
            }
            emit(&events, "plugin:node", json!({ "id": id, "instance": instance, "message": { "type": "exit" } }));
        });
    }
    {
        let events = events.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log(&events, &id, "error", line);
            }
        });
    }
    RUNNING
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(id, std::sync::Arc::new(NodePlugin { stdin: sender, child: tokio::sync::Mutex::new(child) }));
    Ok(instance)
}

pub async fn stop(id: &str) {
    let running = RUNNING.lock().unwrap().get_or_insert_with(HashMap::new).remove(id);
    if let Some(plugin) = running {
        drop(plugin.stdin.clone());
        let mut child = plugin.child.lock().await;
        let _ = child.kill().await;
    }
}

#[tauri::command]
pub async fn plugin_node_start(app: AppHandle, id: String) -> Result<u64, String> {
    start(crate::events::for_app(&app), id).await
}

#[tauri::command]
pub fn plugin_node_send(id: String, message: String) -> Result<(), String> {
    let running = RUNNING.lock().unwrap();
    let plugin = running.as_ref().and_then(|running| running.get(&id)).ok_or_else(|| format!("{id} isn't running"))?;
    plugin.stdin.send(message).map_err(|_| format!("{id} stopped"))
}

#[tauri::command]
pub async fn plugin_node_stop(id: String) -> Result<(), String> {
    stop(&id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A converted Node extension, run by the real Node host with the
    /// worker bootstrap: its command uses Node's `fs` and the vscode API.
    #[tokio::test(flavor = "multi_thread")]
    async fn runs_a_node_extension() {
        if node().is_none() {
            eprintln!("Node.js isn't installed — skipped");
            return;
        }
        let base = std::env::temp_dir().join(format!("sable-node-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ext = base.join("ext");
        std::fs::create_dir_all(ext.join("out")).unwrap();
        std::fs::create_dir_all(ext.join("node_modules/greeting")).unwrap();
        std::fs::write(
            ext.join("package.json"),
            r#"{"name":"nodey","publisher":"t","version":"1.0.0","engines":{"vscode":"^1.80.0"},"main":"./out/extension.js",
               "contributes":{"commands":[{"command":"nodey.hello","title":"Hello"}]}}"#,
        )
        .unwrap();
        std::fs::write(ext.join("node_modules/greeting/index.js"), "module.exports = (name) => `hello ${name} from ${require('os').platform() ? 'node' : '?'}`;").unwrap();
        std::fs::write(
            ext.join("out/extension.js"),
            r#"const vscode = require('vscode'); const fs = require('fs'); const greet = require('greeting');
               exports.activate = (context) => {
                 context.subscriptions.push(vscode.commands.registerCommand('nodey.hello', () => {
                   const text = greet(fs.existsSync(__filename) ? 'file' : 'nofile');
                   vscode.window.showInformationMessage(text);
                   return text;
                 }));
               };"#,
        )
        .unwrap();
        let (_lock, _plugins) = crate::plugins::test_plugins_dir();
        let converted = base.join("converted");
        let manifest = crate::vscode::convert(&ext, &converted).unwrap();
        assert_eq!(manifest.runtime.as_deref(), Some("node"));
        assert!(manifest.permissions.contains(&"node".to_string()));
        let installed = crate::plugins::plugin_install(converted.to_string_lossy().into_owned(), false, None).unwrap();
        assert!(std::path::Path::new(&installed.path).join("extension/node_modules/greeting/index.js").exists(), "dependencies kept");

        let seen: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let sink = seen.clone();
        let events: Events = Arc::new(move |name, payload| {
            if name == "plugin:node" {
                sink.lock().unwrap().push(payload["message"].clone());
            }
        });
        start(events, manifest.id.clone()).await.unwrap();
        let send = |message: Value| plugin_node_send(manifest.id.clone(), message.to_string()).unwrap();
        // The worker bootstrap, minimal: it just has to drive the same protocol.
        send(json!({ "type": "bootstrap", "source": TEST_BOOTSTRAP }));
        send(json!({ "type": "init", "source": "", "manifest": manifest, "root": base, "sableVersion": "0.3.7" }));

        // Answer the extension's calls; wait for it to activate.
        let mut answered = 0;
        let mut activated = false;
        let mut handler = None;
        let mut message_shown = None;
        for _ in 0..200 {
            let messages: Vec<Value> = seen.lock().unwrap().drain(..).collect();
            for message in messages {
                match message["type"].as_str() {
                    Some("call") => {
                        let method = message["method"].as_str().unwrap_or("");
                        let value = match method {
                            "storage.keys" => json!([]),
                            "editor.active" => Value::Null,
                            "languages.getDiagnostics" => json!([]),
                            "commands.register" if message["args"][1] == "nodey.hello" => {
                                handler = message["args"][0].as_u64();
                                Value::Null
                            }
                            "window.showMessage" => {
                                message_shown = message["args"][0].as_str().map(str::to_string);
                                Value::Null
                            }
                            _ => Value::Null,
                        };
                        send(json!({ "type": "reply", "id": message["id"], "value": value }));
                        answered += 1;
                    }
                    Some("activated") => activated = true,
                    Some("failed") => panic!("activation failed: {}", message["error"]),
                    Some("return") => {
                        assert_eq!(message["value"], "hello file from node");
                    }
                    _ => {}
                }
            }
            if activated && handler.is_some() && message_shown.is_none() && answered > 0 {
                send(json!({ "type": "invoke", "id": 99, "handler": handler.unwrap(), "args": [] }));
                handler = None;
            }
            if message_shown.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        stop(&manifest.id).await;
        assert!(activated, "the extension didn't activate");
        assert_eq!(message_shown.as_deref(), Some("hello file from node"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The same protocol as the worker bootstrap, cut down for the test.
    const TEST_BOOTSTRAP: &str = r#"
(() => {
  let nextId = 1; const pending = new Map(); const handlers = new Map(); let plugin = null;
  const post = (m) => self.postMessage(m);
  const call = (method, ...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); post({ type: "call", id, method, args }); });
  const handler = (fn) => { const id = nextId++; handlers.set(id, fn); return id; };
  self.onmessage = async ({ data: m }) => {
    if (m.type === "reply") { const w = pending.get(m.id); pending.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.value); }
    else if (m.type === "invoke") { try { post({ type: "return", id: m.id, value: await handlers.get(m.handler)(...m.args) }); } catch (e) { post({ type: "return", id: m.id, error: String(e) }); } }
    else if (m.type === "init") {
      const api = {
        commands: { register: (id, title, run, options) => { const h = handler(run); call("commands.register", h, id, title, options); return { dispose() {} }; } },
        window: { showMessage: (t) => call("window.showMessage", t), showError: (t) => call("window.showError", t), showWarning: (t) => call("window.showWarning", t) },
        editor: { active: () => call("editor.active") },
        storage: { keys: () => call("storage.keys"), get: () => call("storage.get"), set: () => call("storage.set") },
        events: { onDidChange() {}, onDidSave() {}, onDidOpen() {}, onDidChangeActiveEditor() {}, onDidChangeSelection() {} },
        languages: { getDiagnostics: () => call("languages.getDiagnostics") },
        views: { declare: () => Promise.resolve() },
        workspace: { root: m.root },
      };
      try { plugin = await self.__sableImport(""); await plugin.activate(api); post({ type: "activated" }); }
      catch (e) { post({ type: "failed", error: e.stack || String(e) }); }
    }
  };
})();
"#;
}
