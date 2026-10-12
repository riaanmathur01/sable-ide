/**
 * A VS Code color theme (the JSON a theme extension contributes: `colors`,
 * `tokenColors`, `semanticTokenColors`) as a Sable theme. Plugins add
 * themes this way (lib/pluginThemes.ts).
 *
 *   - Syntax: the theme's `tokenColors` drive TextMate highlighting as in
 *     VS Code. Monaco's Monarch rules (languages without a grammar) and
 *     Sable's semantic categories are worked out from them.
 *   - Editor: the theme's `colors` go to Monaco, which shares VS Code's
 *     color ids.
 *   - UI: Sable's dozen design tokens are picked from the workbench colors
 *     (sideBar.background, focusBorder, …), falling back to VS Code's
 *     defaults for whatever the theme leaves out.
 *
 * Pure (no DOM, no Monaco), so it runs in tests.
 */

import type { EditorThemeData, SemanticStyles, TerminalPalette, ThemeDefinition, TokenColorRule } from "./themes";

/** A theme file, its `include`s already merged in. */
export interface VscodeThemeJson {
  type?: string;
  colors?: Record<string, unknown>;
  tokenColors?: unknown;
  semanticTokenColors?: Record<string, unknown>;
}

// --- Colors ---------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parse(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const channel = (index: number) => parseInt(full.slice(index * 2, index * 2 + 2), 16);
  return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) / 255 : 1 };
}

const hex2 = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
const toHex = ({ r, g, b }: Rgba) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** `color` painted over `background`: an opaque #rrggbb. */
function over(color: Rgba, background: Rgba): string {
  const a = color.a;
  return toHex({ r: color.r * a + background.r * (1 - a), g: color.g * a + background.g * (1 - a), b: color.b * a + background.b * (1 - a), a: 1 });
}

/** `a` moved towards `b` by `amount` (0–1). */
function mix(a: string, b: string, amount: number): string {
  const [x, y] = [parse(a)!, parse(b)!];
  return toHex({ r: x.r + (y.r - x.r) * amount, g: x.g + (y.g - x.g) * amount, b: x.b + (y.b - x.b) * amount, a: 1 });
}

function luminance(color: string): number {
  const { r, g, b } = parse(color)!;
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `color`, moved towards white or black (whichever `background` is
 *  not) just far enough to reach `minimum` contrast with it. */
function readable(color: string, background: string, minimum: number): string {
  if (contrast(color, background) >= minimum) return color;
  const target = luminance(background) > 0.4 ? "#000000" : "#ffffff";
  for (let step = 1; step <= 20; step++) {
    const moved = mix(color, target, step / 20);
    if (contrast(moved, background) >= minimum) return moved;
  }
  return target;
}

// --- VS Code's defaults ---------------------------------------------------------------

const DEFAULTS = {
  dark: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "sideBar.background": "#252526",
    "editorWidget.background": "#252526",
    border: "#3c3c3c",
    "focusBorder": "#007fd4",
    "button.background": "#0e639c",
    "errorForeground": "#f48771",
    terminal: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"],
  },
  light: {
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
    "sideBar.background": "#f3f3f3",
    "editorWidget.background": "#f3f3f3",
    border: "#e5e5e5",
    "focusBorder": "#0090f1",
    "button.background": "#007acc",
    "errorForeground": "#a1260d",
    terminal: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"],
  },
};

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

// --- Token colors ------------------------------------------------------------------

interface RawRule {
  scope?: unknown;
  settings?: { foreground?: unknown; fontStyle?: unknown };
}

interface Style {
  foreground?: string;
  fontStyle?: string;
}

