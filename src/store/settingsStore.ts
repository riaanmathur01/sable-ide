import { create } from "zustand";
import { loadSettings, saveSettings, settingsPath } from "../lib/ipc";
import { useUiStore } from "./uiStore";
import { cachedThemeId, type ThemeId } from "../lib/themes";

/**
 * User settings. The schema below is the single source of truth: it
 * defines every setting's key, type, default, and how the Settings view
 * renders it. Only values that differ from the default are written to
 * settings.json (like VS Code), so changing a default later reaches
 * everyone who never touched it.
 */

/** "JetBrains Mono" is the copy bundled with Sable (lib/fonts.ts). */
export const MONO_FONT_STACK = '"JetBrains Mono", "SF Mono", Menlo, monospace';

export interface Settings {
  "workbench.colorTheme": ThemeId;
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.fontWeight": "300" | "400" | "500" | "600" | "700";
  "editor.lineHeight": number;
  "editor.fontLigatures": boolean;
  "editor.tabSize": number;
  "editor.insertSpaces": boolean;
  "editor.detectIndentation": boolean;
  "editor.wordWrap": "off" | "on";
  "editor.minimap": boolean;
  "editor.inlayHints": boolean;
  "editor.lineNumbers": "on" | "relative" | "off";
  "editor.rulers": string;
  "editor.renderWhitespace": "none" | "selection" | "boundary" | "all";
  "editor.cursorStyle": "line" | "block" | "underline";
  "editor.cursorBlinking": "smooth" | "blink" | "phase" | "expand" | "solid";
  "editor.smoothCaret": boolean;
  "editor.bracketPairColorization": boolean;
  "editor.semanticHighlighting": boolean;
  "editor.bracketPairGuides": boolean;
  "editor.stickyScroll": boolean;
  "editor.smoothScrolling": boolean;
  "editor.autoClosingBrackets": boolean;
  "editor.linkedEditing": boolean;
  "editor.mouseWheelZoom": boolean;
  "editor.formatOnSave": boolean;
  "editor.formatOnPaste": boolean;
  "editor.trimTrailingWhitespace": boolean;
  "editor.insertFinalNewline": boolean;
  "files.autoSave": boolean;
  "files.autoSaveDelay": number;
  "terminal.fontSize": number;
  "terminal.fontFamily": string;
  "terminal.cursorBlink": boolean;
  "ai.provider": "anthropic" | "openai" | "google";
  "ai.anthropicModel": string;
  "ai.openaiModel": string;
  "ai.googleModel": string;
  "ai.openaiBaseUrl": string;
  "ai.maxTokens": number;
  "ai.maxSteps": number;
  "ai.autoApproveEdits": boolean;
  "ai.autoApproveCommands": boolean;
  "ai.commandTimeout": number;
  "ai.includeEditorContext": boolean;
  "ai.customInstructions": string;
  "ai.quickFixes": boolean;
  "ai.inlineCompletions": boolean;
  "ai.inlineAnthropicModel": string;
  "ai.inlineOpenaiModel": string;
  "ai.inlineGoogleModel": string;
  "updates.checkOnStartup": boolean;
}

export type SettingKey = keyof Settings;

interface BaseSpec<K extends SettingKey> {
  key: K;
  section: string;
  label: string;
  description: string;
  default: Settings[K];
}

export type SettingSpec =
  | (BaseSpec<SettingKey> & { type: "boolean" })
  | (BaseSpec<SettingKey> & {
      type: "number";
      min: number;
      max: number;
      step?: number;
    })
  | (BaseSpec<SettingKey> & {
      type: "string";
      multiline?: boolean;
      placeholder?: string;
      /** Render as a dropdown of installed monospace fonts. */
      fontPicker?: boolean;
    })
  | (BaseSpec<SettingKey> & {
      type: "enum";
      options: { value: string; label: string }[];
    });

