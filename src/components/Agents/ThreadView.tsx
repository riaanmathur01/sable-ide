import { memo, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Circle,
  CircleDot,
  Copy,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import {
  useAcpStore,
  type Mention,
  type PermissionState,
  type Thread,
  type ThreadItem,
  type ToolState,
} from "../../store/acpStore";
import type { AuthMethod, PermissionOption, ToolCallContent } from "../../lib/acp/protocol";
import { diffLines, diffStats, hunks, splitLines } from "../../lib/acp/lineDiff";
import { Markdown } from "../Agent/Markdown";
import { useTabsStore } from "../../store/tabsStore";
import { revealPosition } from "../../lib/editorRegistry";
import { workspaceRelativePath } from "../../store/workspaceStore";
import { useSetting } from "../../store/settingsStore";
import { agentName, authHint, deviceCode } from "../../lib/acp/agents";
import { openAgentSettings, useAgentHubStore } from "../../store/agentHubStore";
import { runTerminalLogin } from "../../store/acpStore";
import { modKey } from "./keys";
import { runCommandById } from "../../lib/shortcuts";
import { paletteCommands } from "../CommandPalette/CommandPalette";

/** Whether a palette command exists (another integration may provide it). */
function hasCommand(id: string): boolean {
  try {
    return paletteCommands().some((command) => command.id === id);
  } catch {
    return false;
  }
}

const KIND_ICONS: Record<string, typeof FileText> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ListChecks,
  other: Wrench,
};

const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

async function openAt(path: string, line?: number | null) {
  await useTabsStore.getState().openFile(path);
  if (line) revealPosition(path, line);
}

/** The thread's items, in order. */
export function ThreadItems({ thread }: { thread: Thread }) {
  const running = thread.status === "running";
  const lastAssistant = useMemo(() => {
    for (let index = thread.items.length - 1; index >= 0; index--) if (thread.items[index].kind === "assistant") return thread.items[index].id;
    return null;
  }, [thread.items]);
  const tail = thread.items[thread.items.length - 1];
  return (
    <>
      {thread.items.map((item) => (
        <ItemView key={item.id} item={item} thread={thread} streaming={running && item.id === lastAssistant && tail?.id === item.id} />
      ))}
      {running && <Working thread={thread} />}
    </>
  );
}

/** "Working…" with the turn's time, unless something visibly streams. */
function Working({ thread }: { thread: Thread }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const last = thread.items[thread.items.length - 1];
  const waiting = last?.kind === "tool" && last.tool.permission && !last.tool.permission.chosen;
  if (waiting) return null;
  const busy = last?.kind === "thought" && !last.endedAt;
  if (busy) return null;
  const elapsed = thread.turnStartedAt ? formatDuration(now - thread.turnStartedAt) : "";
  return (
    <div className="acp-working">
      <span className="acp-working-dots">
        <i />
        <i />
        <i />
      </span>
      <span>{last?.kind === "tool" && last.tool.status !== "completed" ? "Working" : "Thinking"}</span>
      {elapsed && <span className="acp-working-time">{elapsed}</span>}
    </div>
  );
}

const ItemView = memo(function ItemView({ item, thread, streaming }: { item: ThreadItem; thread: Thread; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} mentions={item.mentions} images={item.images} />;
    case "assistant":
      if (!item.text) return null;
      return (
        <div className={streaming ? "acp-assistant streaming" : "acp-assistant"}>
          <Markdown source={item.text} />
        </div>
      );
    case "thought":
      return <Thought text={item.text} startedAt={item.startedAt} endedAt={item.endedAt} />;
    case "tool":
      return <ToolCard tool={item.tool} thread={thread} />;
    case "notice":
      return <Notice tone={item.tone} title={item.title} text={item.text} />;
    case "permission":
      return (
        <div className="acp-tool acp-tool-asking">
          <div className="acp-tool-header">
            <ShieldQuestion size={14} className="acp-tool-icon" />
            <span className="acp-tool-title">{item.title}</span>
          </div>
          <PermissionBar threadId={thread.id} agentId={thread.agentId} permission={item.permission} />
        </div>
      );
    case "elicitation":
      return <ElicitationCard threadId={thread.id} item={item} />;
    case "auth":
      return <AuthCard thread={thread} message={item.message} reason={item.reason} />;
  }
});

