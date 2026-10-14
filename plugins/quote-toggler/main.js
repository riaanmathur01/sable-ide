// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const QUOTES = ["'", '"', "`"];
/** ' → " → ` → ' */
const nextQuote = (quote) => QUOTES[(QUOTES.indexOf(quote) + 1) % QUOTES.length];

/**
 * The quoted strings in a line: `{ start, end, quote }`, where start is the
 * opening quote's index and end the index just past the closing quote.
 * Backslash escapes are skipped; an unclosed string is ignored.
 */
function findStrings(line) {
  const strings = [];
  for (let i = 0; i < line.length; i++) {
    const quote = line[i];
    if (!QUOTES.includes(quote)) continue;
    let j = i + 1;
    while (j < line.length && line[j] !== quote) j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) break;
    strings.push({ start: i, end: j + 1, quote });
    i = j;
  }
  return strings;
}

/**
 * A string's contents, re-escaped to sit between `to` quotes instead of
 * `from` quotes: `\'` loses its backslash, a bare `"` gains one, and so on.
 * In a template literal (backticks), `${` is escaped too.
 */
function requote(body, from, to) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === from && from !== to) out += next; // no longer needs escaping
      else if (from === "`" && next === "$" && body[i + 2] === "{" && to !== "`") out += "$";
      else out += char + next;
      i++;
    } else if (char === to) {
      out += "\\" + char;
    } else if (to === "`" && char === "$" && body[i + 1] === "{") {
      out += "\\$";
    } else {
      out += char;
    }
  }
  return out;
}

/** Whether a template literal's contents can't be a plain string: `${…}` or line breaks. */
function needsTemplate(body) {
  return /\n/.test(body) || /(^|[^\\])(\\\\)*\$\{/.test(body);
}

/** A whole quoted string ("'it\\'s'") in its next quote style, or null if it can't change. */
function toggleQuotes(quoted) {
  const from = quoted[0];
  const body = quoted.slice(1, -1);
  const to = nextQuote(from);
  // A template literal with interpolation or line breaks skips the plain quotes.
  if (from === "`" && needsTemplate(body)) return null;
  return to + requote(body, from, to) + to;
}

/** Whether text is one complete quoted string. */
function isQuoted(text) {
  return text.length >= 2 && QUOTES.includes(text[0]) && text.at(-1) === text[0] && findStrings(text)[0]?.end === text.length;
}

/** Wrappers offered by Wrap Selection…: label, opening, closing. */
const WRAPPERS = [
  ["( )", "(", ")"],
  ["[ ]", "[", "]"],
  ["{ }", "{", "}"],
  ['" "', '"', '"'],
  ["' '", "'", "'"],
  ["` `", "`", "`"],
  ["< >", "<", ">"],
  ["**bold**", "**", "**"],
  ["_italic_", "_", "_"],
];

/** @param {Sable} sable */
export function activate(sable) {
  sable.commands.register("toggle", "Toggle Quotes", async () => {
    const editor = await sable.editor.active();
    const selection = editor?.selection;
    if (!editor || !selection) return sable.window.showError("Open a file first");

    // A selected string, even one spanning lines (a template literal).
    if (isQuoted(selection.text)) {
      const toggled = toggleQuotes(selection.text);
      if (toggled === null) return sable.window.showError("This template string has ${…} or line breaks, so it can't use plain quotes");
      return sable.editor.replaceSelection(toggled);
    }

    // Otherwise the string around the cursor (or selection) on its line.
    const { line, column } = selection.start;
    const lineText = editor.text.split(/\r?\n/)[line - 1] ?? "";
    const from = column - 1;
    const to = selection.end.line === line ? selection.end.column - 1 : from;
    const found = findStrings(lineText).find((string) => string.start <= from && to <= string.end);
    if (!found) return sable.window.showError("Put the cursor in a quoted string first");

    const toggled = toggleQuotes(lineText.slice(found.start, found.end));
    if (toggled === null) return sable.window.showError("This template string has ${…}, so it can't use plain quotes");
    await sable.editor.applyEdits([
      { range: { start: { line, column: found.start + 1 }, end: { line, column: found.end + 1 } }, text: toggled },
    ]);
    // Keep the cursor on the same character: toggling only adds or drops
    // backslashes, so line the two strings up, skipping those.
    const before = lineText.slice(found.start, found.end);
    const offsets = [];
    for (let i = 0, j = 0; i <= before.length; ) {
      if (i < before.length && j < toggled.length && before[i] !== toggled[j]) {
        if (before[i] === "\\") {
          offsets[i++] = j;
          continue;
        }
        if (toggled[j] === "\\") {
          j++;
          continue;
        }
      }
      offsets[i++] = j++;
    }
    const shift = toggled.length - before.length;
    const place = (index) => {
      const inside = index - found.start;
      const mapped = inside >= 0 && inside <= before.length ? found.start + Math.min(offsets[inside], toggled.length) : index >= found.end ? index + shift : index;
      return { line, column: mapped + 1 };
    };
    await sable.editor.setSelection({ start: place(from), end: place(to) });
  });

  sable.commands.register("wrap", "Wrap Selection…", async () => {
    const editor = await sable.editor.active();
    const selection = editor?.selection;
    if (!editor || !selection) return sable.window.showError("Open a file first");
    const sample = selection.text.split("\n")[0].slice(0, 40) || "…";
    const choice = await sable.window.showQuickPick(
      WRAPPERS.map(([label, open, close]) => ({ label, description: open + sample + close, open, close })),
      { placeholder: selection.text ? "Wrap the selection in…" : "Insert a pair…" },
    );
    if (!choice) return;
    const { open, close } = choice;
    await sable.editor.replaceSelection(open + selection.text + close);
    // Select what was wrapped (or put the cursor between an empty pair).
    const { start, end } = selection;
    await sable.editor.setSelection({
      start: { line: start.line, column: start.column + open.length },
      end: { line: end.line, column: end.line === start.line ? end.column + open.length : end.column },
    });
  });
}
