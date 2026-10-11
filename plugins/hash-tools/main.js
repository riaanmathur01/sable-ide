// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Command id → [name, Web Crypto algorithm]. */
/** @type {Record<string, [string, string]>} */
const ALGORITHMS = {
  sha1: ["SHA-1", "SHA-1"],
  sha256: ["SHA-256", "SHA-256"],
  sha384: ["SHA-384", "SHA-384"],
  sha512: ["SHA-512", "SHA-512"],
};

/** The lowercase hex digest of `text`'s UTF-8 bytes. */
async function hash(algorithm, text) {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {Sable} sable */
export function activate(sable) {
  /** The text to hash: the selection, or the whole file. */
  const source = async () => {
    const editor = await sable.editor.active();
    if (!editor) {
      await sable.window.showError("Open a file first");
      return null;
    }
    const selected = editor.selection?.text ?? "";
    return { text: selected || editor.text, selected: Boolean(selected) };
  };

  // One command per algorithm: the selection becomes its digest. With
  // nothing selected, the whole file's digest goes in at the cursor.
  for (const [id, [name, algorithm]] of Object.entries(ALGORITHMS)) {
    sable.commands.register(id, `${name} (Replace Selection)`, async () => {
      const input = await source();
      if (!input) return;
      const digest = await hash(algorithm, input.text);
      await sable.editor.replaceSelection(digest);
      if (!input.selected) await sable.window.showMessage(`Inserted the file's ${name}`);
    });
  }

  // Every digest at once; the chosen one goes to the clipboard.
  sable.commands.register("copy", "Copy Hash…", async () => {
    const input = await source();
    if (!input) return;
    const items = await Promise.all(
      Object.values(ALGORITHMS).map(async ([name, algorithm]) => ({ label: name, description: await hash(algorithm, input.text) })),
    );
    const choice = await sable.window.showQuickPick(items, {
      placeholder: input.selected ? "Copy the selection's hash…" : "Copy the file's hash…",
    });
    if (!choice) return;
    await sable.env.clipboard.writeText(choice.description);
    await sable.window.showMessage(`Copied the ${choice.label} hash`);
  });
}
