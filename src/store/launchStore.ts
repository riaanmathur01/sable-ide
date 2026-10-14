import { create } from "zustand";
import { readFile } from "../lib/ipc";
import { listen } from "../lib/events";
import { parseJsonc } from "../lib/jsonc";
import { onPluginEvent } from "../lib/plugins/events";
import {
  launchEntries,
  parseLaunchJson,
  parseTasksJson,
  parseTasksObject,
  parseWorkspaceLaunch,
  type LaunchEntry,
  type LaunchSource,
  type TasksFile,
} from "../lib/debug/launchJson";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The workspace's launch.json configurations (every folder's
 * .vscode/launch.json, and a .code-workspace file's `launch`), its
 * tasks.json tasks and .vscode/settings.json values, the configuration
 * selected in the Run and Debug view (remembered per workspace), and the
 * debug sessions started from them. Starting lives in
 * lib/debug/launchRunner.ts.
 */

/** Sable's own configuration: debug the current file (F5's behaviour
 *  without a launch.json). */
export const AUTO_FILE_KEY = "auto:file";

/** Tasks and settings belonging to one folder (null: the workspace file). */
export interface FolderExtras {
  folder: string | null;
  tasks: TasksFile;
  settings: Record<string, unknown>;
}

/** A session started from a launch.json configuration. */
export interface LaunchSession {
  id: string;
  name: string;
  state: "running" | "paused" | "ended";
  threadId: number | null;
  reason: string | null;
  /** Run when it ends. */
  postDebugTask?: string;
  source: LaunchSource;
}

interface LaunchState {
  sources: LaunchSource[];
  extras: FolderExtras[];
  entries: LaunchEntry[];
  /** The selected entry's key, or AUTO_FILE_KEY. */
  selectedKey: string | null;
  /** What's being prepared (a preLaunchTask running…), for the view. */
  launching: string | null;
  sessions: LaunchSession[];
  /** The session the debug view and controls show. */
  focusedSession: string | null;
  /** The compound running, if any. */
  compound: { name: string; stopAll: boolean } | null;
  load: () => Promise<void>;
  select: (key: string) => void;
  /** The entry F5 starts: the selection, else the first configuration. */
  selectedEntry: () => LaunchEntry | null;
  setLaunching: (text: string | null) => void;
  updateSession: (id: string, change: Partial<LaunchSession>) => void;
}

const separatorOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");
export const joinPath = (folder: string, ...parts: string[]) => [folder.replace(/[/\\]+$/, ""), ...parts].join(separatorOf(folder));

const selectionKey = () => {
  const { workspaceFile, rootPath } = useWorkspaceStore.getState();
  const workspace = workspaceFile ?? rootPath;
  return workspace ? `sable.launchSelection:${workspace}` : null;
};

function savedSelection(): string | null {
  const key = selectionKey();
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path).catch(() => null);
}

