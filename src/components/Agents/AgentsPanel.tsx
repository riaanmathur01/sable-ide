import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileDiff,
  History,
  Loader2,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { AgentPanel } from "../Agent/AgentPanel";
import { AgentIcon } from "./AgentIcon";
import { Composer } from "./Composer";
import { ConsentNotice } from "./AgentsSettings";
import { AccountLine, PlanCard, ThreadItems, openAgentDiff, sortedOptions } from "./ThreadView";
import { useAcpStore, type SavedThread, type Thread } from "../../store/acpStore";
import { isNewer, useAgentHubStore, visibleAgents } from "../../store/agentHubStore";
import { agentName, profileFor, SABLE_AGENT_ID } from "../../lib/acp/agents";
import { useUiStore } from "../../store/uiStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore, workspaceRelativePath } from "../../store/workspaceStore";
import { readCurrentText } from "../../lib/fileContents";
import { diffLines, diffStats, splitLines } from "../../lib/acp/lineDiff";
import { modKey } from "./keys";
import "./Agents.css";

/**
 * The right-hand agent panel: Sable's own agent or an external one
 * (Claude Agent, Codex…), picked in the header.
 */
export function AgentsPanel() {
  const panelAgent = useAcpStore((state) => state.panelAgent);
  useEffect(() => {
    void useAgentHubStore.getState().load();
  }, []);
  const switcher = <AgentSwitcher />;
  if (panelAgent === SABLE_AGENT_ID) return <AgentPanel switcher={switcher} />;
  return <AcpPanel agentId={panelAgent} switcher={switcher} />;
}

