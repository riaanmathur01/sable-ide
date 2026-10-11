// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const TOP = 50;

/** Common English words that would otherwise fill the list. */
const STOP_WORDS = new Set(
  ("a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our she " +
    "so that the their them then there these they this to us was we were what when which who will with you your")
    .split(" "),
);

/** The words of `text`, lowercased; numbers and stop words left out. */
function words(text) {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}'’_-]*/gu) ?? [])
    .map((word) => word.replace(/['’_-]+$/u, ""))
    .filter((word) => !STOP_WORDS.has(word));
}

/** The `top` most frequent words as [word, count], most frequent first (ties alphabetically). */
function frequencies(text, top = TOP) {
  const counts = new Map();
  for (const word of words(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

/** @param {Sable} sable */
export function activate(sable) {
  sable.commands.register("show", "Show Word Frequency", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const selected = Boolean(editor.selection?.text);
    const counted = frequencies(selected ? editor.selection?.text ?? "" : editor.text);
    if (!counted.length) return sable.window.showMessage(`No words in the ${selected ? "selection" : "file"}`);

    const choice = await sable.window.showQuickPick(
      counted.map(([word, count]) => ({ label: word, description: `${count.toLocaleString()}×`, word })),
      { placeholder: `The ${counted.length} most frequent words in the ${selected ? "selection" : "file"} — choose one to copy it` },
    );
    if (!choice) return;
    await sable.env.clipboard.writeText(choice.word);
    await sable.window.showMessage(`Copied “${choice.word}”`);
  });
}