export const SETTINGS_SCHEMA: SettingSpec[] = [
  // --- Editor: text ---------------------------------------------------------
  { key: "editor.fontSize", section: "Editor", type: "number", min: 8, max: 32, label: "Font Size", description: "Editor font size in pixels. ⌘= / ⌘- / ⌘0 also adjust it.", default: 13 },
  { key: "editor.fontFamily", section: "Editor", type: "string", fontPicker: true, label: "Font Family", description: "Editor font. JetBrains Mono is bundled with Sable; the rest are the monospace fonts installed on this computer.", default: MONO_FONT_STACK },
  { key: "editor.fontWeight", section: "Editor", type: "enum", options: [{ value: "300", label: "Light" }, { value: "400", label: "Regular" }, { value: "500", label: "Medium" }, { value: "600", label: "Semibold" }, { value: "700", label: "Bold" }], label: "Font Weight", description: "Stroke weight of editor text. Regular matches PyCharm's default; Medium reads heavier on dark themes.", default: "400" },
  { key: "editor.lineHeight", section: "Editor", type: "number", min: 1, max: 3, step: 0.1, label: "Line Height", description: "Line height as a multiple of the font size.", default: 1.6 },
  { key: "editor.fontLigatures", section: "Editor", type: "boolean", label: "Font Ligatures", description: "Render ligatures like => and != as single glyphs (off by default, like PyCharm).", default: false },
  { key: "editor.tabSize", section: "Editor", type: "number", min: 1, max: 8, label: "Tab Size", description: "Spaces per indentation level.", default: 2 },
  { key: "editor.insertSpaces", section: "Editor", type: "boolean", label: "Insert Spaces", description: "Pressing Tab inserts spaces instead of a tab character.", default: true },
  { key: "editor.detectIndentation", section: "Editor", type: "boolean", label: "Detect Indentation", description: "Match each file's existing indentation instead of the settings above.", default: true },
  { key: "editor.wordWrap", section: "Editor", type: "enum", options: [{ value: "off", label: "Off" }, { value: "on", label: "Wrap at viewport" }], label: "Word Wrap", description: "Wrap long lines. ⌥Z toggles it.", default: "off" },
  { key: "editor.rulers", section: "Editor", type: "string", placeholder: "e.g. 80, 120", label: "Rulers", description: "Comma-separated columns at which to draw vertical rulers.", default: "" },
  // --- Editor: appearance ---------------------------------------------------
  { key: "workbench.colorTheme", section: "Editor Appearance", type: "enum", options: [{ value: "sable-dark", label: "Sable Dark" }, { value: "jetbrains-darcula", label: "JetBrains Darcula" }, { value: "jetbrains-dark", label: "JetBrains Dark (New UI)" }, { value: "jetbrains-islands-dark", label: "JetBrains Islands Dark" }, { value: "catppuccin-mocha", label: "Catppuccin Mocha" }], label: "Color Theme", description: "Colors for the whole app: editor syntax, panels, and terminal. The JetBrains themes use the exact colors of JetBrains' schemes, per language as in each JetBrains IDE; Catppuccin Mocha matches the JetBrains Catppuccin plugin.", default: "sable-dark" },
  { key: "editor.lineNumbers", section: "Editor Appearance", type: "enum", options: [{ value: "on", label: "On" }, { value: "relative", label: "Relative" }, { value: "off", label: "Off" }], label: "Line Numbers", description: "How line numbers are shown.", default: "on" },
  { key: "editor.inlayHints", section: "Editor Appearance", type: "boolean", label: "Inlay Hints", description: "Show argument names (and other hints from the language server) inline in the code, greyed out, like JetBrains IDEs. Hold ⌃⌥ to hide them temporarily.", default: true },
  { key: "editor.minimap", section: "Editor Appearance", type: "boolean", label: "Minimap", description: "Show a zoomed-out overview of the file on the right edge, with errors, warnings, search matches and breakpoints marked. Click or drag it to scroll.", default: true },
  { key: "editor.renderWhitespace", section: "Editor Appearance", type: "enum", options: [{ value: "none", label: "None" }, { value: "selection", label: "In selection" }, { value: "boundary", label: "Boundary" }, { value: "all", label: "All" }], label: "Render Whitespace", description: "When to draw whitespace characters.", default: "selection" },
  { key: "editor.cursorStyle", section: "Editor Appearance", type: "enum", options: [{ value: "line", label: "Line" }, { value: "block", label: "Block" }, { value: "underline", label: "Underline" }], label: "Cursor Style", description: "Shape of the text cursor.", default: "line" },
  { key: "editor.cursorBlinking", section: "Editor Appearance", type: "enum", options: [{ value: "smooth", label: "Smooth" }, { value: "blink", label: "Blink" }, { value: "phase", label: "Phase" }, { value: "expand", label: "Expand" }, { value: "solid", label: "Solid" }], label: "Cursor Blinking", description: "Cursor animation style.", default: "smooth" },
  { key: "editor.smoothCaret", section: "Editor Appearance", type: "boolean", label: "Smooth Caret Animation", description: "Animate the cursor as it moves.", default: true },
  { key: "editor.semanticHighlighting", section: "Editor Appearance", type: "boolean", label: "Semantic Highlighting", description: "Color names by what they are — parameters, self, classes, builtins, function definitions — like JetBrains IDEs. Comes from the language server: TypeScript, Rust, Go, C/C++, Java; for Python, install basedpyright (button below or ⇧⌘P → “Python: Install basedpyright”).", default: true },
  { key: "editor.bracketPairColorization", section: "Editor Appearance", type: "boolean", label: "Bracket Pair Colors", description: "Color matching brackets by nesting depth (rainbow brackets).", default: false },
  { key: "editor.bracketPairGuides", section: "Editor Appearance", type: "boolean", label: "Bracket Pair Guides", description: "Draw guides connecting the active bracket pair.", default: true },
  { key: "editor.stickyScroll", section: "Editor Appearance", type: "boolean", label: "Sticky Scroll", description: "Pin the enclosing function/class headers to the top while scrolling.", default: true },
  { key: "editor.smoothScrolling", section: "Editor Appearance", type: "boolean", label: "Smooth Scrolling", description: "Ease scrolling: each wheel scroll goes as far as usual, speeding up and slowing down along a bell curve, and settles on a whole line.", default: true },
  // --- Editor: behavior -----------------------------------------------------
  { key: "editor.autoClosingBrackets", section: "Editing", type: "boolean", label: "Auto-close Brackets & Quotes", description: "Insert the closing bracket or quote as you type the opening one.", default: true },
  { key: "editor.linkedEditing", section: "Editing", type: "boolean", label: "Linked Editing", description: "Rename matching HTML/JSX tags together.", default: true },
  { key: "editor.mouseWheelZoom", section: "Editing", type: "boolean", label: "Mouse Wheel Zoom", description: "Zoom the editor font with ⌘ + scroll.", default: true },
  { key: "editor.formatOnSave", section: "Editing", type: "boolean", label: "Format on Save", description: "Format the file on manual save (⌘S) when a formatter exists (JS/TS, JSON, CSS, HTML).", default: false },
  { key: "editor.formatOnPaste", section: "Editing", type: "boolean", label: "Format on Paste", description: "Format pasted code when a formatter exists.", default: false },
  { key: "editor.trimTrailingWhitespace", section: "Editing", type: "boolean", label: "Trim Trailing Whitespace", description: "Remove trailing whitespace on manual save.", default: false },
  { key: "editor.insertFinalNewline", section: "Editing", type: "boolean", label: "Insert Final Newline", description: "Ensure files end with a newline on manual save.", default: false },
  { key: "files.autoSave", section: "Editing", type: "boolean", label: "Auto Save", description: "Save files automatically shortly after you stop typing.", default: true },
  { key: "files.autoSaveDelay", section: "Editing", type: "number", min: 200, max: 10000, step: 100, label: "Auto Save Delay (ms)", description: "How long after the last keystroke auto-save waits.", default: 800 },
  // --- Terminal ---------------------------------------------------------------
  { key: "terminal.fontSize", section: "Terminal", type: "number", min: 8, max: 28, step: 0.5, label: "Font Size", description: "Terminal font size in pixels.", default: 12.5 },
  { key: "terminal.fontFamily", section: "Terminal", type: "string", fontPicker: true, label: "Font Family", description: "Terminal font. Nerd Fonts show icons from shell prompts like Starship or Powerlevel10k.", default: MONO_FONT_STACK },
  { key: "terminal.cursorBlink", section: "Terminal", type: "boolean", label: "Cursor Blink", description: "Blink the terminal cursor.", default: true },
  // --- AI agent -----------------------------------------------------------------
  { key: "ai.provider", section: "AI Agent", type: "enum", options: [{ value: "anthropic", label: "Anthropic" }, { value: "openai", label: "OpenAI" }, { value: "google", label: "Google" }], label: "Provider", description: "Which provider the agent uses.", default: "anthropic" },
  { key: "ai.anthropicModel", section: "AI Agent", type: "string", label: "Anthropic Model", description: "Model id used when the provider is Anthropic.", default: "claude-opus-5-5" },
  { key: "ai.openaiModel", section: "AI Agent", type: "string", label: "OpenAI Model", description: "Model id used when the provider is OpenAI.", default: "gpt-5" },
  { key: "ai.googleModel", section: "AI Agent", type: "string", label: "Google Model", description: "Model id used when the provider is Google.", default: "gemini-pro-latest" },
  { key: "ai.openaiBaseUrl", section: "AI Agent", type: "string", placeholder: "https://api.openai.com/v1", label: "OpenAI Base URL", description: "Point the OpenAI provider at any OpenAI-compatible API (OpenRouter, Ollama, LM Studio…). Leave empty for OpenAI.", default: "" },
  { key: "ai.maxTokens", section: "AI Agent", type: "number", min: 1024, max: 64000, step: 1024, label: "Max Output Tokens", description: "Upper bound on each model response (Anthropic requires one).", default: 8192 },
  { key: "ai.maxSteps", section: "AI Agent", type: "number", min: 1, max: 200, label: "Max Steps per Request", description: "How many model ↔ tool round-trips one request may take.", default: 40 },
  { key: "ai.autoApproveEdits", section: "AI Agent", type: "boolean", label: "Auto-approve File Edits", description: "Let the agent create, edit, and delete files without asking. Every edit can still be reverted from the chat.", default: true },
  { key: "ai.autoApproveCommands", section: "AI Agent", type: "boolean", label: "Auto-approve Commands", description: "Let the agent run shell, git, and GitHub commands without asking. Read-only git commands never ask.", default: false },
  { key: "ai.commandTimeout", section: "AI Agent", type: "number", min: 5, max: 1800, label: "Command Timeout (s)", description: "Commands the agent runs are killed after this long.", default: 120 },
  { key: "ai.includeEditorContext", section: "AI Agent", type: "boolean", label: "Include Editor Context", description: "Send the active file, cursor, selection, and open tabs with each message.", default: true },
  { key: "ai.quickFixes", section: "AI Agent", type: "boolean", label: "Agent Quick Fixes", description: "Offer “Fix with Agent” and “Explain with Agent” in the quick-fix menu (lightbulb or ⌘.) for every error and warning.", default: true },
  { key: "ai.inlineCompletions", section: "AI Completions", type: "boolean", label: "Inline Completions", description: "Suggest code as you type, as grey text — Tab accepts it. Uses the agent's provider and API key (each suggestion is a small API call).", default: false },
  { key: "ai.inlineAnthropicModel", section: "AI Completions", type: "string", label: "Anthropic Model", description: "A fast model for suggestions when the provider is Anthropic.", default: "claude-haiku-4-5-20251001" },
  { key: "ai.inlineOpenaiModel", section: "AI Completions", type: "string", label: "OpenAI Model", description: "A fast model for suggestions when the provider is OpenAI.", default: "gpt-5-mini" },
  { key: "ai.inlineGoogleModel", section: "AI Completions", type: "string", label: "Google Model", description: "A fast model for suggestions when the provider is Google.", default: "gemini-flash-latest" },
  { key: "updates.checkOnStartup", section: "Updates", type: "boolean", label: "Check for Updates on Startup", description: "Look for a newer Sable when it starts, and say so in the status bar. “Check for Updates” in the command palette installs it.", default: true },
  { key: "ai.customInstructions", section: "AI Agent", type: "string", multiline: true, placeholder: "e.g. Prefer functional components. Always add tests.", label: "Custom Instructions", description: "Extra guidance appended to the agent's system prompt.", default: "" },
];

