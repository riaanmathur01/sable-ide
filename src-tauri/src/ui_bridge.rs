//! A development aid for testing the UI against the real backend: serves
//! the backend's commands over local HTTP, so the frontend can run in an
//! ordinary browser (driven by a test script) with `invoke()` forwarded
//! here. Only commands that don't need the app's window are served;
//! the test script stands in for the rest (terminals, language servers).
//!
//!   SABLE_UI_BRIDGE_PORT=1531 cargo test --lib ui_bridge -- --ignored
//!
//! POST /invoke  {"cmd": "git_status", "args": {...}}
//!   → {"ok": <result>} | {"err": "<message>"} | {"unknown": true}

use crate::commands::{fs, git, history, refactor, search, shell};
use crate::plugins;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("argument {key}: {error}"))
}

fn reply<T: Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "err": error }),
    }
}

async fn dispatch(command: &str, args: &Value) -> Result<Value, String> {
    Ok(match command {
        "read_directory" => reply(fs::read_directory(arg(args, "path")?)),
        "read_file" => reply(fs::read_file(arg(args, "path")?)),
        "read_file_base64" => reply(fs::read_file_base64(arg(args, "path")?)),
        "write_file" => reply(fs::write_file(arg(args, "path")?, arg(args, "contents")?)),
        "is_directory" => reply(fs::is_directory(arg(args, "path")?)),
        "path_exists" => json!({ "ok": fs::path_exists(arg(args, "path")?) }),
        "real_path" => reply(fs::real_path(arg(args, "path")?)),
        "create_file" => reply(fs::create_file(arg(args, "path")?)),
        "create_directory" => reply(fs::create_directory(arg(args, "path")?)),
        "delete_path" => reply(fs::delete_path(arg(args, "path")?)),
        "rename_path" => reply(fs::rename_path(arg(args, "path")?, arg(args, "newName")?)),
        "move_path" => reply(fs::move_path(arg(args, "source")?, arg(args, "targetDirectory")?)),
        "list_workspace_files" => reply(search::list_workspace_files(arg(args, "root")?)),
        "run_shell" => reply(shell::run_shell(arg(args, "command")?, arg(args, "cwd")?, arg(args, "timeoutSecs")?).await),
        "git_status" => reply(git::git_status(arg(args, "path")?)),
        "git_stage" => reply(git::git_stage(arg(args, "root")?, arg(args, "file")?)),
        "git_unstage" => reply(git::git_unstage(arg(args, "root")?, arg(args, "file")?)),
        "git_stage_all" => reply(git::git_stage_all(arg(args, "root")?)),
        "git_unstage_all" => reply(git::git_unstage_all(arg(args, "root")?)),
        "git_stage_content" => reply(git::git_stage_content(arg(args, "root")?, arg(args, "file")?, arg(args, "content")?)),
        "git_commit" => reply(git::git_commit(arg(args, "root")?, arg(args, "message")?)),
        "git_conflict_versions" => reply(git::git_conflict_versions(arg(args, "root")?, arg(args, "file")?)),
        "git_merge_abort" => reply(git::git_merge_abort(arg(args, "root")?)),
        "git_merge" => reply(git::git_merge(arg(args, "root")?, arg(args, "branch")?).await),
        "git_file_diff" => reply(git::git_file_diff(arg(args, "root")?, arg(args, "file")?, arg(args, "staged")?)),
        "git_log" => reply(git::git_log(arg(args, "root")?, arg(args, "limit")?, arg(args, "skip")?, arg(args, "branch")?)),
        "git_stash_list" => reply(git::git_stash_list(arg(args, "root")?)),
        "git_stash_save" => reply(git::git_stash_save(arg(args, "root")?, arg(args, "message")?, arg(args, "includeUntracked")?).await),
        "git_stash_apply" => reply(git::git_stash_apply(arg(args, "root")?, arg(args, "index")?, arg(args, "pop")?).await),
        "git_stash_drop" => reply(git::git_stash_drop(arg(args, "root")?, arg(args, "index")?).await),
        "git_cherry_pick" => reply(git::git_cherry_pick(arg(args, "root")?, arg(args, "hash")?).await),
        "git_revert_commit" => reply(git::git_revert_commit(arg(args, "root")?, arg(args, "hash")?).await),
        "git_abort" => reply(git::git_abort(arg(args, "root")?).await),
        "git_rebase" => reply(git::git_rebase(arg(args, "root")?, arg(args, "onto")?).await),
        "git_rebase_interactive" => reply(git::git_rebase_interactive(arg(args, "root")?, arg(args, "base")?, arg(args, "steps")?).await),
        "git_rebase_continue" => reply(git::git_rebase_continue(arg(args, "root")?, arg(args, "skip")?).await),
        "git_commit_files" => reply(git::git_commit_files(arg(args, "root")?, arg(args, "hash")?)),
        "git_commit_file_diff" => {
            reply(git::git_commit_file_diff(arg(args, "root")?, arg(args, "hash")?, arg(args, "file")?))
        }
        "git_blame" => reply(git::git_blame(arg(args, "root")?, arg(args, "file")?)),
        "git_branches" => reply(git::git_branches(arg(args, "root")?)),
        "git_create_branch" => reply(git::git_create_branch(arg(args, "root")?, arg(args, "name")?)),
        "git_switch_branch" => reply(git::git_switch_branch(arg(args, "root")?, arg(args, "name")?)),
        "git_delete_branch" => reply(git::git_delete_branch(arg(args, "root")?, arg(args, "name")?)),
        "git_ahead_behind" => reply(git::git_ahead_behind(arg(args, "root")?)),
        "python_refactor" => reply(
            refactor::python_refactor(
                arg(args, "python")?,
                arg(args, "root")?,
                arg(args, "file")?,
                arg(args, "kind")?,
                arg(args, "start")?,
                arg(args, "end")?,
                arg(args, "name")?,
            )
            .await,
        ),
        "history_list" => json!({ "ok": history::history_list(arg(args, "path")?) }),
        "history_read" => reply(history::history_read(arg(args, "path")?, arg(args, "id")?)),
        "history_deleted_files" => json!({ "ok": history::history_deleted_files(arg(args, "root")?) }),
        "list_processes" => reply(crate::debug::list_processes().await),
        "plugin_list" => reply(plugins::plugin_list()),
        "plugin_inspect" => reply(plugins::plugin_inspect(arg(args, "source")?).await),
        "plugin_install" => reply(plugins::plugin_install(arg(args, "path")?, arg(args, "link")?, arg(args, "source")?)),
        "plugin_uninstall" => reply(plugins::plugin_uninstall(arg(args, "id")?)),
        "plugin_set_enabled" => reply(plugins::plugin_set_enabled(arg(args, "id")?, arg(args, "enabled")?)),
        "plugin_read_main" => reply(plugins::plugin_read_main(arg(args, "id")?)),
        "plugin_discard" => reply(plugins::plugin_discard(arg(args, "path")?)),
        "plugin_marketplace" => reply(plugins::plugin_marketplace(arg(args, "url")?).await),
        _ => json!({ "unknown": true }),
    })
}

