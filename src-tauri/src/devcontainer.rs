//! Dev containers: open a local folder inside the container its
//! `.devcontainer/devcontainer.json` describes.
//!
//! Sable reads the common parts of the spec — `image`, or `build`
//! (`dockerfile`, `context`, `args`); `workspaceFolder` and
//! `workspaceMount`; `containerEnv`; `runArgs`; `remoteUser`;
//! `overrideCommand`; `postCreateCommand` — builds or pulls the image, and
//! starts a container named for the folder (reused next time) with the
//! folder mounted. Then it connects to it like any running container
//! (src/remote.rs). Compose-based configs (`dockerComposeFile`) and
//! features aren't supported; Sable says so.

use crate::events::{emit, Events};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Where a folder's dev container config is, if it has one.
pub fn config_path(folder: &Path) -> Option<PathBuf> {
    [folder.join(".devcontainer").join("devcontainer.json"), folder.join(".devcontainer.json")]
        .into_iter()
        .find(|path| path.is_file())
}

/// JSON with comments and trailing commas (what devcontainer.json is).
pub fn parse_jsonc(text: &str) -> Result<Value, String> {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let c = chars[index];
        if in_string {
            out.push(c);
            if c == '\\' && index + 1 < chars.len() {
                out.push(chars[index + 1]);
                index += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' && chars.get(index + 1) == Some(&'/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        } else if c == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index += 2;
            continue;
        } else {
            out.push(c);
        }
        index += 1;
    }
    // Then commas before } or ] (comments are gone, so a trailing comma
    // followed by a comment is caught too).
    let chars: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(out.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if in_string {
            cleaned.push(c);
            if c == '\\' && index + 1 < chars.len() {
                cleaned.push(chars[index + 1]);
                index += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            cleaned.push(c);
        } else if c == ',' {
            let next = chars[index + 1..].iter().find(|next| !next.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                cleaned.push(c);
            }
        } else {
            cleaned.push(c);
        }
        index += 1;
    }
    serde_json::from_str(&cleaned).map_err(|error| format!("devcontainer.json is invalid: {error}"))
}

/// What to run, decided from the config.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The container's name (stable per folder, so it's reused).
    pub name: String,
    /// An image to pull/use, or one to build.
    pub image: String,
    pub build: Option<Build>,
    pub workspace_folder: String,
    /// `docker run` arguments, after `run -d --name <name>`.
    pub run_args: Vec<String>,
    pub user: Option<String>,
    pub post_create: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Build {
    pub dockerfile: PathBuf,
    pub context: PathBuf,
    pub args: Vec<(String, String)>,
}

fn short_hash(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// A command as one shell line (strings, arrays, or an object of them).
fn command_line(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Array(parts) => {
            let words: Vec<String> = parts.iter().filter_map(Value::as_str).map(|part| format!("'{}'", part.replace('\'', r"'\''"))).collect();
            (!words.is_empty()).then(|| words.join(" "))
        }
        Value::Object(commands) => {
            let lines: Vec<String> = commands.values().filter_map(command_line).collect();
            (!lines.is_empty()).then(|| lines.join(" && "))
        }
        _ => None,
    }
}

