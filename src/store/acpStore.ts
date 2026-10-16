import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { JsonRpcPeer, RpcError } from "../lib/acp/connection";
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  ErrorCode,
  PROTOCOL_VERSION,
  type AuthMethod,
  type AvailableCommand,
  type ContentBlock,
  type CreateTerminalRequest,
  type ElicitationRequest,
  type ElicitationResponse,
  type InitializeResponse,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PlanEntry,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallLocation,
  type Usage,
  type WriteTextFileRequest,
} from "../lib/acp/protocol";
import {
  acpRegistryCache,
  agentDisplayName,
  openAgentSettings,
  useAgentHubStore,
} from "./agentHubStore";
import {
  acpSend,
  acpStart,
  acpStop,
  acpTerminalCreate,
  acpTerminalKill,
  acpTerminalOutput,
  acpTerminalRelease,
  acpTerminalSpec,
  acpTerminalWait,
  acpThreadsLoad,
  acpThreadsSave,
  onAcpEvent,
} from "../lib/acp/ipc";
import { authHint, explainAgentError, profileFor, SABLE_AGENT_ID } from "../lib/acp/agents";
import { readCurrentText, writeFileContents } from "../lib/fileContents";
import { createDirectory, deletePath, pathExists } from "../lib/ipc";
import { getModelValue, hasModel, isModelDirty, markSaved, replaceModelContent, revealPosition } from "../lib/editorRegistry";
import { useWorkspaceStore } from "./workspaceStore";
import { useTabsStore } from "./tabsStore";
import { useTerminalStore } from "./terminalStore";
import { useUiStore } from "./uiStore";
import { getSetting } from "./settingsStore";
import { useGitStore } from "./gitStore";
import { diffLines, joinLines, splitLines, acceptChange, rejectChange } from "../lib/acp/lineDiff";

/**
 * External coding agents (Claude Agent, Codex, …) over ACP: connections
 * (one agent process per agent per window), threads (an ACP session each),
 * and everything the client side of the protocol does — permission
 * prompts, files read and written through the editor, terminals, the edit
 * review. The panel (components/Agents) renders this state.
 */

// --- Thread model ---------------------------------------------------------------------------

export interface Mention {
  kind: "file" | "folder" | "symbol" | "selection";
  path: string;
  /** Shown on the chip / pill. */
  label: string;
  /** For symbols and selections: 1-based lines. */
  startLine?: number;
  endLine?: number;
  /** The selected text (selection chips). */
  text?: string;
}

export interface PromptImage {
  mimeType: string;
  data: string;
  name: string;
}

export interface PromptInput {
  text: string;
  mentions: Mention[];
  images: PromptImage[];
}

export interface PermissionState {
  key: string;
  options: PermissionOption[];
  /** The option picked, or "cancelled". */
  chosen?: string;
}

export interface ToolState {
  toolCallId: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  startedAt: number;
  endedAt?: number;
  permission?: PermissionState;
  /** Claude Agent's display terminal (`_meta.terminal_info`), by id. */
  terminalId?: string;
  cancelled?: boolean;
}

export interface ElicitationState {
  key: string;
  request: ElicitationRequest;
  answered?: "accept" | "decline" | "cancel";
  /** The agent said the URL flow finished (`elicitation/complete`). */
  completed?: boolean;
}

export type ThreadItem =
  | { kind: "user"; id: string; text: string; mentions: Mention[]; images: PromptImage[] }
  | { kind: "assistant"; id: string; text: string; messageId?: string | null }
  | { kind: "thought"; id: string; text: string; startedAt: number; endedAt?: number }
  | { kind: "tool"; id: string; tool: ToolState }
  | { kind: "notice"; id: string; tone: "info" | "warning" | "error"; title: string; text?: string }
  | { kind: "permission"; id: string; title: string; permission: PermissionState }
  | { kind: "elicitation"; id: string; elicitation: ElicitationState }
  | { kind: "auth"; id: string; message: string; reason?: string };

export interface ReviewEntry {
  /** Text before the agent's first change (null: the agent created it). */
  original: string | null;
  /** When the agent last touched it. */
  touchedAt: number;
}

export type ThreadStatus = "connecting" | "idle" | "running" | "auth" | "error" | "loading";

export interface Thread {
  id: string;
  agentId: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  items: ThreadItem[];
  plan: PlanEntry[];
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  /** Context window use (usage_update). */
  context: { used: number; size: number; cost?: { amount: number; currency: string } | null } | null;
  /** Tokens across this thread's turns (PromptResponse.usage). */
  tokens: { input: number; output: number; cached: number };
  status: ThreadStatus;
  error?: string;
  /** A saved transcript reopened without the agent: read only. */
  readOnly: boolean;
  /** The agent's edits not yet accepted or rejected, by path. */
  review: Record<string, ReviewEntry>;
  turnStartedAt?: number;
  /** The connection epoch the session belongs to (a restarted agent needs it reloaded). */
  epoch: number;
}

export interface ConnectionState {
  agentId: string;
  status: "starting" | "ready" | "exited" | "error";
  error?: string;
  init?: InitializeResponse;
  authMethods: AuthMethod[];
  /** Claude's `_auth/status_update` (who's signed in), when sent. */
  account?: { kind: string; label: string; detail?: string; account?: { email?: string; plan?: string; organization?: string } };
  stderr: string[];
  epoch: number;
  /** An `authenticate` in progress. */
  authenticating?: string;
  /** Why the last `authenticate` failed (for the sign-in card). */
  authError?: string;
}

export interface TerminalOutputState {
  output: string;
  exit?: { exitCode: number | null; signal: string | null };
  command?: string;
}

/** A transcript kept by Sable (reopened read-only, or reloaded from the agent). */
export interface SavedThread {
  id: string;
  agentId: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  items: ThreadItem[];
  plan: PlanEntry[];
}

interface AcpState {
  /** Which agent the right-hand panel shows: "sable" or an agent id. */
  panelAgent: string;
  connections: Record<string, ConnectionState>;
  threads: Record<string, Thread>;
  /** Open thread tabs, in order. */
  openThreadIds: string[];
  activeThreadId: string | null;
  historyOpen: boolean;
  saved: SavedThread[];
  /** Sessions the agent lists (session/list), by agent. */
  agentSessions: Record<string, SessionInfo[]>;
  terminals: Record<string, TerminalOutputState>;
  /** Text for the composer to take (Send selection, Explain…). */
  composerRequest: { threadId: string; text: string; mentions: Mention[]; send: boolean; nonce: number } | null;

  setPanelAgent: (agentId: string) => void;
  setHistoryOpen: (open: boolean) => void;
  connect: (agentId: string) => Promise<ConnectionState>;
  disconnect: (agentId: string) => Promise<void>;
  newThread: (agentId: string) => Promise<string>;
  /** The agent's open thread, or a new one (once, however often it's asked). */
  ensureThread: (agentId: string) => void;
  activateThread: (threadId: string) => void;
  closeThread: (threadId: string) => void;
  send: (threadId: string, input: PromptInput) => Promise<void>;
  cancel: (threadId: string) => void;
  setConfigOption: (threadId: string, configId: string, value: string | boolean) => Promise<void>;
  setMode: (threadId: string, modeId: string) => Promise<void>;
  respondPermission: (threadId: string, key: string, optionId: string) => void;
  respondElicitation: (threadId: string, key: string, response: ElicitationResponse) => void;
  authenticate: (threadId: string, method: AuthMethod) => Promise<void>;
  /** Stop a browser sign-in that's waiting (the agent restarts). */
  cancelAuthenticate: (threadId: string) => Promise<void>;
  /** Sign out through the agent's ACP `logout` (Kimi Code). */
  logout: (agentId: string) => Promise<void>;
  retry: (threadId: string) => Promise<void>;
  loadSaved: () => Promise<void>;
  openSaved: (saved: SavedThread) => Promise<void>;
  deleteSaved: (id: string) => void;
  listAgentSessions: (agentId: string) => Promise<void>;
  openAgentSession: (agentId: string, session: SessionInfo) => Promise<void>;
  acceptFile: (threadId: string, path: string) => void;
  rejectFile: (threadId: string, path: string) => Promise<void>;
  acceptAll: (threadId?: string) => void;
  rejectAll: (threadId?: string) => Promise<void>;
  acceptHunk: (threadId: string, path: string, changeIndex: number) => Promise<void>;
  rejectHunk: (threadId: string, path: string, changeIndex: number) => Promise<void>;
  /** Put text (and context) in the composer; `send` sends it right away. */
  ask: (text: string, mentions: Mention[], options?: { send?: boolean; agentId?: string }) => Promise<void>;
}

// --- Module state (not in the store: peers, resolvers) ----------------------------------------

