import { NAMED, parseColor, type Rgba } from "./colors";

/**
 * Where a color goes in code: an existing color under the cursor, or an
 * empty place that's waiting for one (a CSS color property, an empty
 * string assigned to something named like a color, a lone "#").
 */

export interface ColorSlot {
  /** 1-based columns on the line; `end` is exclusive. */
  start: number;
  end: number;
  /** The color already there (null: an empty slot). */
  current: Rgba | null;
  /** How to write the chosen text into this spot (quotes in YAML…). */
  quote: boolean;
}

/** A color written on a line. */
export interface ColorMatch {
  start: number;
  end: number;
  text: string;
  color: Rgba;
}

/** Languages where colors are bare values (#abc, red, rgb()). */
const CSS_LIKE = new Set(["css", "scss", "less", "sass", "stylus", "html", "vue", "svelte", "xml", "svg", "postcss"]);
/** Where a bare # starts a comment: write colors quoted. */
const HASH_COMMENTS = new Set(["yaml", "toml", "ini", "shell", "python", "ruby", "r", "perl", "dockerfile", "makefile", "coffeescript"]);

const COLOR_WORDS = /(colou?r|background|\bbg\b|bg[A-Z_-]|\bfg\b|fg[A-Z_-]|foreground|fill|stroke|tint|accent|border|shadow|highlight|primary|secondary|theme|palette|swatch)/i;
const FUNCTIONS = /\b(rgba?|hsla?|hwb|oklch)\([^()]*\)/gi;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_])/g;

/** Every color written on a line. Short hex (#abc) only counts where it
 *  can't be something else: CSS-like files, or inside a string. */
export function colorsOnLine(line: string, language: string): ColorMatch[] {
  const matches: ColorMatch[] = [];
  const css = CSS_LIKE.has(language);
  for (const match of line.matchAll(HEX)) {
    const start = match.index!;
    const before = line[start - 1] ?? "";
    // Not part of a word, an HTML entity (&#123;) or an anchor (x#abc).
    if (/[\w&]/.test(before)) continue;
    const length = match[0].length - 1;
    if (length <= 4 && !css && !/["'`]/.test(before)) continue;
    const color = parseColor(match[0]);
    if (color) matches.push({ start: start + 1, end: start + 1 + match[0].length, text: match[0], color });
  }
  for (const match of line.matchAll(FUNCTIONS)) {
    const color = parseColor(match[0]);
    if (color) matches.push({ start: match.index! + 1, end: match.index! + 1 + match[0].length, text: match[0], color });
  }
  if (css) {
    // Named colors as property values (color: tomato).
    const value = /:\s*([^;{}]*)/.exec(line);
    if (value) {
      const offset = value.index + value[0].indexOf(value[1]);
      for (const word of value[1].matchAll(/[a-zA-Z]+/g)) {
        const name = word[0].toLowerCase();
        if (!NAMED[name]) continue;
        const start = offset + word.index! + 1;
        if (matches.some((existing) => start >= existing.start && start < existing.end)) continue;
        matches.push({ start, end: start + word[0].length, text: word[0], color: parseColor(name)! });
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** The color slot at 1-based `column` of `line`, if there is one. */
export function colorSlotAt(line: string, column: number, language: string): ColorSlot | null {
  const quote = HASH_COMMENTS.has(language);
  // On (or right after) a color that's there.
  const existing = colorsOnLine(line, language).find((match) => column >= match.start && column <= match.end);
  if (existing) return { start: existing.start, end: existing.end, current: existing.color, quote: false };

  const index = column - 1;
  const before = line.slice(0, index);
  const after = line.slice(index);

  // A lone "#" just typed.
  if (before.endsWith("#") && !/^[0-9a-fA-F]/.test(after) && !/[\w&]#$/.test(before)) {
    return { start: column - 1, end: column, current: null, quote: false };
  }

  // Inside an empty string: "|" or '|' after a color-named key or variable.
  const open = before.slice(-1);
  if (/["'`]/.test(open) && after.startsWith(open) && COLOR_WORDS.test(before.slice(0, -1))) {
    return { start: column, end: column, current: null, quote: false };
  }

  // A CSS color property (or YAML/TOML key) waiting for its value.
  const property = /^\s*([\w$@.-]+)\s*[:=]\s*$/.exec(before);
  if (property && COLOR_WORDS.test(property[1]) && /^\s*[;,]?\s*$/.test(after)) {
    if (CSS_LIKE.has(language) || /^(yaml|toml|ini|json|jsonc|properties)$/.test(language)) {
      return { start: column, end: column, current: null, quote: quote || /^(json|jsonc)$/.test(language) };
    }
  }
  return null;
}
