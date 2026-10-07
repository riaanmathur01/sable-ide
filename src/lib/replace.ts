/**
 * Find-and-replace text transforms (pure, unit-tested). The search itself
 * runs in Rust (ripgrep's engine); replacing happens here, on the file
 * text as the editor sees it, using an equivalent JavaScript regex.
 */

export interface SearchOptions {
  /** `null` = smart case: case-sensitive only if the query has uppercase. */
  caseSensitive: boolean | null;
  wholeWord: boolean;
  isRegex: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The JS regex equivalent to the Rust-side matcher. Throws on a bad pattern. */
export function buildSearchRegExp(query: string, options: SearchOptions): RegExp {
  const sensitive = options.caseSensitive ?? /[A-Z]/.test(query);
  let pattern = options.isRegex ? query : escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  // m: ^/$ match at line boundaries, as in ripgrep's line-oriented search.
  return new RegExp(pattern, `g${sensitive ? "" : "i"}m`);
}

/**
 * Replace every match in `text`. In regex mode the replacement may use
 * `$1`, `$&`, … ; otherwise it's inserted literally. With `onlyLine`
 * (1-based), only that line changes. Returns the new text and count.
 */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  options: SearchOptions,
  onlyLine?: number,
): { text: string; count: number } {
  const regex = buildSearchRegExp(query, options);
  let count = 0;
  const replaceAll = (input: string) =>
    input.replace(regex, (...args) => {
      // Empty matches are fine (e.g. "^" → "> " prefixes every line);
      // String.replace advances past them on its own.
      const match = args[0] as string;
      count++;
      if (!options.isRegex) return replacement;
      // Expand $1 / $& / $$ the way String.replace would.
      return match.replace(new RegExp(regex.source, regex.flags.replace("g", "")), replacement);
    });

  if (onlyLine === undefined) return { text: replaceAll(text), count };

  const lines = text.split("\n");
  const index = onlyLine - 1;
  if (index < 0 || index >= lines.length) return { text, count: 0 };
  // Keep a CRLF line's \r outside the replaced region.
  const hasCr = lines[index].endsWith("\r");
  const body = hasCr ? lines[index].slice(0, -1) : lines[index];
  lines[index] = replaceAll(body) + (hasCr ? "\r" : "");
  return { text: lines.join("\n"), count };
}