const peers = new Map<string, { peer: JsonRpcPeer; instance: number; unsubscribe: () => void }>();
const connecting = new Map<string, Promise<ConnectionState>>();
const permissionResolvers = new Map<string, (outcome: RequestPermissionOutcome) => void>();
const elicitationResolvers = new Map<string, (response: ElicitationResponse) => void>();
const ensuring = new Set<string>();
/** The thread an agent's `authenticate` runs for (its elicitations show there). */
const authThreads = new Map<string, string>();
/** Agents whose waiting `authenticate` the user stopped. */
const cancelledAuth = new Set<string>();
/** A prompt refused for want of sign-in, sent again once signed in. */
const retryAfterAuth = new Map<string, PromptInput>();
/** Threads whose session/load replay is suppressed (they already have it). */
const replaySuppressed = new Set<string>();

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const PANEL_AGENT_KEY = "sable.agents.panelAgent";

function readPanelAgent(): string {
  try {
    return localStorage.getItem(PANEL_AGENT_KEY) ?? SABLE_AGENT_ID;
  } catch {
    return SABLE_AGENT_ID;
  }
}

const fileUri = (path: string) => `file://${encodeURI(path.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

function errorText(error: unknown): string {
  if (error instanceof RpcError) {
    const data = typeof error.data === "object" && error.data ? (error.data as { details?: unknown; message?: unknown }) : {};
    // Generic JSON-RPC messages ("Invalid params") carry the real one in data.message (Cursor).
    if (typeof data.message === "string" && data.message.trim() && data.message !== error.message) {
      return /^(invalid params|internal error|authentication required)$/i.test(error.message.trim()) ? data.message : `${error.message}: ${data.message}`;
    }
    const detail = data.details !== undefined ? ` (${String(data.details)})` : "";
    return `${error.message}${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const isAuthError = (error: unknown) => error instanceof RpcError && error.code === ErrorCode.authRequired;

/** The Sable sign-in method the agent runs with. */
function currentProvider(agentId: string): string | undefined {
  const hub = useAgentHubStore.getState();
  return hub.config[agentId]?.provider ?? hub.providers[agentId]?.[0]?.id ?? undefined;
}

/** A session-level failure: the sign-in card (with the agent's own words for it), or an error. */
function sessionFailed(threadId: string, agentId: string, error: unknown) {
  const text = errorText(error);
  const explained = explainAgentError(agentId, text, currentProvider(agentId));
  if (isAuthError(error) || explained?.auth) showAuth(threadId, explained?.message ?? text, error);
  else updateThread(threadId, () => ({ status: "error", error: explained?.message ?? text }));
}

function client() {
  return useAcpStore.getState();
}

function updateThread(threadId: string, update: (thread: Thread) => Partial<Thread> | null) {
  useAcpStore.setState((state) => {
    const thread = state.threads[threadId];
    if (!thread) return {};
    const patch = update(thread);
    if (!patch) return {};
    return { threads: { ...state.threads, [threadId]: { ...thread, ...patch } } };
  });
}

function updateConnection(agentId: string, patch: Partial<ConnectionState>) {
  useAcpStore.setState((state) => {
    const current = state.connections[agentId] ?? { agentId, status: "starting", authMethods: [], stderr: [], epoch: 0 };
    return { connections: { ...state.connections, [agentId]: { ...current, ...patch } } };
  });
}

function threadForSession(agentId: string, sessionId: string): Thread | undefined {
  return Object.values(client().threads).find((thread) => thread.agentId === agentId && thread.sessionId === sessionId);
}

function pushItem(threadId: string, item: ThreadItem) {
  updateThread(threadId, (thread) => ({ items: [...thread.items, item], updatedAt: Date.now() }));
}

function notice(threadId: string, tone: "info" | "warning" | "error", title: string, text?: string) {
  pushItem(threadId, { kind: "notice", id: uid("notice"), tone, title, text });
}

// --- Persistence (Sable-side transcripts per workspace) ---------------------------------------

const MAX_SAVED = 60;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** A thread for saving: tool outputs trimmed, live state dropped. */
function toSaved(thread: Thread): SavedThread {
  const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…` : text);
  const items = thread.items
    .filter((item) => item.kind !== "auth" && item.kind !== "elicitation")
    .map((item): ThreadItem => {
      if (item.kind !== "tool") return item;
      const content = item.tool.content.map((entry): ToolCallContent => {
        if (entry.type === "diff") return { ...entry, oldText: entry.oldText ? trim(entry.oldText, 20000) : entry.oldText, newText: trim(entry.newText, 20000) };
        if (entry.type === "content" && entry.content.type === "text") return { type: "content", content: { type: "text", text: trim(entry.content.text, 8000) } };
        return entry;
      });
      return { ...item, tool: { ...item.tool, content, rawInput: undefined, rawOutput: undefined, permission: item.tool.permission ? { ...item.tool.permission, chosen: item.tool.permission.chosen ?? "cancelled" } : undefined } };
    });
  return { id: thread.id, agentId: thread.agentId, sessionId: thread.sessionId, title: thread.title, cwd: thread.cwd, createdAt: thread.createdAt, updatedAt: thread.updatedAt, items, plan: thread.plan };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    const { threads, saved } = client();
    const live = Object.values(threads).filter((thread) => thread.cwd === root && !thread.readOnly && thread.items.some((item) => item.kind === "user"));
    const byId = new Map(saved.map((entry) => [entry.id, entry]));
    for (const thread of live) byId.set(thread.id, toSaved(thread));
    const all = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED);
    useAcpStore.setState({ saved: all });
    void acpThreadsSave(root, { version: 1, threads: all }).catch(() => {});
  }, 600);
}

// --- Editor-side helpers ---------------------------------------------------------------------

/** Remember a file's text before the agent changes it (once per review). */
async function snapshot(threadId: string, path: string, diff?: { oldText?: string | null; newText: string }) {
  const thread = client().threads[threadId];
  if (!thread || thread.review[path] !== undefined || pendingSnapshots.has(`${threadId}\u0000${path}`)) return;
  const key = `${threadId}\u0000${path}`;
  const read = (async () => {
    let original = await readCurrentText(path);
    // Too late (an edit that ran without asking): undo it on the copy.
    if (original !== null && diff && diff.oldText && diff.newText && original.includes(diff.newText) && !original.includes(diff.oldText)) {
      original = original.replace(diff.newText, diff.oldText);
    } else if (original !== null && diff && !diff.oldText && diff.newText && original === diff.newText) {
      original = null;
    }
    updateThread(threadId, (current) => (current.review[path] !== undefined ? null : { review: { ...current.review, [path]: { original, touchedAt: Date.now() } } }));
  })();
  pendingSnapshots.set(key, read);
  try {
    await read;
  } finally {
    pendingSnapshots.delete(key);
  }
}
const pendingSnapshots = new Map<string, Promise<void>>();

/** Paths a tool call changes (diffs, else its locations for edit kinds). */
function editedPaths(tool: Pick<ToolState, "kind" | "content" | "locations">): { path: string; diff?: { oldText?: string | null; newText: string } }[] {
  const out = new Map<string, { path: string; diff?: { oldText?: string | null; newText: string } }>();
  for (const entry of tool.content) {
    if (entry.type === "diff" && entry.path && !out.has(entry.path)) out.set(entry.path, { path: entry.path, diff: { oldText: entry.oldText, newText: entry.newText } });
  }
  if (["edit", "delete", "move"].includes(tool.kind)) {
    for (const location of tool.locations) if (location.path && !out.has(location.path)) out.set(location.path, { path: location.path });
  }
  return [...out.values()];
}

/** After the agent wrote a file itself: show the new text in an open editor. */
async function syncEditor(path: string, threadId: string) {
  const disk = await readCurrentTextFromDisk(path);
  if (disk === null) return;
  if (hasModel(path)) {
    const current = getModelValue(path);
    const original = client().threads[threadId]?.review[path]?.original;
    // Only replace what the user hasn't typed into since.
    if (current !== disk && (!isModelDirty(path) || current === original)) {
      replaceModelContent(path, disk);
      markSaved(path);
      useTabsStore.getState().syncDirtyState(path);
    }
  }
}

async function readCurrentTextFromDisk(path: string): Promise<string | null> {
  const { readFile } = await import("../lib/ipc");
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Follow along: show the file the agent is editing. */
function follow(path: string, line?: number | null) {
  if (!getSetting("agents.followAlong")) return;
  const tabs = useTabsStore.getState();
  void tabs.openFile(path).then(() => {
    if (line) revealPosition(path, line);
  });
}

// --- Building prompts ------------------------------------------------------------------------

async function promptBlocks(agentId: string, input: PromptInput): Promise<ContentBlock[]> {
  const capabilities = client().connections[agentId]?.init?.agentCapabilities?.promptCapabilities ?? {};
  const blocks: ContentBlock[] = [];
  if (input.text.trim()) blocks.push({ type: "text", text: input.text });
  for (const mention of input.mentions) {
    if (mention.kind === "folder") {
      blocks.push({ type: "resource_link", uri: fileUri(mention.path), name: mention.label, mimeType: "inode/directory" });
      continue;
    }
    const range = mention.startLine ? `#L${mention.startLine}${mention.endLine && mention.endLine !== mention.startLine ? `-${mention.endLine}` : ""}` : "";
    if (mention.kind === "selection" && mention.text !== undefined) {
      if (capabilities.embeddedContext) blocks.push({ type: "resource", resource: { uri: fileUri(mention.path) + range, text: mention.text, mimeType: "text/plain" } });
      else blocks.push({ type: "text", text: `\n${mention.label}:\n\`\`\`\n${mention.text}\n\`\`\`` });
      continue;
    }
    if (mention.kind === "file" && capabilities.embeddedContext) {
      const text = await readCurrentText(mention.path);
      if (text !== null && text.length <= 256 * 1024) {
        blocks.push({ type: "resource", resource: { uri: fileUri(mention.path), text, mimeType: "text/plain" } });
        continue;
      }
    }
    blocks.push({ type: "resource_link", uri: fileUri(mention.path) + range, name: mention.label });
  }
  for (const image of input.images) {
    if (capabilities.image) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

// --- Handling the agent's messages -------------------------------------------------------------

function applyUpdate(agentId: string, notification: SessionNotification) {
  const thread = threadForSession(agentId, notification.sessionId);
  if (!thread) return;
  if (replaySuppressed.has(thread.id)) {
    // A reloaded session's history: keep only state, not items.
    const update = notification.update as SessionUpdate & Record<string, unknown>;
    if (!["available_commands_update", "current_mode_update", "config_option_update", "usage_update", "session_info_update"].includes(update.sessionUpdate)) return;
  }
  const threadId = thread.id;
  const update = notification.update as SessionUpdate & Record<string, unknown>;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "user_message_chunk":
    case "agent_thought_chunk": {
      const content = update.content as ContentBlock;
      const text = content.type === "text" ? content.text : content.type === "resource_link" ? `[${content.name}](${content.uri})` : content.type === "image" ? "" : "";
      const messageId = (update.messageId as string | null | undefined) ?? null;
      updateThread(threadId, (current) => {
        const items = [...current.items];
        const last = items[items.length - 1];
        const now = Date.now();
        if (update.sessionUpdate === "agent_message_chunk") {
          if (last?.kind === "assistant" && (!messageId || !last.messageId || last.messageId === messageId)) items[items.length - 1] = { ...last, text: last.text + text, messageId: messageId ?? last.messageId };
          else items.push({ kind: "assistant", id: uid("msg"), text, messageId });
          // A message ends the thinking before it.
          closeThoughts(items, now);
        } else if (update.sessionUpdate === "agent_thought_chunk") {
          if (last?.kind === "thought" && !last.endedAt) items[items.length - 1] = { ...last, text: last.text + text };
          else items.push({ kind: "thought", id: uid("thought"), text, startedAt: now });
        } else {
          // History replay (session/load): the user's own messages.
          const image = content.type === "image" ? [{ mimeType: content.mimeType, data: content.data, name: "image" }] : [];
          if (last?.kind === "user" && (!messageId || last.id === messageId)) items[items.length - 1] = { ...last, text: last.text + text, images: [...last.images, ...image] };
          else items.push({ kind: "user", id: messageId ?? uid("user"), text, mentions: [], images: image });
        }
        const title = current.title === "New thread" && update.sessionUpdate === "user_message_chunk" && text.trim() ? titleFrom(text) : current.title;
        return { items, updatedAt: now, title };
      });
      return;
    }
    case "tool_call":
    case "tool_call_update":
      applyToolCall(threadId, update as unknown as ToolCall, update.sessionUpdate === "tool_call");
      return;
    case "plan":
      updateThread(threadId, () => ({ plan: (update.entries as PlanEntry[]) ?? [] }));
      return;
    case "plan_update": {
      const plan = update.plan as { type?: string; entries?: PlanEntry[] } | undefined;
      if (plan?.entries) updateThread(threadId, () => ({ plan: plan.entries ?? [] }));
      return;
    }
    case "plan_removed":
      updateThread(threadId, () => ({ plan: [] }));
      return;
    case "available_commands_update":
      updateThread(threadId, () => ({ commands: (update.availableCommands as AvailableCommand[]) ?? [] }));
      return;
    case "current_mode_update":
      updateThread(threadId, (current) => ({
        modes: current.modes ? { ...current.modes, currentModeId: update.currentModeId as string } : current.modes,
        configOptions: current.configOptions.map((option) => (option.category === "mode" && option.type === "select" ? { ...option, currentValue: update.currentModeId as string } : option)),
      }));
      return;
    case "config_option_update":
      updateThread(threadId, () => ({ configOptions: (update.configOptions as SessionConfigOption[]) ?? [] }));
      return;
    case "session_info_update":
      if (typeof update.title === "string" && update.title.trim()) updateThread(threadId, () => ({ title: (update.title as string).trim() }));
      return;
    case "usage_update":
      updateThread(threadId, () => ({ context: { used: update.used as number, size: update.size as number, cost: (update.cost as { amount: number; currency: string } | null) ?? null } }));
      return;
    case "notice": {
      const severity = String(update.severity ?? "info");
      notice(threadId, severity === "error" ? "error" : severity === "warning" ? "warning" : "info", String(update.title ?? ""), (update.description as string | undefined) ?? undefined);
      return;
    }
    case "compaction_update":
      if (update.status === "in_progress") notice(threadId, "info", "Compacting the conversation…");
      else if (update.status === "completed") notice(threadId, "info", "Conversation compacted");
      else if (update.status === "failed") notice(threadId, "warning", "Compaction failed", (update.error as string) ?? undefined);
      return;
    default:
      return; // Unknown kinds are tolerated (the protocol grows).
  }
}

function closeThoughts(items: ThreadItem[], now: number) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "thought" && !item.endedAt) items[index] = { ...item, endedAt: now };
    if (item.kind === "user") break;
  }
}

