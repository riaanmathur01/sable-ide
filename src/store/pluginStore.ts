import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { createDirectory, pathExists, writeFile } from "../lib/ipc";
import { PluginRuntime, type PluginCommand, type PluginStatusItem } from "../lib/plugins/host";
import { onPluginEvent } from "../lib/plugins/events";
import { scaffoldFiles } from "../lib/plugins/scaffold";
import {
  PERMISSION_DESCRIPTIONS,
  type InspectedPlugin,
  type PluginInfo,
  type PluginLogLine,
  type PluginPermission,
  type PluginState,
} from "../lib/plugins/types";
import { useUiStore } from "./uiStore";
import { useTabsStore } from "./tabsStore";

/**
 * Installed plugins and their running state. Rust keeps the plugins and
 * the registry (src-tauri/src/plugins.rs); each enabled plugin runs in a
 * PluginRuntime (lib/plugins/host.ts).
 */

const MAX_LOG_LINES = 300;

interface PluginState_ {
  plugins: PluginInfo[];
  states: Record<string, PluginState>;
  errors: Record<string, string>;
  logs: Record<string, PluginLogLine[]>;
  /** Every running plugin's palette commands. */
  commands: { pluginId: string; pluginName: string; command: PluginCommand }[];
  statusItems: Record<string, PluginStatusItem>;
  busy: boolean;
  /** The Create Plugin dialog. */
  createDialogOpen: boolean;
  setCreateDialogOpen: (open: boolean) => void;

  /** Read the installed plugins and start the enabled ones (at launch). */
  load: () => Promise<void>;
  /** Inspect, ask, install. `link`: run it from its folder (development). */
  installFromFolder: (path: string, link?: boolean) => Promise<boolean>;
  installFromUrl: (url: string) => Promise<boolean>;
  update: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reload: (id: string) => Promise<void>;
  reloadAll: () => Promise<void>;
  runCommand: (pluginId: string, handler: number) => void;
  /** Scaffold a plugin in `parent/<id>`, link it, open its main.js. */
  createPlugin: (options: { name: string; id: string; parent: string; permissions: PluginPermission[] }) => Promise<void>;
}

const runtimes = new Map<string, PluginRuntime>();

function describePermissions(permissions: PluginPermission[]): string {
  return permissions.length
    ? permissions.map((permission) => `• ${PERMISSION_DESCRIPTIONS[permission] ?? permission}`).join("\n")
    : "• Nothing beyond adding commands and status messages";
}