/// Plan the container for `folder` from its config.
pub fn plan(folder: &Path, config_file: &Path, config: &Value) -> Result<Plan, String> {
    if config.get("dockerComposeFile").is_some() {
        return Err("This dev container uses Docker Compose, which Sable doesn't support yet (image- and Dockerfile-based ones work)".into());
    }
    let folder_name = folder.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".into());
    let safe: String = folder_name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let hash = short_hash(&folder.to_string_lossy());
    let name = format!("sable-{}-{hash}", safe.trim_matches('-'));
    let config_dir = config_file.parent().unwrap_or(folder);
    let text = |key: &str| config.get(key).and_then(Value::as_str).map(str::to_string);

    let build_section = config.get("build").cloned().unwrap_or(Value::Null);
    let dockerfile = build_section.get("dockerfile").and_then(Value::as_str).map(str::to_string).or_else(|| text("dockerFile"));
    let (image, build) = match (text("image"), dockerfile) {
        (_, Some(dockerfile)) => {
            let context = build_section.get("context").and_then(Value::as_str).or_else(|| config.get("context").and_then(Value::as_str)).unwrap_or(".");
            let args = build_section
                .get("args")
                .and_then(Value::as_object)
                .map(|args| args.iter().map(|(key, value)| (key.clone(), value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))).collect())
                .unwrap_or_default();
            (
                format!("sable-dev-{hash}"),
                Some(Build { dockerfile: config_dir.join(dockerfile), context: config_dir.join(context), args }),
            )
        }
        (Some(image), None) => (image, None),
        (None, None) => return Err("devcontainer.json has neither an \"image\" nor a \"build\" Dockerfile".into()),
    };

    let workspace_folder = text("workspaceFolder").unwrap_or_else(|| format!("/workspaces/{folder_name}"));
    let mount = text("workspaceMount")
        .map(|mount| mount.replace("${localWorkspaceFolder}", &folder.to_string_lossy()).replace("${localWorkspaceFolderBasename}", &folder_name))
        .unwrap_or_else(|| format!("type=bind,source={},target={workspace_folder}", folder.to_string_lossy()));
    let mut run_args = vec!["--label".to_string(), format!("sable.devcontainer={}", folder.to_string_lossy()), "--mount".to_string(), mount];
    if let Some(Value::Object(env)) = config.get("containerEnv") {
        for (key, value) in env {
            run_args.push("-e".into());
            run_args.push(format!("{key}={}", value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())));
        }
    }
    if let Some(Value::Array(extra)) = config.get("runArgs") {
        run_args.extend(extra.iter().filter_map(Value::as_str).map(str::to_string));
    }
    // Keep it running whatever the image's command does (the spec's default).
    let override_command = config.get("overrideCommand").and_then(Value::as_bool).unwrap_or(true);
    if override_command {
        run_args.extend(["--entrypoint".to_string(), "/bin/sh".to_string()]);
    }
    run_args.push(image.clone());
    if override_command {
        run_args.extend(["-c".to_string(), "while sleep 1000; do :; done".to_string()]);
    }
    let user = text("remoteUser").or_else(|| text("containerUser"));
    let post_create = config.get("postCreateCommand").and_then(command_line);
    Ok(Plan { name, image, build, workspace_folder, run_args, user, post_create })
}

/// What the frontend needs to connect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub name: String,
    pub engine: String,
    pub user: Option<String>,
    pub workspace_folder: String,
    /// Set when the container was just created: run it once.
    pub post_create_command: Option<String>,
}

/// Run a container engine command, reporting its output lines as progress.
async fn run(engine: &Path, args: &[String], events: &Events, what: &str) -> Result<String, String> {
    let mut child = Command::new(engine)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Couldn't run {}: {error}", engine.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let progress = |events: Events, what: String, stream: Option<tokio::process::ChildStdout>| async move {
        let mut collected = String::new();
        if let Some(stream) = stream {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit(&events, "remote:status", json!({ "state": "connecting", "message": format!("{what}: {}", line.trim()) }));
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    };
    let errors = async move {
        let mut text = String::new();
        if let Some(stream) = stderr {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                text.push_str(&line);
                text.push('\n');
            }
        }
        text
    };
    let (output, error_text) = tokio::join!(progress(events.clone(), what.to_string(), stdout), errors);
    let status = child.wait().await.map_err(|error| error.to_string())?;
    if status.success() {
        Ok(output)
    } else {
        let last = error_text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("it failed").trim().to_string();
        Err(format!("{what} failed: {last}"))
    }
}

