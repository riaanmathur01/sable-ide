import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderTree,
  GitBranch,
  GitPullRequest,
  History,
  KeyRound,
  Loader2,
  Pencil,
  Search,
  Settings,
  SquarePen,
  Square,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  useAgentStore,
  type ChatItem,
  type Conversation,
} from "../../store/agentStore";
import { useUiStore } from "../../store/uiStore";
import { useTabsStore } from "../../store/tabsStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useSettingsStore, type Settings as SettingsShape } from "../../store/settingsStore";
import type { AiProvider } from "../../lib/ipc";
import { Markdown } from "./Markdown";
import "./AgentPanel.css";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

const MODEL_SETTING: Record<AiProvider, keyof SettingsShape> = {
  anthropic: "ai.anthropicModel",
  openai: "ai.openaiModel",
  google: "ai.googleModel",
};

const SUGGESTIONS = [
  "Explain how this project is structured",
  "Find and fix the bug in the current file",
  "Write tests for the selected code",
  "Review my uncommitted changes, then commit them",
];

const TOOL_ICONS: Record<string, typeof FileText> = {
  list_directory: FolderTree,
  find_files: Search,
  search: Search,
  read_file: FileText,
  edit_file: Pencil,
  write_file: Pencil,
  delete_path: Trash2,
  run_command: SquareTerminal,
  git: GitBranch,
  github: GitPullRequest,
};

/**
 * The AI agent chat (right-hand panel, ⌘L). Shows the conversation, each
 * tool call as a collapsible card (with approve/deny and revert), and the
 * input box. All behavior lives in agentStore.
 */
