//! Git integration.
//!
//! Design boundary (built to deliberately, so later stages don't refactor):
//!   - **Local operations use `git2` (libgit2).** Status, staging, commits
//!     (and diffs/log later). Structured data beats parsing the `git`
//!     CLI's human-readable, version/locale-dependent output.
//!   - **Network operations will shell out to the `git` CLI** (push/pull,
//!     a later stage) so they reuse the user's existing SSH keys and
//!     credential helpers instead of hand-wired git2 auth callbacks.
//!
//! Everything in this file is the local (`git2`) half. The future
//! network half goes in its own functions below the marked boundary.

use git2::{IndexAddOption, ObjectType, Repository, Status, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// The single indicator for one side (staged or unstaged) of a file.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Modified,
    Added,
    Untracked,
    Deleted,
    Renamed,
}

/// A changed file's status, split into the two sides the commit panel
/// needs. A file can have BOTH at once (e.g. staged, then edited again),
/// so neither is exclusive.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Index vs HEAD — what's staged for commit (libgit2 `INDEX_*`).
    staged: Option<FileStatus>,
    /// Working tree vs index — unstaged edits (libgit2 `WT_*`).
    unstaged: Option<FileStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the folder isn't inside a Git repo — the UI then shows
    /// nothing Git-related (this is not an error).
    is_repo: bool,
    /// Branch name, short hash (detached HEAD), or None (empty repo).
    branch: Option<String>,
    /// Absolute file path → split status, so the frontend matches both
    /// file-tree rows and the source-control panel.
    files: HashMap<String, GitFile>,
}

impl GitStatus {
    fn not_a_repo() -> Self {
        GitStatus {
            is_repo: false,
            branch: None,
            files: HashMap::new(),
        }
    }
}

/// Map the index (staged) side of libgit2's status bitset.
fn map_index_status(status: Status) -> Option<FileStatus> {
    if status.intersects(Status::INDEX_NEW) {
        Some(FileStatus::Added)
    } else if status.intersects(Status::INDEX_DELETED) {
        Some(FileStatus::Deleted)
    } else if status.intersects(Status::INDEX_RENAMED) {
        Some(FileStatus::Renamed)
    } else if status
        .intersects(Status::INDEX_MODIFIED | Status::INDEX_TYPECHANGE)
    {
        Some(FileStatus::Modified)
    } else {
        None
    }
}

/// Map the working-tree (unstaged) side of libgit2's status bitset.
/// WT_NEW means an untracked file on disk.
fn map_worktree_status(status: Status) -> Option<FileStatus> {
    if status.intersects(Status::WT_NEW) {
        Some(FileStatus::Untracked)
    } else if status.intersects(Status::WT_DELETED) {
        Some(FileStatus::Deleted)
    } else if status.intersects(Status::WT_RENAMED) {
        Some(FileStatus::Renamed)
    } else if status.intersects(Status::WT_MODIFIED | Status::WT_TYPECHANGE) {
        Some(FileStatus::Modified)
    } else {
        None
    }
}

/// Resolve the current branch name. Falls back to a short commit hash on
/// detached HEAD, and the unborn branch name on an empty repo.
fn current_branch(repo: &Repository) -> Option<String> {
    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand().ok().map(|name| name.to_string())
            } else {
                head.target()
                    .map(|oid| oid.to_string()[..7].to_string())
            }
        }
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|head| {
                head.symbolic_target()
                    .ok()
                    .flatten()
                    .map(|target| target.to_string())
            })
            .and_then(|target| {
                target
                    .strip_prefix("refs/heads/")
                    .map(|name| name.to_string())
            }),
    }
}

/// Open the repo containing `root` (walking up to find it).
fn open_repo(root: &str) -> Result<Repository, String> {
    Repository::discover(root)
        .map_err(|_| "Not a git repository".to_string())
}

/// Convert an absolute file path to one relative to the repo workdir,
/// which is what the index API expects. Returns owned PathBuf.
fn relative_to_workdir(
    repo: &Repository,
    file: &str,
) -> Result<std::path::PathBuf, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare repositories are unsupported".to_string())?;
    Path::new(file)
        .strip_prefix(workdir)
        .map(|relative| relative.to_path_buf())
        .map_err(|_| format!("{file} is outside the repository"))
}

/// Read git status for the workspace folder. Returns a non-repo result
/// (not an error) when there's no repo, so the UI degrades cleanly.
#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    let repo = match Repository::discover(&path) {
        Ok(repo) => repo,
        Err(_) => return Ok(GitStatus::not_a_repo()),
    };
    let workdir = match repo.workdir() {
        Some(workdir) => workdir.to_path_buf(),
        None => return Ok(GitStatus::not_a_repo()),
    };

    let branch = current_branch(&repo);

    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(false)
        .recurse_ignored_dirs(false)
        .include_unmodified(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(|error| format!("Could not read git status: {error}"))?;

    let mut files = HashMap::new();
    for entry in statuses.iter() {
        let Ok(relative_path) = entry.path() else {
            continue;
        };
        let status = entry.status();
        let staged = map_index_status(status);
        let unstaged = map_worktree_status(status);
        if staged.is_none() && unstaged.is_none() {
            continue;
        }
        let absolute = workdir.join(relative_path);
        files.insert(
            absolute.to_string_lossy().into_owned(),
            GitFile { staged, unstaged },
        );
    }

    Ok(GitStatus {
        is_repo: true,
        branch,
        files,
    })
}

