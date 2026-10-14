//! GitHub pull requests and issues, through the GitHub CLI (`gh`) the user
//! already has — like VS Code's "GitHub Pull Requests and Issues". Sable
//! stores no tokens: `gh` is signed in (`gh auth login`) and does the
//! talking, run in the repository's folder so it knows which repository
//! (`{owner}/{repo}` placeholders). Remote workspaces run it on the remote
//! (the agent serves `github_call` too).
//!
//! One command, `github_call(root, op, args, ghPath)`, does everything; the
//! ops build `gh` arguments (`*_args` below, unit-tested) and turn gh's JSON
//! into the shapes the frontend shows (`parse_*`, tested on recorded output).
//! Errors are gh's own text (rate limits and sign-in called out).

use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// How long one gh call may take (merges and checkouts fetch).
const TIMEOUT: Duration = Duration::from_secs(120);

/// Fields of `gh pr list --json`.
const PR_LIST_FIELDS: &str =
    "number,title,author,labels,isDraft,statusCheckRollup,reviewDecision,headRefName,baseRefName,url,updatedAt,state";
/// Fields of `gh pr view --json`.
const PR_VIEW_FIELDS: &str = "number,title,body,author,state,isDraft,labels,assignees,reviewRequests,latestReviews,reviews,commits,statusCheckRollup,headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,mergeable,mergeStateStatus,url,createdAt,comments,reviewDecision,additions,deletions,changedFiles,milestone";
/// Fields of `gh issue list --json`.
const ISSUE_LIST_FIELDS: &str = "number,title,author,labels,milestone,assignees,updatedAt,url,state";
/// Fields of `gh issue view --json`.
const ISSUE_VIEW_FIELDS: &str = "number,title,body,author,state,stateReason,labels,assignees,milestone,comments,url,createdAt";

// --- Running gh ----------------------------------------------------------------------------

/// The gh to run: the `github.ghPath` setting, else `SABLE_GH_PATH`, else
/// gh found where GUI apps don't look (Homebrew…), else `gh` on PATH.
pub fn gh_program(setting: Option<&str>) -> String {
    if let Some(path) = setting.map(str::trim).filter(|path| !path.is_empty()) {
        return path.to_string();
    }
    if let Ok(path) = std::env::var("SABLE_GH_PATH") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    if let Some(found) = crate::lsp::resolve_binary("gh") {
        return found.to_string_lossy().into_owned();
    }
    for candidate in [r"C:\Program Files\GitHub CLI\gh.exe", r"C:\Program Files (x86)\GitHub CLI\gh.exe"] {
        if cfg!(windows) && Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "gh".to_string()
}

/// What a finished process printed.
#[derive(Debug)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

/// gh (or git) couldn't be started at all.
pub const MISSING: &str = "The GitHub CLI (gh) isn't installed or couldn't be started";

/// Run `program args…` in `cwd`, never prompting, with `stdin` fed in.
async fn run(program: &str, cwd: &str, args: &[String], stdin: Option<&str>) -> Result<Output, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    // Apps started from the Dock lack the shell's PATH: gh runs git and
    // credential helpers that live beside it (Homebrew).
    if let Ok(path) = std::env::var("PATH") {
        let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&path).collect();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            if !dirs.iter().any(|dir| dir == Path::new(extra)) {
                dirs.push(extra.into());
            }
        }
        if let Some(parent) = Path::new(program).parent().filter(|parent| !parent.as_os_str().is_empty()) {
            dirs.push(parent.to_path_buf());
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            command.env("PATH", joined);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound && !program.ends_with("git") {
            format!("{MISSING} ({program}: {error})")
        } else {
            format!("Couldn't run {program}: {error}")
        }
    })?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        tokio::spawn(async move {
            let _ = pipe.write_all(text.as_bytes()).await;
            let _ = pipe.shutdown().await;
        });
    }
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} took too long (over {} seconds)", TIMEOUT.as_secs()))?
        .map_err(|error| error.to_string())?;
    Ok(Output {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        success: output.status.success(),
    })
}

/// gh's error text, with rate limits and sign-in problems explained first.
pub fn gh_error(output: &Output) -> String {
    let text = format!("{}\n{}", output.stderr.trim(), output.stdout.trim()).trim().to_string();
    let lowered = text.to_lowercase();
    if lowered.contains("rate limit") {
        format!("GitHub's API rate limit was reached — try again in a few minutes.\n{text}")
    } else if lowered.contains("gh auth login") || lowered.contains("not logged into") || lowered.contains("http 401") {
        format!("Not signed in to GitHub — sign in with `gh auth login`.\n{text}")
    } else if text.is_empty() {
        "gh failed without saying why".to_string()
    } else {
        text
    }
}

/// Whether gh's failure means "not signed in".
pub fn is_auth_error(output: &Output) -> bool {
    let text = format!("{}{}", output.stderr, output.stdout).to_lowercase();
    text.contains("gh auth login") || text.contains("not logged into") || text.contains("http 401") || text.contains("authentication required")
}

struct Gh {
    program: String,
    cwd: String,
}

impl Gh {
    async fn output(&self, args: &[String], stdin: Option<&str>) -> Result<Output, String> {
        run(&self.program, &self.cwd, args, stdin).await
    }

    /// Run gh; its stdout, or its error.
    async fn text(&self, args: &[String], stdin: Option<&str>) -> Result<String, String> {
        let output = self.output(args, stdin).await?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(gh_error(&output))
        }
    }

    /// Run gh and parse its JSON.
    async fn json(&self, args: &[String], stdin: Option<&str>) -> Result<Value, String> {
        let text = self.text(args, stdin).await?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|error| format!("Couldn't read gh's output ({error}): {}", clip(&text)))
    }

    async fn git(&self, args: &[&str]) -> Result<String, String> {
        let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let output = run("git", &self.cwd, &args, None).await?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(output.stderr.trim().to_string())
        }
    }

    /// A GraphQL call. Variables: (name, value, typed) — typed ones go as
    /// `-F` (numbers, and the `{owner}`/`{repo}` placeholders gh fills in),
    /// the rest as raw strings (`-f`).
    async fn graphql(&self, query: &str, variables: &[(&str, String, bool)]) -> Result<Value, String> {
        let mut args = strings(&["api", "graphql", "-f"]);
        args.push(format!("query={query}"));
        for (name, value, typed) in variables {
            args.push(if *typed { "-F" } else { "-f" }.into());
            args.push(format!("{name}={value}"));
        }
        let value = self.json(&args, None).await?;
        if let Some(errors) = value.get("errors").and_then(Value::as_array).filter(|errors| !errors.is_empty()) {
            let messages: Vec<&str> = errors.iter().filter_map(|error| error.get("message").and_then(Value::as_str)).collect();
            return Err(messages.join("\n"));
        }
        Ok(value)
    }
}

fn clip(text: &str) -> String {
    text.chars().take(300).collect()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

// --- Arguments ---------------------------------------------------------------------------

/// The search a sidebar category stands for.
pub fn category_query(category: &str) -> &'static str {
    match category {
        "review" => "review-requested:@me",
        "assigned" => "assignee:@me",
        "created" => "author:@me",
        "mentioned" => "mentions:@me",
        _ => "",
    }
}

fn search_arg(category: &str, search: &str) -> Option<String> {
    let query = [category_query(category), search.trim()].iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" ");
    (!query.is_empty()).then_some(query)
}

/// `gh pr list` for a category ("review", "assigned", "created", "all") and search text.
pub fn list_prs_args(category: &str, search: &str, limit: u32) -> Vec<String> {
    let mut args = strings(&["pr", "list", "--state", "open", "--limit"]);
    args.push(limit.clamp(1, 1000).to_string());
    args.extend(strings(&["--json", PR_LIST_FIELDS]));
    if let Some(query) = search_arg(category, search) {
        args.push("--search".into());
        args.push(query);
    }
    args
}

