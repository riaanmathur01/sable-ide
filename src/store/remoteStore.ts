import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invokeLocal, setRemoteActive } from "../lib/backend";
import { killTerminal, readDirectory } from "../lib/ipc";
import { resetLanguageServers } from "../lib/lsp/lspClient";
import { useTerminalStore } from "./terminalStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Remote development: the window's workspace on an SSH host, in WSL or in
 * a container (src-tauri/src/remote.rs runs Sable's agent there). While
 * connected, lib/backend.ts sends workspace commands to the agent.
 */

export type RemoteTarget =
  | { kind: "ssh"; host: string }
  | { kind: "wsl"; distro: string }
  | { kind: "container"; name: string; engine?: string };

export interface AgentInfo {
  version: string;
  os: string;
  arch: string;
  home: string;
  hostname: string;
  tmp: string;
}

interface RemoteInfo {
  target: RemoteTarget;
  label: string;
  agent: AgentInfo;
}

interface Targets {
  ssh: { name: string; hostname?: string | null; user?: string | null }[];
  wsl: string[];
  containers: { name: string; image: string; engine: string }[];
}

/** A remote folder opened before, for the Recent list. */
interface RecentRemote {
  target: RemoteTarget;
  folder: string;
}

export type RemoteStatus = "local" | "connecting" | "connected" | "lost";

interface RemoteState {
  status: RemoteStatus;
  target: RemoteTarget | null;
  label: string | null;
  /** Progress while connecting; the reason when the connection is lost. */
  message: string | null;
  agent: AgentInfo | null;
  /** Connect, then open `folder` (or ask for one). */
  connect: (target: RemoteTarget, folder?: string) => Promise<boolean>;
  reconnect: () => Promise<void>;
  /** Close the connection and the remote folder; back to local. */
  close: () => Promise<void>;
  /** Choose a folder on the remote and open it. */
  openFolder: () => Promise<void>;
  /** The remote menu (status bar button). */
  showMenu: () => Promise<void>;
  pickSshHost: () => Promise<void>;
  pickWsl: () => Promise<void>;
  pickContainer: () => Promise<void>;
}

const LAST_REMOTE_KEY = "sable.lastRemote";
const RECENT_REMOTES_KEY = "sable.recentRemotes";
const MAX_RECENT = 8;

export function targetLabel(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `SSH: ${target.host}`;
    case "wsl":
      return `WSL: ${target.distro}`;
    case "container":
      return `Container: ${target.name}`;
  }
}

const sameTarget = (a: RemoteTarget, b: RemoteTarget) => targetLabel(a) === targetLabel(b);

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: nothing to remember.
  }
}

/** The remote folder open at last exit (to reconnect to on launch). */
export function lastRemote(): RecentRemote | null {
  return readJson<RecentRemote | null>(LAST_REMOTE_KEY, null);
}

function recentRemotes(): RecentRemote[] {
  return readJson<RecentRemote[]>(RECENT_REMOTES_KEY, []);
}

function remember(target: RemoteTarget, folder: string) {
  writeJson(LAST_REMOTE_KEY, { target, folder });
  const recent = recentRemotes().filter((entry) => !(sameTarget(entry.target, target) && entry.folder === folder));
  writeJson(RECENT_REMOTES_KEY, [{ target, folder }, ...recent].slice(0, MAX_RECENT));
}

/** `~/x` for paths in the remote home. */
function tidy(path: string, home: string | undefined): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Move the window's backend between this computer and the remote: stop
 * the language servers and shells where they run now (while commands
 * still go there), switch, and start fresh shells on the other side.
 */
async function switchSides(remote: boolean) {
  await resetLanguageServers();
  const terminals = useTerminalStore.getState();
  await Promise.all(terminals.sessions.map((session) => killTerminal(session.id).catch(() => {})));
  setRemoteActive(remote);
  await terminals.restartAll();
}

const parentOf = (path: string) => path.replace(/\/[^/]*\/?$/, "") || "/";
const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

