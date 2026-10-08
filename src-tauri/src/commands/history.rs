//! Local history (as in JetBrains IDEs): a snapshot of a file each time
//! Sable writes it, and its last contents when Sable deletes it — so any
//! saved version can be compared with and restored, git or not.
//!
//! Stored in the app's data folder, one directory per file (named by a
//! hash of its path): `path` (the file's path), `index.jsonl` (one line
//! per snapshot) and the snapshots themselves.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Where history lives (set at startup).
static HISTORY_DIR: OnceLock<PathBuf> = OnceLock::new();
/// One writer at a time (saves can overlap with deletes).
static LOCK: Mutex<()> = Mutex::new(());

const MAX_SNAPSHOTS: usize = 100;
/// Saves within this long of a snapshot's first save update it instead of
/// adding one (auto-save writes after every pause in typing).
const MERGE_WINDOW_MS: u64 = 60_000;
const MAX_AGE_DAYS: u64 = 30;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Folders whose files aren't worth a history (generated or vendored).
const SKIPPED_FOLDERS: &[&str] = &[".git", "node_modules", "target", "__pycache__", ".venv", "venv", "build", "dist", ".gradle"];

pub fn set_history_dir(dir: PathBuf) {
    let _ = HISTORY_DIR.set(dir);
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Also the snapshot's file name.
    id: String,
    /// Unix milliseconds.
    timestamp: u64,
    /// What happened: "Saved", "Deleted", "Before first save", "Restored".
    label: String,
    size: usize,
    /// When this snapshot's first save happened (later saves within
    /// MERGE_WINDOW_MS replace its text).
    #[serde(default)]
    started: u64,
}

/// FNV-1a: a stable name for a path's folder (std's hasher isn't
/// guaranteed stable across Rust versions).
fn folder_for(path: &str) -> Option<PathBuf> {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(HISTORY_DIR.get()?.join(format!("{hash:016x}")))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis() as u64).unwrap_or(0)
}

/// Whether a file's changes are kept at all.
fn tracked(path: &Path) -> bool {
    if path.starts_with(std::env::temp_dir()) || path.starts_with("/tmp") || path.starts_with("/private/tmp") {
        return false;
    }
    !path.components().any(|part| SKIPPED_FOLDERS.iter().any(|skipped| part.as_os_str() == *skipped))
}

