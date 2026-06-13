import { create } from "zustand";
import { gitStatus, type GitFileStatus } from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Git status for the open workspace: current branch and per-file status.
 * Refreshes are debounced so a burst of file-watcher events (a checkout,
 * a save, an external commit) triggers a single status query, not dozens.
 */
interface GitState {
  isRepo: boolean;
  branch: string | null;
  statusByPath: Record<string, GitFileStatus>;
  /** Debounced re-query of git status against the current workspace. */
  refresh: () => void;
  /** Clear all git state (e.g. when no folder is open). */
  reset: () => void;
}

const REFRESH_DEBOUNCE_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useGitStore = create<GitState>((set) => ({
  isRepo: false,
  branch: null,
  statusByPath: {},

  refresh: () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
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
        // Leave the last good state rather than flashing empty on a
        // transient error.
      }
    }, REFRESH_DEBOUNCE_MS);
  },

  reset: () => {
    clearTimeout(refreshTimer);
    set({ isRepo: false, branch: null, statusByPath: {} });
  },
}));
