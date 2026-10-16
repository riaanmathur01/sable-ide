import { create } from "zustand";
import {
  acpAccountStatus,
  acpConfig,
  acpDeleteSecret,
  acpFindLocal,
  acpInstall,
  acpLinkLocal,
  acpInstalled,
  acpProviders,
  acpRegistry,
  acpRuntimes,
  acpSecretStatus,
  acpSetConfig,
  acpSetSecret,
  acpUninstall,
  onAcpEvent,
  type AccountStatus,
  type AgentConfig,
  type AuthProvider,
  type InstalledAgent,
  type RegistryEntry,
  type RegistryResult,
  type Runtimes,
} from "../lib/acp/ipc";
import { agentName, agentOrder, HIDDEN_REGISTRY_IDS, needsConsent, profileFor } from "../lib/acp/agents";
import { useUiStore } from "./uiStore";

/**
 * The agents you can have: the ACP registry, what's installed (and
 * whether there's an update), how each one signs in, and installing,
 * updating and removing them. Settings → AI Agents, the Marketplace's
 * "AI Agents" category and the panel's agent picker all read this.
 */

export interface InstallProgress {
  message: string;
  fraction: number | null;
}

interface AgentHubState {
  registry: RegistryResult | null;
  registryError: string | null;
  loadingRegistry: boolean;
  installed: InstalledAgent[];
  runtimes: Runtimes | null;
  /** Install/update in progress, by agent id. */
  progress: Record<string, InstallProgress>;
  /** The last install error, by agent id. */
  installErrors: Record<string, string>;
  providers: Record<string, AuthProvider[]>;
  config: Record<string, AgentConfig>;
  secrets: Record<string, Record<string, boolean>>;
  account: Record<string, AccountStatus & { checking?: boolean }>;
  /** The agent whose install notice is open (proprietary downloads). */
  consentFor: string | null;
  /** A CLI of the user's own found for the agent (Cursor's), by id. */
  localCli: Record<string, string | null>;
  /** Settings → AI Agents should open this card on this sign-in method. */
  focus: { agentId: string; provider?: string; nonce: number } | null;
  load: (refresh?: boolean) => Promise<void>;
  refreshInstalled: () => Promise<void>;
  /** `consent`: the user agreed to a proprietary download's notice. */
  install: (id: string, consent?: boolean) => Promise<boolean>;
  setConsentFor: (id: string | null) => void;
  findLocal: (id: string) => Promise<void>;
  /** Use the CLI the user installed instead of downloading one. */
  linkLocal: (id: string) => Promise<boolean>;
  uninstall: (id: string) => Promise<void>;
  loadAuth: (id: string) => Promise<void>;
  saveConfig: (id: string, config: AgentConfig) => Promise<void>;
  setSecret: (id: string, key: string, value: string) => Promise<void>;
  deleteSecret: (id: string, key: string) => Promise<void>;
  checkAccount: (id: string) => Promise<void>;
}

let loaded: Promise<void> | null = null;