/// `gh issue list` for a category ("assigned", "created", "mentioned", "open").
pub fn list_issues_args(category: &str, search: &str, limit: u32) -> Vec<String> {
    let mut args = strings(&["issue", "list", "--state", "open", "--limit"]);
    args.push(limit.clamp(1, 1000).to_string());
    args.extend(strings(&["--json", ISSUE_LIST_FIELDS]));
    if let Some(query) = search_arg(category, search) {
        args.push("--search".into());
        args.push(query);
    }
    args
}

/// `gh pr merge`: method "merge" | "squash" | "rebase".
pub fn merge_args(number: u64, method: &str, delete_branch: bool) -> Result<Vec<String>, String> {
    let flag = match method {
        "merge" => "--merge",
        "squash" => "--squash",
        "rebase" => "--rebase",
        other => return Err(format!("Unknown merge method {other}")),
    };
    let mut args = vec!["pr".into(), "merge".into(), number.to_string(), flag.into()];
    if delete_branch {
        args.push("--delete-branch".into());
    }
    Ok(args)
}

/// `gh pr create` (the body goes on stdin).
pub fn create_pr_args(title: &str, base: &str, head: &str, draft: bool, reviewers: &[String]) -> Vec<String> {
    let mut args = strings(&["pr", "create", "--title"]);
    args.push(title.to_string());
    args.extend(strings(&["--body-file", "-"]));
    if !base.is_empty() {
        args.push("--base".into());
        args.push(base.to_string());
    }
    if !head.is_empty() {
        args.push("--head".into());
        args.push(head.to_string());
    }
    if draft {
        args.push("--draft".into());
    }
    let reviewers: Vec<&str> = reviewers.iter().map(|reviewer| reviewer.trim()).filter(|reviewer| !reviewer.is_empty()).collect();
    if !reviewers.is_empty() {
        args.push("--reviewer".into());
        args.push(reviewers.join(","));
    }
    args
}

/// `gh issue create` (the body goes on stdin).
pub fn create_issue_args(title: &str, labels: &[String], assignees: &[String]) -> Vec<String> {
    let mut args = strings(&["issue", "create", "--title"]);
    args.push(title.to_string());
    args.extend(strings(&["--body-file", "-"]));
    for (flag, values) in [("--label", labels), ("--assignee", assignees)] {
        let values: Vec<&str> = values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()).collect();
        if !values.is_empty() {
            args.push(flag.into());
            args.push(values.join(","));
        }
    }
    args
}

/// `gh issue edit` / `gh pr edit` adding and removing labels and assignees.
pub fn edit_args(kind: &str, number: u64, changes: &Value) -> Vec<String> {
    let mut args = vec![kind.to_string(), "edit".into(), number.to_string()];
    for (key, flag) in [
        ("addLabels", "--add-label"),
        ("removeLabels", "--remove-label"),
        ("addAssignees", "--add-assignee"),
        ("removeAssignees", "--remove-assignee"),
    ] {
        let values: Vec<&str> = changes.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        if !values.is_empty() {
            args.push(flag.into());
            args.push(values.join(","));
        }
    }
    args
}

/// A file's path in a URL (`contents/<path>`): each segment escaped.
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            segment
                .bytes()
                .map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
                    _ => format!("%{byte:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The JSON for `POST /pulls/{n}/reviews`: the event, its body and the
/// pending line comments (a range has `startLine`).
pub fn review_body(commit_id: &str, event: &str, body: &str, comments: &[Value]) -> Result<Value, String> {
    let event = match event {
        "approve" | "APPROVE" => "APPROVE",
        "requestChanges" | "REQUEST_CHANGES" => "REQUEST_CHANGES",
        "comment" | "COMMENT" => "COMMENT",
        other => return Err(format!("Unknown review event {other}")),
    };
    if event == "REQUEST_CHANGES" && body.trim().is_empty() && comments.is_empty() {
        return Err("Say what should change: requesting changes needs a comment".into());
    }
    if event == "COMMENT" && body.trim().is_empty() && comments.is_empty() {
        return Err("Write a comment first".into());
    }
    let comments: Vec<Value> = comments
        .iter()
        .map(|comment| {
            let side = comment.get("side").and_then(Value::as_str).unwrap_or("RIGHT");
            let mut out = json!({
                "path": comment.get("path").and_then(Value::as_str).unwrap_or(""),
                "line": comment.get("line").and_then(Value::as_u64).unwrap_or(1),
                "side": side,
                "body": comment.get("body").and_then(Value::as_str).unwrap_or(""),
            });
            let line = out["line"].as_u64().unwrap_or(1);
            if let Some(start) = comment.get("startLine").and_then(Value::as_u64).filter(|start| *start < line) {
                out["start_line"] = json!(start);
                out["start_side"] = json!(comment.get("startSide").and_then(Value::as_str).unwrap_or(side));
            }
            out
        })
        .collect();
    let mut review = json!({ "event": event, "body": body, "comments": comments });
    if !commit_id.is_empty() {
        review["commit_id"] = json!(commit_id);
    }
    Ok(review)
}

// --- Parsing ------------------------------------------------------------------------------

/// One check (a CheckRun or a commit StatusContext).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// "success" | "failure" | "pending" | "neutral" | "skipped"
    pub state: String,
    pub description: String,
    pub url: String,
    pub workflow: String,
}

/// One entry of `statusCheckRollup`.
pub fn parse_check(item: &Value) -> Check {
    let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let is_status = item.get("__typename").and_then(Value::as_str) == Some("StatusContext") || item.get("context").is_some();
    if is_status {
        let state = match text("state").as_str() {
            "SUCCESS" => "success",
            "FAILURE" | "ERROR" => "failure",
            _ => "pending",
        };
        return Check { name: text("context"), state: state.into(), description: text("description"), url: text("targetUrl"), workflow: String::new() };
    }
    let state = if text("status") != "COMPLETED" && !text("status").is_empty() {
        "pending"
    } else {
        match text("conclusion").as_str() {
            "SUCCESS" => "success",
            "NEUTRAL" => "neutral",
            "SKIPPED" => "skipped",
            "" => "pending",
            _ => "failure",
        }
    };
    Check { name: text("name"), state: state.into(), description: text("conclusion").to_lowercase(), url: text("detailsUrl"), workflow: text("workflowName") }
}

/// The checks of a rollup, and their overall state ("success", "failure",
/// "pending", or "none" without checks).
pub fn check_summary(rollup: &Value) -> (Vec<Check>, &'static str) {
    let checks: Vec<Check> = rollup.as_array().into_iter().flatten().map(parse_check).collect();
    let state = if checks.is_empty() {
        "none"
    } else if checks.iter().any(|check| check.state == "failure") {
        "failure"
    } else if checks.iter().any(|check| check.state == "pending") {
        "pending"
    } else {
        "success"
    };
    (checks, state)
}

fn login(value: &Value) -> String {
    value.get("login").and_then(Value::as_str).unwrap_or("ghost").to_string()
}

fn labels(value: &Value) -> Value {
    Value::Array(
        value
            .get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|label| json!({ "name": label.get("name").and_then(Value::as_str).unwrap_or(""), "color": label.get("color").and_then(Value::as_str).unwrap_or("8b949e") }))
            .collect(),
    )
}

fn logins(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().map(login).collect()
}

