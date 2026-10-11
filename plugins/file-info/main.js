// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** 1536 → "1.5 KB". */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** "LF", "CRLF", "Mixed", or null for a file without line breaks. */
function lineEndings(text) {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf && lf) return "Mixed";
  if (crlf) return "CRLF";
  if (lf) return "LF";
  return null;
}

/** The longest line's length and 1-based number. */
function longestLine(lines) {
  let length = 0;
  let line = 1;
  lines.forEach((text, index) => {
    if (text.length > length) {
      length = text.length;
      line = index + 1;
    }
  });
  return { length, line };
}

/** "Tabs", "2 spaces", "4 spaces"… or "None" — a guess from how lines are indented. */
function guessIndentation(lines) {
  let tabs = 0;
  let spaces = 0;
  /** How often each step in indentation occurs (e.g. 4 → 4 → 8 is a step of 4). */
  const steps = new Map();
  let previous = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    if (indent.startsWith("\t")) {
      tabs++;
      continue;
    }
    if (indent.length) spaces++;
    const step = indent.length - previous;
    if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = indent.length;
  }
  if (!tabs && !spaces) return "None";
  if (tabs >= spaces) return spaces ? "Tabs (some lines use spaces)" : "Tabs";
  const [width] = [...steps.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [spaces ? 4 : 0];
  return `${width} space${width === 1 ? "" : "s"}${tabs ? " (some lines use tabs)" : ""}`;
}

/** Everything shown for a file's text. */
function fileInfo(text) {
  const bytes = new TextEncoder().encode(text).length;
  const lines = text.split(/\r\n|\r|\n/);
  return {
    bytes,
    lines: lines.length,
    endings: lineEndings(text),
    longest: longestLine(lines),
    indentation: guessIndentation(lines),
  };
}

/** @param {Sable} sable */
export async function activate(sable) {
  const update = async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.statusBar.clear();
    const info = fileInfo(editor.text);
    const name = editor.path.split(/[/\\]/).pop();
    const parts = [humanSize(info.bytes), `${info.lines.toLocaleString()} line${info.lines === 1 ? "" : "s"}`];
    if (info.endings) parts.push(info.endings);
    await sable.statusBar.set(parts.join(" · "), {
      tooltip: [
        name,
        `Size: ${info.bytes.toLocaleString()} bytes (UTF-8)`,
        `Lines: ${info.lines.toLocaleString()}`,
        `Longest line: ${info.longest.length.toLocaleString()} characters (line ${info.longest.line})`,
        `Line endings: ${info.endings ?? "none (a single line)"}`,
        `Indentation: ${info.indentation}`,
      ].join("\n"),
    });
  };

  sable.events.onDidChangeActiveEditor(update);
  sable.events.onDidChange(update);
  await update();
}
