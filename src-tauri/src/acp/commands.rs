//! The app's ACP commands. Local windows install and run agents from
//! Sable's data folder (`<app data>/agents`); a remote window forwards the
//! workspace-side commands to the remote agent (agents live in
//! `~/.sable/agents` there). Secrets come from the OS keychain here, on
//! this machine, and only ever travel inside the environment of an agent
//! being started — never to the frontend, never into a settings file.

use super::env::{self, AgentConfig, AgentsConfig, AuthProvider};
use super::{process, registry, AcpState};
use crate::events::Events;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

static AGENTS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_agents_dir(dir: PathBuf) {
    *AGENTS_DIR.lock().unwrap() = Some(dir);
}

pub fn agents_dir() -> Result<PathBuf, String> {
    let dir = AGENTS_DIR.lock().unwrap().clone().ok_or("The agents folder isn't set")?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// Who's asking: a window (its events, its agents, whether it's remote).
#[derive(Clone)]
pub struct Context {
    pub label: String,
    pub events: Events,
    pub state: Arc<AcpState>,
}

impl Context {
    fn remote(&self) -> bool {
        crate::remote::is_connected(&self.label)
    }

    /// A workspace-side command, here or on the remote.
    pub async fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        if self.remote() {
            return crate::remote::call(&self.label, command.to_string(), args).await;
        }
        let root = agents_dir()?;
        super::dispatch(&self.state, &self.events, &root, command, &args)
            .await
            .unwrap_or_else(|| Err(format!("Unknown agent command {command}")))
    }
}

// --- The registry ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryResult {
    #[serde(flatten)]
    pub registry: registry::Registry,
    /// "network", "cache" or "builtin".
    pub source: String,
    /// Why the network copy couldn't be had, if it couldn't.
    pub error: Option<String>,
}

const CACHE_HOURS: u64 = 6;

fn registry_url() -> String {
    std::env::var("SABLE_ACP_REGISTRY_URL").unwrap_or_else(|_| registry::REGISTRY_URL.to_string())
}

/// The registry: a fresh cached copy, else the network, else any cached
/// copy, else the built-in one.
pub async fn load_registry(refresh: bool) -> Result<RegistryResult, String> {
    let mut result = load_registry_only(refresh).await?;
    result.registry = registry::with_extras(result.registry, registry::EXTRA);
    Ok(result)
}

async fn load_registry_only(refresh: bool) -> Result<RegistryResult, String> {
    let cache = agents_dir()?.join("registry.json");
    let cached = || std::fs::read_to_string(&cache).ok().and_then(|text| registry::parse(&text).ok());
    let age = std::fs::metadata(&cache).and_then(|m| m.modified()).ok().and_then(|modified| modified.elapsed().ok());
    if !refresh && age.is_some_and(|age| age < Duration::from_secs(CACHE_HOURS * 3600)) {
        if let Some(registry) = cached() {
            return Ok(RegistryResult { registry, source: "cache".into(), error: None });
        }
    }
    let fetched: Result<registry::Registry, String> = async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
        let response = client.get(registry_url()).send().await.map_err(|e| format!("Couldn't reach the agent registry: {e}"))?;
        let text = response.error_for_status().map_err(|e| format!("The agent registry answered {e}"))?.text().await.map_err(|e| e.to_string())?;
        let registry = registry::parse(&text)?;
        let _ = std::fs::write(&cache, &text);
        Ok(registry)
    }
    .await;
    match fetched {
        Ok(registry) => Ok(RegistryResult { registry, source: "network".into(), error: None }),
        Err(error) => match cached() {
            Some(registry) => Ok(RegistryResult { registry, source: "cache".into(), error: Some(error) }),
            None => Ok(RegistryResult { registry: registry::parse(registry::FALLBACK)?, source: "builtin".into(), error: Some(error) }),
        },
    }
}

async fn entry(id: &str) -> Result<registry::AgentEntry, String> {
    let result = load_registry(false).await?;
    if let Some(entry) = result.registry.agents.into_iter().find(|agent| agent.id == id) {
        return Ok(entry);
    }
    // Maybe it's new since the cached copy.
    load_registry(true).await?.registry.agents.into_iter().find(|agent| agent.id == id).ok_or_else(|| format!("{id} isn't in the agent registry"))
}

/// What a consent-less install of a proprietary download answers.
pub const CONSENT_REQUIRED: &str = "consent-required";

pub async fn install_agent(context: &Context, id: &str, consent: bool) -> Result<Value, String> {
    let entry = entry(id).await?;
    if registry::needs_consent(&entry) && !consent {
        return Err(format!("{CONSENT_REQUIRED}: {} is proprietary software downloaded from its vendor; agree to its terms first", entry.name));
    }
    context.call("acp_install_entry", json!({ "entry": entry })).await
}

/// Use the user's own installed CLI for the agent (no download).
pub async fn link_local(context: &Context, id: &str) -> Result<Value, String> {
    let entry = entry(id).await?;
    context.call("acp_link_local", json!({ "entry": entry })).await
}

// --- Settings (agents/config.json) -------------------------------------------------------------

fn config_path() -> Result<PathBuf, String> {
    Ok(agents_dir()?.join("config.json"))
}

pub fn load_config() -> Result<AgentsConfig, String> {
    match std::fs::read_to_string(config_path()?) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("agents/config.json isn't valid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentsConfig::default()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_agent_config(agent_id: &str, config: AgentConfig) -> Result<AgentsConfig, String> {
    if !registry::valid_id(agent_id) {
        return Err(format!("Invalid agent id {agent_id:?}"));
    }
    // Secret fields never land here, even if the frontend sent one.
    let mut config = config;
    for provider in env::providers(agent_id) {
        for field in provider.fields.iter().filter(|field| field.secret) {
            config.values.remove(&env::value_key(&provider.id, &field.key));
        }
    }
    let mut all = load_config().unwrap_or_default();
    all.agents.insert(agent_id.to_string(), config);
    let path = config_path()?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    Ok(all)
}

// --- Secrets (the OS keychain) -------------------------------------------------------------------

#[cfg_attr(test, allow(dead_code))]
const KEYCHAIN_SERVICE: &str = "com.riaanmathur.sable";

/// Read this session (one keychain prompt at most, for unsigned builds).
static SECRET_CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn account(agent_id: &str, key: &str) -> String {
    format!("acp-{agent_id}-{key}")
}

#[cfg(not(test))]
fn keychain_get(account: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).ok()?.get_password().ok()
}
#[cfg(not(test))]
fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|error| format!("Keychain unavailable: {error}"))?
        .set_password(value)
        .map_err(|error| format!("Couldn't save to the keychain: {error}"))
}
#[cfg(not(test))]
fn keychain_delete(account: &str) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Couldn't remove it from the keychain: {error}")),
    }
}
// Tests (and the UI bridge) never touch the real keychain.
#[cfg(test)]
static TEST_KEYCHAIN: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
#[cfg(test)]
fn keychain_get(account: &str) -> Option<String> {
    TEST_KEYCHAIN.lock().unwrap().get_or_insert_with(HashMap::new).get(account).cloned()
}
#[cfg(test)]
fn keychain_set(account: &str, value: &str) -> Result<(), String> {
    TEST_KEYCHAIN.lock().unwrap().get_or_insert_with(HashMap::new).insert(account.into(), value.into());
    Ok(())
}
#[cfg(test)]
fn keychain_delete(account: &str) -> Result<(), String> {
    TEST_KEYCHAIN.lock().unwrap().get_or_insert_with(HashMap::new).remove(account);
    Ok(())
}

fn secret_known(agent_id: &str, key: &str) -> Result<(), String> {
    let known = env::providers(agent_id)
        .iter()
        .any(|provider| provider.fields.iter().any(|field| field.secret && env::value_key(&provider.id, &field.key) == key));
    if known {
        Ok(())
    } else {
        Err(format!("{key} isn't a secret {agent_id} uses"))
    }
}

