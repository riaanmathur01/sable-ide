// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").Position} Position */

/**
 * An integer literal → its value, or null. Takes 255, -255, 0xff, 0b1010,
 * 0o17, and separators as in 1_000_000 or 1,000,000. BigInt keeps big
 * numbers exact.
 */
function parseInteger(literal) {
  const text = literal.trim().replace(/_/g, "");
  const match = text.match(/^([-+]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d{1,3}(?:,\d{3})+|\d+)$/);
  if (!match) return null;
  const value = BigInt(match[2].replace(/,/g, "").replace(/^0([XBO])/, (_, p) => `0${p.toLowerCase()}`));
  return match[1] === "-" ? -value : value;
}

/** A value in each base, with the usual prefixes. */
function bases(value) {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  return {
    Decimal: value.toString(),
    Hex: `${sign}0x${magnitude.toString(16)}`,
    Binary: `${sign}0b${magnitude.toString(2)}`,
    Octal: `${sign}0o${magnitude.toString(8)}`,
  };
}

/**
 * The plain decimal integers in `text`, as { start, end, text } (0-based,
 * end exclusive). A minus is a sign only when it doesn't follow a name or
 * a closing bracket ("x-1" is subtraction). Skipped: digits inside names
 * and versions (h1, v1.2), decimals (1.5), and the 0 of 0x… literals.
 */
function integers(text) {
  const out = [];
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    let start = match.index ?? 0;
    let raw = match[0];
    if (raw[0] === "-" && /[\w)\]]/.test(text[start - 1] ?? "")) {
      start++;
      raw = raw.slice(1);
    }
    const before = text[start - 1] ?? "";
    const after = text[start + raw.length] ?? "";
    if (/[\w.]/.test(before) || raw.includes(".")) continue;
    if (/^-?0$/.test(raw) && /[xXbBoO]/.test(after)) continue;
    out.push({ start, end: start + raw.length, text: raw });
  }
  return out;
}

/** `integer` (as text) plus `delta`. Leading zeros keep the width: 007 → 008. */
function addTo(integer, delta) {
  const result = BigInt(integer) + BigInt(delta);
  const digits = integer.replace(/^-/, "");
  if (digits.length > 1 && digits.startsWith("0")) {
    const sign = result < 0n ? "-" : "";
    return sign + (result < 0n ? -result : result).toString().padStart(digits.length, "0");
  }
  return result.toString();
}

/** Every integer in `text` plus `delta`. */
function shiftAll(text, delta) {
  let out = "";
  let last = 0;
  for (const { start, end, text: integer } of integers(text)) {
    out += text.slice(last, start) + addTo(integer, delta);
    last = end;
  }
  return out + text.slice(last);
}

/** Numbers (with an optional fraction) whose whole part has 4+ digits. */
function groupable(text) {
  const out = [];
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const start = match.index ?? 0;
    const before = text[start - 1] ?? "";
    const after = text[start + match[0].length] ?? "";
    if (/[\w.,]/.test(before) || /[\w,]/.test(after)) continue;
    if (match[0].split(".")[0].length < 4) continue;
    out.push({ start, end: start + match[0].length, text: match[0] });
  }
  return out;
}

/** 1234567.891 → 1,234,567.891 */
function addSeparators(number) {
  const [whole, fraction] = number.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction !== undefined ? `.${fraction}` : "");
}

function groupAll(text) {
  let out = "";
  let last = 0;
  for (const { start, end, text: number } of groupable(text)) {
    out += text.slice(last, start) + addSeparators(number);
    last = end;
  }
  return out + text.slice(last);
}

/** Integer literals of any base, as they appear in code (a minus included). */
const LITERAL = /-?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|\d(?:_?\d)*)/g;

/** The integer literals in a line, as { start, end, text }: not inside
 *  names (x1, h2) or decimals (1.5). */
function literals(line) {
  const out = [];
  for (const match of line.matchAll(LITERAL)) {
    let start = match.index ?? 0;
    let raw = match[0];
    if (raw[0] === "-" && /[\w)\]]/.test(line[start - 1] ?? "")) {
      start++;
      raw = raw.slice(1);
    }
    const before = line[start - 1] ?? "";
    const after = line.slice(start + raw.length, start + raw.length + 2);
    if (/[\w.]/.test(before) || /^(\w|\.\d)/.test(after)) continue;
    out.push({ start, end: start + raw.length, text: raw });
  }
  return out;
}

