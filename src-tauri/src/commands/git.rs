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

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, IndexAddOption, ObjectType, Repository, RepositoryState,
    Status, StatusOptions,
};
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
    /// Both sides of a merge changed it — needs resolving.
    Conflicted,
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
    /// An operation in progress that the next commit finishes: "merge",
    /// "cherry-pick", "revert" or "rebase".
    operation: Option<String>,
    /// The message Git prepared for it (MERGE_MSG), to prefill the box.
    merge_message: Option<String>,
}

impl GitStatus {
    fn not_a_repo() -> Self {
        GitStatus {
            is_repo: false,
            branch: None,
            files: HashMap::new(),
            operation: None,
            merge_message: None,
        }
    }
}

/// The in-progress operation, by Git's name for it.
fn operation_name(repo: &Repository) -> Option<String> {
    match repo.state() {
        RepositoryState::Merge => Some("merge"),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            Some("cherry-pick")
        }
        RepositoryState::Revert | RepositoryState::RevertSequence => Some("revert"),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Some("rebase"),
        _ => None,
    }
    .map(str::to_string)
}

/// MERGE_MSG without Git's "# ..." comment lines.
fn merge_message(repo: &Repository) -> Option<String> {
    let text = std::fs::read_to_string(repo.path().join("MERGE_MSG")).ok()?;
    let message = text
        .lines()
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    (!message.is_empty()).then_some(message)
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
        // A conflicted file shows once, as needing resolution.
        let (staged, unstaged) = if status.intersects(Status::CONFLICTED) {
            (None, Some(FileStatus::Conflicted))
        } else {
            (map_index_status(status), map_worktree_status(status))
        };
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
        operation: operation_name(&repo),
        merge_message: merge_message(&repo),
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

/// Stage exactly `content` as the file's next-commit version — how single
/// hunks are staged or unstaged: the frontend applies the hunk to the
/// staged text and sends the result. Keeps the entry's mode; a file new to
/// the index gets the working file's.
#[tauri::command]
pub fn git_stage_content(root: String, file: String, content: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;
    let mut index = repo
        .index()
        .map_err(|error| format!("Could not open index: {error}"))?;
    let entry = match index.get_path(&relative, 0) {
        Some(entry) => entry,
        None => {
            let executable = executable_on_disk(&file);
            git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: if executable { 0o100755 } else { 0o100644 },
                uid: 0,
                gid: 0,
                file_size: 0,
                id: git2::Oid::ZERO_SHA1,
                flags: 0,
                flags_extended: 0,
                path: relative.to_string_lossy().replace('\\', "/").into_bytes(),
            }
        }
    };
    index
        .add_frombuffer(&entry, content.as_bytes())
        .map_err(|error| format!("Could not stage {file}: {error}"))?;
    index
        .write()
        .map_err(|error| format!("Could not write index: {error}"))
}

#[cfg(unix)]
fn executable_on_disk(file: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file)
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn executable_on_disk(_file: &str) -> bool {
    false
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
    if index.has_conflicts() {
        return Err("Resolve the merge conflicts first (Source Control → Merge Conflicts)".to_string());
    }
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
    // Finishing a cherry-pick: the change is still its original author's.
    let picked = (matches!(repo.state(), RepositoryState::CherryPick | RepositoryState::CherryPickSequence))
        .then(|| std::fs::read_to_string(repo.path().join("CHERRY_PICK_HEAD")).ok())
        .flatten()
        .and_then(|head| git2::Oid::from_str(head.trim()).ok())
        .and_then(|oid| repo.find_commit(oid).ok());
    let original_author = picked.as_ref().map(|commit| commit.author().to_owned());
    let author = original_author.as_ref().unwrap_or(&signature);

    // 3. Parent = current HEAD commit; none on the very first commit.
    let parent_commit = match repo.head() {
        Ok(head) => Some(
            head.peel_to_commit()
                .map_err(|error| format!("Could not read HEAD commit: {error}"))?,
        ),
        Err(_) => None, // unborn branch → first commit, no parents
    };
    // Finishing a merge: the merged-in commits are parents too.
    let mut merge_parents = Vec::new();
    if repo.state() == RepositoryState::Merge {
        let heads = std::fs::read_to_string(repo.path().join("MERGE_HEAD"))
            .map_err(|error| format!("Could not read MERGE_HEAD: {error}"))?;
        for line in heads.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let commit = git2::Oid::from_str(line)
                .and_then(|oid| repo.find_commit(oid))
                .map_err(|error| format!("Could not read MERGE_HEAD: {error}"))?;
            merge_parents.push(commit);
        }
    }
    let parents: Vec<&git2::Commit> = parent_commit.iter().chain(merge_parents.iter()).collect();

    // 4. Create the commit and move HEAD to it.
    repo.commit(
        Some("HEAD"),
        author,
        &signature,
        message.trim(),
        &tree,
        &parents,
    )
    .map_err(|error| format!("Could not commit: {error}"))?;

    // The merge (or cherry-pick, revert) is done: clear MERGE_HEAD etc.
    if repo.state() != RepositoryState::Clean
        && !matches!(
            repo.state(),
            RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge
        )
    {
        repo.cleanup_state()
            .map_err(|error| format!("Committed, but could not finish the merge: {error}"))?;
    }

    Ok(())
}

