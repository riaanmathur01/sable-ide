import { formatParam, languageOf, parseParam } from "./signature";
import { EditSet, layoutList, lineStarts, matchBracket, positionAt, skipSpace, splitTopLevel, type ScanOptions } from "./textScan";
import type { PlannedFile, RefactoringPlan, Signature, SignatureLanguage, UsageItem } from "./types";

/**
 * The text-based engine (languages without a syntax tree here: Java, Go,
 * Rust, C/C++, C#, Kotlin, PHP, Ruby…): reads declarations and calls
 * with a bracket-, string- and comment-aware scanner and rewrites them,
 * given the references a language server found (generic.ts asks it).
 *
 * No app imports: tested on its own (scripts/ui-test/refactorings-typescript.mjs).
 */

export const TEXT_ENGINE = "text-based, on the language server's references (best effort)";

export class TextFailure extends Error {}

/** A reference: the name's offsets in its file's current text. */
export interface TextLocation {
  path: string;
  start: number;
  end: number;
}

export interface TextDeclaration {
  path: string;
  text: string;
  nameStart: number;
  nameEnd: number;
  /** The parameter list's parentheses. */
  open: number;
  close: number;
  signature: Signature;
}

const KEYWORDS_BEFORE_CALL = /\b(return|new|await|throw|case|else|yield|in|of|typeof|delete|not|and|or|is|as|do|go|defer)\s*$/;

export function scanOptions(path: string): ScanOptions {
  const language = languageOf(path);
  return { hashComments: language === "ruby" || language === "other", angles: false };
}

/** After a name: optional generics, then `(`. The `(` offset, or -1. */
export function callParen(text: string, nameEnd: number, options: ScanOptions): number {
  let index = skipSpace(text, nameEnd, options);
  if (text.startsWith("::<", index)) index += 2;
  if (text[index] === "<") {
    const close = matchBracket(text, index, { ...options, angles: true });
    if (close < 0) return -1;
    index = skipSpace(text, close + 1, options);
  }
  return text[index] === "(" ? index : -1;
}

/** Whether the name at `start` (its list closing at `close`) declares a function rather than calls one. */
export function looksLikeDeclaration(text: string, start: number, close: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(lineStart, start);
  // `fn name`, `func (r T) name`, `def name`…
  if (/\b(fn|func|fun|def|function|sub)\s+(\([^)]*\)\s*)?$/.test(before)) return true;
  if (KEYWORDS_BEFORE_CALL.test(before)) return false;
  // A type or modifier right before the name: `void name(`, `List<T> name(`, `int *name(`.
  if (!/([\p{L}\p{N}_>\]?]\s+|[\p{L}\p{N}_]\s*[*&]+)$/u.test(before)) return false;
  const after = text.slice(close + 1).trimStart();
  return /^(\{|:|->|throws\b|const\b|override\b|noexcept\b|where\b|;)/.test(after);
}

