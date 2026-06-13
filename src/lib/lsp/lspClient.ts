import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { parentDirectoryOf } from "../ipc";

/**
 * Frontend side of the LSP bridge. Rust owns the server process; this
 * module decides *when* to start one (by file extension), kicks it off,
 * and listens for the status/message events Rust relays back.
 *
 * Phase 6a only needs: start the server for Python files and surface the
 * connection status. Document sync and feature requests arrive in 6b+.
 */

/** Extensions Sable knows how to start a server for (mirrors Rust). */
const SUPPORTED_EXTENSIONS = new Set(["py", "pyi"]);

/** Languages we've already asked Rust to start, so we don't spam it. */
const requestedExtensions = new Set<string>();

export function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Ensure a language server is running for the given file's language.
 * Safe to call on every file open — it's a no-op after the first call
 * per language (and the Rust side is idempotent too).
 */
export async function ensureLanguageServerForFile(path: string): Promise<void> {
  const extension = extensionOf(path);
  if (!SUPPORTED_EXTENSIONS.has(extension)) return;
  if (requestedExtensions.has(extension)) return;
  requestedExtensions.add(extension);

  // Pyright needs a project root; fall back to the file's folder if no
  // workspace is open.
  const rootPath =
    useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(path);

  try {
    await invoke("start_language_server", { extension, rootPath });
  } catch (error) {
    // Let it be retried on a later open (e.g. after installing Pyright).
    requestedExtensions.delete(extension);
    useUiStore.getState().setLastError(String(error));
  }
}

let listenersReady = false;

/** Register the Rust→frontend event listeners exactly once. */
export function initLspListeners(): void {
  if (listenersReady) return;
  listenersReady = true;

  listen<{
    state: string;
    server?: string;
    capabilities?: unknown;
  }>("lsp:status", (event) => {
    const { state, server, capabilities } = event.payload;
    if (state === "connected") {
      // eslint-disable-next-line no-console
      console.log(`[lsp] ${server} connected. Capabilities:`, capabilities);
      useUiStore.getState().setLspStatus(server ?? "Language server");
    } else if (state === "disconnected") {
      // eslint-disable-next-line no-console
      console.warn("[lsp] server disconnected");
      useUiStore.getState().setLspStatus(null);
    }
  });

  // Server→client messages (responses + notifications). Wired to
  // features in 6b+; logged for now to prove the pipe is live.
  listen<Record<string, unknown>>("lsp:message", (event) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug("[lsp] message", event.payload);
    }
  });
}
