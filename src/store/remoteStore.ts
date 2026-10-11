import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invoke, invokeLocal, setRemoteActive } from "../lib/backend";
import { getSetting } from "./settingsStore";
import { openUrl } from "@tauri-apps/plugin-opener";
import { killTerminal, readDirectory } from "../lib/ipc";
import { resetLanguageServers, restartLanguageServers } from "../lib/lsp/lspClient";
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
  | { kind: "container"; name: string; engine?: string; user?: string };

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

/** A remote port reachable here. */
export interface ForwardedPort {
  remotePort: number;
  localPort: number;
  /** Forwarded because it opened (not chosen by the user). */
  auto: boolean;
}

interface RemoteState {
  status: RemoteStatus;
  target: RemoteTarget | null;
  label: string | null;
  /** Progress while connecting; the reason when the connection is lost. */
  message: string | null;
  agent: AgentInfo | null;
  /** Ports listening on the remote now. */
  listening: number[];
  forwarded: ForwardedPort[];
  forwardPort: (remotePort: number, auto?: boolean) => Promise<number | null>;
  stopForwarding: (remotePort: number) => Promise<void>;
  /** Ask for a port number and forward it. */
  promptForwardPort: () => Promise<void>;
  /** Connect, then open `folder` (or ask for one). `quiet`: no error popup. */
  connect: (target: RemoteTarget, folder?: string, options?: { quiet?: boolean }) => Promise<boolean>;
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
  /** The local folder this dev container window was reopened from. */
  localFolder: string | null;
  /** Open the (local) folder inside its dev container. */
  reopenInContainer: () => Promise<void>;
  /** Back from a dev container to the folder on this computer. */
  reopenLocally: () => Promise<void>;
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
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Path rules for the remote's OS (Windows: C:\\Users\\me). */
function pathsFor(os: string) {
  const windows = os === "windows";
  const separator = windows ? "\\" : "/";
  const isRoot = (path: string) => (windows ? /^[A-Za-z]:\\?$/.test(path) : path === "/");
  const isAbsolute = (path: string) => (windows ? /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path) : path.startsWith("/"));
  const trim = (path: string) => {
    if (isRoot(path)) return windows ? `${path.slice(0, 2)}\\` : "/";
    return path.replace(/[\\/]+$/, "") || "/";
  };
  return {
    separator,
    isRoot,
    isAbsolute,
    join: (dir: string, name: string) => trim(`${dir.replace(/[\\/]+$/, "")}${separator}${name}`),
    parent: (path: string) => {
      if (isRoot(path)) return path;
      const cut = path.replace(/[\\/][^\\/]*[\\/]?$/, "");
      return trim(windows && /^[A-Za-z]:$/.test(cut) ? `${cut}\\` : cut || "/");
    },
    trim,
  };
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

/** Ports listening when the connection started (not auto-forwarded). */
let baseline: Set<number> | null = null;
/** Ports the user stopped forwarding: not forwarded again by themselves. */
const ignoredPorts = new Set<number>();
/** Never auto-forwarded: SSH, and ports below 1024 (system services). */
const neverAuto = (port: number) => port < 1024;


export const useRemoteStore = create<RemoteState>((set, get) => ({
  status: "local",
  target: null,
  label: null,
  message: null,
  agent: null,
  listening: [],
  forwarded: [],
  localFolder: null,

  reopenInContainer: async () => {
    const ui = useUiStore.getState();
    const folder = useWorkspaceStore.getState().rootPath;
    if (!folder || get().status !== "local") {
      ui.setLastError("Open a folder on this computer first (one with .devcontainer/devcontainer.json)");
      return;
    }
    if (!(await invokeLocal<boolean>("devcontainer_exists", { folder }))) {
      ui.setLastError("This folder has no .devcontainer/devcontainer.json");
      return;
    }
    set({ status: "connecting", label: "Dev Container", message: "Starting the dev container…" });
    let started: { name: string; engine: string; user?: string | null; workspaceFolder: string; postCreateCommand?: string | null };
    try {
      started = await invokeLocal("devcontainer_up", { folder });
    } catch (error) {
      set({ status: "local", label: null, message: null });
      ui.setLastError(String(error));
      return;
    }
    const target: RemoteTarget = { kind: "container", name: started.name, engine: started.engine, user: started.user ?? undefined };
    if (await get().connect(target, started.workspaceFolder)) {
      set({ localFolder: folder });
      if (started.postCreateCommand) {
        // First start: the config's setup command, where it can be watched.
        ui.setTerminalVisible(true);
        useTerminalStore.getState().enqueueCommand(started.postCreateCommand);
      }
    }
  },

  reopenLocally: async () => {
    const folder = get().localFolder;
    await get().close();
    set({ localFolder: null });
    if (folder) await useWorkspaceStore.getState().openWorkspace(folder);
  },

  forwardPort: async (remotePort, auto = false) => {
    try {
      const localPort = await invokeLocal<number>("remote_forward_port", { remotePort, localPort: null });
      set((state) => ({
        forwarded: [...state.forwarded.filter((port) => port.remotePort !== remotePort), { remotePort, localPort, auto }].sort(
          (a, b) => a.remotePort - b.remotePort,
        ),
      }));
      return localPort;
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
      return null;
    }
  },

  stopForwarding: async (remotePort) => {
    await invokeLocal("remote_stop_forward", { remotePort }).catch(() => {});
    ignoredPorts.add(remotePort);
    set((state) => ({ forwarded: state.forwarded.filter((port) => port.remotePort !== remotePort) }));
  },

  promptForwardPort: async () => {
    const answer = await useUiStore.getState().openPickOrText(
      get().listening.map((port) => ({ label: String(port), detail: "listening on the remote" })),
      `Forward a port from ${get().label ?? "the remote"} (type a number)`,
      "Forward port %s",
    );
    const port = Number(typeof answer === "number" ? get().listening[answer] : answer);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      if (answer !== null) useUiStore.getState().setLastError("Enter a port number (1–65535)");
      return;
    }
    ignoredPorts.delete(port);
    const local = await get().forwardPort(port);
    if (local) useUiStore.getState().showStatus(`Port ${port} is at localhost:${local}`);
  },

  connect: async (target, folder, options) => {
    const ui = useUiStore.getState();
    const before = { target: get().target, forwarded: get().forwarded };
    set({ status: "connecting", target, label: targetLabel(target), message: `Connecting to ${targetLabel(target)}…` });
    let info: RemoteInfo;
    try {
      info = await invokeLocal<RemoteInfo>("remote_connect", { target });
    } catch (error) {
      // Back to however things were (local, or the previous remote).
      const stillRemote = useWorkspaceStore.getState().rootPath !== null && get().agent !== null;
      set({ status: stillRemote ? "lost" : "local", message: stillRemote ? String(error) : null, ...(stillRemote ? {} : { target: null, label: null }) });
      if (!options?.quiet) ui.setLastError(String(error));
      return false;
    }
    await switchSides(true);
    // Forwards belong to a connection: put back the ones that were
    // forwarded before (a reconnect), start fresh for a new machine.
    const sameMachine = before.target !== null && sameTarget(before.target, target);
    const previous = sameMachine ? before.forwarded : [];
    set({ status: "connected", target, label: info.label, agent: info.agent, message: null, listening: [], forwarded: [] });
    baseline = null;
    if (!sameMachine) ignoredPorts.clear();
    for (const port of previous) void get().forwardPort(port.remotePort, port.auto);
    void invoke("ports_watch").catch(() => {});
    if (folder && folder === useWorkspaceStore.getState().rootPath && sameMachine) {
      // A reconnect: the folder is still open — just pick up where it was.
      await useWorkspaceStore.getState().refreshDirectory(folder);
      void invoke("watch_workspace", { path: folder }).catch(() => {});
      void restartLanguageServers();
    } else if (folder) {
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
    cancelAutoReconnect();
    await switchSides(false);
    await invokeLocal("remote_disconnect").catch(() => {});
    writeJson(LAST_REMOTE_KEY, null);
    set({ status: "local", target: null, label: null, message: null, agent: null, listening: [], forwarded: [], localFolder: null });
    useWorkspaceStore.getState().closeWorkspace();
  },

  openFolder: async () => {
    const { agent } = get();
    if (!agent) return;
    const ui = useUiStore.getState();
    const paths = pathsFor(agent.os);
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
        ...(!paths.isRoot(dir) ? [{ label: "..", detail: "up a folder" }] : []),
        ...folders.map((entry) => ({ label: `${entry.name}/` })),
      ];
      const choice = await ui.openPickOrText(items, `Open a folder on ${get().label} — ${tidy(dir, agent.home)}`, "Go to %s");
      if (choice === null) return;
      if (typeof choice === "string") {
        // A typed path: absolute, ~/…, or relative to here.
        dir = paths.isAbsolute(choice)
          ? paths.trim(choice)
          : choice.startsWith("~")
            ? paths.join(agent.home, choice.slice(1).replace(/^[\\/]/, ""))
            : paths.join(dir, choice);
        continue;
      }
      if (choice === 0) {
        const { target } = get();
        await useWorkspaceStore.getState().openWorkspace(dir);
        if (target && useWorkspaceStore.getState().rootPath === dir) remember(target, dir);
        return;
      }
      const item = items[choice];
      dir = item.label === ".." ? paths.parent(dir) : paths.join(dir, item.label.replace(/\/$/, ""));
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

/**
 * After a dropped connection (a network blip, a laptop waking up), try to
 * reconnect by itself a few times before leaving it to the Reconnect
 * button.
 */
const RECONNECT_DELAYS_MS = [1500, 5000, 15000];
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function cancelAutoReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function autoReconnect(attempt = 0) {
  cancelAutoReconnect();
  if (attempt >= RECONNECT_DELAYS_MS.length) return;
  reconnectTimer = setTimeout(async () => {
    const store = useRemoteStore.getState();
    if (store.status !== "lost" || !store.target) return;
    const folder = useWorkspaceStore.getState().rootPath ?? undefined;
    if (await store.connect(store.target, folder, { quiet: true })) {
      useUiStore.getState().showStatus(`Reconnected to ${targetLabel(store.target)}`);
    } else {
      autoReconnect(attempt + 1);
    }
  }, RECONNECT_DELAYS_MS[attempt]);
}

// Connection progress and loss, from the backend.
void listen<{ state: string; label: string; message?: string | null }>("remote:status", ({ payload }) => {
  const store = useRemoteStore.getState();
  if (payload.state === "connecting" && store.status === "connecting") {
    useRemoteStore.setState({ message: payload.message ?? null });
  } else if (payload.state === "disconnected" && store.status === "connected") {
    // Keep the workspace (and routing) so Reconnect can pick up where it was.
    useRemoteStore.setState({ status: "lost", message: payload.message ?? null });
    useUiStore.getState().showStatus(`Lost the connection to ${payload.label} — reconnecting…`);
    autoReconnect();
  }
}).catch(() => {});

// Ports opening and closing on the remote. A port that opens while
// connected (a dev server starting) is forwarded automatically.
void listen<{ port: number }[]>("ports:changed", ({ payload }) => {
  const store = useRemoteStore.getState();
  if (store.status !== "connected") return;
  const ports = payload.map((entry) => entry.port);
  useRemoteStore.setState({ listening: ports });
  if (!baseline) {
    baseline = new Set(ports);
    return;
  }
  if (!getSetting("remote.autoForwardPorts")) return;
  for (const port of ports) {
    const known = baseline.has(port) || ignoredPorts.has(port) || neverAuto(port) || store.forwarded.some((entry) => entry.remotePort === port);
    if (known) continue;
    baseline.add(port);
    void store.forwardPort(port, true).then((local) => {
      if (local) useUiStore.getState().showStatus(`Port ${port} on ${store.label} is forwarded to localhost:${local} — see Ports`);
    });
  }
}).catch(() => {});

/** Open a forwarded port in the browser. */
export function openForwardedPort(port: ForwardedPort): void {
  void openUrl(`http://localhost:${port.localPort}`).catch((error) => useUiStore.getState().setLastError(String(error)));
}
