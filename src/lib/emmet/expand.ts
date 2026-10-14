import expandAbbreviation, { extract, resolveConfig, type UserConfig } from "emmet";
import { HTML_TAGS, type EmmetSyntax } from "./context";

/**
 * Emmet expansion as Monaco snippets: the official `emmet` library does
 * the expanding; its tab stops become snippet placeholders (`${1}`,
 * `${2:device-width}`) so Tab walks through them. Pure.
 */

/** Text in a snippet: `$`, `}` and `\` are syntax there. */
const escapeSnippetText = (text: string) => text.replace(/[\\$}]/g, "\\$&");

/** JSX: className/htmlFor, and `<img />`. */
const JSX_OPTIONS = {
  "jsx.enabled": true,
  "markup.attributes": { class: "className", "class*": "className", for: "htmlFor" },
  "output.selfClosingStyle": "xhtml" as const,
};

function configFor(syntax: EmmetSyntax, text?: string[]): UserConfig {
  return {
    type: syntax.type,
    syntax: syntax.syntax,
    text,
    options: {
      "output.field": (index: number, placeholder: string) =>
        placeholder ? `\${${index}:${escapeSnippetText(placeholder)}}` : `\${${index}}`,
      "output.text": escapeSnippetText,
      // Monaco re-indents the snippet to the line (and to spaces if the file uses them).
      "output.indent": "\t",
      // `foo` alone shouldn't become a fuzzy match like `font: optional`.
      "stylesheet.fuzzySearchMinScore": 0.4,
      ...(syntax.syntax === "jsx" ? JSX_OPTIONS : {}),
    } as UserConfig["options"],
  };
}

/** Properties Emmet knows (from its snippets), plus newer ones it lacks. */
const CSS_PROPERTIES: Set<string> = (() => {
  const properties = new Set(
    `gap row-gap column-gap inset aspect-ratio place-items place-content place-self scroll-behavior accent-color
    caret-color object-fit object-position isolation mix-blend-mode backdrop-filter filter transition animation
    transform translate rotate scale will-change user-select pointer-events container-type`.split(/\s+/),
  );
  const snippets = resolveConfig({ type: "stylesheet", syntax: "css" }).snippets;
  for (const value of Object.values(snippets)) {
    const property = /^[a-z-]+/.exec(value)?.[0];
    if (property) properties.add(property);
  }
  return properties;
})();

const MARKUP_SNIPPETS: Set<string> = new Set(Object.keys(resolveConfig({ type: "markup", syntax: "html" }).snippets));

/** Emmet operators: an abbreviation using any of these is clearly one. */
const MARKUP_OPERATORS = /[>+^*.#[\]{}()$@!]/;

/** Whether a markup abbreviation is worth offering (not just any word). */
export function isMarkupAbbreviation(abbreviation: string, syntax: EmmetSyntax): boolean {
  if (MARKUP_OPERATORS.test(abbreviation)) return /^[\w!.#[({@*>+^-]/.test(abbreviation) && !/^\d/.test(abbreviation);
  const name = abbreviation.split(":")[0];
  if (HTML_TAGS.has(name.toLowerCase()) || MARKUP_SNIPPETS.has(abbreviation) || MARKUP_SNIPPETS.has(name)) return true;
  // Custom elements (`my-card`), and components in JSX (`Button`).
  if (syntax.syntax !== "jsx" && /^[a-z][\w]*-[\w-]+$/.test(abbreviation)) return true;
  return syntax.syntax === "jsx" && /^[A-Z][\w.]*$/.test(abbreviation);
}

/**
 * The snippet for an abbreviation, or null if it isn't one (invalid, or a
 * plain word that isn't a tag, snippet or CSS property).
 */
export function expandToSnippet(abbreviation: string, syntax: EmmetSyntax, text?: string[]): string | null {
  if (!abbreviation.trim()) return null;
  if (syntax.type === "markup" && !text && !isMarkupAbbreviation(abbreviation, syntax)) return null;
  let expanded: string;
  try {
    expanded = expandAbbreviation(abbreviation, configFor(syntax, text));
  } catch {
    return null;
  }
  if (!expanded.trim()) return null;
  if (syntax.type === "stylesheet") {
    if (/^[@!]/.test(expanded)) return expanded;
    // Each declaration must name a real property (`xyz: ;` isn't one).
    const properties = [...expanded.matchAll(/(?:^|;\s*)([a-z-]+)\s*:/g)].map((match) => match[1]);
    if (properties.length === 0 || properties.some((property) => !CSS_PROPERTIES.has(property) && !property.startsWith("-"))) {
      return null;
    }
  }
  return expanded;
}

/** The snippet as plain text, for the suggestion's preview. */
export function snippetPreview(snippet: string): string {
  return snippet
    .replace(/\$\{\d+:((?:[^}\\]|\\.)*)\}/g, "$1")
    .replace(/\$\{\d+\}|\$\d+/g, "")
    .replace(/\\([\\$}])/g, "$1")
    .replace(/\t/g, "  ");
}

export interface FoundAbbreviation {
  abbreviation: string;
  /** 0-based offsets on the line: [start, end). */
  start: number;
  end: number;
}

/** The abbreviation ending at (or just around) `column` (0-based) on a line. */
export function abbreviationBefore(line: string, column: number, type: EmmetSyntax["type"]): FoundAbbreviation | null {
  // Nothing typed right before the cursor: not an abbreviation.
  if (column === 0 || /\s/.test(line[column - 1])) return null;
  const found = extract(line, column, { type, lookAhead: type === "markup" });
  if (!found || !found.abbreviation) return null;
  return { abbreviation: found.abbreviation, start: found.location, end: found.end };
}
