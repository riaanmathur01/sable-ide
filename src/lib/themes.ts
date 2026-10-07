/**
 * Color themes. Each theme defines palettes that must agree:
 *   - `ui`: the CSS design tokens from theme.css (sidebar, panels, …)
 *   - `tokenColors`: TextMate scope rules — the real syntax colors.
 *     Highlighting uses VS Code's TextMate grammars (via Shiki, see
 *     shikiMonaco.ts), so these can target precise scopes: builtins,
 *     method calls, f-string placeholders, `self`, decorators, …
 *   - `editor`: Monaco editor colors, plus coarse Monarch rules used only
 *     for languages without a TextMate grammar (and the instant before
 *     grammars load)
 *   - `terminal`: the xterm.js palette
 *
 * The JetBrains themes port IntelliJ's open-source (Apache-2.0) Darcula
 * and New UI Dark schemes. Catppuccin Mocha (MIT) follows the JetBrains
 * Catppuccin plugin, which differs slightly from the VS Code port.
 *
 * Only plain data lives here (no Monaco import), so the main bundle can
 * apply UI colors at startup without loading the editor.
 */

export type ThemeId =
  | "sable-dark"
  | "jetbrains-darcula"
  | "jetbrains-dark"
  | "catppuccin-mocha";

/** One TextMate theme rule (VS Code's `tokenColors` format). */
export interface TokenColorRule {
  scope: string | string[];
  settings: { foreground?: string; fontStyle?: string };
}

