import { create } from "zustand";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "../lib/ipc";
import {
  disposeModel,
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
  closeTab: (path: string) => Promise<void>;
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
    const value = getModelValue(path);
    if (value === null) return;
    try {
      await writeFile(path, value);
      markSaved(path);
      get().syncDirtyState(path);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  closeTab: async (path) => {
    const { tabs } = get();
    const closingTab = tabs.find((tab) => tab.path === path);
    if (!closingTab) return;

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
