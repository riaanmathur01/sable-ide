// @ts-check
/** @typedef {import("../sable").Sable} Sable */
/** @typedef {import("../sable").ActiveEditor["selection"]} Selection */

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** Characters, words and lines of a selection. */
function stats(selection) {
  const { text, start, end } = selection;
  // Characters as people count them: an emoji is one, not two.
  const characters = [...text].length;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  // Whole lines selected end at column 1 of the next line, which isn't really selected.
  let lines = end.line - start.line + 1;
  if (end.line > start.line && end.column === 1) lines--;
  return { characters, words, lines };
}

/** @param {Sable} sable */
export function activate(sable) {
  let shown = false;

  /** @param {Selection} selection */
  const update = async (selection) => {
    if (!selection?.text) {
      if (shown) await sable.statusBar.clear();
      shown = false;
      return;
    }
    const { characters, words, lines } = stats(selection);
    shown = true;
    await sable.statusBar.set(`${plural(characters, "char")} · ${plural(words, "word")} · ${plural(lines, "line")}`, {
      tooltip: `Selected: ${plural(characters, "character")}, ${plural(words, "word")}, ${plural(lines, "line")}`,
    });
  };

  sable.events.onDidChangeSelection(({ selection }) => update(selection));
  // Switching files resets the selection; the next selection event redraws it.
  sable.events.onDidChangeActiveEditor(() => update(null));
}
