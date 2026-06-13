import { create } from "zustand";
import {
  createTerminal,
  killTerminal,
  writeTerminal,
} from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Single integrated terminal. Each shell session has a unique id
 * (`main-0`, `main-1`, …) that changes on restart — so a killed
 * session's lingering exit event can never be mistaken for the new one.
 */
let sessionCounter = 0;

interface TerminalSessionState {
  /** Current session id; changes on each restart. */
  terminalId: string;
  isSessionRunning: boolean;
  /** Create the PTY if needed (idempotent). cwd = workspace root. */
  ensureSession: () => Promise<void>;
  /** Type a full command line into the shell (with Enter). */
  sendCommandLine: (commandLine: string) => Promise<void>;
  /** Kill the shell and start a fresh one. */
  restartSession: () => Promise<void>;
  markSessionEnded: () => void;
}

export const useTerminalStore = create<TerminalSessionState>((set, get) => ({
  terminalId: "main-0",
  isSessionRunning: false,

  ensureSession: async () => {
    if (get().isSessionRunning) return;
    const workspaceRoot = useWorkspaceStore.getState().rootPath;
    try {
      // 80x24 is a placeholder; the panel fits and resizes immediately
      // after mounting.
      await createTerminal(get().terminalId, 80, 24, workspaceRoot);
      set({ isSessionRunning: true });
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  sendCommandLine: async (commandLine) => {
    await get().ensureSession();
    if (!get().isSessionRunning) return;
    try {
      await writeTerminal(get().terminalId, `${commandLine}\r`);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  restartSession: async () => {
    // Kill the old PTY, then mint a new id. The terminal view is keyed
    // on terminalId, so it remounts with a clean buffer and a new shell.
    await killTerminal(get().terminalId).catch(() => {});
    sessionCounter += 1;
    set({ terminalId: `main-${sessionCounter}`, isSessionRunning: false });
  },

  markSessionEnded: () => set({ isSessionRunning: false }),
}));
