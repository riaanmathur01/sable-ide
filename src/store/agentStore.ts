import { create } from "zustand";
import { aiKeyStatus, loadChats, saveChats, type AiProvider } from "../lib/ipc";
import { completeStreaming, type StreamHandle } from "../lib/ai/providers";
import {
  TOOL_DEFINITIONS,
  approvalCategory,
  describeCall,
  executeTool,
  revertEdit,
  type FileEdit,
} from "../lib/ai/tools";
import type { ModelReply, ToolCall, ToolResult, Turn } from "../lib/ai/types";
import { getEditor } from "../lib/editorRegistry";
import { useWorkspaceStore } from "./workspaceStore";
import { allOpenFiles, useTabsStore } from "./tabsStore";
import { useGitStore } from "./gitStore";
import { useUiStore } from "./uiStore";
import { getSetting } from "./settingsStore";

/**
 * AI agent state and the agent loop. The loop alternates model calls and
 * tool executions until the model answers without calling a tool, the
 * user stops it, or the step limit is reached. Replies stream in as they
 * are generated.
 *
 * Chats are kept per workspace and saved to disk (src-tauri ai.rs
 * load_chats/save_chats). The active chat lives in the top-level fields
 * (`items`, `history`, …) the panel renders; `conversations` holds every
 * chat for the history list. One chat runs at a time, and the active
 * chat can't change while it runs.
 */

export type ToolStatus =
  | "awaiting-approval"
  | "running"
  | "done"
  | "error"
  | "denied"
  | "cancelled";

export type ChatItem =
  | { id: number; kind: "user"; text: string; contextLabel: string | null }
  | { id: number; kind: "assistant"; text: string; streaming?: boolean }
  | {
      id: number;
      kind: "tool";
      call: ToolCall;
      summary: string;
      approval: "edit" | "command" | null;
      status: ToolStatus;
      output: string | null;
      edit: FileEdit | null;
      reverted: boolean;
    }
  | { id: number; kind: "notice"; text: string; tone: "error" | "info" };

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: ChatItem[];
  history: Turn[];
  usage: { input: number; output: number };
  allowCommandsThisChat: boolean;
}

interface AgentState {
  /** Every chat in this workspace, newest first (the active one included). */
  conversations: Conversation[];
  activeId: string;
  // --- The active chat ---
  items: ChatItem[];
  history: Turn[];
  usage: { input: number; output: number };
  /** "Allow all" for commands, for the rest of this chat. */
  allowCommandsThisChat: boolean;
  isRunning: boolean;
  /** Short live status ("Thinking…", "Running git status"). */
  status: string | null;
  /** null until first checked. */
  keyStatus: Record<AiProvider, boolean> | null;
  /** Draft input text (kept here so it survives hiding the panel). */
  draft: string;

  setDraft: (draft: string) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  newChat: () => void;
  switchChat: (id: string) => void;
  deleteChat: (id: string) => void;
  /** Load the chats saved for a workspace (on open / folder switch). */
  loadWorkspaceChats: (root: string | null) => Promise<void>;
  respondToApproval: (itemId: number, decision: "allow" | "allow-all" | "deny") => void;
  revert: (itemId: number) => Promise<void>;
  refreshKeyStatus: () => Promise<void>;
}

let itemId = 0;
/** Bumped by stop/newChat; a loop whose token is stale exits. */
let runToken = 0;
const approvalResolvers = new Map<number, (approved: boolean) => void>();
/** The in-flight model stream, so Stop can abort the HTTP request. */
let currentStream: StreamHandle | null = null;

const MAX_SAVED_CHATS = 50;
const SAVE_DEBOUNCE_MS = 800;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The workspace whose chats are loaded (saves go there). */
let chatsRoot: string | null = null;

let conversationCounter = 0;
function emptyConversation(): Conversation {
  conversationCounter += 1;
  const now = Date.now();
  return {
    id: `chat-${now.toString(36)}-${conversationCounter}`,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    items: [],
    history: [],
    usage: { input: 0, output: 0 },
    allowCommandsThisChat: false,
  };
}

