// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** Each site: its name and the search URL the query is appended to. */
const SITES = {
  google: ["Google", "https://www.google.com/search?q="],
  duckduckgo: ["DuckDuckGo", "https://duckduckgo.com/?q="],
  stackoverflow: ["Stack Overflow", "https://stackoverflow.com/search?q="],
  mdn: ["MDN", "https://developer.mozilla.org/en-US/search?q="],
  docsrs: ["docs.rs", "https://docs.rs/releases/search?query="],
  pypi: ["PyPI", "https://pypi.org/search/?q="],
  npm: ["npm", "https://www.npmjs.com/search?q="],
};

/** A site's search URL for `query`. */
const searchUrl = (id, query) => SITES[id][1] + encodeURIComponent(query);

/** Selected text as a search query: one line, trimmed, not too long. */
const toQuery = (text) => text.replace(/\s+/g, " ").trim().slice(0, 500);

/** The word (identifier) around a 1-based column of a line, or "". */
function wordAt(lineText, column) {
  const isWord = (char) => char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
  let start = column - 1;
  let end = column - 1;
  while (isWord(lineText[start - 1])) start--;
  while (isWord(lineText[end])) end++;
  return lineText.slice(start, end);
}

/** @param {Sable} sable */
export function activate(sable) {
  /** The selection, else the word at the cursor, else whatever the user types. */
  const query = async () => {
    const editor = await sable.editor.active();
    const selection = editor?.selection;
    let text = toQuery(selection?.text ?? "");
    if (!text && editor && selection) {
      const lineText = editor.text.split(/\r?\n/)[selection.start.line - 1] ?? "";
      text = wordAt(lineText, selection.start.column);
    }
    if (!text) text = toQuery((await sable.window.showInputBox({ prompt: "Search for" })) ?? "");
    return text || null;
  };

  const search = async (id, text) => sable.env.openExternal(searchUrl(id, text));

  for (const [id, [name]] of Object.entries(SITES)) {
    sable.commands.register(id, `Search ${name}`, async () => {
      const text = await query();
      if (text) await search(id, text);
    });
  }

  sable.commands.register("search", "Search the Web…", async () => {
    const text = await query();
    if (!text) return;
    const choice = await sable.window.showQuickPick(
      Object.entries(SITES).map(([id, [name]]) => ({ label: name, description: text.slice(0, 60), id })),
      { placeholder: `Search for “${text.slice(0, 60)}” on…` },
    );
    if (choice) await search(choice.id, text);
  });
}
