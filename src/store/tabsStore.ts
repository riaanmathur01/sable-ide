import { create } from "zustand";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "../lib/ipc";
import {
  disposeModel,
  getEditor,
  getModelValue,
  isModelDirty,
  markSaved,
} from "../lib/editorRegistry";
import { useUiStore } from "./uiStore";

export interface EditorTab {
  path: string;
  name: string;
  isDirty: boolean;
}

/**
 * Open-tab metadata. File *content* loads here once (for model creation)
 * but then lives in Monaco models — see lib/editorRegistry.ts.
 */
interface TabsState {
  tabs: EditorTab[];
  activePath: string | null;
  /** Initial content for models Monaco hasn't created yet. */
  initialContentByPath: Record<string, string>;
  openFile: (path: string) => Promise<void>;
  setActive: (path: string) => void;
  /** Re-check the active model's dirty state (called on editor change). */
  syncDirtyState: (path: string) => void;
  saveTab: (path: string) => Promise<void>;
  /** Debounced save-after-typing-stops; called on every editor change. */
  scheduleAutoSave: (path: string) => void;
  closeTab: (path: string) => Promise<void>;
  /** After a move on disk, repoint affected tabs at their new paths. */
  remapMovedPaths: (oldPath: string, newPath: string) => Promise<void>;
}

/** True if `path` is `prefix` itself or lives underneath it. */
function isSameOrInside(path: string, prefix: string): boolean {
  return (
    path === prefix ||
    path.startsWith(`${prefix}/`) ||
    path.startsWith(`${prefix}\\`)
  );
}

/** Auto-save fires this long after the last keystroke. */
const AUTO_SAVE_DELAY_MS = 800;

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelAutoSave(path: string) {
  const timer = autoSaveTimers.get(path);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoSaveTimers.delete(path);
  }
}

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activePath: null,
  initialContentByPath: {},

  openFile: async (path) => {
    const { tabs } = get();
    if (tabs.some((tab) => tab.path === path)) {
      set({ activePath: path });
      return;
    }
    try {
      const contents = await readFile(path);
      set((state) => ({
        tabs: [
          ...state.tabs,
          { path, name: fileNameOf(path), isDirty: false },
        ],
        activePath: path,
        initialContentByPath: {
          ...state.initialContentByPath,
          [path]: contents,
        },
      }));
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  setActive: (path) => set({ activePath: path }),

  syncDirtyState: (path) => {
    const isDirty = isModelDirty(path);
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path && tab.isDirty !== isDirty
          ? { ...tab, isDirty }
          : tab,
      ),
    }));
  },

  saveTab: async (path) => {
    cancelAutoSave(path);
    // Read from the model; fall back to the live editor for the active
    // tab. If neither works something is genuinely wrong — say so
    // instead of silently dropping the save.
    let value = getModelValue(path);
    if (value === null && get().activePath === path) {
      value = getEditor()?.getValue() ?? null;
    }
    if (value === null) {
      useUiStore
        .getState()
        .setLastError(`Could not read editor contents for ${path}`);
      return;
    }
    try {
      await writeFile(path, value);
      markSaved(path);
      get().syncDirtyState(path);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  scheduleAutoSave: (path) => {
    cancelAutoSave(path);
    autoSaveTimers.set(
      path,
      setTimeout(() => {
        autoSaveTimers.delete(path);
        get().saveTab(path);
      }, AUTO_SAVE_DELAY_MS),
    );
  },

  remapMovedPaths: async (oldPath, newPath) => {
    const affectedTabs = get().tabs.filter((tab) =>
      isSameOrInside(tab.path, oldPath),
    );
    for (const tab of affectedTabs) {
      const updatedPath = newPath + tab.path.slice(oldPath.length);
      try {
        // The old Monaco model's URI can't change; reload from the new
        // location instead. Callers save dirty tabs before moving, so
        // nothing is lost.
        const contents = await readFile(updatedPath);
        cancelAutoSave(tab.path);
        disposeModel(tab.path);
        set((state) => {
          const initialContentByPath = { ...state.initialContentByPath };
          delete initialContentByPath[tab.path];
          initialContentByPath[updatedPath] = contents;
          return {
            tabs: state.tabs.map((openTab) =>
              openTab.path === tab.path
                ? {
                    path: updatedPath,
                    name: fileNameOf(updatedPath),
                    isDirty: false,
                  }
                : openTab,
            ),
            activePath:
              state.activePath === tab.path ? updatedPath : state.activePath,
            initialContentByPath,
          };
        });
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
      }
    }
  },

  closeTab: async (path) => {
    const { tabs } = get();
    const closingTab = tabs.find((tab) => tab.path === path);
    if (!closingTab) return;

    // A pending auto-save must not fire against a disposed model.
    cancelAutoSave(path);

    if (closingTab.isDirty) {
      const discard = await confirmNative(
        `"${closingTab.name}" has unsaved changes. Discard them?`,
        { title: "Unsaved Changes", kind: "warning" },
      );
      if (!discard) return;
    }

    disposeModel(path);
    set((state) => {
      const remainingTabs = state.tabs.filter((tab) => tab.path !== path);
      const initialContentByPath = { ...state.initialContentByPath };
      delete initialContentByPath[path];

      // If the active tab closed, activate its neighbor (right, then left).
      let activePath = state.activePath;
      if (activePath === path) {
        const closedIndex = state.tabs.findIndex((tab) => tab.path === path);
        activePath =
          remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)]
            ?.path ?? null;
      }
      return { tabs: remainingTabs, activePath, initialContentByPath };
    });
  },
}));