/** The theme's scoped rules, cleaned: a valid color and/or font style. */
function cleanRules(tokenColors: unknown): TokenColorRule[] {
  if (!Array.isArray(tokenColors)) return [];
  const rules: TokenColorRule[] = [];
  for (const raw of tokenColors as RawRule[]) {
    if (!raw || typeof raw !== "object" || !raw.settings) continue;
    const scope = typeof raw.scope === "string" ? raw.scope : Array.isArray(raw.scope) ? raw.scope.filter((item): item is string => typeof item === "string") : null;
    if (!scope || scope.length === 0) continue;
    const foreground = parse(raw.settings.foreground) ? String(raw.settings.foreground) : undefined;
    const fontStyle = typeof raw.settings.fontStyle === "string" ? raw.settings.fontStyle : undefined;
    if (foreground === undefined && fontStyle === undefined) continue;
    rules.push({ scope, settings: { ...(foreground ? { foreground } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) } });
  }
  return rules;
}

/** The global rule's colors (a rule without a scope). */
function globalSettings(tokenColors: unknown): { foreground?: string; background?: string } {
  if (!Array.isArray(tokenColors)) return {};
  for (const raw of tokenColors as { scope?: unknown; settings?: Record<string, unknown> }[]) {
    if (raw && !raw.scope && raw.settings) {
      return {
        foreground: parse(raw.settings.foreground) ? String(raw.settings.foreground) : undefined,
        background: parse(raw.settings.background) ? String(raw.settings.background) : undefined,
      };
    }
  }
  return {};
}

/**
 * The style a TextMate scope gets, roughly as vscode-textmate decides: the
 * longest matching selector wins, later rules win ties. Selectors with a
 * parent ("meta.call entity.name.function") only count when nothing
 * simpler matches.
 */
function styleFor(rules: TokenColorRule[], scope: string): Style {
  let best: { score: number; style: Style } | null = null;
  let contextual: { score: number; style: Style } | null = null;
  const foreground: { score: number; value?: string } = { score: -1 };
  const fontStyle: { score: number; value?: string } = { score: -1 };
  for (const rule of rules) {
    const selectors = (Array.isArray(rule.scope) ? rule.scope : rule.scope.split(",")).map((selector) => selector.trim()).filter(Boolean);
    for (const selector of selectors) {
      const parts = selector.split(/\s+/);
      const last = parts[parts.length - 1];
      if (last !== scope && !scope.startsWith(`${last}.`)) continue;
      const score = last.split(".").length;
      if (parts.length > 1) {
        if (!contextual || score >= contextual.score) contextual = { score, style: rule.settings };
        continue;
      }
      if (!best || score >= best.score) best = { score, style: rule.settings };
      // Foreground and font style resolve separately (a bold-only rule
      // doesn't erase a broader rule's color).
      if (rule.settings.foreground && score >= foreground.score) Object.assign(foreground, { score, value: rule.settings.foreground });
      if (rule.settings.fontStyle !== undefined && score >= fontStyle.score) Object.assign(fontStyle, { score, value: rule.settings.fontStyle });
    }
  }
  if (!best) return contextual?.style ?? {};
  return { foreground: foreground.value ?? contextual?.style.foreground, fontStyle: fontStyle.value };
}

/** The first of `scopes` the theme colors. */
function firstStyle(rules: TokenColorRule[], scopes: string[]): Style {
  for (const scope of scopes) {
    const style = styleFor(rules, scope);
    if (style.foreground) return style;
  }
  return {};
}

/** A semanticTokenColors entry: "#hex" or { foreground, fontStyle, bold, italic }. */
function semanticEntry(value: unknown): Style | null {
  if (typeof value === "string") return parse(value) ? { foreground: value } : null;
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const styles = typeof entry.fontStyle === "string" ? [entry.fontStyle] : [];
  if (entry.italic === true) styles.push("italic");
  if (entry.bold === true) styles.push("bold");
  const foreground = parse(entry.foreground) ? String(entry.foreground) : undefined;
  if (!foreground && styles.length === 0) return null;
  return { foreground, fontStyle: styles.join(" ") || undefined };
}

// --- The conversion --------------------------------------------------------------------

export interface ThemeSource {
  id: string;
  label: string;
  /** The contribution's uiTheme: "vs-dark", "vs", "hc-black", "hc-light". */
  uiTheme?: string;
  json: VscodeThemeJson;
}

