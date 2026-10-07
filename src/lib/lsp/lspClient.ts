import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useUiStore } from "../../store/uiStore";
import { useDiagnosticsStore } from "../../store/diagnosticsStore";
import { parentDirectoryOf } from "../ipc";
import { applyDiagnostics, getModelValue, type LspDiagnostic } from "../editorRegistry";
import { allOpenFiles } from "../../store/tabsStore";
import { installBasedpyright, readFile } from "../ipc";
import { useProblemsStore } from "../../store/problemsStore";
import { applyWorkspaceEdit, type LspWorkspaceEdit } from "./workspaceEdit";

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

/** Extensions Sable starts a server for, mapped to their LSP languageId.
 *  (Must mirror server_id_for_extension on the Rust side.) */
const LANGUAGE_IDS: Record<string, string> = {
  py: "python",
  pyi: "python",
  java: "java",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
};

/** Extension → server id (mirrors server_id_for_extension in Rust). */
const SERVER_IDS: Record<string, string> = {
  py: "pyright",
  pyi: "pyright",
  java: "java",
  rs: "rust-analyzer",
  go: "gopls",
  ...Object.fromEntries(["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx"].map((ext) => [ext, "clangd"])),
  ...Object.fromEntries(
    ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"].map((ext) => [ext, "typescript"]),
  ),
};

export function serverIdFor(path: string): string | null {
  return SERVER_IDS[extensionOf(path)] ?? null;
}

/** Capabilities of each connected server (by id), from its handshake. */
const serverCapabilities = new Map<string, Record<string, any>>();

export function capabilitiesOf(serverId: string): Record<string, any> | null {
  return serverCapabilities.get(serverId) ?? null;
}

type ServerListener = (serverId: string, connected: boolean) => void;
const serverListeners = new Set<ServerListener>();

/**
 * Be told when a language server connects or disconnects (the editor
 * registers semantic highlighting and swaps the built-in TS service).
 * Fires immediately for servers already connected.
 */
export function onServerConnection(listener: ServerListener): () => void {
  serverListeners.add(listener);
  for (const serverId of serverCapabilities.keys()) listener(serverId, true);
  return () => serverListeners.delete(listener);
}

/** Diagnostic source label per extension, for servers that omit `source`. */
const SERVER_LABELS: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts",
  js: "ts",
  mjs: "ts",
  cjs: "ts",
  jsx: "ts",
  py: "pyright",
  pyi: "pyright",
  java: "jdtls",
  rs: "rust-analyzer",
  go: "gopls",
  c: "clangd",
  h: "clangd",
  cc: "clangd",
  cpp: "clangd",
  cxx: "clangd",
  hpp: "clangd",
  hh: "clangd",
  hxx: "clangd",
};

/** Latest raw diagnostics per file — code-action requests send the
 *  server's own diagnostics back as context. */
const diagnosticsByPath = new Map<string, LspDiagnostic[]>();

export function lspDiagnosticsFor(path: string): LspDiagnostic[] {
  return diagnosticsByPath.get(path) ?? [];
}

/** Languages we've already asked Rust to start, so we don't spam it. */
const requestedExtensions = new Set<string>();
/** Servers that failed to start this session (usually: not installed).
 *  Not retried on every file open, so the install hint shows once. */
const failedExtensions = new Set<string>();

/** Per-document version counters; presence also means "didOpen sent". */
const documentVersions = new Map<string, number>();

export function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function languageIdFor(path: string): string | null {
  return LANGUAGE_IDS[extensionOf(path)] ?? null;
}

/** Build the `file://` URI for a path (mirrors the Rust side). */
export function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/** Display names the Rust side uses for each server id. */
function serverLabelMatches(serverId: string, displayName: string): boolean {
  const names: Record<string, string[]> = {
    pyright: ["Pyright", "basedpyright"],
    java: ["Java (jdtls)"],
    "rust-analyzer": ["rust-analyzer"],
    gopls: ["gopls"],
    clangd: ["clangd"],
    typescript: ["TypeScript"],
  };
  return names[serverId]?.includes(displayName) ?? false;
}

/** Inverse of pathToUri, for routing diagnostics back to a model. */
export function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // Windows: file:///c:/Users/… → C:\Users\… — the form the file tree
  // and tabs use (drive letter case and separators must match exactly).
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
    path = path[0].toUpperCase() + path.slice(1).replace(/\//g, "\\");
  }
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
  if (failedExtensions.has(extension)) return false;
  if (requestedExtensions.has(extension)) return true;
  requestedExtensions.add(extension);

  const rootPath =
    useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(path);
  try {
    await invoke("start_language_server", { extension, rootPath });
    return true;
  } catch (error) {
    requestedExtensions.delete(extension);
    // Retried after a folder switch or restart (e.g. once installed).
    failedExtensions.add(extension);
    const serverId = SERVER_IDS[extension];
    if (serverId) useUiStore.getState().setLspStatus(serverId, null);
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
    extension: extensionOf(path),
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
    extension: extensionOf(path),
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
    extension: extensionOf(path),
    method: "textDocument/didClose",
    params: { textDocument: { uri: pathToUri(path) } },
  }).catch(() => {});
}

/**
 * Stop every language server and forget all per-server bookkeeping.
 * Servers are rooted at the folder they started in, so a workspace
 * switch must restart them; the next opened file starts a fresh one.
 */
