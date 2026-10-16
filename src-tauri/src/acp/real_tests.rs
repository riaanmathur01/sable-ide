//! Against the real Claude Agent (claude-agent-acp from the live registry),
//! installed for real with npm. Network and Node 22+ needed; ignored by
//! default:
//!
//!   cargo test --lib acp::real_tests -- --ignored --nocapture
//!
//! It never prompts the model: initialize, the auth methods, the account
//! status command and session/new only (no tokens are used), and it runs
//! the adapter the way Sable does, with `--hide-claude-auth`.
//!
//! `real_claude_code_cli` checks Claude Code (the user's own `claude`):
//! discovery, `claude --version`, `claude auth status`, the adapter's
//! initialize + session/new, and that headless `claude -p` (stream-json)
//! starts and exits cleanly when its input closes — again with no prompt.

use super::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

async fn wait_for_line(seen: &Arc<Mutex<Vec<Value>>>, id: u64, secs: u64) -> Value {
    for _ in 0..secs * 20 {
        if let Some(found) = seen.lock().unwrap().iter().find(|message| message["id"] == id) {
            return found.clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no answer to request {id}; got {:?}", seen.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "installs claude-agent-acp from npm and runs it (no prompts)"]
async fn real_claude_agent_handshake() {
    let root = std::env::var_os("SABLE_REAL_AGENTS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sable-real-agents"));
    let text = reqwest::get(registry::REGISTRY_URL).await.unwrap().text().await.unwrap();
    let registry = registry::parse(&text).unwrap();
    let entry = registry.agents.iter().find(|agent| agent.id == "claude-acp").expect("claude-acp in the registry").clone();
    let installed = match install::read(&root, "claude-acp").filter(|agent| agent.version == entry.version) {
        Some(agent) => agent,
        None => {
            let progress = |message: &str, _: Option<f64>| eprintln!("install: {message}");
            install::install(&root, &entry, registry::platform().as_deref(), &progress).await.unwrap()
        }
    };
    eprintln!("installed {} {} at {} (node: {})", installed.name, installed.version, installed.program, installed.node);
    assert!(installed.node, "an npm package runs with Node");

    // The environment Sable builds for the default method (Console login).
    let built = env::build("claude-acp", &env::AgentConfig::default(), &|_| None).unwrap();
    assert_eq!(built.args, vec!["--hide-claude-auth"]);

    // The account check Settings runs.
    let status_args = env::providers("claude-acp")[0].account.clone().unwrap().status.unwrap();
    let status = process::exec(
        process::launch_spec(&installed, &process::SpawnRequest { agent_id: "claude-acp".into(), env: built.env.clone(), unset: built.unset.clone(), args: Some(status_args), ..Default::default() }).unwrap(),
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    eprintln!("auth status: {}", status["stdout"].as_str().unwrap_or("").trim());
    let parsed: Value = serde_json::from_str(status["stdout"].as_str().unwrap().trim()).expect("auth status prints JSON");
    assert!(parsed.get("loggedIn").is_some());

    // The ACP handshake, as the panel does it.
    let workspace = std::env::temp_dir().join(format!("sable-real-ws-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).unwrap();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = seen.clone();
    let events: crate::events::Events = Arc::new(move |name, payload| {
        if name == process::MESSAGE {
            if let Ok(message) = serde_json::from_str::<Value>(payload["line"].as_str().unwrap_or("")) {
                sink.lock().unwrap().push(message);
            }
        } else if name == process::STDERR {
            eprintln!("agent stderr: {}", payload["line"]);
        }
    });
    let state = AcpState::default();
    let request = process::SpawnRequest {
        agent_id: "claude-acp".into(),
        cwd: Some(workspace.to_string_lossy().into_owned()),
        env: built.env,
        unset: built.unset,
        args: None,
        extra_args: built.args,
        files: built.files,
    };
    let instance = process::spawn(events, &state.processes, process::launch_spec(&installed, &request).unwrap()).await.unwrap();
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true, "auth": { "terminal": true },
                "session": { "configOptions": { "boolean": {} }, "notices": {}, "compaction": {} },
                "elicitation": { "form": {}, "url": {} },
                "_meta": { "terminal_output": true, "terminal-auth": true }
            },
            "clientInfo": { "name": "sable", "title": "Sable", "version": "0.4.0" }
        }
    });
    process::send(&state.processes, instance, initialize.to_string()).unwrap();
    let answer = wait_for_line(&seen, 1, 60).await;
    eprintln!("initialize → {}", serde_json::to_string_pretty(&answer["result"]["authMethods"]).unwrap());
    assert_eq!(answer["result"]["protocolVersion"], 1);
    let methods: Vec<&str> = answer["result"]["authMethods"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect();
    assert!(methods.contains(&"console-login"), "the Console login is offered: {methods:?}");
    assert!(!methods.contains(&"claude-ai-login"), "no claude.ai subscription login with --hide-claude-auth: {methods:?}");

    let new_session = json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": workspace, "mcpServers": [] } });
    process::send(&state.processes, instance, new_session.to_string()).unwrap();
    let session = wait_for_line(&seen, 2, 90).await;
    eprintln!("session/new → {}", serde_json::to_string(&session).unwrap().chars().take(600).collect::<String>());
    if let Some(error) = session.get("error") {
        // A claude.ai-only login is refused here: what the panel shows as sign-in.
        eprintln!("session/new refused: {error}");
        assert_eq!(error["code"], -32000, "{error}");
    } else {
        let options: Vec<&str> = session["result"]["configOptions"].as_array().unwrap().iter().filter_map(|o| o["category"].as_str()).collect();
        eprintln!("config option categories: {options:?}");
        assert!(session["result"]["sessionId"].is_string());
    }
    let notifications: Vec<String> = seen.lock().unwrap().iter().filter_map(|m| m["method"].as_str().map(str::to_string)).collect();
    eprintln!("notifications: {notifications:?}");
    state.shutdown().await;
    let _ = std::fs::remove_dir_all(&workspace);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the user's installed claude CLI (no prompts)"]
async fn real_claude_code_cli() {
    let Some(claude) = claude_code::find() else {
        eprintln!("no claude CLI found — skipped");
        return;
    };
    eprintln!("found claude at {}", claude.display());
    let version = std::process::Command::new(&claude).arg("--version").output().unwrap();
    let version = String::from_utf8_lossy(&version.stdout).to_string();
    eprintln!("claude --version: {}", version.trim());
    assert!(version.contains("Claude Code"));
    let root = std::env::temp_dir().join(format!("sable-real-cc-{}", std::process::id()));
    let agent = install::read(&root, claude_code::ID).expect("Claude Code shows as installed");
    assert_eq!(agent.kind, "cli");

    // The account status (what Settings shows), through the adapter's --cli.
    let built = env::build(claude_code::ID, &env::AgentConfig::default(), &|_| None).unwrap();
    assert!(built.env.is_empty() && built.args.is_empty(), "no auth environment or flags: {built:?}");
    let status_args = env::providers(claude_code::ID)[0].account.clone().unwrap().status.unwrap();
    let request = process::SpawnRequest { agent_id: claude_code::ID.into(), args: Some(status_args), unset: built.unset.clone(), ..Default::default() };
    let status = process::exec(process::launch_spec(&agent, &request).unwrap(), Duration::from_secs(30)).await.unwrap();
    let stdout = status["stdout"].as_str().unwrap_or("").to_string();
    let parsed: Value = serde_json::from_str(&stdout[stdout.find('{').unwrap_or(0)..]).expect("auth status JSON");
    eprintln!("auth status: loggedIn={} authMethod={}", parsed["loggedIn"], parsed["authMethod"]);

    // The adapter: initialize and session/new (it checks sign-in; no prompt).
    let workspace = std::env::temp_dir().join(format!("sable-real-cc-ws-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).unwrap();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = seen.clone();
    let events: crate::events::Events = Arc::new(move |name, payload| {
        if name == process::MESSAGE {
            if let Ok(message) = serde_json::from_str::<Value>(payload["line"].as_str().unwrap_or("")) {
                sink.lock().unwrap().push(message);
            }
        }
    });
    let state = AcpState::default();
    let spawn = process::SpawnRequest { agent_id: claude_code::ID.into(), cwd: Some(workspace.to_string_lossy().into_owned()), unset: built.unset, ..Default::default() };
    let instance = process::spawn(events, &state.processes, process::launch_spec(&agent, &spawn).unwrap()).await.unwrap();
    process::send(&state.processes, instance, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "clientCapabilities": { "auth": { "terminal": true }, "fs": { "readTextFile": true, "writeTextFile": true } } } }).to_string()).unwrap();
    let hello = wait_for_line(&seen, 1, 30).await;
    eprintln!("initialize → authMethods {}", hello["result"]["authMethods"]);
    assert_eq!(hello["result"]["authMethods"][0]["id"], "claude-code-login");
    process::send(&state.processes, instance, json!({ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": workspace, "mcpServers": [] } }).to_string()).unwrap();
    let session = wait_for_line(&seen, 2, 60).await;
    eprintln!("session/new → {}", serde_json::to_string(&session).unwrap().chars().take(300).collect::<String>());
    if parsed["loggedIn"] == true {
        assert!(session["result"]["sessionId"].is_string(), "{session}");
    } else {
        assert_eq!(session["error"]["code"], -32000);
    }
    state.shutdown().await;

    // Headless claude starts and waits for input; closing its input ends it.
    let mut child = tokio::process::Command::new(&claude)
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .current_dir(&workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(child.try_wait().unwrap().is_none(), "headless claude is up, waiting for a message");
    drop(child.stdin.take());
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output()).await.unwrap().unwrap();
    eprintln!("headless claude exited {:?}; stdout {} bytes (no prompt was sent)", output.status.code(), output.stdout.len());
    assert!(output.status.success());
    let _ = std::fs::remove_dir_all(&workspace);
    let _ = std::fs::remove_dir_all(&root);
}

// --- Codex, Kimi Code, Cursor ----------------------------------------------------------------------
//
//   cargo test --lib acp::real_tests::real_codex -- --ignored --nocapture
//
// Each installs the real agent the way Sable does (into a temp folder, or
// SABLE_REAL_AGENTS_DIR to reuse one), runs it with a temp HOME and config
// folder — never the user's own logins — and checks initialize, its sign-in
// methods and session/new, signed out and with the environment Sable builds
// for its other methods. No prompt is ever sent.

fn real_root() -> std::path::PathBuf {
    std::env::var_os("SABLE_REAL_AGENTS_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("sable-real-agents"))
}

/// The live registry (with Sable's own entries), and `id` installed from it.
async fn real_install(id: &str) -> install::InstalledAgent {
    let root = real_root();
    let text = reqwest::get(registry::REGISTRY_URL).await.unwrap().text().await.unwrap();
    let registry = registry::with_extras(registry::parse(&text).unwrap(), registry::EXTRA);
    let entry = registry.agents.iter().find(|agent| agent.id == id).unwrap_or_else(|| panic!("{id} in the registry")).clone();
    if let Some(agent) = install::read(&root, id).filter(|agent| agent.version == entry.version) {
        return agent;
    }
    let progress = |message: &str, _: Option<f64>| eprintln!("install {id}: {message}");
    let installed = install::install(&root, &entry, registry::platform().as_deref(), &progress).await.unwrap();
    eprintln!("installed {} {} at {}", installed.name, installed.version, installed.program);
    installed
}

/// A temp HOME (and the like) for one run.
fn sandbox(name: &str) -> (std::path::PathBuf, std::collections::BTreeMap<String, String>) {
    let dir = std::env::temp_dir().join(format!("sable-real-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::create_dir_all(dir.join("ws")).unwrap();
    let home = dir.join("home").to_string_lossy().into_owned();
    let env = std::collections::BTreeMap::from([("HOME".to_string(), home.clone()), ("USERPROFILE".to_string(), home)]);
    (dir, env)
}

/// Start the agent (through `launch`, so Sable's config files are written),
/// initialize it as Sable does, optionally authenticate, then session/new.
async fn real_session(root: &std::path::Path, request: process::SpawnRequest, workspace: &std::path::Path, authenticate: Option<&str>) -> (Value, Option<Value>, Value) {
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = seen.clone();
    let events: crate::events::Events = Arc::new(move |name, payload| {
        if name == process::MESSAGE {
            if let Ok(message) = serde_json::from_str::<Value>(payload["line"].as_str().unwrap_or("")) {
                sink.lock().unwrap().push(message);
            }
        }
    });
    let state = AcpState::default();
    let spec = launch(root, &request).unwrap();
    let instance = process::spawn(events, &state.processes, spec).await.unwrap();
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true, "auth": { "terminal": true },
                "session": { "configOptions": { "boolean": {} }, "notices": {}, "compaction": {} },
                "elicitation": { "form": {}, "url": {} },
                "_meta": { "terminal_output": true, "terminal-auth": true }
            },
            "clientInfo": { "name": "sable", "title": "Sable", "version": "0.4.0" }
        }
    });
    process::send(&state.processes, instance, initialize.to_string()).unwrap();
    let init = wait_for_line(&seen, 1, 120).await;
    let auth = match authenticate {
        Some(method) => {
            process::send(&state.processes, instance, json!({ "jsonrpc": "2.0", "id": 2, "method": "authenticate", "params": { "methodId": method } }).to_string()).unwrap();
            Some(wait_for_line(&seen, 2, 60).await)
        }
        None => None,
    };
    process::send(&state.processes, instance, json!({ "jsonrpc": "2.0", "id": 3, "method": "session/new", "params": { "cwd": workspace, "mcpServers": [] } }).to_string()).unwrap();
    let session = wait_for_line(&seen, 3, 120).await;
    state.shutdown().await;
    (init, auth, session)
}

fn option_values(session: &Value, category: &str) -> Vec<String> {
    session["result"]["configOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| option["category"] == category)
        .flat_map(|option| option["options"].as_array().cloned().unwrap_or_default())
        .filter_map(|choice| choice["value"].as_str().map(str::to_string))
        .collect()
}

fn files_containing(dir: &std::path::Path, needle: &str) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files_containing(&path, needle));
        } else if std::fs::read(&path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|window| window == needle.as_bytes())) {
            found.push(path);
        }
    }
    found
}