pub fn get_secret(agent_id: &str, key: &str) -> Option<String> {
    let account = account(agent_id, key);
    if let Some(value) = SECRET_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&account) {
        return value.clone();
    }
    let value = keychain_get(&account).filter(|value| !value.trim().is_empty());
    SECRET_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(account, value.clone());
    value
}

pub fn set_secret(agent_id: &str, key: &str, value: &str) -> Result<(), String> {
    secret_known(agent_id, key)?;
    let value = value.trim();
    if value.is_empty() {
        return delete_secret(agent_id, key);
    }
    let account = account(agent_id, key);
    keychain_set(&account, value)?;
    SECRET_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(account, Some(value.to_string()));
    Ok(())
}

pub fn delete_secret(agent_id: &str, key: &str) -> Result<(), String> {
    secret_known(agent_id, key)?;
    let account = account(agent_id, key);
    keychain_delete(&account)?;
    SECRET_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(account, None);
    Ok(())
}

/// Which secrets are set — never their values.
pub fn secret_status(agent_id: &str) -> BTreeMap<String, bool> {
    let mut status = BTreeMap::new();
    for provider in env::providers(agent_id) {
        for field in provider.fields.iter().filter(|field| field.secret) {
            let key = env::value_key(&provider.id, &field.key);
            let set = get_secret(agent_id, &key).is_some();
            status.insert(key, set);
        }
    }
    status
}

// --- Starting agents -------------------------------------------------------------------------------

fn built_env(agent_id: &str) -> Result<env::BuiltEnv, String> {
    let config = load_config()?.agents.get(agent_id).cloned().unwrap_or_default();
    env::build(agent_id, &config, &|key| get_secret(agent_id, key))
}

pub async fn start(context: &Context, agent_id: &str, cwd: Option<String>) -> Result<Value, String> {
    let built = built_env(agent_id)?;
    let request = process::SpawnRequest { agent_id: agent_id.into(), cwd, env: built.env, unset: built.unset, args: None, extra_args: built.args, files: built.files };
    let instance = context.call("acp_spawn", json!({ "request": request })).await?;
    Ok(json!({ "instance": instance, "provider": built.provider }))
}

fn account_commands(agent_id: &str) -> Option<env::AccountCommands> {
    account_commands_of(agent_id, None)
}

/// The account commands of `provider` (default: the method in use).
fn account_commands_of(agent_id: &str, provider: Option<&str>) -> Option<env::AccountCommands> {
    let config = load_config().ok()?.agents.get(agent_id).cloned().unwrap_or_default();
    let providers = env::providers(agent_id);
    let chosen = match provider.or(config.provider.as_deref()) {
        Some(id) => providers.iter().find(|p| p.id == id)?,
        None => providers.first()?,
    };
    chosen.account.clone()
}

/// The agent's own account, for a method that has one (Claude's login,
/// ChatGPT, Cursor): `{supported: false}`, or `{supported: true, status}`
/// where `status` is the agent's own JSON with `loggedIn` (and `email`,
/// `detail` when known) filled in.
pub async fn account_status(context: &Context, agent_id: &str) -> Result<Value, String> {
    let Some(commands) = account_commands(agent_id) else {
        return Ok(json!({ "supported": false }));
    };
    let Some(status_args) = commands.status.clone() else {
        return Ok(json!({ "supported": false }));
    };
    let built = built_env(agent_id)?;
    let request = process::SpawnRequest { agent_id: agent_id.into(), cwd: None, env: built.env, unset: built.unset, args: Some(status_args), extra_args: vec![], files: built.files };
    let result = context.call("acp_exec", json!({ "request": request, "timeoutSecs": 30 })).await?;
    let status = env::account_status_of(&commands.status_format, result["code"].as_i64(), result["stdout"].as_str().unwrap_or(""), result["stderr"].as_str().unwrap_or(""));
    Ok(json!({ "supported": true, "status": status, "code": result["code"], "stderr": result["stderr"] }))
}