/** Header dropdown: which agent the panel talks to. */
export function AgentSwitcher() {
  const panelAgent = useAcpStore((state) => state.panelAgent);
  const registry = useAgentHubStore((state) => state.registry);
  const installed = useAgentHubStore((state) => state.installed);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const agents = useMemo(() => {
    const listed = visibleAgents(registry).filter((entry) => profileFor(entry.id) || installed.some((agent) => agent.id === entry.id));
    for (const agent of installed) if (!listed.some((entry) => entry.id === agent.id)) listed.push({ id: agent.id, name: agent.name, version: agent.version, description: "", authors: [], distribution: {} });
    return listed;
  }, [registry, installed]);
  const choose = (id: string) => {
    setOpen(false);
    useAcpStore.getState().setPanelAgent(id);
    useUiStore.getState().focusAgent();
  };
  const current = panelAgent === SABLE_AGENT_ID ? "Sable Agent" : agentName(panelAgent, registry?.agents.find((entry) => entry.id === panelAgent)?.name);
  const iconUrl = registry?.agents.find((entry) => entry.id === panelAgent)?.icon;
  return (
    <div className="acp-switcher" ref={root}>
      <button className={open ? "acp-switcher-button open" : "acp-switcher-button"} onClick={() => setOpen(!open)} title="Switch agent" data-testid="agent-switcher">
        <AgentIcon id={panelAgent} size={15} iconUrl={iconUrl} />
        <span className="acp-switcher-name">{current}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="acp-menu down left acp-switcher-menu" role="listbox">
          <button className={`acp-menu-item${panelAgent === SABLE_AGENT_ID ? " selected" : ""}`} onClick={() => choose(SABLE_AGENT_ID)}>
            <span className="acp-menu-check">{panelAgent === SABLE_AGENT_ID && <Check size={12} />}</span>
            <AgentIcon id={SABLE_AGENT_ID} size={16} />
            <span className="acp-menu-text">
              <span className="acp-menu-label">Sable Agent</span>
              <span className="acp-menu-description">Built in · your API keys</span>
            </span>
            <kbd>{modKey()}L</kbd>
          </button>
          <div className="acp-menu-group">External agents</div>
          {agents.map((entry) => {
            const isInstalled = installed.some((agent) => agent.id === entry.id);
            const profile = profileFor(entry.id);
            return (
              <button key={entry.id} className={`acp-menu-item${panelAgent === entry.id ? " selected" : ""}`} onClick={() => choose(entry.id)} data-agent={entry.id}>
                <span className="acp-menu-check">{panelAgent === entry.id && <Check size={12} />}</span>
                <AgentIcon id={entry.id} size={16} iconUrl={entry.icon} />
                <span className="acp-menu-text">
                  <span className="acp-menu-label">{agentName(entry.id, entry.name)}</span>
                  <span className="acp-menu-description">{profile?.vendor ?? entry.authors[0] ?? ""}</span>
                </span>
                {isInstalled ? (
                  null
                ) : (
                  <span className="acp-tag">{entry.source === "cli" ? "Not found" : "Install"}</span>
                )}
              </button>
            );
          })}
          <div className="acp-menu-footer">
            <button
              className="acp-link"
              onClick={() => {
                setOpen(false);
                useTabsStore.getState().openSettings("agents");
              }}
            >
              Manage agents…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AcpPanel({ agentId, switcher }: { agentId: string; switcher: React.ReactNode }) {
  const width = useUiStore((state) => state.panelSizes.agentWidth);
  const installed = useAgentHubStore((state) => state.installed.find((agent) => agent.id === agentId));
  const hubLoaded = useAgentHubStore((state) => state.registry !== null || state.installed.length > 0 || state.registryError !== null);
  const openThreadIds = useAcpStore((state) => state.openThreadIds);
  const threads = useAcpStore((state) => state.threads);
  const activeThreadId = useAcpStore((state) => state.activeThreadId);
  const historyOpen = useAcpStore((state) => state.historyOpen);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const tabs = openThreadIds.map((id) => threads[id]).filter((thread): thread is Thread => Boolean(thread) && thread.agentId === agentId);
  const thread = activeThreadId && threads[activeThreadId]?.agentId === agentId ? threads[activeThreadId] : tabs[tabs.length - 1];
  const name = agentName(agentId);

  // An installed agent with no thread yet: start one (it shows the agent's modes and models straight away).
  useEffect(() => {
    if (installed && !thread && rootPath && !historyOpen) useAcpStore.getState().ensureThread(agentId);
  }, [installed, thread, rootPath, historyOpen, agentId]);

  usePermissionShortcuts(thread);

  return (
    <aside className="agent-panel acp-panel" style={{ width }} data-agent={agentId}>
      <div className="acp-header">
        {switcher}
        <div className="acp-header-actions">
          {installed && (
            <button title="New thread" onClick={() => void useAcpStore.getState().newThread(agentId)} data-testid="acp-new-thread">
              <MessageSquarePlus size={15} strokeWidth={1.6} />
            </button>
          )}
          <button title="History" className={historyOpen ? "active" : undefined} onClick={() => useAcpStore.getState().setHistoryOpen(!historyOpen)} data-testid="acp-history">
            <History size={15} strokeWidth={1.6} />
          </button>
          <button title={`${name} settings`} onClick={() => useTabsStore.getState().openSettings("agents")}>
            <Settings size={15} strokeWidth={1.6} />
          </button>
          <button title="Close panel" onClick={() => useUiStore.getState().toggleAgent()}>
            <X size={15} strokeWidth={1.6} />
          </button>
        </div>
      </div>
      {tabs.length > 1 && !historyOpen && (
        <div className="acp-tabs" role="tablist">
          {tabs.map((tab) => (
            <div key={tab.id} role="tab" aria-selected={tab.id === thread?.id} className={tab.id === thread?.id ? "acp-tab active" : "acp-tab"} onClick={() => useAcpStore.getState().activateThread(tab.id)} title={tab.title}>
              {tab.status === "running" ? <Loader2 size={11} className="spinning" /> : Object.keys(tab.review).length > 0 ? <span className="acp-tab-dot" /> : null}
              <span className="acp-tab-title">{tab.title}</span>
              <button
                className="acp-tab-close"
                title="Close thread"
                onClick={(event) => {
                  event.stopPropagation();
                  useAcpStore.getState().closeThread(tab.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button className="acp-tab-new" title="New thread" onClick={() => void useAcpStore.getState().newThread(agentId)}>
            <Plus size={12} />
          </button>
        </div>
      )}
      {historyOpen ? (
        <HistoryView agentId={agentId} />
      ) : !hubLoaded ? (
        <div className="acp-center">
          <Loader2 size={16} className="spinning" />
        </div>
      ) : !installed ? (
        <InstallCard agentId={agentId} />
      ) : !rootPath ? (
        <div className="acp-center acp-muted">Open a folder to work with {name}.</div>
      ) : thread ? (
        <ThreadBody thread={thread} />
      ) : (
        <div className="acp-center">
          <Loader2 size={16} className="spinning" />
        </div>
      )}
    </aside>
  );
}

/** ⌘⏎ allow once, ⌥⌘⏎ always allow, ⌘⌫ reject — while a question waits. */
function usePermissionShortcuts(thread: Thread | undefined) {
  useEffect(() => {
    if (!thread) return;
    const handler = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const inEditor = event.target instanceof Element && event.target.closest(".monaco-editor");
      if (inEditor) return;
      const waiting = [...thread.items].reverse().find((item) => (item.kind === "tool" && item.tool.permission && !item.tool.permission.chosen) || (item.kind === "permission" && !item.permission.chosen));
      const permission = waiting?.kind === "tool" ? waiting.tool.permission : waiting?.kind === "permission" ? waiting.permission : undefined;
      if (!permission) return;
      const options = sortedOptions(permission.options);
      const kind = event.key === "Enter" ? (event.altKey ? "allow_always" : "allow_once") : event.key === "Backspace" ? "reject_once" : null;
      if (!kind) return;
      const option = options.find((candidate) => candidate.kind === kind) ?? (kind === "reject_once" ? options.find((candidate) => candidate.kind.startsWith("reject")) : undefined);
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      useAcpStore.getState().respondPermission(thread.id, permission.key, option.optionId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [thread]);
}

function ThreadBody({ thread }: { thread: Thread }) {
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const connection = useAcpStore((state) => state.connections[thread.agentId]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [thread.items, thread.status]);
  useEffect(() => {
    stick.current = true;
  }, [thread.id]);
  const empty = !thread.items.some((item) => item.kind === "user" || item.kind === "assistant" || item.kind === "auth");
  return (
    <>
      <div
        className="acp-messages"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {empty && <EmptyThread thread={thread} />}
        <ThreadItems thread={thread} />
        {thread.status === "error" && (
          <div className="acp-error">
            <AlertCircle size={14} />
            <div>
              <div className="acp-error-title">{agentName(thread.agentId)} couldn't start</div>
              <pre className="acp-error-text">{thread.error ?? connection?.error ?? "Unknown error"}</pre>
              <button className="acp-button" onClick={() => void useAcpStore.getState().retry(thread.id)}>
                <RefreshCw size={12} /> Try again
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="acp-footer">
        <PlanCard thread={thread} />
        <ReviewBar thread={thread} />
        <Composer thread={thread} />
      </div>
    </>
  );
}

function EmptyThread({ thread }: { thread: Thread }) {
  const profile = profileFor(thread.agentId);
  const name = agentName(thread.agentId);
  const connecting = thread.status === "connecting";
  const askSuggestion = (text: string) => useAcpStore.setState({ composerRequest: { threadId: thread.id, text, mentions: [], send: false, nonce: Date.now() } });
  return (
    <div className="acp-empty">
      <AgentIcon id={thread.agentId} size={30} className="acp-empty-icon" />
      <div className="acp-empty-title">{connecting ? `Starting ${name}…` : thread.readOnly ? thread.title : `What should ${name} do?`}</div>
      <AccountLine agentId={thread.agentId} />
      {!thread.readOnly && (
        <>
          <div className="acp-empty-text">
            {name} works in <code>{thread.cwd.split(/[/\\]/).filter(Boolean).pop() ?? thread.cwd}</code>: it reads and edits files, runs commands, and asks before anything risky. Edits stay
            reviewable until you accept them.
          </div>
          {profile?.suggestions && (
            <div className="acp-suggestions">
              {profile.suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => askSuggestion(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <div className="acp-hints">
            <span>
              <kbd>@</kbd> files, folders, symbols
            </span>
            <span>
              <kbd>/</kbd> commands
            </span>
            <span>
              <kbd>⇧Tab</kbd> mode
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Edits waiting for review: accept or reject each file, or all. */
function ReviewBar({ thread }: { thread: Thread }) {
  const [open, setOpen] = useState(false);
  const paths = Object.keys(thread.review);
  const [stats, setStats] = useState<Record<string, { added: number; removed: number }>>({});
  const reviewKey = paths.map((path) => `${path}:${thread.review[path].touchedAt}`).join("|");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      paths.map(async (path) => {
        const current = (await readCurrentText(path)) ?? "";
        const original = thread.review[path].original ?? "";
        return [path, diffStats(diffLines(splitLines(original), splitLines(current)))] as const;
      }),
    ).then((entries) => !cancelled && setStats(Object.fromEntries(entries)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewKey]);
  if (!paths.length || thread.status === "running") return null;
  const total = paths.reduce((sum, path) => ({ added: sum.added + (stats[path]?.added ?? 0), removed: sum.removed + (stats[path]?.removed ?? 0) }), { added: 0, removed: 0 });
  const store = useAcpStore.getState();
  return (
    <div className="acp-review" data-testid="acp-review">
      <div className="acp-review-header">
        <button className="acp-review-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileDiff size={13} />
          <span className="acp-review-count">
            {paths.length} file{paths.length === 1 ? "" : "s"}
          </span>
          <span className="acp-diff-stats">
            <span className="added">+{total.added}</span>
            <span className="removed">−{total.removed}</span>
          </span>
        </button>
        <span className="acp-composer-spacer" />
        <button className="acp-button ghost" title="Review all changes in the diff view" onClick={() => paths.forEach((path) => openAgentDiff(thread.id, path))}>
          Review
        </button>
        <button className="acp-button ghost danger" title={`Reject all (⌥⇧${modKey()}Y)`} onClick={() => void store.rejectAll(thread.id)} data-testid="acp-reject-all">
          <Undo2 size={12} /> Reject
        </button>
        <button className="acp-button primary" title={`Accept all (⇧${modKey()}Y)`} onClick={() => store.acceptAll(thread.id)} data-testid="acp-accept-all">
          <Check size={12} /> Accept
        </button>
      </div>
      {open && (
        <div className="acp-review-files">
          {paths.map((path) => (
            <div key={path} className="acp-review-file">
              <button className="acp-review-name" title={path} onClick={() => openAgentDiff(thread.id, path)}>
                <span>{path.split(/[/\\]/).pop()}</span>
                <span className="acp-diff-dir">{workspaceRelativePath(path).replace(/[^/\\]*$/, "")}</span>
                {thread.review[path].original === null && <span className="acp-tag new">New</span>}
              </button>
              <span className="acp-diff-stats">
                <span className="added">+{stats[path]?.added ?? 0}</span>
                <span className="removed">−{stats[path]?.removed ?? 0}</span>
              </span>
              <button className="acp-icon-button" title="Reject this file's changes" onClick={() => void store.rejectFile(thread.id, path)}>
                <Undo2 size={12} />
              </button>
              <button className="acp-icon-button" title="Accept this file's changes" onClick={() => store.acceptFile(thread.id, path)}>
                <Check size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

function HistoryView({ agentId }: { agentId: string }) {
  const saved = useAcpStore((state) => state.saved);
  const sessions = useAcpStore((state) => state.agentSessions[agentId]);
  const threads = useAcpStore((state) => state.threads);
  const [query, setQuery] = useState("");
  const mine = saved.filter((entry) => entry.agentId === agentId && entry.title.toLowerCase().includes(query.toLowerCase()));
  const known = new Set(saved.map((entry) => entry.sessionId).filter(Boolean));
  const fromAgent = (sessions ?? []).filter((session) => !known.has(session.sessionId) && (session.title ?? "").toLowerCase().includes(query.toLowerCase()));
  const name = agentName(agentId);
  return (
    <div className="acp-history">
      <div className="acp-history-search">
        <input placeholder="Search threads" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      </div>
      {mine.length === 0 && fromAgent.length === 0 && <div className="acp-muted acp-history-empty">No {name} threads in this folder yet.</div>}
      {mine.map((entry: SavedThread) => {
        const open = threads[entry.id];
        const messages = entry.items.filter((item) => item.kind === "user").length;
        return (
          <div key={entry.id} className="acp-history-item" onClick={() => void useAcpStore.getState().openSaved(entry)} title={entry.title}>
            <div className="acp-history-text">
              <div className="acp-history-title">{entry.title}</div>
              <div className="acp-history-meta">
                {relativeTime(entry.updatedAt)} · {messages} message{messages === 1 ? "" : "s"}
                {open && " · open"}
              </div>
            </div>
            <button
              className="acp-icon-button"
              title="Delete from history"
              onClick={(event) => {
                event.stopPropagation();
                useAcpStore.getState().deleteSaved(entry.id);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
      {fromAgent.length > 0 && (
        <>
          <div className="acp-menu-group">Earlier {name} sessions</div>
          {fromAgent.map((session) => (
            <div key={session.sessionId} className="acp-history-item" onClick={() => void useAcpStore.getState().openAgentSession(agentId, session)}>
              <div className="acp-history-text">
                <div className="acp-history-title">{session.title || "Untitled session"}</div>
                <div className="acp-history-meta">{session.updatedAt ? relativeTime(Date.parse(session.updatedAt)) : session.sessionId.slice(0, 8)}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** An agent that isn't installed yet: what it is, and Install. */
function InstallCard({ agentId }: { agentId: string }) {
  const entry = useAgentHubStore((state) => state.registry?.agents.find((agent) => agent.id === agentId));
  const progress = useAgentHubStore((state) => state.progress[agentId]);
  const error = useAgentHubStore((state) => state.installErrors[agentId]);
  const runtimes = useAgentHubStore((state) => state.runtimes);
  const consent = useAgentHubStore((state) => state.consentFor === agentId);
  const profile = profileFor(agentId);
  const name = agentName(agentId, entry?.name);
  if (entry?.source === "cli" || profile?.cli) {
    return (
      <div className="acp-install">
        <AgentIcon id={agentId} size={36} className="acp-empty-icon" />
        <div className="acp-empty-title">{name}</div>
        <div className="acp-empty-text">{profile?.description}</div>
        <div className="acp-callout">
          <AlertCircle size={14} />
          <div>Sable didn't find the claude CLI on this machine. Install Claude Code, sign in with it once, then look again. (If it's somewhere unusual, set its location in Settings → AI Agents.)</div>
        </div>
        <button className="acp-button primary large" onClick={() => void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(profile?.cli?.setupUrl ?? "https://code.claude.com/docs/en/setup"))}>
          <Download size={13} /> Get Claude Code
        </button>
        <button className="acp-link" style={{ marginTop: 10 }} onClick={() => void useAgentHubStore.getState().refreshInstalled()}>
          I've installed it — look again
        </button>
      </div>
    );
  }
  const needsNode = Boolean(entry?.distribution.npx) && !(entry?.distribution.binary && runtimes?.platform && entry.distribution.binary[runtimes.platform]);
  if (entry && consent) {
    return (
      <div className="acp-install">
        <AgentIcon id={agentId} size={36} iconUrl={entry.icon} className="acp-empty-icon" />
        <div className="acp-empty-title">{name}</div>
        <ConsentNotice entry={entry} />
        {error && <pre className="acp-error-text">{error}</pre>}
      </div>
    );
  }
  return (
    <div className="acp-install">
      <AgentIcon id={agentId} size={36} iconUrl={entry?.icon} className="acp-empty-icon" />
      <div className="acp-empty-title">{name}</div>
      <div className="acp-empty-text">{profile?.description ?? entry?.description ?? "An ACP coding agent."}</div>
      {needsNode && runtimes && !runtimes.node && (
        <div className="acp-callout">
          <AlertCircle size={14} />
          <div>
            {name} runs on Node.js, which isn't installed. Install the LTS version from{" "}
            <a href="https://nodejs.org" target="_blank" rel="noreferrer">
              nodejs.org
            </a>
            , then come back.
          </div>
        </div>
      )}
      {error && <pre className="acp-error-text">{error}</pre>}
      <button className="acp-button primary large" disabled={Boolean(progress) || !entry} onClick={() => void useAgentHubStore.getState().install(agentId)} data-testid="acp-install">
        {progress ? <Loader2 size={13} className="spinning" /> : <Download size={13} />}
        {progress ? progress.message : entry ? `Install ${name}` : "Not available"}
      </button>
      {progress?.fraction != null && (
        <div className="acp-progress">
          <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
        </div>
      )}
      {entry && (
        <div className="acp-install-meta">
          {entry.version} · {entry.distribution.npx ? "npm package" : entry.distribution.binary ? "download" : "Python"} · installed into Sable's folder, nothing global
        </div>
      )}
    </div>
  );
}

export function updateAvailable(agentId: string): string | null {
  const { registry, installed } = useAgentHubStore.getState();
  const entry = registry?.agents.find((agent) => agent.id === agentId);
  const current = installed.find((agent) => agent.id === agentId);
  return entry && current && isNewer(entry.version, current.version) ? entry.version : null;
}
