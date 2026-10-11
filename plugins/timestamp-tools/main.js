// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** 10-digit (seconds) and 13-digit (milliseconds) Unix timestamps, not
 *  inside longer numbers, names or decimals. */
const EPOCH = /(?<![\w.])(?:\d{10}|\d{13})(?![\w]|\.\d)/g;
/** ISO 8601 dates and date-times: 2024-05-01, 2024-05-01T12:30:00Z,
 *  2024-05-01 12:30:00.123+02:00, … */
const ISO = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/** A timestamp's digits → milliseconds: 13+ digits are already ms. */
const toMs = (digits) => (digits.replace(/^-/, "").length >= 12 ? Number(digits) : Number(digits) * 1000);

/** ISO 8601 in UTC, without ".000" when there are no milliseconds. */
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

/** How far `ms` is from now: "3 days ago", "2 hours from now". */
function relative(ms, now = Date.now()) {
  const diff = ms - now;
  const seconds = Math.abs(diff) / 1000;
  const suffix = diff < 0 ? "ago" : "from now";
  const unit = (n, name) => `${n.toLocaleString("en-US")} ${name}${n === 1 ? "" : "s"} ${suffix}`;
  if (seconds < 1) return "now";
  if (seconds < 60) return unit(Math.floor(seconds), "second");
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return unit(Math.floor(seconds / 3600), "hour");
  const days = Math.floor(seconds / 86400);
  if (days < 365) return unit(days, "day");
  const years = Math.round((days / 365.25) * 10) / 10;
  return `${unit(days, "day")} (about ${years} year${years === 1 ? "" : "s"})`;
}

/** The time in the user's own time zone, e.g. "May 1, 2024, 2:30:00 PM GMT+2". */
const local = (ms) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(new Date(ms));

/** A date-time → milliseconds, or NaN. "2024-05-01 12:30" (a space, not
 *  T) is read too; a date-time without a zone is local time and a bare
 *  date is UTC midnight, as in JavaScript. */
const parseDate = (text) => Date.parse(text.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));

/** Matches of `pattern` in `line` as { start, end, text } (0-based). */
const matches = (line, pattern) =>
  Array.from(line.matchAll(pattern), (m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] }));

/** The match containing (or ending at) 0-based `index`. */
const at = (tokens, index) => tokens.find((t) => t.start <= index && index <= t.end) ?? null;

/** Convert a timestamp to ISO, or a date to a timestamp (seconds). */
function convert(text) {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const ms = toMs(trimmed);
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new Error("That timestamp is out of range");
    return iso(ms);
  }
  const ms = parseDate(trimmed);
  if (Number.isNaN(ms)) throw new Error("Select a Unix timestamp or a date, like 1700000000 or 2024-05-01T12:30:00Z");
  return String(Math.floor(ms / 1000));
}

/** @param {Sable} sable */
export function activate(sable) {
  sable.languages.registerHover("*", ({ line, column, lineText }) => {
    const token = at(matches(lineText, EPOCH), column - 1);
    if (!token || column - 1 >= token.end) return null;
    const ms = toMs(token.text);
    const kind = token.text.length === 13 ? "milliseconds" : "seconds";
    return {
      contents: [
        `**Unix timestamp** (${kind})`,
        "",
        `- UTC: \`${iso(ms)}\``,
        `- Local: ${local(ms)}`,
        `- ${relative(ms)}`,
      ].join("\n"),
      range: { start: { line, column: token.start + 1 }, end: { line, column: token.end + 1 } },
    };
  });

  const insert = async (text) => {
    if (!(await sable.editor.active())) return sable.window.showError("Open a file first");
    await sable.editor.replaceSelection(text);
  };
  sable.commands.register("insertUnix", "Insert Unix Timestamp", () => insert(String(Math.floor(Date.now() / 1000))));
  sable.commands.register("insertIso", "Insert ISO Date-Time", () => insert(iso(Math.floor(Date.now() / 1000) * 1000)));

  // The selection, or the timestamp or date at the cursor.
  sable.commands.register("convert", "Convert Timestamp ↔ Date", async () => {
    const editor = await sable.editor.active();
    if (!editor?.selection) return sable.window.showError("Open a file first");
    const { selection } = editor;
    try {
      if (selection.text) {
        const result = convert(selection.text);
        await sable.editor.replaceSelection(selection.text.replace(selection.text.trim(), result));
        return;
      }
      const { line, column } = selection.start;
      const lineText = editor.text.split("\n")[line - 1] ?? "";
      const token = at(matches(lineText, EPOCH), column - 1) ?? at(matches(lineText, ISO), column - 1);
      if (!token) return sable.window.showError("Select a Unix timestamp or a date, or put the cursor on one");
      await sable.editor.applyEdits([
        { range: { start: { line, column: token.start + 1 }, end: { line, column: token.end + 1 } }, text: convert(token.text) },
      ]);
    } catch (error) {
      await sable.window.showError(error instanceof Error ? error.message : String(error));
    }
  });
}
