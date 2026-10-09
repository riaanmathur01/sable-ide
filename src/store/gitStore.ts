import { create } from "zustand";
import {
  gitAheadBehind,
  gitBranches,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitAbort,
  gitRebase,
  gitRebaseContinue,
  gitRebaseInteractive,
  gitCherryPick,
  gitMerge,
  gitRevertCommit,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashSave,
  gitPull,
  gitPush,
  gitSetIdentity,
  gitStage,
  gitStageAll,
  gitStageContent,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  gitUnstageAll,
  type BranchInfo,
  type StashInfo,
  type CommitInfo,
  type RebaseStep,
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
  /** A merge (cherry-pick, …) in progress, and Git's message for it. */
  operation: string | null;
  mergeMessage: string | null;
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
  /** Write a file's staged version (hunk staging). */
  stageContent: (file: string, content: string) => Promise<boolean>;
  /** Merge a branch into the current one (conflicts are left to resolve). */
  merge: (branch: string) => Promise<void>;
  /** Abandon the merge / cherry-pick / revert in progress. */
  abort: () => Promise<void>;
  stashes: StashInfo[];
  loadStashes: () => Promise<void>;
  stashSave: (message: string | null, includeUntracked: boolean) => Promise<void>;
  stashApply: (index: number, pop: boolean) => Promise<void>;
  stashDrop: (index: number) => Promise<void>;
  cherryPick: (hash: string) => Promise<void>;
  /** Rebase the current branch onto a branch or commit. */
  rebase: (onto: string) => Promise<void>;
  rebaseInteractive: (base: string, steps: RebaseStep[]) => Promise<void>;
  /** Go on after resolving a rebase's conflicts (or skip its commit). */
  continueRebase: (skip?: boolean) => Promise<void>;
  /** The interactive rebase dialog: the commits after `base`, oldest first. */
  rebaseDialog: { base: string; commits: CommitInfo[] } | null;
  setRebaseDialog: (dialog: { base: string; commits: CommitInfo[] } | null) => void;
  revertCommit: (hash: string) => Promise<void>;
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
      operation: null,
      mergeMessage: null,
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
      operation: status.operation,
      mergeMessage: status.mergeMessage,
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
  operation: null,
  mergeMessage: null,
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
      operation: null,
      mergeMessage: null,
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

  stageContent: async (file, content) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return false;
    try {
      await gitStageContent(root, file, content);
      await get().refreshNow();
      return true;
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
      return false;
    }
  },

  merge: (branch) => runNetwork(set, get, (root) => gitMerge(root, branch), `Merged ${branch}`),

  abort: () => runGitOperation(get, gitAbort, "Aborted"),

  stashes: [],
  loadStashes: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      set({ stashes: await gitStashList(root) });
    } catch {
      set({ stashes: [] });
    }
  },
  stashSave: (message, includeUntracked) =>
    runGitOperation(get, (root) => gitStashSave(root, message, includeUntracked), "Changes stashed"),
  stashApply: (index, pop) =>
    runGitOperation(get, (root) => gitStashApply(root, index, pop), pop ? "Stash popped" : "Stash applied"),
  stashDrop: (index) => runGitOperation(get, (root) => gitStashDrop(root, index), "Stash dropped"),
  cherryPick: (hash) => runGitOperation(get, (root) => gitCherryPick(root, hash), "Cherry-picked"),
  rebase: (onto) => runGitOperation(get, (root) => gitRebase(root, onto), `Rebased onto ${onto}`),
  rebaseInteractive: (base, steps) =>
    runGitOperation(get, (root) => gitRebaseInteractive(root, base, steps), "Rebase done"),
  continueRebase: (skip = false) =>
    runGitOperation(get, (root) => gitRebaseContinue(root, skip), skip ? "Skipped that commit" : "Rebase continued"),
  rebaseDialog: null,
  setRebaseDialog: (dialog) => set({ rebaseDialog: dialog }),
  revertCommit: (hash) => runGitOperation(get, (root) => gitRevertCommit(root, hash), "Commit reverted"),

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
    const pulled = get().syncMessage ?? "";
    if (!pulled.startsWith("Error") && !pulled.startsWith("Conflicts")) {
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
    const message = String(error);
    // Conflicts aren't a failure: the merge is under way, to be finished
    // in Source Control.
    if (message.startsWith("Conflicts")) {
      set({ syncMessage: message });
      useUiStore.getState().setSidebarView("git");
    } else {
      set({ syncMessage: `Error: ${message}` });
    }
  } finally {
    set({ isSyncing: false });
    await get().refreshNow();
    await get().loadBranches();
  }
}

/**
 * A local git operation that may stop on conflicts (stash, cherry-pick,
 * revert, abort): report the outcome in the status bar, send conflicts to
 * Source Control, refresh.
 */
async function runGitOperation(get: () => GitState, op: (root: string) => Promise<unknown>, done: string): Promise<void> {
  const root = useWorkspaceStore.getState().rootPath;
  if (!root) return;
  const ui = useUiStore.getState();
  try {
    await op(root);
    ui.showStatus(done);
  } catch (error) {
    const message = String(error);
    if (message.startsWith("Conflicts")) {
      ui.showStatus(message);
      ui.setSidebarView("git");
    } else {
      ui.setLastError(message);
    }
  } finally {
    await get().refreshNow();
    await get().loadStashes();
  }
}