/// Stage one path: add it to the index (or stage its deletion if it's
/// gone from disk), then persist the index.
#[tauri::command]
pub fn git_stage(root: String, file: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open index: {error}"))?;

    if Path::new(&file).exists() {
        index.add_path(&relative)
    } else {
        // File deleted on disk → stage the deletion.
        index.remove_path(&relative)
    }
    .map_err(|error| format!("Could not stage {file}: {error}"))?;

    index
        .write()
        .map_err(|error| format!("Could not write index: {error}"))
}

/// Unstage one path: reset its index entry back to HEAD. With no commits
/// yet (no HEAD), "unstage" means removing the entry from the index.
#[tauri::command]
pub fn git_unstage(root: String, file: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;
    let relative_str = relative.to_string_lossy().into_owned();

    // Bind to a variable so the temporary borrow from `repo.head()` ends
    // before `repo` drops at the end of the function.
    let result = match repo.head() {
        Ok(head) => {
            let head_commit = head
                .peel(ObjectType::Commit)
                .map_err(|error| format!("Could not read HEAD: {error}"))?;
            repo.reset_default(Some(&head_commit), [relative_str])
                .map_err(|error| format!("Could not unstage {file}: {error}"))
        }
        Err(_) => {
            // No commits yet: drop the entry from the index.
            let mut index = repo
                .index()
                .map_err(|error| format!("Could not open index: {error}"))?;
            index
                .remove_path(&relative)
                .map_err(|error| format!("Could not unstage {file}: {error}"))?;
            index
                .write()
                .map_err(|error| format!("Could not write index: {error}"))
        }
    };
    result
}

/// Stage every change (like `git add -A`): new/modified via add_all,
/// deletions of tracked files via update_all.
#[tauri::command]
pub fn git_stage_all(root: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open index: {error}"))?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(|error| format!("Could not stage changes: {error}"))?;
    index
        .update_all(["*"], None)
        .map_err(|error| format!("Could not stage deletions: {error}"))?;
    index
        .write()
        .map_err(|error| format!("Could not write index: {error}"))
}

/// Unstage everything: reset the whole index to HEAD, or clear it when
/// there are no commits yet.
#[tauri::command]
pub fn git_unstage_all(root: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let result = match repo.head() {
        Ok(head) => {
            let head_commit = head
                .peel(ObjectType::Commit)
                .map_err(|error| format!("Could not read HEAD: {error}"))?;
            repo.reset_default(Some(&head_commit), ["*"])
                .map_err(|error| format!("Could not unstage: {error}"))
        }
        Err(_) => {
            let mut index = repo
                .index()
                .map_err(|error| format!("Could not open index: {error}"))?;
            index
                .clear()
                .map_err(|error| format!("Could not clear index: {error}"))?;
            index
                .write()
                .map_err(|error| format!("Could not write index: {error}"))
        }
    };
    result
}

/// Marker the frontend recognizes to offer the set-identity prompt.
const IDENTITY_UNSET: &str = "identity-unset";

/// Commit the staged changes. Carefully handles the empty-repo (no
/// parent) and missing-identity cases.
#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".to_string());
    }
    let repo = open_repo(&root)?;

    // 1. Snapshot the index into a tree object.
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open index: {error}"))?;
    let tree_oid = index
        .write_tree()
        .map_err(|error| format!("Could not write tree: {error}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|error| format!("Could not read tree: {error}"))?;

    // 2. Author/committer signature from git config. Missing identity is
    //    common on a fresh machine — surface it, don't crash.
    let signature = repo
        .signature()
        .map_err(|_| IDENTITY_UNSET.to_string())?;

    // 3. Parent = current HEAD commit; none on the very first commit.
    let parent_commit = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|error| format!("Could not read HEAD commit: {error}"))?,
        ),
        Err(_) => None, // unborn branch → first commit, no parents
    };
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    // 4. Create the commit and move HEAD to it.
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message.trim(),
        &tree,
        &parents,
    )
    .map_err(|error| format!("Could not commit: {error}"))?;

    Ok(())
}

/// Write user.name / user.email to the global git config — backs the
/// in-app identity prompt when a commit hits the missing-identity case.
#[tauri::command]
pub fn git_set_identity(name: String, email: String) -> Result<(), String> {
    let mut config = git2::Config::open_default()
        .map_err(|error| format!("Could not open git config: {error}"))?;
    // Write to the global level (~/.gitconfig) so it applies everywhere.
    let mut global = config
        .open_global()
        .map_err(|error| format!("Could not open global git config: {error}"))?;
    global
        .set_str("user.name", name.trim())
        .map_err(|error| format!("Could not set user.name: {error}"))?;
    global
        .set_str("user.email", email.trim())
        .map_err(|error| format!("Could not set user.email: {error}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// NETWORK BOUNDARY
//
// push/pull and other remote operations (a later stage) go BELOW this
// line and shell out to the `git` CLI — not git2 — so they reuse the
// user's SSH keys and credential helpers. Nothing above this line should
// depend on anything below it.
// ---------------------------------------------------------------------------
