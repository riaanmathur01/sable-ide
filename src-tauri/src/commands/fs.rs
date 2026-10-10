//! Filesystem commands — the only place Sable touches the disk for
//! workspace browsing. The frontend calls these via `invoke()` and never
//! reads the filesystem itself.

use serde::Serialize;
use std::path::Path;

/// One entry in a directory listing. `path` is absolute so the frontend
/// can use it directly as a stable key and pass it back to other commands.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

/// Read a single directory level. The tree loads lazily — one level per
/// expanded folder — so opening a workspace with tens of thousands of
/// files stays instant.
#[tauri::command]
pub fn read_directory(path: String) -> Result<Vec<FsEntry>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|error| format!("Could not read {path}: {error}"))?;

    let mut listing: Vec<FsEntry> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Symlink-aware: follow the link to decide file vs directory,
            // fall back to "file" if the target is unreadable.
            let is_directory = entry
                .metadata()
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            Some(FsEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name,
                is_directory,
            })
        })
        .collect();

    // Directories first, then case-insensitive by name — matches VS Code.
    listing.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(listing)
}

/// Used by drag-and-drop to decide whether a dropped path can be opened
/// as a workspace.
#[tauri::command]
pub fn is_directory(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    // `create_new` fails if the file exists, so we never clobber data.
    std::fs::File::create_new(&path)
        .map(|_| ())
        .map_err(|error| format!("Could not create file {path}: {error}"))
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir(&path)
        .map_err(|error| format!("Could not create folder {path}: {error}"))
}

/// Read a file as UTF-8 text for the editor. Binary/non-UTF-8 files
/// produce a friendly error instead of garbage in Monaco.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not open {path}: {error}"))
}

/// A file's bytes as base64 (images in the Markdown preview). Capped so a
/// huge file can't stall the webview.
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("Could not open {path}: {error}"))?;
    if metadata.len() > 20 * 1024 * 1024 {
        return Err(format!("{path} is too large to show"));
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("Could not open {path}: {error}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write editor contents back to disk (Cmd/Ctrl+S).
#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    super::history::record_original(&path);
    std::fs::write(&path, &contents)
        .map_err(|error| format!("Could not save {path}: {error}"))?;
    let _ = super::history::record(&path, &contents, "Saved");
    Ok(())
}

/// Permanently delete a file or folder (recursively). The frontend shows
/// a native confirm dialog before calling this.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    super::history::record_deletion(&path);
    let target = Path::new(&path);
    let result = if target.is_dir() {
        std::fs::remove_dir_all(target)
    } else {
        std::fs::remove_file(target)
    };
    result.map_err(|error| format!("Could not delete {path}: {error}"))
}

/// Move a file or folder into another directory (tree drag-and-drop).
/// Returns the new absolute path.
#[tauri::command]
pub fn move_path(source: String, target_directory: String) -> Result<String, String> {
    let source_path = Path::new(&source);
    let target_dir = Path::new(&target_directory);
    let entry_name = source_path
        .file_name()
        .ok_or_else(|| format!("{source} has no name"))?;

    if target_dir.starts_with(source_path) {
        return Err("Cannot move a folder into itself".to_string());
    }
    let destination = target_dir.join(entry_name);
    if destination == source_path {
        return Ok(source); // dropped where it already lives — no-op
    }
    if destination.exists() {
        return Err(format!(
            "{} already exists in that folder",
            entry_name.to_string_lossy()
        ));
    }
    std::fs::rename(source_path, &destination)
        .map_err(|error| format!("Could not move {source}: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Rename an entry in place. Takes the new *name* (not path) and joins it
/// here so path separators are handled on the Rust side for both OSes.
/// Whether two paths name the same file (e.g. `Main.py` and `main.py` on
/// a case-insensitive disk).
fn is_same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let source = Path::new(&path);
    let parent = source
        .parent()
        .ok_or_else(|| format!("{path} has no parent directory"))?;
    let destination = parent.join(&new_name);
    // On case-insensitive disks (macOS, Windows) `main.py` "exists" when
    // the file is `Main.py` — a case-only rename of the same file is fine.
    if destination.exists() && !is_same_file(source, &destination) {
        return Err(format!("{new_name} already exists"));
    }
    std::fs::rename(source, &destination)
        .map_err(|error| format!("Could not rename {path}: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_changes_only_case() {
        let dir = std::env::temp_dir().join(format!("sable-rename-case-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let original = dir.join("Main.py");
        std::fs::write(&original, "print(1)\n").unwrap();
        let renamed = rename_path(original.to_string_lossy().into_owned(), "main.py".into()).unwrap();
        assert!(renamed.ends_with("main.py"));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["main.py"]);
        // A real clash is still refused.
        std::fs::write(dir.join("other.py"), "").unwrap();
        assert!(rename_path(dir.join("other.py").to_string_lossy().into_owned(), "main.py".into()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