function UserMessage({ text, mentions, images }: { text: string; mentions: Mention[]; images: { mimeType: string; data: string; name: string }[] }) {
  return (
    <div className="acp-user">
      {(mentions.length > 0 || images.length > 0) && (
        <div className="acp-user-context">
          {mentions.map((mention, index) => (
            <button key={index} className="acp-pill" title={mention.path} onClick={() => mention.kind !== "folder" && void openAt(mention.path, mention.startLine)}>
              {mention.kind === "selection" ? <FileCode2 size={11} /> : <FileText size={11} />}
              {mention.label}
            </button>
          ))}
          {images.map((image, index) => (
            <img key={`img-${index}`} className="acp-user-image" src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
          ))}
        </div>
      )}
      {text && <div className="acp-user-text">{text}</div>}
    </div>
  );
}

function Thought({ text, startedAt, endedAt }: { text: string; startedAt: number; endedAt?: number }) {
  const expandedByDefault = useSetting("agents.thinkingExpanded");
  const [open, setOpen] = useState<boolean | null>(null);
  const thinking = !endedAt;
  const expanded = open ?? expandedByDefault;
  if (!text.trim() && !thinking) return null;
  return (
    <div className={`acp-thought${thinking ? " active" : ""}`}>
      <button className="acp-thought-header" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <Brain size={13} />
        <span className={thinking ? "acp-shimmer" : undefined}>{thinking ? "Thinking" : `Thought for ${formatDuration(endedAt - startedAt)}`}</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && text.trim() && (
        <div className="acp-thought-body">
          <Markdown source={text} />
        </div>
      )}
    </div>
  );
}

function Notice({ tone, title, text }: { tone: "info" | "warning" | "error"; title: string; text?: string }) {
  const Icon = tone === "error" ? CircleAlert : tone === "warning" ? TriangleAlert : Info;
  return (
    <div className={`acp-notice ${tone}`}>
      <Icon size={13} />
      <div>
        <div className="acp-notice-title">{title}</div>
        {text && <div className="acp-notice-text">{text}</div>}
      </div>
    </div>
  );
}

// --- Tool calls ----------------------------------------------------------------------------------

function StatusMark({ tool }: { tool: ToolState }) {
  if (tool.cancelled && tool.status !== "completed" && tool.status !== "failed") return <span className="acp-tag">Cancelled</span>;
  if (tool.permission && !tool.permission.chosen) return <span className="acp-tag asking">Needs approval</span>;
  if (tool.permission?.chosen && isReject(tool.permission)) return <span className="acp-tag rejected">Rejected</span>;
  switch (tool.status) {
    case "pending":
    case "in_progress":
      return <Loader2 size={12} className="spinning acp-status-running" />;
    case "completed":
      return <Check size={12} className="acp-status-ok" />;
    case "failed":
      return <X size={12} className="acp-status-failed" />;
  }
}

function isReject(permission: PermissionState) {
  const chosen = permission.options.find((option) => option.optionId === permission.chosen);
  return permission.chosen === "cancelled" || (chosen ? chosen.kind.startsWith("reject") : false);
}

function commandOf(tool: ToolState): string | null {
  const input = tool.rawInput as { command?: unknown; cmd?: unknown } | undefined;
  const command = input?.command ?? input?.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.join(" ");
  return null;
}