/** The token touching column `column` (1-based), else the first after it. */
function tokenAt(tokens, column, { after = true } = {}) {
  const index = column - 1;
  return tokens.find((t) => t.start <= index && index <= t.end) ?? (after ? tokens.find((t) => t.start > index) : undefined) ?? null;
}

/** The position after inserting `text` at `origin`. */
function endOf(text, origin) {
  const lines = text.split("\n");
  const last = lines[lines.length - 1].length;
  return { line: origin.line + lines.length - 1, column: lines.length === 1 ? origin.column + last : last + 1 };
}

/** @param {Sable} sable */
export function activate(sable) {
  /**
   * Change numbers: every one in the selection (which stays selected, so
   * the command can be repeated), or the one at or after the cursor on
   * its line.
   * @param {(text: string) => string} changeAll
   * @param {(line: string) => {start: number, end: number, text: string}[]} find
   * @param {(token: string) => string} changeOne
   */
  const changeNumbers = async (changeAll, find, changeOne, missing) => {
    const editor = await sable.editor.active();
    if (!editor?.selection) return sable.window.showError("Open a file first");
    const { selection } = editor;
    if (selection.text) {
      const result = changeAll(selection.text);
      if (result === selection.text) return sable.window.showError(`${missing} in the selection`);
      await sable.editor.applyEdits([{ range: { start: selection.start, end: selection.end }, text: result }]);
      await sable.editor.setSelection({ start: selection.start, end: endOf(result, selection.start) });
      return;
    }
    const { line, column } = selection.start;
    const lineText = editor.text.split("\n")[line - 1] ?? "";
    const token = tokenAt(find(lineText), column);
    if (!token) return sable.window.showError(`${missing} on this line`);
    const replacement = changeOne(token.text);
    await sable.editor.applyEdits([
      { range: { start: { line, column: token.start + 1 }, end: { line, column: token.end + 1 } }, text: replacement },
    ]);
    const end = { line, column: token.start + 1 + replacement.length };
    await sable.editor.setSelection({ start: end, end });
  };

  sable.commands.register("increment", "Increment", () =>
    changeNumbers((text) => shiftAll(text, 1), integers, (n) => addTo(n, 1), "No whole numbers"),
  );
  sable.commands.register("decrement", "Decrement", () =>
    changeNumbers((text) => shiftAll(text, -1), integers, (n) => addTo(n, -1), "No whole numbers"),
  );
  sable.commands.register("separators", "Add Thousands Separators", () =>
    changeNumbers(groupAll, groupable, addSeparators, "No numbers of 1,000 or more"),
  );

  // The selected number (or the one at the cursor) in another base.
  sable.commands.register("convert", "Convert Number…", async () => {
    const editor = await sable.editor.active();
    if (!editor?.selection) return sable.window.showError("Open a file first");
    const { selection } = editor;
    let source = selection.text;
    /** @type {import("../sable").Range | null} */
    let range = null;
    if (!source) {
      const { line, column } = selection.start;
      const token = tokenAt(literals(editor.text.split("\n")[line - 1] ?? ""), column, { after: false });
      if (token) {
        source = token.text;
        range = { start: { line, column: token.start + 1 }, end: { line, column: token.end + 1 } };
      }
    }
    const value = source ? parseInteger(source) : null;
    if (value === null) return sable.window.showError("Select a whole number, like 255, 0xff, 0b1010 or 0o17");
    const choice = await sable.window.showQuickPick(
      Object.entries(bases(value)).map(([label, description]) => ({ label, description })),
      { placeholder: `Convert ${source.trim()} to…` },
    );
    if (!choice) return;
    if (range) await sable.editor.applyEdits([{ range, text: choice.description }]);
    else await sable.editor.replaceSelection(source.replace(source.trim(), choice.description));
  });

  // Hovering an integer literal shows it in every base. Single decimal
  // digits are skipped: they're everywhere and the same in every base.
  sable.languages.registerHover("*", ({ line, column, lineText }) => {
    const token = tokenAt(literals(lineText), column, { after: false });
    if (!token || column - 1 >= token.end) return null;
    const value = parseInteger(token.text);
    if (value === null || /^-?\d$/.test(token.text)) return null;
    const rows = Object.entries(bases(value)).map(([name, text]) => `| ${name} | \`${text}\` |`);
    return {
      contents: ["| Base | Value |", "| --- | --- |", ...rows].join("\n"),
      range: { start: { line, column: token.start + 1 }, end: { line, column: token.end + 1 } },
    };
  });
}