const titleFrom = (text: string) => {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New thread";
};

function applyToolCall(threadId: string, call: ToolCall, isNew: boolean) {
  const meta = (call._meta ?? {}) as Record<string, unknown>;
  const terminalInfo = meta.terminal_info as { terminal_id?: string } | undefined;
  const terminalOutput = (meta.terminal_output ?? meta.terminal_output_delta) as { terminal_id?: string; data?: string } | undefined;
  const terminalExit = meta.terminal_exit as { terminal_id?: string; exit_code?: number | null; signal?: string | null } | undefined;
  let finished: ToolState | null = null;
  let toSnapshot: { path: string; diff?: { oldText?: string | null; newText: string } }[] = [];
  updateThread(threadId, (thread) => {
    const items = [...thread.items];
    const index = items.findIndex((item) => item.kind === "tool" && item.tool.toolCallId === call.toolCallId);
    const now = Date.now();
    const previous = index >= 0 ? (items[index] as Extract<ThreadItem, { kind: "tool" }>).tool : null;
    const tool: ToolState = {
      toolCallId: call.toolCallId,
      title: call.title ?? previous?.title ?? "Tool call",
      kind: call.kind ?? previous?.kind ?? "other",
      status: (call.status ?? previous?.status ?? "pending") as ToolState["status"],
      content: call.content ?? previous?.content ?? [],
      locations: call.locations ?? previous?.locations ?? [],
      rawInput: call.rawInput !== undefined ? call.rawInput : previous?.rawInput,
      rawOutput: call.rawOutput !== undefined ? call.rawOutput : previous?.rawOutput,
      startedAt: previous?.startedAt ?? now,
      endedAt: previous?.endedAt,
      permission: previous?.permission,
      terminalId: terminalInfo?.terminal_id ?? terminalOutput?.terminal_id ?? previous?.terminalId,
      cancelled: previous?.cancelled,
    };
    if ((tool.status === "completed" || tool.status === "failed") && !tool.endedAt) {
      tool.endedAt = now;
      finished = tool;
    }
    if (index >= 0) items[index] = { kind: "tool", id: items[index].id, tool };
    else {
      closeThoughts(items, now);
      items.push({ kind: "tool", id: uid("tool"), tool });
    }
    toSnapshot = editedPaths(tool).filter((entry) => thread.review[entry.path] === undefined);
    return { items, updatedAt: now };
  });
  if (terminalOutput?.terminal_id) {
    const id = terminalOutput.terminal_id;
    useAcpStore.setState((state) => {
      const current = state.terminals[id] ?? { output: "" };
      const output = meta.terminal_output_delta ? current.output + (terminalOutput.data ?? "") : (terminalOutput.data ?? current.output);
      return { terminals: { ...state.terminals, [id]: { ...current, output } } };
    });
  }
  if (terminalExit?.terminal_id) {
    const id = terminalExit.terminal_id;
    useAcpStore.setState((state) => ({ terminals: { ...state.terminals, [id]: { ...(state.terminals[id] ?? { output: "" }), exit: { exitCode: terminalExit.exit_code ?? null, signal: terminalExit.signal ?? null } } } }));
  }
  const thread = client().threads[threadId];
  const replaying = replaySuppressed.has(threadId) || thread?.status === "loading";
  if (!replaying) for (const entry of toSnapshot) void snapshot(threadId, entry.path, entry.diff);
  const done = finished as ToolState | null;
  if (done && !replaying && done.status === "completed") {
    const paths = editedPaths(done);
    for (const { path } of paths) {
      void (async () => {
        await pendingSnapshots.get(`${threadId}\u0000${path}`);
        await syncEditor(path, threadId);
        reconcileReview(threadId, path);
      })();
    }
    if (paths.length) {
      const first = done.locations.find((location) => location.path === paths[0].path);
      follow(paths[0].path, first?.line ?? null);
      useGitStore.getState().refresh();
    }
  }
  void isNew;
}