async fn serve(mut stream: tokio::net::TcpStream) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 65536];
    // Headers, then Content-Length bytes of body.
    let (header_end, length) = loop {
        let Ok(read) = stream.read(&mut chunk).await else { return };
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&buffer[..end]).to_lowercase();
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            break (end + 4, length);
        }
    };
    while buffer.len() < header_end + length {
        let Ok(read) = stream.read(&mut chunk).await else { return };
        if read == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let request: Value = serde_json::from_slice(&buffer[header_end..header_end + length]).unwrap_or(Value::Null);
    let command = request["cmd"].as_str().unwrap_or("");
    let body = match dispatch(command, &request["args"]).await {
        Ok(value) => value,
        Err(error) => json!({ "err": error }),
    }
    .to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

#[tokio::test]
#[ignore = "a server for UI testing; runs until killed"]
async fn ui_bridge() {
    let port: u16 = std::env::var("SABLE_UI_BRIDGE_PORT").ok().and_then(|port| port.parse().ok()).unwrap_or(1531);
    if let Some(home) = std::env::var_os("HOME") {
        crate::lsp::set_tools_dir(std::path::PathBuf::from(home).join("Library/Application Support/com.riaanmathur.sable/tools"));
    }
    if let Ok(dir) = std::env::var("SABLE_UI_HISTORY_DIR") {
        history::set_history_dir(std::path::PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("SABLE_UI_PLUGINS_DIR") {
        plugins::set_plugins_dir(std::path::PathBuf::from(dir));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    eprintln!("ui bridge on {port}");
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        tokio::spawn(serve(stream));
    }
}
