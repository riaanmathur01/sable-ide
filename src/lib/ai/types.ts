import type { AiProvider } from "../ipc";

/**
 * Provider-neutral conversation model. The agent loop only ever deals in
 * these types; providers.ts translates them to and from each API's wire
 * format, so switching provider mid-chat keeps working.
 */

/** JSON-schema subset that all three providers accept for tool params. */
export interface JsonSchema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /**
       * The provider's own message, replayed verbatim to the same
       * provider. Needed for state the neutral form can't carry
       * (Anthropic thinking blocks, Gemini thought signatures).
       */
      raw?: { provider: AiProvider; value: unknown };
    }
  | { role: "tool"; results: ToolResult[] };

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  raw: unknown;
  /** Normalized: "end" | "tool_use" | "max_tokens" | other provider value. */
  stopReason: string;
  usage: { input: number; output: number };
}
