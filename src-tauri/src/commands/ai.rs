//! AI provider access for the agent panel.
//!
//! Split of responsibilities:
//!   - The frontend builds provider-specific request bodies (messages,
//!     tools) and runs the agent loop — that logic changes often and is
//!     easiest to iterate on in TypeScript.
//!   - Rust owns the API keys and the HTTP calls. Keys live in the OS
//!     keychain (macOS Keychain / Windows Credential Manager / Linux
//!     keyutils) and are never handed to the webview; the frontend only
//!     ever learns *whether* a key is set.
//!
//! This is the one part of Sable that makes network calls, and only when
//! the user sends a message to the agent.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "com.riaanmathur.sable";
const PROVIDERS: [&str; 3] = ["anthropic", "openai", "google"];

pub struct AiState {
    /// Keys read from the keychain this session. Caching avoids a
    /// keychain round-trip (and, for unsigned dev builds, a macOS access
    /// prompt) on every request.
    keys: Mutex<HashMap<String, String>>,
    client: reqwest::Client,
    /// In-flight streams by id, so Stop can abort the HTTP request.
    streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Default for AiState {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // Long agent turns (big file rewrites) can take minutes.
            .timeout(Duration::from_secs(600))
            .build()
            .expect("failed to build HTTP client");
        AiState {
            keys: Mutex::new(HashMap::new()),
            client,
            streams: Mutex::new(HashMap::new()),
        }
    }
}

fn check_provider(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("Unknown AI provider: {provider}"))
    }
}

fn keychain_entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("{provider}-api-key"))
        .map_err(|error| format!("Keychain unavailable: {error}"))
}

/// Environment-variable fallback, so a key exported in the shell works
/// without going through the settings UI.
fn env_key(provider: &str) -> Option<String> {
    let names: &[&str] = match provider {
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "openai" => &["OPENAI_API_KEY"],
        "google" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        _ => &[],
    };
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.trim().is_empty())
}

/// Resolve a provider's key: session cache → keychain → environment.
fn api_key(state: &AiState, provider: &str) -> Option<String> {
    if let Some(key) = state.keys.lock().unwrap().get(provider) {
        return Some(key.clone());
    }
    let from_keychain = keychain_entry(provider)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|key| !key.trim().is_empty());
    let key = from_keychain.or_else(|| env_key(provider))?;
    state
        .keys
        .lock()
        .unwrap()
        .insert(provider.to_string(), key.clone());
    Some(key)
}

/// Store a key in the OS keychain.
#[tauri::command]
pub fn ai_set_api_key(
    state: State<AiState>,
    provider: String,
    key: String,
) -> Result<(), String> {
    check_provider(&provider)?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    keychain_entry(&provider)?
        .set_password(&key)
        .map_err(|error| format!("Could not save key to keychain: {error}"))?;
    state.keys.lock().unwrap().insert(provider, key);
    Ok(())
}

/// Remove a key from the keychain (and this session's cache).
#[tauri::command]
pub fn ai_delete_api_key(state: State<AiState>, provider: String) -> Result<(), String> {
    check_provider(&provider)?;
    state.keys.lock().unwrap().remove(&provider);
    match keychain_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Could not remove key: {error}")),
    }
}

/// Which providers have a usable key — booleans only, never the keys.
#[tauri::command]
pub fn ai_key_status(state: State<AiState>) -> HashMap<String, bool> {
    PROVIDERS
        .iter()
        .map(|provider| (provider.to_string(), api_key(&state, provider).is_some()))
        .collect()
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        _ => "Google",
    }
}

/// Turn a non-2xx response into a readable error. All three providers
/// put a human message at `error.message`.
async fn error_from_response(provider: &str, response: reqwest::Response) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| {
            body.pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(500).collect());
    let hint = match status.as_u16() {
        401 | 403 => " — check the API key in Settings",
        429 => " — rate limited, try again shortly",
        _ => "",
    };
    format!(
        "{} API error ({}): {}{}",
        provider_label(provider),
        status.as_u16(),
        message.trim(),
        hint
    )
}

fn openai_base(base_url: Option<String>) -> String {
    base_url
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
}

/// Attach the provider's auth header to a request.
fn with_auth(
    request: reqwest::RequestBuilder,
    provider: &str,
    key: &str,
) -> reqwest::RequestBuilder {
    match provider {
        "anthropic" => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "openai" => request.bearer_auth(key),
        _ => request.header("x-goog-api-key", key),
    }
}

