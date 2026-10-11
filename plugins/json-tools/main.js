// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").Position} Position */

/** Keys of every object, recursively, in order. Arrays keep their order;
 *  keys that compare equal keep theirs (Array.prototype.sort is stable). */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const sorted = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * Where (and why) `text` isn't valid JSON: { offset, message }, or null
 * when it's valid. JSON.parse's own messages differ between engines and
 * WebKit's don't say where, so this walks the text itself.
 */
function findJsonError(text) {
  let i = 0;
  const fail = (message) => {
    throw { offset: i, message };
  };
  const skipSpace = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const string = () => {
    i++; // the opening quote
    for (;;) {
      if (i >= text.length) fail("Unterminated string");
      const ch = text[i];
      if (ch === '"') return void i++;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined && '"\\/bfnrt'.includes(next)) i += 2;
        else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else fail("Invalid escape in string");
      } else if (ch < " ") fail("Unescaped control character in string (write \\n, \\t, …)");
      else i++;
    }
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = () => {
    skipSpace();
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      i++;
      skipSpace();
      if (text[i] === close) return void i++;
      for (;;) {
        if (ch === "{") {
          skipSpace();
          if (text[i] === "}") fail("Trailing comma before '}'");
          if (text[i] !== '"') fail("Expected a property name in double quotes");
          string();
          skipSpace();
          if (text[i] !== ":") fail("Expected ':' after the property name");
          i++;
        } else {
          skipSpace();
          if (text[i] === "]") fail("Trailing comma before ']'");
        }
        value();
        skipSpace();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === close) return void i++;
        fail(i >= text.length ? "Unexpected end of JSON" : `Expected ',' or '${close}'`);
      }
    }
    if (ch === '"') return string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      NUMBER.lastIndex = i;
      if (!NUMBER.test(text)) fail("Invalid number");
      i = NUMBER.lastIndex;
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) return void (i += literal.length);
    }
    if (i >= text.length) fail("Unexpected end of JSON");
    fail(ch === "'" ? "Strings need double quotes" : `Unexpected character '${ch}'`);
  };
  try {
    value();
    skipSpace();
    if (i < text.length) fail("Unexpected text after the JSON value");
    return null;
  } catch (error) {
    if (error && typeof error.offset === "number") return error;
    throw error;
  }
}

/** The position `offset` characters into `text`, which starts at `origin`. */
function positionAt(text, offset, origin = { line: 1, column: 1 }) {
  const before = text.slice(0, offset).split("\n");
  const line = origin.line + before.length - 1;
  const last = before[before.length - 1].length;
  return { line, column: before.length === 1 ? origin.column + last : last + 1 };
}

/**
 * Why `text` failed to parse and where (relative to `text`), from the
 * engine's error message when it gives a position ("line 3 column 5",
 * "position 42"), else from findJsonError.
 */
function describeError(text, error) {
  const located = findJsonError(text);
  const message = located?.message ?? String(error?.message ?? error);
  const raw = String(error?.message ?? "");
  const lineColumn = raw.match(/line (\d+) column (\d+)/);
  if (lineColumn) {
    const line = Number(lineColumn[1]);
    const column = Number(lineColumn[2]);
    const lines = text.split("\n");
    const offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column - 1;
    return { offset, message };
  }
  const position = raw.match(/at position (\d+)/);
  if (position) return { offset: Number(position[1]), message };
  return { offset: located?.offset ?? 0, message };
}

/** @param {Sable} sable */
export function activate(sable) {
  /**
   * The JSON to work on (the selection, or the whole file), parsed. On a
   * syntax error, marks it in the editor and returns null.
   */
  const load = async () => {
    const editor = await sable.editor.active();
    if (!editor) {
      await sable.window.showError("Open a file first");
      return null;
    }
    const selected = editor.selection?.text ?? "";
    const raw = selected || editor.text;
    // A byte-order mark isn't part of the JSON.
    const text = raw.replace(/^﻿/, "");
    if (!text.trim()) {
      await sable.window.showError(selected ? "The selection is empty" : "The file is empty");
      return null;
    }
    const origin = selected && editor.selection ? editor.selection.start : { line: 1, column: 1 };
    try {
      const value = JSON.parse(text);
      await sable.languages.clearDiagnostics(editor.path);
      return { editor, selected: Boolean(selected), text, value };
    } catch (error) {
      const { offset, message } = describeError(text, error);
      const bom = raw.length - text.length;
      const at = positionAt(raw, offset + bom, origin);
      await sable.languages.setDiagnostics(editor.path, [
        { line: at.line, column: at.column, endLine: at.line, endColumn: at.column + 1, message: `Invalid JSON: ${message}`, severity: "error" },
      ]);
      await sable.window.showError(`Invalid JSON (line ${at.line}, column ${at.column}): ${message}`);
      return null;
    }
  };

  /** Put `result` back where the JSON came from. A whole file keeps its
   *  trailing newline. */
  const write = async (loaded, result) => {
    if (loaded.selected) await sable.editor.replaceSelection(result);
    else await sable.editor.setText(result + (loaded.text.endsWith("\n") ? "\n" : ""));
  };

  sable.commands.register("format", "Format JSON", async () => {
    const loaded = await load();
    if (loaded) await write(loaded, JSON.stringify(loaded.value, null, 2));
  });

  sable.commands.register("minify", "Minify JSON", async () => {
    const loaded = await load();
    if (loaded) await write(loaded, JSON.stringify(loaded.value));
  });

  sable.commands.register("sort", "Sort Keys", async () => {
    const loaded = await load();
    if (!loaded) return;
    // Minified JSON stays minified; anything else comes out formatted.
    const minified = !loaded.text.trim().includes("\n");
    await write(loaded, JSON.stringify(sortKeys(loaded.value), null, minified ? undefined : 2));
  });

  sable.commands.register("validate", "Validate JSON", async () => {
    const loaded = await load();
    if (loaded) await sable.window.showMessage(loaded.selected ? "The selection is valid JSON" : "Valid JSON");
  });
}