export const useAgentHubStore = create<AgentHubState>((set, get) => ({
  registry: null,
  registryError: null,
  loadingRegistry: false,
  installed: [],
  runtimes: null,
  progress: {},
  installErrors: {},
  providers: {},
  config: {},
  secrets: {},
  account: {},
  consentFor: null,
  localCli: {},
  focus: null,

  load: async (refresh = false) => {
    if (!refresh && loaded) return loaded;
    const run = (async () => {
      set({ loadingRegistry: true });
      const [registry, installed, runtimes, config] = await Promise.allSettled([acpRegistry(refresh), acpInstalled(), acpRuntimes(), acpConfig()]);
      set({
        registry: registry.status === "fulfilled" ? registry.value : get().registry,
        registryError: registry.status === "rejected" ? String(registry.reason) : registry.value.error,
        installed: installed.status === "fulfilled" ? installed.value : get().installed,
        runtimes: runtimes.status === "fulfilled" ? runtimes.value : get().runtimes,
        config: config.status === "fulfilled" ? config.value.agents : get().config,
        loadingRegistry: false,
      });
    })();
    loaded = run;
    return run;
  },

  refreshInstalled: async () => {
    const installed = await acpInstalled().catch(() => get().installed);
    set({ installed });
  },

  install: async (id, consent = false) => {
    const entry = get().registry?.agents.find((agent) => agent.id === id);
    const installedBefore = get().installed.some((agent) => agent.id === id);
    if (entry && needsConsent(entry) && !consent && !installedBefore) {
      // Proprietary software from its vendor: the notice first.
      set({ consentFor: id });
      void get().findLocal(id);
      return false;
    }
    set((state) => ({ consentFor: state.consentFor === id ? null : state.consentFor, progress: { ...state.progress, [id]: { message: "Starting…", fraction: null } }, installErrors: { ...state.installErrors, [id]: "" } }));
    try {
      // An update of something already agreed to keeps that agreement.
      const installed = await acpInstall(id, consent || installedBefore);
      set((state) => ({ installed: [...state.installed.filter((agent) => agent.id !== id), installed] }));
      useUiStore.getState().showStatus(`Installed ${agentName(id, installed.name)} ${installed.version}`);
      return true;
    } catch (error) {
      set((state) => ({ installErrors: { ...state.installErrors, [id]: String(error) } }));
      return false;
    } finally {
      set((state) => {
        const progress = { ...state.progress };
        delete progress[id];
        return { progress };
      });
    }
  },

  setConsentFor: (id) => {
    set({ consentFor: id });
    if (id) void get().findLocal(id);
  },

  findLocal: async (id) => {
    if (!profileFor(id)?.localCli) return;
    const path = await acpFindLocal(id).catch(() => null);
    set((state) => ({ localCli: { ...state.localCli, [id]: path } }));
  },

  linkLocal: async (id) => {
    try {
      const installed = await acpLinkLocal(id);
      set((state) => ({ installed: [...state.installed.filter((agent) => agent.id !== id), installed], consentFor: state.consentFor === id ? null : state.consentFor, installErrors: { ...state.installErrors, [id]: "" } }));
      useUiStore.getState().showStatus(`Using your ${agentName(id, installed.name)} CLI (${installed.version})`);
      return true;
    } catch (error) {
      set((state) => ({ installErrors: { ...state.installErrors, [id]: String(error) } }));
      return false;
    }
  },

  uninstall: async (id) => {
    const { useAcpStore } = await import("./acpStore");
    await useAcpStore.getState().disconnect(id);
    await acpUninstall(id);
    set((state) => ({ installed: state.installed.filter((agent) => agent.id !== id) }));
  },

  loadAuth: async (id) => {
    const [providers, secrets] = await Promise.all([acpProviders(id), acpSecretStatus(id)]);
    set((state) => ({ providers: { ...state.providers, [id]: providers }, secrets: { ...state.secrets, [id]: secrets } }));
  },

  saveConfig: async (id, config) => {
    const all = await acpSetConfig(id, config);
    set({ config: all.agents });
    // A running agent keeps its old environment: start it afresh.
    const { useAcpStore } = await import("./acpStore");
    await useAcpStore.getState().disconnect(id);
  },

  setSecret: async (id, key, value) => {
    await acpSetSecret(id, key, value);
    set((state) => ({ secrets: { ...state.secrets, [id]: { ...state.secrets[id], [key]: value.trim() !== "" } } }));
    const { useAcpStore } = await import("./acpStore");
    await useAcpStore.getState().disconnect(id);
  },

  deleteSecret: async (id, key) => {
    await acpDeleteSecret(id, key);
    set((state) => ({ secrets: { ...state.secrets, [id]: { ...state.secrets[id], [key]: false } } }));
  },

  checkAccount: async (id) => {
    set((state) => ({ account: { ...state.account, [id]: { ...(state.account[id] ?? { supported: true }), checking: true } } }));
    try {
      const status = await acpAccountStatus(id);
      set((state) => ({ account: { ...state.account, [id]: status } }));
    } catch (error) {
      set((state) => ({ account: { ...state.account, [id]: { supported: true, status: null, stderr: String(error) } } }));
    }
  },
}));

onAcpEvent<{ id: string; message: string; fraction: number | null }>("acp:install", (payload) => {
  useAgentHubStore.setState((state) => (state.progress[payload.id] ? { progress: { ...state.progress, [payload.id]: { message: payload.message, fraction: payload.fraction } } } : {}));
});

/** Registry entries worth showing, featured first. */
export function visibleAgents(registry: RegistryResult | null): RegistryEntry[] {
  return (registry?.agents ?? []).filter((entry) => !HIDDEN_REGISTRY_IDS.has(entry.id)).sort(agentOrder);
}

export function isNewer(candidate: string, current: string): boolean {
  const parts = (text: string) => text.replace(/^v/, "").split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = parts(candidate);
  const b = parts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return typeof y === "string"; // 1.0.0 > 1.0.0-preview
    if (y === undefined) return typeof x !== "string";
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y;
    return String(x) > String(y);
  }
  return false;
}

/** Synchronous facts for other stores. */
export function acpRegistryCache() {
  const state = useAgentHubStore.getState();
  return {
    installedIds: [...state.installed].sort(agentOrder).map((agent) => agent.id),
    entry: (id: string) => state.registry?.agents.find((agent) => agent.id === id),
  };
}

/** Open Settings → AI Agents on an agent's card (and a sign-in method). */
export function openAgentSettings(agentId: string, provider?: string) {
  useAgentHubStore.setState({ focus: { agentId, provider, nonce: Date.now() } });
  void import("./tabsStore").then(({ useTabsStore }) => useTabsStore.getState().openSettings("agents"));
}

export function agentDisplayName(id: string): string {
  const state = useAgentHubStore.getState();
  return agentName(id, state.registry?.agents.find((agent) => agent.id === id)?.name ?? state.installed.find((agent) => agent.id === id)?.name);
}

export { profileFor };
