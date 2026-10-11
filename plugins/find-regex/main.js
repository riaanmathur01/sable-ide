// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const MAX_MATCHES = 1000;

/**
 * "/todo|fixme/i" or a plain "todo|fixme" → a global RegExp. Throws
 * (with the engine's message) if the pattern or its flags are invalid.
 */
function parsePattern(input) {
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(input);
  const [source, flags] = literal ? [literal[1], literal[2]] : [input, ""];
  return new RegExp(source, flags.includes("g") ? flags : flags + "g");
}

/** Index of each line's first character, to turn offsets into line/column. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** A text offset → a 1-based position (binary search over the line starts). */
function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

/** Matches of `regex` in `text` (at most `limit`) with their ranges. */
function findMatches(text, regex, limit = MAX_MATCHES) {
  const starts = lineStarts(text);
  const matches = [];
  for (const match of text.matchAll(regex)) {
    if (matches.length === limit) return { matches, capped: true };
    const index = match.index ?? 0;
    matches.push({
      text: match[0],
      start: positionAt(starts, index),
      end: positionAt(starts, index + match[0].length),
    });
  }
  return { matches, capped: false };
}

/** Shorten for the list, showing line breaks as ⏎. */
const preview = (text, length = 80) => {
  const flat = text.replace(/\r?\n/g, "⏎");
  return flat.length > length ? flat.slice(0, length - 1) + "…" : flat;
};

/** @param {Sable} sable */
export function activate(sable) {
  let lastPattern = "";

  sable.commands.register("find", "Find with Regex…", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const input = await sable.window.showInputBox({
      prompt: "Regular expression",
      placeholder: "e.g. \\bget\\w+ or /todo|fixme/i",
      value: lastPattern,
    });
    if (!input) return;
    lastPattern = input;

    let regex;
    try {
      regex = parsePattern(input);
    } catch (error) {
      return sable.window.showError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }

    const { matches, capped } = findMatches(editor.text, regex);
    if (!matches.length) return sable.window.showMessage(`No matches for ${regex}`);
    const lines = editor.text.split(/\r?\n/);
    const choice = await sable.window.showQuickPick(
      matches.map((match) => ({
        label: `${match.start.line}: ${match.text ? preview(match.text) : "(empty match)"}`,
        detail: preview(lines[match.start.line - 1].trim(), 120),
        match,
      })),
      {
        placeholder: capped
          ? `The first ${MAX_MATCHES} matches of ${regex} — choose one to select it`
          : `${matches.length} match${matches.length === 1 ? "" : "es"} of ${regex} — choose one to select it`,
      },
    );
    if (choice) await sable.editor.setSelection({ start: choice.match.start, end: choice.match.end });
  });
}
