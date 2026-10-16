import { invokeLocal } from "../backend";
import { listen } from "../events";

/**
 * The backend's agent commands (src-tauri/src/acp). Every command goes to
 * this app's backend; in a remote window it forwards the workspace-side
 * ones to the remote agent itself (agents run where the code is).
 */

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors: string[];
  license?: string;
  licenseUrl?: string;
  icon?: string;
  distribution: {
    binary?: Record<string, { archive: string; cmd: string; args: string[]; sha256?: string }>;
    npx?: { package: string; args: string[] };
    uvx?: { package: string; args: string[] };
  };
  /** "sable": listed by Sable, not the ACP registry. */
  source?: string;
}

export interface RegistryResult {
  version: string;
  agents: RegistryEntry[];
  source: "network" | "cache" | "builtin";
  error: string | null;
}

export interface InstalledAgent {
  id: string;
  name: string;
  version: string;
  kind: "npx" | "binary" | "uvx" | "cli";
  program: string;
  node: boolean;
  args: string[];
  env?: Record<string, string>;
  dir: string;
  installedAt: number;
  /** SHA-256 of the downloaded archive (pinned when the registry gives none). */
  archiveSha256?: string;
}

export interface Runtimes {
  node: string | null;
  nodeVersion: string | null;
  npm: string | null;
  uvx: string | null;
  platform: string | null;
}

export interface AuthField {
  key: string;
  label: string;
  env?: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  default?: string;
  when?: [string, string[]];
  /** A dotted key in the config file Sable writes for the agent. */
  config?: string;
  /** Passed as `<arg> <value>` when the agent starts. */
  arg?: string;
  /** Passed as `<loginArg> <value>` to its sign-in. */
  loginArg?: string;
}

export interface AccountCommands {
  status?: string[];
  /** "json" (the agent's own JSON) or "exit" (exit code + a line). */
  statusFormat: string;
  login?: string[];
  /** Sign in with a one-time code (no browser needed here). */
  loginDevice?: string[];
  logout?: string[];
  /** Sign out through the agent's ACP `logout`. */
  logoutAcp: boolean;
}

export interface AuthProvider {
  id: string;
  label: string;
  description: string;
  /** "subscription" | "account" | "apiKey" | "cloud" | "local" | "custom" | "cli". */
  kind: string;
  helpUrl?: string;
  fields: AuthField[];
  env: Record<string, string>;
  account?: AccountCommands;
  /** The agent's own ACP auth methods that sign in this way. */
  acpMethods?: string[];
  /** A settings folder of Sable's own for this method (Codex's CODEX_HOME). */
  home?: { env: string; dir: string; file: string };
}

export interface AgentConfig {
  provider?: string | null;
  values: Record<string, string>;
  env: Record<string, string>;
}

export interface LaunchSpec {
  program: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  unset: string[];
}

export interface AccountStatus {
  supported: boolean;
  status?: Record<string, unknown> | null;
  code?: number | null;
  stderr?: string;
}

/** A workspace-side command (here, or on the remote). */
export function acpCall<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return invokeLocal<T>("acp_call", { cmd, args });
}

export const acpRegistry = (refresh = false) => invokeLocal<RegistryResult>("acp_registry", { refresh });
export const acpInstall = (id: string, consent = false) => invokeLocal<InstalledAgent>("acp_install", { id, consent });
/** Use the CLI the user installed (Cursor's), instead of downloading it. */
export const acpLinkLocal = (id: string) => invokeLocal<InstalledAgent>("acp_link_local", { id });
export const acpFindLocal = (id: string) => acpCall<string | null>("acp_find_local", { id });
export const acpInstalled = () => acpCall<InstalledAgent[]>("acp_installed");
export const acpUninstall = (id: string) => acpCall<null>("acp_uninstall", { id });
export const acpRuntimes = () => acpCall<Runtimes>("acp_runtimes");
export const acpProviders = (agentId: string) => invokeLocal<AuthProvider[]>("acp_providers", { agentId });
export const acpConfig = () => invokeLocal<{ agents: Record<string, AgentConfig> }>("acp_config");
export const acpSetConfig = (agentId: string, config: AgentConfig) => invokeLocal<{ agents: Record<string, AgentConfig> }>("acp_set_config", { agentId, config });
export const acpSetSecret = (agentId: string, key: string, value: string) => invokeLocal<null>("acp_set_secret", { agentId, key, value });
export const acpDeleteSecret = (agentId: string, key: string) => invokeLocal<null>("acp_delete_secret", { agentId, key });
export const acpSecretStatus = (agentId: string) => invokeLocal<Record<string, boolean>>("acp_secret_status", { agentId });
export const acpStart = (agentId: string, cwd: string | null) => invokeLocal<{ instance: number; provider: string }>("acp_start", { agentId, cwd });
export const acpSend = (instance: number, line: string) => acpCall<null>("acp_send", { instance, line });
export const acpStop = (instance: number) => acpCall<null>("acp_stop", { instance });
export const acpAccountStatus = (agentId: string) => invokeLocal<AccountStatus>("acp_account_status", { agentId });
export const acpTerminalSpec = (agentId: string, options: { action?: "login" | "login_device" | "logout"; args?: string[]; env?: Record<string, string>; provider?: string }) =>
  invokeLocal<LaunchSpec>("acp_terminal_spec", { agentId, action: options.action ?? null, args: options.args ?? null, env: options.env ?? null, provider: options.provider ?? null });
export const acpThreadsLoad = (root: string) => invokeLocal<unknown>("acp_threads_load", { root });
export const acpThreadsSave = (root: string, threads: unknown) => invokeLocal<null>("acp_threads_save", { root, threads });

export const acpTerminalCreate = (request: Record<string, unknown>) => acpCall<{ terminalId: string }>("acp_terminal_create", { request });
export const acpTerminalOutput = (terminalId: string) =>
  acpCall<{ output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null }>("acp_terminal_output", { terminalId });
export const acpTerminalWait = (terminalId: string) => acpCall<{ exitCode: number | null; signal: string | null }>("acp_terminal_wait", { terminalId });
export const acpTerminalKill = (terminalId: string) => acpCall<null>("acp_terminal_kill", { terminalId });
export const acpTerminalRelease = (terminalId: string) => acpCall<null>("acp_terminal_release", { terminalId });

// --- Events -----------------------------------------------------------------------------------

type Listener<T> = (payload: T) => void;
const routes = new Map<string, Set<Listener<never>>>();

/** Subscribe to a backend agent event (one window listener per event name). */
export function onAcpEvent<T>(event: "acp:message" | "acp:stderr" | "acp:exit" | "acp:terminal" | "acp:install", listener: Listener<T>): () => void {
  let set = routes.get(event);
  if (!set) {
    set = new Set();
    routes.set(event, set);
    const all = set;
    void listen<T>(event, ({ payload }) => {
      for (const each of [...all]) (each as Listener<T>)(payload);
    });
  }
  set.add(listener as Listener<never>);
  return () => set!.delete(listener as Listener<never>);
}