fn str_of(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// A pull request as the sidebar lists it.
pub fn parse_pr_summary(pr: &Value) -> Value {
    let (_, checks) = check_summary(pr.get("statusCheckRollup").unwrap_or(&Value::Null));
    json!({
        "number": pr.get("number").and_then(Value::as_u64).unwrap_or(0),
        "title": str_of(pr, "title"),
        "author": login(pr.get("author").unwrap_or(&Value::Null)),
        "labels": labels(pr),
        "isDraft": pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        "checks": checks,
        "reviewDecision": str_of(pr, "reviewDecision"),
        "headRefName": str_of(pr, "headRefName"),
        "baseRefName": str_of(pr, "baseRefName"),
        "url": str_of(pr, "url"),
        "updatedAt": str_of(pr, "updatedAt"),
        "state": str_of(pr, "state"),
    })
}

/// An issue as the sidebar lists it.
pub fn parse_issue_summary(issue: &Value) -> Value {
    json!({
        "number": issue.get("number").and_then(Value::as_u64).unwrap_or(0),
        "title": str_of(issue, "title"),
        "author": login(issue.get("author").unwrap_or(&Value::Null)),
        "labels": labels(issue),
        "milestone": issue.get("milestone").and_then(|milestone| milestone.get("title")).and_then(Value::as_str),
        "assignees": logins(issue.get("assignees")),
        "updatedAt": str_of(issue, "updatedAt"),
        "url": str_of(issue, "url"),
        "state": str_of(issue, "state"),
    })
}

fn comment_entry(comment: &Value) -> Value {
    json!({
        "kind": "comment",
        "id": str_of(comment, "id"),
        "author": login(comment.get("author").unwrap_or(&Value::Null)),
        "body": str_of(comment, "body"),
        "createdAt": str_of(comment, "createdAt"),
        "url": str_of(comment, "url"),
    })
}

/// `gh pr view --json …`: the details tab's data, with reviewers merged
/// (requested + latest reviews) and a timeline (comments and reviews, oldest first).
pub fn parse_pr_details(pr: &Value) -> Value {
    let (checks, check_state) = check_summary(pr.get("statusCheckRollup").unwrap_or(&Value::Null));
    // Reviewers: latest review states, then requested ones (re-requested wins).
    let mut reviewers: Vec<(String, String)> = Vec::new();
    for review in pr.get("latestReviews").and_then(Value::as_array).into_iter().flatten() {
        let who = login(review.get("author").unwrap_or(&Value::Null));
        reviewers.push((who, str_of(review, "state")));
    }
    for request in pr.get("reviewRequests").and_then(Value::as_array).into_iter().flatten() {
        let who = request
            .get("login")
            .and_then(Value::as_str)
            .or_else(|| request.get("slug").and_then(Value::as_str))
            .or_else(|| request.get("name").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        if who.is_empty() {
            continue;
        }
        match reviewers.iter_mut().find(|(name, _)| *name == who) {
            Some(entry) => entry.1 = "REQUESTED".into(),
            None => reviewers.push((who, "REQUESTED".into())),
        }
    }
    let mut timeline: Vec<Value> = pr.get("comments").and_then(Value::as_array).into_iter().flatten().map(comment_entry).collect();
    for review in pr.get("reviews").and_then(Value::as_array).into_iter().flatten() {
        let state = str_of(review, "state");
        let body = str_of(review, "body");
        // Reviews that only carry line comments show as their threads.
        if state == "PENDING" || (state == "COMMENTED" && body.trim().is_empty()) {
            continue;
        }
        timeline.push(json!({
            "kind": "review",
            "id": str_of(review, "id"),
            "author": login(review.get("author").unwrap_or(&Value::Null)),
            "body": body,
            "state": state,
            "createdAt": str_of(review, "submittedAt"),
            "url": "",
        }));
    }
    timeline.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
    let commits: Vec<Value> = pr
        .get("commits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|commit| {
            let author = commit
                .get("authors")
                .and_then(Value::as_array)
                .and_then(|authors| authors.first())
                .map(|author| author.get("login").and_then(Value::as_str).filter(|login| !login.is_empty()).or_else(|| author.get("name").and_then(Value::as_str)).unwrap_or("").to_string())
                .unwrap_or_default();
            json!({
                "oid": str_of(commit, "oid"),
                "headline": str_of(commit, "messageHeadline"),
                "author": author,
                "date": str_of(commit, "committedDate"),
            })
        })
        .collect();
    json!({
        "number": pr.get("number").and_then(Value::as_u64).unwrap_or(0),
        "title": str_of(pr, "title"),
        "body": str_of(pr, "body"),
        "author": login(pr.get("author").unwrap_or(&Value::Null)),
        "state": str_of(pr, "state"),
        "isDraft": pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        "labels": labels(pr),
        "assignees": logins(pr.get("assignees")),
        "reviewers": reviewers.into_iter().map(|(login, state)| json!({ "login": login, "state": state })).collect::<Vec<_>>(),
        "checks": checks,
        "checkState": check_state,
        "commits": commits,
        "headRefName": str_of(pr, "headRefName"),
        "baseRefName": str_of(pr, "baseRefName"),
        "headRefOid": str_of(pr, "headRefOid"),
        "baseRefOid": str_of(pr, "baseRefOid"),
        "isCrossRepository": pr.get("isCrossRepository").and_then(Value::as_bool).unwrap_or(false),
        "mergeable": str_of(pr, "mergeable"),
        "mergeStateStatus": str_of(pr, "mergeStateStatus"),
        "reviewDecision": str_of(pr, "reviewDecision"),
        "url": str_of(pr, "url"),
        "createdAt": str_of(pr, "createdAt"),
        "additions": pr.get("additions").and_then(Value::as_u64).unwrap_or(0),
        "deletions": pr.get("deletions").and_then(Value::as_u64).unwrap_or(0),
        "changedFiles": pr.get("changedFiles").and_then(Value::as_u64).unwrap_or(0),
        "milestone": pr.get("milestone").and_then(|milestone| milestone.get("title")).and_then(Value::as_str),
        "timeline": timeline,
    })
}

/// `gh issue view --json …`.
pub fn parse_issue_details(issue: &Value) -> Value {
    json!({
        "number": issue.get("number").and_then(Value::as_u64).unwrap_or(0),
        "title": str_of(issue, "title"),
        "body": str_of(issue, "body"),
        "author": login(issue.get("author").unwrap_or(&Value::Null)),
        "state": str_of(issue, "state"),
        "stateReason": str_of(issue, "stateReason"),
        "labels": labels(issue),
        "assignees": logins(issue.get("assignees")),
        "milestone": issue.get("milestone").and_then(|milestone| milestone.get("title")).and_then(Value::as_str),
        "comments": issue.get("comments").and_then(Value::as_array).into_iter().flatten().map(comment_entry).collect::<Vec<_>>(),
        "url": str_of(issue, "url"),
        "createdAt": str_of(issue, "createdAt"),
    })
}

/// `gh api --paginate` output: one JSON value per page (arrays are joined).
pub fn parse_pages(text: &str) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for page in serde_json::Deserializer::from_str(text).into_iter::<Value>() {
        match page.map_err(|error| format!("Couldn't read gh's output ({error})"))? {
            Value::Array(values) => items.extend(values),
            other => items.push(other),
        }
    }
    Ok(items)
}