export async function resetLanguageServers(): Promise<void> {
  requestedExtensions.clear();
  failedExtensions.clear();
  documentVersions.clear();
  diagnosticsByPath.clear();
  for (const serverId of [...serverCapabilities.keys()]) {
    serverCapabilities.delete(serverId);
    for (const listener of serverListeners) listener(serverId, false);
  }
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve(null);
    pendingRequests.delete(id);
  }
  useUiStore.getState().setLspStatus(null, null);
  await invoke("stop_language_servers").catch(() => {});
}

/**
 * Restart every language server and re-open the files that are open, so
 * analysis resumes without reopening anything (after installing a server,
 * or from the command palette).
 */
export async function restartLanguageServers(): Promise<void> {
  await resetLanguageServers();
  for (const path of allOpenFiles()) {
    if (!LANGUAGE_IDS[extensionOf(path)]) continue;
    const text = getModelValue(path) ?? (await readFile(path).catch(() => null));
    if (text !== null) await openDocument(path, text);
  }
}

/** Install basedpyright (Python semantic highlighting), then restart. */
export async function setUpPythonSemanticHighlighting(): Promise<void> {
  const ui = useUiStore.getState();
  ui.showStatus("Installing basedpyright…");
  try {
    await installBasedpyright();
    await restartLanguageServers();
    ui.showStatus("basedpyright installed — Python semantic highlighting is on");
  } catch (error) {
    ui.setLastError(String(error));
  }
}

/** In-flight LSP requests, keyed by the id we minted, awaiting a response. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRequests = new Map<number, PendingRequest>();
let requestIdCounter = 0;
const REQUEST_TIMEOUT_MS = 4000;

/**
 * Send an LSP *request* and await its result. Resolves with the server's
 * `result` (or null on error/timeout — providers then show nothing
 * rather than hanging the editor).
 */
/** Send an LSP request to the server for a file's language. */
export function sendRequest(
  extension: string,
  method: string,
  params: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const id = ++requestIdCounter;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(null);
    }, timeoutMs);
    pendingRequests.set(id, { resolve, timer });
    invoke("lsp_request", { extension, method, params, id }).catch(() => {
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve(null);
    });
  });
}

let listenersReady = false;

/** Register the Rust→frontend event listeners exactly once. */
export function initLspListeners(): void {
  if (listenersReady) return;
  listenersReady = true;

  listen<{
    state: string;
    server?: string;
    id?: string;
    capabilities?: Record<string, any>;
  }>(
    "lsp:status",
    (event) => {
      const { state, server, id } = event.payload;
      if (state === "connected" && id) {
        serverCapabilities.set(id, event.payload.capabilities ?? {});
        for (const listener of serverListeners) listener(id, true);
      }
      const ui = useUiStore.getState();
      if (state === "starting" && id) {
        // Heavy servers (jdtls, rust-analyzer) index for a while; say so
        // rather than looking dead.
        ui.setLspStatus(id, `${server ?? "Language server"}…`);
      } else if (state === "connected" && id) {
        ui.setLspStatus(id, server ?? "Language server");
      } else if (state === "disconnected") {
        // Which server? The Rust side reports its display name.
        for (const [serverId] of serverCapabilities) {
          if (server && serverLabelMatches(serverId, server)) {
            serverCapabilities.delete(serverId);
            for (const listener of serverListeners) listener(serverId, false);
          }
        }
        // Only clear the label if it's still this server's — a killed
        // old server must not blank out its replacement.
        if (id) {
          const current = ui.lspStatus[id];
          if (current === server || current === `${server}…`) ui.setLspStatus(id, null);
        }
      }
    },
  );

  // Server→client messages: responses (correlated by id) and unprompted
  // notifications (dispatched by method, e.g. diagnostics).
  listen<{
    id?: number;
    result?: unknown;
    error?: unknown;
    method?: string;
    params?: unknown;
  }>("lsp:message", (event) => {
    const message = event.payload;

    // A response to one of our requests (has id, no method).
    if (message.id != null && message.method == null) {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(message.id);
        pending.resolve(message.error ? null : message.result);
      }
      return;
    }

    // A server applying an edit itself (e.g. after a quick-fix command).
    // Rust already acknowledged it; apply it here.
    if (message.method === "workspace/applyEdit" && message.params) {
      const { edit } = message.params as { edit: LspWorkspaceEdit };
      void applyWorkspaceEdit(edit).catch((error) =>
        useUiStore.getState().setLastError(String(error)),
      );
      return;
    }

    if (message.method === "textDocument/publishDiagnostics" && message.params) {
      const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
      const path = uriToPath(params.uri);
      const diagnostics = params.diagnostics;
      diagnosticsByPath.set(path, diagnostics);
      useProblemsStore.getState().setLspDiagnostics(path, diagnostics);
      applyDiagnostics(
        path,
        diagnostics,
        SERVER_LABELS[extensionOf(path)] ?? "lsp",
      );
      // Count error-severity (1) diagnostics for the explorer's red dot.
      const errorCount = diagnostics.filter(
        (diagnostic) => (diagnostic.severity ?? 1) === 1,
      ).length;
      useDiagnosticsStore.getState().setFileErrorCount(path, errorCount);
    }
  });
}