/// One non-streaming model call. `body` is the provider-native request
/// body built by the frontend (src/lib/ai/providers.ts); the response is
/// returned as-is for the frontend to parse.
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AiState>,
    provider: String,
    model: String,
    body: Value,
    base_url: Option<String>,
) -> Result<Value, String> {
    check_provider(&provider)?;
    let key = api_key(&state, &provider).ok_or_else(|| {
        format!(
            "No {} API key — add one in Settings → AI Agent",
            provider_label(&provider)
        )
    })?;
    let url = match provider.as_str() {
        "anthropic" => "https://api.anthropic.com/v1/messages".to_string(),
        "openai" => format!("{}/chat/completions", openai_base(base_url)),
        _ => format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            model.trim_start_matches("models/")
        ),
    };
    let client = state.client.clone();
    let response = with_auth(client.post(&url), &provider, &key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", provider_label(&provider)))?;
    if !response.status().is_success() {
        return Err(error_from_response(&provider, response).await);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid response from {}: {error}", provider_label(&provider)))
}

/// List the model ids the key can use, so the model picker never relies
/// on a hard-coded (and inevitably stale) list.
#[tauri::command]
pub async fn ai_list_models(
    state: State<'_, AiState>,
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    check_provider(&provider)?;
    let key = api_key(&state, &provider)
        .ok_or_else(|| format!("Add a {} API key first", provider_label(&provider)))?;
    let url = match provider.as_str() {
        "anthropic" => "https://api.anthropic.com/v1/models?limit=100".to_string(),
        "openai" => format!("{}/models", openai_base(base_url)),
        _ => "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
            .to_string(),
    };
    let client = state.client.clone();
    let response = with_auth(client.get(&url), &provider, &key)
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", provider_label(&provider)))?;
    if !response.status().is_success() {
        return Err(error_from_response(&provider, response).await);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Invalid model list: {error}"))?;

    let mut models: Vec<String> = match provider.as_str() {
        "google" => body["models"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    // Only models that can actually chat.
                    .filter(|model| {
                        model["supportedGenerationMethods"]
                            .as_array()
                            .is_some_and(|methods| {
                                methods.contains(&json!("generateContent"))
                            })
                    })
                    .filter_map(|model| model["name"].as_str())
                    .map(|name| name.trim_start_matches("models/").to_string())
                    .collect()
            })
            .unwrap_or_default(),
        _ => body["data"]
            .as_array()
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model["id"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    };
    if provider == "openai" {
        // The OpenAI list includes embeddings, audio, image models, etc.
        models.retain(|id| {
            !["embedding", "whisper", "tts", "dall-e", "moderation", "audio", "image", "transcribe", "realtime", "search"]
                .iter()
                .any(|skip| id.contains(skip))
        });
    }
    models.sort();
    models.dedup();
    Ok(models)
}

// --- Streaming -------------------------------------------------------------------

/// Incremental parser for server-sent events: feed it raw bytes as they
/// arrive, get back each complete event's `data` payload. (All three
/// providers stream SSE; OpenAI ends with a `[DONE]` sentinel.) Bytes are
/// buffered until an event is complete, so a multi-byte UTF-8 character
/// split across network chunks is never mangled.
#[derive(Default)]
struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        // Normalize CRLF framing; event boundaries are then "\n\n".
        self.buffer.extend(chunk.iter().copied().filter(|&byte| byte != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\n\n") {
            let raw: Vec<u8> = self.buffer.drain(..end + 2).collect();
            let raw = String::from_utf8_lossy(&raw);
            let data: Vec<&str> = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|value| value.strip_prefix(' ').unwrap_or(value))
                .collect();
            if data.is_empty() {
                continue; // comments, `event:` lines without data, keep-alives
            }
            let payload = data.join("\n");
            if payload != "[DONE]" {
                events.push(payload);
            }
        }
        events
    }
}

