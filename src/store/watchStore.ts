import { create } from "zustand";
import { sendDebugRequest, type DebugVariable } from "../lib/debug/debugClient";
import { useDebugStore } from "./debugStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Watch expressions (Run and Debug view): saved per workspace, evaluated
 * in the selected stack frame each time the program pauses.
 */
interface WatchState {
  expressions: string[];
  /** The latest value of each expression (by index), as a variable so it
   *  can be expanded like one. */
  results: (DebugVariable & { error?: boolean })[];
  add: (expression: string) => void;
  remove: (index: number) => void;
  /** Re-evaluate everything (called on each pause / frame change). */
  refresh: () => Promise<void>;
  loadWorkspace: (root: string | null) => void;
}

const STORAGE_PREFIX = "sable.watches:";
let workspaceRoot: string | null = null;

function persist(expressions: string[]) {
  if (!workspaceRoot) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + workspaceRoot, JSON.stringify(expressions));
  } catch {
    /* not persisted */
  }
}

async function evaluate(expression: string, frameId: number | null): Promise<DebugVariable & { error?: boolean }> {
  const response = await sendDebugRequest("evaluate", { expression, frameId: frameId ?? undefined, context: "watch" });
  if (!response?.success) {
    const message = String((response as { message?: string } | null)?.message ?? "not available");
    return { name: expression, value: message, variablesReference: 0, error: true };
  }
  const body = response.body as { result?: string; type?: string; variablesReference?: number };
  return { name: expression, value: body.result ?? "", type: body.type, variablesReference: body.variablesReference ?? 0 };
}

export const useWatchStore = create<WatchState>((set, get) => ({
  expressions: [],
  results: [],

  add: (expression) => {
    const trimmed = expression.trim();
    if (!trimmed) return;
    const expressions = [...get().expressions, trimmed];
    set({ expressions });
    persist(expressions);
    void get().refresh();
  },

  remove: (index) => {
    const expressions = get().expressions.filter((_, position) => position !== index);
    set({ expressions, results: get().results.filter((_, position) => position !== index) });
    persist(expressions);
  },

  refresh: async () => {
    const { isPaused, selectedFrameId } = useDebugStore.getState();
    const { expressions } = get();
    if (!isPaused) {
      set({ results: [] });
      return;
    }
    const results = await Promise.all(expressions.map((expression) => evaluate(expression, selectedFrameId)));
    // Still the same pause and list?
    if (useDebugStore.getState().selectedFrameId === selectedFrameId && get().expressions === expressions) {
      set({ results });
    }
  },

  loadWorkspace: (root) => {
    workspaceRoot = root;
    let expressions: string[] = [];
    try {
      expressions = root ? (JSON.parse(localStorage.getItem(STORAGE_PREFIX + root) ?? "[]") as string[]) : [];
    } catch {
      expressions = [];
    }
    set({ expressions, results: [] });
  },
}));

// Each pause, step, or frame change: re-evaluate.
useDebugStore.subscribe((state, previous) => {
  if (state.isPaused !== previous.isPaused || state.selectedFrameId !== previous.selectedFrameId) {
    void useWatchStore.getState().refresh();
  }
});

// Watches are saved per workspace: follow the open folder. (Subscribed
// here rather than called from workspaceStore, which would import this
// module — and through debugStore, itself — in a cycle.)
useWatchStore.getState().loadWorkspace(useWorkspaceStore.getState().rootPath);
useWorkspaceStore.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) useWatchStore.getState().loadWorkspace(state.rootPath);
});
