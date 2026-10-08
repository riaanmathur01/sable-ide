import { create } from "zustand";
import { EMPTY_RUN_CONFIG, type RunConfig } from "../lib/runConfig";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Run configurations per file (arguments, environment, working
 * directory), kept per project across launches. `editingPath` is the
 * file whose configuration dialog is open.
 */
interface RunConfigState {
  configs: Record<string, RunConfig>;
  editingPath: string | null;
  configFor: (path: string) => RunConfig;
  save: (path: string, config: RunConfig) => void;
  edit: (path: string) => void;
  closeEditor: () => void;
  load: (root: string | null) => void;
}

const storageKey = (root: string) => `sable.runConfigs:${root}`;

export const useRunConfigStore = create<RunConfigState>((set, get) => ({
  configs: {},
  editingPath: null,
  configFor: (path) => get().configs[path] ?? EMPTY_RUN_CONFIG,
  save: (path, config) => {
    const configs = { ...get().configs, [path]: config };
    set({ configs });
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    try {
      localStorage.setItem(storageKey(root), JSON.stringify(configs));
    } catch {
      /* storage unavailable — the configuration lasts this session */
    }
  },
  edit: (path) => set({ editingPath: path }),
  closeEditor: () => set({ editingPath: null }),
  load: (root) => {
    try {
      set({ configs: root ? (JSON.parse(localStorage.getItem(storageKey(root)) ?? "{}") as Record<string, RunConfig>) : {} });
    } catch {
      set({ configs: {} });
    }
  },
}));

useRunConfigStore.getState().load(useWorkspaceStore.getState().rootPath);
useWorkspaceStore.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) useRunConfigStore.getState().load(state.rootPath);
});
