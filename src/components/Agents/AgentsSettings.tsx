import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Download, ExternalLink, FolderCog, KeyRound, Loader2, LogIn, LogOut, MessageSquare, RefreshCw, ShieldAlert, Smartphone, SquareTerminal, Trash2, TriangleAlert } from "lucide-react";
import { ask as confirmNative } from "@tauri-apps/plugin-dialog";
import { isNewer, openAgentSettings, useAgentHubStore, visibleAgents } from "../../store/agentHubStore";
import { runTerminalLogin, useAcpStore } from "../../store/acpStore";
import { agentName, AGENT_PROFILES, needsConsent, profileFor } from "../../lib/acp/agents";
import type { AgentConfig, AuthField, AuthProvider, RegistryEntry } from "../../lib/acp/ipc";
import { SETTINGS_SCHEMA } from "../../store/settingsStore";
import { SettingRow } from "../Settings/SettingsView";
import { useUiStore } from "../../store/uiStore";
import { AgentIcon } from "./AgentIcon";
import "./Agents.css";

const open = (url: string) => void openUrl(url).catch((error) => useUiStore.getState().setLastError(String(error)));

/** What a sign-in method is, in a word (on its button). */
const KIND_LABELS: Record<string, string> = {
  subscription: "Subscription",
  account: "Account",
  apiKey: "API key",
  cloud: "Cloud provider",
  local: "Runs locally",
  custom: "Custom",
  cli: "Your CLI",
};

/**
 * Settings → AI Agents: each coding agent as a card — install, update,
 * remove, how it signs in (subscription, API key, Bedrock, Vertex, local
 * models…) — and the agent panel's own settings.
 */
