import { invoke } from "@tauri-apps/api/core";
import type { SearchOptions } from "./replace";

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

/** A terminal running one program (not a shell); resolves to its pid. */
export function createCommandTerminal(
  id: string,
  args: string[],
  cwd: string | null,
  env: Record<string, string | null> | null,
  cols: number,
  rows: number,
): Promise<number> {
  return invoke<number>("create_command_terminal", { id, args, cwd, env, cols, rows });
}

export function killTerminal(id: string): Promise<void> {
  return invoke<void>("kill_terminal", { id });
}

export type GitFileStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflicted";

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
  /** An operation the next commit finishes ("merge", "cherry-pick", …). */
  operation: string | null;
  /** Git's prepared message for it (MERGE_MSG). */
  mergeMessage: string | null;
}

/** Read git status for the workspace; non-repo folders return isRepo:false. */
export function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
}

export interface FileDiff {
  original: string;
  modified: string;
  isBinary: boolean;
}

/** The two versions of a file to diff (staged: index vs HEAD). */
export function gitFileDiff(
  root: string,
  file: string,
  staged: boolean,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { root, file, staged });
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: number; // Unix seconds
  summary: string;
  body: string;
  /** Parent hashes (the graph's edges). */
  parents: string[];
  /** Branches and tags pointing here ("main", "origin/main", "tag: v1.0"). */
  refs: string[];
}

export interface CommitFile {
  path: string; // repo-relative
  status: GitFileStatus;
}

export interface BlameLine {
  hash: string; // full commit hash; "" for uncommitted
  shortHash: string;
  author: string;
  timestamp: number; // Unix seconds; 0 for uncommitted
  summary: string;
}

/** Per-line blame for a file (empty for new/untracked files). */
export function gitBlame(root: string, file: string): Promise<BlameLine[]> {
  return invoke<BlameLine[]>("git_blame", { root, file });
}

/** Paginated commit log from HEAD backward. */
export function gitLog(
  root: string,
  limit: number,
  skip: number,
  branch: string | null = null,
): Promise<CommitInfo[]> {
  return invoke<CommitInfo[]>("git_log", { root, limit, skip, branch });
}

/** Files changed by a commit (vs its first parent). */
export function gitCommitFiles(
  root: string,
  hash: string,
): Promise<CommitFile[]> {
  return invoke<CommitFile[]>("git_commit_files", { root, hash });
}