/** Drop a review entry whose file is back to what it was. */
function reconcileReview(threadId: string, path: string) {
  void (async () => {
    const entry = client().threads[threadId]?.review[path];
    if (!entry) return;
    const now = await readCurrentText(path);
    if (now === entry.original) {
      updateThread(threadId, (thread) => {
        const review = { ...thread.review };
        delete review[path];
        return { review };
      });
    } else {
      updateThread(threadId, (thread) => (thread.review[path] ? { review: { ...thread.review, [path]: { ...thread.review[path], touchedAt: Date.now() } } } : null));
    }
  })();
}

// --- Client-side requests ------------------------------------------------------------------------

async function handleRequest(agentId: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  switch (method) {
    case CLIENT_METHODS.requestPermission:
      return requestPermission(agentId, params as RequestPermissionRequest, signal);
    case CLIENT_METHODS.readTextFile: {
      const { path, line, limit } = params as ReadTextFileRequest;
      const text = await readCurrentText(path);
      if (text === null) throw new RpcError(ErrorCode.resourceNotFound, `No such file: ${path}`);
      if (!line && !limit) return { content: text };
      const lines = text.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      return { content: lines.slice(start, limit ? start + limit : undefined).join("\n") };
    }
    case CLIENT_METHODS.writeTextFile: {
      const { sessionId, path, content } = params as WriteTextFileRequest;
      const thread = threadForSession(agentId, sessionId);
      if (thread && !thread.readOnly) await snapshot(thread.id, path);
      const exists = await pathExists(path).catch(() => false);
      if (!exists) {
        const parent = path.replace(/[/\\][^/\\]*$/, "");
        if (parent && parent !== path && !(await pathExists(parent).catch(() => false))) await createDirectory(parent).catch(() => {});
      }
      // Through the editor: an open file gets one undoable edit, then it's saved.
      await writeFileContents(path, content);
      if (thread) {
        reconcileReview(thread.id, path);
        follow(path);
      }
      return {};
    }
    case CLIENT_METHODS.createTerminal: {
      const request = params as CreateTerminalRequest;
      const thread = threadForSession(agentId, request.sessionId);
      const { terminalId } = await acpTerminalCreate({
        command: request.command,
        args: request.args ?? [],
        env: request.env ?? [],
        cwd: request.cwd ?? thread?.cwd ?? useWorkspaceStore.getState().rootPath,
        outputByteLimit: request.outputByteLimit ?? null,
      });
      const command = [request.command, ...(request.args ?? [])].join(" ");
      useAcpStore.setState((state) => ({ terminals: { ...state.terminals, [terminalId]: { output: state.terminals[terminalId]?.output ?? "", command } } }));
      return { terminalId };
    }
    case CLIENT_METHODS.terminalOutput: {
      const { terminalId } = params as { terminalId: string };
      const result = await acpTerminalOutput(terminalId);
      return { output: result.output, truncated: result.truncated, exitStatus: result.exitStatus ?? undefined };
    }
    case CLIENT_METHODS.waitForExit: {
      const { terminalId } = params as { terminalId: string };
      const waited = acpTerminalWait(terminalId);
      const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new RpcError(ErrorCode.cancelled, "Cancelled"))));
      return Promise.race([waited, aborted]);
    }
    case CLIENT_METHODS.killTerminal:
      await acpTerminalKill((params as { terminalId: string }).terminalId);
      return {};
    case CLIENT_METHODS.releaseTerminal:
      await acpTerminalRelease((params as { terminalId: string }).terminalId);
      return {};
    case CLIENT_METHODS.elicitationCreate:
      return elicit(agentId, params as ElicitationRequest, signal);
    default:
      throw new RpcError(ErrorCode.methodNotFound, `Sable doesn't support ${method}`);
  }
}

function requestPermission(agentId: string, request: RequestPermissionRequest, signal: AbortSignal): Promise<{ outcome: RequestPermissionOutcome }> {
  const thread = threadForSession(agentId, request.sessionId);
  if (!thread) return Promise.resolve({ outcome: { outcome: "cancelled" } });
  const key = uid("perm");
  const permission: PermissionState = { key, options: request.options };
  const call = request.toolCall;
  const known = thread.items.some((item) => item.kind === "tool" && item.tool.toolCallId === call.toolCallId);
  if (known || call.title || call.kind) {
    applyToolCall(thread.id, call, !known);
    updateThread(thread.id, (current) => ({
      items: current.items.map((item) => (item.kind === "tool" && item.tool.toolCallId === call.toolCallId ? { ...item, tool: { ...item.tool, permission } } : item)),
    }));
  } else {
    pushItem(thread.id, { kind: "permission", id: uid("perm"), title: "The agent asks for permission", permission });
  }
  // Remember the file before it changes (the edit runs once allowed).
  const tool = client().threads[thread.id]?.items.find((item) => item.kind === "tool" && item.tool.toolCallId === call.toolCallId) as Extract<ThreadItem, { kind: "tool" }> | undefined;
  const snapshots = tool ? editedPaths(tool.tool).map((entry) => snapshot(thread.id, entry.path, entry.diff)) : [];
  // The panel shows the question; make sure it's visible.
  if (!useUiStore.getState().agentVisible) useUiStore.getState().focusAgent();
  return new Promise((resolve) => {
    const finish = (outcome: RequestPermissionOutcome) => {
      permissionResolvers.delete(key);
      setChosen(thread.id, key, outcome.outcome === "selected" ? outcome.optionId : "cancelled");
      void Promise.all(snapshots).finally(() => resolve({ outcome }));
    };
    permissionResolvers.set(key, finish);
    signal.addEventListener("abort", () => finish({ outcome: "cancelled" }));
  });
}

function setChosen(threadId: string, key: string, chosen: string) {
  updateThread(threadId, (thread) => ({
    items: thread.items.map((item) => {
      if (item.kind === "tool" && item.tool.permission?.key === key) return { ...item, tool: { ...item.tool, permission: { ...item.tool.permission, chosen } } };
      if (item.kind === "permission" && item.permission.key === key) return { ...item, permission: { ...item.permission, chosen } };
      return item;
    }),
  }));
}

