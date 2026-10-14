/**
 * Which parts of a file get spell-checked, decided from the TextMate
 * scopes of each token (the same grammars that color the editor). Pure.
 *
 * In code: comments, strings and identifiers — but not keywords, numbers,
 * punctuation, regular expressions, HTML tag and attribute names,
 * library builtins or import paths. In prose (Markdown, plain text):
 * everything except code spans, code blocks and link targets.
 */

/** Languages that are prose: every word is checked. */
export const PROSE_LANGUAGES = new Set(["markdown", "plaintext", "restructuredtext", "asciidoc", "latex", "tex"]);

/** Scope prefixes whose text is never checked in code. */
const CODE_SKIP = [
  "keyword",
  "storage",
  "constant.numeric",
  "constant.language",
  "constant.character",
  "constant.other.color",
  "constant.other.rgb-value",
  "constant.other.unicode-range",
  "punctuation",
  "entity.name.tag",
  "entity.other.attribute-name",
  "string.regexp",
  "variable.language",
  "meta.preprocessor.include",
  "string.quoted.other.lt-gt.include",
  "markup.underline.link",
];

/** Library names and builtins (`console`, `Math.floor`) aren't yours to spell. */
const SUPPORT_KEPT = ["support.class.component", "support.type.property-name"];

/** Scope prefixes skipped in prose. */
const PROSE_SKIP = [
  "markup.inline.raw",
  "markup.fenced_code",
  "markup.raw",
  "markup.underline.link",
  "meta.link.reference.def",
  "meta.embedded",
  "comment",
  "meta.frontmatter",
];

const startsWithAny = (scope: string, prefixes: string[]) => prefixes.some((prefix) => scope.startsWith(prefix));

/** Whether a token (by its scope stack, outermost first) is spell-checked. */
export function isCheckedToken(scopes: string[], prose: boolean): boolean {
  if (prose) return !scopes.some((scope) => startsWithAny(scope, PROSE_SKIP));
  let inString = false;
  let inImport = false;
  for (const scope of scopes) {
    if (startsWithAny(scope, CODE_SKIP)) return false;
    if (scope.startsWith("support.") && !startsWithAny(scope, SUPPORT_KEPT)) return false;
    if (scope.startsWith("string")) inString = true;
    if (scope.startsWith("meta.import") || scope.startsWith("meta.export") || scope.startsWith("meta.module-reference")) inImport = true;
  }
  // Module specifiers ("lodash-es", "./fooUtils").
  if (inString && inImport) return false;
  return true;
}

export interface FileDirectives {
  /** Words the file itself says are fine (`cspell:ignore`, `cspell:words`). */
  words: Set<string>;
  /** 0-based lines not to check (`cspell:disable` … `cspell:enable`, `cspell:disable-next-line`). */
  disabledLines: Set<number>;
}

const DIRECTIVE = /\b(?:cspell|spell-?checker)\s*:\s*(ignore|words|disable-next-line|disable-line|disable|enable)\b([^\n]*)/gi;

/** cspell's in-file directives, so files configured for cspell behave the same here. */
export function fileDirectives(lines: string[]): FileDirectives {
  const words = new Set<string>();
  const disabledLines = new Set<number>();
  let disabledFrom: number | null = null;
  lines.forEach((line, index) => {
    if (!/spell/i.test(line)) {
      if (disabledFrom !== null) disabledLines.add(index);
      return;
    }
    let disabledHere = disabledFrom !== null;
    for (const match of line.matchAll(DIRECTIVE)) {
      const kind = match[1].toLowerCase();
      if (kind === "ignore" || kind === "words") {
        for (const word of match[2].replace(/\*\/.*$|-->.*$/, "").split(/[\s,]+/)) {
          if (word) words.add(word.toLowerCase());
        }
      } else if (kind === "disable-next-line") disabledLines.add(index + 1);
      else if (kind === "disable-line") disabledHere = true;
      else if (kind === "disable") {
        disabledFrom = index;
        disabledHere = true;
      } else if (kind === "enable") {
        disabledFrom = null;
      }
    }
    if (disabledHere) disabledLines.add(index);
  });
  return { words, disabledLines };
}