/** A declaration's extent from its name: comments/annotations above, through its body. */
export function declarationExtent(text: string, nameStart: number, options: ScanOptions): { start: number; end: number } {
  const starts = lineStarts(text);
  let line = positionAt(text, nameStart).line - 1;
  // Comments, doc comments, annotations and attributes right above.
  while (line > 0) {
    const previous = text.slice(starts[line - 1], starts[line]).trim();
    if (/^(\/\/|\/\*|\*|@\w|#\[|#!\[|\[\w)/.test(previous) || (options.hashComments && previous.startsWith("#"))) line--;
    else break;
  }
  const start = starts[line];
  // The body: the first `{` or `;` at depth 0 after the name.
  let end = -1;
  for (let i = nameStart; i < text.length; i++) {
    const char = text[i];
    if (char === "(" || char === "[") {
      const close = matchBracket(text, i, options);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (char === "{") {
      end = matchBracket(text, i, options);
      break;
    }
    if (char === ";") {
      end = i;
      break;
    }
    if (char === "\n" && options.hashComments) {
      // Ruby: `def … end` at the same indentation.
      const indent = text.slice(start).match(/^[ \t]*/)![0];
      const closing = new RegExp(`\\n${indent}end\\b`).exec(text.slice(i - 1));
      if (closing) end = i - 1 + closing.index + closing[0].length - 1;
      break;
    }
  }
  if (end < 0) throw new TextFailure("Can't find where this declaration ends");
  let stop = text.indexOf("\n", end);
  stop = stop < 0 ? text.length : stop + 1;
  // A blank line goes with it when it sat between blank lines.
  const blankBefore = start === 0 || /\n[ \t]*\n$/.test(text.slice(0, start));
  const after = text.slice(stop).match(/^[ \t]*\n/);
  if (after && blankBefore) stop += after[0].length;
  else if (!after && blankBefore && start > 0) {
    // Last in its block (`}` next): the blank line before it goes.
    const previous = text.lastIndexOf("\n", start - 2);
    return { start: previous + 1, end: stop };
  }
  if (text.slice(stop).trim() === "") {
    // At the end: the blank lines before it go instead.
    stop = text.length;
    let from = start;
    while (from > 1 && text[from - 1] === "\n" && text[from - 2] === "\n") from--;
    return { start: from, end: stop };
  }
  return { start, end: stop };
}

export function usageOf(path: string, text: string, start: number, end: number): UsageItem {
  const from = positionAt(text, start);
  const starts = lineStarts(text);
  const lineEnd = from.line < starts.length ? starts[from.line] - 1 : text.length;
  return { path, line: from.line, column: from.column, endColumn: from.column + (end - start), preview: text.slice(starts[from.line - 1], lineEnd) };
}

/** If the name at `nameStart` is a parameter in a declaration's list: where that function's name is, and the parameter's index. */
export function parameterOf(text: string, nameStart: number, options: ScanOptions): { functionAt: number; index: number } | null {
  let depth = 0;
  for (let i = nameStart - 1; i >= Math.max(0, nameStart - 4000); i--) {
    const char = text[i];
    if (char === ")" || char === "]" || char === "}") depth++;
    else if (char === "[" || char === "{") {
      if (depth === 0) return null;
      depth--;
    } else if (char === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = text.slice(0, i).match(/([\p{L}_$][\p{L}\p{N}_$]*)\s*(<[^()]*>)?\s*$/u);
      if (!before || before.index === undefined) return null;
      const close = matchBracket(text, i, options);
      if (close < 0 || close < nameStart || !looksLikeDeclaration(text, before.index, close)) return null;
      const pieces = splitTopLevel(text, i + 1, close, { ...options, angles: true });
      const index = pieces.findIndex((piece) => piece.start <= nameStart && nameStart < piece.end);
      return index < 0 ? null : { functionAt: before.index, index };
    }
  }
  return null;
}

/** The function declared at `nameStart` in `text`. */
export function readDeclaration(path: string, text: string, nameStart: number): TextDeclaration {
  const options = scanOptions(path);
  const name = text.slice(nameStart).match(/^[\p{L}\p{N}_$]+/u)?.[0];
  if (!name) throw new TextFailure("Put the cursor on a function's name");
  const open = callParen(text, nameStart + name.length, options);
  if (open < 0) throw new TextFailure(`Can't find ${name}'s parameter list`);
  const close = matchBracket(text, open, options);
  if (close < 0) throw new TextFailure(`Can't read ${name}'s parameters`);
  const language = languageOf(path);
  const pieces = splitTopLevel(text, open + 1, close, { ...options, angles: true });
  let params = pieces.map((piece, index) => parseParam(language, piece.text, index));
  // Rust's `self`: not a parameter callers pass.
  let implicit: string | undefined;
  if (language === "rust" && params[0] && /^&?\s*('\w+\s+)?(mut\s+)?self\b/.test(params[0].raw ?? "")) {
    implicit = params[0].raw;
    params = params.slice(1).map((param, index) => ({ ...param, original: index }));
  }
  return { path, text, nameStart, nameEnd: nameStart + name.length, open, close, signature: { name, params, returnType: null, implicit, language, kind: "function" } };
}

/** Languages whose parameters can have default values (callers may omit them). */
const DEFAULTS = new Set<SignatureLanguage>(["kotlin", "csharp", "php", "ruby", "c", "other"]);

function rewriteArguments(signature: Signature, args: string[]): string[] {
  const out: (string | null)[] = [];
  for (const param of signature.params) {
    if (param.original !== null) {
      out.push(args[param.original] ?? null);
      continue;
    }
    const value = param.value.trim();
    const fallback = param.defaultValue.trim();
    // Without default parameters, the "default" is what callers pass.
    out.push(value || (DEFAULTS.has(signature.language) && fallback ? null : fallback));
  }
  while (out.length > 0 && out[out.length - 1] === null) out.pop();
  return out.map((value) => value ?? "");
}

/**
 * The declaration and every call and override among `locations` (the
 * function's references, its declaration included), rewritten for
 * `signature`. `files`: each file's current text.
 */
export function rewriteSignature(declaration: TextDeclaration, signature: Signature, locations: TextLocation[], files: Map<string, string>): RefactoringPlan {
  const { path } = declaration;
  files.set(path, declaration.text);
  const sets = new Map<string, EditSet>();
  const editsFor = (file: string) => {
    let set = sets.get(file);
    if (!set) sets.set(file, (set = new EditSet(files.get(file) ?? "")));
    return set;
  };
  const conflicts: string[] = [];
  const renamed = signature.name !== declaration.signature.name;
  const language = signature.language;
  const options = scanOptions(path);
  // Inner calls first (an outer call's arguments then include them).
  const sites = locations.map((location) => ({ ...location, text: files.get(location.path) ?? "" })).sort((a, b) => b.start - a.start);
  for (const site of sites) {
    const edits = editsFor(site.path);
    if (renamed) edits.add({ start: site.start, end: site.end, text: signature.name });
    if (site.path === path && site.start === declaration.nameStart) continue;
    const open = callParen(site.text, site.end, options);
    if (open < 0) continue;
    const close = matchBracket(site.text, open, options);
    if (close < 0) continue;
    const where = `${site.path.split(/[/\\]/).pop()}:${positionAt(site.text, site.start).line}`;
    if (looksLikeDeclaration(site.text, site.start, close)) {
      // An override or implementation: its own parameter texts, moved.
      const pieces = splitTopLevel(site.text, open + 1, close, { ...options, angles: true });
      const own = language === "rust" && pieces[0] && /^&?\s*('\w+\s+)?(mut\s+)?self\b/.test(pieces[0].text) ? pieces.slice(1) : pieces;
      const parts = signature.params.map((param) => (param.original !== null && own[param.original] ? own[param.original].text : formatParam(language, param)));
      if (own !== pieces) parts.unshift(pieces[0].text);
      edits.replace(open + 1, close, layoutList(site.text.slice(open + 1, close), parts, site.text, open));
      continue;
    }
    const pieces = splitTopLevel(site.text, open + 1, close, options);
    if (pieces.some((piece) => /^(\.\.\.|\*)/.test(piece.text) || /^[\p{L}_$][\p{L}\p{N}_$]*\s*(:|=)(?![=:])/u.test(piece.text))) {
      conflicts.push(`${where}: named or spread arguments — this call wasn't changed`);
      continue;
    }
    const values = rewriteArguments(
      signature,
      pieces.map((piece) => edits.peek(piece.start, piece.end)),
    );
    if (values.some((value) => value === "")) conflicts.push(`${where}: a new parameter has no value to pass`);
    edits.replace(open + 1, close, layoutList(site.text.slice(open + 1, close), values, site.text, open));
  }
  // The declaration itself.
  const parts = signature.params.map((param) => formatParam(language, param));
  if (signature.implicit) parts.unshift(signature.implicit);
  editsFor(path).replace(
    declaration.open + 1,
    declaration.close,
    layoutList(declaration.text.slice(declaration.open + 1, declaration.close), parts, declaration.text, declaration.open),
  );
  const planned: PlannedFile[] = [];
  for (const [file, edits] of sets) {
    const after = edits.result();
    if (after !== edits.text) planned.push({ path: file, before: edits.text, after });
  }
  return { title: `Change Signature of ${declaration.signature.name}`, files: planned, moves: [], conflicts, engine: TEXT_ENGINE };
}

/** Delete the declaration named at `nameStart` (with its comments and annotations). */
export function deleteDeclaration(path: string, text: string, nameStart: number): RefactoringPlan {
  const extent = declarationExtent(text, nameStart, scanOptions(path));
  const name = text.slice(nameStart).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? "this";
  return {
    title: `Safe Delete ${name}`,
    files: [{ path, before: text, after: text.slice(0, extent.start) + text.slice(extent.end) }],
    moves: [],
    conflicts: [],
    engine: TEXT_ENGINE,
  };
}
