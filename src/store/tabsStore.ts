import { create } from "zustand";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "../lib/ipc";
import { closeDocument, openDocument } from "../lib/lsp/lspClient";
import { useGitStore } from "./gitStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  applySaveTransforms,
  disposeModel,
  getEditor,
  getModelValue,
  isModelDirty,
  markSaved,
  setActiveEditorGroup,
} from "../lib/editorRegistry";
import { useUiStore } from "./uiStore";
import { getSetting, useSettingsStore } from "./settingsStore";

/** Synthetic key of the (singleton) Settings tab. */
export const SETTINGS_TAB_KEY = "sable:settings";

/** What a diff tab compares: working-tree changes, or a past commit. */
export type DiffSource =
  | { kind: "working"; filePath: string; staged: boolean }
  | { kind: "commit"; filePath: string; hash: string; shortHash: string };

export interface EditorTab {
  /** Stable key. File tabs use the file path; diff tabs use a synthetic key. */
  path: string;
  name: string;
  isDirty: boolean;
  kind: "file" | "diff" | "settings" | "merge" | "history";
  /** Present on diff tabs: what to compare. */
  diff?: DiffSource;
  /** Present on merge tabs: the conflicted file. */
  mergeFile?: string;
  /** On history tabs: the file, or null for "Recover Deleted File". */
  historyFile?: string | null;
}

/**
 * A column of the split editor: its own tabs and active tab. The same
 * file can be open in several groups — they share one Monaco model, so
 * edits show up in both live (as in VS Code).
 */
export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activePath: string | null;
  /** The group's most recent *file* tab — what its editor shows while a
   *  diff or settings tab is in front. */
  lastFilePath: string | null;
}

/** Side-by-side editor groups allowed (⌘\ splits). */
export const MAX_GROUPS = 3;

/** Synthetic tab key for a diff so it never collides with a file tab. */
function diffKey(source: DiffSource): string {
  return source.kind === "working"
    ? `diff:w:${source.staged ? "s" : "u"}:${source.filePath}`
    : `diff:c:${source.hash}:${source.filePath}`;
}

function diffName(source: DiffSource): string {
  const base = source.filePath.split(/[/\\]/).filter(Boolean).pop() ?? source.filePath;
  return source.kind === "working"
    ? `${base} (${source.staged ? "Staged" : "Changes"})`
    : `${base} @ ${source.shortHash}`;
}

/**
 * Open-tab metadata, by editor group. File *content* loads here once (for
 * model creation) but then lives in Monaco models — see
 * lib/editorRegistry.ts.
 *
 * `tabs` / `activePath` / `lastFilePath` mirror the *focused* group, so
 * everything that just wants "the current file" reads them as before;
 * file-level operations (rename, delete, dirty state, …) span all groups.
 */
interface TabsState {
  groups: EditorGroup[];
  activeGroupId: string;
  /** Mirrors of the focused group. */
  tabs: EditorTab[];
  activePath: string | null;
  lastFilePath: string | null;
  /** Initial content for models Monaco hasn't created yet. */
  initialContentByPath: Record<string, string>;
  /** Open a file in a group (default: the focused one). */
  openFile: (path: string, options?: { groupId?: string }) => Promise<void>;
  /** Open a read-only diff (working change or commit) as its own tab. */
  openDiff: (source: DiffSource) => void;
  /** Open (or focus) the merge tool for a conflicted file. */
  openMerge: (filePath: string) => void;
  /** Open (or focus) a file's local history (null: deleted files). */
  openHistory: (filePath: string | null) => void;
  /** Activate a tab in a group (default: focused) and focus that group. */
  setActive: (path: string, groupId?: string) => void;
  /** Open (or focus) the Settings tab. */
  openSettings: () => void;
  /** Re-check a model's dirty state (called on editor change). */
  syncDirtyState: (path: string) => void;
  /**
   * Write a tab to disk. "manual" saves (⌘S, Run, …) also apply the
   * format/trim/final-newline settings; auto-saves never rewrite text
   * under the user's cursor.
   */
  saveTab: (path: string, reason?: "manual" | "auto") => Promise<void>;
  /** Debounced save-after-typing-stops; called on every editor change. */
  scheduleAutoSave: (path: string) => void;
  /** Close a tab in a group (default: focused). */
  closeTab: (path: string, groupId?: string) => Promise<void>;
  /** After a move on disk, repoint affected tabs at their new paths. */
  remapMovedPaths: (oldPath: string, newPath: string) => Promise<void>;
  /** Save any dirty tab at or under `path` (before a move/rename). */
  saveTabsUnder: (path: string) => Promise<void>;
  /** Close tabs at or under `path` without prompting (it's gone from disk). */
  closeTabsUnder: (path: string) => void;
  /** Reopen the most recently closed file tab (⇧⌘T). */
  reopenClosedTab: () => Promise<void>;
  /** Move to the next/previous tab of the focused group, wrapping. */
  cycleTab: (direction: 1 | -1) => void;
  /** Activate the tab at a 0-based index (⌘1…⌘9; 9 = last). */
  activateTabAt: (index: number) => void;
  /** Split: open the focused group's file in a new group to the right. */
  splitRight: () => Promise<void>;
  focusGroup: (groupId: string) => void;
  /** Focus the next/previous group (wraps). */
  focusAdjacentGroup: (direction: 1 | -1) => void;
  /** Move the focused group's active tab into the next group (creating
   *  one if needed). */
  moveActiveTabToNextGroup: () => Promise<void>;
  /** Close every tab in a group (asks about unsaved ones). */
  closeGroup: (groupId: string) => Promise<void>;
  /** Close everything (used when switching workspaces). */
  resetTabs: () => void;
  /** Reopen the saved tabs for the current workspace (session restore). */
  restoreSession: () => Promise<void>;
}