/// The versions of a conflicted file, for the merge tool: the common
/// ancestor, ours (the current branch) and theirs (being merged in).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    base: String,
    ours: String,
    theirs: String,
    /// Branch names for the column headings.
    ours_label: String,
    theirs_label: String,
}

#[tauri::command]
pub fn git_conflict_versions(root: String, file: String) -> Result<ConflictVersions, String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;
    let index = repo
        .index()
        .map_err(|error| format!("Could not open index: {error}"))?;
    let stage = |number: i32| match index.get_path(&relative, number) {
        Some(entry) => match blob_content(&repo, entry.id) {
            Content::Text(text) => Ok(text),
            Content::Binary => Err(format!("{file} is binary — resolve it outside Sable")),
            Content::Absent => Ok(String::new()),
        },
        None => Ok(String::new()),
    };
    let theirs_label = std::fs::read_to_string(repo.path().join("MERGE_MSG"))
        .ok()
        .and_then(|message| {
            // "Merge branch 'feature' into main"
            let start = message.find('\'')? + 1;
            let end = start + message[start..].find('\'')?;
            Some(message[start..end].to_string())
        })
        .unwrap_or_else(|| "Incoming".to_string());
    Ok(ConflictVersions {
        base: stage(1)?,
        ours: stage(2)?,
        theirs: stage(3)?,
        ours_label: current_branch(&repo).unwrap_or_else(|| "Current".to_string()),
        theirs_label,
    })
}

/// Abandon the merge in progress: back to HEAD, MERGE_HEAD cleared (like
/// `git merge --abort` from a clean tree).
#[tauri::command]
pub fn git_merge_abort(root: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let head = repo
        .head()
        .and_then(|head| head.peel(ObjectType::Commit))
        .map_err(|error| format!("Could not read HEAD: {error}"))?;
    repo.reset(&head, git2::ResetType::Hard, None)
        .map_err(|error| format!("Could not abort the merge: {error}"))?;
    repo.cleanup_state()
        .map_err(|error| format!("Could not abort the merge: {error}"))
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

// === Diff (local, git2) ====================================================

/// The content of one side of a diff, resolved from a blob or disk.
enum Content {
    /// UTF-8 text we can diff.
    Text(String),
    /// Exists but isn't valid UTF-8 (an image, etc.) — not diffable.
    Binary,
    /// Doesn't exist on this side (new file's original / deleted file's
    /// modified) — shown as an empty pane.
    Absent,
}

/// Read a blob's bytes as text, or flag it binary.
fn blob_content(repo: &Repository, oid: git2::Oid) -> Content {
    match repo.find_blob(oid) {
        Ok(blob) => match std::str::from_utf8(blob.content()) {
            Ok(text) => Content::Text(text.to_string()),
            Err(_) => Content::Binary,
        },
        Err(_) => Content::Absent,
    }
}

/// The file's content within a given tree. Resolving a path to a blob:
/// `get_path` walks the tree to the file's entry → the entry's id is the
/// blob. Absent if the path isn't in the tree (a new file).
fn tree_content(repo: &Repository, tree: &git2::Tree, relative: &Path) -> Content {
    match tree.get_path(relative) {
        Ok(entry) => blob_content(repo, entry.id()),
        Err(_) => Content::Absent,
    }
}

/// The file's content in the HEAD commit (or Absent if no HEAD).
fn head_content(repo: &Repository, relative: &Path) -> Content {
    match repo.head().and_then(|head| head.peel_to_tree()) {
        Ok(tree) => tree_content(repo, &tree, relative),
        Err(_) => Content::Absent,
    }
}

/// The file's staged content from the index (stage 0 = the normal entry).
fn index_content(repo: &Repository, relative: &Path) -> Content {
    let index = match repo.index() {
        Ok(index) => index,
        Err(_) => return Content::Absent,
    };
    match index.get_path(relative, 0) {
        Some(entry) => blob_content(repo, entry.id),
        None => Content::Absent,
    }
}

/// The working-tree content (the file on disk). Absent if it's gone
/// (a deletion), Binary if not UTF-8.
fn worktree_content(absolute: &str) -> Content {
    match std::fs::read(absolute) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Content::Text(text),
            Err(_) => Content::Binary,
        },
        Err(_) => Content::Absent,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    original: String,
    modified: String,
    is_binary: bool,
}

