// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Characters as people see them (an emoji with a skin tone is one), so
 *  reversing doesn't break them apart. */
function graphemes(text) {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

const rot13 = (text) =>
  text.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= "Z" ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });

/** "Héllo, World!" → "hello-world" */
const slugify = (text) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/** A line wrapped at `width` columns, breaking between words. Continuation
 *  lines keep the line's indentation; a word longer than the width gets a
 *  line of its own. */
function wrapLine(line, width) {
  if (line.length <= width) return [line];
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const words = line.slice(indent.length).split(/\s+/).filter(Boolean);
  const out = [];
  let current = "";
  for (const word of words) {
    if (current && indent.length + current.length + 1 + word.length > width) {
      out.push(indent + current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(indent + current);
  return out;
}

/** Transforms of the list of lines. */
/** @type {Record<string, [string, (lines: string[]) => string[]]>} */
const LINE_TRANSFORMS = {
  reverseLines: ["Reverse Lines", (lines) => [...lines].reverse()],
  trimTrailing: ["Trim Trailing Whitespace", (lines) => lines.map((line) => line.replace(/[ \t\f\v\u00a0]+(\r?)$/, "$1"))],
  removeBlank: ["Remove Blank Lines", (lines) => lines.filter((line) => line.trim())],
  joinLines: ["Join Lines", (lines) => [lines.map((line) => line.trim()).filter(Boolean).join(" ")]],
  // Inner runs of spaces and tabs become one space; indentation stays.
  collapseSpaces: [
    "Collapse Spaces",
    (lines) => lines.map((line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? "";
      return indent + line.slice(indent.length).replace(/[ \t]+/g, " ");
    }),
  ],
  numberLines: [
    "Number Lines",
    (lines) => {
      const width = String(lines.length).length;
      return lines.map((line, i) => `${String(i + 1).padStart(width)}. ${line}`);
    },
  ],
  slugify: ["Slugify", (lines) => lines.map(slugify)],
  wrap80: ["Wrap Lines at 80", (lines) => lines.flatMap((line) => wrapLine(line, 80))],
};

/** Transforms of the text as a whole. */
/** @type {Record<string, [string, (text: string) => string]>} */
const TEXT_TRANSFORMS = {
  reverseText: ["Reverse Text", (text) => graphemes(text).reverse().join("")],
  rot13: ["ROT13", rot13],
};

/** `text` with `transform` applied to its lines. A trailing newline
 *  stays where it was. */
function transformLines(text, transform) {
  return withLineEndings(text, transform);
}

/** `transform` on the lines of `text`, keeping its line endings (\r\n or
 *  \n, even mixed): each line break stays in its place while the number
 *  of lines doesn't change, else the text's usual one is used. */
function withLineEndings(text, transform) {
  const parts = text.split(/(\r?\n)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const breaks = parts.filter((_, i) => i % 2 === 1);
  const trailing = lines.length > 1 && lines[lines.length - 1] === "" ? breaks.pop() : "";
  if (trailing) lines.pop();
  const result = transform(lines);
  const usual = text.includes("\r\n") ? "\r\n" : "\n";
  const joined = result.map((line, i) => (i === 0 ? line : (result.length === lines.length ? breaks[i - 1] : usual) + line)).join("");
  return joined + (trailing ? (result.length === lines.length ? trailing : usual) : "");
}

/** @param {Sable} sable */
export function activate(sable) {
  /** @param {string} title @param {(text: string) => string} transform */
  const register = (id, title, transform) =>
    sable.commands.register(id, title, async () => {
      const editor = await sable.editor.active();
      if (!editor) return sable.window.showError("Open a file first");
      const selected = editor.selection?.text ?? "";
      const text = selected || editor.text;
      if (!text) return sable.window.showError("Nothing to transform: the file is empty");
      const result = transform(text);
      if (result === text) return sable.window.showMessage(`${title}: nothing to change`);
      if (selected) await sable.editor.replaceSelection(result);
      else await sable.editor.setText(result);
    });

  for (const [id, [title, transform]] of Object.entries(LINE_TRANSFORMS)) {
    register(id, title, (text) => transformLines(text, transform));
  }
  for (const [id, [title, transform]] of Object.entries(TEXT_TRANSFORMS)) {
    register(id, title, transform);
  }
}
