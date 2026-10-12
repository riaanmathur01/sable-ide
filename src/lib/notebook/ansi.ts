/**
 * ANSI escape codes (colors in tracebacks, colored logs, progress bars)
 * as styled text segments. The 16 standard colors are CSS variables
 * (--nb-ansi-0 … 15) set from the theme's terminal palette, so outputs
 * match the integrated terminal.
 */

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const indexed = (index: number) => `var(--nb-ansi-${index})`;

/** One of the 256 xterm colors. */
function color256(index: number): string {
  if (index < 16) return indexed(index);
  if (index < 232) {
    const value = index - 16;
    const level = (component: number) => (component === 0 ? 0 : 55 + component * 40);
    return `rgb(${level(Math.floor(value / 36))}, ${level(Math.floor(value / 6) % 6)}, ${level(value % 6)})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

/**
 * Apply carriage returns and backspaces like a terminal would: "\r"
 * rewinds to the line start (progress bars redraw in place), "\b"
 * erases a character.
 */
export function applyControlCharacters(text: string): string {
  if (!/[\r\b]/.test(text)) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line) => {
      let current = "";
      for (const part of line.split("\r")) {
        // Overwrite from the start of the line.
        current = part + current.slice(part.length);
      }
      while (current.includes("\b")) current = current.replace(/[^\b]?\b/, "");
      return current;
    })
    .join("\n");
}

const ESCAPE = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

/** Text with ANSI codes → styled segments (other escapes dropped). */
export function parseAnsi(input: string): AnsiSegment[] {
  const text = applyControlCharacters(input);
  const segments: AnsiSegment[] = [];
  let style: Omit<AnsiSegment, "text"> = {};
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const previous = segments[segments.length - 1];
    if (previous && sameStyle(previous, style)) previous.text += chunk;
    else segments.push({ text: chunk, ...style });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[2] !== "m") continue; // cursor movement etc.: ignored
    const codes = (match[1] || "0").split(";").map((code) => Number(code || 0));
    style = { ...style };
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) style = {};
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 22) style.bold = style.dim = false;
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code >= 30 && code <= 37) style.fg = indexed(code - 30);
      else if (code >= 90 && code <= 97) style.fg = indexed(code - 90 + 8);
      else if (code === 39) delete style.fg;
      else if (code >= 40 && code <= 47) style.bg = indexed(code - 40);
      else if (code >= 100 && code <= 107) style.bg = indexed(code - 100 + 8);
      else if (code === 49) delete style.bg;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "fg" : "bg";
        if (codes[index + 1] === 5) {
          style[key] = color256(codes[index + 2] ?? 0);
          index += 2;
        } else if (codes[index + 1] === 2) {
          style[key] = `rgb(${codes[index + 2] ?? 0}, ${codes[index + 3] ?? 0}, ${codes[index + 4] ?? 0})`;
          index += 4;
        }
      }
    }
  }
  push(text.slice(last));
  return segments;
}

function sameStyle(a: Omit<AnsiSegment, "text">, b: Omit<AnsiSegment, "text">): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

/** The text without any escape codes (for copying, hover text). */
export function stripAnsi(text: string): string {
  return applyControlCharacters(text).replace(ESCAPE, "");
}