fn request_for(agent_id: &str, built: &env::BuiltEnv, base: &std::collections::BTreeMap<String, String>, workspace: &std::path::Path) -> process::SpawnRequest {
    let mut env = base.clone();
    env.extend(built.env.clone());
    process::SpawnRequest {
        agent_id: agent_id.into(),
        cwd: Some(workspace.to_string_lossy().into_owned()),
        env,
        unset: built.unset.clone(),
        args: None,
        extra_args: built.args.clone(),
        files: built.files.clone(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "installs codex-acp (and its codex binary) from npm and runs it (no prompts)"]
async fn real_codex_handshake() {
    let installed = real_install("codex-acp").await;
    assert!(installed.node);
    // npm sometimes skips the native codex package silently; the installer fetches it.
    assert!(install::missing_platform_packages(&std::path::Path::new(&installed.dir).join("node_modules")).is_empty(), "this platform's codex binary is installed");
    let root = real_root();
    let (dir, mut base) = sandbox("codex");
    let workspace = dir.join("ws");
    // ChatGPT (the user's own ~/.codex — here a temp one): signed out.
    base.insert("CODEX_HOME".into(), dir.join("codex-home").to_string_lossy().into_owned());
    std::fs::create_dir_all(dir.join("codex-home")).unwrap();
    let chatgpt = env::build("codex-acp", &env::AgentConfig::default(), &|_| None).unwrap();
    let (init, _, session) = real_session(&root, request_for("codex-acp", &chatgpt, &base, &workspace), &workspace, None).await;
    let methods: Vec<&str> = init["result"]["authMethods"].as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect();
    eprintln!("codex authMethods: {methods:?}");
    assert_eq!(methods, vec!["api-key", "chat-gpt", "chat-gpt-device-code"], "the device-code method appears because Sable supports URL elicitation");
    assert_eq!(session["error"]["code"], -32000, "signed out: {session}");
    // The account check Settings runs: `codex-acp cli login status`.
    let status_args = env::providers("codex-acp")[0].account.clone().unwrap().status.unwrap();
    let status = process::exec(launch(&root, &process::SpawnRequest { agent_id: "codex-acp".into(), env: base.clone(), args: Some(status_args), ..Default::default() }).unwrap(), Duration::from_secs(60)).await.unwrap();
    let parsed = commands_status("exit", &status);
    eprintln!("codex login status → {parsed}");
    assert_eq!(parsed["loggedIn"], false);

    // Amazon Bedrock: Sable's CODEX_HOME and config.toml; no AWS credentials needed to open a session.
    base.remove("CODEX_HOME");
    let mut bedrock = env::AgentConfig { provider: Some("bedrock".into()), ..Default::default() };
    bedrock.values.insert("bedrock.region".into(), "us-east-2".into());
    bedrock.values.insert("bedrock.credentials".into(), "profile".into());
    bedrock.values.insert("bedrock.profile".into(), "sable-real-test-nonexistent".into());
    let built = env::build("codex-acp", &bedrock, &|_| None).unwrap();
    let (_, _, session) = real_session(&root, request_for("codex-acp", &built, &base, &workspace), &workspace, None).await;
    assert!(session["result"]["sessionId"].is_string(), "Bedrock needs no ChatGPT sign-in: {session}");
    let models = option_values(&session, "model");
    eprintln!("codex on Bedrock: models {models:?}");
    assert!(models.iter().all(|model| model.contains("openai.")), "Bedrock's catalog: {models:?}");

    // An OpenAI API key (a fake one): signed in in memory only.
    let key = "sk-sable-real-test-not-a-key";
    let mut keyed = env::AgentConfig { provider: Some("apiKey".into()), ..Default::default() };
    keyed.values.insert("apiKey.model".into(), "gpt-5.5".into());
    let built = env::build("codex-acp", &keyed, &|_| Some(key.to_string())).unwrap();
    let (_, _, session) = real_session(&root, request_for("codex-acp", &built, &base, &workspace), &workspace, None).await;
    assert!(session["result"]["sessionId"].is_string(), "DEFAULT_AUTH_REQUEST signs in with the key: {session}");
    let data = data_dir(&root, "codex-acp").unwrap();
    assert!(data.join("codex-home/config.toml").exists());
    assert!(!data.join("codex-home/auth.json").exists(), "nothing stored by the ephemeral credential store");
    assert!(files_containing(&data, key).is_empty() && files_containing(&dir, key).is_empty(), "the key isn't written anywhere");
    let _ = std::fs::remove_dir_all(&dir);
}

fn commands_status(format: &str, result: &Value) -> Value {
    env::account_status_of(format, result["code"].as_i64(), result["stdout"].as_str().unwrap_or(""), result["stderr"].as_str().unwrap_or("")).unwrap_or(Value::Null)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "installs Kimi Code from npm (Node 22.19+) and runs it (no prompts)"]
async fn real_kimi_code_handshake() {
    let installed = real_install("kimi-code").await;
    let root = real_root();
    let (dir, mut base) = sandbox("kimi");
    let workspace = dir.join("ws");
    base.insert("KIMI_CODE_HOME".into(), dir.join("kimi-home").to_string_lossy().into_owned());
    let account = env::build("kimi-code", &env::AgentConfig::default(), &|_| None).unwrap();
    let (init, _, session) = real_session(&root, request_for("kimi-code", &account, &base, &workspace), &workspace, None).await;
    eprintln!("kimi agentInfo {} authMethods {}", init["result"]["agentInfo"], init["result"]["authMethods"]);
    assert_eq!(init["result"]["agentInfo"]["name"], "Kimi Code CLI", "the current Kimi Code, not the archived kimi-cli");
    let method = &init["result"]["authMethods"][0];
    assert_eq!((method["id"].as_str(), method["type"].as_str()), (Some("login"), Some("terminal")));
    assert_eq!(method["args"], json!(["--login"]), "Sable's terminal sign-in appends these to `kimi acp`");
    assert_eq!(env::providers("kimi-code")[0].account.clone().unwrap().login.unwrap(), vec!["acp", "--login"]);
    assert!(init["result"]["agentCapabilities"]["auth"]["logout"].is_object(), "sign-out over ACP");
    assert_eq!(session["error"]["code"], -32000, "signed out: {session}");

    // A Kimi Platform key (a fake one) through KIMI_MODEL_*: a session, nothing written.
    let key = "sk-sable-real-test-not-a-key";
    let mut platform = env::AgentConfig { provider: Some("platform".into()), ..Default::default() };
    platform.values.insert("platform.model".into(), "kimi-k2-turbo-preview".into());
    let built = env::build("kimi-code", &platform, &|_| Some(key.to_string())).unwrap();
    let (_, _, session) = real_session(&root, request_for("kimi-code", &built, &base, &workspace), &workspace, None).await;
    assert!(session["result"]["sessionId"].is_string(), "KIMI_MODEL_* passes Kimi Code's sign-in gate: {session}");
    let model = session["result"]["configOptions"].as_array().unwrap().iter().find(|option| option["category"] == "model").cloned().unwrap();
    eprintln!("kimi model option: {model}");
    assert!(model.to_string().contains("kimi-k2-turbo-preview"), "the model shows by its name");
    for category in ["thought_level", "mode"] {
        assert!(!option_values(&session, category).is_empty(), "{category} options");
    }
    assert!(!dir.join("kimi-home/config.toml").exists() || !std::fs::read_to_string(dir.join("kimi-home/config.toml")).unwrap().contains(key), "nothing written to config.toml");
    assert!(files_containing(&dir, key).is_empty(), "the key isn't written anywhere");
    let _ = installed;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "downloads Cursor's CLI (~170 MB, proprietary) into a temp folder and runs it (no prompts, no sign-in)"]
async fn real_cursor_handshake() {
    // Cursor's own CLI, downloaded only for this opt-in test (or an
    // unpacked package given in SABLE_CURSOR_PACKAGE).
    let root = real_root();
    let installed = match std::env::var_os("SABLE_CURSOR_PACKAGE") {
        Some(package) => {
            let entry: registry::AgentEntry = serde_json::from_value(json!({ "id": "cursor", "name": "Cursor", "version": "local", "distribution": { "binary": {} } })).unwrap();
            let program = std::path::PathBuf::from(package).join("dist-package/cursor-agent");
            install::link_local(&root, &entry, &program).unwrap()
        }
        None => real_install("cursor").await,
    };
    eprintln!("cursor at {} ({}; archive sha256 {:?})", installed.program, installed.version, installed.archive_sha256);
    let (dir, mut base) = sandbox("cursor");
    let workspace = dir.join("ws");
    // Cursor's file credential store in the temp HOME (never the Keychain), no browser.
    base.insert("AGENT_CLI_CREDENTIAL_STORE".into(), "file".into());
    base.insert("CURSOR_CONFIG_DIR".into(), dir.join("cursor-config").to_string_lossy().into_owned());
    base.insert("CURSOR_DATA_DIR".into(), dir.join("cursor-config").to_string_lossy().into_owned());
    base.insert("NO_OPEN_BROWSER".into(), "1".into());
    let account = env::build("cursor", &env::AgentConfig::default(), &|_| None).unwrap();
    let (init, auth, session) = real_session(&root, request_for("cursor", &account, &base, &workspace), &workspace, Some("cursor_login")).await;
    eprintln!("cursor authMethods {}", init["result"]["authMethods"]);
    assert_eq!(init["result"]["authMethods"][0]["id"], "cursor_login");
    let auth = auth.unwrap();
    eprintln!("cursor authenticate without a browser → {auth}");
    assert!(auth["error"]["data"]["message"].as_str().unwrap_or("").contains("Failed to open browser"), "{auth}");
    assert_eq!(session["error"]["code"], -32000, "{session}");
    let status_args = env::providers("cursor")[0].account.clone().unwrap().status.unwrap();
    let status = process::exec(launch(&root, &process::SpawnRequest { agent_id: "cursor".into(), env: base.clone(), args: Some(status_args), ..Default::default() }).unwrap(), Duration::from_secs(60)).await.unwrap();
    let parsed = commands_status("json", &status);
    eprintln!("cursor status → {parsed}");
    assert_eq!(parsed["loggedIn"], false);
    // --model goes after acp (the CLI reads it there too).
    let mut pinned = env::AgentConfig::default();
    pinned.values.insert("account.model".into(), "gpt-5".into());
    let built = env::build("cursor", &pinned, &|_| None).unwrap();
    let (init, _, _) = real_session(&root, request_for("cursor", &built, &base, &workspace), &workspace, None).await;
    assert_eq!(init["result"]["protocolVersion"], 1, "starts with --model after acp");
    let _ = std::fs::remove_dir_all(&dir);
}
