// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").Diagnostic} Diagnostic */

/** Each line's part in a fenced code block: "open", "body", "close" or null. */
function fences(lines) {
  /** @type {("open" | "body" | "close" | null)[]} */
  const kinds = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const rest = match ? line.slice(match[0].length) : "";
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !rest.trim()) {
        kinds.push("close");
        fence = null;
      } else kinds.push("body");
    } else if (match && !(match[1][0] === "`" && rest.includes("`"))) {
      fence = { char: match[1][0], length: match[1].length };
      kinds.push("open");
    } else kinds.push(null);
  }
  return kinds;
}

/** The index of the line closing YAML front matter (--- … ---), or -1. */
function frontMatterEnd(lines) {
  if (lines[0]?.trim() !== "---") return -1;
  return lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const BULLET = /^(\s*)([-*+])[ \t]+/;
const ORDERED = /^(\s*)\d{1,9}[.)](?:[ \t]+|$)/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Inline code spans blanked out, so `![](x)` in code isn't flagged. */
const withoutCode = (line) => line.replace(/(`+)(.+?)\1/g, (span) => " ".repeat(span.length));

/** Markdown problems in `text`, as diagnostics. */
function lint(text) {
  const lines = text.split(/\r?\n/);
  const kinds = fences(lines);
  const frontEnd = frontMatterEnd(lines);
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const warn = (index, column, endColumn, message) =>
    diagnostics.push({ line: index + 1, column, endColumn, message, severity: "warning", source: "Markdown Lint" });
  // Lines outside the document (and front matter) count as blank.
  const blank = (index) => index <= frontEnd || index >= lines.length || !lines[index].trim();

  let previousLevel = 0;
  let blankRun = 0;
  /** The bullet ("-", "*" or "+") each list in progress uses, by indent. */
  const bullets = new Map();

  lines.forEach((line, i) => {
    if (i <= frontEnd || kinds[i] === "body") return;
    // The empty "line" after the file's final newline isn't a line.
    if (i === lines.length - 1 && i > 0 && line === "") return;

    // Trailing whitespace: two spaces after text are a line break, so allowed.
    const trailing = /[ \t]+$/.exec(line);
    if (trailing && !(trailing[0] === "  " && line.trim())) {
      warn(i, trailing.index + 1, line.length + 1, line.trim() ? "Trailing spaces" : "Whitespace on a blank line");
    }

    // More than one blank line in a row.
    if (!line.trim()) {
      blankRun++;
      if (blankRun > 1) warn(i, 1, line.length + 1, "Multiple consecutive blank lines");
      return;
    }
    blankRun = 0;

    // Fenced code needs blank lines around it.
    if (kinds[i] === "open" && !blank(i - 1)) warn(i, 1, line.length + 1, "Add a blank line before this code block");
    if (kinds[i] === "close" && !blank(i + 1)) warn(i, 1, line.length + 1, "Add a blank line after this code block");

    // Headings: no skipped levels, and blank lines around them.
    const atx = ATX_HEADING.exec(line);
    const setext =
      !atx && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1] ?? "") && blank(i - 1) && !kinds[i + 1] &&
      !BULLET.test(line) && !ORDERED.test(line) && !THEMATIC_BREAK.test(line) && !/^\s*[>|<]/.test(line);
    if (atx || setext) {
      const level = atx ? atx[1].length : (lines[i + 1].trim()[0] === "=" ? 1 : 2);
      if (previousLevel && level > previousLevel + 1) {
        warn(i, 1, line.length + 1, `Heading level skips from h${previousLevel} to h${level} (expected h${previousLevel + 1})`);
      }
      previousLevel = level;
      if (atx) {
        if (!blank(i - 1)) warn(i, 1, line.length + 1, "Add a blank line before this heading");
        if (!blank(i + 1)) warn(i, 1, line.length + 1, "Add a blank line after this heading");
      }
    }

    // Images need alt text: ![](src) or ![][ref].
    const code = withoutCode(line);
    for (const match of code.matchAll(/!\[\s*\][([]/g)) {
      warn(i, (match.index ?? 0) + 1, (match.index ?? 0) + match[0].length + 1, "Image has no alt text");
    }

    // One bullet character per list.
    const bullet = BULLET.exec(line);
    const ordered = !bullet && ORDERED.exec(line);
    if (bullet && !THEMATIC_BREAK.test(line)) {
      const indent = bullet[1].length;
      for (const level of bullets.keys()) if (level > indent) bullets.delete(level);
      const first = bullets.get(indent);
      if (first && first !== bullet[2]) {
        warn(i, indent + 1, indent + 2, `List marker "${bullet[2]}" differs from "${first}" used earlier in this list`);
      } else bullets.set(indent, bullet[2]);
    } else if (ordered) {
      const indent = ordered[1].length;
      for (const level of bullets.keys()) if (level >= indent) bullets.delete(level);
    } else if (!/^\s{2,}/.test(line)) {
      // Unindented text that isn't a list item ends every list.
      bullets.clear();
    }
  });
  return diagnostics;
}

/** @param {Sable} sable */
export async function activate(sable) {
  let found = 0;
  /** Lints the open file if it's Markdown (and, given a path, that file). */
  const check = async (path) => {
    const editor = await sable.editor.active();
    if (!editor || editor.language !== "markdown" || (path && editor.path !== path)) return false;
    const diagnostics = lint(editor.text);
    found = diagnostics.length;
    if (found) await sable.languages.setDiagnostics(editor.path, diagnostics);
    else await sable.languages.clearDiagnostics(editor.path);
    return true;
  };
  sable.events.onDidOpen(({ path }) => check(path));
  sable.events.onDidSave(({ path }) => check(path));
  sable.events.onDidChange(({ path }) => check(path));
  sable.events.onDidChangeActiveEditor(({ path }) => path && check(path));
  sable.commands.register("lint", "Lint This File", async () => {
    if (!(await check())) return sable.window.showError("Open a Markdown file first");
    await sable.window.showMessage(found ? `${found} Markdown problem${found === 1 ? "" : "s"} — see Problems` : "No Markdown problems");
  });
  sable.commands.register("clear", "Clear Markdown Problems", () => sable.languages.clearDiagnostics());
  await check();
}
