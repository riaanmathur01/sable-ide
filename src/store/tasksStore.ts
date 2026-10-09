import { create } from "zustand";
import { readFile } from "../lib/ipc";
import { discoverTasks, TASK_FILES, type Task } from "../lib/tasks/discover";
import { loginShellArgs } from "../lib/shell";
import { useTerminalStore } from "./terminalStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * The project's tasks (scripts, make targets, …) — the Explorer's Tasks
 * section and "Run Task" in the command palette. Each runs in its own
 * terminal tab; running it again reuses that tab.
 */
interface TasksState {
  tasks: Task[];
  /** Re-read the build files (on open, and when they change on disk). */
  load: () => Promise<void>;
  run: (task: Task) => void;
}

export const useTasksStore = create<TasksState>((set) => ({
  tasks: [],

  load: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) {
      set({ tasks: [] });
      return;
    }
    const separator = root.includes("\\") ? "\\" : "/";
    const contents = await Promise.all(
      TASK_FILES.map(async (name) => [name, await readFile(`${root}${separator}${name}`).catch(() => null)] as const),
    );
    if (useWorkspaceStore.getState().rootPath !== root) return;
    set({ tasks: discoverTasks(Object.fromEntries(contents)) });
  },

  run: (task) => {
    const root = useWorkspaceStore.getState().rootPath;
    void useTerminalStore
      .getState()
      .startCommandSession({ args: loginShellArgs(task.command), cwd: root, env: null }, task.label, `task:${task.id}`)
      .catch((error) => useUiStore.getState().setLastError(String(error)));
  },
}));

// A different folder: its tasks.
void useTasksStore.getState().load();
useWorkspaceStore.subscribe((state, previous) => {
  if (state.rootPath !== previous.rootPath) void useTasksStore.getState().load();
});
