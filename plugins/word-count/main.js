// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Words, characters, and minutes to read at ~230 words a minute. */
function stats(text) {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return { words, characters: text.length, minutes: Math.max(1, Math.round(words / 230)) };
}

/** @param {Sable} sable */
export async function activate(sable) {
  const update = async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.statusBar.clear();
    const source = editor.selection?.text ? editor.selection.text : editor.text;
    const { words, characters, minutes } = stats(source);
    const scope = editor.selection?.text ? "selected" : "";
    await sable.statusBar.set(`${words.toLocaleString()} words${scope ? " selected" : ""}`, {
      tooltip: `${characters.toLocaleString()} characters · about ${minutes} min to read — click to recount`,
      command: "count",
    });
  };
  sable.commands.register("count", "Count Words (or Selection)", update);
  sable.events.onDidOpen(update);
  sable.events.onDidSave(update);
  await update();
}