fn read_index(folder: &Path) -> Vec<Snapshot> {
    std::fs::read_to_string(folder.join("index.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn write_index(folder: &Path, snapshots: &[Snapshot]) -> std::io::Result<()> {
    let text: String = snapshots
        .iter()
        .filter_map(|snapshot| serde_json::to_string(snapshot).ok())
        .map(|line| line + "\n")
        .collect();
    std::fs::write(folder.join("index.jsonl"), text)
}

/// Keep `contents` as a snapshot of `path`. Errors are swallowed by callers: history must never break a
/// save.
pub fn record(path: &str, contents: &str, label: &str) -> std::io::Result<()> {
    if !tracked(Path::new(path)) || contents.len() as u64 > MAX_FILE_BYTES {
        return Ok(());
    }
    let Some(folder) = folder_for(path) else { return Ok(()) };
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(&folder)?;
    std::fs::write(folder.join("path"), path)?;
    let mut snapshots = read_index(&folder);
    // A repeat save of the same text adds nothing (a deletion still
    // counts, for "Recover Deleted File").
    if let Some(last) = snapshots.last().filter(|last| last.label == label) {
        if std::fs::read_to_string(folder.join(&last.id)).is_ok_and(|text| text == contents) {
            return Ok(());
        }
    }
    let timestamp = now_ms().max(snapshots.last().map_or(0, |last| last.timestamp + 1));
    let mut started = timestamp;
    // Merge a burst of saves into one snapshot.
    if label == "Saved" {
        if let Some(last) = snapshots.last().filter(|last| last.label == "Saved") {
            let since = if last.started > 0 { last.started } else { last.timestamp };
            if timestamp.saturating_sub(since) < MERGE_WINDOW_MS {
                started = since;
                let _ = std::fs::remove_file(folder.join(&last.id));
                snapshots.pop();
            }
        }
    }
    let id = format!("{timestamp}.snap");
    std::fs::File::create(folder.join(&id))?.write_all(contents.as_bytes())?;
    snapshots.push(Snapshot { id, timestamp, label: label.to_string(), size: contents.len(), started });
    // Prune: the newest MAX_SNAPSHOTS, none older than MAX_AGE_DAYS (but
    // always the latest, so a file's last state survives).
    let cutoff = timestamp.saturating_sub(MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    let keep_from = snapshots.len().saturating_sub(MAX_SNAPSHOTS);
    let last = snapshots.len() - 1;
    let (kept, dropped): (Vec<_>, Vec<_>) = snapshots
        .into_iter()
        .enumerate()
        .partition(|(index, snapshot)| *index == last || (*index >= keep_from && snapshot.timestamp >= cutoff));
    for (_, snapshot) in dropped {
        let _ = std::fs::remove_file(folder.join(&snapshot.id));
    }
    write_index(&folder, &kept.into_iter().map(|(_, snapshot)| snapshot).collect::<Vec<_>>())
}

/// Before writing `path`: if it has no history yet, keep what's on disk
/// now — the version from before Sable first changed it.
pub fn record_original(path: &str) {
    let Some(folder) = folder_for(path) else { return };
    if folder.join("index.jsonl").exists() || !tracked(Path::new(path)) {
        return;
    }
    if let Ok(text) = std::fs::read_to_string(path) {
        let _ = record(path, &text, "Before first save");
    }
}

/// Before deleting `path` (a file, or every text file in a folder).
pub fn record_deletion(path: &str) {
    let target = Path::new(path);
    if target.is_dir() {
        let mut files = Vec::new();
        collect_files(target, &mut files, 0);
        for file in files.into_iter().take(500) {
            if let Ok(text) = std::fs::read_to_string(&file) {
                let _ = record(&file.to_string_lossy(), &text, "Deleted");
            }
        }
    } else if let Ok(text) = std::fs::read_to_string(target) {
        let _ = record(path, &text, "Deleted");
    }
}

fn collect_files(dir: &Path, files: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 || files.len() > 500 || !tracked(dir) {
        return;
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, files, depth + 1);
        } else {
            files.push(path);
        }
    }
}

/// A file's snapshots, newest first.
#[tauri::command]
pub fn history_list(path: String) -> Vec<Snapshot> {
    let Some(folder) = folder_for(&path) else { return Vec::new() };
    let mut snapshots = read_index(&folder);
    snapshots.reverse();
    snapshots
}

#[tauri::command]
pub fn history_read(path: String, id: String) -> Result<String, String> {
    let folder = folder_for(&path).ok_or("No history folder")?;
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Bad snapshot id".into());
    }
    std::fs::read_to_string(folder.join(id)).map_err(|error| format!("Could not read the snapshot: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFile {
    path: String,
    /// When it was deleted (its last snapshot), Unix ms.
    deleted_at: u64,
}

/// Files under `root` that Sable deleted and that are still gone, newest
/// first — for "Recover Deleted File".
#[tauri::command]
pub fn history_deleted_files(root: String) -> Vec<DeletedFile> {
    let Some(dir) = HISTORY_DIR.get() else { return Vec::new() };
    let mut found: Vec<DeletedFile> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let folder = entry.path();
            let path = std::fs::read_to_string(folder.join("path")).ok()?;
            if !Path::new(&path).starts_with(&root) || Path::new(&path).exists() {
                return None;
            }
            let last = read_index(&folder).pop()?;
            (last.label == "Deleted").then_some(DeletedFile { path, deleted_at: last.timestamp })
        })
        .collect();
    found.sort_by_key(|file| std::cmp::Reverse(file.deleted_at));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_saves_deletions_and_originals() {
        let base = std::env::temp_dir().join(format!("sable-history-test-{}", std::process::id()));
        set_history_dir(base.join("history"));
        // Files under the temp dir aren't tracked, so use a folder in HOME.
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let project = home.join(format!(".sable-history-test-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();
        let file = project.join("notes.txt");
        let path = file.to_string_lossy().into_owned();
        std::fs::write(&file, "original\n").unwrap();

        // First save keeps the original, then the new text. Saves in
        // quick succession (auto-save) merge into one snapshot holding the
        // latest text.
        crate::commands::fs::write_file(path.clone(), "first\n".into()).unwrap();
        crate::commands::fs::write_file(path.clone(), "first\n".into()).unwrap();
        crate::commands::fs::write_file(path.clone(), "second\n".into()).unwrap();
        let snapshots = history_list(path.clone());
        let labels: Vec<_> = snapshots.iter().map(|snapshot| snapshot.label.as_str()).collect();
        assert_eq!(labels, ["Saved", "Before first save"]);
        assert_eq!(history_read(path.clone(), snapshots[1].id.clone()).unwrap(), "original\n");
        assert_eq!(history_read(path.clone(), snapshots[0].id.clone()).unwrap(), "second\n");
        // A save after the window starts a new snapshot.
        {
            let folder = folder_for(&path).unwrap();
            let mut index = read_index(&folder);
            let last = index.last_mut().unwrap();
            last.started -= MERGE_WINDOW_MS;
            write_index(&folder, &index).unwrap();
        }
        crate::commands::fs::write_file(path.clone(), "third\n".into()).unwrap();
        assert_eq!(history_list(path.clone()).len(), 3);
        assert!(history_read(path.clone(), "../path".into()).is_err());

        // Deleting keeps the last contents and lists the file as recoverable.
        crate::commands::fs::delete_path(path.clone()).unwrap();
        let deleted = history_deleted_files(project.to_string_lossy().into_owned());
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].path, path);

        // Pruning keeps the newest MAX_SNAPSHOTS.
        for n in 0..(MAX_SNAPSHOTS + 5) {
            record(&path, &format!("v{n}\n"), if n % 2 == 0 { "Saved" } else { "Restored" }).unwrap();
        }
        assert_eq!(history_list(path.clone()).len(), MAX_SNAPSHOTS);
        let folder = folder_for(&path).unwrap();
        let files = std::fs::read_dir(&folder).unwrap().filter(|entry| entry.as_ref().unwrap().path().extension().is_some_and(|ext| ext == "snap")).count();
        assert_eq!(files, MAX_SNAPSHOTS);

        // Temp files (test reports etc.) aren't tracked.
        let temp = std::env::temp_dir().join("sable-history-temp.txt");
        crate::commands::fs::write_file(temp.to_string_lossy().into_owned(), "x".into()).unwrap();
        assert!(history_list(temp.to_string_lossy().into_owned()).is_empty());

        let _ = std::fs::remove_dir_all(project);
        let _ = std::fs::remove_dir_all(base);
    }
}
