//! Git integration.
//!
//! Design boundary (built to deliberately, so later stages don't refactor):
//!   - **Local operations use `git2` (libgit2).** Status now; staging,
//!     commits, diffs, and log later. Structured data beats parsing the
//!     `git` CLI's human-readable, version/locale-dependent output.
//!   - **Network operations will shell out to the `git` CLI** (push/pull,
//!     a later stage) so they reuse the user's existing SSH keys and
//!     credential helpers instead of hand-wired git2 auth callbacks.
//!
//! Everything in this file is the local (`git2`) half. The future
//! network half goes in its own functions below the marked boundary.

use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;

/// The single indicator Sable shows for a file. libgit2 exposes many
/// fine-grained flags (and a file can carry several at once); Stage 1
/// collapses them to the one most useful label. The full staged-vs-
/// unstaged split arrives with the commit stage.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Modified,
    Added,
    Untracked,
    Deleted,
    Renamed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the folder isn't inside a Git repo — the UI then shows
    /// nothing Git-related (this is not an error).
    is_repo: bool,
    /// Branch name, or a short commit hash when HEAD is detached, or None
    /// for an empty repo with no commits yet.
    branch: Option<String>,
    /// Absolute file path → status, so the frontend can match entries to
    /// file-tree rows directly (the tree keys nodes by absolute path).
    files: HashMap<String, FileStatus>,
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

/// Map libgit2's status bitflags to our single indicator.
///
/// A file's `Status` is a bitset that can combine index (staged) and
/// working-tree (unstaged) changes. We check in priority order so the
/// most actionable label wins:
///   - any "new" flag (index or worktree) that isn't tracked yet → the
///     file is brand new. INDEX_NEW means staged-add; WT_NEW means an
///     untracked file on disk.
///   - any "deleted" flag → Deleted.
///   - any "renamed" flag → Renamed.
///   - otherwise "modified" (index or worktree) → Modified.
fn map_status(status: Status) -> Option<FileStatus> {
    if status.intersects(Status::INDEX_NEW) {
        // Staged brand-new file.
        Some(FileStatus::Added)
    } else if status.intersects(Status::WT_NEW) {
        // On disk but not tracked or staged.
        Some(FileStatus::Untracked)
    } else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        Some(FileStatus::Deleted)
    } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        Some(FileStatus::Renamed)
    } else if status.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED) {
        Some(FileStatus::Modified)
    } else {
        // Ignored/unmodified/typechange we don't surface in Stage 1.
        None
    }
}

/// Resolve the current branch name. Falls back to a short commit hash on
/// detached HEAD, and `None` on an empty repo (HEAD points at an unborn
/// branch with no commits).
fn current_branch(repo: &Repository) -> Option<String> {
    match repo.head() {
        Ok(head) => {
            if head.is_branch() {
                head.shorthand().ok().map(|name| name.to_string())
            } else {
                // Detached HEAD: show the short commit hash.
                head.target()
                    .map(|oid| oid.to_string()[..7].to_string())
            }
        }
        // Unborn branch (fresh repo, no commits): report the branch name
        // git would create on first commit if we can read it.
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            // symbolic_target is Result<Option<&str>>: ok() then flatten.
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

/// Read Git status for the workspace folder. Discovers the repo by
/// walking up from `path`, so it works from the repo root or any
/// subfolder. Returns a non-repo result (not an error) when there's no
/// repo, so the UI degrades cleanly.
#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    // `discover` walks parent directories looking for a .git.
    let repo = match Repository::discover(&path) {
        Ok(repo) => repo,
        Err(_) => return Ok(GitStatus::not_a_repo()),
    };

    // The working directory root; bare repos have none and can't show
    // file status meaningfully.
    let workdir = match repo.workdir() {
        Some(workdir) => workdir.to_path_buf(),
        None => return Ok(GitStatus::not_a_repo()),
    };

    let branch = current_branch(&repo);

    let mut options = StatusOptions::new();
    options
        .include_untracked(true) // show new files
        .include_ignored(false) // never surface .gitignore'd files
        // Report an untracked directory as a single entry rather than
        // walking into it — cheaper, and ignored dirs (node_modules,
        // target) are skipped entirely since ignored is excluded.
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
        // path() is Result<&str> — it fails only on non-UTF-8 paths,
        // which we simply skip.
        let Ok(relative_path) = entry.path() else {
            continue;
        };
        let Some(file_status) = map_status(entry.status()) else {
            continue;
        };
        // Build an absolute path so the frontend matches tree rows. join
        // handles the OS separator; libgit2 always hands us '/'-relative
        // paths, which join normalizes per platform.
        let absolute = workdir.join(relative_path);
        files.insert(absolute.to_string_lossy().into_owned(), file_status);
    }

    Ok(GitStatus {
        is_repo: true,
        branch,
        files,
    })
}

// ---------------------------------------------------------------------------
// NETWORK BOUNDARY
//
// push/pull and other remote operations (a later stage) go BELOW this
// line and shell out to the `git` CLI — not git2 — so they reuse the
// user's SSH keys and credential helpers. Nothing above this line should
// depend on anything below it.
// ---------------------------------------------------------------------------