export function AgentsSettings() {
  const registry = useAgentHubStore((state) => state.registry);
  const loading = useAgentHubStore((state) => state.loadingRegistry);
  const runtimes = useAgentHubStore((state) => state.runtimes);
  const registryError = useAgentHubStore((state) => state.registryError);
  useEffect(() => {
    void useAgentHubStore.getState().load();
  }, []);
  const all = visibleAgents(registry);
  const featured = AGENT_PROFILES.map((profile) => all.find((entry) => entry.id === profile.id)).filter((entry): entry is RegistryEntry => Boolean(entry));
  const rest = all.filter((entry) => !profileFor(entry.id));
  const specs = SETTINGS_SCHEMA.filter((spec) => spec.section === "AI Agents");
  return (
    <div className="agents-settings">
      <h2>AI Agents</h2>
      <p className="agents-settings-lead">
        Coding agents that run on your machine and work in your workspace, through the{" "}
        <a href="#" onClick={(event) => (event.preventDefault(), open("https://agentclientprotocol.com"))}>
          Agent Client Protocol
        </a>
        . Each signs in its own way — your subscription, an API key, a cloud provider such as Amazon Bedrock, or a model on this machine. Keys are kept in your
        system keychain, never in settings files. Sable's own agent (API keys, under AI Agent) stays available beside them.
      </p>
      {runtimes && !runtimes.node && (
        <div className="agents-settings-notice">
          <TriangleAlert size={14} /> Node.js isn't installed: agents distributed as npm packages (Claude Agent, Codex, Kimi Code) need it. Get the LTS from{" "}
          <a href="#" onClick={(event) => (event.preventDefault(), open("https://nodejs.org"))}>
            nodejs.org
          </a>
          .
        </div>
      )}
      {registryError && registry?.source !== "network" && (
        <div className="agents-settings-notice">
          <TriangleAlert size={14} /> {registry?.source === "builtin" ? "Couldn't reach the agent registry; showing the agents Sable knows." : "Couldn't refresh the agent registry; showing the last copy."}
          <button className="acp-link" onClick={() => void useAgentHubStore.getState().load(true)}>
            Retry
          </button>
        </div>
      )}
      <div className="agent-cards">
        {featured.map((entry) => (
          <AgentCard key={entry.id} entry={entry} />
        ))}
      </div>
      {rest.length > 0 && (
        <div className="agent-more">
          <h3>
            More agents from the ACP registry{" "}
            <button className="acp-icon-button" title="Check for new agents and updates" onClick={() => void useAgentHubStore.getState().load(true)}>
              <RefreshCw size={12} className={loading ? "spinning" : undefined} />
            </button>
          </h3>
          <div className="agent-more-grid">
            {rest.map((entry) => (
              <MiniAgentCard key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}
      {specs.length > 0 && (
        <div className="agent-more">
          <h3>Agent panel</h3>
          {specs.map((spec) => (
            <SettingRow key={spec.key} spec={spec} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Install / Update / Installed. A proprietary download (Cursor) opens its
 * notice first: inline where the card can show it (`consentInline`),
 * else on its card in Settings → AI Agents.
 */
export function InstallButton({ entry, compact, consentInline }: { entry: RegistryEntry; compact?: boolean; consentInline?: boolean }) {
  const installed = useAgentHubStore((state) => state.installed.find((agent) => agent.id === entry.id));
  const progress = useAgentHubStore((state) => state.progress[entry.id]);
  const update = installed && installed.kind !== "cli" && isNewer(entry.version, installed.version);
  if (entry.source === "cli") {
    if (installed)
      return (
        <span className="acp-tag good" data-testid={`installed-${entry.id}`} title={installed.env?.SABLE_CLAUDE_PATH}>
          <Check size={10} /> Found {installed.version}
        </span>
      );
    return (
      <span style={{ display: "inline-flex", gap: 6 }}>
        <button className="acp-button primary" onClick={() => open(profileFor(entry.id)?.cli?.setupUrl ?? entry.website ?? "")} data-testid={`get-${entry.id}`}>
          <Download size={12} /> Get {agentName(entry.id, entry.name)}
        </button>
        <button className="acp-icon-button" title="Look again" onClick={() => void useAgentHubStore.getState().refreshInstalled()}>
          <RefreshCw size={12} />
        </button>
      </span>
    );
  }
  if (progress)
    return (
      <button className="acp-button" disabled title={progress.message}>
        <Loader2 size={12} className="spinning" /> {compact ? "Installing…" : progress.message.length > 32 ? `${progress.message.slice(0, 30)}…` : progress.message}
      </button>
    );
  const install = () => {
    void useAgentHubStore
      .getState()
      .install(entry.id)
      .then(() => {
        if (!consentInline && useAgentHubStore.getState().consentFor === entry.id) openAgentSettings(entry.id);
      });
  };
  if (!installed)
    return (
      <button className="acp-button primary" onClick={install} data-testid={`install-${entry.id}`}>
        <Download size={12} /> {needsConsent(entry) ? "Install…" : "Install"}
      </button>
    );
  if (update)
    return (
      <button className="acp-button primary" onClick={install} title={`${installed.version} → ${entry.version}`}>
        <RefreshCw size={12} /> Update to {entry.version}
      </button>
    );
  return (
    <span className="acp-tag good" data-testid={`installed-${entry.id}`} title={installed.kind === "cli" ? installed.program : undefined}>
      <Check size={10} /> {installed.kind === "cli" ? "Your CLI" : "Installed"}
    </span>
  );
}

/**
 * Before downloading proprietary software (Cursor's CLI): whose it is,
 * where it comes from, whose terms apply — and the user's own copy, if
 * they have one, as the alternative.
 */
export function ConsentNotice({ entry }: { entry: RegistryEntry }) {
  const profile = profileFor(entry.id);
  const local = useAgentHubStore((state) => state.localCli[entry.id]);
  const [agreed, setAgreed] = useState(false);
  const name = agentName(entry.id, entry.name);
  let host = "its vendor";
  try {
    const archive = Object.values(entry.distribution.binary ?? {})[0]?.archive;
    if (archive) host = new URL(archive).host;
  } catch {
    /* keep the words */
  }
  const terms = profile?.consent?.termsUrl ?? entry.licenseUrl;
  return (
    <div className="agent-consent" data-testid="agent-consent">
      <div className="agent-consent-title">
        <ShieldAlert size={15} /> {name}'s CLI is proprietary software
      </div>
      <p>
        Installing downloads {name}'s agent CLI{profile?.consent?.size ? ` (${profile.consent.size})` : ""} from {host} into Sable's agents folder. It's made by{" "}
        {profile?.consent?.vendor ?? entry.authors.join(", ")}, not Sable; using it is subject to {name}'s terms and needs a {name} account or API key. Sable
        doesn't modify or redistribute it. The registry publishes no checksum for it, so Sable records the download's SHA-256 and refuses different bytes for
        the same version later.
      </p>
      {local && (
        <div className="agent-consent-local">
          <SquareTerminal size={13} />
          <span>
            You already have {name}'s CLI at <code>{local}</code>.
          </span>
          <button className="acp-button" onClick={() => void useAgentHubStore.getState().linkLocal(entry.id)} data-testid="agent-use-local">
            Use it instead (no download)
          </button>
        </div>
      )}
      <label className="agent-consent-agree">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} data-testid="agent-consent-agree" />
        <span>
          I agree to {name}'s{" "}
          <a href="#" onClick={(event) => (event.preventDefault(), terms && open(terms))}>
            Terms of Service
          </a>
        </span>
      </label>
      <div className="agent-consent-actions">
        <button className="acp-button primary" disabled={!agreed} onClick={() => void useAgentHubStore.getState().install(entry.id, true)} data-testid="agent-consent-install">
          <Download size={12} /> Download and install
        </button>
        <button className="acp-button ghost" onClick={() => useAgentHubStore.getState().setConsentFor(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function AgentCard({ entry }: { entry: RegistryEntry }) {
  const profile = profileFor(entry.id);
  const installed = useAgentHubStore((state) => state.installed.find((agent) => agent.id === entry.id));
  const error = useAgentHubStore((state) => state.installErrors[entry.id]);
  const consent = useAgentHubStore((state) => state.consentFor === entry.id);
  const focus = useAgentHubStore((state) => (state.focus?.agentId === entry.id ? state.focus : null));
  const name = agentName(entry.id, entry.name);
  const [showAuth, setShowAuth] = useState(entry.id === "claude-acp");
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    setShowAuth(true);
    requestAnimationFrame(() => card.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const linked = installed?.kind === "cli" && entry.source !== "cli";
  return (
    <div className={`agent-card${focus ? " focused" : ""}`} data-agent={entry.id} ref={card}>
      <div className="agent-card-top">
        <div className="agent-card-logo">
          <AgentIcon id={entry.id} size={22} iconUrl={entry.icon} />
        </div>
        <div className="agent-card-main">
          <div className="agent-card-title">
            {name} <span className="agent-card-vendor">{profile?.vendor ?? entry.authors[0]}</span>
            {profile && !profile.integrated && <span className="acp-tag warn">Preview</span>}
          </div>
          <p className="agent-card-description">{profile?.description ?? entry.description}</p>
          <div className="agent-card-meta">
            {entry.source === "cli" ? (
              <span>{installed ? `claude ${installed.version} at ${installed.env?.SABLE_CLAUDE_PATH ?? "?"}` : "The claude CLI isn't installed"}</span>
            ) : linked ? (
              <span title={installed.program}>Your {profile?.localCli ?? "CLI"} {installed.version}</span>
            ) : (
              <>
                <span>{installed ? `Installed ${installed.version}` : `Version ${entry.version}`}</span>
                <span>{entry.distribution.npx ? "npm package (needs Node.js)" : entry.distribution.binary ? `Download from ${entry.license === "proprietary" ? "the vendor" : "the registry"}` : "Python (uv)"}</span>
              </>
            )}
            {entry.source === "sable" && <span>Listed by Sable</span>}
            {(profile?.docsUrl ?? entry.website ?? entry.repository) && (
              <a href="#" onClick={(event) => (event.preventDefault(), open((profile?.docsUrl ?? entry.website ?? entry.repository)!))}>
                Docs <ExternalLink size={10} />
              </a>
            )}
            {entry.license &&
              (entry.licenseUrl ? (
                <a href="#" onClick={(event) => (event.preventDefault(), open(entry.licenseUrl!))}>
                  License: {entry.license}
                </a>
              ) : (
                <span>License: {entry.license}</span>
              ))}
          </div>
        </div>
        <div className="agent-card-actions">
          <InstallButton entry={entry} consentInline />
          {installed && (
            <>
              <button
                className="acp-icon-button"
                title={`Open ${name} in the agent panel`}
                data-testid={`open-${entry.id}`}
                onClick={() => {
                  useAcpStore.getState().setPanelAgent(entry.id);
                  useUiStore.getState().focusAgent();
                }}
              >
                <MessageSquare size={14} />
              </button>
              {entry.source !== "cli" && (
                <button
                  className="acp-icon-button"
                  title={linked ? `Stop using your ${name} CLI` : `Uninstall ${name}`}
                  onClick={async () => {
                    const text = linked
                      ? `Stop using your own ${name} CLI in Sable? The CLI itself stays installed.`
                      : `Uninstall ${name}? Its files in Sable's agents folder are removed; your sign-in and settings stay.`;
                    const yes = await confirmNative(text, { title: "Uninstall agent", kind: "warning" }).catch(() => true);
                    if (yes) await useAgentHubStore.getState().uninstall(entry.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {consent && !installed && <ConsentNotice entry={entry} />}
      {error && (
        <div className="agent-card-status">
          <span className="dot warn" />
          <pre className="acp-error-text" style={{ margin: 0 }}>
            {error}
          </pre>
        </div>
      )}
      <AccountStatusRow agentId={entry.id} installed={Boolean(installed)} onShowAuth={() => setShowAuth(!showAuth)} authOpen={showAuth} />
      {showAuth && <AuthSettings agentId={entry.id} />}
    </div>
  );
}

function MiniAgentCard({ entry }: { entry: RegistryEntry }) {
  return (
    <div className="agent-mini" data-agent={entry.id}>
      <AgentIcon id={entry.id} size={18} iconUrl={entry.icon} />
      <div className="agent-mini-main">
        <div className="agent-mini-name">{entry.name}</div>
        <div className="agent-mini-description">{entry.description}</div>
      </div>
      <InstallButton entry={entry} compact />
    </div>
  );
}

interface AccountState {
  loggedIn?: boolean;
  email?: string;
  detail?: string;
  subscriptionType?: string;
  orgName?: string;
  authMethod?: string;
}

/** Who the agent is signed in as, with Sign in / Sign out for account logins. */
function AccountStatusRow({ agentId, installed, onShowAuth, authOpen }: { agentId: string; installed: boolean; onShowAuth: () => void; authOpen: boolean }) {
  const providers = useAgentHubStore((state) => state.providers[agentId]);
  const config = useAgentHubStore((state) => state.config[agentId]);
  const account = useAgentHubStore((state) => state.account[agentId]);
  const secrets = useAgentHubStore((state) => state.secrets[agentId]);
  const live = useAcpStore((state) => state.connections[agentId]?.account);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useAgentHubStore.getState().loadAuth(agentId);
  }, [agentId]);
  const provider = providers?.find((candidate) => candidate.id === config?.provider) ?? providers?.[0];
  const hasStatus = Boolean(provider?.account?.status);
  useEffect(() => {
    if (installed && hasStatus) void useAgentHubStore.getState().checkAccount(agentId);
  }, [installed, hasStatus, agentId, provider?.id]);
  if (!providers || !provider) return null;
  const name = agentName(agentId);
  const status = account?.status as AccountState | null | undefined;
  const commands = provider.account;
  let text: React.ReactNode;
  let dot = "";
  let canSignIn = false;
  let canSignOut = false;
  if (!installed) {
    text = <span className="acp-muted">Install to sign in.</span>;
  } else if (hasStatus) {
    // Claude Agent (the SDK adapter) can't use a claude.ai plan; Claude Code (the CLI itself) can.
    const subscription = agentId === "claude-acp" && status?.loggedIn && (status.authMethod === "claude.ai" || (status.subscriptionType && !status.authMethod));
    // Codex's ~/.codex can hold an API key login instead of ChatGPT.
    const codexKey = agentId === "codex-acp" && provider.id === "chatgpt" && status?.loggedIn && /api key/i.test(status.authMethod ?? "");
    if (account?.checking && !status) text = <span className="acp-muted">Checking sign-in…</span>;
    else if (subscription) {
      dot = "warn";
      canSignIn = true;
      text = (
        <span data-testid="account-status">
          Your Claude login{status?.email ? ` (${status.email})` : ""} is a claude.ai subscription, which Claude Agent can't use: sign in with a Console account, or pick
          another method below.
        </span>
      );
    } else if (codexKey) {
      dot = "warn";
      canSignIn = true;
      canSignOut = true;
      text = <span data-testid="account-status">Codex (~/.codex) is signed in with an API key, not ChatGPT. Sign in with ChatGPT to use your plan.</span>;
    } else if (status?.loggedIn) {
      dot = "ok";
      canSignOut = true;
      const plan =
        status.subscriptionType && agentId === "claude-code"
          ? `Claude ${status.subscriptionType[0].toUpperCase()}${status.subscriptionType.slice(1)}`
          : status.authMethod === "console" || status.authMethod === "api_key"
            ? "Anthropic Console"
            : agentId === "codex-acp"
              ? (status.authMethod ?? "ChatGPT")
              : agentId === "cursor"
                ? "Cursor account"
                : status.authMethod;
      const email = status.email ?? (agentId === "codex-acp" && live?.account?.email ? live.account.email : undefined);
      text = (
        <span data-testid="account-status">
          Signed in{email ? ` as ${email}` : ""}
          {plan ? ` · ${plan}` : ""}
        </span>
      );
    } else if (status) {
      dot = "warn";
      canSignIn = true;
      text = <span data-testid="account-status">Not signed in{provider.kind === "subscription" ? ` — sign in to use your ${provider.label.replace(/ account$/, "")} plan` : ""}</span>;
    } else {
      canSignIn = true;
      text = <span className="acp-muted">{account?.stderr ? `Couldn't check: ${account.stderr.split("\n")[0]}` : "Sign-in status unknown"}</span>;
    }
  } else if (commands?.login) {
    // An account the agent keeps but can't report on (Kimi Code).
    canSignIn = true;
    canSignOut = commands.logoutAcp || Boolean(commands.logout);
    dot = live ? "ok" : "";
    text = live ? (
      `${live.label}${live.detail ? ` · ${live.detail}` : ""}`
    ) : (
      <span data-testid="account-status">
        {name} keeps its own sign-in{provider.kind === "subscription" ? ` to your ${provider.label}` : ""}: sign in once and it's remembered.
      </span>
    );
  } else {
    const missing = provider.fields.filter((field) => field.secret && field.required && fieldActive(provider, field, config?.values ?? {}) && !secrets?.[`${provider.id}.${field.key}`]);
    dot = missing.length ? "warn" : "ok";
    const summary = summarize(provider, config?.values ?? {});
    text = missing.length ? (
      <span data-testid="account-status">
        {provider.label}: add your {missing.map((field) => field.label.toLowerCase()).join(" and ")} below.
      </span>
    ) : (
      <span data-testid="account-status">
        Using {provider.label}
        {summary ? ` · ${summary}` : ""}
      </span>
    );
  }
  const run = async (action: "login" | "login_device" | "logout") => {
    setBusy(true);
    try {
      if (action === "logout" && commands?.logoutAcp && !commands.logout) await useAcpStore.getState().logout(agentId);
      else {
        await runTerminalLogin(agentId, { action });
        await useAcpStore.getState().disconnect(agentId);
      }
      if (action === "logout") useUiStore.getState().showStatus(`Signed out of ${name}`);
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    } finally {
      setBusy(false);
      if (hasStatus) void useAgentHubStore.getState().checkAccount(agentId);
    }
  };
  const signInLabel =
    agentId === "claude-code" ? "Sign in (opens claude)" : provider.kind === "subscription" ? `Sign in${provider.id === "chatgpt" ? " with ChatGPT" : provider.label ? ` with ${provider.label.replace(/ account$/, "")}` : ""}` : "Sign in";
  return (
    <div className="agent-card-status">
      <span className={`dot ${dot}`} />
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      {installed && commands?.login && canSignIn && (
        <button
          className="acp-button primary"
          disabled={busy}
          onClick={() => void run("login")}
          data-testid="agent-sign-in"
          title={agentId === "claude-code" ? "Opens a terminal running your claude — type /login there" : "Opens a terminal running the agent's own sign-in"}
        >
          <LogIn size={12} /> {signInLabel}
        </button>
      )}
      {installed && commands?.loginDevice && canSignIn && (
        <button className="acp-button" disabled={busy} onClick={() => void run("login_device")} data-testid="agent-sign-in-device" title="Sign in with a one-time code, from a browser on any device">
          <Smartphone size={12} /> Use a one-time code
        </button>
      )}
      {installed && commands && (commands.logout || commands.logoutAcp) && canSignOut && (
        <button className="acp-button ghost" disabled={busy} onClick={() => void run("logout")} data-testid="agent-sign-out">
          <LogOut size={12} /> Sign out
        </button>
      )}
      {installed && hasStatus && (
        <button className="acp-icon-button" title="Check again" onClick={() => void useAgentHubStore.getState().checkAccount(agentId)}>
          <RefreshCw size={12} className={account?.checking ? "spinning" : undefined} />
        </button>
      )}
      <button className="acp-button ghost" onClick={onShowAuth} data-testid="agent-auth-toggle">
        <KeyRound size={12} /> {authOpen ? "Hide sign-in options" : "Sign-in & providers"}
      </button>
    </div>
  );
}

function fieldActive(provider: AuthProvider, field: AuthField, values: Record<string, string>): boolean {
  if (!field.when) return true;
  const [key, allowed] = field.when;
  const other = provider.fields.find((candidate) => candidate.key === key);
  const value = values[`${provider.id}.${key}`] ?? other?.default ?? "";
  return allowed.includes(value);
}

/** "us-east-2 · global.openai.gpt-6.1-sol": the method's main choices. */
function summarize(provider: AuthProvider, values: Record<string, string>): string {
  const parts: string[] = [];
  for (const field of provider.fields) {
    if (field.secret || !["region", "model", "server", "endpoint", "resource", "projectId"].includes(field.key)) continue;
    const value = values[`${provider.id}.${field.key}`] ?? field.default;
    if (!value) continue;
    parts.push(field.options?.find((option) => option.value === value)?.label.replace(/ \(.*\)$/, "") ?? value);
  }
  return parts.slice(0, 3).join(" · ");
}

/** Pick how the agent authenticates, and fill in what that needs. */
export function AuthSettings({ agentId }: { agentId: string }) {
  const providers = useAgentHubStore((state) => state.providers[agentId]);
  const saved = useAgentHubStore((state) => state.config[agentId]);
  const secrets = useAgentHubStore((state) => state.secrets[agentId]) ?? {};
  const focus = useAgentHubStore((state) => (state.focus?.agentId === agentId ? state.focus : null));
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const config: AgentConfig = draft ?? saved ?? { provider: null, values: {}, env: {} };
  useEffect(() => {
    // Opened from the panel on a particular method ("Use an OpenAI API key…").
    if (!focus) return;
    if (focus.provider && focus.provider !== (saved?.provider ?? providers?.[0]?.id)) setDraft({ ...(saved ?? { provider: null, values: {}, env: {} }), provider: focus.provider });
    // Once: reopening Settings later starts from what's saved.
    useAgentHubStore.setState({ focus: null });
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = useMemo(() => providers?.find((provider) => provider.id === config.provider) ?? providers?.[0], [providers, config.provider]);
  if (!providers || !current) return null;
  const name = agentName(agentId);
  const dirty = draft !== null || Object.values(secretDrafts).some((value) => value !== "");
  const setValue = (key: string, value: string) => setDraft({ ...config, values: { ...config.values, [`${current.id}.${key}`]: value } });
  const save = async () => {
    setStatus("saving");
    try {
      for (const [key, value] of Object.entries(secretDrafts)) if (value.trim()) await useAgentHubStore.getState().setSecret(agentId, key, value);
      await useAgentHubStore.getState().saveConfig(agentId, { provider: current.id, values: config.values, env: config.env ?? {} });
      setDraft(null);
      setSecretDrafts({});
      setStatus("saved");
      void useAgentHubStore.getState().checkAccount(agentId);
      setTimeout(() => setStatus("idle"), 2500);
    } catch (error) {
      setStatus("idle");
      useUiStore.getState().setLastError(String(error));
    }
  };
  return (
    <div className="agent-card-auth">
      {providers.length > 1 && <div className="agent-auth-heading">How {name} signs in</div>}
      {providers.length > 1 && (
        <div className="agent-auth-methods" role="radiogroup">
          {providers.map((provider) => (
            <button
              key={provider.id}
              role="radio"
              aria-checked={provider.id === current.id}
              className={provider.id === current.id ? "agent-auth-method selected" : "agent-auth-method"}
              onClick={() => setDraft({ ...config, provider: provider.id })}
              data-provider={provider.id}
            >
              <span className="agent-auth-radio" />
              <span className="agent-auth-method-text">
                <span>{provider.label}</span>
                {KIND_LABELS[provider.kind] && <span className={`agent-auth-kind kind-${provider.kind}`}>{KIND_LABELS[provider.kind]}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="agent-auth-detail" data-method={current.id}>
        <p className="agent-auth-description">
          {current.description}{" "}
          {current.helpUrl && (
            <a href="#" onClick={(event) => (event.preventDefault(), open(current.helpUrl!))}>
              Learn more
            </a>
          )}
        </p>
        {current.acpMethods?.length && current.account?.login && !current.fields.length ? (
          <div className="agent-auth-note">
            <LogIn size={13} />
            <span>Nothing to fill in: sign in from the panel when {name} asks, or with Sign in above.</span>
          </div>
        ) : null}
        {current.fields
          .filter((field) => fieldActive(current, field, config.values))
          .map((field) => {
            const key = `${current.id}.${field.key}`;
            return (
              <label key={field.key} className="agent-field" data-field={key}>
                <span className="agent-field-label">
                  {field.label}
                  {field.required && <span className="required">*</span>}
                </span>
                {field.secret ? (
                  <span className="agent-secret">
                    {secrets[key] && secretDrafts[key] === undefined ? (
                      <span className="agent-secret-set">
                        <Check size={12} className="acp-status-ok" /> Saved in your keychain
                        <button className="acp-link" onClick={(event) => (event.preventDefault(), setSecretDrafts({ ...secretDrafts, [key]: "" }))}>
                          Change
                        </button>
                        <button
                          className="acp-link"
                          onClick={(event) => {
                            event.preventDefault();
                            void useAgentHubStore.getState().deleteSecret(agentId, key);
                          }}
                        >
                          Remove
                        </button>
                      </span>
                    ) : (
                      <input type="password" autoComplete="off" placeholder={field.placeholder ?? (field.required ? "" : "Optional")} value={secretDrafts[key] ?? ""} onChange={(event) => setSecretDrafts({ ...secretDrafts, [key]: event.target.value })} />
                    )}
                  </span>
                ) : field.options ? (
                  <select value={config.values[key] ?? field.default ?? ""} onChange={(event) => setValue(field.key, event.target.value)}>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.key === "headers" ? (
                  <textarea rows={2} placeholder={field.placeholder ?? ""} value={config.values[key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)} />
                ) : (
                  <input placeholder={field.placeholder ?? field.default ?? (field.required ? "" : "Optional")} value={config.values[key] ?? ""} spellCheck={false} onChange={(event) => setValue(field.key, event.target.value)} />
                )}
                {field.help && <span className="agent-field-help">{field.help}</span>}
              </label>
            );
          })}
        {current.home && (
          <div className="agent-auth-note" data-testid="agent-auth-home">
            <FolderCog size={13} />
            <span>
              For this method Sable starts {name} with a settings folder of its own (<code>{current.home.env}</code>) and writes its <code>{current.home.file}</code> there from
              these fields — never your keys, which go to {name} through its environment. Your own {agentId === "codex-acp" ? "~/.codex" : "settings"} and any
              sign-in in it stay as they are.
            </span>
          </div>
        )}
        <div className="agent-auth-actions">
          <button className="acp-button primary" disabled={!dirty || status === "saving"} onClick={() => void save()} data-testid="agent-auth-save">
            {status === "saving" ? <Loader2 size={12} className="spinning" /> : <Check size={12} />} Save
          </button>
          {dirty && (
            <button
              className="acp-button ghost"
              onClick={() => {
                setDraft(null);
                setSecretDrafts({});
              }}
            >
              Discard
            </button>
          )}
          {status === "saved" && <span className="agent-auth-saved">Saved — the agent restarts with it.</span>}
        </div>
      </div>
    </div>
  );
}