/** Before/after of one file at a commit, for the diff viewer. */
export function gitCommitFileDiff(
  root: string,
  hash: string,
  file: string,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_commit_file_diff", { root, hash, file });
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

// --- Local history ---------------------------------------------------------

export interface HistorySnapshot {
  id: string;
  /** Unix milliseconds. */
  timestamp: number;
  /** "Saved", "Deleted", "Before first save". */
  label: string;
  size: number;
}

export function historyList(path: string): Promise<HistorySnapshot[]> {
  return invoke<HistorySnapshot[]>("history_list", { path });
}

export function historyRead(path: string, id: string): Promise<string> {
  return invoke<string>("history_read", { path, id });
}

export function historyDeletedFiles(root: string): Promise<{ path: string; deletedAt: number }[]> {
  return invoke("history_deleted_files", { root });
}

/** Stage exactly `content` as the file's next-commit version (hunks). */
export function gitStageContent(root: string, file: string, content: string): Promise<void> {
  return invoke<void>("git_stage_content", { root, file, content });
}

export interface ConflictVersions {
  base: string;
  ours: string;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

export function gitConflictVersions(root: string, file: string): Promise<ConflictVersions> {
  return invoke<ConflictVersions>("git_conflict_versions", { root, file });
}

export function gitMerge(root: string, branch: string): Promise<string> {
  return invoke<string>("git_merge", { root, branch });
}

export interface StashInfo {
  index: number;
  message: string;
  hash: string;
  shortHash: string;
  timestamp: number;
}

export function gitStashList(root: string): Promise<StashInfo[]> {
  return invoke<StashInfo[]>("git_stash_list", { root });
}

export function gitStashSave(root: string, message: string | null, includeUntracked: boolean): Promise<string> {
  return invoke<string>("git_stash_save", { root, message, includeUntracked });
}

export function gitStashApply(root: string, index: number, pop: boolean): Promise<string> {
  return invoke<string>("git_stash_apply", { root, index, pop });
}

export function gitStashDrop(root: string, index: number): Promise<string> {
  return invoke<string>("git_stash_drop", { root, index });
}

export function gitCherryPick(root: string, hash: string): Promise<string> {
  return invoke<string>("git_cherry_pick", { root, hash });
}

export function gitRevertCommit(root: string, hash: string): Promise<string> {
  return invoke<string>("git_revert_commit", { root, hash });
}

export interface RebaseStep {
  action: "pick" | "reword" | "squash" | "fixup" | "drop";
  hash: string;
  message?: string;
}

export function gitRebase(root: string, onto: string): Promise<string> {
  return invoke<string>("git_rebase", { root, onto });
}

export function gitRebaseInteractive(root: string, base: string, steps: RebaseStep[]): Promise<string> {
  return invoke<string>("git_rebase_interactive", { root, base, steps });
}

export function gitRebaseContinue(root: string, skip: boolean): Promise<string> {
  return invoke<string>("git_rebase_continue", { root, skip });
}

export function gitAbort(root: string): Promise<string> {
  return invoke<string>("git_abort", { root });
}

export function gitSetIdentity(name: string, email: string): Promise<void> {
  return invoke<void>("git_set_identity", { name, email });
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasRemote: boolean;
}

export function gitBranches(root: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("git_branches", { root });
}

export function gitCreateBranch(root: string, name: string): Promise<void> {
  return invoke<void>("git_create_branch", { root, name });
}

export function gitSwitchBranch(root: string, name: string): Promise<void> {
  return invoke<void>("git_switch_branch", { root, name });
}

export function gitDeleteBranch(root: string, name: string): Promise<void> {
  return invoke<void>("git_delete_branch", { root, name });
}

export function gitAheadBehind(root: string): Promise<AheadBehind> {
  return invoke<AheadBehind>("git_ahead_behind", { root });
}

export function gitFetch(root: string): Promise<string> {
  return invoke<string>("git_fetch", { root });
}

export function gitPull(root: string): Promise<string> {
  return invoke<string>("git_pull", { root });
}

export function gitPush(root: string): Promise<string> {
  return invoke<string>("git_push", { root });
}

export interface Interpreter {
  path: string;
  label: string;
  version: string;
  kind: string; // "pypy" | "cpython" | "venv"
}

export function discoverPythonInterpreters(
  root: string | null,
): Promise<Interpreter[]> {
  return invoke<Interpreter[]>("discover_python_interpreters", { root });
}

export function createPythonVenv(
  base: string,
  targetDir: string,
): Promise<Interpreter> {
  return invoke<Interpreter>("create_python_venv", { base, targetDir });
}

export interface SearchMatch {
  path: string;
  /** 0 for file/folder-name matches. */
  lineNumber: number;
  /** The matching line for content hits; the entry name for name hits. */
  preview: string;
  kind: "file" | "folder" | "content";
}

/** List all files in the workspace (for quick-open / Cmd+P). */
export function listWorkspaceFiles(root: string): Promise<string[]> {
  return invoke<string[]>("list_workspace_files", { root });
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
  options?: SearchOptions,
): Promise<void> {
  return invoke<void>("search_workspace", { root, query, searchId, options });
}

/** Every file with at least one match (for Replace All). */
export function filesWithMatches(
  root: string,
  query: string,
  options: SearchOptions,
): Promise<string[]> {
  return invoke<string[]>("files_with_matches", { root, query, options });
}

/** One-shot content search (used by the AI agent). */
export function searchText(
  root: string,
  query: string,
  isRegex: boolean,
  maxResults: number,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_text", {
    root,
    query,
    isRegex,
    maxResults,
  });
}

