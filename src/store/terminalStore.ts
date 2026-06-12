import { create } from "zustand";
import { createTerminal, writeTerminal } from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/** v1 has a single terminal; the id scheme allows more later. */
export const MAIN_TERMINAL_ID = "main";

interface TerminalSessionState {
  isSessionRunning: boolean;
  /** Create the PTY if needed (idempotent). cwd = workspace root. */
  ensureSession: () => Promise<void>;
  /** Type a full command line into the shell (with Enter). */
  sendCommandLine: (commandLine: string) => Promise<void>;
  markSessionEnded: () => void;
}

export const useTerminalStore = create<TerminalSessionState>((set, get) => ({
  isSessionRunning: false,

  ensureSession: async () => {
    if (get().isSessionRunning) return;
    const workspaceRoot = useWorkspaceStore.getState().rootPath;
    try {
      // 80x24 is a placeholder; the panel fits and resizes immediately
      // after mounting.
      await createTerminal(MAIN_TERMINAL_ID, 80, 24, workspaceRoot);
      set({ isSessionRunning: true });
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  sendCommandLine: async (commandLine) => {
    await get().ensureSession();
    if (!get().isSessionRunning) return;
    try {
      await writeTerminal(MAIN_TERMINAL_ID, `${commandLine}\r`);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  markSessionEnded: () => set({ isSessionRunning: false }),
}));
