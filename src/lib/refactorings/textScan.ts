/**
 * Bracket-, string- and comment-aware scanning of source text, for the
 * text-based refactorings (languages without a syntax tree here): find a
 * call's matching parenthesis, split an argument list at its top-level
 * commas, find where a declaration ends.
 */

export interface ScanOptions {
  /** `#` starts a line comment (Python, Ruby, shell). */
  hashComments?: boolean;
  /** Treat `<…>` as brackets (generic parameter lists). */
  angles?: boolean;
}

const OPEN = "([{";
const CLOSE = ")]}";

/** Index just past a string/comment starting at `index`, or -1 if none starts there. */
function skipLiteral(text: string, index: number, options: ScanOptions): number {
  const char = text[index];
  const next = text[index + 1];
  if (char === "/" && next === "/") {
    const end = text.indexOf("\n", index);
    return end < 0 ? text.length : end;
  }
  if (char === "/" && next === "*") {
    const end = text.indexOf("*/", index + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (char === "#" && options.hashComments) {
    const end = text.indexOf("\n", index);
    return end < 0 ? text.length : end;
  }
  if (char === '"' || char === "'" || char === "`") {
    const triple = text.slice(index, index + 3);
    if (triple === '"""' || triple === "'''") {
      const end = text.indexOf(triple, index + 3);
      return end < 0 ? text.length : end + 3;
    }
    for (let i = index + 1; i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === char) return i + 1;
      // Unterminated on this line (a char literal like Rust's lifetimes 'a): stop.
      if (text[i] === "\n" && char !== "`") return char === "'" ? index + 1 : i;
    }
    return text.length;
  }
  return -1;
}

/** Index of the bracket closing the one at `open`; -1 if unbalanced. */
export function matchBracket(text: string, open: number, options: ScanOptions = {}): number {
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const skipped = skipLiteral(text, i, options);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    const char = text[i];
    if (OPEN.includes(char) || (options.angles && char === "<")) stack.push(char);
    else if (CLOSE.includes(char) || (options.angles && char === ">" && stack[stack.length - 1] === "<")) {
      if (char === ">" && text[i - 1] === "=") continue; // `=>`
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export interface Piece {
  start: number;
  end: number;
  /** Trimmed text. */
  text: string;
}

/** The top-level comma-separated pieces of text[start, end). */
export function splitTopLevel(text: string, start: number, end: number, options: ScanOptions = {}): Piece[] {
  const pieces: Piece[] = [];
  let depth = 0;
  let pieceStart = start;
  const push = (to: number) => {
    const raw = text.slice(pieceStart, to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) pieces.push({ start: pieceStart + lead, end: pieceStart + lead + trimmed.length, text: trimmed });
  };
  for (let i = start; i < end; i++) {
    const skipped = skipLiteral(text, i, options);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    const char = text[i];
    if (OPEN.includes(char) || (options.angles && char === "<")) depth++;
    else if (CLOSE.includes(char) || (options.angles && char === ">" && text[i - 1] !== "=" && depth > 0)) depth--;
    else if (char === "," && depth === 0) {
      push(i);
      pieceStart = i + 1;
    }
  }
  push(end);
  return pieces;
}

/** Skip whitespace (and comments) forward from `index`. */
export function skipSpace(text: string, index: number, options: ScanOptions = {}): number {
  let i = index;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const skipped = text[i] === "/" || text[i] === "#" ? skipLiteral(text, i, options) : -1;
    if (skipped >= 0) {
      i = skipped;
      continue;
    }
    break;
  }
  return i;
}

/** Offset of each line's start. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line + 1-based UTF-16 column → offset. */
export function offsetAt(text: string, line: number, column: number): number {
  const starts = lineStarts(text);
  const start = starts[Math.min(Math.max(line - 1, 0), starts.length - 1)];
  return Math.min(start + column - 1, text.length);
}

/** Offset → 1-based line and column. */
export function positionAt(text: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(text);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

/** An edit at character offsets. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * Collects edits to one file where some replace a range containing
 * earlier ones (a call nested in another call's arguments): `absorb`
 * hands back the range's text with the inner edits applied and drops them.
 */
export class EditSet {
  edits: TextEdit[] = [];
  constructor(readonly text: string) {}

  /** The text of [start, end) with the edits inside it applied (and removed). */
  absorb(start: number, end: number): string {
    const inner = this.edits.filter((edit) => edit.start >= start && edit.end <= end);
    this.edits = this.edits.filter((edit) => !inner.includes(edit));
    return applyEdits(
      this.text.slice(start, end),
      inner.map((edit) => ({ start: edit.start - start, end: edit.end - start, text: edit.text })),
    );
  }

  /** The text of [start, end) with the edits inside it applied (kept). */
  peek(start: number, end: number): string {
    const inner = this.edits.filter((edit) => edit.start >= start && edit.end <= end);
    return applyEdits(
      this.text.slice(start, end),
      inner.map((edit) => ({ start: edit.start - start, end: edit.end - start, text: edit.text })),
    );
  }

  /** Replace [start, end), dropping edits inside it (`text` already accounts for them). */
  replace(start: number, end: number, text: string) {
    this.edits = this.edits.filter((edit) => !(edit.start >= start && edit.end <= end));
    if (this.edits.some((edit) => edit.start < end && start < edit.end)) return false;
    this.edits.push({ start, end, text });
    return true;
  }

  add(edit: TextEdit) {
    if (this.edits.some((other) => other.start === edit.start && other.end === edit.end && other.text === edit.text)) return;
    this.edits.push(edit);
  }

  result(): string {
    return applyEdits(this.text, this.edits);
  }
}

/** `(a, b)` — or one per line, indented like the original when it was laid out so. */
export function layoutList(originalInner: string, parts: string[], fullText: string, openParen: number): string {
  const lead = originalInner.match(/^[ \t]*\n([ \t]*)/);
  if (lead && parts.length > 0) {
    const indent = lead[1];
    // The closing parenthesis's indentation: the line it was on.
    const closingLine = originalInner.slice(originalInner.lastIndexOf("\n") + 1);
    const closing = closingLine.trim() === "" ? closingLine : lineIndent(fullText, openParen);
    const trailingComma = /,\s*$/.test(originalInner.trimEnd()) ? "," : "";
    return "\n" + parts.map((part) => indent + part).join(",\n") + trailingComma + "\n" + closing;
  }
  return parts.join(", ");
}

/** The indentation of the line `offset` is on. */
export function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(start).match(/^[ \t]*/)![0];
}