export function ToolCard({ tool, thread }: { tool: ToolState; thread: Thread }) {
  const asking = Boolean(tool.permission && !tool.permission.chosen);
  const hasDiff = tool.content.some((entry) => entry.type === "diff");
  const hasTerminal = tool.content.some((entry) => entry.type === "terminal") || Boolean(tool.terminalId);
  const defaultOpen = asking || hasDiff || hasTerminal || tool.kind === "execute";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? defaultOpen;
  const Icon = KIND_ICONS[tool.kind] ?? Wrench;
  const running = tool.status === "pending" || tool.status === "in_progress";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running || tool.cancelled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, tool.cancelled]);
  const elapsed = (tool.endedAt ?? now) - tool.startedAt;
  const command = tool.kind === "execute" ? commandOf(tool) : null;
  const location = tool.locations[0];
  const title = tool.title || "Tool call";
  const textContent = tool.content.filter((entry): entry is Extract<ToolCallContent, { type: "content" }> => entry.type === "content");
  const showBody = expanded && (tool.content.length > 0 || command || tool.terminalId || asking);
  return (
    <div className={`acp-tool kind-${tool.kind}${asking ? " acp-tool-asking" : ""}${tool.status === "failed" ? " failed" : ""}`}>
      <div className="acp-tool-header" onClick={() => setOpen(!expanded)} role="button" aria-expanded={expanded}>
        <Icon size={13} className="acp-tool-icon" />
        <span className="acp-tool-title" title={title}>
          {title}
        </span>
        {location && tool.kind !== "edit" && (
          <button
            className="acp-tool-location"
            title={`Open ${location.path}`}
            onClick={(event) => {
              event.stopPropagation();
              void openAt(location.path, location.line);
            }}
          >
            {baseName(location.path)}
            {location.line ? `:${location.line}` : ""}
          </button>
        )}
        <span className="acp-tool-meta">
          {(!running || tool.endedAt) && elapsed >= 300 && <span className="acp-duration">{formatDuration(elapsed)}</span>}
          <StatusMark tool={tool} />
        </span>
        {(tool.content.length > 0 || command || tool.terminalId) && (expanded ? <ChevronDown size={12} className="acp-chevron" /> : <ChevronRight size={12} className="acp-chevron" />)}
      </div>
      {showBody && (
        <div className="acp-tool-body">
          {command && !hasTerminal && <pre className="acp-command">$ {command}</pre>}
          {tool.content.map((entry, index) => {
            if (entry.type === "diff") return <DiffBlock key={index} path={entry.path} oldText={entry.oldText ?? null} newText={entry.newText} thread={tool.status === "completed" ? thread : undefined} />;
            if (entry.type === "terminal") return <TerminalBlock key={index} terminalId={entry.terminalId} command={command} />;
            return null;
          })}
          {tool.terminalId && !tool.content.some((entry) => entry.type === "terminal") && <TerminalBlock terminalId={tool.terminalId} command={command} />}
          {textContent.map((entry, index) => (
            <ToolText key={`t-${index}`} block={entry.content} failed={tool.status === "failed"} />
          ))}
        </div>
      )}
      {asking && tool.permission && <PermissionBar threadId={thread.id} agentId={thread.agentId} permission={tool.permission} />}
    </div>
  );
}