export const usePluginStore = create<PluginState_>((set, get) => {
  function report(error: unknown) {
    useUiStore.getState().setLastError(String(error instanceof Error ? error.message : error));
  }

  function collectCommands() {
    set({
      commands: [...runtimes.values()].flatMap((runtime) =>
        [...runtime.commands.values()].map((command) => ({
          pluginId: runtime.id,
          pluginName: runtime.info.manifest.name,
          command,
        })),
      ),
    });
  }

  async function startPlugin(info: PluginInfo) {
    await stopPlugin(info.manifest.id);
    const id = info.manifest.id;
    set((state) => ({ errors: { ...state.errors, [id]: "" }, logs: { ...state.logs, [id]: [] } }));
    const runtime = new PluginRuntime(info, {
      state: (pluginState, error) =>
        set((state) => ({
          states: { ...state.states, [id]: pluginState },
          errors: error ? { ...state.errors, [id]: error } : state.errors,
        })),
      log: (line) =>
        set((state) => {
          const lines = [...(state.logs[id] ?? []), line];
          return { logs: { ...state.logs, [id]: lines.slice(-MAX_LOG_LINES) } };
        }),
      commandsChanged: collectCommands,
      statusChanged: (item) =>
        set((state) => {
          const statusItems = { ...state.statusItems };
          if (item) statusItems[id] = item;
          else delete statusItems[id];
          return { statusItems };
        }),
    });
    runtimes.set(id, runtime);
    try {
      await runtime.start();
    } catch {
      // The runtime recorded the error (shown in the Plugins view).
      runtimes.delete(id);
    }
  }

  async function stopPlugin(id: string) {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtimes.delete(id);
    await runtime.stop();
    collectCommands();
  }

  async function refreshList(): Promise<PluginInfo[]> {
    const plugins = await invoke<PluginInfo[]>("plugin_list");
    set({ plugins });
    return plugins;
  }

  /** Show what a plugin asks for; install it if the user agrees. */
  async function confirmAndInstall(inspected: InspectedPlugin, link: boolean, source: string | null): Promise<boolean> {
    const { manifest, installedVersion } = inspected;
    const verb = installedVersion ? (installedVersion === manifest.version ? "Reinstall" : `Update (from ${installedVersion}) to`) : "Install";
    const agreed = await confirmNative(
      `${verb} ${manifest.name} ${manifest.version}${manifest.author ? ` by ${manifest.author}` : ""}?\n\n` +
        `${manifest.description ? `${manifest.description}\n\n` : ""}It will be able to:\n${describePermissions(manifest.permissions)}` +
        `\n\nOnly install plugins you trust.`,
      { title: link ? "Load Plugin for Development" : "Install Plugin", kind: "warning" },
    );
    if (!agreed) {
      await invoke("plugin_discard", { path: inspected.path }).catch(() => {});
      return false;
    }
    const info = await invoke<PluginInfo>("plugin_install", { path: inspected.path, link, source });
    await refreshList();
    if (info.enabled) await startPlugin(info);
    useUiStore.getState().showStatus(`${manifest.name} ${installedVersion ? "updated" : "installed"}`);
    return true;
  }

  async function guarded<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    set({ busy: true });
    try {
      return await work();
    } catch (error) {
      report(error);
      return fallback;
    } finally {
      set({ busy: false });
    }
  }

  // Linked plugins reload when one of their files is saved in Sable.
  onPluginEvent((name, { path }) => {
    if (name !== "didSave") return;
    for (const plugin of get().plugins) {
      const inside = path.startsWith(`${plugin.path}/`) || path.startsWith(`${plugin.path}\\`);
      if (plugin.linked && plugin.enabled && inside) {
        void get().reload(plugin.manifest.id).then(() => {
          const error = get().errors[plugin.manifest.id];
          useUiStore.getState().showStatus(error ? `${plugin.manifest.name} failed to load — see Plugins` : `${plugin.manifest.name} reloaded`);
        });
      }
    }
  });

  return {
    plugins: [],
    states: {},
    errors: {},
    logs: {},
    commands: [],
    statusItems: {},
    busy: false,
    createDialogOpen: false,
    setCreateDialogOpen: (open) => set({ createDialogOpen: open }),

    load: async () => {
      try {
        const plugins = await refreshList();
        await Promise.all(plugins.filter((plugin) => plugin.enabled).map(startPlugin));
      } catch (error) {
        report(error);
      }
    },

    installFromFolder: (path, link = false) =>
      guarded(async () => {
        const inspected = await invoke<InspectedPlugin>("plugin_inspect", { source: { kind: "folder", path } });
        return confirmAndInstall(inspected, link, null);
      }, false),

    installFromUrl: (url) =>
      guarded(async () => {
        const trimmed = url.trim();
        useUiStore.getState().showStatus("Downloading plugin…");
        const inspected = await invoke<InspectedPlugin>("plugin_inspect", { source: { kind: "url", url: trimmed } });
        return confirmAndInstall(inspected, false, trimmed);
      }, false),

    update: async (id) => {
      const plugin = get().plugins.find((candidate) => candidate.manifest.id === id);
      if (!plugin?.source) return;
      await get().installFromUrl(plugin.source);
    },

    uninstall: async (id) => {
      const plugin = get().plugins.find((candidate) => candidate.manifest.id === id);
      if (!plugin) return;
      const agreed = await confirmNative(
        plugin.linked
          ? `Remove ${plugin.manifest.name} from Sable? Its folder (${plugin.path}) is left as it is.`
          : `Uninstall ${plugin.manifest.name}?`,
        { title: "Uninstall Plugin", kind: "warning" },
      );
      if (!agreed) return;
      await guarded(async () => {
        await stopPlugin(id);
        await invoke("plugin_uninstall", { id });
        await refreshList();
        set((state) => {
          const { [id]: _state, ...states } = state.states;
          const { [id]: _logs, ...logs } = state.logs;
          return { states, logs };
        });
      }, undefined);
    },

    setEnabled: (id, enabled) =>
      guarded(async () => {
        await invoke("plugin_set_enabled", { id, enabled });
        const plugins = await refreshList();
        const info = plugins.find((plugin) => plugin.manifest.id === id);
        if (enabled && info) await startPlugin(info);
        if (!enabled) await stopPlugin(id);
      }, undefined),

    reload: async (id) => {
      try {
        const plugins = await refreshList();
        const info = plugins.find((plugin) => plugin.manifest.id === id);
        if (info?.enabled) await startPlugin(info);
      } catch (error) {
        report(error);
      }
    },

    reloadAll: async () => {
      for (const id of [...runtimes.keys()]) await stopPlugin(id);
      await get().load();
      useUiStore.getState().showStatus("Plugins reloaded");
    },

    runCommand: (pluginId, handler) => {
      void runtimes.get(pluginId)?.runCommand(handler);
    },

    createPlugin: ({ name, id, parent, permissions }) =>
      guarded(async () => {
        const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
        const folder = `${parent.replace(/[/\\]+$/, "")}${separator}${id}`;
        if (await pathExists(folder)) throw new Error(`${folder} already exists — choose another name or location`);
        await createDirectory(parent).catch(() => {});
        await createDirectory(folder);
        const sableVersion = await getVersion().catch(() => "");
        const files = scaffoldFiles({ id, name, author: "", permissions, sableVersion });
        for (const [file, contents] of Object.entries(files)) {
          await writeFile(`${folder}${separator}${file}`, contents);
        }
        // Linked: runs from the folder, reloads on save. Created by the
        // user just now, so no permission prompt.
        const info = await invoke<PluginInfo>("plugin_install", { path: folder, link: true, source: null });
        await refreshList();
        await startPlugin(info);
        set({ createDialogOpen: false });
        await useTabsStore.getState().openFile(`${folder}${separator}main.js`);
        useUiStore
          .getState()
          .showStatus(`${name} created in ${folder} — edit main.js; it reloads when you save. Try "${name}: Say Hello" in ⇧⌘P`);
      }, undefined),
  };
});
