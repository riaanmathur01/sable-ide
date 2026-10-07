import type { AiProvider } from "../ipc";
import type { ModelReply, ToolCall } from "./types";

/**
 * Stream accumulators: fold a provider's streamed events (one SSE `data`
 * payload each, already JSON-parsed) into the same ModelReply the
 * non-streaming adapters produce — including the raw assistant message
 * replayed on the next turn (Anthropic thinking blocks with signatures,
 * Gemini thought signatures). Pure; unit-tested with recorded events.
 */
export interface StreamAccumulator {
  /** Feed one event; returns any new visible text (for live display). */
  push(event: unknown): string;
  finish(): ModelReply;
}

let streamCallId = 0;
function localCallId(): string {
  streamCallId += 1;
  return `call_${Date.now().toString(36)}_s${streamCallId}`;
}

function parseJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { __invalidJson: text };
  }
}

// --- Anthropic ----------------------------------------------------------------------

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; json: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "other"; value: Record<string, unknown> };

function anthropicAccumulator(): StreamAccumulator {
  const blocks: AnthropicBlock[] = [];
  let stopReason = "end";
  const usage = { input: 0, output: 0 };

  return {
    push(raw) {
      const event = raw as Record<string, any>;
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage ?? {};
          usage.input =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          usage.output = u.output_tokens ?? 0;
          return "";
        }
        case "content_block_start": {
          const block = event.content_block ?? {};
          blocks[event.index] =
            block.type === "text"
              ? { type: "text", text: block.text ?? "" }
              : block.type === "tool_use"
                ? { type: "tool_use", id: block.id, name: block.name, json: "" }
                : block.type === "thinking"
                  ? { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" }
                  : { type: "other", value: block };
          return block.type === "text" ? (block.text ?? "") : "";
        }
        case "content_block_delta": {
          const block = blocks[event.index];
          const delta = event.delta ?? {};
          if (!block) return "";
          if (delta.type === "text_delta" && block.type === "text") {
            block.text += delta.text;
            return delta.text;
          }
          if (delta.type === "input_json_delta" && block.type === "tool_use") {
            block.json += delta.partial_json;
          } else if (delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += delta.thinking;
          } else if (delta.type === "signature_delta" && block.type === "thinking") {
            block.signature += delta.signature;
          }
          return "";
        }
        case "message_delta":
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason === "end_turn" ? "end" : event.delta.stop_reason;
          }
          if (event.usage?.output_tokens != null) usage.output = event.usage.output_tokens;
          return "";
        case "error":
          throw new Error(`Anthropic API error: ${event.error?.message ?? "stream error"}`);
        default:
          return "";
      }
    },
    finish() {
      const present = blocks.filter(Boolean);
      const raw = present.map((block) =>
        block.type === "tool_use"
          ? { type: "tool_use", id: block.id, name: block.name, input: parseJson(block.json) }
          : block.type === "other"
            ? block.value
            : block,
      );
      const toolCalls: ToolCall[] = present
        .filter((block): block is Extract<AnthropicBlock, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, args: parseJson(block.json) }));
      const text = present
        .filter((block): block is Extract<AnthropicBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { text, toolCalls, raw, stopReason, usage };
    },
  };
}

// --- OpenAI (Chat Completions) -------------------------------------------------------

function openAiAccumulator(): StreamAccumulator {
  let text = "";
  const calls: { id: string; name: string; args: string }[] = [];
  let finish = "stop";
  const usage = { input: 0, output: 0 };

  return {
    push(raw) {
      const event = raw as Record<string, any>;
      if (event.error) throw new Error(`OpenAI API error: ${event.error.message ?? "stream error"}`);
      if (event.usage) {
        usage.input = event.usage.prompt_tokens ?? usage.input;
        usage.output = event.usage.completion_tokens ?? usage.output;
      }
      const choice = event.choices?.[0];
      if (!choice) return "";
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta ?? {};
      for (const callDelta of delta.tool_calls ?? []) {
        const index = callDelta.index ?? calls.length;
        calls[index] ??= { id: "", name: "", args: "" };
        if (callDelta.id) calls[index].id = callDelta.id;
        if (callDelta.function?.name) calls[index].name += callDelta.function.name;
        if (callDelta.function?.arguments) calls[index].args += callDelta.function.arguments;
      }
      if (typeof delta.content === "string") {
        text += delta.content;
        return delta.content;
      }
      return "";
    },
    finish() {
      const present = calls.filter(Boolean);
      const toolCalls: ToolCall[] = present.map((call) => ({
        id: call.id || localCallId(),
        name: call.name,
        args: parseJson(call.args),
      }));
      return {
        text,
        toolCalls,
        raw: {
          role: "assistant",
          content: text || null,
          ...(present.length > 0
            ? {
                tool_calls: present.map((call, index) => ({
                  id: toolCalls[index].id,
                  type: "function",
                  function: { name: call.name, arguments: call.args },
                })),
              }
            : {}),
        },
        stopReason:
          finish === "tool_calls" || toolCalls.length > 0
            ? "tool_use"
            : finish === "length"
              ? "max_tokens"
              : "end",
        usage,
      };
    },
  };
}

// --- Google Gemini -----------------------------------------------------------------------

function geminiAccumulator(): StreamAccumulator {
  const parts: Record<string, any>[] = [];
  let finish = "STOP";
  const usage = { input: 0, output: 0 };

  return {
    push(raw) {
      const event = raw as Record<string, any>;
      if (event.error) throw new Error(`Google API error: ${event.error.message ?? "stream error"}`);
      if (event.usageMetadata) {
        usage.input = event.usageMetadata.promptTokenCount ?? usage.input;
        usage.output = event.usageMetadata.candidatesTokenCount ?? usage.output;
      }
      const candidate = event.candidates?.[0];
      if (!candidate) {
        const reason = event.promptFeedback?.blockReason;
        if (reason) throw new Error(`Gemini blocked the request (${reason})`);
        return "";
      }
      if (candidate.finishReason) finish = candidate.finishReason;
      let visible = "";
      for (const part of candidate.content?.parts ?? []) {
        const last = parts[parts.length - 1];
        // Merge streamed text pieces (same kind, no signature) into one
        // part; anything else (function calls, signed parts) stays whole.
        const mergeable =
          typeof part.text === "string" &&
          !part.thoughtSignature &&
          last &&
          typeof last.text === "string" &&
          !last.thoughtSignature &&
          Boolean(last.thought) === Boolean(part.thought);
        if (mergeable) last.text += part.text;
        else parts.push({ ...part });
        if (typeof part.text === "string" && !part.thought) visible += part.text;
      }
      return visible;
    },
    finish() {
      const text = parts
        .filter((part) => typeof part.text === "string" && !part.thought)
        .map((part) => part.text as string)
        .join("");
      const toolCalls: ToolCall[] = parts
        .filter((part) => part.functionCall)
        .map((part) => ({
          id: part.functionCall.id ?? localCallId(),
          name: part.functionCall.name,
          args: (part.functionCall.args as Record<string, unknown>) ?? {},
        }));
      return {
        text,
        toolCalls,
        raw: parts,
        stopReason: toolCalls.length > 0 ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end",
        usage,
      };
    },
  };
}

export function createAccumulator(provider: AiProvider): StreamAccumulator {
  return provider === "anthropic"
    ? anthropicAccumulator()
    : provider === "openai"
      ? openAiAccumulator()
      : geminiAccumulator();
}
