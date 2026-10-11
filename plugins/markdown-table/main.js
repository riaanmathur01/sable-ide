// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").ActiveEditor} ActiveEditor */

/** For each line, whether it's part of a fenced code block (``` or ~~~). */
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

/** Whether a line looks like a table row: it has a "|" that isn't escaped. */
const isRow = (line) => /(^|[^\\])\|/.test(line) && !!line.trim();

/** "| a | b \| c |" → ["a", "b \| c"]. Escaped pipes stay in their cell. */
function splitRow(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (text[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += text[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The |---|:---:| row under the header. */
const isDelimiterRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

/** ":---" → "left", ":---:" → "center", "---:" → "right", "---" → "none". */
function alignmentOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "none";
}

/** Characters as they take up space (code points, not UTF-16 units). */
const width = (text) => [...text].length;

function pad(text, size, alignment) {
  const gap = size - width(text);
  if (alignment === "right") return " ".repeat(gap) + text;
  if (alignment === "center") return " ".repeat(Math.floor(gap / 2)) + text + " ".repeat(Math.ceil(gap / 2));
  return text + " ".repeat(gap);
}

function delimiter(alignment, size) {
  if (alignment === "center") return ":" + "-".repeat(size - 2) + ":";
  if (alignment === "right") return "-".repeat(size - 1) + ":";
  if (alignment === "left") return ":" + "-".repeat(size - 1);
  return "-".repeat(size);
}

/** Cells (header first) → aligned table lines. Adds the delimiter row
 *  when it's missing, and fills short rows with empty cells. */
function renderTable(rows, indent = "") {
  if (!(rows.length > 1 && isDelimiterRow(rows[1]))) {
    rows = [rows[0], rows[0].map(() => "---"), ...rows.slice(1)];
  }
  const columns = Math.max(...rows.map((row) => row.length));
  const alignments = Array.from({ length: columns }, (_, c) => alignmentOf(rows[1][c] ?? "---"));
  const body = rows.filter((_, i) => i !== 1);
  const widths = alignments.map((_, c) => Math.max(3, ...body.map((row) => width(row[c] ?? ""))));
  return rows.map((row, i) => {
    const cells = widths.map((size, c) => (i === 1 ? delimiter(alignments[c], size) : pad(row[c] ?? "", size, alignments[c])));
    return `${indent}| ${cells.join(" | ")} |`;
  });
}

/** Table lines → the same table, aligned. */
const formatTable = (lines) => renderTable(lines.map(splitRow), /^\s*/.exec(lines[0])?.[0] ?? "");

/** The table (first and last line index) containing line `index`, or null. */
function tableAround(lines, index, fenced = fencedLines(lines)) {
  const rowAt = (i) => i >= 0 && i < lines.length && !fenced[i] && isRow(lines[i]);
  if (!rowAt(index)) return null;
  let start = index;
  let end = index;
  while (rowAt(start - 1)) start--;
  while (rowAt(end + 1)) end++;
  return { start, end };
}

/** Every table touching lines first..last (0-based), each once. */
function tablesIn(lines, first, last) {
  const fenced = fencedLines(lines);
  const tables = [];
  for (let i = first; i <= last; i++) {
    const table = tableAround(lines, i, fenced);
    if (table && !tables.some((t) => t.start === table.start)) {
      tables.push(table);
      i = table.end;
    }
  }
  return tables;
}

/** The edit replacing lines start..end (0-based) with `replacement`. */
function linesEdit(lines, start, end, replacement, eol) {
  return {
    range: { start: { line: start + 1, column: 1 }, end: { line: end + 1, column: lines[end].length + 1 } },
    text: replacement.join(eol),
  };
}

// RFC 4180 CSV, for "CSV to Markdown Table".

/** The likeliest separator: the one that appears the same (non-zero)
 *  number of times on the most of the first lines, outside quotes. */
function detectSeparator(text) {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 10);
  let best = ",";
  let bestScore = -1;
  for (const separator of [",", ";", "\t"]) {
    const counts = sample.map((line) => line.replace(/"[^"]*"/g, "").split(separator).length - 1);
    const consistent = counts.filter((count) => count > 0 && count === counts[0]).length;
    const score = counts[0] > 0 ? consistent * 1000 + counts[0] : 0;
    if (score > bestScore) [best, bestScore] = [separator, score];
  }
  return best;
}

/** CSV text → rows of fields. Quoted fields may hold separators, newlines
 *  and doubled quotes (""). */
function parseCsv(text, separator = detectSeparator(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

/** CSV → table lines. Pipes are escaped; newlines in a cell become <br>. */
function csvToTable(text) {
  const rows = parseCsv(text).map((row) => row.map((cell) => cell.trim().replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")));
  return rows.length ? renderTable(rows) : [];
}

/** Which column (0-based) the cursor column (1-based) is in. */
function columnAt(line, column) {
  const before = line.slice(0, column - 1);
  const pipes = (before.match(/(^|[^\\])\|/g) ?? []).length;
  return Math.max(0, pipes - (line.trim().startsWith("|") ? 1 : 0));
}

/** @param {Sable} sable */
export function activate(sable) {
  /** The open Markdown file and its lines, or null (after saying why). */
  const open = async () => {
    const editor = await sable.editor.active();
    if (!editor) {
      await sable.window.showError("Open a Markdown file first");
      return null;
    }
    const eol = editor.text.includes("\r\n") ? "\r\n" : "\n";
    return { editor, eol, lines: editor.text.split(/\r?\n/) };
  };

  sable.commands.register("format", "Format Table", async () => {
    const context = await open();
    if (!context) return;
    const { editor, eol, lines } = context;
    const selection = editor.selection ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
    const tables = tablesIn(lines, selection.start.line - 1, selection.end.line - 1);
    if (!tables.length) return sable.window.showError("Put the cursor in a table (or select one) first");
    const edits = tables
      .map(({ start, end }) => {
        const table = lines.slice(start, end + 1);
        const formatted = formatTable(table);
        return formatted.join("\n") === table.join("\n") ? null : linesEdit(lines, start, end, formatted, eol);
      })
      .filter((edit) => edit !== null);
    if (edits.length) await sable.editor.applyEdits(/** @type {any} */ (edits));
    await sable.window.showMessage(
      edits.length ? `Formatted ${tables.length} table${tables.length === 1 ? "" : "s"}` : "Table is already formatted",
    );
  });

  sable.commands.register("fromCsv", "CSV to Markdown Table", async () => {
    const context = await open();
    if (!context) return;
    const selected = context.editor.selection?.text ?? "";
    if (!selected.trim()) return sable.window.showError("Select the CSV to convert first");
    const table = csvToTable(selected);
    if (!table.length) return sable.window.showError("The selection has no CSV rows");
    await sable.editor.replaceSelection(table.join(context.eol) + (/\r?\n$/.test(selected) ? context.eol : ""));
  });

  /** Changes the table under the cursor: `change(rows, row, column)` edits
   *  the cells and returns the (row, column) to put the cursor in. */
  const changeTable = async (change) => {
    const context = await open();
    if (!context) return;
    const { editor, eol, lines } = context;
    const cursor = editor.selection?.start ?? { line: 1, column: 1 };
    const table = tableAround(lines, cursor.line - 1);
    if (!table) return sable.window.showError("Put the cursor in a table first");
    let rows = lines.slice(table.start, table.end + 1).map(splitRow);
    if (!(rows.length > 1 && isDelimiterRow(rows[1]))) rows = [rows[0], rows[0].map(() => "---"), ...rows.slice(1)];
    const columns = Math.max(...rows.map((row) => row.length));
    rows = rows.map((row) => [...row, ...Array(columns - row.length).fill("")]);
    const row = cursor.line - 1 - table.start;
    const target = change(rows, row, Math.min(columnAt(lines[cursor.line - 1], cursor.column), columns - 1));
    const indent = /^\s*/.exec(lines[table.start])?.[0] ?? "";
    const formatted = renderTable(rows, indent);
    await sable.editor.applyEdits([linesEdit(lines, table.start, table.end, formatted, eol)]);
    // The cursor goes to the start of the new cell.
    const text = formatted[target.row];
    let column = indent.length + 3;
    for (let c = 0; c < target.column; c++) column = text.indexOf(" | ", column - 1) + 4;
    const position = { line: table.start + target.row + 1, column };
    await sable.editor.setSelection({ start: position, end: position });
  };

  sable.commands.register("addRow", "Add Row Below", () =>
    changeTable((rows, row) => {
      const at = Math.max(row, 1) + 1; // never between the header and |---|
      rows.splice(at, 0, rows[0].map(() => ""));
      return { row: at, column: 0 };
    }),
  );

  sable.commands.register("addColumn", "Add Column After", () =>
    changeTable((rows, row, column) => {
      rows.forEach((cells, i) => cells.splice(column + 1, 0, i === 1 ? "---" : ""));
      return { row, column: column + 1 };
    }),
  );
}
