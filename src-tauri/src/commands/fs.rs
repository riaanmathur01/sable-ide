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
