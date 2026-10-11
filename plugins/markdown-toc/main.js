// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").ActiveEditor} ActiveEditor */

const OPEN = /^\s*<!--\s*toc\s*-->\s*$/i;
const CLOSE = /^\s*<!--\s*tocstop\s*-->\s*$/i;

/** For each line, whether it's part of a fenced code block (``` or ~~~),
 *  fence lines included. */
function fencedLines(lines) {
  const inside = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      inside.push(true);
      const rest = match ? line.slice(match[0].length) : "";
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !rest.trim()) fence = null;
    } else if (match && !(match[1][0] === "`" && line.slice(match[0].length).includes("`"))) {
      fence = { char: match[1][0], length: match[1].length };
      inside.push(true);
    } else {
      inside.push(false);
    }
  }
  return inside;
}

/** The index of the line closing YAML front matter (--- … ---), or -1. */
function frontMatterEnd(lines) {
  if (lines[0]?.trim() !== "---") return -1;
  return lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
}

/** ATX (# Title) and setext (Title / ===) headings, outside code fences and
 *  front matter, skipping lines for which `skip(index)` is true. */
function findHeadings(lines, skip = (_i) => false) {
  const fenced = fencedLines(lines);
  const frontEnd = frontMatterEnd(lines);
  /** @type {{ level: number, text: string, line: number }[]} */
  const headings = [];
  lines.forEach((line, i) => {
    if (fenced[i] || i <= frontEnd || skip(i)) return;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      if (atx[2]?.trim()) headings.push({ level: atx[1].length, text: atx[2].trim(), line: i });
      return;
    }
    // Setext: a lone line of text, underlined with === (h1) or --- (h2).
    const next = lines[i + 1];
    if (
      next !== undefined &&
      !fenced[i + 1] &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(next) &&
      line.trim() &&
      (i === 0 || !lines[i - 1].trim()) &&
      !/^ {0,3}([-*+>|<]|\d+[.)](\s|$))/.test(line)
    ) {
      headings.push({ level: next.trim()[0] === "=" ? 1 : 2, text: line.trim(), line: i });
    }
  });
  return headings;
}

/** A heading's text without Markdown formatting: "**Fast** `api` [docs](x)" → "Fast api docs". */
function plainText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)(.+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|\W)_(?=\S)(.+?)_(?!\w)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
}

/** GitHub's anchor for a heading: "What's New?" → "whats-new". */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** A slug function that de-duplicates like GitHub: "a", "a-1", "a-2". */
function slugger() {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return (text) => {
    const base = slug(text);
    let result = base;
    while (seen.has(result)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      result = `${base}-${count}`;
    }
    seen.set(result, 0);
    return result;
  };
}

/** The <!-- toc --> and <!-- tocstop --> line indexes, or null. */
function findMarkers(lines) {
  const fenced = fencedLines(lines);
  const start = lines.findIndex((line, i) => !fenced[i] && OPEN.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && !fenced[i] && CLOSE.test(line));
  return end < 0 ? null : { start, end };
}

/** The table of contents: one nested "- [Heading](#slug)" line per heading. */
function tocItems(lines, markers = findMarkers(lines)) {
  const inMarkers = (i) => !!markers && i >= markers.start && i <= markers.end;
  const slugFor = slugger();
  // Slug every heading (the title too: GitHub counts it for duplicates).
  const entries = findHeadings(lines, inMarkers).map((h) => ({ ...h, slug: slugFor(plainText(h.text)) }));
  if (entries[0]?.level === 1) entries.shift(); // the document's title
  if (!entries.length) return [];
  const top = Math.min(...entries.map((entry) => entry.level));
  let previous = -1;
  return entries.map((entry) => {
    // Never nest more than one level below the previous item (h2 → h4).
    const depth = Math.min(entry.level - top, previous + 1);
    previous = depth;
    return `${"  ".repeat(depth)}- [${plainText(entry.text)}](#${entry.slug})`;
  });
}

/** The whole block, markers included. */
function tocBlock(items, eol = "\n") {
  return ["<!-- toc -->", "", ...items, "", "<!-- tocstop -->"].join(eol);
}

/** The edit that refreshes the list between existing markers, or null if
 *  it's up to date (or there are no markers). */
function updateEdit(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const markers = findMarkers(lines);
  if (!markers) return null;
  const inner = ["", ...tocItems(lines, markers), ""];
  const current = lines.slice(markers.start + 1, markers.end);
  if (inner.join("\n") === current.join("\n")) return null;
  return {
    // From the line after <!-- toc --> to the start of <!-- tocstop -->.
    range: { start: { line: markers.start + 2, column: 1 }, end: { line: markers.end + 1, column: 1 } },
    text: inner.map((line) => line + eol).join(""),
  };
}

/** @param {Sable} sable */
export function activate(sable) {
  /** @param {ActiveEditor} editor */
  const update = async (editor) => {
    const edit = updateEdit(editor.text);
    if (edit) await sable.editor.applyEdits([edit]);
    return !!edit;
  };

  sable.commands.register("update", "Insert/Update Table of Contents", async () => {
    const editor = await sable.editor.active();
    if (!editor || editor.language !== "markdown") return sable.window.showError("Open a Markdown file first");
    const lines = editor.text.split(/\r?\n/);
    if (findMarkers(lines)) {
      const changed = await update(editor);
      return sable.window.showMessage(changed ? "Table of contents updated" : "Table of contents is up to date");
    }
    const items = tocItems(lines, null);
    if (!items.length) return sable.window.showError("No headings to list (the first H1 is the title)");
    // Insert at the cursor, on lines of its own.
    const cursor = editor.selection?.start ?? { line: 1, column: 1 };
    const line = lines[cursor.line - 1] ?? "";
    const before = line.slice(0, cursor.column - 1).trim() ? "\n\n" : "";
    const after = line.slice((editor.selection?.end ?? cursor).column - 1).trim() ? "\n\n" : "";
    const eol = editor.text.includes("\r\n") ? "\r\n" : "\n";
    await sable.editor.replaceSelection(before + tocBlock(items, eol) + after);
  });

  // Update on save: a Markdown file that already has the markers keeps its
  // table of contents current (save again to write the update to disk).
  sable.events.onDidSave(async ({ path }) => {
    const editor = await sable.editor.active();
    if (!editor || editor.path !== path || editor.language !== "markdown") return;
    if (await update(editor)) await sable.window.showMessage("Table of contents updated — save again to keep it");
  });
}
