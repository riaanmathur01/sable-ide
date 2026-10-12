import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invokeLocal } from "./backend";
import type { RemoteTarget } from "../store/remoteStore";

/**
 * Sable's windows. Each window has its own workspace (its folders, tabs,
 * terminals, language servers and remote connection); the backend keeps
 * them apart by window label (src-tauri/src/windows.rs).
 *
 * The first window is "main". Every window records what it has open, so
 * the next launch reopens every window that was open at quit. Closing a
 * window while others stay open forgets it, as in VS Code.
 */

export const windowLabel: string = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
})();

export const isMainWindow = windowLabel === "main";

/** What a window has open. */
export interface WindowState {
  folders: string[];
  workspaceFile?: string | null;
  /** A remote window: where to reconnect. */
  remote?: { target: RemoteTarget; folder: string } | null;
}

const WINDOWS_KEY = "sable.windows";

function readAll(): Record<string, WindowState> {
  try {
    return JSON.parse(localStorage.getItem(WINDOWS_KEY) ?? "{}") as Record<string, WindowState>;
  } catch {
    return {};
  }
}

function writeAll(states: Record<string, WindowState>) {
  try {
    localStorage.setItem(WINDOWS_KEY, JSON.stringify(states));
  } catch {
    // Storage unavailable: windows aren't restored.
  }
}

/** Record what this window has open (null: nothing). */
export function saveWindowState(state: WindowState | null): void {
  const states = readAll();
  if (state && (state.folders.length || state.remote)) states[windowLabel] = state;
  else delete states[windowLabel];
  writeAll(states);
}

/** The other windows open at last quit (for the main window to reopen). */
export function takeOtherWindowStates(): WindowState[] {
  const states = readAll();
  const others = Object.entries(states)
    .filter(([label]) => label !== "main")
    .map(([, state]) => state);
  writeAll(states.main ? { main: states.main } : {});
  return others;
}

/** What the main window had open at last quit (folders, if several). */
export function mainWindowState(): WindowState | null {
  return readAll().main ?? null;
}

/** Hand a window its state to open (by query string; see `launchQuery`). */
const PENDING_KEY = "sable.pendingWindow:";

/** Open a new window, optionally with something to open in it. */
export async function openNewWindow(state?: WindowState): Promise<void> {
  let query = "";
  if (state && (state.folders.length || state.remote)) {
    const token = Math.random().toString(36).slice(2);
    try {
      localStorage.setItem(PENDING_KEY + token, JSON.stringify(state));
    } catch {
      // Storage unavailable: just the first folder, in the URL.
      query = state.folders[0] ? `folder=${encodeURIComponent(state.folders[0])}` : "";
    }
    query ||= `open=${token}`;
  }
  await invokeLocal<string>("new_window", { query: query || null });
}

/** What this window was opened to show, if it's not the main window at
 *  launch: "empty" for a new empty window. */
export function launchState(): WindowState | "empty" | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("open");
  if (token) {
    try {
      const raw = localStorage.getItem(PENDING_KEY + token);
      localStorage.removeItem(PENDING_KEY + token);
      if (raw) return JSON.parse(raw) as WindowState;
    } catch {
      // Fall through.
    }
  }
  const folder = params.get("folder");
  if (folder) return { folders: [folder] };
  return isMainWindow ? null : "empty";
}

/** Forget this window if it's closed while others stay open. */
export function forgetWindowWhenClosed(): void {
  try {
    void getCurrentWebviewWindow().onCloseRequested(async () => {
      const labels = await invokeLocal<string[]>("window_labels").catch(() => [windowLabel]);
      if (labels.length > 1) saveWindowState(null);
    });
  } catch {
    // Not in a Tauri window.
  }
}

/** Tell every window something changed here (settings, plugins…). */
export function broadcast(event: "sable:settings-changed" | "sable:keybindings-changed" | "sable:plugins-changed", payload: Record<string, unknown> = {}): void {
  void invokeLocal("broadcast", { event, payload: { ...payload, from: windowLabel } }).catch(() => {});
}

/** The window's title: its workspace's name, as VS Code shows it. */
export function setWindowTitle(title: string): void {
  try {
    void getCurrentWebviewWindow().setTitle(title).catch(() => {});
  } catch {
    // Not in a Tauri window.
  }
}
