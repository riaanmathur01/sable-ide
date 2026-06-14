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

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents });
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

/** Moves an entry into another directory; returns the new path. */
export function movePath(
  source: string,
  targetDirectory: string,
): Promise<string> {
  return invoke<string>("move_path", { source, targetDirectory });
}

/** Start watching the workspace; changes arrive as `fs:changed` events. */
export function watchWorkspace(path: string): Promise<void> {
  return invoke<void>("watch_workspace", { path });
}

export function createTerminal(
  id: string,
  cols: number,
  rows: number,
  cwd: string | null,
): Promise<void> {
  return invoke<void>("create_terminal", { id, cols, rows, cwd });
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return invoke<void>("write_terminal", { id, data });
}

export function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_terminal", { id, cols, rows });
}

export function killTerminal(id: string): Promise<void> {
  return invoke<void>("kill_terminal", { id });
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed";

/** A file's status split into staged (index) and unstaged (working tree). */
export interface GitFileEntry {
  staged: GitFileStatus | null;
  unstaged: GitFileStatus | null;
}

export interface GitStatus {
  isRepo: boolean;
  /** Branch name, short hash (detached HEAD), or null (empty repo). */
  branch: string | null;
  /** Absolute file path → split status, matching file-tree node keys. */
  files: Record<string, GitFileEntry>;
}

/** Read git status for the workspace; non-repo folders return isRepo:false. */
export function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
}

export function gitStage(root: string, file: string): Promise<void> {
  return invoke<void>("git_stage", { root, file });
}

export function gitUnstage(root: string, file: string): Promise<void> {
  return invoke<void>("git_unstage", { root, file });
}

export function gitStageAll(root: string): Promise<void> {
  return invoke<void>("git_stage_all", { root });
}

export function gitUnstageAll(root: string): Promise<void> {
  return invoke<void>("git_unstage_all", { root });
}

export function gitCommit(root: string, message: string): Promise<void> {
  return invoke<void>("git_commit", { root, message });
}

export function gitSetIdentity(name: string, email: string): Promise<void> {
  return invoke<void>("git_set_identity", { name, email });
}

export interface SearchMatch {
  path: string;
  /** 0 for file/folder-name matches. */
  lineNumber: number;
  /** The matching line for content hits; the entry name for name hits. */
  preview: string;
  kind: "file" | "folder" | "content";
}

/**
 * Start a streaming workspace search. The caller supplies a fresh,
 * monotonically increasing id (see searchStore) so it can tag results
 * before any batch arrives. Matches stream as `search:results` events,
 * completion as `search:done`.
 */
export function searchWorkspace(
  root: string,
  query: string,
  searchId: number,
): Promise<void> {
  return invoke<void>("search_workspace", { root, query, searchId });
}

/** Parent directory of an absolute path, handling both separators. */
export function parentDirectoryOf(path: string): string {
  const lastSeparator = Math.max(
    path.lastIndexOf("/"),
    path.lastIndexOf("\\"),
  );
  return lastSeparator > 0 ? path.slice(0, lastSeparator) : path;
}