export const useRemoteStore = create<RemoteState>((set, get) => ({
  status: "local",
  target: null,
  label: null,
  message: null,
  agent: null,

  connect: async (target, folder) => {
    const ui = useUiStore.getState();
    set({ status: "connecting", target, label: targetLabel(target), message: `Connecting to ${targetLabel(target)}…` });
    let info: RemoteInfo;
    try {
      info = await invokeLocal<RemoteInfo>("remote_connect", { target });
    } catch (error) {
      // Back to however things were (local, or the previous remote).
      const stillRemote = useWorkspaceStore.getState().rootPath !== null && get().agent !== null;
      set({ status: stillRemote ? "lost" : "local", message: null, ...(stillRemote ? {} : { target: null, label: null }) });
      ui.setLastError(String(error));
      return false;
    }
    await switchSides(true);
    set({ status: "connected", target, label: info.label, agent: info.agent, message: null });
    if (folder) {
      await useWorkspaceStore.getState().openWorkspace(folder);
      // Still there? (openWorkspace reports its own errors.)
      if (useWorkspaceStore.getState().rootPath === folder) remember(target, folder);
    } else {
      // The folder open before (local, or on another remote) isn't on
      // this machine: close it, then choose one here.
      useWorkspaceStore.getState().closeWorkspace();
      await get().openFolder();
    }
    return true;
  },

  reconnect: async () => {
    const { target } = get();
    if (!target) return;
    const folder = useWorkspaceStore.getState().rootPath ?? undefined;
    if (await get().connect(target, folder)) {
      useUiStore.getState().showStatus(`Reconnected to ${targetLabel(target)}`);
    }
  },

  close: async () => {
    await switchSides(false);
    await invokeLocal("remote_disconnect").catch(() => {});
    writeJson(LAST_REMOTE_KEY, null);
    set({ status: "local", target: null, label: null, message: null, agent: null });
    useWorkspaceStore.getState().closeWorkspace();
  },

  openFolder: async () => {
    const { agent } = get();
    if (!agent) return;
    const ui = useUiStore.getState();
    let dir = useWorkspaceStore.getState().rootPath ?? agent.home;
    for (;;) {
      const entries = await readDirectory(dir).catch((error) => {
        ui.setLastError(String(error));
        return null;
      });
      if (!entries) {
        if (dir === agent.home) return;
        dir = agent.home;
        continue;
      }
      const folders = entries.filter((entry) => entry.isDirectory);
      const items = [
        { label: `Open ${tidy(dir, agent.home)}`, detail: "this folder" },
        ...(dir !== "/" ? [{ label: "..", detail: "up a folder" }] : []),
        ...folders.map((entry) => ({ label: `${entry.name}/` })),
      ];
      const choice = await ui.openPickOrText(items, `Open a folder on ${get().label} — ${tidy(dir, agent.home)}`, "Go to %s");
      if (choice === null) return;
      if (typeof choice === "string") {
        // A typed path: absolute, ~/…, or relative to here.
        dir = choice.startsWith("/") ? choice : choice.startsWith("~") ? `${agent.home}${choice.slice(1)}` : joinPath(dir, choice);
        dir = dir.replace(/\/+$/, "") || "/";
        continue;
      }
      if (choice === 0) {
        const { target } = get();
        await useWorkspaceStore.getState().openWorkspace(dir);
        if (target && useWorkspaceStore.getState().rootPath === dir) remember(target, dir);
        return;
      }
      const item = items[choice];
      dir = item.label === ".." ? parentOf(dir) : joinPath(dir, item.label.replace(/\/$/, ""));
    }
  },

  showMenu: async () => {
    const ui = useUiStore.getState();
    const { status, label } = get();
    type Action = { label: string; detail?: string; run: () => unknown };
    const actions: Action[] = [];
    if (status === "connected") {
      actions.push({ label: "Open Folder…", detail: label ?? undefined, run: () => get().openFolder() });
    }
    if (status === "lost") actions.push({ label: "Reconnect", detail: label ?? undefined, run: () => get().reconnect() });
    actions.push(
      { label: "Connect to SSH Host…", run: () => get().pickSshHost() },
      { label: "Attach to Running Container…", run: () => get().pickContainer() },
    );
    if (navigator.userAgent.includes("Windows")) actions.push({ label: "Connect to WSL…", run: () => get().pickWsl() });
    for (const recent of recentRemotes()) {
      if (status === "connected" && get().target && sameTarget(recent.target, get().target!) && recent.folder === useWorkspaceStore.getState().rootPath) continue;
      actions.push({
        label: `${targetLabel(recent.target)}  ${recent.folder}`,
        detail: "recent",
        run: () => get().connect(recent.target, recent.folder),
      });
    }
    if (status !== "local") actions.push({ label: "Close Remote Connection", detail: "back to this computer", run: () => get().close() });
    const choice = await ui.openPick(
      actions.map(({ label, detail }) => ({ label, detail })),
      status === "local" ? "Open a remote folder" : `${label}`,
    );
    if (choice !== null) await actions[choice].run();
  },

  pickSshHost: async () => {
    const ui = useUiStore.getState();
    const targets = await invokeLocal<Targets>("remote_targets").catch(() => null);
    const hosts = targets?.ssh ?? [];
    const choice = await ui.openPickOrText(
      hosts.map((host) => ({
        label: host.name,
        detail: [host.user, host.hostname].filter(Boolean).join("@") || undefined,
      })),
      hosts.length ? "Choose a host from ~/.ssh/config, or type user@host" : "Type user@host (or a host from ~/.ssh/config)",
      "Connect to %s",
    );
    if (choice === null) return;
    const host = typeof choice === "string" ? choice : hosts[choice].name;
    await get().connect({ kind: "ssh", host });
  },

  pickWsl: async () => {
    const ui = useUiStore.getState();
    const targets = await invokeLocal<Targets>("remote_targets").catch(() => null);
    const distros = targets?.wsl ?? [];
    if (distros.length === 0) {
      ui.setLastError("No WSL distributions found. Install one with `wsl --install` in PowerShell.");
      return;
    }
    const choice = await ui.openPick(distros.map((distro) => ({ label: distro })), "Choose a WSL distribution");
    if (choice !== null) await get().connect({ kind: "wsl", distro: distros[choice] });
  },

  pickContainer: async () => {
    const ui = useUiStore.getState();
    const targets = await invokeLocal<Targets>("remote_targets").catch(() => null);
    const containers = targets?.containers ?? [];
    if (containers.length === 0) {
      ui.setLastError("No running containers found (Sable looks with docker and podman).");
      return;
    }
    const choice = await ui.openPick(
      containers.map((container) => ({ label: container.name, detail: `${container.image} · ${container.engine}` })),
      "Attach to a running container",
    );
    if (choice === null) return;
    const container = containers[choice];
    await get().connect({ kind: "container", name: container.name, engine: container.engine });
  },
}));

// Connection progress and loss, from the backend.
void listen<{ state: string; label: string; message?: string | null }>("remote:status", ({ payload }) => {
  const store = useRemoteStore.getState();
  if (payload.state === "connecting" && store.status === "connecting") {
    useRemoteStore.setState({ message: payload.message ?? null });
  } else if (payload.state === "disconnected" && store.status === "connected") {
    // Keep the workspace (and routing) so Reconnect can pick up where it was.
    useRemoteStore.setState({ status: "lost", message: payload.message ?? null });
    useUiStore.getState().setLastError(`${payload.label}: ${payload.message ?? "the connection was lost"}`);
  }
}).catch(() => {});
