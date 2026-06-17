import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useTabsStore } from "./tabsStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useInterpreterStore } from "./interpreterStore";
import { useBreakpointsStore } from "./breakpointsStore";
import { useUiStore } from "./uiStore";
import { parentDirectoryOf } from "../lib/ipc";

/**
 * Debug session state (DAP). The actual protocol traffic is handled by
 * lib/debug/debugClient; this store holds what the UI shows: whether we're
 * debugging, whether we're paused, and where execution stopped.
 */
interface DebugState {
  isDebugging: boolean;
  isPaused: boolean;
  stoppedThreadId: number | null;
  /** Absolute file + 1-based line where execution is paused. */
  stoppedFile: string | null;
  stoppedLine: number | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Called by the debug client when a `stopped` event resolves. */
  setStopped: (threadId: number, file: string | null, line: number) => void;
  /** Clear the paused highlight (on continue / step). */
  setRunning: () => void;
  /** Session ended. */
  setTerminated: () => void;
}

export const useDebugStore = create<DebugState>((set) => ({
  isDebugging: false,
  isPaused: false,
  stoppedThreadId: null,
  stoppedFile: null,
  stoppedLine: null,

  start: async () => {
    const program = useTabsStore.getState().lastFilePath;
    if (!program) {
      useUiStore.getState().setLastError("Open a Python file to debug");
      return;
    }
    if (!/\.pyi?$/.test(program)) {
      useUiStore.getState().setLastError("Debugging currently supports Python");
      return;
    }
    const python = useInterpreterStore.getState().selectedPath ?? "python3";
    const cwd =
      useWorkspaceStore.getState().rootPath ?? parentDirectoryOf(program);
    const breakpoints = useBreakpointsStore.getState().breakpointsByFile;

    set({
      isDebugging: true,
      isPaused: false,
      stoppedFile: null,
      stoppedLine: null,
    });
    try {
      await invoke("start_debug", { python, program, cwd, breakpoints });
    } catch (error) {
      set({ isDebugging: false });
      useUiStore.getState().setLastError(String(error));
    }
  },

  stop: async () => {
    await invoke("debug_stop").catch(() => {});
    set({
      isDebugging: false,
      isPaused: false,
      stoppedFile: null,
      stoppedLine: null,
      stoppedThreadId: null,
    });
  },

  setStopped: (threadId, file, line) =>
    set({
      isPaused: true,
      stoppedThreadId: threadId,
      stoppedFile: file,
      stoppedLine: line,
    }),

  setRunning: () =>
    set({ isPaused: false, stoppedFile: null, stoppedLine: null }),

  setTerminated: () =>
    set({
      isDebugging: false,
      isPaused: false,
      stoppedFile: null,
      stoppedLine: null,
      stoppedThreadId: null,
    }),
}));