/** Tell Pyright which interpreter to resolve imports against. */
export function lspSetPythonPath(path: string | null): Promise<void> {
  return invoke<void>("lsp_set_python_path", { path });
}

/** Install basedpyright into Sable's tools folder (semantic highlighting). */
export function installTypeScriptServer(): Promise<void> {
  return invoke<void>("install_typescript_server");
}

export function installBasedpyright(): Promise<void> {
  return invoke<void>("install_basedpyright");
}

/** Whether Python's language server provides semantic highlighting. */
export function pythonServerHasSemanticTokens(): Promise<boolean> {
  return invoke<boolean>("python_server_has_semantic_tokens");
}

/** Installed monospace font families (for the font pickers). */
export function listMonospaceFonts(): Promise<string[]> {
  return invoke<string[]>("list_monospace_fonts");
}

// --- Settings -------------------------------------------------------------

export function settingsPath(): Promise<string> {
  return invoke<string>("settings_path");
}

/** The raw user settings object (only keys the user changed). */
export function loadSettings(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>("load_settings");
}

export function saveSettings(settings: Record<string, unknown>): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

// --- Shell (AI agent commands) ---------------------------------------------

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Run a command non-interactively in the user's login shell. */
export function runShell(
  command: string,
  cwd: string,
  timeoutSecs: number,
): Promise<ShellOutput> {
  return invoke<ShellOutput>("run_shell", { command, cwd, timeoutSecs });
}

// --- AI providers ------------------------------------------------------------

export type AiProvider = "anthropic" | "openai" | "google";

/** Store a key in the OS keychain (it never comes back to the frontend). */
export function aiSetApiKey(provider: AiProvider, key: string): Promise<void> {
  return invoke<void>("ai_set_api_key", { provider, key });
}

export function aiDeleteApiKey(provider: AiProvider): Promise<void> {
  return invoke<void>("ai_delete_api_key", { provider });
}

/** Which providers have a key configured. */
export function aiKeyStatus(): Promise<Record<AiProvider, boolean>> {
  return invoke<Record<AiProvider, boolean>>("ai_key_status");
}

/** One model call with a provider-native body; returns the raw response. */
export function aiComplete(
  provider: AiProvider,
  model: string,
  body: unknown,
  baseUrl: string | null,
): Promise<unknown> {
  return invoke<unknown>("ai_complete", { provider, model, body, baseUrl });
}

/** Start a streamed model call; events arrive as `ai:stream`. */
export function aiStream(
  provider: AiProvider,
  model: string,
  body: unknown,
  baseUrl: string | null,
  streamId: string,
): Promise<void> {
  return invoke<void>("ai_stream", { provider, model, body, baseUrl, streamId });
}

/** Abort an in-flight stream. */
export function aiCancel(streamId: string): Promise<void> {
  return invoke<void>("ai_cancel", { streamId });
}

/** A workspace's saved agent chats (null if none). */
export function loadChats(root: string): Promise<unknown> {
  return invoke<unknown>("load_chats", { root });
}

export function saveChats(root: string, chats: unknown): Promise<void> {
  return invoke<void>("save_chats", { root, chats });
}

export function aiListModels(
  provider: AiProvider,
  baseUrl: string | null,
): Promise<string[]> {
  return invoke<string[]>("ai_list_models", { provider, baseUrl });
}

/** Parent directory of an absolute path, handling both separators. */
export function parentDirectoryOf(path: string): string {
  const lastSeparator = Math.max(
    path.lastIndexOf("/"),
    path.lastIndexOf("\\"),
  );
  return lastSeparator > 0 ? path.slice(0, lastSeparator) : path;
}
