import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { parentDirectoryOf } from "../ipc";
import { applyDiagnostics, type LspDiagnostic } from "../editorRegistry";

/**
 * Frontend side of the LSP bridge. Rust owns the server process; this
 * module decides *when* to start one (by file extension), keeps the
 * server's copy of each open document in sync, and turns the diagnostics
 * the server pushes back into Monaco markers.
 *
 * Document sync is the non-negotiable part: the server only produces
 * correct diagnostics/completions if it has the current buffer. So:
 *   open  → textDocument/didOpen   (full text, version 1)
 *   edit  → textDocument/didChange (full text, version++)
 *   close → textDocument/didClose
 */

/** Extensions Sable starts a server for, mapped to their LSP languageId. */
const LANGUAGE_IDS: Record<string, string> = {
  py: "python",
  pyi: "python",
};

/** Languages we've already asked Rust to start, so we don't spam it. */
const requestedExtensions = new Set<string>();

/** Per-document version counters; presence also means "didOpen sent". */
const documentVersions = new Map<string, number>();

export function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function languageIdFor(path: string): string | null {
  return LANGUAGE_IDS[extensionOf(path)] ?? null;
}

/** Build the `file://` URI for a path (mirrors the Rust side). */
function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** Inverse of pathToUri, for routing diagnostics back to a model. */
function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // Windows: file:///C:/... → "/C:/..."; strip the leading slash.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * Ensure a language server is running for the file's language. Returns
 * true once a server is available. No-op (returns false) for unsupported
 * languages; safe to call repeatedly.
 */
async function ensureLanguageServerForFile(path: string): Promise<boolean> {
  const extension = extensionOf(path);
  if (!LANGUAGE_IDS[extension]) return false;
  if (requestedExtensions.has(extension)) return true;
  requestedExtensions.add(extension);

  const rootPath =
    useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(path);
  try {
    await invoke("start_language_server", { extension, rootPath });
    return true;
  } catch (error) {
    requestedExtensions.delete(extension); // allow a later retry
    useUiStore.getState().setLastError(String(error));
    return false;
  }
}

/** Tell the server a document is now open (starting its server first). */
export async function openDocument(path: string, text: string): Promise<void> {
  const languageId = languageIdFor(path);
  if (!languageId) return;
  if (documentVersions.has(path)) return; // already open
  const ready = await ensureLanguageServerForFile(path);
  if (!ready) return;

  documentVersions.set(path, 1);
  await invoke("lsp_notify", {
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: pathToUri(path),
        languageId,
        version: 1,
        text,
      },
    },
  }).catch((error) => useUiStore.getState().setLastError(String(error)));
}

/**
 * Push an edit to the server. Full-document sync: we send the entire
 * buffer each time, which works regardless of the server's preferred
 * sync mode and is simplest to reason about.
 */
export async function changeDocument(
  path: string,
  text: string,
): Promise<void> {
  const version = documentVersions.get(path);
  if (version === undefined) return; // not an LSP-tracked document
  const nextVersion = version + 1;
  documentVersions.set(path, nextVersion);
  await invoke("lsp_notify", {
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: pathToUri(path), version: nextVersion },
      contentChanges: [{ text }],
    },
  }).catch((error) => useUiStore.getState().setLastError(String(error)));
}

/** Tell the server a document was closed (and clear its tracking). */
export async function closeDocument(path: string): Promise<void> {
  if (!documentVersions.has(path)) return;
  documentVersions.delete(path);
  await invoke("lsp_notify", {
    method: "textDocument/didClose",
    params: { textDocument: { uri: pathToUri(path) } },
  }).catch(() => {});
}

let listenersReady = false;

/** Register the Rust→frontend event listeners exactly once. */
export function initLspListeners(): void {
  if (listenersReady) return;
  listenersReady = true;

  listen<{ state: string; server?: string; capabilities?: unknown }>(
    "lsp:status",
    (event) => {
      const { state, server } = event.payload;
      if (state === "connected") {
        useUiStore.getState().setLspStatus(server ?? "Language server");
      } else if (state === "disconnected") {
        useUiStore.getState().setLspStatus(null);
      }
    },
  );

  // Server→client messages: responses (handled in 6c/6d) and unprompted
  // notifications. Diagnostics are the notification we care about now.
  listen<{
    method?: string;
    params?: { uri: string; diagnostics: LspDiagnostic[] };
  }>("lsp:message", (event) => {
    const message = event.payload;
    if (message.method === "textDocument/publishDiagnostics" && message.params) {
      applyDiagnostics(uriToPath(message.params.uri), message.params.diagnostics);
    }
  });
}