/** Persisted open-tab session, keyed per workspace folder. */
const SESSION_KEY_PREFIX = "sable.session:";

interface PersistedSession {
  groups?: { openPaths: string[]; activePath: string | null }[];
  activeGroup?: number;
  /** Pre-split format: a single group. */
  openPaths?: string[];
  activePath?: string | null;
}

function persistSession(state: Pick<TabsState, "groups" | "activeGroupId">) {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return;
  try {
    // Only file tabs persist; diff/settings tabs are transient (and have
    // synthetic keys that aren't openable paths).
    const groups = state.groups.map((group) => {
      const openPaths = group.tabs.filter((tab) => tab.kind === "file").map((tab) => tab.path);
      const activePath =
        group.activePath && openPaths.includes(group.activePath) ? group.activePath : null;
      return { openPaths, activePath };
    });
    const session: PersistedSession = {
      groups,
      activeGroup: Math.max(
        0,
        state.groups.findIndex((group) => group.id === state.activeGroupId),
      ),
    };
    localStorage.setItem(SESSION_KEY_PREFIX + root, JSON.stringify(session));
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

/** Recently closed file paths, most recent last (for ⇧⌘T). */
const closedTabStack: string[] = [];
const CLOSED_TAB_LIMIT = 30;

function rememberClosed(path: string) {
  const existing = closedTabStack.indexOf(path);
  if (existing !== -1) closedTabStack.splice(existing, 1);
  closedTabStack.push(path);
  if (closedTabStack.length > CLOSED_TAB_LIMIT) closedTabStack.shift();
}

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

let groupCounter = 0;
function emptyGroup(): EditorGroup {
  groupCounter += 1;
  return { id: `group-${groupCounter}`, tabs: [], activePath: null, lastFilePath: null };
}

/** State update that keeps the focused-group mirrors in sync. */
function withGroups(groups: EditorGroup[], activeGroupId: string) {
  const focused = groups.find((group) => group.id === activeGroupId) ?? groups[0];
  return {
    groups,
    activeGroupId: focused.id,
    tabs: focused.tabs,
    activePath: focused.activePath,
    lastFilePath: focused.lastFilePath,
  };
}

function updateGroup(
  groups: EditorGroup[],
  groupId: string,
  update: (group: EditorGroup) => EditorGroup,
): EditorGroup[] {
  return groups.map((group) => (group.id === groupId ? update(group) : group));
}

/** A group with `path` removed, picking a sensible new active tab. */
function withoutTab(group: EditorGroup, path: string): EditorGroup {
  const closedIndex = group.tabs.findIndex((tab) => tab.path === path);
  const tabs = group.tabs.filter((tab) => tab.path !== path);
  const activePath =
    group.activePath === path
      ? (tabs[Math.min(closedIndex, tabs.length - 1)]?.path ?? null)
      : group.activePath;
  const lastFilePath =
    group.lastFilePath === path
      ? (tabs.filter((tab) => tab.kind === "file").pop()?.path ?? null)
      : group.lastFilePath;
  return { ...group, tabs, activePath, lastFilePath };
}

/** Drop empty groups (always keeping one). */
function pruneGroups(groups: EditorGroup[]): EditorGroup[] {
  const nonEmpty = groups.filter((group) => group.tabs.length > 0);
  if (nonEmpty.length > 0) return nonEmpty;
  // Everything closed: keep the first group, emptied.
  const first = groups[0];
  return [first ? { ...first, tabs: [], activePath: null, lastFilePath: null } : emptyGroup()];
}

function isOpenAnywhere(groups: EditorGroup[], path: string): boolean {
  return groups.some((group) => group.tabs.some((tab) => tab.path === path));
}

/** Release a file's model and LSP document once no group shows it. */
function releaseIfUnused(groups: EditorGroup[], path: string) {
  if (isOpenAnywhere(groups, path)) return;
  cancelAutoSave(path);
  void closeDocument(path);
  disposeModel(path);
}

const initialGroup = emptyGroup();

export const useTabsStore = create<TabsState>((set, get) => ({
  ...withGroups([initialGroup], initialGroup.id),
  initialContentByPath: {},

  openFile: async (path, options) => {
    const groupId = options?.groupId ?? get().activeGroupId;
    const group = get().groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    if (group.tabs.some((tab) => tab.path === path)) {
      get().setActive(path, groupId);
      return;
    }
    // Already open in another group: share its model, no disk read.
    const elsewhere = isOpenAnywhere(get().groups, path);
    let contents: string | null = null;
    if (!elsewhere) {
      try {
        contents = await readFile(path);
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
        return;
      }
    }
    set((state) => {
      // Re-check against the latest state: a concurrent open (e.g.
      // session restore under StrictMode) may have added it already.
      const groups = updateGroup(state.groups, groupId, (current) =>
        current.tabs.some((tab) => tab.path === path)
          ? { ...current, activePath: path, lastFilePath: path }
          : {
              ...current,
              tabs: [...current.tabs, { path, name: fileNameOf(path), isDirty: false, kind: "file" }],
              activePath: path,
              lastFilePath: path,
            },
      );
      return {
        ...withGroups(groups, groupId),
        initialContentByPath:
          contents === null
            ? state.initialContentByPath
            : { ...state.initialContentByPath, [path]: contents },
      };
    });
    persistSession(get());
    // Start a language server (if any) and tell it this doc is open.
    if (contents !== null) void openDocument(path, contents);
  },

  openDiff: (source) => {
    const key = diffKey(source);
    const groupId = get().activeGroupId;
    set((state) =>
      withGroups(
        updateGroup(state.groups, groupId, (group) =>
          group.tabs.some((tab) => tab.path === key)
            ? { ...group, activePath: key }
            : {
                ...group,
                tabs: [
                  ...group.tabs,
                  { path: key, name: diffName(source), isDirty: false, kind: "diff", diff: source },
                ],
                activePath: key,
              },
        ),
        groupId,
      ),
    );
  },

  openMerge: (filePath) => {
    const key = `merge:${filePath}`;
    const groupId = get().activeGroupId;
    const base = filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath;
    set((state) =>
      withGroups(
        updateGroup(state.groups, groupId, (group) =>
          group.tabs.some((tab) => tab.path === key)
            ? { ...group, activePath: key }
            : {
                ...group,
                tabs: [
                  ...group.tabs,
                  { path: key, name: `${base} (Merge)`, isDirty: false, kind: "merge", mergeFile: filePath },
                ],
                activePath: key,
              },
        ),
        groupId,
      ),
    );
  },

  openHistory: (filePath) => {
    const key = `history:${filePath ?? "deleted"}`;
    const groupId = get().activeGroupId;
    const base = filePath ? (filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath) : null;
    set((state) =>
      withGroups(
        updateGroup(state.groups, groupId, (group) =>
          group.tabs.some((tab) => tab.path === key)
            ? { ...group, activePath: key }
            : {
                ...group,
                tabs: [
                  ...group.tabs,
                  {
                    path: key,
                    name: base ? `${base} (History)` : "Deleted Files",
                    isDirty: false,
                    kind: "history",
                    historyFile: filePath,
                  },
                ],
                activePath: key,
              },
        ),
        groupId,
      ),
    );
  },

  openSettings: () => {
    // One Settings tab: focus it wherever it is.
    const existing = get().groups.find((group) =>
      group.tabs.some((tab) => tab.path === SETTINGS_TAB_KEY),
    );
    if (existing) {
      get().setActive(SETTINGS_TAB_KEY, existing.id);
      return;
    }
    const groupId = get().activeGroupId;
    set((state) =>
      withGroups(
        updateGroup(state.groups, groupId, (group) => ({
          ...group,
          tabs: [
            ...group.tabs,
            { path: SETTINGS_TAB_KEY, name: "Settings", isDirty: false, kind: "settings" },
          ],
          activePath: SETTINGS_TAB_KEY,
        })),
        groupId,
      ),
    );
  },

  reopenClosedTab: async () => {
    while (closedTabStack.length > 0) {
      const path = closedTabStack.pop()!;
      if (get().tabs.some((tab) => tab.path === path)) continue;
      await get().openFile(path); // reports an error if it's gone
      return;
    }
  },

  cycleTab: (direction) => {
    const { tabs, activePath } = get();
    if (tabs.length === 0) return;
    const index = tabs.findIndex((tab) => tab.path === activePath);
    const next = (index + direction + tabs.length) % tabs.length;
    get().setActive(tabs[next].path);
  },

  activateTabAt: (index) => {
    const { tabs } = get();
    if (tabs.length === 0) return;
    const target = index >= 8 ? tabs[tabs.length - 1] : tabs[index];
    if (target) get().setActive(target.path);
  },

  setActive: (path, groupId) => {
    const targetId = groupId ?? get().activeGroupId;
    set((state) =>
      withGroups(
        updateGroup(state.groups, targetId, (group) => {
          const tab = group.tabs.find((candidate) => candidate.path === path);
          if (!tab) return group;
          // Only file tabs drive what the group's editor shows.
          return tab.kind === "file"
            ? { ...group, activePath: path, lastFilePath: path }
            : { ...group, activePath: path };
        }),
        targetId,
      ),
    );
    persistSession(get());
  },

  focusGroup: (groupId) => {
    if (get().activeGroupId === groupId) return;
    set((state) => withGroups(state.groups, groupId));
    persistSession(get());
  },

  focusAdjacentGroup: (direction) => {
    const { groups, activeGroupId } = get();
    const index = groups.findIndex((group) => group.id === activeGroupId);
    const next = groups[(index + direction + groups.length) % groups.length];
    get().focusGroup(next.id);
    getEditor()?.focus();
  },

  splitRight: async () => {
    const { groups, activeGroupId, lastFilePath } = get();
    if (!lastFilePath) {
      useUiStore.getState().setLastError("Open a file to split the editor");
      return;
    }
    const index = groups.findIndex((group) => group.id === activeGroupId);
    let target = groups[index + 1];
    if (!target) {
      if (groups.length >= MAX_GROUPS) {
        useUiStore.getState().setLastError(`Up to ${MAX_GROUPS} editor groups`);
        return;
      }
      target = emptyGroup();
      const next = [...groups.slice(0, index + 1), target, ...groups.slice(index + 1)];
      set(withGroups(next, activeGroupId));
    }
    await get().openFile(lastFilePath, { groupId: target.id });
    get().focusGroup(target.id);
  },

  moveActiveTabToNextGroup: async () => {
    const { groups, activeGroupId, activePath, tabs } = get();
    const tab = tabs.find((candidate) => candidate.path === activePath);
    if (!tab || tab.kind !== "file") return;
    const index = groups.findIndex((group) => group.id === activeGroupId);
    let target = groups[index + 1];
    if (!target) {
      if (groups.length >= MAX_GROUPS) return;
      target = emptyGroup();
      set(withGroups([...groups, target], activeGroupId));
    }
    await get().openFile(tab.path, { groupId: target.id });
    // Remove from the source group without releasing the model (it's
    // still open in the target).
    set((state) => {
      const pruned = pruneGroups(
        updateGroup(state.groups, activeGroupId, (group) => withoutTab(group, tab.path)),
      );
      return withGroups(pruned, target.id);
    });
    persistSession(get());
  },

  closeGroup: async (groupId) => {
    const group = get().groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    for (const tab of [...group.tabs]) {
      await get().closeTab(tab.path, groupId);
      // Stop if the user kept a dirty tab.
      const still = get().groups.find((candidate) => candidate.id === groupId);
      if (still?.tabs.some((candidate) => candidate.path === tab.path)) return;
    }
  },

  restoreSession: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    const raw = localStorage.getItem(SESSION_KEY_PREFIX + root);
    if (!raw) return;
    let session: PersistedSession;
    try {
      session = JSON.parse(raw);
    } catch {
      return;
    }
    const savedGroups =
      session.groups ??
      (session.openPaths
        ? [{ openPaths: session.openPaths, activePath: session.activePath ?? null }]
        : []);
    const restored: string[] = [];
    for (const [index, saved] of savedGroups.slice(0, MAX_GROUPS).entries()) {
      // The first group already exists; create the rest.
      let groupId = get().groups[0].id;
      if (index > 0) {
        const group = emptyGroup();
        set((state) => withGroups([...state.groups, group], state.activeGroupId));
        groupId = group.id;
      }
      // Reopen tabs in their saved order; openFile tolerates deleted files.
      for (const path of saved.openPaths) await get().openFile(path, { groupId });
      if (saved.activePath) get().setActive(saved.activePath, groupId);
      restored.push(groupId);
    }
    // Groups whose files were all deleted stay empty — drop them.
    set((state) => withGroups(pruneGroups(state.groups), state.activeGroupId));
    const focus = restored[session.activeGroup ?? 0];
    if (focus && get().groups.some((group) => group.id === focus)) get().focusGroup(focus);
  },

  resetTabs: () => {
    const paths = new Set(get().groups.flatMap((group) => group.tabs.map((tab) => tab.path)));
    for (const path of paths) {
      cancelAutoSave(path);
      disposeModel(path);
      void closeDocument(path);
    }
    const group = emptyGroup();
    set({ ...withGroups([group], group.id), initialContentByPath: {} });
  },

  syncDirtyState: (path) => {
    const isDirty = isModelDirty(path);
    set((state) =>
      withGroups(
        state.groups.map((group) =>
          group.tabs.some((tab) => tab.path === path && tab.isDirty !== isDirty)
            ? {
                ...group,
                tabs: group.tabs.map((tab) => (tab.path === path ? { ...tab, isDirty } : tab)),
              }
            : group,
        ),
        state.activeGroupId,
      ),
    );
  },

  saveTab: async (path, reason = "manual") => {
    // Diff/settings tabs are read-only — never write to their synthetic key.
    const tab = get()
      .groups.flatMap((group) => group.tabs)
      .find((candidate) => candidate.path === path);
    if (tab && tab.kind !== "file") return;
    cancelAutoSave(path);
    if (reason === "manual") {
      await applySaveTransforms(path, {
        format: getSetting("editor.formatOnSave"),
        trimTrailingWhitespace: getSetting("editor.trimTrailingWhitespace"),
        insertFinalNewline: getSetting("editor.insertFinalNewline"),
      });
    }
    // Read from the model; fall back to the live editor for the active
    // tab. If neither works something is genuinely wrong — say so
    // instead of silently dropping the save.
    let value = getModelValue(path);
    if (value === null && get().activePath === path) {
      value = getEditor()?.getValue() ?? null;
    }
    if (value === null) {
      useUiStore.getState().setLastError(`Could not read editor contents for ${path}`);
      return;
    }
    try {
      await writeFile(path, value);
      markSaved(path);
      get().syncDirtyState(path);
      // A save changes git status (modified/untracked); refresh it.
      useGitStore.getState().refresh();
      // Hand-edited settings.json takes effect on save.
      if (path === useSettingsStore.getState().filePath) {
        void useSettingsStore.getState().load();
      }
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  scheduleAutoSave: (path) => {
    cancelAutoSave(path);
    if (!getSetting("files.autoSave")) return;
    autoSaveTimers.set(
      path,
      setTimeout(() => {
        autoSaveTimers.delete(path);
        get().saveTab(path, "auto");
      }, getSetting("files.autoSaveDelay")),
    );
  },

  remapMovedPaths: async (oldPath, newPath) => {
    const affected = new Set(
      get()
        .groups.flatMap((group) => group.tabs)
        .filter((tab) => tab.kind === "file" && isSameOrInside(tab.path, oldPath))
        .map((tab) => tab.path),
    );
    for (const path of affected) {
      const updatedPath = newPath + path.slice(oldPath.length);
      try {
        // The old Monaco model's URI can't change; reload from the new
        // location instead. Callers save dirty tabs before moving, so
        // nothing is lost.
        const contents = await readFile(updatedPath);
        cancelAutoSave(path);
        disposeModel(path);
        // Re-register the document with the language server at its new path.
        void closeDocument(path);
        void openDocument(updatedPath, contents);
        const repoint = (value: string | null) => (value === path ? updatedPath : value);
        set((state) => {
          const initialContentByPath = { ...state.initialContentByPath };
          delete initialContentByPath[path];
          initialContentByPath[updatedPath] = contents;
          const groups = state.groups.map((group) => ({
            ...group,
            tabs: group.tabs.map((tab) =>
              tab.path === path
                ? { path: updatedPath, name: fileNameOf(updatedPath), isDirty: false, kind: "file" as const }
                : tab,
            ),
            activePath: repoint(group.activePath),
            lastFilePath: repoint(group.lastFilePath),
          }));
          return { ...withGroups(groups, state.activeGroupId), initialContentByPath };
        });
        persistSession(get());
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
      }
    }
  },

  saveTabsUnder: async (path) => {
    const dirty = new Set(
      get()
        .groups.flatMap((group) => group.tabs)
        .filter((tab) => tab.kind === "file" && tab.isDirty && isSameOrInside(tab.path, path))
        .map((tab) => tab.path),
    );
    for (const dirtyPath of dirty) await get().saveTab(dirtyPath);
  },

  closeTabsUnder: (path) => {
    const closing = new Set(
      get()
        .groups.flatMap((group) => group.tabs)
        .filter((tab) => tab.kind === "file" && isSameOrInside(tab.path, path))
        .map((tab) => tab.path),
    );
    if (closing.size === 0) return;
    for (const closedPath of closing) {
      cancelAutoSave(closedPath);
      void closeDocument(closedPath);
      disposeModel(closedPath);
    }
    set((state) => {
      let groups = state.groups;
      for (const closedPath of closing) {
        groups = groups.map((group) => withoutTab(group, closedPath));
      }
      const initialContentByPath = { ...state.initialContentByPath };
      for (const closedPath of closing) delete initialContentByPath[closedPath];
      return { ...withGroups(pruneGroups(groups), state.activeGroupId), initialContentByPath };
    });
    persistSession(get());
  },

  closeTab: async (path, groupId) => {
    const targetId = groupId ?? get().activeGroupId;
    const group = get().groups.find((candidate) => candidate.id === targetId);
    const closingTab = group?.tabs.find((tab) => tab.path === path);
    if (!group || !closingTab) return;

    const openElsewhere = get().groups.some(
      (other) => other.id !== targetId && other.tabs.some((tab) => tab.path === path),
    );
    // Unsaved edits live in the shared model — only at risk when this is
    // the last tab showing the file.
    if (closingTab.isDirty && !openElsewhere) {
      const discard = await confirmNative(
        `"${closingTab.name}" has unsaved changes. Discard them?`,
        { title: "Unsaved Changes", kind: "warning" },
      );
      if (!discard) return;
    }

    set((state) => {
      const groups = pruneGroups(
        updateGroup(state.groups, targetId, (current) => withoutTab(current, path)),
      );
      // If the group vanished, focus its neighbor.
      const index = state.groups.findIndex((candidate) => candidate.id === targetId);
      const focus = groups.some((candidate) => candidate.id === state.activeGroupId)
        ? state.activeGroupId
        : groups[Math.min(index, groups.length - 1)].id;
      const initialContentByPath = { ...state.initialContentByPath };
      if (!isOpenAnywhere(groups, path)) delete initialContentByPath[path];
      return { ...withGroups(groups, focus), initialContentByPath };
    });

    // Only now that the close is certain: stop pending auto-saves (they
    // must not fire against a disposed model) and tell the language
    // server — unless another group still shows the file.
    if (closingTab.kind === "file") {
      if (!isOpenAnywhere(get().groups, path)) rememberClosed(path);
      releaseIfUnused(get().groups, path);
    }
    persistSession(get());
  },
}));

/** Whether a file is open in any editor group. */
export function isFileOpen(path: string): boolean {
  return isOpenAnywhere(useTabsStore.getState().groups, path);
}

/** Every distinct file open in any group (focused group first). */
export function allOpenFiles(): string[] {
  const { groups, activeGroupId } = useTabsStore.getState();
  const ordered = [
    ...groups.filter((group) => group.id === activeGroupId),
    ...groups.filter((group) => group.id !== activeGroupId),
  ];
  return [
    ...new Set(
      ordered.flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === "file").map((tab) => tab.path),
      ),
    ),
  ];
}

// The editor registry routes getEditor() to the focused group's editor.
useTabsStore.subscribe((state, previous) => {
  if (state.activeGroupId !== previous.activeGroupId) {
    setActiveEditorGroup(state.activeGroupId);
  }
});
setActiveEditorGroup(initialGroup.id);
