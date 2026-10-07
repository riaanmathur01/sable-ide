import { create } from "zustand";
import { createTerminal, killTerminal } from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Integrated terminals. Each shell session has a unique id (`term-1`,
 * `term-2`, …) that is never reused — restarting mints a new one — so a
 * killed session's lingering exit/output events can never be mistaken
 * for another session's.
 */
let sessionCounter = 0;

function nextId(): string {
  sessionCounter += 1;
  return `term-${sessionCounter}`;
}

export interface TerminalSession {
  id: string;
  /** Shown on the tab; follows the shell's title escape sequence. */
  title: string;
  isRunning: boolean;
}

interface PendingCommand {
  terminalId: string;
  commandLine: string;
}

interface TerminalState {
  /** Always at least one. */
  sessions: TerminalSession[];
  activeId: string;
  /**
   * A command line waiting to be typed into a shell. Set by "Run"; that
   * terminal's view flushes it once it's listening and its PTY exists, so
   * nothing is missed even when the panel was closed (it lazy-loads).
   */
  pendingCommand: PendingCommand | null;
  /**
   * Create a session's PTY if needed (idempotent). cwd = workspace root.
   * Pass the real size: shells draw their first prompt at the size the
   * PTY starts with.
   */
  ensureSession: (id: string, size?: { cols: number; rows: number }) => Promise<void>;
  /** Open a new terminal tab (and show the panel). */
  newTerminal: () => string;
  /** Kill a terminal and remove its tab. Closing the last one hides the
   *  panel and leaves a fresh (not yet started) session behind. */
  closeTerminal: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  setTitle: (id: string, title: string) => void;
  /** Kill a shell and start a fresh one in the same tab. */
  restartSession: (id?: string) => Promise<void>;
  /** Kill every shell and start over with one (workspace switch). */
  restartAll: () => Promise<void>;
  /** Queue a command for the active terminal. */
  enqueueCommand: (commandLine: string) => void;
  clearPendingCommand: () => void;
  markSessionEnded: (id: string) => void;
}

function freshSession(): TerminalSession {
  return { id: nextId(), title: "", isRunning: false };
}

const initial = freshSession();

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [initial],
  activeId: initial.id,
  pendingCommand: null,

  ensureSession: async (id, size) => {
    const session = get().sessions.find((candidate) => candidate.id === id);
    if (!session || session.isRunning) return;
    const workspaceRoot = useWorkspaceStore.getState().rootPath;
    try {
      // 80x24 only if the caller doesn't know its size yet; the view
      // resizes the PTY as soon as it fits.
      await createTerminal(id, size?.cols ?? 80, size?.rows ?? 24, workspaceRoot);
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === id ? { ...candidate, isRunning: true } : candidate,
        ),
      }));
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  newTerminal: () => {
    const session = freshSession();
    set((state) => ({ sessions: [...state.sessions, session], activeId: session.id }));
    useUiStore.getState().setBottomPanel("terminal");
    return session.id;
  },

  closeTerminal: async (id) => {
    await killTerminal(id).catch(() => {});
    const { sessions, activeId } = get();
    const index = sessions.findIndex((session) => session.id === id);
    if (index === -1) return;
    const remaining = sessions.filter((session) => session.id !== id);
    if (remaining.length === 0) {
      const session = freshSession();
      set({ sessions: [session], activeId: session.id });
      useUiStore.getState().setTerminalVisible(false);
      return;
    }
    set({
      sessions: remaining,
      activeId:
        activeId === id ? remaining[Math.min(index, remaining.length - 1)].id : activeId,
    });
  },

  setActive: (id) => set({ activeId: id }),

  setTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id && session.title !== title ? { ...session, title } : session,
      ),
    })),

  restartSession: async (id) => {
    const target = id ?? get().activeId;
    await killTerminal(target).catch(() => {});
    // A new id remounts the tab's view (it's keyed on the id) with a
    // clean buffer and a new shell.
    const session = freshSession();
    set((state) => ({
      sessions: state.sessions.map((candidate) => (candidate.id === target ? session : candidate)),
      activeId: state.activeId === target ? session.id : state.activeId,
    }));
  },

  restartAll: async () => {
    await Promise.all(get().sessions.map((session) => killTerminal(session.id).catch(() => {})));
    const session = freshSession();
    set({ sessions: [session], activeId: session.id, pendingCommand: null });
  },

  enqueueCommand: (commandLine) =>
    set({ pendingCommand: { terminalId: get().activeId, commandLine } }),
  clearPendingCommand: () => set({ pendingCommand: null }),

  markSessionEnded: (id) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, isRunning: false } : session,
      ),
    })),
}));