const SPEC_BY_KEY = new Map(SETTINGS_SCHEMA.map((spec) => [spec.key, spec]));

export const DEFAULT_SETTINGS = Object.fromEntries(
  SETTINGS_SCHEMA.map((spec) => [spec.key, spec.default]),
) as unknown as Settings;

/** Coerce a raw value from settings.json; undefined if it's invalid. */
function validate(spec: SettingSpec, value: unknown): unknown {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.min(spec.max, Math.max(spec.min, value))
        : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
    case "enum":
      return spec.options.some((option) => option.value === value)
        ? value
        : undefined;
  }
}

interface SettingsState {
  values: Settings;
  /** Absolute path of settings.json (for "Open settings.json"). */
  filePath: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  set: <K extends SettingKey>(key: K, value: Settings[K]) => void;
  reset: (key: SettingKey) => void;
}

const SAVE_DEBOUNCE_MS = 300;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Keys present in settings.json that this version doesn't know — kept
 *  so we never delete a setting a newer build (or the user) added. */
let unknownEntries: Record<string, unknown> = {};

function persist(values: Settings) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const overrides: Record<string, unknown> = { ...unknownEntries };
    for (const spec of SETTINGS_SCHEMA) {
      const value = values[spec.key];
      if (value !== spec.default) overrides[spec.key] = value;
    }
    saveSettings(overrides).catch((error) =>
      useUiStore.getState().setLastError(String(error)),
    );
  }, SAVE_DEBOUNCE_MS);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: DEFAULT_SETTINGS,
  filePath: null,
  loaded: false,

  load: async () => {
    try {
      const [raw, filePath] = await Promise.all([loadSettings(), settingsPath()]);
      const values = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
      unknownEntries = {};
      for (const [key, value] of Object.entries(raw)) {
        const spec = SPEC_BY_KEY.get(key as SettingKey);
        if (!spec) {
          unknownEntries[key] = value;
          continue;
        }
        const valid = validate(spec, value);
        if (valid !== undefined) values[key] = valid;
      }
      set({ values: values as unknown as Settings, filePath, loaded: true });
    } catch (error) {
      // Keep defaults (or the previous values) and say why.
      set({ loaded: true });
      useUiStore.getState().setLastError(String(error));
    }
  },

  set: (key, value) => {
    const spec = SPEC_BY_KEY.get(key);
    const valid = spec ? validate(spec, value) : value;
    if (valid === undefined) return;
    const values = { ...get().values, [key]: valid };
    set({ values });
    persist(values);
  },

  reset: (key) => {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) return;
    const values = { ...get().values, [key]: spec.default };
    set({ values });
    persist(values);
  },
}));

/** Reactive single-setting hook for components. */
export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettingsStore((state) => state.values[key]);
}

/**
 * The color theme to render with. Before settings.json has loaded, use
 * last session's theme so the first paint isn't the default.
 */
export function useColorTheme(): ThemeId {
  return useSettingsStore((state) =>
    state.loaded ? state.values["workbench.colorTheme"] : cachedThemeId(),
  );
}

/** Non-reactive read for stores and plain functions. */
export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettingsStore.getState().values[key];
}
