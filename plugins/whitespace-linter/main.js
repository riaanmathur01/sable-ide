// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").Diagnostic} Diagnostic */

/** Files bigger than this aren't checked (characters, about 1 MB). */
const MAX_LENGTH = 1_000_000;
/** At most this many marks per file, so a messy file stays responsive. */
const MAX_DIAGNOSTICS = 1000;

/** A NUL in the first 8 KB means a binary file shown as text. */
const looksBinary = (text) => text.slice(0, 8000).includes("\u0000");

/** Languages where two trailing spaces mean a line break. */
const HARD_BREAK_LANGUAGES = new Set(["markdown", "mdx"]);

/** Where `line`'s trailing whitespace starts (0-based), or -1 if it has
 *  none worth flagging. A trailing \r (Windows line ending) doesn't count;
 *  in Markdown, exactly two spaces after text is a deliberate line break. */
function trailingStart(line, language) {
  const match = line.match(/[ \t]+(?=\r?$)/);
  if (!match || match.index === undefined) return -1;
  if (HARD_BREAK_LANGUAGES.has(language) && match[0] === "  " && match.index > 0) return -1;
  return match.index;
}

/** True when `line`'s indentation mixes tabs and spaces. A tab-indented
 *  block comment's " * " continuation lines are fine. */
function mixedIndentation(line) {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  if (!indent.includes("\t") || !indent.includes(" ")) return false;
  return !/^\t+ \*/.test(line);
}

/** The whitespace problems in `text`. */
function lint(text, language) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && diagnostics.length < MAX_DIAGNOSTICS; i++) {
    const line = lines[i];
    const start = trailingStart(line, language);
    if (start >= 0) {
      const end = line.endsWith("\r") ? line.length - 1 : line.length;
      diagnostics.push({ line: i + 1, column: start + 1, endLine: i + 1, endColumn: end + 1, message: "Trailing whitespace", severity: "info" });
    }
    if (mixedIndentation(line)) {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "";
      diagnostics.push({ line: i + 1, column: 1, endLine: i + 1, endColumn: indent.length + 1, message: "Indentation mixes tabs and spaces", severity: "info" });
    }
  }
  if (text && !text.endsWith("\n")) {
    const last = lines[lines.length - 1];
    diagnostics.push({
      line: lines.length,
      column: Math.max(1, last.length),
      endLine: lines.length,
      endColumn: last.length + 1,
      message: "No newline at the end of the file",
      severity: "hint",
    });
  }
  return diagnostics;
}

/** `text` without trailing whitespace and with a final newline (CRLF if
 *  the file uses it). Markdown line breaks stay. */
function fixWhitespace(text, language) {
  const fixed = text
    .split("\n")
    .map((line) => {
      const start = trailingStart(line, language);
      return start < 0 ? line : line.slice(0, start) + (line.endsWith("\r") ? "\r" : "");
    })
    .join("\n");
  if (!fixed || fixed.endsWith("\n")) return fixed;
  return fixed + (fixed.includes("\r\n") ? "\r\n" : "\n");
}

/** @param {Sable} sable */
export function activate(sable) {
  /** Check the file in front, if it's `path` (or any file, without one). */
  const check = async (path) => {
    const editor = await sable.editor.active();
    if (!editor || (path && editor.path !== path)) return;
    if (editor.text.length > MAX_LENGTH || looksBinary(editor.text)) {
      await sable.languages.clearDiagnostics(editor.path);
      return;
    }
    await sable.languages.setDiagnostics(editor.path, lint(editor.text, editor.language));
  };

  sable.events.onDidOpen(({ path }) => check(path));
  sable.events.onDidSave(({ path }) => check(path));
  sable.events.onDidChange(({ path }) => check(path));
  sable.events.onDidChangeActiveEditor(({ path }) => (path ? check(path) : undefined));
  // The file already open when Sable starts.
  check(null);

  sable.commands.register("fix", "Fix Whitespace", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    if (looksBinary(editor.text)) return sable.window.showError("This looks like a binary file");
    const fixed = fixWhitespace(editor.text, editor.language);
    if (fixed === editor.text) return sable.window.showMessage("No whitespace to fix");
    await sable.editor.setText(fixed);
    await check(editor.path);
    await sable.window.showMessage("Fixed trailing whitespace and the final newline");
  });
}