/** Monaco's IStandaloneThemeData, kept structural to avoid importing it. */
export interface EditorThemeData {
  base: "vs-dark";
  inherit: boolean;
  rules: { token: string; foreground?: string; background?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

export interface TerminalPalette {
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Colors for Sable's semantic categories (lib/lsp/semanticTokens.ts). */
export type SemanticStyles = Record<
  | "sem-parameter"
  | "sem-self"
  | "sem-class-decl"
  | "sem-class"
  | "sem-type-param"
  | "sem-function-decl"
  | "sem-function-call"
  | "sem-dunder-decl"
  | "sem-builtin"
  | "sem-decorator"
  | "sem-property"
  | "sem-property-static"
  | "sem-enum-member",
  { foreground: string; fontStyle?: string }
>;

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  ui: Record<string, string>;
  /** Default text color for TextMate highlighting. */
  foreground: string;
  /** Rules applied on top of `baseTokenColors` (later rules win). */
  tokenColors: TokenColorRule[];
  /** Start from a published theme's token colors (loaded with Shiki). */
  baseTokenColors?: "catppuccin-mocha";
  editor: EditorThemeData;
  /** Semantic highlighting (needs a language server that provides it). */
  semantic: SemanticStyles;
  terminal: TerminalPalette;
}

/** Theme rules for the semantic categories (appended to Monaco themes). */
export function semanticRules(theme: ThemeDefinition) {
  return Object.entries(theme.semantic).map(([token, style]) => ({
    token,
    foreground: style.foreground.replace("#", ""),
    fontStyle: style.fontStyle ?? "",
  }));
}

const SABLE: ThemeDefinition = {
  id: "sable-dark",
  label: "Sable Dark",
  foreground: "#e6e6e9",
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#5c5c66", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.control", "constant.language", "variable.language"], settings: { foreground: "#7c93ff" } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#8a8a93" } },
    { scope: ["keyword.operator.logical.python", "keyword.operator.word", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: "#7c93ff" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#a3be8c" } },
    { scope: ["constant.character.escape", "constant.character.format.placeholder", "punctuation.definition.template-expression", "punctuation.section.embedded"], settings: { foreground: "#d4a373" } },
    { scope: ["constant.numeric", "constant.other", "variable.other.constant"], settings: { foreground: "#d4a373" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "storage.type.java", "storage.type.primitive"], settings: { foreground: "#8fb8d4" } },
    { scope: ["entity.name.function", "meta.function-call", "support.function", "meta.decorator", "entity.name.function.decorator", "storage.type.annotation"], settings: { foreground: "#b0a3e0" } },
    { scope: ["variable.language.special.self", "variable.parameter.function.language.special.self", "variable.language.this"], settings: { foreground: "#8fb8d4", fontStyle: "italic" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#7c93ff" } },
    { scope: ["entity.other.attribute-name", "support.type.property-name"], settings: { foreground: "#8fb8d4" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#7c93ff", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#a3be8c" } },
    { scope: ["markup.underline.link"], settings: { foreground: "#8fb8d4" } },
  ],
  ui: {
    "--bg-base": "#0d0d0f",
    "--bg-panel": "#161618",
    "--bg-elevated": "#1e1e22",
    "--border": "#2a2a30",
    "--text": "#e6e6e9",
    "--text-muted": "#8a8a93",
    "--accent": "#7c93ff",
    "--on-accent": "#0d0d0f",
    "--danger": "#f87171",
    "--git-modified": "#d6a55c",
    "--git-added": "#6cc070",
    "--git-deleted": "#d66c6c",
  },
  editor: {
    base: "vs-dark",
    inherit: true,
    // Calm and desaturated so the UI accent stays the only loud color.
    rules: [
      { token: "comment", foreground: "5c5c66", fontStyle: "italic" },
      { token: "keyword", foreground: "7c93ff" },
      { token: "string", foreground: "a3be8c" },
      { token: "number", foreground: "d4a373" },
      { token: "regexp", foreground: "d4a373" },
      { token: "type", foreground: "8fb8d4" },
      { token: "class", foreground: "8fb8d4" },
      { token: "interface", foreground: "8fb8d4" },
      { token: "function", foreground: "b0a3e0" },
      { token: "variable", foreground: "e6e6e9" },
      { token: "constant", foreground: "d4a373" },
      { token: "annotation", foreground: "b0a3e0" },
      { token: "tag", foreground: "7c93ff" },
      { token: "tag.python", foreground: "b0a3e0" },
      { token: "attribute.name", foreground: "8fb8d4" },
      { token: "string.key.json", foreground: "8fb8d4" },
      { token: "delimiter", foreground: "8a8a93" },
    ],
    colors: {
      "editor.background": "#0d0d0f",
      "editor.foreground": "#e6e6e9",
      "editorLineNumber.foreground": "#3f3f46",
      "editorLineNumber.activeForeground": "#8a8a93",
      "editorCursor.foreground": "#7c93ff",
      "editor.selectionBackground": "#7c93ff33",
      "editor.inactiveSelectionBackground": "#7c93ff1a",
      "editor.lineHighlightBackground": "#16161866",
      "editor.lineHighlightBorder": "#00000000",
      "editorWhitespace.foreground": "#2a2a30",
      "editorIndentGuide.background1": "#1e1e22",
      "editorIndentGuide.activeBackground1": "#2a2a30",
      "editorWidget.background": "#1e1e22",
      "editorWidget.border": "#2a2a30",
      "editorSuggestWidget.background": "#1e1e22",
      "editorSuggestWidget.border": "#2a2a30",
      "editorSuggestWidget.selectedBackground": "#7c93ff26",
      "editorHoverWidget.background": "#1e1e22",
      "editorHoverWidget.border": "#2a2a30",
      "scrollbarSlider.background": "#2a2a3066",
      "scrollbarSlider.hoverBackground": "#2a2a30aa",
      "scrollbarSlider.activeBackground": "#2a2a30dd",
      "editorBracketMatch.background": "#7c93ff26",
      "editorBracketMatch.border": "#7c93ff66",
      "editorBracketHighlight.foreground1": "#7c93ff",
      "editorBracketHighlight.foreground2": "#b0a3e0",
      "editorBracketHighlight.foreground3": "#8fb8d4",
      "editorBracketHighlight.unexpectedBracket.foreground": "#f87171",
      "editorBracketPairGuide.activeBackground1": "#7c93ff66",
      "editorBracketPairGuide.activeBackground2": "#b0a3e066",
      "editorBracketPairGuide.activeBackground3": "#8fb8d466",
      "editorRuler.foreground": "#2a2a30",
      "editorStickyScroll.background": "#0d0d0f",
      "editorStickyScroll.shadow": "#00000066",
      "editorStickyScrollHover.background": "#161618",
      "editorGutter.background": "#0d0d0f",
      "editorError.foreground": "#f87171",
      "editorWarning.foreground": "#d6a55c",
      "editorInfo.foreground": "#7c93ff",
      "editorLightBulb.foreground": "#d6a55c",
      "editorLightBulbAutoFix.foreground": "#7c93ff",
      "editorOverviewRuler.errorForeground": "#f87171",
      "editorOverviewRuler.warningForeground": "#d6a55c",
    },
  },
  semantic: {
    "sem-parameter": { foreground: "#c8c8cf", fontStyle: "italic" },
    "sem-self": { foreground: "#8fb8d4", fontStyle: "italic" },
    "sem-class-decl": { foreground: "#8fb8d4" },
    "sem-class": { foreground: "#8fb8d4" },
    "sem-type-param": { foreground: "#8fb8d4", fontStyle: "italic" },
    "sem-function-decl": { foreground: "#b0a3e0" },
    "sem-function-call": { foreground: "#b0a3e0" },
    "sem-dunder-decl": { foreground: "#b0a3e0", fontStyle: "italic" },
    "sem-builtin": { foreground: "#7c93ff" },
    "sem-decorator": { foreground: "#b0a3e0" },
    "sem-property": { foreground: "#e6e6e9" },
    "sem-property-static": { foreground: "#d4a373" },
    "sem-enum-member": { foreground: "#d4a373" },
  },
  terminal: {
    foreground: "#e6e6e9",
    cursor: "#7c93ff",
    selectionBackground: "#7c93ff33",
    black: "#161618",
    red: "#f87171",
    green: "#6cc070",
    yellow: "#d6a55c",
    blue: "#7c93ff",
    magenta: "#b0a3e0",
    cyan: "#8fb8d4",
    white: "#c8c8cf",
    brightBlack: "#8a8a93",
    brightRed: "#fca5a5",
    brightGreen: "#a3be8c",
    brightYellow: "#e6c07b",
    brightBlue: "#a5b4ff",
    brightMagenta: "#d0c6f5",
    brightCyan: "#b4d4e6",
    brightWhite: "#ffffff",
  },
};

const DARCULA: ThemeDefinition = {
  id: "jetbrains-darcula",
  label: "JetBrains Darcula",
  foreground: "#a9b7c6",
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#808080" } },
    { scope: ["comment.block.documentation", "string.quoted.docstring", "comment.block.javadoc"], settings: { foreground: "#629755", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.control", "constant.language", "keyword.operator.logical.python", "keyword.operator.word", "keyword.operator.new", "keyword.operator.expression", "variable.language.this", "variable.language.super"], settings: { foreground: "#cc7832" } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#a9b7c6" } },
    { scope: ["punctuation.separator.comma", "punctuation.separator.element", "punctuation.separator.parameters", "punctuation.separator.arguments", "punctuation.terminator", "punctuation.separator.delimiter"], settings: { foreground: "#cc7832" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#6a8759" } },
    { scope: ["constant.character.escape", "constant.character.format.placeholder", "punctuation.definition.template-expression", "storage.type.string.python"], settings: { foreground: "#cc7832" } },
    { scope: ["constant.numeric"], settings: { foreground: "#6897bb" } },
    { scope: ["entity.name.function"], settings: { foreground: "#ffc66d" } },
    { scope: ["meta.function-call", "entity.name.function.member", "meta.method-call entity.name.function"], settings: { foreground: "#a9b7c6" } },
    { scope: ["support.function.builtin", "support.type.python", "support.function.magic.python", "support.variable.magic.python"], settings: { foreground: "#8888c6" } },
    { scope: ["meta.decorator", "entity.name.function.decorator", "punctuation.definition.decorator", "storage.type.annotation", "punctuation.definition.annotation"], settings: { foreground: "#bbb529" } },
    { scope: ["meta.function.decorator.python support.type.python", "meta.function.decorator.python support.function.builtin.python", "meta.function.decorator.python entity.name.function.decorator.python"], settings: { foreground: "#bbb529" } },
    { scope: ["variable.language.special.self", "variable.parameter.function.language.special.self", "variable.language.special.cls", "variable.parameter.function.language.special.cls"], settings: { foreground: "#94558d" } },
    { scope: ["variable.other.property", "variable.other.object.property", "variable.other.member", "meta.attribute.python"], settings: { foreground: "#9876aa" } },
    { scope: ["variable.other.constant", "constant.other", "variable.other.enummember"], settings: { foreground: "#9876aa", fontStyle: "italic" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#e8bf6a" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#bababa" } },
    { scope: ["meta.attribute string", "string.quoted.double.html", "string.quoted.single.html"], settings: { foreground: "#a5c261" } },
    { scope: ["support.type.property-name"], settings: { foreground: "#9876aa" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#cc7832", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#6a8759" } },
  ],
  ui: {
    "--bg-base": "#2b2b2b",
    "--bg-panel": "#3c3f41",
    "--bg-elevated": "#4c5052",
    "--border": "#2b2b2b",
    "--text": "#bbbbbb",
    "--text-muted": "#8c8c8c",
    "--accent": "#4a88c7",
    "--on-accent": "#ffffff",
    "--danger": "#ff6b68",
    "--git-modified": "#6897bb",
    "--git-added": "#629755",
    "--git-deleted": "#8c8c8c",
  },
  editor: {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "a9b7c6" },
      { token: "comment", foreground: "808080" },
      { token: "comment.doc", foreground: "629755", fontStyle: "italic" },
      { token: "keyword", foreground: "cc7832" },
      { token: "string", foreground: "6a8759" },
      { token: "string.escape", foreground: "cc7832" },
      { token: "number", foreground: "6897bb" },
      { token: "regexp", foreground: "6a8759" },
      { token: "type", foreground: "8888c6" },
      { token: "type.identifier", foreground: "a9b7c6" },
      { token: "identifier", foreground: "a9b7c6" },
      { token: "annotation", foreground: "bbb529" },
      { token: "tag", foreground: "e8bf6a" },
      { token: "tag.python", foreground: "bbb529" },
      { token: "metatag", foreground: "e8bf6a" },
      { token: "attribute.name", foreground: "bababa" },
      { token: "attribute.value", foreground: "a5c261" },
      { token: "string.key.json", foreground: "9876aa" },
      { token: "string.value.json", foreground: "6a8759" },
      { token: "constant", foreground: "9876aa", fontStyle: "italic" },
      { token: "variable.predefined", foreground: "9876aa" },
      { token: "delimiter", foreground: "a9b7c6" },
      { token: "operator", foreground: "a9b7c6" },
    ],
    colors: {
      "editor.background": "#2b2b2b",
      "editor.foreground": "#a9b7c6",
      "editorLineNumber.foreground": "#606366",
      "editorLineNumber.activeForeground": "#a4a3a3",
      "editorGutter.background": "#313335",
      "editorCursor.foreground": "#bbbbbb",
      "editor.selectionBackground": "#214283",
      "editor.inactiveSelectionBackground": "#21428388",
      "editor.lineHighlightBackground": "#323232",
      "editor.lineHighlightBorder": "#00000000",
      "editor.findMatchBackground": "#32593d",
      "editor.findMatchHighlightBackground": "#32593d99",
      "editor.wordHighlightBackground": "#344134",
      "editor.wordHighlightStrongBackground": "#40332b",
      "editorWhitespace.foreground": "#4a4a4a",
      "editorIndentGuide.background1": "#373737",
      "editorIndentGuide.activeBackground1": "#505050",
      "editorRuler.foreground": "#3c3f41",
      "editorBracketMatch.background": "#3b514d",
      "editorBracketMatch.border": "#3b514d",
      "editorBracketHighlight.foreground1": "#ffc66d",
      "editorBracketHighlight.foreground2": "#9876aa",
      "editorBracketHighlight.foreground3": "#6897bb",
      "editorBracketHighlight.unexpectedBracket.foreground": "#ff6b68",
      "editorBracketPairGuide.activeBackground1": "#ffc66d66",
      "editorBracketPairGuide.activeBackground2": "#9876aa66",
      "editorBracketPairGuide.activeBackground3": "#6897bb66",
      "editorWidget.background": "#3c3f41",
      "editorWidget.border": "#515151",
      "editorSuggestWidget.background": "#3c3f41",
      "editorSuggestWidget.border": "#515151",
      "editorSuggestWidget.selectedBackground": "#0d293e",
      "editorSuggestWidget.highlightForeground": "#ffc66d",
      "editorHoverWidget.background": "#3c3f41",
      "editorHoverWidget.border": "#515151",
      "editorStickyScroll.background": "#2b2b2b",
      "editorStickyScroll.shadow": "#00000088",
      "editorStickyScrollHover.background": "#323232",
      "scrollbarSlider.background": "#4e525480",
      "scrollbarSlider.hoverBackground": "#5f6366aa",
      "scrollbarSlider.activeBackground": "#6e7275cc",
      "editorError.foreground": "#bc3f3c",
      "editorWarning.foreground": "#be9117",
      "editorInfo.foreground": "#6897bb",
      "editorUnnecessaryCode.opacity": "#00000088",
      "editorLightBulb.foreground": "#ffc66d",
      "editorLightBulbAutoFix.foreground": "#6897bb",
      "editorOverviewRuler.errorForeground": "#bc3f3c",
      "editorOverviewRuler.warningForeground": "#be9117",
    },
  },
  // IntelliJ Darcula: parameters/classes/calls plain; self purple; method
  // declarations yellow; fields purple; builtins lavender-blue.
  semantic: {
    "sem-parameter": { foreground: "#a9b7c6" },
    "sem-self": { foreground: "#94558d" },
    "sem-class-decl": { foreground: "#a9b7c6" },
    "sem-class": { foreground: "#a9b7c6" },
    "sem-type-param": { foreground: "#20999d" },
    "sem-function-decl": { foreground: "#ffc66d" },
    "sem-function-call": { foreground: "#a9b7c6" },
    "sem-dunder-decl": { foreground: "#b200b2" },
    "sem-builtin": { foreground: "#8888c6" },
    "sem-decorator": { foreground: "#bbb529" },
    "sem-property": { foreground: "#9876aa" },
    "sem-property-static": { foreground: "#9876aa", fontStyle: "italic" },
    "sem-enum-member": { foreground: "#9876aa", fontStyle: "italic" },
  },
  terminal: {
    foreground: "#bbbbbb",
    cursor: "#bbbbbb",
    selectionBackground: "#214283",
    black: "#000000",
    red: "#ff6b68",
    green: "#a8c023",
    yellow: "#d6bf55",
    blue: "#5394ec",
    magenta: "#ae8abe",
    cyan: "#299999",
    white: "#999999",
    brightBlack: "#555555",
    brightRed: "#ff8785",
    brightGreen: "#a8c023",
    brightYellow: "#ffff00",
    brightBlue: "#7eaef1",
    brightMagenta: "#ff99ff",
    brightCyan: "#6cdada",
    brightWhite: "#ffffff",
  },
};

const JETBRAINS_DARK: ThemeDefinition = {
  id: "jetbrains-dark",
  label: "JetBrains Dark (New UI)",
  foreground: "#bcbec4",
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7a7e85" } },
    { scope: ["comment.block.documentation", "string.quoted.docstring", "comment.block.javadoc"], settings: { foreground: "#5f826b", fontStyle: "italic" } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.control", "constant.language", "keyword.operator.logical.python", "keyword.operator.word", "keyword.operator.new", "keyword.operator.expression", "variable.language.this", "variable.language.super"], settings: { foreground: "#cf8e6d" } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#bcbec4" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#6aab73" } },
    { scope: ["constant.character.escape", "constant.character.format.placeholder", "punctuation.definition.template-expression", "storage.type.string.python"], settings: { foreground: "#cf8e6d" } },
    { scope: ["constant.numeric"], settings: { foreground: "#2aacb8" } },
    { scope: ["entity.name.function"], settings: { foreground: "#56a8f5" } },
    { scope: ["meta.function-call", "entity.name.function.member", "meta.method-call entity.name.function"], settings: { foreground: "#bcbec4" } },
    { scope: ["support.function.builtin", "support.type.python", "support.function.magic.python", "support.variable.magic.python"], settings: { foreground: "#8888c6" } },
    { scope: ["meta.decorator", "entity.name.function.decorator", "punctuation.definition.decorator", "storage.type.annotation", "punctuation.definition.annotation"], settings: { foreground: "#b3ae60" } },
    { scope: ["meta.function.decorator.python support.type.python", "meta.function.decorator.python support.function.builtin.python", "meta.function.decorator.python entity.name.function.decorator.python"], settings: { foreground: "#b3ae60" } },
    { scope: ["variable.language.special.self", "variable.parameter.function.language.special.self", "variable.language.special.cls", "variable.parameter.function.language.special.cls"], settings: { foreground: "#94558d" } },
    { scope: ["variable.other.property", "variable.other.object.property", "variable.other.member", "meta.attribute.python"], settings: { foreground: "#c77dbb" } },
    { scope: ["variable.other.constant", "constant.other", "variable.other.enummember"], settings: { foreground: "#c77dbb", fontStyle: "italic" } },
    { scope: ["entity.name.type.parameter", "meta.type.parameters entity.name.type"], settings: { foreground: "#16baac" } },
    { scope: ["entity.name.tag"], settings: { foreground: "#d5b778" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#bababa" } },
    { scope: ["support.type.property-name"], settings: { foreground: "#c77dbb" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "#cf8e6d", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#6aab73" } },
  ],
  ui: {
    "--bg-base": "#1e1f22",
    "--bg-panel": "#2b2d30",
    "--bg-elevated": "#393b40",
    "--border": "#1e1f22",
    "--text": "#dfe1e5",
    "--text-muted": "#868a91",
    "--accent": "#3574f0",
    "--on-accent": "#ffffff",
    "--danger": "#f75464",
    "--git-modified": "#70aeff",
    "--git-added": "#73bd79",
    "--git-deleted": "#868a91",
  },
  editor: {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "bcbec4" },
      { token: "comment", foreground: "7a7e85" },
      { token: "comment.doc", foreground: "5f826b", fontStyle: "italic" },
      { token: "keyword", foreground: "cf8e6d" },
      { token: "string", foreground: "6aab73" },
      { token: "string.escape", foreground: "cf8e6d" },
      { token: "number", foreground: "2aacb8" },
      { token: "regexp", foreground: "42c3d4" },
      { token: "type", foreground: "8888c6" },
      { token: "type.identifier", foreground: "bcbec4" },
      { token: "identifier", foreground: "bcbec4" },
      { token: "annotation", foreground: "b3ae60" },
      { token: "tag", foreground: "d5b778" },
      { token: "tag.python", foreground: "b3ae60" },
      { token: "metatag", foreground: "d5b778" },
      { token: "attribute.name", foreground: "bababa" },
      { token: "attribute.value", foreground: "6aab73" },
      { token: "string.key.json", foreground: "c77dbb" },
      { token: "string.value.json", foreground: "6aab73" },
      { token: "constant", foreground: "c77dbb", fontStyle: "italic" },
      { token: "variable.predefined", foreground: "c77dbb" },
      { token: "delimiter", foreground: "bcbec4" },
      { token: "operator", foreground: "bcbec4" },
    ],
    colors: {
      "editor.background": "#1e1f22",
      "editor.foreground": "#bcbec4",
      "editorLineNumber.foreground": "#4b5059",
      "editorLineNumber.activeForeground": "#a1a3ab",
      "editorGutter.background": "#1e1f22",
      "editorCursor.foreground": "#ced0d6",
      "editor.selectionBackground": "#214283",
      "editor.inactiveSelectionBackground": "#21428388",
      "editor.lineHighlightBackground": "#26282e",
      "editor.lineHighlightBorder": "#00000000",
      "editor.findMatchBackground": "#114957",
      "editor.findMatchHighlightBackground": "#11495799",
      "editor.wordHighlightBackground": "#373b39",
      "editor.wordHighlightStrongBackground": "#402f33",
      "editorWhitespace.foreground": "#6f737a55",
      "editorIndentGuide.background1": "#313438",
      "editorIndentGuide.activeBackground1": "#4e5157",
      "editorRuler.foreground": "#393b40",
      "editorBracketMatch.background": "#43454a",
      "editorBracketMatch.border": "#43454a",
      "editorBracketHighlight.foreground1": "#56a8f5",
      "editorBracketHighlight.foreground2": "#c77dbb",
      "editorBracketHighlight.foreground3": "#cf8e6d",
      "editorBracketHighlight.unexpectedBracket.foreground": "#f75464",
      "editorBracketPairGuide.activeBackground1": "#56a8f566",
      "editorBracketPairGuide.activeBackground2": "#c77dbb66",
      "editorBracketPairGuide.activeBackground3": "#cf8e6d66",
      "editorWidget.background": "#2b2d30",
      "editorWidget.border": "#43454a",
      "editorSuggestWidget.background": "#2b2d30",
      "editorSuggestWidget.border": "#43454a",
      "editorSuggestWidget.selectedBackground": "#2e436e",
      "editorSuggestWidget.highlightForeground": "#56a8f5",
      "editorHoverWidget.background": "#2b2d30",
      "editorHoverWidget.border": "#43454a",
      "editorStickyScroll.background": "#1e1f22",
      "editorStickyScroll.shadow": "#00000088",
      "editorStickyScrollHover.background": "#26282e",
      "scrollbarSlider.background": "#4e515766",
      "scrollbarSlider.hoverBackground": "#5a5d63aa",
      "scrollbarSlider.activeBackground": "#6f737acc",
      "editorError.foreground": "#f75464",
      "editorWarning.foreground": "#e0bb65",
      "editorInfo.foreground": "#3574f0",
      "editorLightBulb.foreground": "#e0bb65",
      "editorLightBulbAutoFix.foreground": "#56a8f5",
      "editorOverviewRuler.errorForeground": "#f75464",
      "editorOverviewRuler.warningForeground": "#e0bb65",
    },
  },
  // IntelliJ New UI Dark.
  semantic: {
    "sem-parameter": { foreground: "#bcbec4" },
    "sem-self": { foreground: "#94558d" },
    "sem-class-decl": { foreground: "#bcbec4" },
    "sem-class": { foreground: "#bcbec4" },
    "sem-type-param": { foreground: "#16baac" },
    "sem-function-decl": { foreground: "#56a8f5" },
    "sem-function-call": { foreground: "#bcbec4" },
    "sem-dunder-decl": { foreground: "#b200b2" },
    "sem-builtin": { foreground: "#8888c6" },
    "sem-decorator": { foreground: "#b3ae60" },
    "sem-property": { foreground: "#c77dbb" },
    "sem-property-static": { foreground: "#c77dbb", fontStyle: "italic" },
    "sem-enum-member": { foreground: "#c77dbb", fontStyle: "italic" },
  },
  terminal: {
    foreground: "#bcbec4",
    cursor: "#ced0d6",
    selectionBackground: "#214283",
    black: "#000000",
    red: "#f0524f",
    green: "#5c962c",
    yellow: "#a68a0d",
    blue: "#3993d4",
    magenta: "#a771bf",
    cyan: "#00a3a3",
    white: "#808080",
    brightBlack: "#595959",
    brightRed: "#ff4050",
    brightGreen: "#4fc414",
    brightYellow: "#e5bf00",
    brightBlue: "#1fb0ff",
    brightMagenta: "#ed7eed",
    brightCyan: "#00e5e5",
    brightWhite: "#ffffff",
  },
};


/**
 * Catppuccin Mocha, matching the JetBrains Catppuccin plugin: the
 * official token colors plus the plugin's differences from the VS Code
 * port — sky operators, peach builtin types, mauve True/False/None, and
 * italic function calls.
 */
const CATPPUCCIN_MOCHA: ThemeDefinition = {
  id: "catppuccin-mocha",
  label: "Catppuccin Mocha",
  ui: {
    "--bg-base": "#1e1e2e",
    "--bg-panel": "#181825",
    "--bg-elevated": "#313244",
    "--border": "#11111b",
    "--text": "#cdd6f4",
    "--text-muted": "#7f849c",
    "--accent": "#cba6f7",
    "--on-accent": "#11111b",
    "--danger": "#f38ba8",
    "--git-modified": "#f9e2af",
    "--git-added": "#a6e3a1",
    "--git-deleted": "#f38ba8",
  },
  foreground: "#cdd6f4",
  baseTokenColors: "catppuccin-mocha",
  tokenColors: [
    { scope: ["keyword.operator", "punctuation.separator.dict.python", "punctuation.separator.key-value", "punctuation.separator.annotation.python"], settings: { foreground: "#89dceb" } },
    { scope: ["keyword.operator.logical.python", "keyword.operator.word", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: "#cba6f7" } },
    { scope: ["support.type.python"], settings: { foreground: "#fab387", fontStyle: "italic" } },
    { scope: ["constant.language.python"], settings: { foreground: "#cba6f7", fontStyle: "" } },
    { scope: ["meta.function-call.generic.python", "meta.function-call.generic", "entity.name.function.member", "meta.method-call entity.name.function"], settings: { foreground: "#89b4fa", fontStyle: "italic" } },
    { scope: ["storage.type.string.python"], settings: { foreground: "#a6e3a1", fontStyle: "" } },
  ],
  editor: {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "cdd6f4" },
      { token: "comment", foreground: "9399b2", fontStyle: "italic" },
      { token: "keyword", foreground: "cba6f7" },
      { token: "string", foreground: "a6e3a1" },
      { token: "string.escape", foreground: "f5c2e7" },
      { token: "number", foreground: "fab387" },
      { token: "regexp", foreground: "f5c2e7" },
      { token: "type", foreground: "f9e2af" },
      { token: "type.identifier", foreground: "f9e2af" },
      { token: "annotation", foreground: "fab387" },
      { token: "tag", foreground: "cba6f7" },
      { token: "tag.python", foreground: "fab387" },
      { token: "attribute.name", foreground: "f9e2af" },
      { token: "string.key.json", foreground: "89b4fa" },
      { token: "delimiter", foreground: "9399b2" },
      { token: "operator", foreground: "89dceb" },
    ],
    colors: {
      "editor.background": "#1e1e2e",
      "editor.foreground": "#cdd6f4",
      "editorLineNumber.foreground": "#6c7086",
      "editorLineNumber.activeForeground": "#b4befe",
      "editorGutter.background": "#1e1e2e",
      "editorCursor.foreground": "#f5e0dc",
      "editor.selectionBackground": "#9399b240",
      "editor.inactiveSelectionBackground": "#9399b226",
      "editor.lineHighlightBackground": "#cdd6f408",
      "editor.lineHighlightBorder": "#00000000",
      "editor.findMatchBackground": "#5e3f53",
      "editor.findMatchHighlightBackground": "#3e5767",
      "editor.wordHighlightBackground": "#9399b233",
      "editor.wordHighlightStrongBackground": "#89b4fa33",
      "editorWhitespace.foreground": "#9399b266",
      "editorIndentGuide.background1": "#313244",
      "editorIndentGuide.activeBackground1": "#45475a",
      "editorRuler.foreground": "#313244",
      "editorBracketMatch.background": "#9399b21a",
      "editorBracketMatch.border": "#9399b2",
      "editorBracketHighlight.foreground1": "#f38ba8",
      "editorBracketHighlight.foreground2": "#fab387",
      "editorBracketHighlight.foreground3": "#f9e2af",
      "editorBracketHighlight.unexpectedBracket.foreground": "#eba0ac",
      "editorWidget.background": "#181825",
      "editorWidget.border": "#313244",
      "editorSuggestWidget.background": "#181825",
      "editorSuggestWidget.border": "#313244",
      "editorSuggestWidget.selectedBackground": "#313244",
      "editorSuggestWidget.highlightForeground": "#cba6f7",
      "editorHoverWidget.background": "#181825",
      "editorHoverWidget.border": "#313244",
      "editorStickyScroll.background": "#1e1e2e",
      "editorStickyScroll.shadow": "#11111b",
      "editorStickyScrollHover.background": "#313244",
      "scrollbarSlider.background": "#585b7066",
      "scrollbarSlider.hoverBackground": "#585b70aa",
      "scrollbarSlider.activeBackground": "#585b70cc",
      "editorError.foreground": "#f38ba8",
      "editorWarning.foreground": "#fab387",
      "editorInfo.foreground": "#89b4fa",
      "editorLightBulb.foreground": "#f9e2af",
      "editorLightBulbAutoFix.foreground": "#89b4fa",
      "editorOverviewRuler.errorForeground": "#f38ba8",
      "editorOverviewRuler.warningForeground": "#fab387",
    },
  },
  // From the JetBrains Catppuccin plugin's color scheme (editor.tera):
  // PARAMETER maroon italic, PY.SELF_PARAMETER red italic, CLASS_NAME
  // yellow italic, FUNCTION_DECLARATION/CALL blue italic, PY.BUILTIN_NAME
  // peach italic, PY.DECORATOR peach, PY.PREDEFINED_DEFINITION sapphire
  // italic, STATIC_FIELD teal, CONSTANT peach.
  semantic: {
    "sem-parameter": { foreground: "#eba0ac", fontStyle: "italic" },
    "sem-self": { foreground: "#f38ba8", fontStyle: "italic" },
    "sem-class-decl": { foreground: "#f9e2af", fontStyle: "italic" },
    "sem-class": { foreground: "#f9e2af" },
    "sem-type-param": { foreground: "#f9e2af", fontStyle: "italic" },
    "sem-function-decl": { foreground: "#89b4fa", fontStyle: "italic" },
    "sem-function-call": { foreground: "#89b4fa", fontStyle: "italic" },
    "sem-dunder-decl": { foreground: "#74c7ec", fontStyle: "italic" },
    "sem-builtin": { foreground: "#fab387", fontStyle: "italic" },
    "sem-decorator": { foreground: "#fab387" },
    "sem-property": { foreground: "#cdd6f4" },
    "sem-property-static": { foreground: "#94e2d5" },
    "sem-enum-member": { foreground: "#fab387" },
  },
  terminal: {
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
};

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  "sable-dark": SABLE,
  "jetbrains-darcula": DARCULA,
  "jetbrains-dark": JETBRAINS_DARK,
  "catppuccin-mocha": CATPPUCCIN_MOCHA,
};

export function themeById(id: string): ThemeDefinition {
  return THEMES[id as ThemeId] ?? SABLE;
}

/** Remembered so the next launch paints the right colors before
 *  settings.json has loaded (no flash of the default theme). */
const THEME_CACHE_KEY = "sable.colorTheme";

/** Apply a theme's UI tokens to the document (CSS variables). */
export function applyUiTheme(id: string): void {
  const theme = themeById(id);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.ui)) {
    root.style.setProperty(name, value);
  }
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme.id);
  } catch {
    /* storage unavailable — only costs a flash on next launch */
  }
}

/** The theme used last session, for the very first paint. */
export function cachedThemeId(): ThemeId {
  try {
    return themeById(localStorage.getItem(THEME_CACHE_KEY) ?? "").id;
  } catch {
    return "sable-dark";
  }
}
