import { create } from "zustand";
import {
  gitAheadBehind,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitPull,
  gitPush,
  gitSetIdentity,
  gitStage,
  gitStageAll,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  gitUnstageAll,
  type BranchInfo,
  type GitFileEntry,
  type GitFileStatus,
} from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Git status + commit actions for the open workspace. Status refreshes
 * are debounced (watcher/save bursts collapse to one query); deliberate
 * user actions (stage, commit, …) refresh immediately for snappy
 * feedback.
 */

/** Returned by a commit attempt so the UI can react to a missing identity. */
export type CommitOutcome =
  | { ok: true }
  | { ok: false; needsIdentity: boolean; message: string };

/** Single indicator the file tree shows: prefer the unstaged side. */
export function treeStatusOf(entry: GitFileEntry): GitFileStatus | undefined {
  return entry.unstaged ?? entry.staged ?? undefined;
}

interface GitState {
  isRepo: boolean;
  branch: string | null;
  statusByPath: Record<string, GitFileEntry>;
  // Sync state vs upstream.
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasRemote: boolean;
  // Branch management.
  branches: BranchInfo[];
  // Network op in flight + last result message (transient).
  isSyncing: boolean;
  syncMessage: string | null;
  /** Debounced re-query (watcher / save driven). */
  refresh: () => void;
  /** Immediate re-query (after a deliberate git action). */
  refreshNow: () => Promise<void>;
  reset: () => void;
  stage: (file: string) => Promise<void>;
  unstage: (file: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (message: string) => Promise<CommitOutcome>;
  setIdentity: (name: string, email: string) => Promise<boolean>;
  loadBranches: () => Promise<void>;
  switchBranch: (name: string) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  sync: () => Promise<void>;
}

const REFRESH_DEBOUNCE_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

async function queryStatus(
  set: (partial: Partial<GitState>) => void,
): Promise<void> {
  const rootPath = useWorkspaceStore.getState().rootPath;
  if (!rootPath) {
    set({
      isRepo: false,
      branch: null,
      statusByPath: {},
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasRemote: false,
      branches: [],
    });
    return;
  }
  try {
    const status = await gitStatus(rootPath);
    set({
      isRepo: status.isRepo,
      branch: status.branch,
      statusByPath: status.files,
    });
    if (status.isRepo) {
      // Ahead/behind is a separate, cheap query; failures shouldn't wipe
      // the status we just got.
      try {
        const sync = await gitAheadBehind(rootPath);
        set({
          ahead: sync.ahead,
          behind: sync.behind,
          hasUpstream: sync.hasUpstream,
          hasRemote: sync.hasRemote,
        });
      } catch {
        /* leave previous sync state */
      }
    }
  } catch {
    // Keep the last good state rather than flashing empty.
  }
}

export const useGitStore = create<GitState>((set, get) => ({
  isRepo: false,
  branch: null,
  statusByPath: {},
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  hasRemote: false,
  branches: [],
  isSyncing: false,
  syncMessage: null,

  refresh: () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void queryStatus(set), REFRESH_DEBOUNCE_MS);
  },

  refreshNow: () => queryStatus(set),

  reset: () => {
    clearTimeout(refreshTimer);
    set({
      isRepo: false,
      branch: null,
      statusByPath: {},
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasRemote: false,
      branches: [],
      syncMessage: null,
    });
  },

  stage: async (file) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitStage(root, file);
      await get().refreshNow();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  unstage: async (file) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitUnstage(root, file);
      await get().refreshNow();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  stageAll: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitStageAll(root);
      await get().refreshNow();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  unstageAll: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitUnstageAll(root);
      await get().refreshNow();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  commit: async (message) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return { ok: false, needsIdentity: false, message: "No repo" };
    try {
      await gitCommit(root, message);
      await get().refreshNow();
      return { ok: true };
    } catch (error) {
      const text = String(error);
      // The Rust side returns this marker when user.name/email are unset.
      const needsIdentity = text.includes("identity-unset");
      return { ok: false, needsIdentity, message: text };
    }
  },

  setIdentity: async (name, email) => {
    try {
      await gitSetIdentity(name, email);
      return true;
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
      return false;
    }
  },

  loadBranches: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      const branches = await gitBranches(root);
      set({ branches });
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  switchBranch: async (name) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitSwitchBranch(root, name);
      await get().refreshNow();
      await get().loadBranches();
    } catch (error) {
      // e.g. "commit or stash first" — surface, don't lose work.
      useUiStore.getState().setLastError(String(error));
    }
  },

  createBranch: async (name) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitCreateBranch(root, name);
      await get().refreshNow();
      await get().loadBranches();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  deleteBranch: async (name) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      await gitDeleteBranch(root, name);
      await get().loadBranches();
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  fetch: () => runNetwork(set, get, gitFetch, "Fetched"),
  pull: () => runNetwork(set, get, gitPull, "Pulled"),
  push: () => runNetwork(set, get, gitPush, "Pushed"),

  sync: async () => {
    // VS Code-style sync: pull then push.
    await runNetwork(set, get, gitPull, "Pulled");
    if (!get().syncMessage?.startsWith("Error")) {
      await runNetwork(set, get, gitPush, "Pushed");
    }
  },
}));

/** Shared runner for network ops: pending state, result message, refresh. */
async function runNetwork(
  set: (partial: Partial<GitState>) => void,
  get: () => GitState,
  op: (root: string) => Promise<string>,
  successVerb: string,
): Promise<void> {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return;
  set({ isSyncing: true, syncMessage: null });
  try {
    const output = await op(root);
    set({ syncMessage: output ? `${successVerb}: ${output}` : successVerb });
  } catch (error) {
    set({ syncMessage: `Error: ${String(error)}` });
  } finally {
    set({ isSyncing: false });
    await get().refreshNow();
    await get().loadBranches();
  }
}