export function AgentPanel() {
  const items = useAgentStore((state) => state.items);
  const isRunning = useAgentStore((state) => state.isRunning);
  const status = useAgentStore((state) => state.status);
  const usage = useAgentStore((state) => state.usage);
  const keyStatus = useAgentStore((state) => state.keyStatus);
  const draft = useAgentStore((state) => state.draft);
  const { setDraft, send, stop, newChat, refreshKeyStatus } = useAgentStore.getState();
  const width = useUiStore((state) => state.panelSizes.agentWidth);
  const focusRequest = useUiStore((state) => state.agentFocusRequest);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const provider = useSettingsStore((state) => state.values["ai.provider"]);
  const model = useSettingsStore((state) => state.values[MODEL_SETTING[provider]]) as string;
  const setSetting = useSettingsStore((state) => state.set);

  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (keyStatus === null) void refreshKeyStatus();
  }, [keyStatus, refreshKeyStatus]);

  useEffect(() => {
    if (focusRequest > 0) inputRef.current?.focus();
  }, [focusRequest]);

  // Follow new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [items, status]);

  // Auto-grow the textarea up to a limit.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [draft]);

  const hasKey = keyStatus?.[provider] ?? true;
  const canSend = draft.trim() !== "" && !isRunning && Boolean(rootPath);

  function submit() {
    if (!canSend) return;
    stickToBottom.current = true;
    void send(draft);
  }

  return (
    <aside className="agent-panel" style={{ width }}>
      <div className="agent-header">
        <span className="agent-title">{showHistory ? "Chats" : "Agent"}</span>
        <div className="agent-header-actions">
          <button
            title="New chat"
            onClick={() => {
              newChat();
              setShowHistory(false);
              inputRef.current?.focus();
            }}
          >
            <SquarePen size={14} strokeWidth={1.5} />
          </button>
          <button
            title={showHistory ? "Back to chat" : "Chat history"}
            className={showHistory ? "active" : undefined}
            onClick={() => setShowHistory(!showHistory)}
          >
            <History size={14} strokeWidth={1.5} />
          </button>
          <button
            title="Agent settings"
            onClick={() => useTabsStore.getState().openSettings()}
          >
            <Settings size={14} strokeWidth={1.5} />
          </button>
          <button
            title="Close (⌥⌘A)"
            onClick={() => useUiStore.getState().toggleAgent()}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {showHistory && <ChatHistory onOpen={() => setShowHistory(false)} />}
      <div
        className="agent-messages"
        style={{ display: showHistory ? "none" : undefined }}
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {!hasKey && (
          <div className="agent-callout">
            <KeyRound size={14} strokeWidth={1.5} />
            <div>
              Add your {PROVIDER_LABELS[provider]} API key to start.
              <button onClick={() => useTabsStore.getState().openSettings()}>
                Open Settings
              </button>
            </div>
          </div>
        )}
        {items.length === 0 ? (
          <div className="agent-empty">
            <div className="agent-empty-title">What should we build?</div>
            <div className="agent-empty-text">
              The agent can read and edit files, search the project, run
              commands, and use git and GitHub. It sees your active file and
              selection.
            </div>
            {rootPath ? (
              <div className="agent-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => {
                      setDraft(suggestion);
                      inputRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              <div className="agent-empty-text">Open a folder to get started.</div>
            )}
          </div>
        ) : (
          items.map((item) => <ChatItemView key={item.id} item={item} />)
        )}
        {isRunning && status && !isStreamingVisible(items) && (
          <div className="agent-status">
            <Loader2 size={13} className="spinning" />
            <span>{status}</span>
          </div>
        )}
      </div>

      <div className="agent-composer">
        <textarea
          ref={inputRef}
          rows={2}
          placeholder={
            rootPath ? "Ask the agent to change code, run tests, open a PR…" : "Open a folder first"
          }
          value={draft}
          disabled={!rootPath}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape" && isRunning) stop();
          }}
        />
        <div className="agent-composer-bar">
          <select
            className="agent-provider"
            value={provider}
            title="Provider"
            onChange={(event) => setSetting("ai.provider", event.target.value as AiProvider)}
          >
            {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
          <input
            className="agent-model"
            value={model}
            title="Model id (change it here or in Settings, where you can fetch the list)"
            spellCheck={false}
            onChange={(event) =>
              setSetting(MODEL_SETTING[provider], event.target.value as never)
            }
          />
          <span className="agent-usage" title="Tokens used in this chat (input / output)">
            {usage.input + usage.output > 0 &&
              `${formatTokens(usage.input)} / ${formatTokens(usage.output)}`}
          </span>
          {isRunning ? (
            <button className="agent-send stop" title="Stop (Esc)" onClick={stop}>
              <Square size={12} strokeWidth={2} fill="currentColor" />
            </button>
          ) : (
            <button
              className="agent-send"
              title="Send (Enter)"
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** While reply text is streaming in, the message itself shows progress. */
function isStreamingVisible(items: ChatItem[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === "assistant" && Boolean(last.streaming) && last.text.length > 0;
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

/** Every saved chat in this workspace; click to reopen. */
function ChatHistory({ onOpen }: { onOpen: () => void }) {
  const conversations = useAgentStore((state) => state.conversations);
  const activeId = useAgentStore((state) => state.activeId);
  const isRunning = useAgentStore((state) => state.isRunning);
  const activeItems = useAgentStore((state) => state.items);
  const { switchChat, deleteChat } = useAgentStore.getState();

  // The active chat's live title/size (its list entry syncs on save).
  const live = (conversation: Conversation) =>
    conversation.id === activeId ? { ...conversation, items: activeItems } : conversation;
  const shown = conversations
    .map(live)
    .filter((conversation) => conversation.items.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="agent-history">
      {isRunning && (
        <div className="agent-history-note">Stop the agent to switch chats.</div>
      )}
      {shown.length === 0 && (
        <div className="agent-history-note">No chats yet in this folder.</div>
      )}
      {shown.map((conversation) => {
        const title =
          conversation.id === activeId
            ? (activeItems.find((item) => item.kind === "user") as { text?: string } | undefined)
                ?.text?.split("\n")[0] ?? conversation.title
            : conversation.title;
        const messages = conversation.items.filter((item) => item.kind === "user").length;
        return (
          <div
            key={conversation.id}
            className={
              conversation.id === activeId ? "agent-history-item active" : "agent-history-item"
            }
            onClick={() => {
              if (isRunning) return;
              switchChat(conversation.id);
              onOpen();
            }}
            title={title}
          >
            <div className="agent-history-text">
              <div className="agent-history-title">{title}</div>
              <div className="agent-history-meta">
                {relativeTime(conversation.updatedAt)} · {messages} message
                {messages === 1 ? "" : "s"}
              </div>
            </div>
            <button
              className="agent-history-delete"
              title="Delete chat"
              disabled={isRunning && conversation.id === activeId}
              onClick={(event) => {
                event.stopPropagation();
                deleteChat(conversation.id);
              }}
            >
              <Trash2 size={12} strokeWidth={1.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="agent-user">
          <div className="agent-user-text">{item.text}</div>
          {item.contextLabel && (
            <div className="agent-user-context">with {item.contextLabel}</div>
          )}
        </div>
      );
    case "assistant":
      if (!item.text) return null; // streaming placeholder before the first token
      return (
        <div className={item.streaming ? "agent-assistant streaming" : "agent-assistant"}>
          <Markdown source={item.text} />
        </div>
      );
    case "notice":
      return (
        <div className={`agent-notice ${item.tone}`}>
          {item.tone === "error" && <CircleAlert size={13} strokeWidth={1.5} />}
          <span>{item.text}</span>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
  }
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = useAgentStore((state) => state.isRunning);
  const { respondToApproval, revert } = useAgentStore.getState();
  const Icon = TOOL_ICONS[item.call.name] ?? SquareTerminal;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const awaiting = item.status === "awaiting-approval";
  const command =
    item.call.name === "run_command" || item.call.name === "git" || item.call.name === "github";

  let statusIcon: React.ReactNode = null;
  if (item.status === "running") statusIcon = <Loader2 size={12} className="spinning" />;
  else if (item.status === "done") statusIcon = <Check size={12} className="tool-ok" />;
  else if (item.status === "error") statusIcon = <CircleAlert size={12} className="tool-error" />;
  else if (item.status === "denied") statusIcon = <span className="tool-tag">denied</span>;
  else if (item.status === "cancelled") statusIcon = <span className="tool-tag">cancelled</span>;

  const editPath = item.edit?.path;

  return (
    <div className={`agent-tool status-${item.status}`}>
      <div className="agent-tool-header" onClick={() => setExpanded(!expanded)}>
        <Chevron size={12} strokeWidth={1.5} className="agent-tool-chevron" />
        <Icon size={13} strokeWidth={1.5} className="agent-tool-icon" />
        <span className={command ? "agent-tool-summary mono" : "agent-tool-summary"}>
          {item.summary}
        </span>
        {item.reverted && <span className="tool-tag">reverted</span>}
        {statusIcon}
      </div>

      {awaiting && (
        <div className="agent-approval">
          <span>
            {item.approval === "edit"
              ? "Allow this file change?"
              : "Allow this command to run?"}
          </span>
          <div className="agent-approval-actions">
            <button className="primary" onClick={() => respondToApproval(item.id, "allow")}>
              Allow
            </button>
            {item.approval === "command" && (
              <button onClick={() => respondToApproval(item.id, "allow-all")}>
                Allow all in this chat
              </button>
            )}
            <button onClick={() => respondToApproval(item.id, "deny")}>Deny</button>
          </div>
        </div>
      )}

      {(expanded || awaiting) && <ToolDetails item={item} />}

      {editPath && !item.reverted && item.status === "done" && (
        <div className="agent-tool-actions">
          {item.edit?.after !== null && (
            <button
              onClick={() => void useTabsStore.getState().openFile(editPath)}
            >
              Open
            </button>
          )}
          <button
            disabled={isRunning}
            title={isRunning ? "Available when the agent is idle" : "Undo this change"}
            onClick={() => void revert(item.id)}
          >
            <Undo2 size={11} strokeWidth={1.75} /> Revert
          </button>
        </div>
      )}
    </div>
  );
}

/** Arguments (for approvals/inspection) and output of a tool call. */
function ToolDetails({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const args = item.call.args;
  let preview: React.ReactNode = null;
  if (item.call.name === "edit_file") {
    preview = (
      <div className="agent-diff">
        <pre className="removed">{String(args.old_string ?? "")}</pre>
        <pre className="added">{String(args.new_string ?? "")}</pre>
      </div>
    );
  } else if (item.call.name === "write_file") {
    const content = String(args.content ?? "");
    preview = (
      <pre className="agent-tool-output">
        {content.length > 4000 ? `${content.slice(0, 4000)}\n…` : content}
      </pre>
    );
  } else if (item.status === "awaiting-approval" && item.call.name === "run_command") {
    preview = <pre className="agent-tool-output">{String(args.command ?? "")}</pre>;
  }
  return (
    <div className="agent-tool-details">
      {preview}
      {item.output != null && (
        <pre className={item.status === "error" ? "agent-tool-output error" : "agent-tool-output"}>
          {item.output}
        </pre>
      )}
    </div>
  );
}
