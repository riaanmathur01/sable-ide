// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** The bookmark after `line`, wrapping to the first; null if there are none. */
function nextBookmark(lines, line) {
  return lines.find((candidate) => candidate > line) ?? lines[0] ?? null;
}

/** The bookmark before `line`, wrapping to the last; null if there are none. */
function previousBookmark(lines, line) {
  return [...lines].reverse().find((candidate) => candidate < line) ?? lines.at(-1) ?? null;
}

/** `lines` with `line` added, or removed if it was there; sorted. */
function toggleLine(lines, line) {
  return lines.includes(line) ? lines.filter((candidate) => candidate !== line) : [...lines, line].sort((a, b) => a - b);
}

/** "/home/me/project/src/app.js" → "src/app.js" when the folder is /home/me/project. */
function relativePath(path, root) {
  if (root && path.startsWith(root)) return path.slice(root.length).replace(/^[/\\]/, "");
  return path;
}

/** The line's whole text as a range, to select it. */
const lineRange = (line, text) => ({ start: { line, column: 1 }, end: { line, column: text.length + 1 } });

/** @param {Sable} sable */
export async function activate(sable) {
  // Bookmarks are stored per file, keyed by the file's absolute path: a sorted list of line numbers.
  /** @returns {Promise<number[]>} */
  const load = async (path) => (await sable.storage.get(path)) ?? [];
  const save = (path, lines) => sable.storage.set(path, lines.length ? lines : null);

  const render = async () => {
    const editor = await sable.editor.active();
    const lines = editor ? await load(editor.path) : [];
    if (!lines.length) return sable.statusBar.clear();
    await sable.statusBar.set(`🔖 ${lines.length}`, {
      tooltip: `Bookmarks on line${lines.length === 1 ? "" : "s"} ${lines.join(", ")} — click for the next one`,
      command: "next",
    });
  };

  /** The open file, its bookmarks and the cursor's line; or null (with a message). */
  const context = async () => {
    const editor = await sable.editor.active();
    if (!editor) {
      await sable.window.showError("Open a file first");
      return null;
    }
    const textLines = editor.text.split(/\r?\n/);
    // Bookmarks don't move with edits, so skip any now past the end of the file.
    const lines = (await load(editor.path)).filter((line) => line <= textLines.length);
    return { editor, lines, line: editor.selection?.start.line ?? 1 };
  };

  const jump = async (direction) => {
    const current = await context();
    if (!current) return;
    const { lines, line } = current;
    const target = direction === "next" ? nextBookmark(lines, line) : previousBookmark(lines, line);
    if (target === null) return sable.window.showMessage("No bookmarks in this file — Toggle Bookmark adds one");
    await sable.editor.setSelection({ start: { line: target, column: 1 }, end: { line: target, column: 1 } });
    await sable.window.showMessage(`Bookmark ${lines.indexOf(target) + 1} of ${lines.length}: line ${target}`);
  };

  sable.commands.register("toggle", "Toggle Bookmark", async () => {
    const current = await context();
    if (!current) return;
    const { editor, line } = current;
    const before = await load(editor.path);
    const after = toggleLine(before, line);
    await save(editor.path, after);
    await render();
    await sable.window.showMessage(after.length > before.length ? `Bookmarked line ${line}` : `Removed the bookmark on line ${line}`);
  });

  sable.commands.register("next", "Next Bookmark", () => jump("next"));
  sable.commands.register("previous", "Previous Bookmark", () => jump("previous"));

  sable.commands.register("list", "List Bookmarks", async () => {
    const editor = await sable.editor.active();
    const items = [];
    for (const path of (await sable.storage.keys()).sort()) {
      // The open file's text includes unsaved edits; read the others from the folder.
      let textLines = null;
      try {
        textLines = (editor?.path === path ? editor.text : await sable.workspace.readFile(path)).split(/\r?\n/);
      } catch {
        // Deleted, or outside the open folder: list it without its text.
      }
      for (const line of await load(path)) {
        const text = textLines?.[line - 1];
        items.push({
          label: `${relativePath(path, sable.workspace.root)}:${line}`,
          description: text === undefined ? (textLines ? "(past the end of the file)" : "(can't read the file)") : text.trim(),
          path,
          line,
          text: text ?? "",
        });
      }
    }
    if (!items.length) return sable.window.showMessage("No bookmarks yet — Toggle Bookmark adds one");
    const choice = await sable.window.showQuickPick(items, { placeholder: `${items.length} bookmark${items.length === 1 ? "" : "s"} — choose one to open` });
    if (!choice) return;
    await sable.editor.open(choice.path, { line: choice.line });
    await sable.editor.setSelection(lineRange(choice.line, choice.text));
  });

  sable.commands.register("clear", "Clear Bookmarks in File", async () => {
    const editor = await sable.editor.active();
    if (!editor) return sable.window.showError("Open a file first");
    const count = (await load(editor.path)).length;
    await save(editor.path, []);
    await render();
    await sable.window.showMessage(count ? `Cleared ${count} bookmark${count === 1 ? "" : "s"}` : "This file has no bookmarks");
  });

  sable.events.onDidChangeActiveEditor(render);
  await render();
}