function elicit(agentId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse> {
  // Scoped to a session, or to a request of Sable's (a sign-in: Codex's device code).
  const signingIn = authThreads.get(agentId);
  const thread = request.sessionId
    ? threadForSession(agentId, request.sessionId)
    : ((signingIn ? client().threads[signingIn] : undefined) ?? Object.values(client().threads).find((candidate) => candidate.agentId === agentId && candidate.id === client().activeThreadId));
  if (!thread) return Promise.resolve({ action: "cancel" });
  const key = uid("elicit");
  pushItem(thread.id, { kind: "elicitation", id: key, elicitation: { key, request } });
  return new Promise((resolve) => {
    const finish = (response: ElicitationResponse) => {
      elicitationResolvers.delete(key);
      updateThread(thread.id, (current) => ({
        items: current.items.map((item) => (item.kind === "elicitation" && item.elicitation.key === key ? { ...item, elicitation: { ...item.elicitation, answered: response.action } } : item)),
      }));
      resolve(response);
    };
    elicitationResolvers.set(key, finish);
    signal.addEventListener("abort", () => finish({ action: "cancel" }));
  });
}

function handleNotification(agentId: string, method: string, params: unknown) {
  if (method === CLIENT_METHODS.update) {
    applyUpdate(agentId, params as SessionNotification);
  } else if (method === "_auth/status_update") {
    const status = (params as { authStatus?: ConnectionState["account"] }).authStatus;
    if (status) updateConnection(agentId, { account: status });
  } else if (method === CLIENT_METHODS.elicitationComplete) {
    // The URL flow finished (the device code was entered): say so on its card.
    const id = (params as { elicitationId?: string } | undefined)?.elicitationId;
    useAcpStore.setState((state) => {
      const threads = { ...state.threads };
      for (const thread of Object.values(state.threads)) {
        if (thread.agentId !== agentId || !thread.items.some((item) => item.kind === "elicitation" && item.elicitation.request.elicitationId === id)) continue;
        threads[thread.id] = {
          ...thread,
          items: thread.items.map((item) => (item.kind === "elicitation" && item.elicitation.request.elicitationId === id ? { ...item, elicitation: { ...item.elicitation, completed: true } } : item)),
        };
      }
      return { threads };
    });
  }
}

// --- Sessions ----------------------------------------------------------------------------------

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
  session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
  elicitation: { form: {}, url: {} },
  // Claude Agent: show Bash output as a terminal (`_meta.terminal_output`),
  // and give terminal sign-in its exact command.
  _meta: { terminal_output: true, "terminal-auth": true },
};

function emptyThread(agentId: string, cwd: string): Thread {
  const now = Date.now();
  return {
    id: uid("thread"),
    agentId,
    sessionId: null,
    title: "New thread",
    cwd,
    createdAt: now,
    updatedAt: now,
    items: [],
    plan: [],
    modes: null,
    configOptions: [],
    commands: [],
    context: null,
    tokens: { input: 0, output: 0, cached: 0 },
    status: "connecting",
    readOnly: false,
    review: {},
    epoch: 0,
  };
}

function addThread(thread: Thread, activate = true) {
  useAcpStore.setState((state) => ({
    threads: { ...state.threads, [thread.id]: thread },
    openThreadIds: state.openThreadIds.includes(thread.id) ? state.openThreadIds : [...state.openThreadIds, thread.id],
    activeThreadId: activate ? thread.id : state.activeThreadId,
    historyOpen: activate ? false : state.historyOpen,
  }));
}

function sessionMeta(agentId: string, cwd: string) {
  const meta = profileFor(agentId)?.sessionMeta?.({ cwd });
  return meta ? { _meta: meta } : {};
}

/** Start the thread's ACP session (new), on a ready connection. */
async function startSession(threadId: string) {
  const thread = client().threads[threadId];
  if (!thread) return;
  updateThread(threadId, () => ({ status: "connecting", error: undefined }));
  try {
    const connection = await client().connect(thread.agentId);
    const peer = peers.get(thread.agentId)?.peer;
    if (!peer) throw new Error(connection.error ?? "The agent isn't running");
    const response = await peer.request<NewSessionResponse>(AGENT_METHODS.newSession, { cwd: thread.cwd, mcpServers: [], ...sessionMeta(thread.agentId, thread.cwd) });
    updateThread(threadId, () => ({
      sessionId: response.sessionId,
      modes: response.modes ?? null,
      configOptions: response.configOptions ?? [],
      status: "idle",
      epoch: connection.epoch,
      items: client().threads[threadId].items.filter((item) => item.kind !== "auth"),
    }));
  } catch (error) {
    sessionFailed(threadId, thread.agentId, error);
  }
}

function showAuth(threadId: string, message: string, error?: unknown) {
  const data = error instanceof RpcError ? (error.data as { reason?: unknown } | undefined) : undefined;
  const reason = typeof data?.reason === "string" ? data.reason : undefined;
  updateThread(threadId, (thread) => ({
    status: "auth",
    items: [...thread.items.filter((item) => item.kind !== "auth"), { kind: "auth", id: uid("auth"), message, reason }],
  }));
}

/** Make sure the thread's session lives on the current agent process. */
async function ensureSession(threadId: string): Promise<boolean> {
  let thread = client().threads[threadId];
  if (!thread) return false;
  const connection = await client().connect(thread.agentId);
  const peer = peers.get(thread.agentId)?.peer;
  if (!peer || connection.status !== "ready") return false;
  thread = client().threads[threadId];
  if (thread.sessionId && thread.epoch === connection.epoch) return true;
  if (!thread.sessionId) {
    await startSession(threadId);
    return Boolean(client().threads[threadId]?.sessionId) && client().threads[threadId].status !== "auth";
  }
  // The agent restarted: resume (no replay) or load (replay suppressed).
  const capabilities = connection.init?.agentCapabilities;
  const params = { sessionId: thread.sessionId, cwd: thread.cwd, mcpServers: [], ...sessionMeta(thread.agentId, thread.cwd) };
  try {
    let response: LoadSessionResponse;
    if (capabilities?.sessionCapabilities?.resume) response = await peer.request<LoadSessionResponse>(AGENT_METHODS.resumeSession, params);
    else if (capabilities?.loadSession) {
      replaySuppressed.add(threadId);
      try {
        response = await peer.request<LoadSessionResponse>(AGENT_METHODS.loadSession, params);
      } finally {
        replaySuppressed.delete(threadId);
      }
    } else {
      notice(threadId, "warning", "The agent restarted", "It can't reopen this conversation, so a new one starts here (it won't remember what came before).");
      updateThread(threadId, () => ({ sessionId: null }));
      await startSession(threadId);
      return Boolean(client().threads[threadId]?.sessionId);
    }
    updateThread(threadId, (current) => ({ epoch: connection.epoch, status: "idle", modes: response.modes ?? current.modes, configOptions: response.configOptions ?? current.configOptions }));
    return true;
  } catch (error) {
    sessionFailed(threadId, thread.agentId, error);
    return false;
  }
}

