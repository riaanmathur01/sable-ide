/**
 * In-file rename for languages without a language server: the
 * identifier's occurrences in code, never inside strings or comments
 * (judged by the TextMate grammar's scopes). Pure, so it can be unit-tested.
 */

import type { LineScopes } from "../shikiMonaco";

/** 0-based line + [start, end) columns of one occurrence. */
export interface Occurrence {
  line: number;
  start: number;
  end: number;
}

/** Whether a token is code (not inside a string or comment). Embedded code
 *  (string interpolation, `${…}`) and variables interpolated into strings
 *  (Kotlin/PHP/shell `$name`) count as code. */
export function isCodeScope(scopes: string[]): boolean {
  for (let index = scopes.length - 1; index > 0; index--) {
    const scope = scopes[index];
    if (scope.startsWith("variable")) return true;
    if (scope.startsWith("comment") || scope.startsWith("string")) return false;
    if (
      scope.startsWith("meta.embedded") ||
      scope.startsWith("meta.interpolation") ||
      scope.startsWith("meta.template.expression") ||
      scope.startsWith("source.")
    ) {
      return true;
    }
  }
  return true;
}

/** Keywords and literals aren't renameable. */
export function isKeywordScope(scopes: string[]): boolean {
  const leaf = scopes[scopes.length - 1] ?? "";
  return /^(keyword|storage\.(type|modifier)|constant\.(language|numeric)|support\.type\.primitive)/.test(leaf);
}

// `$` isn't an identifier character here: where it's part of a name
// (PHP `$total`) the word under the cursor already includes it, and
// elsewhere it marks interpolation (Kotlin/shell `"$count"`).
const IDENTIFIER_CHAR = /[\p{L}\p{N}_]/u;

/** Scopes of the token covering `column` (0-based) on a line. */
export function scopesAt(lineScopes: LineScopes | undefined, column: number): string[] | null {
  const token = lineScopes?.find((candidate) => candidate.start <= column && column < candidate.end);
  return token?.scopes ?? null;
}

/**
 * Every whole-identifier occurrence of `word` that is code. Without
 * scopes (grammar not loaded) every whole-identifier match counts.
 */
export function identifierOccurrences(lines: string[], scopes: LineScopes[] | null, word: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  lines.forEach((text, line) => {
    let from = 0;
    for (;;) {
      const start = text.indexOf(word, from);
      if (start === -1) break;
      from = start + word.length;
      const before = text[start - 1];
      const after = text[start + word.length];
      // Whole identifiers only.
      if ((before && IDENTIFIER_CHAR.test(before)) || (after && IDENTIFIER_CHAR.test(after))) {
        continue;
      }
      const tokenScopes = scopes ? scopesAt(scopes[line], start) : null;
      if (tokenScopes && !isCodeScope(tokenScopes)) continue;
      occurrences.push({ line, start, end: start + word.length });
    }
  });
  return occurrences;
}
