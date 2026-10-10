// @ts-check
/** @typedef {import("../sable").Sable} Sable */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** @type {Record<string, [string, (lines: string[]) => string[]]>} */
const ACTIONS = {
  ascending: ["Sort Lines (A → Z)", (lines) => [...lines].sort(collator.compare)],
  descending: ["Sort Lines (Z → A)", (lines) => [...lines].sort((a, b) => collator.compare(b, a))],
  length: ["Sort Lines by Length", (lines) => [...lines].sort((a, b) => a.length - b.length || collator.compare(a, b))],
  unique: ["Remove Duplicate Lines", (lines) => [...new Set(lines)]],
  reverse: ["Reverse Lines", (lines) => [...lines].reverse()],
  shuffle: [
    "Shuffle Lines",
    (lines) => {
      const out = [...lines];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  ],
};

/** @param {Sable} sable */
export function activate(sable) {
  for (const [id, [title, transform]] of Object.entries(ACTIONS)) {
    sable.commands.register(id, title, async () => {
      const editor = await sable.editor.active();
      if (!editor) return sable.window.showError("Open a file first");
      const selected = editor.selection?.text ?? "";
      // The selection's lines, or the whole file without a selection. A
      // trailing newline stays where it was.
      const text = selected || editor.text;
      const trailing = text.endsWith("\n") ? "\n" : "";
      const lines = (trailing ? text.slice(0, -1) : text).split("\n");
      const result = transform(lines).join("\n") + trailing;
      if (selected) await sable.editor.replaceSelection(result);
      else await sable.editor.setText(result);
      await sable.window.showMessage(`${title}: ${lines.length} line${lines.length === 1 ? "" : "s"}`);
    });
  }
}
