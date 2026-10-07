import { listen } from "@tauri-apps/api/event";
import { aiCancel, aiComplete, aiStream, type AiProvider } from "../ipc";
import { createAccumulator } from "./streaming";
import type {
  ModelReply,
  ToolCall,
  ToolDefinition,
  Turn,
} from "./types";

/**
 * Wire-format adapters for Anthropic Messages, OpenAI Chat Completions,
 * and Google Gemini generateContent. Rust adds auth and does the HTTP
 * (keys never touch the webview); everything about message shape lives
 * here.
 */

export interface CompletionRequest {
  provider: AiProvider;
  model: string;
  system: string;
  history: Turn[];
  tools: ToolDefinition[];
  maxTokens: number;
  /** OpenAI-compatible base URL override (OpenAI provider only). */
  baseUrl: string | null;
}

let localIdCounter = 0;
function localCallId(): string {
  localIdCounter += 1;
  return `call_${Date.now().toString(36)}_${localIdCounter}`;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Surface the problem to the tool executor rather than guessing.
    return { __invalidJson: raw };
  }
}

/** Merge consecutive same-role messages (stricter APIs require
 *  alternation; a stopped run can leave two user turns in a row). */
function mergeAdjacent<T extends { role: string }>(
  messages: T[],
  merge: (a: T, b: T) => T,
): T[] {
  const merged: T[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      merged[merged.length - 1] = merge(last, message);
    } else {
      merged.push(message);
    }
  }
  return merged;
}

// --- Anthropic ----------------------------------------------------------------

type AnthropicBlock = Record<string, unknown> & { type: string };
interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function anthropicBody(request: CompletionRequest) {
  const messages = mergeAdjacent<AnthropicMessage>(
    request.history.map((turn): AnthropicMessage => {
      if (turn.role === "user") {
        return { role: "user", content: [{ type: "text", text: turn.text }] };
      }
      if (turn.role === "tool") {
        return {
          role: "user",
          content: turn.results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.callId,
            content: result.content || "(empty)",
            is_error: result.isError,
          })),
        };
      }
      if (
        turn.raw?.provider === "anthropic" &&
        (turn.raw.value as AnthropicBlock[]).length > 0
      ) {
        return { role: "assistant", content: turn.raw.value as AnthropicBlock[] };
      }
      const content: AnthropicBlock[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      if (content.length === 0) content.push({ type: "text", text: "(no response)" });
      return { role: "assistant", content };
    }),
    (a, b) => ({ role: a.role, content: [...a.content, ...b.content] }),
  );

  // Prompt caching: the system prompt + tools, and the conversation so
  // far, are reused on every step of an agent run. Mark both cache
  // breakpoints (copying the last block so stored history isn't mutated).
  const last = messages[messages.length - 1];
  if (last && last.content.length > 0) {
    const blocks = [...last.content];
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1],
      cache_control: { type: "ephemeral" },
    };
    messages[messages.length - 1] = { ...last, content: blocks };
  }

  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
    ],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    messages,
  };
}

function parseAnthropic(response: unknown): ModelReply {
  const body = response as {
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const content = body.content ?? [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const toolCalls: ToolCall[] = content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: String(block.id),
      name: String(block.name),
      args: parseArgs(block.input),
    }));
  const usage = body.usage ?? {};
  return {
    text,
    toolCalls,
    raw: content,
    stopReason:
      body.stop_reason === "end_turn" ? "end" : (body.stop_reason ?? "end"),
    usage: {
      input:
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      output: usage.output_tokens ?? 0,
    },
  };
}

// --- OpenAI -------------------------------------------------------------------

type OpenAiMessage = Record<string, unknown> & { role: string };

function openAiBody(request: CompletionRequest) {
  const messages: OpenAiMessage[] = [{ role: "system", content: request.system }];
  for (const turn of request.history) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "tool") {
      for (const result of turn.results) {
        messages.push({
          role: "tool",
          tool_call_id: result.callId,
          content: result.isError ? `Error: ${result.content}` : result.content || "(empty)",
        });
      }
    } else {
      const message: OpenAiMessage = { role: "assistant", content: turn.text || null };
      if (turn.toolCalls.length > 0) {
        message.tool_calls = turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
      }
      messages.push(message);
    }
  }
  return {
    model: request.model,
    messages,
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    // OpenAI's current models take max_completion_tokens; most
    // OpenAI-compatible servers still expect max_tokens.
    ...(request.baseUrl
      ? { max_tokens: request.maxTokens }
      : { max_completion_tokens: request.maxTokens }),
  };
}

function parseOpenAi(response: unknown): ModelReply {
  const body = response as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
    id: call.id || localCallId(),
    name: call.function.name,
    args: parseArgs(call.function.arguments),
  }));
  const finish = choice?.finish_reason ?? "stop";
  return {
    text: message.content ?? "",
    toolCalls,
    raw: message,
    stopReason:
      finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end",
    usage: {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
    },
  };
}

