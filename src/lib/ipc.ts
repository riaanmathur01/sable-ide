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