/** A chat's title: its first message, trimmed. */
function titleFor(items: ChatItem[]): string {
  const first = items.find((item) => item.kind === "user");
  if (!first || first.kind !== "user") return "New chat";
  const line = first.text.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Tool cards left mid-flight by a closed app can't resume. */
function settleItems(items: ChatItem[]): ChatItem[] {
  return items.map((item) =>
    item.kind === "tool" && (item.status === "running" || item.status === "awaiting-approval")
      ? { ...item, status: "cancelled" as const }
      : item.kind === "assistant" && item.streaming
        ? { ...item, streaming: false }
        : item,
  );
}

function modelFor(provider: AiProvider): string {
  return provider === "anthropic"
    ? getSetting("ai.anthropicModel")
    : provider === "openai"
      ? getSetting("ai.openaiModel")
      : getSetting("ai.googleModel");
}

function platformName(): string {
  const agent = navigator.userAgent;
  if (agent.includes("Mac")) return "macOS";
  if (agent.includes("Windows")) return "Windows";
  return "Linux";
}

function systemPrompt(root: string): string {
  const git = useGitStore.getState();
  const gitLine = git.isRepo
    ? `Git repository, current branch: ${git.branch ?? "(none)"}${git.hasRemote ? " (has a remote)" : " (no remote)"}`
    : "Not a git repository";
  const custom = getSetting("ai.customInstructions").trim();
  return `You are Sable Agent, an AI coding agent built into the Sable code editor. You work directly in the user's open project: you can read, search, create, edit and delete files, and run shell, git and GitHub CLI commands through your tools.

Environment
- Workspace root: ${root} (relative paths resolve against it; you cannot access files outside it)
- OS: ${platformName()}
- Date: ${new Date().toDateString()}
- ${gitLine}

How to work
- Investigate before changing: use find_files, search and read_file to understand the relevant code rather than guessing at its contents.
- Make focused changes with edit_file. old_string must match the file exactly; read_file prefixes lines with "N<tab>" — never include that prefix. Use write_file for new files or full rewrites.
- Follow the project's existing style, conventions and libraries.
- After changing code, verify when practical (type-check, build, or run the relevant tests with run_command).
- Commands are non-interactive (no stdin, no prompts) and time out; never start servers, watchers or other processes that don't exit.
- Git: use the git tool. Only commit, push, create/switch branches, or rewrite history when the user asks. Never force-push without explicit instruction. Write clear commit messages.
- GitHub: use the github tool (gh CLI) for pull requests, issues and repos. If gh is missing or unauthenticated, tell the user (install: brew install gh; then gh auth login).
- The user watches every tool call in the chat panel and may need to approve edits or commands. If a call is denied, don't retry it — adjust your approach or ask.
- If a request is ambiguous or destructive (deleting data, sweeping refactors), ask a brief question before acting.
- Finish with a short summary of what you did and anything the user should check. Use Markdown; refer to files by their workspace-relative path in backticks (e.g. \`src/app.ts:42\`).${custom ? `\n\nUser's custom instructions\n${custom}` : ""}`;
}

/** Active file, cursor, selection and open tabs, as context for the model. */
function editorContext(root: string): { text: string; label: string } | null {
  const { lastFilePath } = useTabsStore.getState();
  const relative = (path: string) =>
    path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, "") : path;
  const lines: string[] = [];
  let label: string | null = null;
  if (lastFilePath) {
    const editor = getEditor();
    const position = editor?.getPosition();
    lines.push(
      `Active file: ${relative(lastFilePath)}${position ? ` (cursor at line ${position.lineNumber})` : ""}`,
    );
    label = lastFilePath.split(/[/\\]/).pop() ?? null;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    if (selection && model && !selection.isEmpty()) {
      const selected = model.getValueInRange(selection);
      const clipped = selected.length > 6000 ? `${selected.slice(0, 6000)}\n… [truncated]` : selected;
      lines.push(
        `Selected text (lines ${selection.startLineNumber}-${selection.endLineNumber}):\n\`\`\`\n${clipped}\n\`\`\``,
      );
      label = `${label} · selection`;
    }
  }
  const openFiles = allOpenFiles().map(relative);
  if (openFiles.length > 0) lines.push(`Open tabs: ${openFiles.join(", ")}`);
  if (lines.length === 0) return null;
  return {
    text: `<editor_context>\n${lines.join("\n")}\n</editor_context>`,
    label: label ?? "open tabs",
  };
}

