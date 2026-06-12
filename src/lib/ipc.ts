import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around every Rust command. This is the only file that
 * calls `invoke()` directly — components and stores go through these so
 * the Rust↔frontend boundary stays in one place.
 */

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export function readDirectory(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("read_directory", { path });
}

export function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>("is_directory", { path });
}

export function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

export function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path });
}

export function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

/** Renames in place; returns the new absolute path. */
export function renamePath(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_path", { path, newName });
}

/** Start watching the workspace; changes arrive as `fs:changed` events. */
export function watchWorkspace(path: string): Promise<void> {
  return invoke<void>("watch_workspace", { path });
}

/** Parent directory of an absolute path, handling both separators. */
export function parentDirectoryOf(path: string): string {
  const lastSeparator = Math.max(
    path.lastIndexOf("/"),
    path.lastIndexOf("\\"),
  );
  return lastSeparator > 0 ? path.slice(0, lastSeparator) : path;
}
