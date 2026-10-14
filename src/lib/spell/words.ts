/**
 * Finding the words to spell-check in a piece of text — a comment, a
 * string, an identifier or a line of prose. Pure (no Monaco, no DOM) so it
 * runs in tests and in the worker alike.
 *
 * Identifiers are split the way people write them: `getUserProfileId`
 * checks get / User / Profile / Id, `MAX_RETRY_COUNT` and `max-retry-count`
 * check max / retry / count, `XMLHttpRequest` checks XML / Http / Request.
 * Things that aren't words — URLs, emails, hex numbers and colors, UUIDs,
 * hashes, escape sequences — are blanked out first.
 */

export interface FoundWord {
  /** The word as written (one camelCase part of an identifier). */
  word: string;
  /** Offset of its first character in the text given. */
  offset: number;
}

/** Shorter words aren't checked: abbreviations (`ctx`, `idx`) are too common in code. */
export const MIN_WORD_LENGTH = 4;
/** All-caps words shorter than this are taken as acronyms (`HTTP`, `JSON`). */
const MIN_ACRONYM_LENGTH = 5;
const MAX_WORD_LENGTH = 40;

/** Patterns blanked out before looking for words. */
const NOT_WORDS: RegExp[] = [
  // URLs (with or without a scheme) and file URIs.
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s"'`<>()[\]{}]+/gi,
  // Email addresses.
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  // UUIDs.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Hex numbers and CSS colors.
  /\b0x[0-9a-f_]+\b/gi,
  /#[0-9a-f]{3,8}\b/gi,
  // Hashes and other long hex runs (with at least one digit: "deadbeef"
  // alone is a word-like string and gets checked).
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi,
  // Base64-ish blobs: long runs without spaces mixing case and digits.
  /\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{24,}={0,2}/g,
  // Escape sequences in strings (`\n`, `\t`, `é`, `\x1b`).
  /\\(?:u\{?[0-9a-f]{1,6}\}?|x[0-9a-f]{2}|[a-z])/gi,
  // Format placeholders (`%s`, `%d`, `{0}`).
  /%[a-z]/gi,
];

/** Blank out what isn't words (keeping every offset where it was). */
export function maskNonWords(text: string): string {
  let masked = text;
  for (const pattern of NOT_WORDS) {
    masked = masked.replace(pattern, (match) => " ".repeat(match.length));
  }
  return masked;
}

/**
 * Split one identifier-ish run of letters into its parts:
 * `getUserProfileId` → get User Profile Id, `HTTPServer` → HTTP Server.
 */
export function splitIdentifier(run: string): { part: string; index: number }[] {
  const parts: { part: string; index: number }[] = [];
  const pattern = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+(?:['’][a-z]+)*|[A-Z]+/g;
  for (const match of run.matchAll(pattern)) {
    parts.push({ part: match[0], index: match.index ?? 0 });
  }
  return parts;
}

/** Whether a word should be looked up at all. */
export function isCheckable(word: string): boolean {
  const letters = word.replace(/['’].*$/, "");
  if (letters.length < MIN_WORD_LENGTH || letters.length > MAX_WORD_LENGTH) return false;
  if (letters === letters.toUpperCase() && letters.length < MIN_ACRONYM_LENGTH) return false;
  return true;
}

/**
 * Every word to check in `text`, with its offset. Runs of letters are
 * split at digits, underscores, hyphens and case changes.
 */
export function extractWords(text: string): FoundWord[] {
  const masked = maskNonWords(text);
  const found: FoundWord[] = [];
  // Letters (and apostrophes inside words, for "don't" / "user's").
  for (const match of masked.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)) {
    const run = match[0];
    const start = match.index ?? 0;
    for (const { part, index } of splitIdentifier(run)) {
      if (isCheckable(part)) found.push({ word: part, offset: start + index });
    }
  }
  return found;
}

/** The form a word is looked up by: lower case, curly apostrophes straightened. */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/’/g, "'");
}

/**
 * Match a suggestion's case to the word it replaces: `Recieve` →
 * `Receive`, `RECIEVE` → `RECEIVE`, `recieve` → `receive`. A suggestion
 * with its own capitals (a name: "JavaScript") keeps them.
 */
export function matchCase(original: string, suggestion: string): string {
  if (suggestion !== suggestion.toLowerCase()) return suggestion;
  if (original.length > 1 && original === original.toUpperCase()) return suggestion.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return suggestion[0].toUpperCase() + suggestion.slice(1);
  return suggestion;
}
