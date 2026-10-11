// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const SEPARATORS = [",", ";", "\t"];
const SEPARATOR_NAMES = { ",": "comma", ";": "semicolon", "\t": "tab" };

/** The likeliest separator: the one that appears the same (non-zero)
 *  number of times on the most of the first lines, outside quotes. */
function detectSeparator(text) {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 10);
  let best = ",";
  let bestScore = -1;
  for (const separator of SEPARATORS) {
    const counts = sample.map((line) => line.replace(/"[^"]*"/g, "").split(separator).length - 1);
    const consistent = counts.filter((count) => count > 0 && count === counts[0]).length;
    const score = counts[0] > 0 ? consistent * 1000 + counts[0] : 0;
    if (score > bestScore) [best, bestScore] = [separator, score];
  }
  return best;
}

/**
 * CSV text → rows of fields (RFC 4180): quoted fields may hold separators,
 * newlines and doubled quotes (""). With `trim`, spaces around unquoted
 * fields and around quotes are padding and dropped.
 */
function parseCsv(text, separator, { trim = false } = {}) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(trim && !wasQuoted ? field.trim() : field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !wasQuoted && (field === "" || (trim && !field.trim()))) {
      quoted = wasQuoted = true;
      field = "";
    } else if (char === separator) endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      row = [];
    } else if (!(wasQuoted && trim && (char === " " || char === "\t"))) field += char;
  }
  if (field || wasQuoted || row.length) {
    endField();
    rows.push(row);
  }
  // Blank lines aren't rows.
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** A field as CSV: quoted only when it has to be. */
function quote(value, separator = ",") {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.includes(separator) || /["\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** "42" → 42, "true" → true; anything else (like "007") stays a string. */
function typed(value) {
  if (value === "true" || value === "false") return value === "true";
  if (value.trim() && String(Number(value)) === value) return Number(value);
  return value;
}

/** CSV (header row first) → an array of objects. */
function csvToObjects(text, separator = detectSeparator(text)) {
  const [header = [], ...rows] = parseCsv(text, separator);
  // Blank or repeated column names get a number so no value is lost.
  const used = new Set();
  const keys = header.map((name, i) => {
    let key = name.trim() || `column${i + 1}`;
    for (let n = 2; used.has(key); n++) key = `${name.trim() || `column${i + 1}`}_${n}`;
    used.add(key);
    return key;
  });
  return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, typed(row[i] ?? "")])));
}

/** JSON (an array of objects, an object, or an array of arrays) → CSV. */
function jsonToCsv(json, separator = ",") {
  const data = Array.isArray(json) ? json : [json];
  if (data.every(Array.isArray)) return data.map((row) => row.map((v) => quote(v, separator)).join(separator)).join("\n");
  const records = data.map((item) => (item !== null && typeof item === "object" && !Array.isArray(item) ? item : { value: item }));
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return [columns, ...records.map((record) => columns.map((column) => record[column]))]
    .map((row) => row.map((value) => quote(value, separator)).join(separator))
    .join("\n");
}

/** Rows → CSV with every column padded to the same width (after its separator). */
function alignRows(rows, separator) {
  const cells = rows.map((row) => row.map((value) => quote(value, separator)));
  const columns = Math.max(...cells.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...cells.map((row) => [...(row[c] ?? "")].length)));
  return cells
    .map((row) =>
      row.map((cell, c) => (c === row.length - 1 ? cell : cell + separator + " ".repeat(widths[c] - [...cell].length))).join(" "),
    )
    .join("\n");
}

/** @param {Sable} sable */
export function activate(sable) {
  /** The selection, or the whole file without one. */
  const source = async () => {
    const editor = await sable.editor.active();
    if (!editor) {
      await sable.window.showError("Open a file first");
      return null;
    }
    const selected = editor.selection?.text ?? "";
    const text = selected || editor.text;
    const trailing = /\r?\n$/.exec(text)?.[0] ?? "";
    return { text, trailing, write: (result) => (selected ? sable.editor.replaceSelection(result) : sable.editor.setText(result)) };
  };

  sable.commands.register("toJson", "CSV to JSON", async () => {
    const input = await source();
    if (!input) return;
    const separator = detectSeparator(input.text);
    const objects = csvToObjects(input.text, separator);
    if (!objects.length) return sable.window.showError("Need a header row and at least one row of CSV");
    await input.write(JSON.stringify(objects, null, 2) + input.trailing);
    await sable.window.showMessage(`${objects.length} row${objects.length === 1 ? "" : "s"} converted (${SEPARATOR_NAMES[separator]}-separated)`);
  });

  sable.commands.register("fromJson", "JSON to CSV", async () => {
    const input = await source();
    if (!input) return;
    let json;
    try {
      json = JSON.parse(input.text);
    } catch (error) {
      return sable.window.showError(`Not valid JSON: ${error instanceof Error ? error.message : error}`);
    }
    if (json === null || typeof json !== "object" || (Array.isArray(json) && !json.length)) {
      return sable.window.showError("Expected an array of objects");
    }
    await input.write(jsonToCsv(json) + (input.trailing || "\n"));
  });

  sable.commands.register("align", "Align CSV Columns", async () => {
    const input = await source();
    if (!input) return;
    const separator = detectSeparator(input.text);
    const rows = parseCsv(input.text, separator, { trim: true });
    if (!rows.length) return sable.window.showError("No CSV to align");
    await input.write(alignRows(rows, separator) + input.trailing);
  });

  sable.commands.register("shrink", "Shrink CSV Columns (Remove Padding)", async () => {
    const input = await source();
    if (!input) return;
    const separator = detectSeparator(input.text);
    const rows = parseCsv(input.text, separator, { trim: true });
    if (!rows.length) return sable.window.showError("No CSV to shrink");
    await input.write(rows.map((row) => row.map((value) => quote(value, separator)).join(separator)).join("\n") + input.trailing);
  });
}