/// `GET /pulls/{n}/files` entries.
pub fn parse_files(text: &str) -> Result<Vec<Value>, String> {
    Ok(parse_pages(text)?
        .iter()
        .map(|file| {
            json!({
                "path": str_of(file, "filename"),
                "previousPath": file.get("previous_filename").and_then(Value::as_str),
                "status": str_of(file, "status"),
                "additions": file.get("additions").and_then(Value::as_u64).unwrap_or(0),
                "deletions": file.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect())
}

/// The review threads query's answer: threads with their comments, which
/// files the viewer marked viewed, and the pull request's node id.
pub fn parse_threads(value: &Value) -> Value {
    let pr = &value["data"]["repository"]["pullRequest"];
    let threads: Vec<Value> = pr["reviewThreads"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|thread| {
            let comments: Vec<Value> = thread["comments"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|comment| {
                    json!({
                        "id": str_of(comment, "id"),
                        "databaseId": comment.get("databaseId").and_then(Value::as_u64).unwrap_or(0),
                        "author": login(comment.get("author").unwrap_or(&Value::Null)),
                        "body": str_of(comment, "body"),
                        "createdAt": str_of(comment, "createdAt"),
                        "url": str_of(comment, "url"),
                    })
                })
                .collect();
            // Outdated threads have no current line: use the original one.
            let line = thread.get("line").and_then(Value::as_u64).or_else(|| thread.get("originalLine").and_then(Value::as_u64));
            let start = thread.get("startLine").and_then(Value::as_u64).or_else(|| thread.get("originalStartLine").and_then(Value::as_u64));
            json!({
                "id": str_of(thread, "id"),
                "path": str_of(thread, "path"),
                "line": line,
                "startLine": start,
                "side": thread.get("diffSide").and_then(Value::as_str).unwrap_or("RIGHT"),
                "isResolved": thread.get("isResolved").and_then(Value::as_bool).unwrap_or(false),
                "isOutdated": thread.get("isOutdated").and_then(Value::as_bool).unwrap_or(false),
                "comments": comments,
            })
        })
        .collect();
    let mut viewed = serde_json::Map::new();
    for file in pr["files"]["nodes"].as_array().into_iter().flatten() {
        viewed.insert(str_of(file, "path"), json!(file.get("viewerViewedState").and_then(Value::as_str) == Some("VIEWED")));
    }
    json!({ "pullId": str_of(pr, "id"), "threads": threads, "viewed": viewed })
}

/// The number at the end of a pull request / issue URL gh printed.
pub fn number_from_url(text: &str) -> Option<u64> {
    let url = text.lines().map(str::trim).rev().find(|line| line.starts_with("http"))?;
    url.trim_end_matches('/').rsplit('/').next()?.parse().ok()
}

/// `git log --format=%H%x1f%s%x1f%b%x1e` → commits.
pub fn parse_log(text: &str) -> Vec<Value> {
    text.split('\u{1e}')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').splitn(3, '\u{1f}');
            let hash = fields.next()?.trim();
            if hash.is_empty() {
                return None;
            }
            Some(json!({ "hash": hash, "subject": fields.next().unwrap_or(""), "body": fields.next().unwrap_or("").trim() }))
        })
        .collect()
}

/// An issue template (`.github/ISSUE_TEMPLATE/*.md`): its front matter
/// (name, about, title, labels, assignees) and body.
pub fn parse_template(file_name: &str, text: &str) -> Value {
    let text = text.replace("\r\n", "\n");
    let (front, body) = match text.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---")) {
        Some((front, rest)) => (front.to_string(), rest.trim_start_matches(|c| c != '\n').trim_start_matches('\n').to_string()),
        None => (String::new(), text.clone()),
    };
    let mut fields = serde_json::Map::new();
    let mut list_key: Option<String> = None;
    for line in front.lines() {
        if let (Some(key), Some(item)) = (&list_key, line.trim_start().strip_prefix("- ")) {
            if let Some(Value::Array(items)) = fields.get_mut(key) {
                items.push(json!(unquote(item)));
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let (key, value) = (key.trim().to_string(), value.trim());
        if value.is_empty() {
            fields.insert(key.clone(), json!([]));
            list_key = Some(key);
        } else {
            list_key = None;
            fields.insert(key, json!(unquote(value)));
        }
    }
    let list = |key: &str| -> Vec<String> {
        match fields.get(key) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(text)) => text
                .trim_matches(|c| c == '[' || c == ']')
                .split(',')
                .map(|item| unquote(item.trim()))
                .filter(|item| !item.is_empty())
                .collect(),
            _ => Vec::new(),
        }
    };
    let text_field = |key: &str| fields.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let name = text_field("name");
    json!({
        "file": file_name,
        "name": if name.is_empty() { file_name.trim_end_matches(".md").replace(['-', '_'], " ") } else { name },
        "about": text_field("about"),
        "title": text_field("title"),
        "labels": list("labels"),
        "assignees": list("assignees"),
        "body": body,
    })
}

fn unquote(text: &str) -> String {
    let text = text.trim();
    for quote in ['"', '\''] {
        if text.len() >= 2 && text.starts_with(quote) && text.ends_with(quote) {
            return text[1..text.len() - 1].to_string();
        }
    }
    text.to_string()
}

// --- Ops -----------------------------------------------------------------------------------

fn arg_str<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arg_number(args: &Value, key: &str) -> Result<u64, String> {
    args.get(key).and_then(Value::as_u64).ok_or_else(|| format!("argument {key}: a number is needed"))
}

fn arg_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

const THREADS_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id files(first: 100) { nodes { path viewerViewedState } } reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine startLine originalStartLine diffSide comments(first: 100) { nodes { id databaseId body createdAt url author { login } } } } } } } }";