/// Produce the two versions of a file to diff.
///   - staged   → original = HEAD, modified = index.
///   - unstaged → original = index (or HEAD if unstaged-only), modified =
///                working tree.
/// New files leave the original empty; deletions leave the modified empty.
#[tauri::command]
pub fn git_file_diff(
    root: String,
    file: String,
    staged: bool,
) -> Result<FileDiff, String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;

    let (original, modified) = if staged {
        (
            head_content(&repo, &relative),
            index_content(&repo, &relative),
        )
    } else {
        // Unstaged compares against the index if the file is staged,
        // otherwise against HEAD — matching `git diff`.
        let original = match index_content(&repo, &relative) {
            Content::Absent => head_content(&repo, &relative),
            other => other,
        };
        (original, worktree_content(&file))
    };

    // If either side is binary, don't attempt a text diff.
    if matches!(original, Content::Binary) || matches!(modified, Content::Binary)
    {
        return Ok(FileDiff {
            original: String::new(),
            modified: String::new(),
            is_binary: true,
        });
    }

    let to_string = |content: Content| match content {
        Content::Text(text) => text,
        _ => String::new(), // Absent → empty pane
    };
    Ok(FileDiff {
        original: to_string(original),
        modified: to_string(modified),
        is_binary: false,
    })
}

// === History (local, git2, read-only) =====================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    hash: String,
    short_hash: String,
    author: String,
    email: String,
    /// Commit time, Unix seconds (the frontend formats "relative time").
    timestamp: i64,
    summary: String,
    body: String,
}

/// Paginated commit log from HEAD backward. A revwalk yields commit oids
/// newest-first; we `skip` past earlier pages and `take` one page so a
/// repo with thousands of commits never loads all at once. An empty repo
/// (no HEAD to push) returns an empty page. `branch` shows another
/// branch's history (to cherry-pick from it).
#[tauri::command]
pub fn git_log(
    root: String,
    limit: usize,
    skip: usize,
    branch: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repo(&root)?;
    let mut revwalk = repo
        .revwalk()
        .map_err(|error| format!("Could not walk history: {error}"))?;
    match branch {
        Some(branch) => {
            let tip = repo
                .revparse_single(&branch)
                .and_then(|object| object.peel_to_commit())
                .map_err(|_| format!("No branch {branch}"))?;
            revwalk.push(tip.id()).map_err(|error| format!("Could not walk history: {error}"))?;
        }
        None => {
            if revwalk.push_head().is_err() {
                return Ok(Vec::new()); // unborn branch / empty repo
            }
        }
    }
    let _ = revwalk.set_sorting(git2::Sort::TIME);

    let mut commits = Vec::new();
    for oid in revwalk.skip(skip).take(limit) {
        let Ok(oid) = oid else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        // summary()/body() return Result<Option<&str>>; flatten to text.
        let summary = commit.summary().ok().flatten().unwrap_or("").to_string();
        let body = commit
            .body()
            .ok()
            .flatten()
            .unwrap_or("")
            .trim()
            .to_string();
        let hash = oid.to_string();
        commits.push(CommitInfo {
            short_hash: hash[..7.min(hash.len())].to_string(),
            hash,
            author: author.name().unwrap_or("").to_string(),
            email: author.email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            summary,
            body,
        });
    }
    Ok(commits)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    path: String,
    status: String,
}