/// Start (creating if needed) the dev container for `folder`.
pub async fn up(events: Events, folder: &Path) -> Result<Started, String> {
    let config_file = config_path(folder).ok_or("This folder has no .devcontainer/devcontainer.json")?;
    let config = parse_jsonc(&std::fs::read_to_string(&config_file).map_err(|error| error.to_string())?)?;
    let plan = plan(folder, &config_file, &config)?;
    let (engine_name, engine) = ["docker", "podman"]
        .into_iter()
        .find_map(|name| crate::lsp::resolve_binary(name).map(|path| (name.to_string(), path)))
        .ok_or("Dev containers need Docker (or Podman) installed and running")?;
    let say = |message: String| emit(&events, "remote:status", json!({ "state": "connecting", "message": message }));

    // Already there? Start it if it's stopped.
    let existing = run(&engine, &["ps".into(), "-a".into(), "--filter".into(), format!("name=^{}$", plan.name), "--format".into(), "{{.State}}".into()], &events, "Docker")
        .await?;
    let state = existing.trim().to_lowercase();
    let mut created = false;
    if state.is_empty() {
        if let Some(build) = &plan.build {
            say("Building the dev container image…".into());
            let mut args = vec!["build".to_string(), "-t".into(), plan.image.clone(), "-f".into(), build.dockerfile.to_string_lossy().into_owned()];
            for (key, value) in &build.args {
                args.extend(["--build-arg".to_string(), format!("{key}={value}")]);
            }
            args.push(build.context.to_string_lossy().into_owned());
            run(&engine, &args, &events, "Building").await?;
        }
        say("Starting the dev container…".into());
        let mut args = vec!["run".to_string(), "-d".into(), "--name".into(), plan.name.clone()];
        args.extend(plan.run_args.iter().cloned());
        run(&engine, &args, &events, "Starting").await?;
        created = true;
    } else if !state.starts_with("running") {
        say("Starting the dev container…".into());
        run(&engine, &["start".into(), plan.name.clone()], &events, "Starting").await?;
    }
    Ok(Started {
        name: plan.name,
        engine: engine_name,
        user: plan.user,
        workspace_folder: plan.workspace_folder,
        post_create_command: if created { plan.post_create } else { None },
    })
}

/// Whether `folder` has a dev container config.
#[tauri::command]
pub fn devcontainer_exists(folder: String) -> bool {
    config_path(Path::new(&folder)).is_some()
}

/// Build/start the dev container for `folder`; the frontend then
/// connects to it (remote_connect with a container target).
#[tauri::command]
pub async fn devcontainer_up(window: tauri::WebviewWindow, folder: String) -> Result<Started, String> {
    up(crate::events::for_window(&window), Path::new(&folder)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_jsonc() {
        let value = parse_jsonc(
            r#"{
              // the image
              "image": "mcr.microsoft.com/devcontainers/rust:1", /* block */
              "url": "http://x//y",
              "list": [1, 2,],
              "after": [3, // a comment after a trailing comma
              ],
            }"#,
        )
        .unwrap();
        assert_eq!(value["image"], "mcr.microsoft.com/devcontainers/rust:1");
        assert_eq!(value["url"], "http://x//y");
        assert_eq!(value["list"], json!([1, 2]));
        assert_eq!(value["after"], json!([3]));
    }

    #[test]
    fn plans_image_and_dockerfile_containers() {
        let folder = Path::new("/home/me/My App");
        let config_file = folder.join(".devcontainer/devcontainer.json");
        let image = plan(
            folder,
            &config_file,
            &json!({ "image": "node:20", "containerEnv": { "A": "1" }, "runArgs": ["--cap-add=SYS_PTRACE"], "remoteUser": "node", "postCreateCommand": "npm install" }),
        )
        .unwrap();
        assert!(image.name.starts_with("sable-my-app-"));
        assert_eq!(image.image, "node:20");
        assert_eq!(image.workspace_folder, "/workspaces/My App");
        assert_eq!(image.user.as_deref(), Some("node"));
        assert_eq!(image.post_create.as_deref(), Some("npm install"));
        let args = image.run_args.join(" ");
        assert!(args.contains("--mount type=bind,source=/home/me/My App,target=/workspaces/My App"), "{args}");
        assert!(args.contains("-e A=1") && args.contains("--cap-add=SYS_PTRACE"));
        assert!(args.ends_with("--entrypoint /bin/sh node:20 -c while sleep 1000; do :; done"), "{args}");

        let built = plan(
            folder,
            &config_file,
            &json!({ "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "3" } }, "workspaceFolder": "/src", "overrideCommand": false, "postCreateCommand": ["pip", "install", "-e", "."] }),
        )
        .unwrap();
        let build = built.build.unwrap();
        assert_eq!(build.dockerfile, folder.join(".devcontainer/Dockerfile"));
        assert_eq!(build.context, folder.join(".devcontainer/.."));
        assert_eq!(build.args, vec![("V".to_string(), "3".to_string())]);
        assert!(built.image.starts_with("sable-dev-"));
        assert_eq!(built.workspace_folder, "/src");
        assert!(built.run_args.last().unwrap().starts_with("sable-dev-"), "no command override");
        assert_eq!(built.post_create.as_deref(), Some("'pip' 'install' '-e' '.'"));

        assert!(plan(folder, &config_file, &json!({ "dockerComposeFile": "x.yml" })).unwrap_err().contains("Compose"));
        assert!(plan(folder, &config_file, &json!({})).is_err());
    }
}
