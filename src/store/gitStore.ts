import { create } from "zustand";
import {
  gitCommit,
  gitSetIdentity,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
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
}

const REFRESH_DEBOUNCE_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

async function queryStatus(
  set: (partial: Partial<GitState>) => void,
): Promise<void> {
  const rootPath = useWorkspaceStore.getState().rootPath;
  if (!rootPath) {
    set({ isRepo: false, branch: null, statusByPath: {} });
    return;
  }
  try {
    const status = await gitStatus(rootPath);
    set({
      isRepo: status.isRepo,
      branch: status.branch,
      statusByPath: status.files,
    });
  } catch {
    // Keep the last good state rather than flashing empty.
  }
}

export const useGitStore = create<GitState>((set, get) => ({
  isRepo: false,
  branch: null,
  statusByPath: {},

  refresh: () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void queryStatus(set), REFRESH_DEBOUNCE_MS);
  },

  refreshNow: () => queryStatus(set),

  reset: () => {
    clearTimeout(refreshTimer);
    set({ isRepo: false, branch: null, statusByPath: {} });
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
}));
