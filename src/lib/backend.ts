import { invoke as invokeTauri, type InvokeArgs } from "@tauri-apps/api/core";
import { appConfigDir, appDataDir } from "@tauri-apps/api/path";

/**
 * Where backend commands run. Locally, everything goes to this app's
 * Rust backend. With a remote workspace open (SSH, WSL, a container — see
 * src-tauri/src/remote.rs), workspace commands go to Sable's agent on
 * that machine instead, and its events come back under the same names,
 * so the rest of the frontend doesn't know the difference.
 *
 * Sable's own files (settings, snippets, plugins) stay local: file
 * commands on paths inside a local root run here even when remote.
 */

/** The commands the remote agent serves (src-tauri/src/agent.rs). */
export const REMOTE_COMMANDS = new Set([
  "read_directory",
  "read_file",
  "read_file_base64",
  "write_file",
  "write_file_base64",
  "is_directory",
  "path_exists",
  "real_path",
  "create_file",
  "create_directory",
  "delete_path",
  "rename_path",
  "move_path",
  "watch_workspace",
  "history_list",
  "history_read",
  "history_deleted_files",
  "list_workspace_files",
  "search_workspace",
  "search_text",
  "files_with_matches",
  "create_terminal",
  "create_command_terminal",
  "write_terminal",
  "resize_terminal",
  "kill_terminal",
  "run_shell",
  "ports_list",
  "ports_watch",
  "tunnel_open",
  "tunnel_close",
  "start_language_server",
  "lsp_notify",
  "lsp_request",
  "stop_language_servers",
  "lsp_set_python_path",
  "install_basedpyright",
  "install_typescript_server",
  "install_php_server",
  "python_server_has_semantic_tokens",
  "python_formatter",
  "format_with",
  "install_ruff",
  "python_refactor",
  "install_rope",
  "discover_python_interpreters",
  "create_python_venv",
  "start_debug",
  "start_attach",
  "start_java_debug",
  "debug_request",
  "debug_stop",
  "debug_terminal_started",
  "install_debugpy",
  "install_js_debug",
  "install_java_debug",
  "java_debug_installed",
  "list_processes",
  "jvm_debug_listen",
  "jvm_debug_accept",
  "jvm_debug_cancel",
  "git_status",
  "git_stage",
  "git_unstage",
  "git_stage_all",
  "git_unstage_all",
  "git_stage_content",
  "git_commit",
  "git_conflict_versions",
  "git_merge_abort",
  "git_merge",
  "git_file_diff",
  "git_log",
  "git_stash_list",
  "git_stash_save",
  "git_stash_apply",
  "git_stash_drop",
  "git_cherry_pick",
  "git_revert_commit",
  "git_abort",
  "git_rebase",
  "git_rebase_interactive",
  "git_rebase_continue",
  "git_commit_files",
  "git_commit_file_diff",
  "git_blame",
  "git_branches",
  "git_create_branch",
  "git_switch_branch",
  "git_delete_branch",
  "git_ahead_behind",
  "git_set_identity",
  "git_fetch",
  "git_pull",
  "git_push",
]);

/** File commands, and the argument holding the path they act on. */
const PATH_ARGUMENT: Record<string, string> = {
  read_directory: "path",
  read_file: "path",
  read_file_base64: "path",
  write_file: "path",
  write_file_base64: "path",
  is_directory: "path",
  path_exists: "path",
  real_path: "path",
  create_file: "path",
  create_directory: "path",
  delete_path: "path",
  rename_path: "path",
  move_path: "source",
  history_list: "path",
  history_read: "path",
};

let remote = false;
let localRoots: string[] = [];

/** Send workspace commands to the remote agent (or stop). */
export function setRemoteActive(active: boolean): void {
  remote = active;
}

export function isRemoteActive(): boolean {
  return remote;
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** Folders whose files always stay local (Sable's own data, plugins). */
export function setLocalRoots(roots: string[]): void {
  localRoots = [...new Set(roots.filter(Boolean).map(normalize))];
}

export function addLocalRoot(root: string): void {
  setLocalRoots([...localRoots, root]);
}

/** Sable's settings, snippets, plugins and data folders: always local. */
export async function initLocalRoots(): Promise<void> {
  const roots = await Promise.all([appConfigDir(), appDataDir()].map((dir) => dir.catch(() => "")));
  setLocalRoots([...localRoots, ...roots]);
}

function isLocalPath(path: unknown): boolean {
  if (typeof path !== "string" || !path) return false;
  const wanted = normalize(path);
  return localRoots.some((root) => wanted === root || wanted.startsWith(`${root}/`));
}

/** Whether `cmd` (with `args`) runs on the remote right now. */
export function runsRemotely(cmd: string, args?: InvokeArgs): boolean {
  if (!remote || !REMOTE_COMMANDS.has(cmd)) return false;
  const key = PATH_ARGUMENT[cmd];
  return !(key && isLocalPath((args as Record<string, unknown> | undefined)?.[key]));
}

/** `invoke`, routed to the remote agent when a remote workspace is open. */
export function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  if (runsRemotely(cmd, args)) {
    return invokeTauri<T>("remote_call", { cmd, args: args ?? {} });
  }
  return invokeTauri<T>(cmd, args);
}

/** Always this machine's backend (Sable's own files, plugins, dialogs). */
export const invokeLocal = invokeTauri;