/// One streamed model call. Each SSE `data` payload is emitted as an
/// `ai:stream` event `{ streamId, data }` (the frontend accumulates them
/// into a reply); the command resolves when the stream ends. `ai_cancel`
/// aborts it mid-flight, so stopping actually stops the request.
#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: State<'_, AiState>,
    provider: String,
    model: String,
    body: Value,
    base_url: Option<String>,
    stream_id: String,
) -> Result<(), String> {
    check_provider(&provider)?;
    let key = api_key(&state, &provider).ok_or_else(|| {
        format!(
            "No {} API key — add one in Settings → AI Agent",
            provider_label(&provider)
        )
    })?;
    let url = match provider.as_str() {
        "anthropic" => "https://api.anthropic.com/v1/messages".to_string(),
        "openai" => format!("{}/chat/completions", openai_base(base_url)),
        _ => format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
            model.trim_start_matches("models/")
        ),
    };
    let request = with_auth(state.client.post(&url), &provider, &key).json(&body);
    let events_id = stream_id.clone();

    let task = tokio::spawn(async move {
        use futures_util::StreamExt;
        let response = request
            .send()
            .await
            .map_err(|error| format!("Could not reach {}: {error}", provider_label(&provider)))?;
        if !response.status().is_success() {
            return Err(error_from_response(&provider, response).await);
        }
        let mut parser = SseParser::default();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Stream interrupted: {error}"))?;
            for data in parser.feed(&chunk) {
                let _ = app.emit("ai:stream", json!({ "streamId": events_id, "data": data }));
            }
        }
        // Events and the command's return travel separately; this marker
        // tells the frontend it has received every event.
        let _ = app.emit("ai:stream", json!({ "streamId": events_id, "done": true }));
        Ok(())
    });
    state
        .streams
        .lock()
        .unwrap()
        .insert(stream_id.clone(), task.abort_handle());
    let result = task.await;
    state.streams.lock().unwrap().remove(&stream_id);
    match result {
        Ok(outcome) => outcome,
        Err(error) if error.is_cancelled() => Err("cancelled".to_string()),
        Err(error) => Err(format!("Stream failed: {error}")),
    }
}

/// Abort an in-flight stream (the agent's Stop button).
#[tauri::command]
pub fn ai_cancel(state: State<AiState>, stream_id: String) {
    if let Some(handle) = state.streams.lock().unwrap().remove(&stream_id) {
        handle.abort();
    }
}

// --- Chat history ------------------------------------------------------------------

/// Chats are stored per workspace in the app data directory (not browser
/// storage: transcripts include file contents and can be large).
fn chats_file(app: &AppHandle, root: &str) -> Result<std::path::PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No data directory: {error}"))?
        .join("chats");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    Ok(dir.join(format!("{:016x}.json", hasher.finish())))
}

/// The saved chats for a workspace (`null` if none yet).
#[tauri::command]
pub fn load_chats(app: AppHandle, root: String) -> Result<Value, String> {
    let path = chats_file(&app, &root)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).or(Ok(Value::Null)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(format!("Could not read chats: {error}")),
    }
}

/// Save a workspace's chats (atomically: temp file + rename).
#[tauri::command]
pub fn save_chats(app: AppHandle, root: String, chats: Value) -> Result<(), String> {
    let path = chats_file(&app, &root)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, chats.to_string()).map_err(|error| format!("Could not save chats: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("Could not save chats: {error}"))
}

#[cfg(test)]
mod tests {
    use super::SseParser;

    #[test]
    fn sse_parser_handles_split_chunks_crlf_and_done() {
        let mut parser = SseParser::default();
        // An event split across chunks, mid-JSON.
        assert!(parser.feed(b"event: message_start\ndata: {\"a\":").is_empty());
        assert_eq!(parser.feed(b"1}\n\n"), vec!["{\"a\":1}"]);
        // CRLF framing, a keep-alive comment, and two events in one chunk.
        assert_eq!(
            parser.feed(b": ping\r\n\r\ndata: {\"b\":2}\r\n\r\ndata:{\"c\":3}\n\n"),
            vec!["{\"b\":2}", "{\"c\":3}"]
        );
        // Multi-line data joins with newlines; [DONE] is dropped.
        assert_eq!(parser.feed(b"data: x\ndata: y\n\ndata: [DONE]\n\n"), vec!["x\ny"]);
        // A multi-byte character split across chunks survives intact.
        let event = "data: {\"t\":\"héllo 👋\"}\n\n".as_bytes();
        let split = event.iter().position(|&byte| byte == 0xF0).unwrap() + 2;
        assert!(parser.feed(&event[..split]).is_empty());
        assert_eq!(parser.feed(&event[split..]), vec!["{\"t\":\"héllo 👋\"}"]);
    }
}