/// The command line for a terminal: an account action ("login",
/// "logout", in place of the agent's ACP arguments), or an ACP terminal
/// auth method's `args` (appended to the agent's own launch command, as the
/// spec says). Secrets aren't included: a terminal's environment passes
/// through the UI.
pub async fn terminal_spec(
    context: &Context,
    agent_id: &str,
    action: Option<String>,
    args: Option<Vec<String>>,
    env_extra: Option<BTreeMap<String, String>>,
    provider: Option<String>,
) -> Result<Value, String> {
    let account_commands = |agent_id: &str| account_commands_of(agent_id, provider.as_deref());
    let mut config = load_config()?.agents.get(agent_id).cloned().unwrap_or_default();
    if provider.is_some() {
        config.provider = provider.clone();
    }
    // Secrets aren't needed to sign in (and a missing one mustn't stop it).
    let built = env::build(agent_id, &config, &|_| Some(String::from("-"))).or_else(|_| env::build(agent_id, &AgentConfig { provider: config.provider.clone(), ..Default::default() }, &|_| Some(String::from("-")))).unwrap_or_default();
    let (replace, append) = match (action.as_deref(), args) {
        // An ACP terminal auth method: its args after the agent's own (plus
        // the method's sign-in flags, e.g. Kimi Code's --region).
        (_, Some(args)) => (None, [args, built.login_args.clone()].concat()),
        (Some("login"), None) => {
            let login = account_commands(agent_id).and_then(|c| c.login).ok_or("This sign-in method has no login command")?;
            (Some([login, built.login_args.clone()].concat()), vec![])
        }
        (Some("login_device"), None) => (Some(account_commands(agent_id).and_then(|c| c.login_device).ok_or("This sign-in method has no one-time-code sign-in")?), vec![]),
        (Some("logout"), None) => (Some(account_commands(agent_id).and_then(|c| c.logout).ok_or("This sign-in method has no logout command")?), vec![]),
        _ => return Err("Nothing to run".into()),
    };
    let secret_vars: Vec<String> = env::providers(agent_id)
        .iter()
        .flat_map(|provider| provider.fields.iter().filter(|field| field.secret).filter_map(|field| field.env.clone()))
        .collect();
    let mut env = built.env;
    env.retain(|name, _| !secret_vars.contains(name));
    env.extend(env_extra.unwrap_or_default());
    let request = process::SpawnRequest { agent_id: agent_id.into(), cwd: None, env, unset: built.unset, args: replace, extra_args: append, files: built.files };
    context.call("acp_launch_spec", json!({ "request": request })).await
}

// --- Sable-side transcripts ----------------------------------------------------------------------------

fn threads_file(root: &str) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    let dir = agents_dir()?.join("threads");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(format!("{:016x}.json", hasher.finish())))
}

pub fn load_threads(root: &str) -> Result<Value, String> {
    match std::fs::read_to_string(threads_file(root)?) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or(Value::Null)),
        Err(_) => Ok(Value::Null),
    }
}

