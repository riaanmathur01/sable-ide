/** Plugin shapes shared by the host, the store and the UI. */

export type PluginPermission = "editor" | "workspace:read" | "workspace:write" | "shell" | "network";

/** What each permission lets a plugin do (shown before installing). */
export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  editor: "Read and change the open file; add formatters, completions and problems",
  "workspace:read": "Read files in the open folder",
  "workspace:write": "Create and change files in the open folder",
  shell: "Run commands on your computer (in the open folder)",
  network: "Connect to the internet",
};

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  main: string;
  permissions: PluginPermission[];
  minSableVersion?: string;
  homepage?: string;
}

export interface PluginInfo {
  manifest: PluginManifest;
  /** The plugin's folder. */
  path: string;
  /** Runs from its own folder (being developed): reloads when saved. */
  linked: boolean;
  enabled: boolean;
  /** The URL it was installed from (for Update). */
  source: string | null;
}

export interface InspectedPlugin {
  manifest: PluginManifest;
  path: string;
  installedVersion: string | null;
}

export type PluginState = "starting" | "running" | "stopped" | "error";

export interface PluginLogLine {
  level: "log" | "warn" | "error";
  text: string;
  time: number;
}

// --- Worker protocol ------------------------------------------------------------

/** Host → worker. */
export type HostMessage =
  | { type: "init"; source: string; manifest: PluginManifest; root: string | null; sableVersion: string }
  | { type: "reply"; id: number; value?: unknown; error?: string }
  | { type: "invoke"; id: number; handler: number; args: unknown[] }
  | { type: "root"; root: string | null }
  | { type: "deactivate" };

/** Worker → host. */
export type WorkerMessage =
  | { type: "call"; id: number; method: string; args: unknown[] }
  | { type: "return"; id: number; value?: unknown; error?: string }
  | { type: "activated" }
  | { type: "deactivated" }
  | { type: "failed"; error: string }
  | { type: "log"; level: PluginLogLine["level"]; text: string };