function parseSettings(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = parseJsonc(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Problems already reported (so a reload doesn't repeat them). */
let reportedErrors = "";
/** Reported once launchRunner is loaded (it owns the debug console). */
export const launchHooks: { reportProblems?: (problems: string[]) => void } = {};

export const useLaunchStore = create<LaunchState>((set, get) => ({
  sources: [],
  extras: [],
  entries: [],
  selectedKey: null,
  launching: null,
  sessions: [],
  focusedSession: null,
  compound: null,

  load: async () => {
    const { folders, workspaceFile } = useWorkspaceStore.getState();
    const perFolder = await Promise.all(
      folders.map(async (folder) => {
        const name = folder.split(/[/\\]/).filter(Boolean).pop() ?? folder;
        const [launch, tasks, settings] = await Promise.all(
          ["launch.json", "tasks.json", "settings.json"].map((file) => readOptional(joinPath(folder, ".vscode", file))),
        );
        return {
          source: launch === null ? null : ({ folder, path: joinPath(folder, ".vscode", "launch.json"), file: parseLaunchJson(launch, `${name}/.vscode/launch.json`) } satisfies LaunchSource),
          extras: { folder, tasks: parseTasksJson(tasks ?? "", `${name}/.vscode/tasks.json`), settings: parseSettings(settings) } satisfies FolderExtras,
        };
      }),
    );
    const sources: LaunchSource[] = perFolder.flatMap((item) => (item.source ? [item.source] : []));
    const extras: FolderExtras[] = perFolder.map((item) => item.extras);
    if (workspaceFile) {
      const text = await readOptional(workspaceFile);
      if (text !== null) {
        const file = parseWorkspaceLaunch(text, workspaceFile.split(/[/\\]/).pop());
        if (file.configurations.length || file.compounds.length || file.errors.length) sources.push({ folder: null, path: workspaceFile, file });
        let raw: Record<string, unknown> = {};
        try {
          raw = (parseJsonc(text) as Record<string, unknown>) ?? {};
        } catch {
          /* reported by parseWorkspaceLaunch */
        }
        extras.push({
          folder: null,
          tasks: parseTasksObject(raw.tasks),
          settings: raw.settings && typeof raw.settings === "object" ? (raw.settings as Record<string, unknown>) : {},
        });
      }
    }
    // The workspace changed while reading: a newer load wins.
    if (useWorkspaceStore.getState().folders !== folders) return;
    const entries = launchEntries(sources, folders.length > 1);
    const saved = savedSelection();
    const current = get().selectedKey ?? saved;
    // Nothing chosen yet (or the choice is gone): the first configuration.
    const selectedKey =
      current && (current === AUTO_FILE_KEY || entries.some((entry) => entry.key === current)) ? current : (entries[0]?.key ?? null);
    set({ sources, extras, entries, selectedKey });
    const problems = [...sources.flatMap((source) => source.file.errors), ...extras.flatMap((extra) => extra.tasks.errors)];
    const signature = problems.join("\n");
    if (signature !== reportedErrors) {
      reportedErrors = signature;
      if (problems.length) launchHooks.reportProblems?.(problems);
    }
  },

  select: (key) => {
    set({ selectedKey: key });
    const storage = selectionKey();
    if (!storage) return;
    try {
      localStorage.setItem(storage, key);
    } catch {
      /* not remembered */
    }
  },

  selectedEntry: () => {
    const { entries, selectedKey } = get();
    if (selectedKey === AUTO_FILE_KEY) return null;
    return entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;
  },

  setLaunching: (text) => set({ launching: text }),

  updateSession: (id, change) =>
    set((state) => ({ sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...change } : session)) })),
}));

// --- Keeping it current ---------------------------------------------------------

const LAUNCH_FILES = /[/\\]\.vscode[/\\](launch|tasks|settings)\.json$/;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleLaunchReload(): void {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void useLaunchStore.getState().load(), 150);
}

let watching = false;
/** Re-read on save, on disk changes, and when the folders change. */
export function watchLaunchFiles(): void {
  if (watching) return;
  watching = true;
  void useLaunchStore.getState().load();
  onPluginEvent((name, payload) => {
    if (name !== "didSave" || !payload.path) return;
    if (LAUNCH_FILES.test(payload.path) || payload.path === useWorkspaceStore.getState().workspaceFile) scheduleLaunchReload();
  });
  void listen<string[]>("fs:changed", (event) => {
    const { folders } = useWorkspaceStore.getState();
    if (event.payload.some((dir) => /[/\\]\.vscode$/.test(dir) || folders.includes(dir))) scheduleLaunchReload();
  });
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.folders !== previous.folders || state.workspaceFile !== previous.workspaceFile) {
      if (state.rootPath !== previous.rootPath || state.workspaceFile !== previous.workspaceFile) {
        useLaunchStore.setState({ selectedKey: null });
      }
      scheduleLaunchReload();
    }
  });
}