function ToolText({ block, failed }: { block: Extract<ToolCallContent, { type: "content" }>["content"]; failed: boolean }) {
  if (block.type === "image") return <img className="acp-tool-image" src={`data:${block.mimeType};base64,${block.data}`} alt="" />;
  if (block.type === "resource_link") return <div className="acp-tool-text">{block.name}</div>;
  if (block.type !== "text") return null;
  const text = block.text.trim();
  if (!text) return null;
  if (/^```/.test(text) || text.includes("\n```")) return <div className="acp-tool-markdown"><Markdown source={stripAnsi(text)} /></div>;
  return <pre className={failed ? "acp-tool-output failed" : "acp-tool-output"}>{stripAnsi(text.length > 12000 ? `${text.slice(0, 12000)}\n…` : text)}</pre>;
}

export function DiffBlock({ path, oldText, newText, thread }: { path: string; oldText: string | null; newText: string; thread?: Thread }) {
  const [collapsed, setCollapsed] = useState(false);
  const { rows, stats } = useMemo(() => {
    const a = splitLines(oldText ?? "");
    const b = splitLines(newText);
    const changes = diffLines(a, b);
    return { rows: hunks(a, b, changes, 2), stats: diffStats(changes) };
  }, [oldText, newText]);
  const inReview = Boolean(thread?.review[path]);
  const created = oldText === null || oldText === undefined;
  const shown = collapsed ? [] : rows;
  const total = rows.reduce((sum, hunk) => sum + hunk.rows.length, 0);
  const [all, setAll] = useState(false);
  const limit = all ? Infinity : 80;
  let budget = limit;
  return (
    <div className="acp-diff">
      <div className="acp-diff-header">
        <button className="acp-diff-file" title={path} onClick={() => void openAt(path, rows[0]?.newStart)}>
          <FileText size={12} />
          <span className="acp-diff-name">{baseName(path)}</span>
          <span className="acp-diff-dir">{workspaceRelativePath(path).replace(/[^/\\]*$/, "")}</span>
        </button>
        {created && <span className="acp-tag new">New</span>}
        <span className="acp-diff-stats">
          {stats.added > 0 && <span className="added">+{stats.added}</span>}
          {stats.removed > 0 && <span className="removed">−{stats.removed}</span>}
        </span>
        {inReview && thread && (
          <button className="acp-diff-action" title="Review this file's changes in the diff view" onClick={() => openAgentDiff(thread.id, path)}>
            Review
          </button>
        )}
        <button className="acp-diff-action icon" title={collapsed ? "Show the diff" : "Hide the diff"} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>
      {!collapsed && (
        <div className="acp-diff-rows">
          {shown.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className="acp-hunk">
              {hunkIndex > 0 && <div className="acp-hunk-gap">⋯</div>}
              {hunk.rows.map((row, rowIndex) => {
                if (budget-- <= 0) return null;
                return (
                  <div key={rowIndex} className={`acp-diff-row ${row.kind}`}>
                    <span className="acp-diff-sign">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
                    <span className="acp-diff-text">{row.text || " "}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {total > limit && (
            <button className="acp-diff-more" onClick={() => setAll(true)}>
              Show {total - limit} more lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function openAgentDiff(threadId: string, path: string) {
  useTabsStore.getState().openDiff({ kind: "agent", filePath: path, threadId });
}

function TerminalBlock({ terminalId, command }: { terminalId: string; command: string | null }) {
  const terminal = useAcpStore((state) => state.terminals[terminalId]);
  const output = stripAnsi(terminal?.output ?? "");
  const exit = terminal?.exit;
  const shownCommand = terminal?.command ?? command;
  const lines = output.split("\n");
  const [all, setAll] = useState(false);
  const tooLong = lines.length > 40 && !all;
  return (
    <div className="acp-terminal">
      {shownCommand && (
        <div className="acp-terminal-command">
          <span className="acp-terminal-prompt">$</span> {shownCommand}
        </div>
      )}
      {output.trim() ? (
        <pre className="acp-terminal-output">{tooLong ? lines.slice(-40).join("\n") : output.replace(/\n$/, "")}</pre>
      ) : (
        !exit && <div className="acp-terminal-empty">Running…</div>
      )}
      <div className="acp-terminal-footer">
        {tooLong && (
          <button className="acp-link" onClick={() => setAll(true)}>
            Show all {lines.length} lines
          </button>
        )}
        {exit ? (
          <span className={exit.exitCode === 0 ? "acp-exit ok" : "acp-exit failed"}>{exit.signal ? `Killed (${exit.signal})` : `Exit ${exit.exitCode ?? "?"}`}</span>
        ) : (
          <Loader2 size={11} className="spinning" />
        )}
      </div>
    </div>
  );
}

// --- Permission prompts ----------------------------------------------------------------------------

const ORDER: Record<string, number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 };

export function sortedOptions(options: PermissionOption[]): PermissionOption[] {
  return [...options].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
}

/** The shortcut for an option: ⌘⏎ allow once, ⌥⌘⏎ always, ⌘⌫ reject. */
export function shortcutFor(option: PermissionOption): string | null {
  if (option.kind === "allow_once") return `${modKey()}⏎`;
  if (option.kind === "allow_always") return `⌥${modKey()}⏎`;
  if (option.kind === "reject_once") return `${modKey()}⌫`;
  return null;
}

function PermissionBar({ threadId, agentId, permission }: { threadId: string; agentId: string; permission: PermissionState }) {
  const respond = useAcpStore((state) => state.respondPermission);
  const name = agentName(agentId);
  if (permission.chosen) return null;
  const options = sortedOptions(permission.options);
  return (
    <div className="acp-permission" data-permission={permission.key}>
      <span className="acp-permission-question">
        <ShieldQuestion size={13} /> Allow {name} to do this?
      </span>
      <div className="acp-permission-actions">
        {options.map((option, index) => {
          const shortcut = shortcutFor(option);
          const reject = option.kind.startsWith("reject");
          return (
            <button
              key={option.optionId}
              className={index === 0 && !reject ? "acp-button primary" : reject ? "acp-button danger-ghost" : "acp-button"}
              autoFocus={index === 0}
              onClick={() => respond(threadId, permission.key, option.optionId)}
              title={shortcut ?? undefined}
            >
              {option.name}
              {shortcut && <kbd>{shortcut}</kbd>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Sign-in and questions ---------------------------------------------------------------------------

/** Anthropic doesn't let third-party apps use claude.ai plans: say so, and offer the alternatives. */
function SubscriptionNotSupported() {
  return (
    <div className="acp-auth-text">
      Claude Agent in Sable can't use a Claude Pro/Max/Team subscription: Anthropic doesn't allow third-party apps to sign in with claude.ai or use plan
      credentials. Use an Anthropic API key or Console account, Amazon Bedrock, Google Vertex AI, Microsoft Foundry or a gateway instead — or switch to
      Claude Code (your installed claude CLI), which can use your subscription.
    </div>
  );
}

function AuthCard({ thread, message, reason }: { thread: Thread; message: string; reason?: string }) {
  const connection = useAcpStore((state) => state.connections[thread.agentId]);
  const authenticate = useAcpStore((state) => state.authenticate);
  const providers = useAgentHubStore((state) => state.providers[thread.agentId]);
  const config = useAgentHubStore((state) => state.config[thread.agentId]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  useEffect(() => {
    if (!providers) void useAgentHubStore.getState().loadAuth(thread.agentId);
  }, [providers, thread.agentId]);
  const name = agentName(thread.agentId);
  const methods: AuthMethod[] = connection?.authMethods ?? [];
  const busy = thread.status === "connecting" || Boolean(connection?.authenticating);
  const provider = providers?.find((candidate) => candidate.id === config?.provider) ?? providers?.[0];
  const subscriptionOnly = reason === "claude_subscription_not_supported" || /claude\.ai subscription/i.test(message);
  // The agent's account login in a terminal (Cursor's `cursor-agent login`), for when its browser sign-in can't run here.
  const accountProvider = providers?.find((candidate) => candidate.account?.login && candidate.acpMethods?.length);
  const waiting = connection?.authenticating ? (authHint(thread.agentId, connection.authenticating)?.waiting ?? "Finish signing in in your browser…") : null;
  const ordered = [...methods].sort((a, b) => Number(Boolean(authHint(thread.agentId, a.id)?.settings)) - Number(Boolean(authHint(thread.agentId, b.id)?.settings)));
  const signInInTerminal = async () => {
    setTerminalBusy(true);
    try {
      await runTerminalLogin(thread.agentId, { action: "login", provider: accountProvider?.id });
    } finally {
      setTerminalBusy(false);
    }
    await useAcpStore.getState().disconnect(thread.agentId);
    await useAcpStore.getState().retry(thread.id);
  };
  return (
    <div className="acp-auth" data-agent={thread.agentId}>
      <div className="acp-auth-title">
        <KeyRound size={14} /> Sign in to {name}
      </div>
      {subscriptionOnly ? (
        <SubscriptionNotSupported />
      ) : (
        <div className="acp-auth-text">{message && !/^auth(entication)? required\.?$/i.test(message.trim()) ? message : `${name} needs you to sign in before it can work.`}</div>
      )}
      {provider && providers && providers.length > 1 && (
        <div className="acp-auth-using">
          Sign-in method: <strong>{provider.label}</strong>
          <button className="acp-link" onClick={() => openAgentSettings(thread.agentId)}>
            Change
          </button>
        </div>
      )}
      <div className="acp-auth-methods">
        {ordered.map((method) => {
          const hint = authHint(thread.agentId, method.id);
          return (
            <button
              key={method.id}
              className={`acp-auth-method${hint?.settings ? " secondary" : ""}${connection?.authenticating === method.id ? " active" : ""}`}
              disabled={busy}
              data-method={method.id}
              onClick={() => void authenticate(thread.id, method)}
            >
              <span className="acp-auth-method-name">
                {hint?.label ?? method.name}
                {method.type === "terminal" && <span className="acp-tag">Opens a terminal</span>}
                {hint?.settings && <span className="acp-tag">Settings</span>}
              </span>
              {(hint?.description ?? method.description) && <span className="acp-auth-method-text">{(hint?.description ?? method.description ?? "").trim()}</span>}
            </button>
          );
        })}
      </div>
      {connection?.authError && (
        <div className="acp-auth-error" data-testid="acp-auth-error">
          <TriangleAlert size={13} />
          <span>{connection.authError}</span>
          {accountProvider && (
            <button className="acp-button" disabled={terminalBusy} onClick={() => void signInInTerminal()} data-testid="acp-auth-terminal">
              <SquareTerminal size={12} /> Sign in in a terminal
            </button>
          )}
        </div>
      )}
      <div className="acp-auth-footer">
        {waiting && (
          <span className="acp-auth-waiting">
            <Loader2 size={12} className="spinning" /> {waiting}
            <button className="acp-link" onClick={() => void useAcpStore.getState().cancelAuthenticate(thread.id)}>
              Cancel
            </button>
          </span>
        )}
        <button className="acp-link" onClick={() => openAgentSettings(thread.agentId)}>
          {ordered.some((method) => authHint(thread.agentId, method.id)?.settings) ? "Other sign-in methods…" : "Use an API key or another provider…"}
        </button>
        {subscriptionOnly && (
          <button className="acp-link" onClick={() => useAcpStore.getState().setPanelAgent("claude-code")}>
            Use Claude Code (your subscription)
          </button>
        )}
        {subscriptionOnly && hasCommand("sable.claudeCode.run") && (
          <button className="acp-link" onClick={() => runCommandById("sable.claudeCode.run")}>
            Open Claude Code in the terminal
          </button>
        )}
        <button className="acp-link" disabled={busy} onClick={() => void useAcpStore.getState().retry(thread.id)}>
          I've signed in — try again
        </button>
      </div>
    </div>
  );
}

function ElicitationCard({ threadId, item }: { threadId: string; item: Extract<ThreadItem, { kind: "elicitation" }> }) {
  const respond = useAcpStore((state) => state.respondElicitation);
  const { request, answered, key } = item.elicitation;
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(request.requestedSchema?.properties ?? {}).map(([name, property]) => [name, property.default ?? (property.type === "boolean" ? false : "")])),
  );
  let host = "";
  try {
    host = request.url ? new URL(request.url).host : "";
  } catch {
    host = request.url ?? "";
  }
  const code = request.mode === "url" ? deviceCode(request.message) : null;
  const [copied, setCopied] = useState(false);
  return (
    <div className={`acp-elicitation${answered ? " answered" : ""}${code ? " device" : ""}`} data-testid="acp-elicitation">
      <div className="acp-elicitation-message">{code ? request.message.replace(code, "").replace(/[:\s]+$/, "") : request.message}</div>
      {code && (
        <div className="acp-device-code">
          <code data-testid="acp-device-code">{code}</code>
          <button
            className="acp-icon-button"
            title="Copy the code"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {});
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      )}
      {request.mode === "url" && request.url && (
        <div className="acp-elicitation-url">
          <Globe size={12} /> {host}
        </div>
      )}
      {request.mode === "form" &&
        Object.entries(request.requestedSchema?.properties ?? {}).map(([name, property]) => (
          <label key={name} className="acp-elicitation-field">
            <span>{property.title ?? name}</span>
            {property.enum ? (
              <select value={String(values[name] ?? "")} disabled={Boolean(answered)} onChange={(event) => setValues({ ...values, [name]: event.target.value })}>
                {property.enum.map((choice) => (
                  <option key={choice}>{choice}</option>
                ))}
              </select>
            ) : property.type === "boolean" ? (
              <input type="checkbox" checked={Boolean(values[name])} disabled={Boolean(answered)} onChange={(event) => setValues({ ...values, [name]: event.target.checked })} />
            ) : (
              <input
                value={String(values[name] ?? "")}
                disabled={Boolean(answered)}
                onChange={(event) => setValues({ ...values, [name]: property.type === "number" || property.type === "integer" ? Number(event.target.value) : event.target.value })}
              />
            )}
          </label>
        ))}
      {answered ? (
        <div className="acp-elicitation-done">
          {item.elicitation.completed ? (
            <>
              <Check size={12} /> Done
            </>
          ) : answered === "accept" ? (
            request.mode === "url" ? (code ? "Opened in your browser — enter the code there" : "Opened in your browser") : "Sent"
          ) : (
            "Declined"
          )}
        </div>
      ) : (
        <div className="acp-permission-actions">
          <button className="acp-button primary" onClick={() => respond(threadId, key, request.mode === "url" ? { action: "accept" } : { action: "accept", content: values })}>
            {request.mode === "url" ? (
              <>
                Open {host} <ExternalLink size={11} />
              </>
            ) : (
              "Submit"
            )}
          </button>
          <button className="acp-button" onClick={() => respond(threadId, key, { action: "decline" })}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

// --- The plan ----------------------------------------------------------------------------------------

export function PlanCard({ thread }: { thread: Thread }) {
  const [toggled, setOpen] = useState<boolean | null>(null);
  const entries = thread.plan;
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  // A finished plan folds away (open it to look back).
  const open = toggled ?? done < entries.length;
  const current = entries.find((entry) => entry.status === "in_progress");
  return (
    <div className="acp-plan">
      <button className="acp-plan-header" onClick={() => setOpen(!open)}>
        <ListChecks size={13} />
        <span className="acp-plan-title">Plan</span>
        <span className="acp-plan-progress">
          {done} of {entries.length}
        </span>
        <span className="acp-plan-bar">
          <span style={{ width: `${(done / entries.length) * 100}%` }} />
        </span>
        {!open && current && <span className="acp-plan-current">{current.content}</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <ol className="acp-plan-entries">
          {entries.map((entry, index) => (
            <li key={index} className={`acp-plan-entry ${entry.status}`}>
              {entry.status === "completed" ? <CircleCheck size={13} /> : entry.status === "in_progress" ? <CircleDot size={13} /> : <Circle size={13} />}
              <span>{entry.content}</span>
              {entry.priority === "high" && entry.status !== "completed" && <span className="acp-tag">High</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** For the empty state: who's signed in (Claude's `_auth/status_update`). */
export function AccountLine({ agentId }: { agentId: string }) {
  const account = useAcpStore((state) => state.connections[agentId]?.account);
  const status = useAgentHubStore((state) => state.account[agentId]?.status as { email?: string; subscriptionType?: string; loggedIn?: boolean } | null | undefined);
  const checked = useAgentHubStore((state) => Boolean(state.account[agentId]));
  useEffect(() => {
    if (agentId === "claude-code" && !checked) void useAgentHubStore.getState().checkAccount(agentId);
  }, [agentId, checked]);
  // Claude Agent's "account" is a claude.ai plan it can't use: don't present it.
  // ("none": the agent says it's signed out.) Codex's "account" is ChatGPT.
  const usable = account && account.kind !== "none" && !(agentId === "claude-acp" && account.kind === "account");
  const label = usable ? `${account.label}${account.account?.email ? ` · ${account.account.email}` : account.detail ? ` · ${account.detail}` : ""}` : status?.loggedIn && (agentId === "claude-code" || !status.subscriptionType) ? `Signed in${status.email ? ` · ${status.email}` : ""}` : null;
  if (!label) return null;
  return (
    <div className="acp-account">
      <span className="acp-account-dot" /> {label}
    </div>
  );
}