pub fn save_threads(root: &str, threads: &Value) -> Result<(), String> {
    let path = threads_file(root)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, threads.to_string()).map_err(|error| format!("Couldn't save the agent threads: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| error.to_string())
}

// --- Tauri commands ---------------------------------------------------------------------------------

fn context(window: &tauri::WebviewWindow, states: &crate::windows::PerWindow<AcpState>) -> Context {
    Context { label: window.label().to_string(), events: crate::events::for_window(window), state: states.get(window.label()) }
}

type States<'a> = tauri::State<'a, crate::windows::PerWindow<AcpState>>;

#[tauri::command]
pub async fn acp_call(window: tauri::WebviewWindow, states: States<'_>, cmd: String, args: Value) -> Result<Value, String> {
    if !cmd.starts_with("acp_") || cmd == "acp_spawn" || cmd == "acp_exec" {
        // Agents start through acp_start (their environment is built here).
        return Err(format!("{cmd} can't be called directly"));
    }
    context(&window, &states).call(&cmd, args).await
}

#[tauri::command]
pub async fn acp_registry(refresh: Option<bool>) -> Result<RegistryResult, String> {
    load_registry(refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn acp_install(window: tauri::WebviewWindow, states: States<'_>, id: String, consent: Option<bool>) -> Result<Value, String> {
    install_agent(&context(&window, &states), &id, consent.unwrap_or(false)).await
}

#[tauri::command]
pub async fn acp_link_local(window: tauri::WebviewWindow, states: States<'_>, id: String) -> Result<Value, String> {
    link_local(&context(&window, &states), &id).await
}

#[tauri::command]
pub fn acp_providers(agent_id: String) -> Vec<AuthProvider> {
    env::providers(&agent_id)
}

#[tauri::command]
pub fn acp_config() -> Result<AgentsConfig, String> {
    load_config()
}

#[tauri::command]
pub fn acp_set_config(agent_id: String, config: AgentConfig) -> Result<AgentsConfig, String> {
    save_agent_config(&agent_id, config)
}

#[tauri::command]
pub fn acp_set_secret(agent_id: String, key: String, value: String) -> Result<(), String> {
    set_secret(&agent_id, &key, &value)
}

#[tauri::command]
pub fn acp_delete_secret(agent_id: String, key: String) -> Result<(), String> {
    delete_secret(&agent_id, &key)
}

#[tauri::command]
pub fn acp_secret_status(agent_id: String) -> BTreeMap<String, bool> {
    secret_status(&agent_id)
}

#[tauri::command]
pub async fn acp_start(window: tauri::WebviewWindow, states: States<'_>, agent_id: String, cwd: Option<String>) -> Result<Value, String> {
    start(&context(&window, &states), &agent_id, cwd).await
}

#[tauri::command]
pub async fn acp_account_status(window: tauri::WebviewWindow, states: States<'_>, agent_id: String) -> Result<Value, String> {
    account_status(&context(&window, &states), &agent_id).await
}

#[tauri::command]
pub async fn acp_terminal_spec(
    window: tauri::WebviewWindow,
    states: States<'_>,
    agent_id: String,
    action: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    provider: Option<String>,
) -> Result<Value, String> {
    terminal_spec(&context(&window, &states), &agent_id, action, args, env, provider).await
}

#[tauri::command]
pub fn acp_threads_load(root: String) -> Result<Value, String> {
    load_threads(&root)
}

#[tauri::command]
pub fn acp_threads_save(root: String, threads: Value) -> Result<(), String> {
    save_threads(&root, &threads)
}

/// The bridge's stand-in for a window (UI tests): the same commands.
#[cfg(test)]
pub async fn bridge_dispatch(context: &Context, command: &str, args: &Value) -> Option<Result<Value, String>> {
    fn arg<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
        serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|error| format!("argument {key}: {error}"))
    }
    fn json_of<T: Serialize>(result: Result<T, String>) -> Option<Result<Value, String>> {
        Some(result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())))
    }
    let value = |result: Result<Value, String>| Some(result);
    let to = value;
    match command {
        "acp_call" => {
            let cmd: String = match arg(args, "cmd") {
                Ok(cmd) => cmd,
                Err(error) => return Some(Err(error)),
            };
            value(context.call(&cmd, args.get("args").cloned().unwrap_or(Value::Null)).await)
        }
        "acp_registry" => json_of(load_registry(arg::<Option<bool>>(args, "refresh").ok().flatten().unwrap_or(false)).await),
        "acp_install" => to(match arg::<String>(args, "id") {
            Ok(id) => install_agent(context, &id, arg::<Option<bool>>(args, "consent").ok().flatten().unwrap_or(false)).await,
            Err(error) => Err(error),
        }),
        "acp_link_local" => to(match arg::<String>(args, "id") {
            Ok(id) => link_local(context, &id).await,
            Err(error) => Err(error),
        }),
        "acp_providers" => json_of(arg::<String>(args, "agentId").map(|id| env::providers(&id))),
        "acp_config" => json_of(load_config()),
        "acp_set_config" => json_of(match (arg::<String>(args, "agentId"), arg::<AgentConfig>(args, "config")) {
            (Ok(id), Ok(config)) => save_agent_config(&id, config),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }),
        "acp_set_secret" => json_of(match (arg::<String>(args, "agentId"), arg::<String>(args, "key"), arg::<String>(args, "value")) {
            (Ok(id), Ok(key), Ok(v)) => set_secret(&id, &key, &v),
            _ => Err("bad arguments".into()),
        }),
        "acp_delete_secret" => json_of(match (arg::<String>(args, "agentId"), arg::<String>(args, "key")) {
            (Ok(id), Ok(key)) => delete_secret(&id, &key),
            _ => Err("bad arguments".into()),
        }),
        "acp_secret_status" => json_of(arg::<String>(args, "agentId").map(|id| secret_status(&id))),
        "acp_start" => to(match arg::<String>(args, "agentId") {
            Ok(id) => start(context, &id, arg(args, "cwd").ok().flatten()).await,
            Err(error) => Err(error),
        }),
        "acp_account_status" => to(match arg::<String>(args, "agentId") {
            Ok(id) => account_status(context, &id).await,
            Err(error) => Err(error),
        }),
        "acp_terminal_spec" => to(match arg::<String>(args, "agentId") {
            Ok(id) => terminal_spec(context, &id, arg(args, "action").ok().flatten(), arg(args, "args").ok().flatten(), arg(args, "env").ok().flatten(), arg(args, "provider").ok().flatten()).await,
            Err(error) => Err(error),
        }),
        "acp_threads_load" => to(arg::<String>(args, "root").and_then(|root| load_threads(&root))),
        "acp_threads_save" => json_of(match (arg::<String>(args, "root"), arg::<Value>(args, "threads")) {
            (Ok(root), Ok(threads)) => save_threads(&root, &threads),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Settings and secrets: secrets go to the keychain (a stand-in in
    /// tests), never config.json; the environment is built from both.
    #[test]
    fn config_and_secrets_build_the_environment() {
        let _lock = crate::acp::commands::tests::DIR_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("sable-acp-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        set_agents_dir(dir.clone());
        let mut config = AgentConfig { provider: Some("bedrock".into()), ..Default::default() };
        config.values.insert("bedrock.credentials".into(), "keys".into());
        config.values.insert("bedrock.region".into(), "us-west-2".into());
        // A secret sneaked into the values is dropped.
        config.values.insert("bedrock.secretAccessKey".into(), "leaked".into());
        save_agent_config("claude-acp", config).unwrap();
        let text = std::fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(!text.contains("leaked"), "{text}");
        assert!(set_secret("claude-acp", "bedrock.nope", "x").is_err(), "unknown secrets are refused");
        set_secret("claude-acp", "bedrock.accessKeyId", "AKIA9").unwrap();
        set_secret("claude-acp", "bedrock.secretAccessKey", "shh").unwrap();
        assert!(secret_status("claude-acp")["bedrock.secretAccessKey"]);
        assert!(!secret_status("claude-acp")["apiKey.apiKey"]);
        let built = built_env("claude-acp").unwrap();
        assert_eq!(built.env["AWS_REGION"], "us-west-2");
        assert_eq!(built.env["AWS_SECRET_ACCESS_KEY"], "shh");
        delete_secret("claude-acp", "bedrock.secretAccessKey").unwrap();
        assert!(built_env("claude-acp").unwrap_err().contains("Secret access key"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proprietary_downloads_wait_for_consent() {
        let _lock = DIR_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("sable-acp-consent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        set_agents_dir(dir.clone());
        // The built-in registry (the network one is never fetched here).
        std::fs::write(dir.join("registry.json"), registry::FALLBACK).unwrap();
        let context = Context { label: "test".into(), events: std::sync::Arc::new(|_, _| {}), state: Default::default() };
        let error = tokio::runtime::Runtime::new().unwrap().block_on(install_agent(&context, "cursor", false)).unwrap_err();
        assert!(error.starts_with(CONSENT_REQUIRED), "{error}");
        assert!(super::super::install::read(&dir, "cursor").is_none(), "nothing was downloaded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    pub(crate) static DIR_LOCK: Mutex<()> = Mutex::new(());
}
