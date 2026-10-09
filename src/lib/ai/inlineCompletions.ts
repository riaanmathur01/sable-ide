import type * as MonacoTypes from "monaco-editor";
import { complete } from "./providers";
import { getSetting, useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { pathFromUri } from "../editorRegistry";

/**
 * Inline AI completions (grey ghost text, Tab to accept), from a fast
 * model of the agent's provider. Off by default: each suggestion is an
 * API call on your key.
 */

const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 1500;
const MAX_LINES = 30;
/** Wait for a pause in typing before asking. */
const DEBOUNCE_MS = 350;

const SYSTEM = [
  "You are a code completion engine inside an editor.",
  "The user message is a file with a <CURSOR> marker.",
  "Reply with exactly the text to insert at <CURSOR>: no explanation, no markdown fences,",
  "and nothing that's already before or after the cursor.",
  "Complete the current statement or block and stop at a natural end (at most about 15 lines).",
  "Match the file's indentation and style. If no completion makes sense, reply with nothing.",
].join(" ");

/** The prompt for a completion at the cursor. */
export function completionPrompt(path: string, language: string, prefix: string, suffix: string): string {
  const before = prefix.slice(-PREFIX_CHARS);
  const after = suffix.slice(0, SUFFIX_CHARS);
  return `File: ${path} (${language})\n\n${before}<CURSOR>${after}`;
}

/**
 * The model's reply, made safe to insert: no fences, no repeat of the
 * line before the cursor or of the text after it, a bounded length.
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/<CURSOR>/g, "");
  // Markdown fences, despite instructions.
  const fenced = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1];
  // A repeat of the current line's start.
  const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
  // (Including just the indentation the cursor is already after.)
  if (linePrefix && text.startsWith(linePrefix)) {
    text = text.slice(linePrefix.length);
  } else if (linePrefix.trim() && text.trimStart().startsWith(linePrefix.trim())) {
    text = text.trimStart().slice(linePrefix.trim().length);
  }
  // A repeat of what's after the cursor on this line (e.g. a closing
  // bracket the editor already inserted).
  const lineSuffix = suffix.split("\n")[0].trim();
  if (lineSuffix && text.trimEnd().endsWith(lineSuffix)) {
    text = text.trimEnd().slice(0, -lineSuffix.length);
  }
  // Starting a new line when the cursor's line is empty: drop the
  // duplicate newline.
  if (!linePrefix.trim() && text.startsWith("\n")) text = text.slice(1);
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join("\n");
  return text.trim() ? text.replace(/\s+$/, "") : "";
}

function modelFor(provider: "anthropic" | "openai" | "google"): string {
  return provider === "anthropic"
    ? getSetting("ai.inlineAnthropicModel")
    : provider === "openai"
      ? getSetting("ai.inlineOpenaiModel")
      : getSetting("ai.inlineGoogleModel");
}

/** Recent results by prefix/suffix, so moving back and forth doesn't re-ask. */
const cache = new Map<string, string>();
let reportedError = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function provide(
  model: MonacoTypes.editor.ITextModel,
  position: MonacoTypes.Position,
  token: MonacoTypes.CancellationToken,
): Promise<MonacoTypes.languages.InlineCompletions> {
  const none = { items: [] };
  if (!getSetting("ai.inlineCompletions") || model.uri.scheme !== "file") return none;
  const offset = model.getOffsetAt(position);
  const text = model.getValue();
  const prefix = text.slice(0, offset);
  const suffix = text.slice(offset);
  // Mid-word, or with code right after the cursor: not a good moment.
  const restOfLine = suffix.split("\n")[0];
  if (/^\w/.test(restOfLine) || /^\s*[^\s)\]}'"`;,]/.test(restOfLine)) return none;
  const key = `${prefix.slice(-500)}\u0000${suffix.slice(0, 200)}`;
  let completion = cache.get(key);
  if (completion === undefined) {
    await sleep(DEBOUNCE_MS);
    if (token.isCancellationRequested) return none;
    const provider = getSetting("ai.provider");
    try {
      const reply = await complete({
        provider,
        model: modelFor(provider),
        system: SYSTEM,
        history: [{ role: "user", text: completionPrompt(pathFromUri(model.uri), model.getLanguageId(), prefix, suffix) }],
        tools: [],
        maxTokens: 256,
        baseUrl: getSetting("ai.openaiBaseUrl") || null,
      });
      completion = cleanCompletion(reply.text, prefix, suffix);
      reportedError = false;
    } catch (error) {
      if (!reportedError) {
        reportedError = true;
        useUiStore.getState().showStatus(`Inline completions: ${String(error)}`);
      }
      return none;
    }
    cache.set(key, completion);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  if (!completion || token.isCancellationRequested) return none;
  return {
    items: [
      {
        insertText: completion,
        range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
      },
    ],
  };
}

export function registerInlineCompletions(monaco: typeof MonacoTypes) {
  monaco.languages.registerInlineCompletionsProvider("*", {
    provideInlineCompletions: (model, position, _context, token) => provide(model, position, token),
    disposeInlineCompletions: () => {},
  });
}

/** Command palette: turn inline completions on or off. */
export function toggleInlineCompletions() {
  const enabled = !getSetting("ai.inlineCompletions");
  useSettingsStore.getState().set("ai.inlineCompletions", enabled);
  useUiStore
    .getState()
    .showStatus(enabled ? "Inline AI completions on — Tab accepts a suggestion" : "Inline AI completions off");
}