export function themeFromVscode({ id, label, uiTheme, json }: ThemeSource): ThemeDefinition {
  const colors = json.colors && typeof json.colors === "object" ? json.colors : {};
  const color = (key: string) => parse(colors[key]);
  // Light or dark: the editor's background says (some themes declare the
  // wrong uiTheme); the declaration decides when there's no background.
  const declaredLight = uiTheme === "vs" || uiTheme === "hc-light" || (!uiTheme && json.type === "light");
  const background = color("editor.background");
  const light = background && background.a > 0.5 ? luminance(toHex(background)) > 0.4 : declaredLight;
  const defaults = light ? DEFAULTS.light : DEFAULTS.dark;
  const rules = cleanRules(json.tokenColors);
  const global = globalSettings(json.tokenColors);

  // Opaque colors: the first defined key, painted over `background`.
  const pick = (keys: string[], background: string): string | undefined => {
    for (const key of keys) {
      const value = color(key);
      if (value && value.a > 0) return over(value, parse(background)!);
    }
    return undefined;
  };

  const base = pick(["editor.background"], defaults["editor.background"]) ?? (global.background ? over(parse(global.background)!, parse(defaults["editor.background"])!) : defaults["editor.background"]);
  const panel = pick(["sideBar.background", "activityBar.background", "panel.background", "editorGroupHeader.tabsBackground"], base) ?? mix(base, light ? "#000000" : "#ffffff", 0.04);
  const editorForeground = pick(["editor.foreground"], base) ?? (global.foreground ? over(parse(global.foreground)!, parse(base)!) : defaults["editor.foreground"]);
  // Sable's text is on panels, popups and pages alike: the most readable
  // of the theme's foregrounds, nudged to at least 4.5:1 if need be.
  const textCandidates = ["foreground", "sideBar.foreground", "editor.foreground"]
    .map((key) => pick([key], panel))
    .filter((value): value is string => Boolean(value));
  let text = textCandidates.find((candidate) => contrast(candidate, panel) >= 4.5) ??
    textCandidates.concat(editorForeground).reduce((best, candidate) => (contrast(candidate, panel) > contrast(best, panel) ? candidate : best));
  text = readable(text, panel, 4.5);
  let elevated = pick(["editorWidget.background", "quickInput.background", "editorSuggestWidget.background", "dropdown.background", "input.background"], panel) ?? defaults["editorWidget.background"];
  // Popups must read with the same text: a dark popup in a light theme
  // (or the reverse) gives way to a tint of the panel.
  if (elevated === panel || contrast(text, elevated) < 4) elevated = mix(panel, light ? "#000000" : "#ffffff", 0.06);
  let muted = pick(["descriptionForeground", "tab.inactiveForeground", "sideBarSectionHeader.foreground", "editorLineNumber.activeForeground"], panel) ?? mix(text, panel, 0.4);
  if (muted === text) muted = mix(text, panel, 0.35);
  muted = readable(muted, panel, 2.8);
  // The quiet borders VS Code draws around the sidebar and tabs; a split
  // editor's or the panel's (often loud) border only if there's no other.
  const border =
    pick(["sideBar.border", "tab.border", "sideBarSectionHeader.border", "editorGroupHeader.tabsBorder", "input.border", "dropdown.border", "widget.border", "editorWidget.border", "contrastBorder", "panel.border", "editorGroup.border"], panel) ??
    mix(panel, text, 0.12);

  const terminalColors = ANSI.map((name, index) => pick([`terminal.ansi${name}`], base) ?? defaults.terminal[index]).concat(
    ANSI.map((name, index) => pick([`terminal.ansiBright${name}`], base) ?? defaults.terminal[index + 8]),
  );
  // The accent: a vivid color the theme uses for emphasis (the first that
  // stands out from the background; else whichever stands out most).
  const accentCandidates = ["activityBarBadge.background", "button.background", "focusBorder", "textLink.foreground", "tab.activeBorderTop", "tab.activeBorder", "progressBar.background", "editorCursor.foreground"]
    .map((key) => color(key))
    .filter((value): value is Rgba => Boolean(value && value.a >= 0.5))
    .map((value) => over(value, parse(base)!))
    .concat([terminalColors[4], terminalColors[12], terminalColors[5], terminalColors[6]]);
  const accent =
    accentCandidates.find((candidate) => contrast(candidate, base) >= 2 && contrast(candidate, panel) >= 1.6) ??
    accentCandidates.reduce((best, candidate) => (contrast(candidate, base) > contrast(best, base) ? candidate : best));
  const onAccentChoices = [base, "#ffffff", "#000000"];
  const onAccent = contrast(base, accent) >= 4.5 ? base : onAccentChoices.reduce((best, candidate) => (contrast(candidate, accent) > contrast(best, accent) ? candidate : best));
  const danger = pick(["errorForeground", "editorError.foreground", "terminal.ansiRed"], panel) ?? defaults.errorForeground;
  const gitModified = pick(["gitDecoration.modifiedResourceForeground", "editorGutter.modifiedBackground"], panel) ?? terminalColors[3];
  const gitAdded = pick(["gitDecoration.untrackedResourceForeground", "gitDecoration.addedResourceForeground", "editorGutter.addedBackground"], panel) ?? terminalColors[2];
  const gitDeleted = pick(["gitDecoration.deletedResourceForeground", "editorGutter.deletedBackground"], panel) ?? terminalColors[1];

  // Monaco takes VS Code's color ids as they are.
  const editorColors: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    if (parse(value)) editorColors[key] = String(value);
  }
  editorColors["editor.background"] = base;
  editorColors["editor.foreground"] = editorForeground;
  editorColors["editorGutter.background"] ??= base;
  editorColors["editorStickyScroll.background"] ??= base;
  editorColors["editorWidget.background"] ??= elevated;
  editorColors["editorSuggestWidget.background"] ??= elevated;
  editorColors["editorHoverWidget.background"] ??= elevated;

  const hex = (value: string | undefined) => value?.replace("#", "").slice(0, 6);
  const monarch = (token: string, scopes: string[]) => {
    const style = firstStyle(rules, scopes);
    return style.foreground ? [{ token, foreground: hex(style.foreground), ...(style.fontStyle ? { fontStyle: style.fontStyle } : {}) }] : [];
  };
  const editor: EditorThemeData = {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: hex(editorForeground) },
      ...monarch("comment", ["comment"]),
      ...monarch("keyword", ["keyword.control", "keyword", "storage.type"]),
      ...monarch("string", ["string"]),
      ...monarch("string.escape", ["constant.character.escape"]),
      ...monarch("number", ["constant.numeric"]),
      ...monarch("regexp", ["string.regexp"]),
      ...monarch("type", ["entity.name.type", "support.type"]),
      ...monarch("class", ["entity.name.type.class", "entity.name.class"]),
      ...monarch("function", ["entity.name.function", "support.function"]),
      ...monarch("variable", ["variable"]),
      ...monarch("constant", ["constant.language", "constant"]),
      ...monarch("tag", ["entity.name.tag"]),
      ...monarch("attribute.name", ["entity.other.attribute-name"]),
      ...monarch("attribute.value", ["string"]),
      ...monarch("string.key.json", ["support.type.property-name.json", "support.type.property-name"]),
      ...monarch("delimiter", ["punctuation"]),
      ...monarch("operator", ["keyword.operator"]),
      ...monarch("annotation", ["meta.decorator", "entity.name.function.decorator"]),
    ],
    colors: editorColors,
  };

  // Sable's semantic categories: the theme's semanticTokenColors, else the
  // colors its TextMate rules give the same things.
  const semanticColors = json.semanticTokenColors && typeof json.semanticTokenColors === "object" ? json.semanticTokenColors : {};
  const semantic = (keys: string[], scopes: string[]): { foreground: string; fontStyle?: string } => {
    for (const key of keys) {
      const entry = semanticEntry(semanticColors[key]);
      if (entry?.foreground) return { foreground: entry.foreground, ...(entry.fontStyle ? { fontStyle: entry.fontStyle } : {}) };
    }
    const style = firstStyle(rules, scopes);
    return { foreground: style.foreground ?? editorForeground, ...(style.fontStyle ? { fontStyle: style.fontStyle } : {}) };
  };
  const semanticStyles: SemanticStyles = {
    "sem-parameter": semantic(["parameter"], ["variable.parameter"]),
    "sem-self": semantic(["selfParameter", "variable.defaultLibrary"], ["variable.language.self", "variable.language.this", "variable.language"]),
    "sem-class-decl": semantic(["class.declaration", "class"], ["entity.name.type.class", "entity.name.class", "entity.name.type"]),
    "sem-class": semantic(["class"], ["entity.name.type.class", "entity.name.class", "support.class", "entity.name.type"]),
    "sem-type-param": semantic(["typeParameter"], ["entity.name.type.parameter", "entity.name.type"]),
    "sem-function-decl": semantic(["function.declaration", "function"], ["entity.name.function"]),
    "sem-function-call": semantic(["function"], ["entity.name.function", "support.function"]),
    "sem-dunder-decl": semantic(["method.declaration", "function.declaration"], ["support.function.magic", "entity.name.function"]),
    "sem-builtin": semantic(["function.defaultLibrary", "*.defaultLibrary"], ["support.function.builtin", "support.function"]),
    "sem-decorator": semantic(["decorator"], ["entity.name.function.decorator", "meta.decorator"]),
    "sem-property": semantic(["property"], ["variable.other.property", "variable.other.object.property", "support.variable.property"]),
    "sem-property-static": semantic(["property.static", "property.readonly"], ["variable.other.constant.property", "variable.other.constant"]),
    "sem-enum-member": semantic(["enumMember"], ["variable.other.enummember", "constant.other.enum", "constant.other"]),
  };

  const terminal: TerminalPalette = {
    foreground: pick(["terminal.foreground"], base) ?? editorForeground,
    cursor: pick(["terminalCursor.foreground", "editorCursor.foreground"], base) ?? accent,
    selectionBackground: typeof colors["terminal.selectionBackground"] === "string" && parse(colors["terminal.selectionBackground"])
      ? String(colors["terminal.selectionBackground"])
      : typeof colors["editor.selectionBackground"] === "string" && parse(colors["editor.selectionBackground"])
        ? String(colors["editor.selectionBackground"])
        : `${accent}44`,
    black: terminalColors[0],
    red: terminalColors[1],
    green: terminalColors[2],
    yellow: terminalColors[3],
    blue: terminalColors[4],
    magenta: terminalColors[5],
    cyan: terminalColors[6],
    white: terminalColors[7],
    brightBlack: terminalColors[8],
    brightRed: terminalColors[9],
    brightGreen: terminalColors[10],
    brightYellow: terminalColors[11],
    brightBlue: terminalColors[12],
    brightMagenta: terminalColors[13],
    brightCyan: terminalColors[14],
    brightWhite: terminalColors[15],
  };

  return {
    id,
    label,
    type: light ? "light" : "dark",
    foreground: editorForeground,
    tokenColors: rules,
    editor,
    semantic: semanticStyles,
    terminal,
    ui: {
      "--bg-base": base,
      "--bg-panel": panel,
      "--bg-elevated": elevated,
      "--border": border,
      "--text": text,
      "--text-muted": muted,
      "--accent": accent,
      "--on-accent": onAccent,
      "--danger": danger,
      "--git-modified": gitModified,
      "--git-added": gitAdded,
      "--git-deleted": gitDeleted,
    },
  };
}

/** The color a converted theme gives each of `scopes` (the first it
 *  colors), as TextMate highlighting would (for previews). */
export function scopeColor(theme: ThemeDefinition, scopes: string[]): string {
  return (firstStyle(theme.tokenColors, scopes).foreground ?? theme.foreground).slice(0, 7);
}