/// Resolve a commit's tree and the tree to diff it against. The "before"
/// side is the FIRST parent's tree — so the first commit (no parent)
/// diffs against nothing (everything added) and a merge commit diffs
/// against its first parent without crashing.
fn commit_and_parent_tree<'repo>(
    repo: &'repo Repository,
    hash: &str,
) -> Result<(git2::Tree<'repo>, Option<git2::Tree<'repo>>), String> {
    let oid = git2::Oid::from_str(hash)
        .map_err(|_| format!("Invalid commit hash: {hash}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|error| format!("Commit not found: {error}"))?;
    let tree = commit
        .tree()
        .map_err(|error| format!("Could not read commit tree: {error}"))?;
    let parent_tree = if commit.parent_count() > 0 {
        commit.parent(0).and_then(|parent| parent.tree()).ok()
    } else {
        None
    };
    Ok((tree, parent_tree))
}

/// The files a commit changed (commit tree vs first-parent tree).
#[tauri::command]
pub fn git_commit_files(
    root: String,
    hash: String,
) -> Result<Vec<CommitFile>, String> {
    let repo = open_repo(&root)?;
    let (tree, parent_tree) = commit_and_parent_tree(&repo, &hash)?;
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|error| format!("Could not diff commit: {error}"))?;

    let mut files = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Renamed => "renamed",
            _ => "modified",
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        files.push(CommitFile {
            path,
            status: status.to_string(),
        });
    }
    Ok(files)
}

/// Before/after content of one file at a commit (parent tree vs commit
/// tree), for the diff viewer. `file` is repo-relative (as returned by
/// git_commit_files).
#[tauri::command]
pub fn git_commit_file_diff(
    root: String,
    hash: String,
    file: String,
) -> Result<FileDiff, String> {
    let repo = open_repo(&root)?;
    let (tree, parent_tree) = commit_and_parent_tree(&repo, &hash)?;
    // Accept either a repo-relative path (from the history panel) or an
    // absolute one (from a blame-line click).
    let relative_buf = if Path::new(&file).is_absolute() {
        relative_to_workdir(&repo, &file).unwrap_or_else(|_| file.clone().into())
    } else {
        file.clone().into()
    };
    let relative = relative_buf.as_path();

    let modified = tree_content(&repo, &tree, relative);
    let original = match &parent_tree {
        Some(parent) => tree_content(&repo, parent, relative),
        None => Content::Absent, // first commit → all added
    };

    if matches!(original, Content::Binary) || matches!(modified, Content::Binary)
    {
        return Ok(FileDiff {
            original: String::new(),
            modified: String::new(),
            is_binary: true,
        });
    }
    let to_string = |content: Content| match content {
        Content::Text(text) => text,
        _ => String::new(),
    };
    Ok(FileDiff {
        original: to_string(original),
        modified: to_string(modified),
        is_binary: false,
    })
}

// === Blame (local, git2, read-only) ========================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    hash: String,
    short_hash: String,
    author: String,
    timestamp: i64,
    summary: String,
}

/// Per-line blame for a file: the commit that last touched each line.
/// Returns one entry per line in file order. A new/untracked file (or a
/// binary one) yields an empty list rather than an error.
#[tauri::command]
pub fn git_blame(root: String, file: String) -> Result<Vec<BlameLine>, String> {
    let repo = open_repo(&root)?;
    let relative = relative_to_workdir(&repo, &file)?;

    let mut options = git2::BlameOptions::new();
    let blame = match repo.blame_file(&relative, Some(&mut options)) {
        Ok(blame) => blame,
        Err(_) => return Ok(Vec::new()), // not tracked yet / no blame
    };

    // Cache commit lookups — adjacent lines usually share a commit.
    let mut cache: HashMap<git2::Oid, BlameLine> = HashMap::new();
    let mut lines: Vec<BlameLine> = Vec::new();

    for hunk in blame.iter() {
        let oid = hunk.final_commit_id();
        let count = hunk.lines_in_hunk();
        let entry = if oid.is_zero() {
            BlameLine {
                hash: String::new(),
                short_hash: String::new(),
                author: "You".to_string(),
                timestamp: 0,
                summary: "Uncommitted change".to_string(),
            }
        } else {
            cache
                .entry(oid)
                .or_insert_with(|| {
                    let hash = oid.to_string();
                    let short_hash = hash[..7.min(hash.len())].to_string();
                    match repo.find_commit(oid) {
                        Ok(commit) => BlameLine {
                            hash: hash.clone(),
                            short_hash,
                            author: commit
                                .author()
                                .name()
                                .unwrap_or("")
                                .to_string(),
                            timestamp: commit.time().seconds(),
                            summary: commit
                                .summary()
                                .ok()
                                .flatten()
                                .unwrap_or("")
                                .to_string(),
                        },
                        Err(_) => BlameLine {
                            hash,
                            short_hash,
                            author: String::new(),
                            timestamp: 0,
                            summary: String::new(),
                        },
                    }
                })
                .clone()
        };
        // Hunks cover contiguous line ranges; expand to one entry per line.
        for _ in 0..count {
            lines.push(entry.clone());
        }
    }
    Ok(lines)
}