// --- Google Gemini --------------------------------------------------------------

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function geminiBody(request: CompletionRequest) {
  const contents = mergeAdjacent<GeminiContent>(
    request.history.map((turn): GeminiContent => {
      if (turn.role === "user") return { role: "user", parts: [{ text: turn.text }] };
      if (turn.role === "tool") {
        return {
          role: "user",
          parts: turn.results.map((result) => ({
            functionResponse: {
              name: result.name,
              response: result.isError
                ? { error: result.content }
                : { result: result.content },
            },
          })),
        };
      }
      // Replaying Gemini's own parts keeps its thought signatures, which
      // multi-step function calling requires.
      if (
        turn.raw?.provider === "google" &&
        (turn.raw.value as GeminiPart[]).length > 0
      ) {
        return { role: "model", parts: turn.raw.value as GeminiPart[] };
      }
      const parts: GeminiPart[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      if (parts.length === 0) parts.push({ text: "(no response)" });
      return { role: "model", parts };
    }),
    (a, b) => ({ role: a.role, parts: [...a.parts, ...b.parts] }),
  );
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents,
    tools: [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ],
    generationConfig: { maxOutputTokens: request.maxTokens },
  };
}

function parseGemini(response: unknown): ModelReply {
  const body = response as {
    candidates?: {
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const candidate = body.candidates?.[0];
  if (!candidate) {
    const reason = body.promptFeedback?.blockReason;
    throw new Error(
      reason ? `Gemini blocked the request (${reason})` : "Gemini returned no response",
    );
  }
  const parts = candidate.content?.parts ?? [];
  const text = parts
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text as string)
    .join("");
  const toolCalls: ToolCall[] = parts
    .filter((part) => part.functionCall)
    .map((part) => {
      const call = part.functionCall as { name: string; args?: unknown; id?: string };
      return { id: call.id ?? localCallId(), name: call.name, args: parseArgs(call.args) };
    });
  const finish = candidate.finishReason ?? "STOP";
  return {
    text,
    toolCalls,
    raw: parts,
    stopReason:
      toolCalls.length > 0 ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end",
    usage: {
      input: body.usageMetadata?.promptTokenCount ?? 0,
      output: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// --- Streaming ------------------------------------------------------------------------

let streamCounter = 0;

/** The provider body with streaming switched on. */
function streamingBody(request: CompletionRequest) {
  if (request.provider === "anthropic") return { ...anthropicBody(request), stream: true };
  if (request.provider === "openai") {
    return {
      ...openAiBody(request),
      stream: true,
      // Usage arrives in a final chunk; OpenAI-compatible servers may
      // not accept the option, so only ask OpenAI itself.
      ...(request.baseUrl ? {} : { stream_options: { include_usage: true } }),
    };
  }
  return geminiBody(request); // the endpoint (streamGenerateContent) streams
}

export interface StreamHandle {
  /** Resolves with the full reply once the stream ends. */
  reply: Promise<ModelReply>;
  /** Abort the HTTP request (Stop). The reply then rejects with "cancelled". */
  cancel: () => void;
}

/**
 * One streamed model call: `onText` receives visible text as it arrives;
 * the reply resolves with the same shape `complete()` returns.
 */
export function completeStreaming(
  request: CompletionRequest,
  onText: (delta: string) => void,
): StreamHandle {
  streamCounter += 1;
  const streamId = `stream-${Date.now().toString(36)}-${streamCounter}`;
  const accumulator = createAccumulator(request.provider);
  let streamError: unknown = null;
  let markDone = () => {};
  const doneSeen = new Promise<void>((resolve) => (markDone = resolve));

  const reply = (async () => {
    // Listen *before* starting the request so no early event is lost.
    const unlisten = await listen<{ streamId: string; data?: string; done?: boolean }>("ai:stream", (event) => {
      if (event.payload.streamId !== streamId) return;
      if (event.payload.done) {
        markDone();
        return;
      }
      if (streamError || event.payload.data === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.payload.data);
      } catch {
        return; // not JSON (shouldn't happen) — skip
      }
      try {
        const text = accumulator.push(parsed);
        if (text) onText(text);
      } catch (error) {
        streamError = error; // an `error` event mid-stream
      }
    });
    try {
      await aiStream(
        request.provider,
        request.model,
        streamingBody(request),
        request.provider === "openai" ? request.baseUrl : null,
        streamId,
      );
      // Events can trail the command's return; wait for the end marker
      // (bounded, in case it was lost).
      await Promise.race([doneSeen, new Promise((resolve) => setTimeout(resolve, 2000))]);
    } finally {
      unlisten();
    }
    if (streamError) throw streamError;
    return accumulator.finish();
  })();

  return { reply, cancel: () => void aiCancel(streamId).catch(() => {}) };
}

// --- Entry point ------------------------------------------------------------------

/** One model call: build the provider body, send via Rust, normalize. */
export async function complete(request: CompletionRequest): Promise<ModelReply> {
  const body =
    request.provider === "anthropic"
      ? anthropicBody(request)
      : request.provider === "openai"
        ? openAiBody(request)
        : geminiBody(request);
  const response = await aiComplete(
    request.provider,
    request.model,
    body,
    request.provider === "openai" ? request.baseUrl : null,
  );
  return request.provider === "anthropic"
    ? parseAnthropic(response)
    : request.provider === "openai"
      ? parseOpenAi(response)
      : parseGemini(response);
}
