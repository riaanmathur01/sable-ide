import { create } from "zustand";
import { readDirectory, readFile, watchFolders, writeFile, type FsEntry } from "../lib/ipc";
import { parseJsonc } from "../lib/jsonc";
import { isMainWindow } from "../lib/windows";
import { useUiStore } from "./uiStore";
import { useGitStore } from "./gitStore";
import { useInterpreterStore } from "./interpreterStore";
import { useTabsStore } from "./tabsStore";
import { useSearchStore } from "./searchStore";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { useTerminalStore } from "./terminalStore";
import { resetLanguageServers } from "../lib/lsp/lspClient";
import { useAgentStore } from "./agentStore";
import { useProblemsStore } from "./problemsStore";
import { useBreakpointsStore } from "./breakpointsStore";
import { invokeLocal, isRemoteActive } from "../lib/backend";

/**
 * Workspace state: the open folder and a lazily-loaded directory tree.
 * Children are fetched from Rust one level at a time when a folder is
 * first expanded, then cached in `childrenByPath`.
 */
interface WorkspaceState {
  /** The workspace's first folder (its only one, usually). */
  rootPath: string | null;
  rootName: string | null;
  /** Every folder of the workspace, `rootPath` first. More than one is a
   *  multi-root workspace (Add Folder to Workspace, .code-workspace). */
  folders: string[];
  /** The .code-workspace file the folders came from, if any. */
  workspaceFile: string | null;
  /** Cached listings, keyed by absolute directory path. */
  childrenByPath: Record<string, FsEntry[]>;
  /** Absolute paths of directories currently expanded in the tree. */
  expandedPaths: Set<string>;
  openWorkspace: (path: string) => Promise<void>;
  /** Open several folders as one workspace (the first is the root). */
  openFolders: (paths: string[], workspaceFile?: string | null) => Promise<void>;
  /** Add a folder to the workspace (opens it if none is open). */
  addFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  /** Open a VS Code-style .code-workspace file. */
  openWorkspaceFile: (file: string) => Promise<void>;
  /** Save the folders as a .code-workspace file. */
  saveWorkspaceAs: (file: string) => Promise<void>;
  /** Close the folder (e.g. when its remote connection is closed). */
  closeWorkspace: () => void;
  toggleDirectory: (path: string) => Promise<void>;
  /** Re-read a directory from disk (after create/delete/rename). */
  refreshDirectory: (path: string) => Promise<void>;
  /** Watcher callback: re-read every changed directory we have cached. */
  applyExternalChanges: (changedDirectories: string[]) => Promise<void>;
  /** Expand the tree down to a folder (used by search folder results). */
  revealPath: (path: string) => Promise<void>;
}

function reportError(error: unknown) {
  useUiStore.getState().setLastError(String(error));
}

/** localStorage key for the last opened folder (session restore). */
const LAST_FOLDER_KEY = "sable.lastFolder";

/** Path of the folder open at last exit, if any. */
export function lastOpenedFolder(): string | null {
  return localStorage.getItem(LAST_FOLDER_KEY);
}

export function clearLastOpenedFolder(): void {
  localStorage.removeItem(LAST_FOLDER_KEY);
}

// --- Folders -------------------------------------------------------------------

const separatorOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
const isInside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`);
export const folderName = (folder: string) => folder.split(/[/\\]/).filter(Boolean).pop() ?? folder;

/** The workspace folder `path` is in (the innermost, if folders nest). */
export function folderOf(path: string): string | null {
  const { folders } = useWorkspaceStore.getState();
  let best: string | null = null;
  for (const folder of folders) {
    if (isInside(path, folder) && (!best || folder.length > best.length)) best = folder;
  }
  return best;
}

/** `path` for display: relative to its folder, which is named first in a
 *  multi-root workspace ("api/src/main.ts"). */
export function workspaceRelativePath(path: string): string {
  const folder = folderOf(path);
  if (!folder) return path;
  const relative = path.slice(folder.length).replace(/^[/\\]/, "");
  return useWorkspaceStore.getState().folders.length > 1 ? `${folderName(folder)}/${relative}` : relative;
}

/** Folders added or removed (language servers, plugins and git follow). */
type FoldersListener = (change: { added: string[]; removed: string[] }) => void;
const foldersListeners = new Set<FoldersListener>();
export function onFoldersChange(listener: FoldersListener): () => void {
  foldersListeners.add(listener);
  return () => foldersListeners.delete(listener);
}
function foldersChanged(added: string[], removed: string[]) {
  for (const listener of foldersListeners) listener({ added, removed });
}

/** A path from a .code-workspace file, resolved against the file's folder. */
function resolveFrom(directory: string, path: string): string {
  const separator = separatorOf(directory);
  if (/^([A-Za-z]:[/\\]|[/\\])/.test(path)) return path.replace(/[/\\]+$/, "") || path;
  const parts = directory.split(/[/\\]/);
  for (const part of path.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join(separator);
}

/** `path` relative to `directory` (for saving a workspace file). */
function relativeTo(directory: string, path: string): string {
  const from = directory.split(/[/\\]/).filter(Boolean);
  const to = path.split(/[/\\]/).filter(Boolean);
  if (from[0] !== to[0]) return path;
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const relative = [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
  return relative || ".";
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootPath: null,
  rootName: null,
  folders: [],
  workspaceFile: null,
  childrenByPath: {},
  expandedPaths: new Set(),

  openWorkspace: async (path) => {
    // Switching folders: clear all prior workspace-scoped state so the
    // new folder starts clean (tabs, git, search, diagnostics, interp).
    useTabsStore.getState().resetTabs();
    useSearchStore.getState().reset();
    useDiagnosticsStore.getState().clear();
    useProblemsStore.getState().clear();
    useGitStore.getState().reset();
    useInterpreterStore.getState().reset();
    // Agent chats belong to a workspace: save the old folder's, load
    // this one's.
    if (get().rootPath !== path) void useAgentStore.getState().loadWorkspaceChats(path);
    // Breakpoints are saved per workspace too.
    if (get().rootPath !== path) useBreakpointsStore.getState().loadWorkspace(path);
    // Language servers are rooted at the old folder; restart them lazily
    // (the next opened file starts one for the new root).
    if (get().rootPath !== path) await resetLanguageServers();
    try {
      const rootChildren = await readDirectory(path);
      // Both separators so Windows paths split correctly too.
      const rootName = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
      const removed = get().folders.filter((folder) => folder !== path);
      set({
        rootPath: path,
        rootName,
        folders: [path],
        workspaceFile: null,
        childrenByPath: { [path]: rootChildren },
        expandedPaths: new Set([path]),
      });
      if (removed.length) foldersChanged([], removed);
      // Remember this folder so the next launch reopens it (other windows
      // remember theirs with the window, lib/windows.ts).
      if (isMainWindow) localStorage.setItem(LAST_FOLDER_KEY, path);
      // Keep the tree in sync with Finder/other apps from here on.
      await watchFolders([path]);
      // Load git status for the newly opened folder (no-op if not a repo).
      useGitStore.getState().refresh();
      // Discover Python interpreters (workspace venv + system).
      void useInterpreterStore.getState().discover();
      // A local folder with a dev container: say it can be opened in it.
      if (!isRemoteActive()) {
        void invokeLocal<boolean>("devcontainer_exists", { folder: path })
          .then((exists) => {
            if (exists) useUiStore.getState().showStatus("This folder has a dev container — “Remote: Reopen Folder in Container” opens it inside");
          })
          .catch(() => {});
      }
      // A running shell is still in the old folder — restart it so it
      // picks up the new workspace as its cwd. (If none is running, the
      // next time the terminal opens it already uses the new root.)
      const terminal = useTerminalStore.getState();
      if (terminal.sessions.some((session) => session.isRunning)) {
        void terminal.restartAll();
      }
    } catch (error) {
      reportError(error);
    }
  },

  openFolders: async (paths, workspaceFile = null) => {
    const [first, ...rest] = [...new Set(paths)];
    if (!first) return;
    await get().openWorkspace(first);
    if (get().rootPath !== first) return;
    for (const folder of rest) await get().addFolder(folder);
    set({ workspaceFile });
  },

  addFolder: async (path) => {
    const normalized = path.replace(/[/\\]+$/, "") || path;
    if (!get().rootPath) return get().openWorkspace(normalized);
    if (get().folders.includes(normalized)) return;
    try {
      const children = await readDirectory(normalized);
      set((state) => ({
        folders: [...state.folders, normalized],
        childrenByPath: { ...state.childrenByPath, [normalized]: children },
        expandedPaths: new Set([...state.expandedPaths, normalized]),
      }));
      await watchFolders(get().folders);
      foldersChanged([normalized], []);
    } catch (error) {
      reportError(error);
    }
  },

  removeFolder: async (path) => {
    const { folders, rootPath, workspaceFile } = get();
    if (!folders.includes(path)) return;
    const rest = folders.filter((folder) => folder !== path);
    if (rest.length === 0) return;
    // The first folder is the workspace's root (language servers, git,
    // the terminal start there): the next one takes over.
    if (path === rootPath) {
      await get().openFolders(rest, workspaceFile);
      return;
    }
    set((state) => {
      const childrenByPath = { ...state.childrenByPath };
      delete childrenByPath[path];
      return { folders: rest, childrenByPath };
    });
    await watchFolders(rest).catch(reportError);
    useTabsStore.getState().closeTabsUnder(path);
    foldersChanged([], [path]);
  },

  openWorkspaceFile: async (file) => {
    try {
      const parsed = parseJsonc(await readFile(file)) as { folders?: { path?: unknown }[] };
      const directory = file.replace(/[/\\][^/\\]*$/, "");
      const folders = (parsed.folders ?? [])
        .map((folder) => (typeof folder?.path === "string" ? resolveFrom(directory, folder.path) : null))
        .filter((folder): folder is string => Boolean(folder));
      if (folders.length === 0) throw new Error(`${file} lists no folders`);
      await get().openFolders(folders, file);
    } catch (error) {
      reportError(error);
    }
  },

  saveWorkspaceAs: async (file) => {
    const directory = file.replace(/[/\\][^/\\]*$/, "");
    let existing: Record<string, unknown> = {};
    try {
      existing = parseJsonc(await readFile(file)) as Record<string, unknown>;
    } catch {
      // A new file.
    }
    const contents = { ...existing, folders: get().folders.map((folder) => ({ path: relativeTo(directory, folder) })) };
    await writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`);
    set({ workspaceFile: file });
    useUiStore.getState().showStatus(`Saved the workspace as ${file.split(/[/\\]/).pop()}`);
  },

  closeWorkspace: () => {
    useTabsStore.getState().resetTabs();
    useSearchStore.getState().reset();
    useDiagnosticsStore.getState().clear();
    useProblemsStore.getState().clear();
    useGitStore.getState().reset();
    useInterpreterStore.getState().reset();
    if (isMainWindow) localStorage.removeItem(LAST_FOLDER_KEY);
    const removed = get().folders;
    set({ rootPath: null, rootName: null, folders: [], workspaceFile: null, childrenByPath: {}, expandedPaths: new Set() });
    if (removed.length) foldersChanged([], removed);
  },

  toggleDirectory: async (path) => {
    const { expandedPaths, childrenByPath } = get();
    const nextExpanded = new Set(expandedPaths);
    if (nextExpanded.has(path)) {
      nextExpanded.delete(path);
      set({ expandedPaths: nextExpanded });
      return;
    }
    nextExpanded.add(path);
    // Expand immediately for responsiveness; children stream in after.
    set({ expandedPaths: nextExpanded });
    if (!childrenByPath[path]) {
      try {
        const children = await readDirectory(path);
        set((state) => ({
          childrenByPath: { ...state.childrenByPath, [path]: children },
        }));
      } catch (error) {
        reportError(error);
      }
    }
  },

  refreshDirectory: async (path) => {
    try {
      const children = await readDirectory(path);
      set((state) => ({
        childrenByPath: { ...state.childrenByPath, [path]: children },
      }));
    } catch (error) {
      reportError(error);
    }
  },

  revealPath: async (path) => {
    const { toggleDirectory } = get();
    const rootPath = folderOf(path);
    if (!rootPath) return;
    const segments = path
      .slice(rootPath.length)
      .split(/[/\\]/)
      .filter(Boolean);
    // Expand ancestors one level at a time, resolving each child through
    // the loaded listing so paths keep the OS's native separators.
    let currentPath = rootPath;
    for (const segment of segments) {
      if (!get().expandedPaths.has(currentPath)) {
        await toggleDirectory(currentPath);
      }
      const child = get()
        .childrenByPath[currentPath]?.find((entry) => entry.name === segment);
      if (!child) return; // gone from disk meanwhile
      currentPath = child.path;
    }
    if (!get().expandedPaths.has(currentPath)) {
      await toggleDirectory(currentPath);
    }
  },

  applyExternalChanges: async (changedDirectories) => {
    const { childrenByPath } = get();
    await Promise.all(
      changedDirectories
        .filter((directory) => childrenByPath[directory] !== undefined)
        .map(async (directory) => {
          try {
            const children = await readDirectory(directory);
            set((state) => ({
              childrenByPath: {
                ...state.childrenByPath,
                [directory]: children,
              },
            }));
          } catch {
            // The directory itself is gone — drop it from the cache and
            // collapse it. Its parent's refresh removes the row.
            set((state) => {
              const childrenByPath = { ...state.childrenByPath };
              delete childrenByPath[directory];
              const expandedPaths = new Set(state.expandedPaths);
              expandedPaths.delete(directory);
              return { childrenByPath, expandedPaths };
            });
          }
        }),
    );
  },
}));
