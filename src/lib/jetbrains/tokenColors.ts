import type { TokenColorRule } from "../themes";
import type { JbScheme, JbStyle } from "./schemes.generated";
import { LANGUAGE_COLORS, TEXTMATE_DEFAULTS, type LanguageColors } from "./scopes";

/**
 * TextMate rules reproducing a JetBrains scheme (see scopes.ts for the
 * three layers). Every rule sets both a color and a font style, so a
 * scope never inherits italics or a color from an enclosing scope that
 * JetBrains wouldn't apply.
 */

export function fontStyleOf(style: JbStyle): string {
  return [
    style.italic && "italic",
    style.bold && "bold",
    style.underline && "underline",
    style.strikethrough && "strikethrough",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Default text color (a key without `fg` renders in it). */
export function textColor(scheme: JbScheme): string {
  return scheme.TEXT?.fg ?? "#bcbec4";
}

/** A key's style. A key the scheme gives no attributes renders as plain
 *  text, as in IntelliJ. */
export function styleOf(scheme: JbScheme, key: string): { foreground: string; fontStyle: string } {
  const style = scheme[key] ?? {};
  return { foreground: style.fg ?? textColor(scheme), fontStyle: fontStyleOf(style) };
}

const DEFAULT_RULES = TEXTMATE_DEFAULTS.filter(([, key]) => key.startsWith("DEFAULT_"));

/**
 * In a native JetBrains language, quotes and comment markers belong to the
 * string/comment token. TextMate scopes them as punctuation, which
 * IntelliJ's generic table leaves uncolored.
 */
const NATIVE_TOKEN_RULES: [string, string][] = [
  ["string punctuation.definition.string", "DEFAULT_STRING"],
  ["comment punctuation.definition.comment", "DEFAULT_LINE_COMMENT"],
  ["comment.line punctuation.definition.comment", "DEFAULT_LINE_COMMENT"],
  ["comment.block punctuation.definition.comment", "DEFAULT_BLOCK_COMMENT"],
  ["comment.block.documentation punctuation.definition.comment", "DEFAULT_DOC_COMMENT"],
  // Separators and brackets have their own keys (Darcula colors commas
  // and semicolons); grammars name them in many ways.
  ...[
    "punctuation.separator.comma",
    "punctuation.separator.parameters",
    "punctuation.separator.parameter",
    "punctuation.separator.arguments",
    "punctuation.separator.element",
    "punctuation.separator.delimiter",
    "punctuation.separator.list.comma",
    "punctuation.separator.array",
    "punctuation.separator.dictionary.pair",
    "punctuation.separator.object",
    "punctuation.comma",
  ].map((selector): [string, string] => [selector, "DEFAULT_COMMA"]),
  ...["punctuation.terminator", "punctuation.semi"].map((selector): [string, string] => [selector, "DEFAULT_SEMICOLON"]),
  ...[
    "punctuation.parenthesis",
    "punctuation.definition.parameters",
    "punctuation.definition.arguments",
    "punctuation.section.parens",
    "punctuation.brackets.round",
    "meta.brace.round",
  ].map((selector): [string, string] => [selector, "DEFAULT_PARENTHS"]),
  ...[
    "punctuation.definition.list",
    "punctuation.section.brackets",
    "punctuation.brackets.square",
    "punctuation.squarebracket",
    "meta.brace.square",
  ].map((selector): [string, string] => [selector, "DEFAULT_BRACKETS"]),
  ...[
    "punctuation.section.block",
    "punctuation.definition.block",
    "punctuation.brackets.curly",
    "punctuation.curlybrace",
    "meta.brace.curly",
  ].map((selector): [string, string] => [selector, "DEFAULT_BRACES"]),
];
const NAMED_RULES = TEXTMATE_DEFAULTS.filter(([, key]) => !key.startsWith("DEFAULT_"));

/** The language's own key for a DEFAULT_* key. */
function languageKey(language: LanguageColors, key: string): string {
  return key.startsWith("DEFAULT_") ? (language.defaults[key.slice("DEFAULT_".length)] ?? key) : key;
}

/** Scope segments of a selector's last scope (`a b.c` → ["b", "c"]). */
function leafSegments(selector: string): string[] {
  const scopes = selector.split(" ");
  return scopes[scopes.length - 1].split(".");
}

/**
 * The DEFAULT_* rule IntelliJ would apply to `selector` if the named rule
 * for it didn't exist: the longest DEFAULT selector that prefixes it.
 */
function underlyingDefault(selector: string): string | undefined {
  const leaf = leafSegments(selector);
  let best: { length: number; key: string } | undefined;
  for (const [candidate, key] of DEFAULT_RULES) {
    if (candidate.includes(" ")) continue;
    const segments = candidate.split(".");
    const matches = segments.every((segment, index) => leaf[index] === segment);
    if (matches && (!best || segments.length > best.length)) best = { length: segments.length, key };
  }
  return best?.key;
}

export function jetbrainsTokenColors(scheme: JbScheme): TokenColorRule[] {
  const rules: TokenColorRule[] = [];
  const add = (scope: string, key: string) => rules.push({ scope, settings: styleOf(scheme, key) });

  // Layer 1: IntelliJ's TextMate table, as-is.
  for (const [selector, key] of TEXTMATE_DEFAULTS) add(selector, key);

  for (const language of Object.values(LANGUAGE_COLORS)) {
    const ownKeys = new Set([...Object.values(language.defaults), ...language.rules.map(([, key]) => key)]);
    // Layer 2: the defaults again, in the language's own keys…
    for (const [selector, key] of [...DEFAULT_RULES, ...NATIVE_TOKEN_RULES]) {
      add(`${language.root} ${selector}`, languageKey(language, key));
    }
    // …and IntelliJ's rules for *other* languages neutralized here
    // (they target TextMate-only files; e.g. its JS regexp color must
    // not reach Python regex strings).
    for (const [selector, key] of NAMED_RULES) {
      if (ownKeys.has(key)) continue;
      const fallback = underlyingDefault(selector);
      if (fallback) add(`${language.root} ${selector}`, languageKey(language, fallback));
    }
  }

  // Layer 3: each language's own constructs.
  for (const language of Object.values(LANGUAGE_COLORS)) {
    for (const [selector, key] of language.rules) add(selector, key);
  }
  return rules;
}
