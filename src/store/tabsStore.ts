import { create } from "zustand";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "../lib/ipc";
import { closeDocument, openDocument } from "../lib/lsp/lspClient";
import { useGitStore } from "./gitStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  disposeModel,
  getEditor,
  getModelValue,
  isModelDirty,
  markSaved,
} from "../lib/editorRegistry";
import { useUiStore } from "./uiStore";

export interface EditorTab {
  /** Stable key. File tabs use the file path; diff tabs use a synthetic key. */
  path: string;
  name: string;
  isDirty: boolean;
  kind: "file" | "diff";
  /** Present on diff tabs: which file and whether to diff the staged side. */
  diff?: { filePath: string; staged: boolean };
}

/** Synthetic tab key for a diff so it never collides with a file tab. */
function diffKey(filePath: string, staged: boolean): string {
  return `diff:${staged ? "s" : "u"}:${filePath}`;
}

/**
 * Open-tab metadata. File *content* loads here once (for model creation)
 * but then lives in Monaco models — see lib/editorRegistry.ts.
 */
interface TabsState {
  tabs: EditorTab[];
  activePath: string | null;
  /** The most recent file (non-diff) tab — what MonacoPane renders. */
  lastFilePath: string | null;
  /** Initial content for models Monaco hasn't created yet. */
  initialContentByPath: Record<string, string>;
  openFile: (path: string) => Promise<void>;
  /** Open a read-only diff for a changed file as its own tab. */
  openDiff: (filePath: string, staged: boolean) => void;
  setActive: (path: string) => void;
  /** Re-check the active model's dirty state (called on editor change). */
  syncDirtyState: (path: string) => void;
  saveTab: (path: string) => Promise<void>;
  /** Debounced save-after-typing-stops; called on every editor change. */
  scheduleAutoSave: (path: string) => void;
  closeTab: (path: string) => Promise<void>;
  /** After a move on disk, repoint affected tabs at their new paths. */
  remapMovedPaths: (oldPath: string, newPath: string) => Promise<void>;
  /** Close everything (used when switching workspaces). */
  resetTabs: () => void;
  /** Reopen the saved tabs for the current workspace (session restore). */
  restoreSession: () => Promise<void>;
}

/** Persisted open-tab session, keyed per workspace folder. */
const SESSION_KEY_PREFIX = "sable.session:";

function persistSession(tabs: EditorTab[], activePath: string | null) {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return;
  try {
    // Only file tabs persist; diff tabs are transient (and have synthetic
    // keys that aren't openable paths).
    const openPaths = tabs
      .filter((tab) => tab.kind === "file")
      .map((tab) => tab.path);
    const persistActive =
      activePath && openPaths.includes(activePath) ? activePath : null;
    localStorage.setItem(
      SESSION_KEY_PREFIX + root,
      JSON.stringify({ openPaths, activePath: persistActive }),
    );
  } catch {
    /* ignore storage quota errors */
  }
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
  lastFilePath: null,
  initialContentByPath: {},

  openFile: async (path) => {
    const { tabs } = get();
    if (tabs.some((tab) => tab.path === path)) {
      set({ activePath: path, lastFilePath: path });
      persistSession(get().tabs, path);
      return;
    }
    try {
      const contents = await readFile(path);
      set((state) => ({
        tabs: [
          ...state.tabs,
          { path, name: fileNameOf(path), isDirty: false, kind: "file" },
        ],
        activePath: path,
        lastFilePath: path,
        initialContentByPath: {
          ...state.initialContentByPath,
          [path]: contents,
        },
      }));
      persistSession(get().tabs, path);
      // Start a language server (if any) and tell it this doc is open.
      void openDocument(path, contents);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  openDiff: (filePath, staged) => {
    const key = diffKey(filePath, staged);
    if (get().tabs.some((tab) => tab.path === key)) {
      set({ activePath: key });
      return;
    }
    const name = `${fileNameOf(filePath)} (${staged ? "Staged" : "Changes"})`;
    set((state) => ({
      tabs: [
        ...state.tabs,
        { path: key, name, isDirty: false, kind: "diff", diff: { filePath, staged } },
      ],
      activePath: key,
    }));
  },

  setActive: (path) => {
    const tab = get().tabs.find((candidate) => candidate.path === path);
    // Only file tabs drive what MonacoPane shows; diff tabs leave it be.
    if (tab?.kind === "file") {
      set({ activePath: path, lastFilePath: path });
    } else {
      set({ activePath: path });
    }
    persistSession(get().tabs, get().activePath);
  },

  restoreSession: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    const raw = localStorage.getItem(SESSION_KEY_PREFIX + root);
    if (!raw) return;
    let session: { openPaths?: string[]; activePath?: string | null };
    try {
      session = JSON.parse(raw);
    } catch {
      return;
    }
    // Reopen tabs in their saved order; openFile tolerates deleted files.
    for (const path of session.openPaths ?? []) {
      await get().openFile(path);
    }
    // Restore the exact active tab (openFile left the last one active).
    if (
      session.activePath &&
      get().tabs.some((tab) => tab.path === session.activePath)
    ) {
      get().setActive(session.activePath);
    }
  },

  resetTabs: () => {
    for (const tab of get().tabs) {
      cancelAutoSave(tab.path);
      disposeModel(tab.path);
      void closeDocument(tab.path);
    }
    set({
      tabs: [],
      activePath: null,
      lastFilePath: null,
      initialContentByPath: {},
    });
  },

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
    // Diff tabs are read-only — never write to their synthetic key.
    const tab = get().tabs.find((candidate) => candidate.path === path);
    if (tab && tab.kind !== "file") return;
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
      // A save changes git status (modified/untracked); refresh it.
      useGitStore.getState().refresh();
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
        // Re-register the document with the language server at its new path.
        void closeDocument(tab.path);
        void openDocument(updatedPath, contents);
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
                    kind: "file" as const,
                  }
                : openTab,
            ),
            activePath:
              state.activePath === tab.path ? updatedPath : state.activePath,
            lastFilePath:
              state.lastFilePath === tab.path
                ? updatedPath
                : state.lastFilePath,
            initialContentByPath,
          };
        });
        persistSession(get().tabs, get().activePath);
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
    void closeDocument(path);

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
      // Keep lastFilePath pointing at a still-open file tab.
      let lastFilePath = state.lastFilePath;
      if (lastFilePath === path) {
        lastFilePath =
          remainingTabs.filter((tab) => tab.kind === "file").pop()?.path ??
          null;
      }
      return { tabs: remainingTabs, activePath, lastFilePath, initialContentByPath };
    });
    persistSession(get().tabs, get().activePath);
  },
}));
