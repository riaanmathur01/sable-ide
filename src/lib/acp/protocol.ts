/**
 * The Agent Client Protocol (ACP, https://agentclientprotocol.com), v1:
 * the types Sable uses, as in the schema of @agentclientprotocol/sdk 1.8.0
 * (schema/schema.json) / spec 1.11.0. Kept here rather than depending on
 * the SDK at runtime: the transport is Sable's (Rust relays the agent's
 * stdio lines as window events), so only the shapes are needed.
 */

export const PROTOCOL_VERSION = 1;

/** JSON-RPC error codes ACP uses. */
export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  authRequired: -32000,
  resourceNotFound: -32002,
  cancelled: -32800,
} as const;

export type Meta = Record<string, unknown> | null | undefined;

// --- Content -------------------------------------------------------------------------------

export interface Annotations {
  audience?: ("assistant" | "user")[] | null;
  lastModified?: string | null;
  priority?: number | null;
}
export type ContentBlock =
  | { type: "text"; text: string; annotations?: Annotations | null; _meta?: Meta }
  | { type: "image"; data: string; mimeType: string; uri?: string | null; _meta?: Meta }
  | { type: "audio"; data: string; mimeType: string; _meta?: Meta }
  | { type: "resource_link"; uri: string; name: string; title?: string | null; description?: string | null; mimeType?: string | null; size?: number | null; _meta?: Meta }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string | null } | { uri: string; blob: string; mimeType?: string | null }; _meta?: Meta };

// --- Initialization and auth ---------------------------------------------------------------

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  auth?: { terminal?: boolean; _meta?: Meta };
  session?: { configOptions?: { boolean?: object | null } | null; notices?: object | null; compaction?: object | null } | null;
  elicitation?: { form?: object | null; url?: object | null } | null;
  _meta?: Meta;
}

export interface Implementation {
  name: string;
  title?: string | null;
  version: string;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: {
    list?: object | null;
    delete?: object | null;
    resume?: object | null;
    close?: object | null;
    fork?: object | null;
    additionalDirectories?: object | null;
  };
  auth?: { logout?: object | null };
  _meta?: Meta;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** "terminal": run the agent's launch command plus `args` in a terminal; else ("agent"): `authenticate`. */
  type?: "terminal" | "agent" | string;
  args?: string[];
  env?: Record<string, string>;
  _meta?: Meta;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: Implementation | null;
  _meta?: Meta;
}

// --- Sessions -------------------------------------------------------------------------------

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}
export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}
export interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}
export interface ConfigSelectGroup {
  group: string;
  name: string;
  options: ConfigSelectOption[];
}
export type SessionConfigOption = {
  id: string;
  name: string;
  description?: string | null;
  /** "mode" | "model" | "model_config" | "thought_level" | custom. */
  category?: string | null;
  _meta?: Meta;
} & (
  | { type: "select"; currentValue: string; options: ConfigSelectOption[] | ConfigSelectGroup[] }
  | { type: "boolean"; currentValue: boolean }
);

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  type?: "http" | "sse";
  url?: string;
  headers?: { name: string; value: string }[];
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  _meta?: Meta;
}
export type LoadSessionResponse = Omit<NewSessionResponse, "sessionId">;

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Meta;
}
export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string | null;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;
export interface Usage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}
export interface PromptResponse {
  stopReason: StopReason;
  usage?: Usage | null;
  _meta?: Meta;
}

// --- Updates ----------------------------------------------------------------------------------

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}
export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string; _meta?: Meta }
  | { type: "terminal"; terminalId: string };

export interface ToolCall {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Meta;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}
export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & ToolCall)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: "notice"; severity: string; title: string; description?: string | null }
  | { sessionUpdate: "compaction_update"; compactionId: string; status: string; error?: string | null }
  | { sessionUpdate: "compaction_summary_chunk"; compactionId: string; content: ContentBlock }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// --- Agent → client requests ---------------------------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}
export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}
export type RequestPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

export interface ReadTextFileRequest {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}
export interface WriteTextFileRequest {
  sessionId: string;
  path: string;
  content: string;
}
export interface CreateTerminalRequest {
  sessionId: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string | null;
  outputByteLimit?: number | null;
}
export interface TerminalExitStatus {
  exitCode?: number | null;
  signal?: string | null;
}

export interface ElicitationRequest {
  sessionId?: string;
  toolCallId?: string;
  requestId?: string | number;
  message: string;
  mode: "form" | "url" | string;
  /** mode "url" */
  elicitationId?: string;
  url?: string;
  /** mode "form": a flat JSON schema. */
  requestedSchema?: { type?: "object"; properties: Record<string, { type: string; title?: string; description?: string; enum?: string[]; default?: unknown }>; required?: string[] };
}
export type ElicitationResponse = { action: "accept"; content?: Record<string, unknown> } | { action: "decline" } | { action: "cancel" };

/** Method names. */
export const AGENT_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  logout: "logout",
  newSession: "session/new",
  loadSession: "session/load",
  listSessions: "session/list",
  resumeSession: "session/resume",
  closeSession: "session/close",
  deleteSession: "session/delete",
  setMode: "session/set_mode",
  setConfigOption: "session/set_config_option",
  prompt: "session/prompt",
  cancel: "session/cancel",
} as const;

export const CLIENT_METHODS = {
  update: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
  createTerminal: "terminal/create",
  terminalOutput: "terminal/output",
  waitForExit: "terminal/wait_for_exit",
  killTerminal: "terminal/kill",
  releaseTerminal: "terminal/release",
  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
} as const;

export const CANCEL_REQUEST = "$/cancel_request";