// === Branch management (local, git2) ======================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    name: String,
    is_current: bool,
}

/// List local branches, marking the current one.
#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<BranchInfo>, String> {
    let repo = open_repo(&root)?;
    let branches = repo
        .branches(Some(BranchType::Local))
        .map_err(|error| format!("Could not list branches: {error}"))?;

    let mut result = Vec::new();
    for branch in branches {
        let (branch, _) = branch
            .map_err(|error| format!("Could not read branch: {error}"))?;
        let is_current = branch.is_head();
        if let Ok(Some(name)) = branch.name() {
            result.push(BranchInfo {
                name: name.to_string(),
                is_current,
            });
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Checkout a local branch with the SAFE strategy: libgit2 refuses if
/// uncommitted working-tree changes would be overwritten, so we never
/// silently discard work. set_head only runs after a clean checkout.
fn checkout_branch(repo: &Repository, name: &str) -> Result<(), String> {
    let refname = format!("refs/heads/{name}");
    let object = repo
        .revparse_single(&refname)
        .map_err(|error| format!("Branch '{name}' not found: {error}"))?;

    let mut options = CheckoutBuilder::new();
    options.safe();
    repo.checkout_tree(&object, Some(&mut options)).map_err(|error| {
        // A SAFE checkout fails precisely when local changes collide with
        // the target — surface the actionable message.
        if error.message().to_lowercase().contains("conflict") {
            "You have uncommitted changes that would be overwritten. \
             Commit or stash them first."
                .to_string()
        } else {
            format!("Could not switch branch: {error}")
        }
    })?;
    repo.set_head(&refname)
        .map_err(|error| format!("Could not set HEAD: {error}"))
}

/// Create a branch from the current HEAD and switch to it.
#[tauri::command]
pub fn git_create_branch(root: String, name: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let head_commit = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|_| "Make a commit before creating a branch".to_string())?;
    repo.branch(&name, &head_commit, false)
        .map_err(|error| format!("Could not create branch: {error}"))?;
    checkout_branch(&repo, &name)
}

/// Switch to an existing local branch (safe — see checkout_branch).
#[tauri::command]
pub fn git_switch_branch(root: String, name: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    checkout_branch(&repo, &name)
}

/// Delete a local branch. Refuses to delete the branch you're on.
#[tauri::command]
pub fn git_delete_branch(root: String, name: String) -> Result<(), String> {
    let repo = open_repo(&root)?;
    let mut branch = repo
        .find_branch(&name, BranchType::Local)
        .map_err(|_| format!("Branch '{name}' not found"))?;
    if branch.is_head() {
        return Err("Cannot delete the branch you're currently on".to_string());
    }
    branch
        .delete()
        .map_err(|error| format!("Could not delete branch: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    ahead: usize,
    behind: usize,
    /// Whether the current branch tracks an upstream.
    has_upstream: bool,
    /// Whether the repo has any remote configured (gates push/pull in UI).
    has_remote: bool,
}

/// Compute how far the current branch is ahead/behind its upstream.
///
/// The upstream is the tracking branch configured for the current branch
/// (e.g. origin/main). `graph_ahead_behind(local, upstream)` returns the
/// number of commits each has that the other doesn't. No upstream (or a
/// detached/empty HEAD) yields zero counts and has_upstream:false.
#[tauri::command]
pub fn git_ahead_behind(root: String) -> Result<AheadBehind, String> {
    let repo = open_repo(&root)?;
    let has_remote = repo.remotes().map(|r| r.len() > 0).unwrap_or(false);

    let mut ahead = 0;
    let mut behind = 0;
    let mut has_upstream = false;

    if let Ok(head) = repo.head() {
        if let (Some(local_oid), Ok(branch_name)) =
            (head.target(), head.shorthand())
        {
            if let Ok(branch) =
                repo.find_branch(branch_name, BranchType::Local)
            {
                if let Ok(upstream) = branch.upstream() {
                    has_upstream = true;
                    if let Some(upstream_oid) = upstream.get().target() {
                        if let Ok((a, b)) =
                            repo.graph_ahead_behind(local_oid, upstream_oid)
                        {
                            ahead = a;
                            behind = b;
                        }
                    }
                }
            }
        }
    }

    Ok(AheadBehind {
        ahead,
        behind,
        has_upstream,
        has_remote,
    })
}

// ---------------------------------------------------------------------------
// NETWORK BOUNDARY
//
// Everything BELOW shells out to the `git` CLI — not git2 — so it reuses
// the user's SSH keys and credential helpers. GIT_TERMINAL_PROMPT=0 keeps
// a missing credential from hanging the app on a hidden prompt. All git2
// work above must finish (and the Repository drop) before any `.await`,
// since Repository isn't Send.
// ---------------------------------------------------------------------------

/// The repo working directory — the cwd we run `git` in.
fn repo_workdir(root: &str) -> Result<String, String> {
    let repo = open_repo(root)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Bare repositories are unsupported".to_string())?;
    Ok(workdir.to_string_lossy().into_owned())
}

/// Run `git <args>` in the repo non-interactively, returning combined
/// output on success or a friendly error (auth failures normalized).
async fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0") // never block on a credential prompt
        .output()
        .await
        .map_err(|error| format!("Could not run git: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_string())
    } else {
        let combined = format!("{stderr}{stdout}");
        let lowered = combined.to_lowercase();
        if lowered.contains("authentication failed")
            || lowered.contains("could not read username")
            || lowered.contains("permission denied")
            || lowered.contains("terminal prompts disabled")
        {
            Err("Authentication failed — check your credentials".to_string())
        } else if lowered.contains("conflict")
            || lowered.contains("automatic merge failed")
        {
            Err("Conflicts — resolve them in Source Control".to_string())
        } else {
            Err(combined.trim().to_string())
        }
    }
}

#[tauri::command]
pub async fn git_fetch(root: String) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    run_git(&workdir, &["fetch"]).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    run_git(&workdir, &["pull"]).await
}

/// Push the current branch. If it has no upstream yet, push with
/// `-u origin <branch>` to create and track it.
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    // git2 reads (sync) fully complete and drop before we await.
    let workdir = repo_workdir(&root)?;
    let (branch, has_upstream) = {
        let repo = open_repo(&root)?;
        let head = repo
            .head()
            .map_err(|_| "No branch to push (empty or detached HEAD)".to_string())?;
        let name = head
            .shorthand()
            .map_err(|_| "Detached HEAD — checkout a branch to push".to_string())?
            .to_string();
        let has_upstream = repo
            .find_branch(&name, BranchType::Local)
            .map(|branch| branch.upstream().is_ok())
            .unwrap_or(false);
        (name, has_upstream)
    };

    if has_upstream {
        run_git(&workdir, &["push"]).await
    } else {
        // New branch: set the upstream as we push.
        run_git(&workdir, &["push", "-u", "origin", &branch]).await
    }
}

/// Merge a branch into the current one. Conflicts are left in the working
/// tree for the merge tool.
#[tauri::command]
pub async fn git_merge(root: String, branch: String) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    run_git(&workdir, &["merge", "--no-edit", &branch]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            status.status.success() || args[0] == "merge",
            "git {args:?}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// A repo mid-merge with one conflicted file.
    fn conflicted_repo(name: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir()
            .join(format!("sable-git-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let file = dir.join("notes.txt");
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        git(&dir, &["checkout", "-qb", "feature"]);
        std::fs::write(&file, "one\nTWO (feature)\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "feature"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(&file, "one\ntwo (main)\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "main"]);
        git(&dir, &["merge", "feature"]);
        (dir, file.to_string_lossy().into_owned())
    }

    #[test]
    fn resolves_a_merge_conflict_and_commits_both_parents() {
        let (dir, file) = conflicted_repo("merge");
        let root = dir.to_string_lossy().into_owned();

        let status = git_status(root.clone()).unwrap();
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert!(status.merge_message.unwrap().contains("feature"));
        assert!(matches!(status.files[&file].unstaged, Some(FileStatus::Conflicted)));
        assert!(git_commit(root.clone(), "too early".into()).is_err());

        let versions = git_conflict_versions(root.clone(), file.clone()).unwrap();
        assert_eq!(versions.base, "one\ntwo\nthree\n");
        assert_eq!(versions.ours, "one\ntwo (main)\nthree\n");
        assert_eq!(versions.theirs, "one\nTWO (feature)\nthree\n");
        assert_eq!(versions.ours_label, "main");
        assert_eq!(versions.theirs_label, "feature");

        // Resolve, mark resolved (stage), commit.
        std::fs::write(&file, "one\ntwo (both)\nthree\n").unwrap();
        git_stage(root.clone(), file.clone()).unwrap();
        let status = git_status(root.clone()).unwrap();
        assert!(matches!(status.files[&file].staged, Some(FileStatus::Modified)));
        git_commit(root.clone(), "Merge feature".into()).unwrap();

        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(repo.state(), RepositoryState::Clean);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn aborts_a_merge() {
        let (dir, file) = conflicted_repo("abort");
        let root = dir.to_string_lossy().into_owned();
        git_merge_abort(root.clone()).unwrap();
        let status = git_status(root).unwrap();
        assert!(status.operation.is_none());
        assert!(status.files.is_empty());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "one\ntwo (main)\nthree\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stages_exact_content() {
        let (dir, file) = conflicted_repo("hunks");
        let root = dir.to_string_lossy().into_owned();
        git_merge_abort(root.clone()).unwrap();
        // Two changes on disk; stage only the first.
        std::fs::write(&file, "ONE\ntwo (main)\nTHREE\n").unwrap();
        git_stage_content(root.clone(), file.clone(), "ONE\ntwo (main)\nthree\n".into()).unwrap();
        let staged = git_file_diff(root.clone(), file.clone(), true).unwrap();
        assert_eq!(staged.modified, "ONE\ntwo (main)\nthree\n");
        let unstaged = git_file_diff(root.clone(), file.clone(), false).unwrap();
        assert_eq!(unstaged.original, "ONE\ntwo (main)\nthree\n");
        assert_eq!(unstaged.modified, "ONE\ntwo (main)\nTHREE\n");

        // A new file, staged in part.
        let new_file = dir.join("new.txt").to_string_lossy().into_owned();
        std::fs::write(&new_file, "a\nb\n").unwrap();
        git_stage_content(root.clone(), new_file.clone(), "a\n".into()).unwrap();
        let status = git_status(root).unwrap();
        assert!(matches!(status.files[&new_file].staged, Some(FileStatus::Added)));
        assert!(matches!(status.files[&new_file].unstaged, Some(FileStatus::Modified)));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A repo with one commit; returns (dir, root string, file path).
    fn simple_repo(name: &str) -> (std::path::PathBuf, String, String) {
        let dir = std::env::temp_dir().join(format!("sable-git-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let file = dir.join("notes.txt");
        git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        (dir.clone(), dir.to_string_lossy().into_owned(), file.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn stashes() {
        let (dir, root, file) = simple_repo("stash");
        std::fs::write(&file, "one\nTWO\nthree\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        git_stash_save(root.clone(), Some("my work".into()), true).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo\nthree\n");
        assert!(!dir.join("new.txt").exists());
        let stashes = git_stash_list(root.clone()).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("my work"), "{}", stashes[0].message);
        // Its changes read like a commit's.
        let files = git_commit_files(root.clone(), stashes[0].hash.clone()).unwrap();
        assert!(!files.is_empty());

        git_stash_apply(root.clone(), 0, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\nTWO\nthree\n");
        assert_eq!(git_stash_list(root.clone()).unwrap().len(), 1, "apply keeps it");
        git(&dir, &["checkout", "--", "."]);
        std::fs::remove_file(dir.join("new.txt")).unwrap();
        git_stash_apply(root.clone(), 0, true).await.unwrap();
        assert!(git_stash_list(root.clone()).unwrap().is_empty(), "pop drops it");
        git_stash_save(root.clone(), None, true).await.unwrap();
        git_stash_drop(root.clone(), 0).await.unwrap();
        assert!(git_stash_list(root.clone()).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn cherry_picks_and_reverts() {
        let (dir, root, file) = simple_repo("pick");
        git(&dir, &["checkout", "-qb", "feature"]);
        std::fs::write(dir.join("extra.txt"), "extra\n").unwrap();
        git(&dir, &["add", "."]);
        Command::new("git")
            .args(["-c", "user.name=Original Author", "-c", "user.email=original@example.com", "commit", "-qm", "Add extra"])
            .current_dir(&dir)
            .output()
            .unwrap();
        std::fs::write(&file, "one\nTWO (feature)\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "Feature edit"]);
        // (By name: commits made in the same second sort either way.)
        let (feature_edit, add_extra) = (rev_parse(&dir, "feature"), rev_parse(&dir, "feature~1"));
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(&file, "one\ntwo (main)\nthree\n").unwrap();
        git(&dir, &["commit", "-qam", "Main edit"]);

        // A clean pick.
        git_cherry_pick(root.clone(), add_extra).await.unwrap();
        assert!(dir.join("extra.txt").exists());
        let repo = Repository::open(&dir).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().ok().flatten(), Some("Add extra"));
        assert_eq!(head.author().name().ok(), Some("Original Author"));

        // A conflicting pick: resolve, commit — still the original author's
        // message prefilled and the operation finished.
        let error = git_cherry_pick(root.clone(), feature_edit).await.unwrap_err();
        assert!(error.starts_with("Conflicts"), "{error}");
        let status = git_status(root.clone()).unwrap();
        assert_eq!(status.operation.as_deref(), Some("cherry-pick"));
        assert!(status.merge_message.unwrap().contains("Feature edit"));
        std::fs::write(&file, "one\nTWO (both)\nthree\n").unwrap();
        git_stage(root.clone(), file.clone()).unwrap();
        git_commit(root.clone(), "Feature edit".into()).unwrap();
        assert!(git_status(root.clone()).unwrap().operation.is_none());
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        // The conflicting pick, finished by Sable's commit, keeps its
        // original author (the test identity), whoever commits it.
        assert_eq!(head.author().name().ok(), Some("Test"));

        // Revert the pick.
        let head = rev_parse(&dir, "HEAD");
        git_revert_commit(root.clone(), head).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo (main)\nthree\n");

        // Abort a conflicting pick.
        let error = git_cherry_pick(root.clone(), rev_parse(&dir, "feature")).await.unwrap_err();
        assert!(error.starts_with("Conflicts"), "{error}");
        git_abort(root.clone()).await.unwrap();
        assert!(git_status(root.clone()).unwrap().operation.is_none());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo (main)\nthree\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn rev_parse(dir: &Path, name: &str) -> String {
        let output = Command::new("git").args(["rev-parse", name]).current_dir(dir).output().unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}

// --- Stash, cherry-pick, revert ---------------------------------------------
//
// These shell out too: `git stash apply` and `git cherry-pick` merge, and
// leave conflicts for the merge tool exactly as Git users expect.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// stash@{index}
    index: usize,
    message: String,
    /// The stash's commit — its changes show like any commit's.
    hash: String,
    short_hash: String,
    /// Unix seconds.
    timestamp: i64,
}

#[tauri::command]
pub fn git_stash_list(root: String) -> Result<Vec<StashInfo>, String> {
    let mut repo = open_repo(&root)?;
    let mut found = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        found.push((index, message.to_string(), *oid));
        true
    })
    .map_err(|error| format!("Could not list stashes: {error}"))?;
    Ok(found
        .into_iter()
        .map(|(index, message, oid)| {
            let hash = oid.to_string();
            StashInfo {
                index,
                // "On main: message" / "WIP on main: abc123 summary".
                message,
                short_hash: hash[..7].to_string(),
                timestamp: repo.find_commit(oid).map(|commit| commit.time().seconds()).unwrap_or(0),
                hash,
            }
        })
        .collect())
}

/// Stash the working changes (and untracked files, if asked).
#[tauri::command]
pub async fn git_stash_save(root: String, message: Option<String>, include_untracked: bool) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let message = message.filter(|message| !message.trim().is_empty());
    if let Some(message) = &message {
        args.extend(["-m", message.as_str()]);
    }
    run_git(&workdir, &args).await
}

/// Apply a stash, keeping it (`pop: false`) or dropping it once applied.
#[tauri::command]
pub async fn git_stash_apply(root: String, index: usize, pop: bool) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    let reference = format!("stash@{{{index}}}");
    run_git(&workdir, &["stash", if pop { "pop" } else { "apply" }, &reference]).await
}

#[tauri::command]
pub async fn git_stash_drop(root: String, index: usize) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    let reference = format!("stash@{{{index}}}");
    run_git(&workdir, &["stash", "drop", &reference]).await
}

/// Apply a commit's change onto the current branch (a new commit).
#[tauri::command]
pub async fn git_cherry_pick(root: String, hash: String) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    run_git(&workdir, &["cherry-pick", &hash]).await
}

/// Undo a commit with a new commit that reverses it.
#[tauri::command]
pub async fn git_revert_commit(root: String, hash: String) -> Result<String, String> {
    let workdir = repo_workdir(&root)?;
    run_git(&workdir, &["revert", "--no-edit", &hash]).await
}

/// Abandon the operation in progress (merge, cherry-pick, revert, rebase).
#[tauri::command]
pub async fn git_abort(root: String) -> Result<String, String> {
    let (workdir, operation) = {
        let repo = open_repo(&root)?;
        (repo_workdir(&root)?, operation_name(&repo))
    };
    match operation.as_deref() {
        Some("merge") => git_merge_abort(root).map(|_| String::new()),
        Some(operation @ ("cherry-pick" | "revert" | "rebase")) => run_git(&workdir, &[operation, "--abort"]).await,
        _ => Err("Nothing to abort".to_string()),
    }
}
