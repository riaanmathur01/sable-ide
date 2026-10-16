import { invokeLocal } from "../backend";

/**
 * The window's Claude Code IDE server (src-tauri/src/claude_code.rs).
 * Always this machine's backend, even in a remote window: the server and
 * its lock file live where Sable runs.
 */

export interface ClaudeCodeServerStatus {
  running: boolean;
  port: number | null;
  clients: number;
  clientPids: number[];
  lockFile: string | null;
  folders: string[];
}

/** The installed `claude` CLI (Anthropic's). */
export interface ClaudeCli {
  path: string;
  version: string | null;
  /** The user's login shell (unix), to start the CLI with their PATH. */
  shell: string | null;
}

/** A tool call from the CLI, relayed to this window. */
export interface ToolRequest {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** An MCP tool result. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const startServer = (folders: string[]) => invokeLocal<ClaudeCodeServerStatus>("claude_code_start", { folders });
export const stopServer = () => invokeLocal<void>("claude_code_stop");
export const serverStatus = () => invokeLocal<ClaudeCodeServerStatus>("claude_code_status");
export const setServerFolders = (folders: string[]) => invokeLocal<void>("claude_code_set_folders", { folders });
export const respond = (id: string, result: ToolResult) => invokeLocal<boolean>("claude_code_respond", { id, result });
export const notify = (method: "selection_changed" | "at_mentioned", params: unknown) =>
  invokeLocal<number>("claude_code_notify", { method, params });
/** Find `claude`: the path from Settings, else PATH and Anthropic's install locations. */
export const findCli = (path: string | null) => invokeLocal<ClaudeCli | null>("claude_code_find_cli", { path });

export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
export const json = (value: unknown): ToolResult => text(JSON.stringify(value));
export const toolError = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });
