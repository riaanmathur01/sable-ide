import { create } from "zustand";
import {
  createPythonVenv,
  discoverPythonInterpreters,
  lspSetPythonPath,
  type Interpreter,
} from "../lib/ipc";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * Python interpreter selection for the Run feature. Discovered from the
 * system + workspace venvs (Rust); the user can pick a local one or
 * create a new virtualenv. The default is the workspace's virtualenv, or
 * else the latest Python version (PyPy stays selectable, never default).
 *
 * Structured so other languages needing an interpreter can be added: the
 * selection is keyed per language, with "python" wired up today.
 */

/** Extract a comparable [major, minor, patch] from a version string. */
function parseVersion(text: string): [number, number, number] {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isNewer(a: string, b: string): boolean {
  const [a0, a1, a2] = parseVersion(a);
  const [b0, b1, b2] = parseVersion(b);
  return a0 !== b0 ? a0 > b0 : a1 !== b1 ? a1 > b1 : a2 > b2;
}

/**
 * Default interpreter: the project's own virtualenv if it has one (that's
 * where its dependencies — and debugpy — are installed), otherwise the
 * highest CPython version, otherwise anything. An explicit choice in the
 * picker always wins over this.
 */
function pickDefault(interpreters: Interpreter[]): Interpreter | null {
  if (interpreters.length === 0) return null;
  const projectVenv = interpreters.find((i) => i.kind === "venv");
  if (projectVenv) return projectVenv;
  const cpython = interpreters.filter((i) => i.kind !== "pypy");
  const pool = cpython.length > 0 ? cpython : interpreters;
  return pool.reduce((best, current) =>
    isNewer(current.version, best.version) ? current : best,
  );
}

function storageKey(root: string): string {
  return `sable.pythonInterpreter:${root}`;
}

interface InterpreterState {
  interpreters: Interpreter[];
  selectedPath: string | null;
  isCreating: boolean;
  /** Re-scan for interpreters and resolve the active selection. */
  discover: () => Promise<void>;
  select: (path: string) => void;
  /** Create a .venv from a base interpreter and select it. */
  createVenv: (basePath: string) => Promise<void>;
  /** Clear discovered interpreters and selection (on workspace switch). */
  reset: () => void;
}

export const useInterpreterStore = create<InterpreterState>((set, get) => ({
  interpreters: [],
  selectedPath: null,
  isCreating: false,

  discover: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    try {
      const interpreters = await discoverPythonInterpreters(root);
      // Restore a persisted choice if it's still present; otherwise pick
      // the latest-version default.
      let selectedPath = get().selectedPath;
      const persisted = root
        ? localStorage.getItem(storageKey(root))
        : null;
      const stillExists = (path: string | null) =>
        path != null && interpreters.some((i) => i.path === path);

      if (stillExists(persisted)) {
        selectedPath = persisted;
      } else if (!stillExists(selectedPath)) {
        selectedPath = pickDefault(interpreters)?.path ?? null;
      }
      set({ interpreters, selectedPath });
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  },

  select: (path) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (root) localStorage.setItem(storageKey(root), path);
    set({ selectedPath: path });
  },

  createVenv: async (basePath) => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    set({ isCreating: true });
    try {
      const created = await createPythonVenv(basePath, `${root}/.venv`);
      set((state) => {
        const interpreters = state.interpreters.some(
          (i) => i.path === created.path,
        )
          ? state.interpreters
          : [created, ...state.interpreters];
        return { interpreters };
      });
      get().select(created.path);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      set({ isCreating: false });
    }
  },

  reset: () => set({ interpreters: [], selectedPath: null }),
}));

// Pyright resolves imports against the selected interpreter (so packages
// in the project's .venv aren't flagged as missing). Keep it in sync with
// every selection change — discovery, the picker, a new venv, a reset.
useInterpreterStore.subscribe((state, previous) => {
  if (state.selectedPath !== previous.selectedPath) {
    void lspSetPythonPath(state.selectedPath).catch(() => {});
  }
});