/// Do one GitHub operation in the repository at `root`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn github_call(root: String, op: String, args: Value, gh_path: Option<String>) -> Result<Value, String> {
    let gh = Gh { program: gh_program(gh_path.as_deref()), cwd: root.clone() };
    let args = if args.is_null() { json!({}) } else { args };
    match op.as_str() {
        // Is gh there, signed in, and is this a GitHub repository?
        "status" => {
            let version = match gh.output(&strings(&["--version"]), None).await {
                Ok(output) if output.success => output.stdout.lines().next().unwrap_or("").to_string(),
                Ok(output) => return Ok(json!({ "installed": false, "error": gh_error(&output) })),
                Err(error) => return Ok(json!({ "installed": false, "error": error })),
            };
            let user = gh.output(&strings(&["api", "user"]), None).await?;
            if !user.success {
                let signed_out = is_auth_error(&user);
                return Ok(json!({ "installed": true, "version": version, "loggedIn": false, "authProblem": signed_out, "error": gh_error(&user) }));
            }
            let user: Value = serde_json::from_str(&user.stdout).unwrap_or(Value::Null);
            let top_level = gh.git(&["rev-parse", "--show-toplevel"]).await.map(|text| text.trim().to_string()).ok();
            let repo = gh.json(&strings(&["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission"]), None).await;
            let (repo, repo_error) = match repo {
                Ok(repo) => (
                    Some(json!({
                        "nameWithOwner": str_of(&repo, "nameWithOwner"),
                        "url": str_of(&repo, "url"),
                        "defaultBranch": repo["defaultBranchRef"]["name"].as_str().unwrap_or("main"),
                        "viewerPermission": str_of(&repo, "viewerPermission"),
                    })),
                    None,
                ),
                Err(error) => (None, Some(error)),
            };
            Ok(json!({
                "installed": true,
                "version": version,
                "loggedIn": true,
                "user": { "login": str_of(&user, "login"), "name": str_of(&user, "name"), "avatarUrl": str_of(&user, "avatar_url") },
                "repo": repo,
                "repoError": repo_error,
                "topLevel": top_level,
            }))
        }
        "list_prs" => {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as u32;
            let value = gh.json(&list_prs_args(arg_str(&args, "category"), arg_str(&args, "search"), limit), None).await?;
            Ok(Value::Array(value.as_array().into_iter().flatten().map(parse_pr_summary).collect()))
        }
        "list_issues" => {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as u32;
            let value = gh.json(&list_issues_args(arg_str(&args, "category"), arg_str(&args, "search"), limit), None).await?;
            Ok(Value::Array(value.as_array().into_iter().flatten().map(parse_issue_summary).collect()))
        }
        "pr_view" => {
            let number = arg_number(&args, "number")?;
            let value = gh.json(&["pr".into(), "view".into(), number.to_string(), "--json".into(), PR_VIEW_FIELDS.into()], None).await?;
            Ok(parse_pr_details(&value))
        }
        // The current branch's pull request, or null.
        "pr_for_branch" => {
            let output = gh.output(&strings(&["pr", "view", "--json", "number,title,state,url,isDraft,headRefName,statusCheckRollup"]), None).await?;
            if !output.success {
                let text = gh_error(&output);
                let lowered = text.to_lowercase();
                if lowered.contains("no pull requests found") || lowered.contains("no default remote") || lowered.contains("could not determine current branch") || lowered.contains("not on any branch") {
                    return Ok(Value::Null);
                }
                return Err(text);
            }
            let value: Value = serde_json::from_str(&output.stdout).map_err(|error| error.to_string())?;
            Ok(parse_pr_summary(&value))
        }
        "pr_files" => {
            let number = arg_number(&args, "number")?;
            let text = gh.text(&[ "api".into(), format!("repos/{{owner}}/{{repo}}/pulls/{number}/files?per_page=100"), "--paginate".into()], None).await?;
            Ok(Value::Array(parse_files(&text)?))
        }
        "pr_threads" => {
            let number = arg_number(&args, "number")?;
            let value = gh
                .graphql(THREADS_QUERY, &[("owner", "{owner}".into(), true), ("name", "{repo}".into(), true), ("number", number.to_string(), true)])
                .await?;
            Ok(parse_threads(&value))
        }
        // A file at a commit: from the local repository when it has the
        // commit, else from GitHub. Missing → empty.
        "file_text" => {
            let reference = arg_str(&args, "ref");
            let path = arg_str(&args, "path");
            if reference.is_empty() || path.is_empty() {
                return Err("file_text needs ref and path".into());
            }
            let local = run("git", &root, &["show".into(), format!("{reference}:{path}")], None).await;
            let text = match local {
                Ok(output) if output.success => output.stdout,
                _ => {
                    let output = gh
                        .output(
                            &[
                                "api".into(),
                                format!("repos/{{owner}}/{{repo}}/contents/{}?ref={reference}", encode_path(path)),
                                "-H".into(),
                                "Accept: application/vnd.github.raw".into(),
                            ],
                            None,
                        )
                        .await?;
                    if output.success {
                        output.stdout
                    } else if output.stderr.contains("404") || output.stdout.contains("Not Found") {
                        String::new()
                    } else {
                        return Err(gh_error(&output));
                    }
                }
            };
            Ok(json!({ "text": text, "binary": text.contains('\0') }))
        }
        // Where a pull request's head left its base (what GitHub diffs
        // against): locally when both commits are here, else from GitHub.
        "merge_base" => {
            let (base, head) = (arg_str(&args, "base"), arg_str(&args, "head"));
            if let Ok(text) = gh.git(&["merge-base", base, head]).await {
                return Ok(json!(text.trim()));
            }
            let text = gh.text(&["api".into(), format!("repos/{{owner}}/{{repo}}/compare/{base}...{head}"), "--jq".into(), ".merge_base_commit.sha".into()], None).await?;
            Ok(json!(text.trim()))
        }
        "pr_checkout" => {
            let number = arg_number(&args, "number")?;
            Ok(json!(gh.text(&["pr".into(), "checkout".into(), number.to_string()], None).await?.trim()))
        }
        "pr_review" => {
            let number = arg_number(&args, "number")?;
            let comments: Vec<Value> = args.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
            let body = review_body(arg_str(&args, "commitId"), arg_str(&args, "event"), arg_str(&args, "body"), &comments)?;
            gh.json(
                &["api".into(), format!("repos/{{owner}}/{{repo}}/pulls/{number}/reviews"), "--method".into(), "POST".into(), "--input".into(), "-".into()],
                Some(&body.to_string()),
            )
            .await
        }
        "pr_reply" => {
            let number = arg_number(&args, "number")?;
            let comment = arg_number(&args, "commentId")?;
            let body = json!({ "body": arg_str(&args, "body") });
            gh.json(
                &["api".into(), format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments/{comment}/replies"), "--method".into(), "POST".into(), "--input".into(), "-".into()],
                Some(&body.to_string()),
            )
            .await
        }
        "thread_resolve" => {
            let thread = arg_str(&args, "threadId");
            let resolve = args.get("resolve").and_then(Value::as_bool).unwrap_or(true);
            let mutation = if resolve { "resolveReviewThread" } else { "unresolveReviewThread" };
            let query = format!("mutation($id: ID!) {{ {mutation}(input: {{threadId: $id}}) {{ thread {{ id isResolved }} }} }}");
            gh.graphql(&query, &[("id", thread.to_string(), false)]).await
        }
        "mark_viewed" => {
            let viewed = args.get("viewed").and_then(Value::as_bool).unwrap_or(true);
            let mutation = if viewed { "markFileAsViewed" } else { "unmarkFileAsViewed" };
            let query = format!("mutation($id: ID!, $path: String!) {{ {mutation}(input: {{pullRequestId: $id, path: $path}}) {{ clientMutationId }} }}");
            gh.graphql(&query, &[("id", arg_str(&args, "pullId").to_string(), false), ("path", arg_str(&args, "path").to_string(), false)]).await
        }
        "pr_merge" => {
            let number = arg_number(&args, "number")?;
            let merge = merge_args(number, arg_str(&args, "method"), args.get("deleteBranch").and_then(Value::as_bool).unwrap_or(false))?;
            Ok(json!(gh.text(&merge, None).await?.trim()))
        }
        // close | reopen | ready | draft, on a pr or an issue.
        "set_state" => {
            let number = arg_number(&args, "number")?.to_string();
            let kind = if arg_str(&args, "kind") == "issue" { "issue" } else { "pr" };
            let command: Vec<String> = match arg_str(&args, "action") {
                "close" => vec![kind.into(), "close".into(), number],
                "reopen" => vec![kind.into(), "reopen".into(), number],
                "ready" if kind == "pr" => vec!["pr".into(), "ready".into(), number],
                "draft" if kind == "pr" => vec!["pr".into(), "ready".into(), number, "--undo".into()],
                other => return Err(format!("Unknown action {other}")),
            };
            Ok(json!(gh.text(&command, None).await?.trim()))
        }
        "comment" => {
            let number = arg_number(&args, "number")?;
            let kind = if arg_str(&args, "kind") == "issue" { "issue" } else { "pr" };
            let body = arg_str(&args, "body");
            if body.trim().is_empty() {
                return Err("Write a comment first".into());
            }
            Ok(json!(gh.text(&[kind.into(), "comment".into(), number.to_string(), "--body-file".into(), "-".into()], Some(body)).await?.trim()))
        }
        "edit" => {
            let number = arg_number(&args, "number")?;
            let kind = if arg_str(&args, "kind") == "issue" { "issue" } else { "pr" };
            let command = edit_args(kind, number, &args);
            if command.len() == 3 {
                return Ok(Value::Null);
            }
            Ok(json!(gh.text(&command, None).await?.trim()))
        }
        "pr_create" => {
            let title = arg_str(&args, "title");
            if title.trim().is_empty() {
                return Err("A pull request needs a title".into());
            }
            let command = create_pr_args(title, arg_str(&args, "base"), arg_str(&args, "head"), args.get("draft").and_then(Value::as_bool).unwrap_or(false), &arg_list(&args, "reviewers"));
            let text = gh.text(&command, Some(arg_str(&args, "body"))).await?;
            Ok(json!({ "url": text.trim().lines().last().unwrap_or(""), "number": number_from_url(&text) }))
        }
        "issue_create" => {
            let title = arg_str(&args, "title");
            if title.trim().is_empty() {
                return Err("An issue needs a title".into());
            }
            let command = create_issue_args(title, &arg_list(&args, "labels"), &arg_list(&args, "assignees"));
            let text = gh.text(&command, Some(arg_str(&args, "body"))).await?;
            Ok(json!({ "url": text.trim().lines().last().unwrap_or(""), "number": number_from_url(&text) }))
        }
        "issue_view" => {
            let number = arg_number(&args, "number")?;
            let value = gh.json(&["issue".into(), "view".into(), number.to_string(), "--json".into(), ISSUE_VIEW_FIELDS.into()], None).await?;
            Ok(parse_issue_details(&value))
        }
        "labels" => {
            let value = gh.json(&strings(&["label", "list", "--limit", "300", "--json", "name,color,description"]), None).await?;
            Ok(Value::Array(value.as_array().into_iter().flatten().map(|label| json!({ "name": str_of(label, "name"), "color": str_of(label, "color") })).collect()))
        }
        "assignees" => {
            let text = gh.text(&strings(&["api", "repos/{owner}/{repo}/assignees?per_page=100", "--paginate"]), None).await?;
            Ok(Value::Array(parse_pages(&text)?.iter().map(|user| json!(login(user))).collect()))
        }
        "issue_templates" => {
            let top = gh.git(&["rev-parse", "--show-toplevel"]).await.map(|text| text.trim().to_string()).unwrap_or(root.clone());
            let dir = Path::new(&top).join(".github").join("ISSUE_TEMPLATE");
            let mut templates: Vec<Value> = Vec::new();
            let mut entries: Vec<_> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|entry| entry.path()).collect();
            entries.sort();
            for path in entries {
                let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                if !name.to_lowercase().ends_with(".md") {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&path) {
                    templates.push(parse_template(&name, &text));
                }
            }
            Ok(Value::Array(templates))
        }
        // For "Create Pull Request": the branch, whether it's pushed, its
        // commits since `base`, and the repository's PR template.
        "branch_info" => {
            let base = arg_str(&args, "base");
            let branch = gh.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await?.trim().to_string();
            let upstream = gh.git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.ok().map(|text| text.trim().to_string());
            let base_ref = if base.is_empty() {
                None
            } else if gh.git(&["rev-parse", "--verify", "--quiet", &format!("origin/{base}")]).await.is_ok() {
                Some(format!("origin/{base}"))
            } else if gh.git(&["rev-parse", "--verify", "--quiet", base]).await.is_ok() {
                Some(base.to_string())
            } else {
                None
            };
            let commits = match &base_ref {
                Some(base_ref) => parse_log(&gh.git(&["log", "--max-count=100", "--format=%H%x1f%s%x1f%b%x1e", &format!("{base_ref}..HEAD")]).await.unwrap_or_default()),
                None => Vec::new(),
            };
            let unpushed = match &upstream {
                Some(_) => gh.git(&["rev-list", "--count", "@{u}..HEAD"]).await.ok().and_then(|text| text.trim().parse::<u64>().ok()).unwrap_or(0),
                None => commits.len() as u64,
            };
            let top = gh.git(&["rev-parse", "--show-toplevel"]).await.map(|text| text.trim().to_string()).unwrap_or(root.clone());
            let template = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "docs/pull_request_template.md"]
                .iter()
                .find_map(|name| std::fs::read_to_string(Path::new(&top).join(name)).ok());
            Ok(json!({ "branch": branch, "upstream": upstream, "unpushed": unpushed, "commits": commits, "template": template }))
        }
        other => Err(format!("Unknown GitHub operation {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn pr_list_arguments_per_category() {
        let args = list_prs_args("review", "", 50);
        assert_eq!(&args[..5], &to_strings(&["pr", "list", "--state", "open", "--limit"])[..]);
        assert_eq!(args[5], "50");
        assert_eq!(args[args.len() - 2..], to_strings(&["--search", "review-requested:@me"])[..]);
        let args = list_prs_args("created", " login bug ", 100);
        assert_eq!(args.last().unwrap(), "author:@me login bug");
        // "All open" without search text: no --search at all.
        assert!(!list_prs_args("all", "", 100).contains(&"--search".to_string()));
        assert_eq!(list_prs_args("all", "fix", 100).last().unwrap(), "fix");
        assert_eq!(list_issues_args("mentioned", "", 10).last().unwrap(), "mentions:@me");
        assert_eq!(list_issues_args("assigned", "", 10).last().unwrap(), "assignee:@me");
        assert_eq!(list_prs_args("all", "", 0)[5], "1");
    }

    #[test]
    fn merge_create_and_edit_arguments() {
        assert_eq!(merge_args(7, "squash", true).unwrap(), to_strings(&["pr", "merge", "7", "--squash", "--delete-branch"]));
        assert_eq!(merge_args(7, "rebase", false).unwrap(), to_strings(&["pr", "merge", "7", "--rebase"]));
        assert!(merge_args(7, "octopus", false).is_err());
        assert_eq!(
            create_pr_args("Add login", "main", "feature/login", true, &to_strings(&["alice", " ", "bob"])),
            to_strings(&["pr", "create", "--title", "Add login", "--body-file", "-", "--base", "main", "--head", "feature/login", "--draft", "--reviewer", "alice,bob"])
        );
        assert_eq!(create_pr_args("T", "", "", false, &[]), to_strings(&["pr", "create", "--title", "T", "--body-file", "-"]));
        assert_eq!(
            create_issue_args("Crash", &to_strings(&["bug", "p1"]), &to_strings(&["octocat"])),
            to_strings(&["issue", "create", "--title", "Crash", "--body-file", "-", "--label", "bug,p1", "--assignee", "octocat"])
        );
        let changes = json!({ "addLabels": ["bug"], "removeLabels": ["triage", "wontfix"], "addAssignees": [], "removeAssignees": ["bob"] });
        assert_eq!(
            edit_args("issue", 12, &changes),
            to_strings(&["issue", "edit", "12", "--add-label", "bug", "--remove-label", "triage,wontfix", "--remove-assignee", "bob"])
        );
    }

    #[test]
    fn review_bodies() {
        let comments = vec![
            json!({ "path": "src/a.ts", "line": 12, "side": "RIGHT", "body": "Nit" }),
            json!({ "path": "src/b.ts", "line": 9, "startLine": 5, "side": "LEFT", "body": "Why remove?" }),
            // A "range" ending where it starts is a single line.
            json!({ "path": "src/c.ts", "line": 3, "startLine": 3, "body": "x" }),
        ];
        let body = review_body("abc123", "approve", "LGTM", &comments).unwrap();
        assert_eq!(body["event"], "APPROVE");
        assert_eq!(body["commit_id"], "abc123");
        assert_eq!(body["body"], "LGTM");
        assert_eq!(body["comments"][0], json!({ "path": "src/a.ts", "line": 12, "side": "RIGHT", "body": "Nit" }));
        assert_eq!(body["comments"][1]["start_line"], 5);
        assert_eq!(body["comments"][1]["start_side"], "LEFT");
        assert!(body["comments"][2].get("start_line").is_none());
        assert_eq!(body["comments"][2]["side"], "RIGHT");
        assert_eq!(review_body("", "requestChanges", "Please fix", &[]).unwrap()["event"], "REQUEST_CHANGES");
        assert!(review_body("", "requestChanges", " ", &[]).is_err());
        assert!(review_body("", "comment", "", &[]).is_err());
        assert!(review_body("", "comment", "", &comments[..1]).is_ok());
        assert!(review_body("", "dance", "x", &[]).is_err());
        assert!(review_body("", "comment", "x", &[]).unwrap().get("commit_id").is_none());
    }

    /// Recorded `statusCheckRollup` entries (Actions check runs and a status).
    fn rollup() -> Value {
        json!([
            { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://github.com/o/r/actions/runs/1", "workflowName": "CI" },
            { "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED", "detailsUrl": "", "workflowName": "CI" },
            { "__typename": "StatusContext", "context": "ci/circleci", "state": "SUCCESS", "targetUrl": "https://circleci.com/x", "description": "Your tests passed" }
        ])
    }

    #[test]
    fn check_states() {
        let (checks, state) = check_summary(&rollup());
        assert_eq!(state, "success");
        assert_eq!(checks.len(), 3);
        assert_eq!(checks[0], Check { name: "build".into(), state: "success".into(), description: "success".into(), url: "https://github.com/o/r/actions/runs/1".into(), workflow: "CI".into() });
        assert_eq!(checks[1].state, "skipped");
        assert_eq!(checks[2].name, "ci/circleci");
        assert_eq!(checks[2].url, "https://circleci.com/x");
        let mut pending = rollup();
        pending.as_array_mut().unwrap().push(json!({ "__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": "" }));
        assert_eq!(check_summary(&pending).1, "pending");
        pending.as_array_mut().unwrap().push(json!({ "__typename": "CheckRun", "name": "e2e", "status": "COMPLETED", "conclusion": "TIMED_OUT" }));
        assert_eq!(check_summary(&pending).1, "failure");
        assert_eq!(check_summary(&json!([{ "context": "deploy", "state": "ERROR" }])).1, "failure");
        assert_eq!(check_summary(&Value::Null).1, "none");
        assert_eq!(check_summary(&json!([])).1, "none");
    }

    #[test]
    fn pr_list_output() {
        // Recorded from `gh pr list --json …` (trimmed).
        let recorded = r#"[{"author":{"id":"MDQ6VXNlcjE=","is_bot":false,"login":"octocat","name":"The Octocat"},"baseRefName":"main","headRefName":"feature/login","isDraft":false,"labels":[{"id":"LA_1","name":"enhancement","description":"","color":"a2eeef"}],"number":42,"reviewDecision":"REVIEW_REQUIRED","state":"OPEN","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-01T10:00:00Z","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/runs/2","name":"test","startedAt":"2026-10-01T09:58:00Z","status":"COMPLETED","workflowName":"CI"}],"title":"Add login form","updatedAt":"2026-10-02T08:00:00Z","url":"https://github.com/o/r/pull/42"}]"#;
        let value: Value = serde_json::from_str(recorded).unwrap();
        let summary = parse_pr_summary(&value[0]);
        assert_eq!(summary["number"], 42);
        assert_eq!(summary["author"], "octocat");
        assert_eq!(summary["checks"], "failure");
        assert_eq!(summary["labels"], json!([{ "name": "enhancement", "color": "a2eeef" }]));
        assert_eq!(summary["reviewDecision"], "REVIEW_REQUIRED");
        assert_eq!(summary["headRefName"], "feature/login");
    }

    #[test]
    fn issue_output() {
        let recorded = r#"{"assignees":[{"id":"U_1","login":"octocat","name":""}],"author":{"login":"hubot"},"body":"It crashes.","comments":[{"id":"IC_1","author":{"login":"octocat"},"authorAssociation":"OWNER","body":"Can't reproduce","createdAt":"2026-10-03T10:00:00Z","url":"https://github.com/o/r/issues/7#issuecomment-1"}],"createdAt":"2026-10-02T10:00:00Z","labels":[{"name":"bug","color":"d73a4a"}],"milestone":{"number":1,"title":"v1.0","description":"","dueOn":null},"number":7,"state":"OPEN","stateReason":"","title":"Crash on start","url":"https://github.com/o/r/issues/7"}"#;
        let issue = parse_issue_details(&serde_json::from_str(recorded).unwrap());
        assert_eq!(issue["number"], 7);
        assert_eq!(issue["milestone"], "v1.0");
        assert_eq!(issue["assignees"], json!(["octocat"]));
        assert_eq!(issue["comments"][0]["author"], "octocat");
        assert_eq!(issue["comments"][0]["body"], "Can't reproduce");
        let summary = parse_issue_summary(&serde_json::from_str(recorded).unwrap());
        assert_eq!(summary["labels"][0]["name"], "bug");
        assert_eq!(parse_issue_summary(&json!({ "number": 1, "milestone": null }))["milestone"], Value::Null);
    }

    #[test]
    fn pr_details_output() {
        let recorded = json!({
            "number": 42, "title": "Add login form", "body": "Adds **login**.", "author": { "login": "octocat" },
            "state": "OPEN", "isDraft": true, "labels": [], "assignees": [{ "login": "octocat" }],
            "reviewRequests": [{ "__typename": "User", "login": "alice" }, { "__typename": "Team", "slug": "core", "name": "Core" }, { "__typename": "User", "login": "carol" }],
            "latestReviews": [{ "author": { "login": "bob" }, "state": "APPROVED", "body": "", "submittedAt": "2026-10-02T09:00:00Z" }, { "author": { "login": "carol" }, "state": "CHANGES_REQUESTED" }],
            "reviews": [
                { "id": "PRR_1", "author": { "login": "bob" }, "state": "APPROVED", "body": "Nice", "submittedAt": "2026-10-02T09:00:00Z" },
                { "id": "PRR_2", "author": { "login": "bob" }, "state": "COMMENTED", "body": "", "submittedAt": "2026-10-02T09:30:00Z" }
            ],
            "comments": [{ "id": "IC_1", "author": { "login": "alice" }, "body": "Looks good", "createdAt": "2026-10-01T12:00:00Z", "url": "u" }],
            "commits": [{ "oid": "abc", "messageHeadline": "Add form", "committedDate": "2026-10-01T10:00:00Z", "authors": [{ "login": "octocat", "name": "Octo" }] }],
            "statusCheckRollup": rollup(),
            "headRefName": "feature/login", "baseRefName": "main", "headRefOid": "h1", "baseRefOid": "b1",
            "mergeable": "MERGEABLE", "url": "https://github.com/o/r/pull/42", "additions": 10, "deletions": 2, "changedFiles": 3,
            "milestone": null
        });
        let pr = parse_pr_details(&recorded);
        assert_eq!(pr["checkState"], "success");
        assert_eq!(pr["checks"].as_array().unwrap().len(), 3);
        assert_eq!(
            pr["reviewers"],
            json!([{ "login": "bob", "state": "APPROVED" }, { "login": "carol", "state": "REQUESTED" }, { "login": "alice", "state": "REQUESTED" }, { "login": "core", "state": "REQUESTED" }])
        );
        // Comment, then the approving review; the bare COMMENTED review is left out.
        let timeline = pr["timeline"].as_array().unwrap();
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0]["kind"], "comment");
        assert_eq!(timeline[1]["state"], "APPROVED");
        assert_eq!(pr["commits"][0]["headline"], "Add form");
        assert_eq!(pr["commits"][0]["author"], "octocat");
        assert_eq!(pr["isDraft"], true);
        assert_eq!(pr["assignees"], json!(["octocat"]));
    }

    #[test]
    fn paginated_files() {
        // `gh api --paginate` prints each page's array in turn.
        let pages = r#"[{"sha":"1","filename":"src/a.ts","status":"modified","additions":3,"deletions":1}]
[{"sha":"2","filename":"src/new name.ts","status":"renamed","previous_filename":"src/old.ts","additions":0,"deletions":0},{"filename":"gone.txt","status":"removed","additions":0,"deletions":5}]"#;
        let files = parse_files(pages).unwrap();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0]["path"], "src/a.ts");
        assert_eq!(files[0]["previousPath"], Value::Null);
        assert_eq!(files[1]["previousPath"], "src/old.ts");
        assert_eq!(files[2]["status"], "removed");
        assert_eq!(files[2]["deletions"], 5);
        assert!(parse_pages("[1,2][3]").unwrap().len() == 3);
        assert!(parse_pages("{oops").is_err());
    }

    #[test]
    fn review_threads() {
        let recorded = json!({ "data": { "repository": { "pullRequest": {
            "id": "PR_kw1",
            "files": { "nodes": [{ "path": "src/a.ts", "viewerViewedState": "VIEWED" }, { "path": "src/b.ts", "viewerViewedState": "UNVIEWED" }] },
            "reviewThreads": { "nodes": [
                { "id": "PRRT_1", "isResolved": false, "isOutdated": false, "path": "src/a.ts", "line": 12, "originalLine": 12, "startLine": null, "diffSide": "RIGHT",
                  "comments": { "nodes": [{ "id": "PRRC_1", "databaseId": 1001, "body": "Rename this?", "createdAt": "2026-10-02T10:00:00Z", "url": "u", "author": { "login": "bob" } },
                                          { "id": "PRRC_2", "databaseId": 1002, "body": "Done", "createdAt": "2026-10-02T11:00:00Z", "url": "u2", "author": { "login": "octocat" } }] } },
                { "id": "PRRT_2", "isResolved": true, "isOutdated": true, "path": "src/b.ts", "line": null, "originalLine": 4, "startLine": null, "originalStartLine": 2, "diffSide": "LEFT",
                  "comments": { "nodes": [] } }
            ] }
        } } } });
        let threads = parse_threads(&recorded);
        assert_eq!(threads["pullId"], "PR_kw1");
        assert_eq!(threads["viewed"], json!({ "src/a.ts": true, "src/b.ts": false }));
        assert_eq!(threads["threads"][0]["line"], 12);
        assert_eq!(threads["threads"][0]["startLine"], Value::Null);
        assert_eq!(threads["threads"][0]["comments"][1]["databaseId"], 1002);
        assert_eq!(threads["threads"][0]["comments"][0]["author"], "bob");
        assert_eq!(threads["threads"][1]["line"], 4);
        assert_eq!(threads["threads"][1]["startLine"], 2);
        assert_eq!(threads["threads"][1]["side"], "LEFT");
        assert_eq!(threads["threads"][1]["isResolved"], true);
    }

    #[test]
    fn urls_paths_logs() {
        assert_eq!(number_from_url("Creating pull request for x into main\n\nhttps://github.com/o/r/pull/43\n"), Some(43));
        assert_eq!(number_from_url("https://github.com/o/r/issues/9"), Some(9));
        assert_eq!(number_from_url("nothing"), None);
        assert_eq!(encode_path("src/my file#1.ts"), "src/my%20file%231.ts");
        assert_eq!(encode_path("ü.md"), "%C3%BC.md");
        let log = "aaa\u{1f}Add form\u{1f}Body line\n\u{1e}\nbbb\u{1f}Fix\u{1f}\u{1e}\n";
        let commits = parse_log(log);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0], json!({ "hash": "aaa", "subject": "Add form", "body": "Body line" }));
        assert_eq!(commits[1]["subject"], "Fix");
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn issue_templates() {
        let text = "---\nname: Bug report\nabout: Something broke\ntitle: \"[Bug] \"\nlabels: bug, triage\nassignees:\n  - octocat\n  - 'hubot'\n---\n\n**Describe the bug**\n";
        let template = parse_template("bug_report.md", text);
        assert_eq!(template["name"], "Bug report");
        assert_eq!(template["about"], "Something broke");
        assert_eq!(template["title"], "[Bug] ");
        assert_eq!(template["labels"], json!(["bug", "triage"]));
        assert_eq!(template["assignees"], json!(["octocat", "hubot"]));
        assert_eq!(template["body"], "**Describe the bug**\n");
        let bare = parse_template("feature-request.md", "Just text");
        assert_eq!(bare["name"], "feature request");
        assert_eq!(bare["body"], "Just text");
        assert_eq!(parse_template("x.md", "---\nlabels: [\"a\", b]\n---\nB")["labels"], json!(["a", "b"]));
    }

    #[test]
    fn errors_explain_rate_limits_and_sign_in() {
        let output = |stderr: &str| Output { stdout: String::new(), stderr: stderr.into(), success: false };
        assert!(gh_error(&output("HTTP 403: API rate limit exceeded for user ID 1.")).starts_with("GitHub's API rate limit"));
        let signed_out = output("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable");
        assert!(is_auth_error(&signed_out));
        assert!(gh_error(&signed_out).starts_with("Not signed in"));
        assert_eq!(gh_error(&output("GraphQL: Could not resolve to a PullRequest with the number of 99.")), "GraphQL: Could not resolve to a PullRequest with the number of 99.");
        assert!(!is_auth_error(&output("HTTP 404: Not Found")));
    }

    #[test]
    fn gh_path_setting_wins() {
        assert_eq!(gh_program(Some("/tmp/fake/gh")), "/tmp/fake/gh");
        assert_ne!(gh_program(Some("  ")), "  ");
    }

    /// The ops against a stand-in gh script (no network): arguments and
    /// stdin arrive as built, and output is parsed.
    #[cfg(unix)]
    #[tokio::test]
    async fn ops_run_gh_with_the_built_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sable-gh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("log");
        let script = dir.join("gh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\ncase \"$1 $2\" in\n  'pr list') echo '[{{\"number\":5,\"title\":\"T\",\"author\":{{\"login\":\"a\"}},\"labels\":[],\"statusCheckRollup\":[]}}]' ;;\n  'api repos/{{owner}}/{{repo}}/pulls/5/reviews') cat >> '{log}'; echo '{{\"id\":1}}' ;;\n  'pr view') echo 'no pull requests found for branch \"main\"' >&2; exit 1 ;;\n  *) echo 'unknown' >&2; exit 1 ;;\nesac\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let root = dir.to_string_lossy().into_owned();
        let gh = Some(script.to_string_lossy().into_owned());
        let prs = github_call(root.clone(), "list_prs".into(), json!({ "category": "review" }), gh.clone()).await.unwrap();
        assert_eq!(prs[0]["number"], 5);
        assert_eq!(prs[0]["checks"], "none");
        let review = json!({ "number": 5, "event": "comment", "body": "", "commitId": "h1", "comments": [{ "path": "a.ts", "line": 2, "side": "RIGHT", "body": "Nit" }] });
        github_call(root.clone(), "pr_review".into(), review, gh.clone()).await.unwrap();
        assert_eq!(github_call(root.clone(), "pr_for_branch".into(), Value::Null, gh.clone()).await.unwrap(), Value::Null);
        assert_eq!(github_call(root.clone(), "nope".into(), Value::Null, gh.clone()).await.unwrap_err(), "Unknown GitHub operation nope");
        let logged = std::fs::read_to_string(&log).unwrap();
        assert!(logged.contains("pr list --state open --limit 100 --json"), "{logged}");
        assert!(logged.contains("--search review-requested:@me"));
        assert!(logged.contains("api repos/{owner}/{repo}/pulls/5/reviews --method POST --input -"));
        assert!(logged.contains(r#""commit_id":"h1""#) && logged.contains(r#""body":"Nit""#), "{logged}");
        let missing = github_call(root, "status".into(), Value::Null, Some(dir.join("no-gh").to_string_lossy().into_owned())).await.unwrap();
        assert_eq!(missing["installed"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