export const useAgentStore = create<AgentState>((set, get) => {
  /** Write the active chat's fields back into its `conversations` entry. */
  function snapshotActive(): Conversation[] {
    const state = get();
    return state.conversations.map((conversation) =>
      conversation.id === state.activeId
        ? {
            ...conversation,
            items: state.items,
            history: state.history,
            usage: state.usage,
            allowCommandsThisChat: state.allowCommandsThisChat,
            title: titleFor(state.items),
            updatedAt: state.items.length > 0 ? Date.now() : conversation.updatedAt,
          }
        : conversation,
    );
  }

  /** Debounced save of every non-empty chat for the current workspace. */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    const root = chatsRoot;
    if (!root) return;
    const conversations = snapshotActive();
    set({ conversations });
    const saved = conversations
      .filter((conversation) => conversation.items.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SAVED_CHATS)
      .map((conversation) => ({ ...conversation, items: settleItems(conversation.items) }));
    try {
      await saveChats(root, { version: 1, activeId: get().activeId, conversations: saved });
    } catch (error) {
      useUiStore.getState().setLastError(String(error));
    }
  }

  function push(item: ChatItem) {
    set((state) => ({ items: [...state.items, item] }));
    scheduleSave();
  }

  function updateItem(id: number, patch: Partial<ChatItem>) {
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? ({ ...item, ...patch } as ChatItem) : item,
      ),
    }));
    scheduleSave();
  }

  function updateTool(id: number, patch: Partial<ToolItem>) {
    updateItem(id, patch as Partial<ChatItem>);
  }

  function notice(text: string, tone: "error" | "info" = "error") {
    push({ id: ++itemId, kind: "notice", text, tone });
  }

  function needsApproval(category: "edit" | "command" | null): boolean {
    if (category === "edit") return !getSetting("ai.autoApproveEdits");
    if (category === "command") {
      return !getSetting("ai.autoApproveCommands") && !get().allowCommandsThisChat;
    }
    return false;
  }

  function waitForApproval(id: number): Promise<boolean> {
    return new Promise((resolve) => approvalResolvers.set(id, resolve));
  }

  /** Execute one tool call, with approval if required. */
  async function runToolCall(call: ToolCall, root: string, token: number): Promise<ToolResult> {
    const category = approvalCategory(call);
    const id = ++itemId;
    const awaiting = needsApproval(category);
    push({
      id,
      kind: "tool",
      call,
      summary: describeCall(call),
      approval: category,
      status: awaiting ? "awaiting-approval" : "running",
      output: null,
      edit: null,
      reverted: false,
    });

    if (awaiting) {
      set({ status: "Waiting for your approval" });
      const approved = await waitForApproval(id);
      if (token !== runToken) {
        updateTool(id, { status: "cancelled" });
        return { callId: call.id, name: call.name, content: "Cancelled by the user.", isError: true };
      }
      if (!approved) {
        updateTool(id, { status: "denied" });
        return {
          callId: call.id,
          name: call.name,
          content: "The user denied this action. Do not retry it; adjust your approach or ask the user.",
          isError: true,
        };
      }
      updateTool(id, { status: "running" });
    }

    set({ status: describeCall(call) });
    const outcome = await executeTool(call, root);
    updateTool(id, {
      status: outcome.isError ? "error" : "done",
      output: outcome.content,
      edit: outcome.edit ?? null,
    });
    return {
      callId: call.id,
      name: call.name,
      content: outcome.content,
      isError: outcome.isError,
    };
  }

  /**
   * One model call, streamed into a live assistant message. Text deltas
   * are batched per animation frame so the panel re-renders smoothly
   * rather than once per token.
   */
  async function streamReply(
    request: Parameters<typeof completeStreaming>[0],
    token: number,
  ): Promise<{ reply: ModelReply | null; partial: string }> {
    const messageId = ++itemId;
    push({ id: messageId, kind: "assistant", text: "", streaming: true });
    let shown = "";
    let pending = "";
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      if (!pending) return;
      shown += pending;
      pending = "";
      set((state) => ({
        items: state.items.map((item) =>
          item.id === messageId && item.kind === "assistant" ? { ...item, text: shown } : item,
        ),
      }));
    };

    const handle = completeStreaming(request, (delta) => {
      if (token !== runToken) return;
      if (shown === "" && pending === "") set({ status: "Writing…" });
      pending += delta;
      frame ??= requestAnimationFrame(flush);
    });
    currentStream = handle;
    try {
      const reply = await handle.reply;
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      // The final text is authoritative (deltas can't drift from it).
      if (reply.text.trim()) {
        updateItem(messageId, { text: reply.text, streaming: false } as Partial<ChatItem>);
      } else {
        set((state) => ({ items: state.items.filter((item) => item.id !== messageId) }));
      }
      return { reply, partial: reply.text };
    } catch (error) {
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
      // Keep whatever arrived before a stop or failure.
      if (shown.trim()) {
        updateItem(messageId, { streaming: false } as Partial<ChatItem>);
      } else {
        set((state) => ({ items: state.items.filter((item) => item.id !== messageId) }));
      }
      if (token === runToken) {
        notice(error instanceof Error ? error.message : String(error));
      }
      return { reply: null, partial: shown };
    } finally {
      if (currentStream === handle) currentStream = null;
    }
  }

  async function runLoop(token: number) {
    const root = useWorkspaceStore.getState().rootPath;
    if (!root) return;
    const provider = getSetting("ai.provider");
    const model = modelFor(provider).trim();
    if (!model) {
      notice(`No ${provider} model set — choose one in Settings → AI Agent.`);
      return;
    }
    const maxSteps = getSetting("ai.maxSteps");
    const system = systemPrompt(root);

    for (let step = 0; step < maxSteps; step++) {
      set({ status: "Thinking…" });
      const { reply, partial } = await streamReply(
        {
          provider,
          model,
          system,
          history: get().history,
          tools: TOOL_DEFINITIONS,
          maxTokens: getSetting("ai.maxTokens"),
          baseUrl: getSetting("ai.openaiBaseUrl").trim() || null,
        },
        token,
      );
      if (!reply) {
        // Stopped or failed mid-reply: record what the user saw, so the
        // model's next turn knows what it already said.
        if (partial.trim()) {
          set((state) => ({
            history: [...state.history, { role: "assistant", text: partial, toolCalls: [] }],
          }));
          scheduleSave();
        }
        return;
      }
      if (token !== runToken) return; // stopped while waiting

      set((state) => ({
        usage: {
          input: state.usage.input + reply.usage.input,
          output: state.usage.output + reply.usage.output,
        },
        history: [
          ...state.history,
          {
            role: "assistant",
            text: reply.text,
            toolCalls: reply.toolCalls,
            raw: { provider, value: reply.raw },
          },
        ],
      }));
      scheduleSave();

      if (reply.toolCalls.length === 0) {
        if (reply.stopReason === "max_tokens") {
          notice("The response hit the output token limit (Settings → AI Agent → Max Output Tokens).", "info");
        }
        return;
      }

      // Every tool call must get a result in the transcript — even if the
      // user stops midway — or the next request is rejected.
      const results: ToolResult[] = [];
      for (const call of reply.toolCalls) {
        if (token !== runToken) {
          results.push({ callId: call.id, name: call.name, content: "Cancelled by the user.", isError: true });
          continue;
        }
        results.push(await runToolCall(call, root, token));
      }
      set((state) => ({ history: [...state.history, { role: "tool", results }] }));
      scheduleSave();
      if (token !== runToken) return;
    }
    notice(
      `Stopped after ${maxSteps} steps (Settings → AI Agent → Max Steps). Send “continue” to keep going.`,
      "info",
    );
  }

  /** Make `conversation` the active chat (top-level fields). */
  function activate(conversation: Conversation) {
    set({
      activeId: conversation.id,
      items: conversation.items,
      history: conversation.history,
      usage: conversation.usage,
      allowCommandsThisChat: conversation.allowCommandsThisChat,
    });
  }

  const initial = emptyConversation();

  return {
    conversations: [initial],
    activeId: initial.id,
    items: [],
    history: [],
    usage: { input: 0, output: 0 },
    allowCommandsThisChat: false,
    isRunning: false,
    status: null,
    keyStatus: null,
    draft: "",

    setDraft: (draft) => set({ draft }),

    send: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || get().isRunning) return;
      const root = useWorkspaceStore.getState().rootPath;
      if (!root) {
        notice("Open a folder first — the agent works inside your workspace.");
        return;
      }
      const provider = getSetting("ai.provider");
      if (get().keyStatus === null) await get().refreshKeyStatus();
      if (get().keyStatus && !get().keyStatus![provider]) {
        notice(`Add your ${provider === "google" ? "Google" : provider === "openai" ? "OpenAI" : "Anthropic"} API key in Settings → AI Agent to get started.`);
        return;
      }

      const context = getSetting("ai.includeEditorContext") ? editorContext(root) : null;
      push({ id: ++itemId, kind: "user", text: trimmed, contextLabel: context?.label ?? null });
      set((state) => ({
        draft: "",
        isRunning: true,
        history: [
          ...state.history,
          { role: "user", text: context ? `${context.text}\n\n${trimmed}` : trimmed },
        ],
      }));

      const token = ++runToken;
      try {
        await runLoop(token);
      } finally {
        if (token === runToken) set({ isRunning: false, status: null });
        void flushSave();
      }
    },

    stop: () => {
      runToken++;
      currentStream?.cancel();
      currentStream = null;
      for (const resolve of approvalResolvers.values()) resolve(false);
      approvalResolvers.clear();
      // Mark anything in flight as cancelled.
      set((state) => ({
        isRunning: false,
        status: null,
        items: settleItems(state.items),
      }));
      // An assistant turn with tool calls but no results would make the
      // next request invalid — close it out.
      const history = get().history;
      const last = history[history.length - 1];
      if (last?.role === "assistant" && last.toolCalls.length > 0) {
        set({
          history: [
            ...history,
            {
              role: "tool",
              results: last.toolCalls.map((call) => ({
                callId: call.id,
                name: call.name,
                content: "Cancelled by the user.",
                isError: true,
              })),
            },
          ],
        });
      }
      scheduleSave();
    },

    newChat: () => {
      if (get().isRunning) get().stop();
      // Already on an empty chat: nothing to do.
      if (get().items.length === 0) return;
      const conversations = snapshotActive();
      const fresh = emptyConversation();
      set({ conversations: [fresh, ...conversations] });
      activate(fresh);
      scheduleSave();
    },

    switchChat: (id) => {
      if (get().isRunning || id === get().activeId) return;
      const conversations = snapshotActive().filter(
        // An untouched empty chat isn't worth keeping in the list.
        (conversation) => conversation.items.length > 0 || conversation.id === id,
      );
      const target = conversations.find((conversation) => conversation.id === id);
      if (!target) return;
      set({ conversations });
      activate(target);
      scheduleSave();
    },

    deleteChat: (id) => {
      if (get().isRunning && id === get().activeId) return;
      const remaining = snapshotActive().filter((conversation) => conversation.id !== id);
      if (id === get().activeId) {
        const next = remaining[0] ?? emptyConversation();
        set({ conversations: remaining.length > 0 ? remaining : [next] });
        activate(next);
      } else {
        set({ conversations: remaining });
      }
      void flushSave();
    },

    loadWorkspaceChats: async (root) => {
      if (get().isRunning) get().stop();
      // Save the previous workspace's chats before switching.
      if (chatsRoot && chatsRoot !== root) await flushSave();
      chatsRoot = root;
      const fresh = emptyConversation();
      let conversations: Conversation[] = [];
      let activeId: string | null = null;
      if (root) {
        try {
          const saved = (await loadChats(root)) as
            | { version?: number; activeId?: string; conversations?: Conversation[] }
            | null;
          conversations = (saved?.conversations ?? []).map((conversation) => ({
            ...conversation,
            items: settleItems(conversation.items ?? []),
            history: conversation.history ?? [],
            usage: conversation.usage ?? { input: 0, output: 0 },
          }));
          activeId = saved?.activeId ?? null;
        } catch (error) {
          useUiStore.getState().setLastError(String(error));
        }
      }
      // Item ids must stay unique across every loaded chat.
      for (const conversation of conversations) {
        for (const item of conversation.items) itemId = Math.max(itemId, item.id);
      }
      // Reopen the chat that was active, else start fresh (older chats
      // are one click away in the history list).
      const active = conversations.find((conversation) => conversation.id === activeId);
      if (active) {
        set({ conversations });
        activate(active);
      } else {
        set({ conversations: [fresh, ...conversations] });
        activate(fresh);
      }
    },

    respondToApproval: (id, decision) => {
      const resolve = approvalResolvers.get(id);
      if (!resolve) return;
      approvalResolvers.delete(id);
      if (decision === "allow-all") set({ allowCommandsThisChat: true });
      resolve(decision !== "deny");
    },

    revert: async (id) => {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item || item.kind !== "tool" || !item.edit || item.reverted) return;
      try {
        await revertEdit(item.edit);
        updateTool(id, { reverted: true });
        // Tell the model, so it doesn't build on the reverted change.
        set((state) => ({
          history: [
            ...state.history,
            {
              role: "user",
              text: `(The user reverted your change to ${item.summary.replace(/^\w+ /, "")}.)`,
            },
          ],
        }));
        scheduleSave();
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
      }
    },

    refreshKeyStatus: async () => {
      try {
        set({ keyStatus: await aiKeyStatus() });
      } catch (error) {
        useUiStore.getState().setLastError(String(error));
      }
    },
  };
});