/** Wait for a Sable terminal session to finish (terminal sign-in). */
function waitForTerminal(sessionId: string): Promise<void> {
  // Called once the program has started: from here, "not running" (or the
  // tab closed) means it finished.
  return new Promise((resolve) => {
    const done = () => {
      const session = useTerminalStore.getState().sessions.find((candidate) => candidate.id === sessionId);
      return !session || !session.isRunning;
    };
    if (done()) return resolve();
    const unsubscribe = useTerminalStore.subscribe(() => {
      if (!done()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Run an agent's terminal sign-in (ACP terminal auth, or its account login) in a Sable terminal tab. */
export async function runTerminalLogin(agentId: string, options: { method?: AuthMethod; action?: "login" | "login_device" | "logout"; provider?: string }): Promise<void> {
  const spec = await acpTerminalSpec(agentId, options.method ? { args: options.method.args ?? [], env: options.method.env } : { action: options.action, provider: options.provider });
  const env: Record<string, string | null> = { ...spec.env };
  for (const name of spec.unset) if (!(name in spec.env)) env[name] = null;
  const terminals = useTerminalStore.getState();
  const title = options.action === "logout" ? `${agentDisplayName(agentId)} sign out` : `${agentDisplayName(agentId)} sign in`;
  const started = terminals.startCommandSession({ args: [spec.program, ...spec.args], cwd: spec.cwd, env }, title, `acp-login-${agentId}`);
  const sessionId = useTerminalStore.getState().activeId;
  await started.catch(() => {});
  await waitForTerminal(sessionId);
}

// --- The store -----------------------------------------------------------------------------------

export const useAcpStore = create<AcpState>((set, get) => ({
  panelAgent: readPanelAgent(),
  connections: {},
  threads: {},
  openThreadIds: [],
  activeThreadId: null,
  historyOpen: false,
  saved: [],
  agentSessions: {},
  terminals: {},
  composerRequest: null,

  setPanelAgent: (agentId) => {
    try {
      localStorage.setItem(PANEL_AGENT_KEY, agentId);
    } catch {
      /* private mode */
    }
    set({ panelAgent: agentId });
    if (agentId === SABLE_AGENT_ID) return;
    const open = get().openThreadIds.map((id) => get().threads[id]).filter((thread) => thread?.agentId === agentId);
    const active = get().activeThreadId ? get().threads[get().activeThreadId!] : null;
    if (active?.agentId === agentId) return;
    if (open.length) set({ activeThreadId: open[open.length - 1].id });
  },

  setHistoryOpen: (open) => {
    set({ historyOpen: open });
    if (open) {
      void get().loadSaved();
      const agentId = get().panelAgent;
      if (agentId !== SABLE_AGENT_ID && get().connections[agentId]?.status === "ready") void get().listAgentSessions(agentId);
    }
  },

  connect: (agentId) => {
    const existing = get().connections[agentId];
    if (existing?.status === "ready" && peers.has(agentId)) return Promise.resolve(existing);
    const pending = connecting.get(agentId);
    if (pending) return pending;
    const run = (async (): Promise<ConnectionState> => {
      const epoch = (existing?.epoch ?? 0) + 1;
      updateConnection(agentId, { status: "starting", error: undefined, stderr: [], epoch });
      try {
        const cwd = useWorkspaceStore.getState().rootPath;
        const { instance } = await acpStart(agentId, cwd);
        // In order: one write at a time (invokes may otherwise overtake).
        let writes: Promise<unknown> = Promise.resolve();
        const write = (line: string) => {
          const next = writes.then(() => acpSend(instance, line));
          writes = next.catch(() => {});
          return next.then(() => {});
        };
        const peer = new JsonRpcPeer(write, {
          request: (method, params, signal) => handleRequest(agentId, method, params, signal),
          notification: (method, params) => handleNotification(agentId, method, params),
        });
        const offMessage = onAcpEvent<{ instance: number; line: string }>("acp:message", (payload) => {
          if (payload.instance === instance) peer.receive(payload.line);
        });
        const offStderr = onAcpEvent<{ instance: number; line: string }>("acp:stderr", (payload) => {
          if (payload.instance !== instance) return;
          const current = get().connections[agentId];
          updateConnection(agentId, { stderr: [...(current?.stderr ?? []), payload.line].slice(-200) });
        });
        const offExit = onAcpEvent<{ instance: number; code: number | null; stderr: string }>("acp:exit", (payload) => {
          if (payload.instance !== instance) return;
          onExit(agentId, instance, payload.code, payload.stderr);
        });
        const unsubscribe = () => {
          offMessage();
          offStderr();
          offExit();
        };
        peers.set(agentId, { peer, instance, unsubscribe });
        const init = await peer.request<InitializeResponse>(AGENT_METHODS.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "sable", title: "Sable", version: (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "0.4.0" },
        });
        if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`The agent speaks ACP version ${init.protocolVersion}; Sable speaks version ${PROTOCOL_VERSION}.`);
        updateConnection(agentId, { status: "ready", init, authMethods: init.authMethods ?? [], epoch });
        return get().connections[agentId];
      } catch (error) {
        const entry = peers.get(agentId);
        if (entry) {
          entry.unsubscribe();
          entry.peer.close(new Error("stopped"));
          void acpStop(entry.instance).catch(() => {});
          peers.delete(agentId);
        }
        const stderr = get().connections[agentId]?.stderr ?? [];
        const message = errorText(error);
        updateConnection(agentId, { status: "error", error: stderr.length && !/isn't installed|Node/.test(message) ? `${message}\n${stderr.slice(-6).join("\n")}` : message });
        return get().connections[agentId];
      } finally {
        connecting.delete(agentId);
      }
    })();
    connecting.set(agentId, run);
    return run;
  },

  disconnect: async (agentId) => {
    const entry = peers.get(agentId);
    if (!entry) return;
    peers.delete(agentId);
    entry.unsubscribe();
    entry.peer.close(new Error("Disconnected"));
    await acpStop(entry.instance).catch(() => {});
    updateConnection(agentId, { status: "exited" });
  },

  newThread: async (agentId) => {
    const cwd = useWorkspaceStore.getState().rootPath ?? "";
    const thread = emptyThread(agentId, cwd);
    addThread(thread);
    if (get().panelAgent !== agentId) get().setPanelAgent(agentId);
    if (!cwd) {
      updateThread(thread.id, () => ({ status: "error", error: "Open a folder first: the agent works in your workspace." }));
      return thread.id;
    }
    void startSession(thread.id);
    return thread.id;
  },

  ensureThread: (agentId) => {
    const state = get();
    const open = state.openThreadIds.map((id) => state.threads[id]).find((thread) => thread?.agentId === agentId);
    if (open || ensuring.has(agentId)) return;
    ensuring.add(agentId);
    void get()
      .newThread(agentId)
      .finally(() => ensuring.delete(agentId));
  },

  activateThread: (threadId) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    set((state) => ({ activeThreadId: threadId, historyOpen: false, openThreadIds: state.openThreadIds.includes(threadId) ? state.openThreadIds : [...state.openThreadIds, threadId] }));
    if (get().panelAgent !== thread.agentId) get().setPanelAgent(thread.agentId);
  },

  closeThread: (threadId) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    if (thread.status === "running") get().cancel(threadId);
    // Unanswered prompts can't stay open.
    for (const item of thread.items) {
      const key = item.kind === "tool" ? item.tool.permission?.key : item.kind === "permission" ? item.permission.key : undefined;
      if (key) permissionResolvers.get(key)?.({ outcome: "cancelled" });
    }
    scheduleSave();
    const peer = peers.get(thread.agentId)?.peer;
    const capabilities = get().connections[thread.agentId]?.init?.agentCapabilities?.sessionCapabilities;
    if (peer && thread.sessionId && capabilities?.close) void peer.request(AGENT_METHODS.closeSession, { sessionId: thread.sessionId }).catch(() => {});
    set((state) => {
      const openThreadIds = state.openThreadIds.filter((id) => id !== threadId);
      const threads = { ...state.threads };
      if (Object.keys(thread.review).length === 0) delete threads[threadId];
      const siblings = openThreadIds.filter((id) => threads[id]?.agentId === thread.agentId);
      return { openThreadIds, threads, activeThreadId: state.activeThreadId === threadId ? (siblings[siblings.length - 1] ?? null) : state.activeThreadId };
    });
  },

  send: async (threadId, input) => {
    const thread = get().threads[threadId];
    if (!thread || thread.readOnly) return;
    if (!input.text.trim() && !input.mentions.length && !input.images.length) return;
    pushItem(threadId, { kind: "user", id: uid("user"), text: input.text, mentions: input.mentions, images: input.images });
    updateThread(threadId, (current) => ({
      status: "running",
      turnStartedAt: Date.now(),
      title: current.title === "New thread" ? titleFrom(input.text || input.mentions.map((mention) => mention.label).join(", ")) : current.title,
      items: current.items.filter((item) => item.kind !== "auth"),
    }));
    if (!(await ensureSession(threadId))) {
      const current = get().threads[threadId];
      if (current?.status !== "auth") updateThread(threadId, (latest) => ({ status: "error", error: latest.error ?? get().connections[thread.agentId]?.error ?? "Couldn't start the agent" }));
      return;
    }
    updateThread(threadId, () => ({ status: "running" }));
    const peer = peers.get(thread.agentId)!.peer;
    try {
      const prompt = await promptBlocks(thread.agentId, input);
      const response = await peer.request<PromptResponse>(AGENT_METHODS.prompt, { sessionId: get().threads[threadId].sessionId, prompt });
      finishTurn(threadId, response.stopReason, response.usage ?? null);
    } catch (error) {
      finishTurn(threadId, "error", null);
      const explained = explainAgentError(thread.agentId, errorText(error), currentProvider(thread.agentId));
      if (isAuthError(error) || explained?.auth) {
        retryAfterAuth.set(threadId, input);
        showAuth(threadId, explained?.message ?? errorText(error), error);
      }
      else if (!peer.isClosed) notice(threadId, "error", "The agent stopped with an error", explained?.message ?? errorText(error));
    }
  },

  cancel: (threadId) => {
    const thread = get().threads[threadId];
    if (!thread?.sessionId || thread.status !== "running") return;
    peers.get(thread.agentId)?.peer.notify(AGENT_METHODS.cancel, { sessionId: thread.sessionId });
    // Every open question is answered "cancelled", as the protocol asks.
    for (const item of thread.items) {
      const key = item.kind === "tool" ? item.tool.permission?.key : item.kind === "permission" ? item.permission.key : undefined;
      if (key && permissionResolvers.has(key)) permissionResolvers.get(key)!({ outcome: "cancelled" });
    }
    updateThread(threadId, (current) => ({
      items: current.items.map((item) => (item.kind === "tool" && (item.tool.status === "pending" || item.tool.status === "in_progress") ? { ...item, tool: { ...item.tool, cancelled: true } } : item)),
    }));
  },

  setConfigOption: async (threadId, configId, value) => {
    const thread = get().threads[threadId];
    if (!thread?.sessionId) return;
    if (!(await ensureSession(threadId))) return;
    const option = thread.configOptions.find((candidate) => candidate.id === configId);
    // Optimistic: the picker shows the choice right away.
    updateThread(threadId, (current) => ({ configOptions: current.configOptions.map((candidate) => (candidate.id === configId ? ({ ...candidate, currentValue: value } as SessionConfigOption) : candidate)) }));
    try {
      const params = option?.type === "boolean" ? { sessionId: thread.sessionId, configId, type: "boolean", value } : { sessionId: thread.sessionId, configId, value };
      const response = await peers.get(thread.agentId)!.peer.request<{ configOptions?: SessionConfigOption[] }>(AGENT_METHODS.setConfigOption, params);
      if (response?.configOptions) updateThread(threadId, () => ({ configOptions: response.configOptions! }));
      if (option?.category === "mode") updateThread(threadId, (current) => ({ modes: current.modes ? { ...current.modes, currentModeId: String(value) } : current.modes }));
    } catch (error) {
      updateThread(threadId, () => ({ configOptions: thread.configOptions }));
      notice(threadId, "error", `Couldn't change ${option?.name ?? configId}`, errorText(error));
    }
  },

  setMode: async (threadId, modeId) => {
    const thread = get().threads[threadId];
    if (!thread?.sessionId) return;
    const modeOption = thread.configOptions.find((option) => option.category === "mode");
    if (modeOption) return get().setConfigOption(threadId, modeOption.id, modeId);
    if (!(await ensureSession(threadId))) return;
    const before = thread.modes;
    updateThread(threadId, (current) => ({ modes: current.modes ? { ...current.modes, currentModeId: modeId } : current.modes }));
    try {
      await peers.get(thread.agentId)!.peer.request(AGENT_METHODS.setMode, { sessionId: thread.sessionId, modeId });
    } catch (error) {
      updateThread(threadId, () => ({ modes: before }));
      notice(threadId, "error", "Couldn't change the mode", errorText(error));
    }
  },

  respondPermission: (_threadId, key, optionId) => {
    permissionResolvers.get(key)?.({ outcome: "selected", optionId });
  },

  respondElicitation: (_threadId, key, response) => {
    const thread = Object.values(get().threads).find((candidate) => candidate.items.some((item) => item.kind === "elicitation" && item.elicitation.key === key));
    const item = thread?.items.find((candidate) => candidate.kind === "elicitation" && candidate.elicitation.key === key) as Extract<ThreadItem, { kind: "elicitation" }> | undefined;
    if (response.action === "accept" && item?.elicitation.request.mode === "url" && item.elicitation.request.url) {
      void openUrl(item.elicitation.request.url).catch((error) => useUiStore.getState().setLastError(String(error)));
    }
    elicitationResolvers.get(key)?.(response);
  },

  authenticate: async (threadId, method) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    const agentId = thread.agentId;
    const hint = authHint(agentId, method.id);
    if (hint?.settings) {
      // An API key: set it up in Settings (keychain), not in the agent's own store.
      openAgentSettings(agentId, hint.settings);
      return;
    }
    updateConnection(agentId, { authError: undefined });
    if (method.type === "terminal") {
      updateThread(threadId, () => ({ status: "connecting" }));
      try {
        await runTerminalLogin(agentId, { method });
      } catch (error) {
        notice(threadId, "error", "Couldn't start the sign-in", errorText(error));
      }
      // Signed in (or not): a fresh agent process picks the login up.
      await get().disconnect(agentId);
      return get().retry(threadId);
    }
    const peer = peers.get(agentId)?.peer;
    if (!peer) return get().retry(threadId);
    updateConnection(agentId, { authenticating: method.id });
    authThreads.set(agentId, threadId);
    try {
      await peer.request(AGENT_METHODS.authenticate, { methodId: method.id });
      authThreads.delete(agentId);
      updateConnection(agentId, { authenticating: undefined });
      await get().retry(threadId);
    } catch (error) {
      authThreads.delete(agentId);
      if (cancelledAuth.delete(agentId)) return;
      const text = errorText(error);
      const explained = explainAgentError(agentId, text, currentProvider(agentId));
      updateConnection(agentId, { authenticating: undefined, authError: explained?.message ?? text });
    }
  },

  cancelAuthenticate: async (threadId) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    // ACP has no way to stop an authenticate: restart the agent.
    cancelledAuth.add(thread.agentId);
    updateConnection(thread.agentId, { authenticating: undefined, authError: undefined });
    await get().disconnect(thread.agentId);
    await get().retry(threadId);
  },

  logout: async (agentId) => {
    const connection = await get().connect(agentId);
    const peer = peers.get(agentId)?.peer;
    if (!peer || connection.status !== "ready") throw new Error(connection.error ?? `${agentDisplayName(agentId)} didn't start`);
    if (!connection.init?.agentCapabilities?.auth?.logout) throw new Error(`${agentDisplayName(agentId)} can't sign out from Sable`);
    await peer.request(AGENT_METHODS.logout, {});
    await get().disconnect(agentId);
  },

  retry: async (threadId) => {
    const thread = get().threads[threadId];
    if (!thread) return;
    if (get().connections[thread.agentId]?.status === "error") updateConnection(thread.agentId, { status: "exited" });
    updateConnection(thread.agentId, { authError: undefined });
    updateThread(threadId, (current) => ({ status: "connecting", error: undefined, items: current.items.filter((item) => item.kind !== "auth") }));
    const ok = await ensureSession(threadId);
    if (ok) updateThread(threadId, (current) => (current.status === "connecting" ? { status: "idle" } : null));
    // Signed in now: send what was refused (its message moves to the end).
    const queued = retryAfterAuth.get(threadId);
    if (ok && queued && get().threads[threadId]?.status === "idle") {
      retryAfterAuth.delete(threadId);
      updateThread(threadId, (current) => {
        const index = current.items.map((item) => item.kind).lastIndexOf("user");
        return index >= 0 ? { items: current.items.filter((_, other) => other !== index) } : null;
      });
      void get().send(threadId, queued);
    }
    else if (get().threads[threadId]?.status === "connecting") updateThread(threadId, () => ({ status: "error", error: get().connections[thread.agentId]?.error ?? "Couldn't start the agent" }));
  },

  loadSaved: async () => {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) {
      set({ saved: [] });
      return;
    }
    const data = (await acpThreadsLoad(root).catch(() => null)) as { threads?: SavedThread[] } | null;
    set({ saved: Array.isArray(data?.threads) ? data!.threads! : [] });
  },

  openSaved: async (saved) => {
    const open = Object.values(get().threads).find((thread) => thread.id === saved.id);
    if (open) return get().activateThread(open.id);
    const connection = await get().connect(saved.agentId);
    const canLoad = connection.status === "ready" && saved.sessionId && (connection.init?.agentCapabilities?.loadSession || connection.init?.agentCapabilities?.sessionCapabilities?.resume);
    const thread: Thread = {
      ...emptyThread(saved.agentId, saved.cwd),
      id: saved.id,
      sessionId: saved.sessionId,
      title: saved.title,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      items: saved.items,
      plan: saved.plan ?? [],
      status: canLoad ? "connecting" : "idle",
      readOnly: !canLoad,
      epoch: -1,
    };
    addThread(thread);
    if (get().panelAgent !== saved.agentId) get().setPanelAgent(saved.agentId);
    if (canLoad) {
      const ok = await ensureSession(thread.id);
      if (!ok && get().threads[thread.id]?.status !== "auth") updateThread(thread.id, () => ({ readOnly: true, status: "idle", error: undefined }));
      else if (ok) updateThread(thread.id, () => ({ status: "idle" }));
    }
  },

  deleteSaved: (id) => {
    const root = useWorkspaceStore.getState().rootPath;
    const saved = get().saved.filter((entry) => entry.id !== id);
    set({ saved });
    if (root) void acpThreadsSave(root, { version: 1, threads: saved }).catch(() => {});
  },

  listAgentSessions: async (agentId) => {
    const connection = get().connections[agentId];
    const peer = peers.get(agentId)?.peer;
    if (!peer || !connection?.init?.agentCapabilities?.sessionCapabilities?.list) return;
    try {
      const response = await peer.request<ListSessionsResponse>(AGENT_METHODS.listSessions, { cwd: useWorkspaceStore.getState().rootPath });
      set((state) => ({ agentSessions: { ...state.agentSessions, [agentId]: response.sessions ?? [] } }));
    } catch {
      /* listing is optional */
    }
  },

  openAgentSession: async (agentId, session) => {
    const open = Object.values(get().threads).find((thread) => thread.agentId === agentId && thread.sessionId === session.sessionId);
    if (open) return get().activateThread(open.id);
    const connection = await get().connect(agentId);
    const peer = peers.get(agentId)?.peer;
    if (!peer || connection.status !== "ready") return;
    const thread: Thread = { ...emptyThread(agentId, session.cwd), sessionId: session.sessionId, title: session.title || "Earlier session", status: "loading", epoch: connection.epoch };
    addThread(thread);
    try {
      const response = await peer.request<LoadSessionResponse>(AGENT_METHODS.loadSession, { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [], ...sessionMeta(agentId, session.cwd) });
      updateThread(thread.id, (current) => ({ status: "idle", modes: response.modes ?? current.modes, configOptions: response.configOptions ?? current.configOptions, items: finalizeReplay(current.items) }));
    } catch (error) {
      sessionFailed(thread.id, agentId, error);
    }
  },

  acceptFile: (threadId, path) => {
    updateThread(threadId, (thread) => {
      const review = { ...thread.review };
      delete review[path];
      return { review };
    });
  },

  rejectFile: async (threadId, path) => {
    const entry = get().threads[threadId]?.review[path];
    if (!entry) return;
    try {
      if (entry.original === null) {
        await deletePath(path).catch(() => {});
        useTabsStore.getState().closeTabsUnder(path);
      } else {
        await writeFileContents(path, entry.original);
      }
      get().acceptFile(threadId, path);
      useGitStore.getState().refresh();
    } catch (error) {
      useUiStore.getState().setLastError(`Couldn't restore ${baseName(path)}: ${errorText(error)}`);
    }
  },

  acceptAll: (threadId) => {
    const ids = threadId ? [threadId] : reviewThreadIds();
    for (const id of ids) updateThread(id, () => ({ review: {} }));
  },

  rejectAll: async (threadId) => {
    const ids = threadId ? [threadId] : reviewThreadIds();
    for (const id of ids) {
      for (const path of Object.keys(get().threads[id]?.review ?? {})) await get().rejectFile(id, path);
    }
  },

  acceptHunk: async (threadId, path, changeIndex) => {
    const entry = get().threads[threadId]?.review[path];
    if (!entry) return;
    const current = (await readCurrentText(path)) ?? "";
    const original = entry.original ?? "";
    const a = splitLines(original);
    const b = splitLines(current);
    const changes = diffLines(a, b);
    const change = changes[changeIndex];
    if (!change) return;
    const baseline = joinLines(acceptChange(a, b, change), original || current);
    updateThread(threadId, (thread) => ({ review: { ...thread.review, [path]: { ...entry, original: entry.original === null && changes.length === 1 ? current : baseline } } }));
    reconcileReview(threadId, path);
  },

  rejectHunk: async (threadId, path, changeIndex) => {
    const entry = get().threads[threadId]?.review[path];
    if (!entry) return;
    const current = (await readCurrentText(path)) ?? "";
    const a = splitLines(entry.original ?? "");
    const b = splitLines(current);
    const changes = diffLines(a, b);
    const change = changes[changeIndex];
    if (!change) return;
    if (changes.length === 1) return get().rejectFile(threadId, path);
    await writeFileContents(path, joinLines(rejectChange(a, b, changes, change), current));
    reconcileReview(threadId, path);
  },

  ask: async (text, mentions, options) => {
    const agentId = options?.agentId ?? (get().panelAgent !== SABLE_AGENT_ID ? get().panelAgent : (preferredAgent() ?? "claude-acp"));
    useUiStore.getState().focusAgent();
    let threadId = get().activeThreadId;
    const active = threadId ? get().threads[threadId] : null;
    if (!active || active.agentId !== agentId || active.readOnly || (options?.send && active.status === "running")) threadId = await get().newThread(agentId);
    else if (get().panelAgent !== agentId) get().setPanelAgent(agentId);
    set({ composerRequest: { threadId: threadId!, text, mentions, send: Boolean(options?.send), nonce: Date.now() } });
  },
}));

function finalizeReplay(items: ThreadItem[]): ThreadItem[] {
  const now = Date.now();
  return items.map((item) => {
    if (item.kind === "thought" && !item.endedAt) return { ...item, endedAt: now };
    if (item.kind === "tool" && (item.tool.status === "pending" || item.tool.status === "in_progress")) return { ...item, tool: { ...item.tool, status: "completed", endedAt: item.tool.endedAt ?? now } };
    return item;
  });
}

function finishTurn(threadId: string, stopReason: string, usage: Usage | null) {
  updateThread(threadId, (thread) => {
    const now = Date.now();
    const items = thread.items.map((item): ThreadItem => {
      if (item.kind === "thought" && !item.endedAt) return { ...item, endedAt: now };
      if (item.kind === "tool" && (item.tool.status === "pending" || item.tool.status === "in_progress") && (stopReason === "cancelled" || item.tool.cancelled)) {
        return { ...item, tool: { ...item.tool, cancelled: true, endedAt: item.tool.endedAt ?? now } };
      }
      return item;
    });
    if (stopReason === "cancelled") items.push({ kind: "notice", id: uid("notice"), tone: "info", title: "Stopped" });
    else if (stopReason === "max_tokens") items.push({ kind: "notice", id: uid("notice"), tone: "warning", title: "The reply hit the model's output limit" });
    else if (stopReason === "max_turn_requests") items.push({ kind: "notice", id: uid("notice"), tone: "warning", title: "The agent reached its turn limit" });
    else if (stopReason === "refusal") items.push({ kind: "notice", id: uid("notice"), tone: "warning", title: "The agent declined to continue" });
    return {
      items,
      status: thread.status === "auth" ? "auth" : "idle",
      turnStartedAt: undefined,
      updatedAt: now,
      tokens: usage
        ? { input: thread.tokens.input + (usage.inputTokens ?? 0), output: thread.tokens.output + (usage.outputTokens ?? 0), cached: thread.tokens.cached + (usage.cachedReadTokens ?? 0) }
        : thread.tokens,
    };
  });
  scheduleSave();
}

function onExit(agentId: string, instance: number, code: number | null, stderr: string) {
  const entry = peers.get(agentId);
  if (!entry || entry.instance !== instance) return;
  peers.delete(agentId);
  entry.unsubscribe();
  const reason = new Error(`${agentDisplayName(agentId)} exited${code !== null ? ` (code ${code})` : ""}`);
  entry.peer.close(reason);
  const tail = stderr.split("\n").filter(Boolean).slice(-8).join("\n");
  updateConnection(agentId, { status: "exited", error: tail ? `${reason.message}\n${tail}` : reason.message });
  for (const thread of Object.values(useAcpStore.getState().threads)) {
    if (thread.agentId !== agentId) continue;
    for (const item of thread.items) {
      const key = item.kind === "tool" ? item.tool.permission?.key : item.kind === "permission" ? item.permission.key : undefined;
      if (key) permissionResolvers.delete(key);
    }
    if (thread.status === "running" || thread.status === "connecting" || thread.status === "loading") {
      updateThread(thread.id, () => ({ status: "error", error: tail ? `${reason.message}:\n${tail}` : reason.message }));
    }
  }
}

function reviewThreadIds(): string[] {
  return Object.values(useAcpStore.getState().threads)
    .filter((thread) => Object.keys(thread.review).length > 0)
    .map((thread) => thread.id);
}

/** Pending edits across every thread. */
export function pendingReviewCount(state = useAcpStore.getState()): number {
  return Object.values(state.threads).reduce((sum, thread) => sum + Object.keys(thread.review).length, 0);
}

/** The agent to use when none is picked: the first installed one. */
function preferredAgent(): string | undefined {
  return acpRegistryCache().installedIds[0];
}

/** The thread (if any) whose review holds `path`. */
export function reviewFor(path: string): { threadId: string; entry: ReviewEntry } | null {
  for (const thread of Object.values(useAcpStore.getState().threads)) {
    const entry = thread.review[path];
    if (entry) return { threadId: thread.id, entry };
  }
  return null;
}

// Another folder: threads belong to their workspace.
let lastRoot = useWorkspaceStore.getState().rootPath;
useWorkspaceStore.subscribe((state) => {
  if (state.rootPath === lastRoot) return;
  lastRoot = state.rootPath;
  for (const agentId of [...peers.keys()]) void useAcpStore.getState().disconnect(agentId);
  useAcpStore.setState({ threads: {}, openThreadIds: [], activeThreadId: null, saved: [], agentSessions: {} });
  void useAcpStore.getState().loadSaved();
});

// Terminal output for the cards.
onAcpEvent<{ terminalId: string; data?: string; exit?: { exitCode: number | null; signal: string | null } }>("acp:terminal", (payload) => {
  useAcpStore.setState((state) => {
    const current = state.terminals[payload.terminalId] ?? { output: "" };
    const output = payload.data ? (current.output + payload.data).slice(-200_000) : current.output;
    return { terminals: { ...state.terminals, [payload.terminalId]: { ...current, output, exit: payload.exit ?? current.exit } } };
  });
});

/** For tests and the agent log. */
export function agentPeer(agentId: string): JsonRpcPeer | undefined {
  return peers.get(agentId)?.peer;
}
