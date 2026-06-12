import { create } from "zustand";
import { readDirectory, type FsEntry } from "../lib/ipc";
import { useUiStore } from "./uiStore";

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
}));
