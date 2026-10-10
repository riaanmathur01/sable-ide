/**
 * Inline debug values (as JetBrains shows them): while paused, each local
 * variable's value at the end of the last line — at or above the paused
 * one — that mentions it. Pure, so it's unit-tested.
 */

export interface InlineVariable {
  name: string;
  value: string;
}

/** How far up from the paused line to look. */
const LOOKBACK = 60;
const MAX_PER_LINE = 4;
const MAX_VALUE = 60;

/** A line with comments and string contents blanked out, so names inside
 *  them don't count. */
function codeOnly(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (match) => match[0] + " ".repeat(Math.max(0, match.length - 2)) + match[0])
    .replace(/(\/\/|#(?!\[|!)|--\s).*$/, "");
}

const shorten = (value: string) =>
  value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value.replace(/\s*\n\s*/g, " ");

/** Line number → its annotation ("x = 5, total = 10"). */
export function inlineValues(lines: string[], pausedLine: number, variables: InlineVariable[]): Map<number, string> {
  const wanted = variables.filter((variable) => /^[A-Za-z_$][\w$]*$/.test(variable.name) && variable.value !== "");
  const lineOf = new Map<string, number>();
  const first = Math.max(1, pausedLine - LOOKBACK);
  for (let number = pausedLine; number >= first; number--) {
    const code = codeOnly(lines[number - 1] ?? "");
    for (const variable of wanted) {
      if (lineOf.has(variable.name)) continue;
      if (new RegExp(`(^|[^\\w$.])${variable.name.replace(/\$/g, "\\$")}(?![\\w$])`).test(code)) {
        lineOf.set(variable.name, number);
      }
    }
  }
  const byLine = new Map<number, string[]>();
  for (const variable of wanted) {
    const line = lineOf.get(variable.name);
    if (line === undefined) continue;
    const entries = byLine.get(line) ?? [];
    if (entries.length < MAX_PER_LINE) entries.push(`${variable.name} = ${shorten(variable.value)}`);
    byLine.set(line, entries);
  }
  return new Map([...byLine].map(([line, entries]) => [line, entries.join(", ")]));
}
