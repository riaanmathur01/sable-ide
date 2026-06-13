import { create } from "zustand";
import { readDirectory, watchWorkspace, type FsEntry } from "../lib/ipc";
import { useUiStore } from "./uiStore";
import { useGitStore } from "./gitStore";

/**
 * Workspace state: the open folder and a lazily-loaded directory tree.
 * Children are fetched from Rust one level at a time when a folder is
 * first expanded, then cached in `childrenByPath`.
 */
interface WorkspaceState {
  rootPath: string | null;
  rootName: string | null;
  /** Cached listings, keyed by absolute directory path. */
  childrenByPath: Record<string, FsEntry[]>;
  /** Absolute paths of directories currently expanded in the tree. */
  expandedPaths: Set<string>;
  openWorkspace: (path: string) => Promise<void>;
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

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootPath: null,
  rootName: null,
  childrenByPath: {},
  expandedPaths: new Set(),

  openWorkspace: async (path) => {
    try {
      const rootChildren = await readDirectory(path);
      // Both separators so Windows paths split correctly too.
      const rootName = path.split(/[/\\]/).filter(Boolean).pop() ?? path;
      set({
        rootPath: path,
        rootName,
        childrenByPath: { [path]: rootChildren },
        expandedPaths: new Set([path]),
      });
      // Keep the tree in sync with Finder/other apps from here on.
      await watchWorkspace(path);
      // Load git status for the newly opened folder (no-op if not a repo).
      useGitStore.getState().refresh();
    } catch (error) {
      reportError(error);
    }
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
    const { rootPath, toggleDirectory } = get();
    if (!rootPath || !path.startsWith(rootPath)) return;
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
