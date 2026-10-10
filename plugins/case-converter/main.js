// @ts-check
/** @typedef {import("../sable").Sable} Sable */

/** "parseHTTPResponse_code-2" → ["parse", "HTTP", "Response", "code", "2"] */
function words(text) {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** @type {Record<string, [string, (text: string) => string]>} */
const CASES = {
  camel: ["camelCase", (t) => words(t).map((w, i) => (i ? capitalize(w) : w.toLowerCase())).join("")],
  pascal: ["PascalCase", (t) => words(t).map(capitalize).join("")],
  snake: ["snake_case", (t) => words(t).map((w) => w.toLowerCase()).join("_")],
  kebab: ["kebab-case", (t) => words(t).map((w) => w.toLowerCase()).join("-")],
  constant: ["CONSTANT_CASE", (t) => words(t).map((w) => w.toUpperCase()).join("_")],
  dot: ["dot.case", (t) => words(t).map((w) => w.toLowerCase()).join(".")],
  title: ["Title Case", (t) => t.replace(/\p{L}[\p{L}'’]*/gu, capitalize)],
  sentence: ["Sentence case", (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase())],
  upper: ["UPPERCASE", (t) => t.toUpperCase()],
  lower: ["lowercase", (t) => t.toLowerCase()],
};

/** `text` in case `id`. Identifier cases convert line by line, so a
 *  selected list converts item by item. */
function convertText(id, text) {
  const convert = CASES[id][1];
  if (["title", "sentence", "upper", "lower"].includes(id)) return convert(text);
  return text
    .split("\n")
    .map((line) => {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return line.trim() ? indent + convert(line.trim()) : line;
    })
    .join("\n");
}

/** Cases that make valid names in code, offered when renaming (F2). */
const NAME_CASES = ["camel", "pascal", "snake", "constant"];
/** Languages where kebab-case names are valid too. */
const KEBAB_LANGUAGES = new Set(["css", "scss", "less", "html"]);

/** @param {Sable} sable */
export function activate(sable) {
  // Under the rename box (F2 / ⇧F6): the symbol in the other cases.
  sable.languages.registerRenameSuggestions("*", ({ name, language }) => {
    const cases = KEBAB_LANGUAGES.has(language) ? [...NAME_CASES, "kebab"] : NAME_CASES;
    return [...new Set(cases.map((id) => convertText(id, name)))].filter((candidate) => candidate !== name);
  });

  const selection = async () => {
    const editor = await sable.editor.active();
    const selected = editor?.selection?.text;
    if (!selected) await sable.window.showError("Select the text to convert first");
    return selected || null;
  };

  // One command for all of them: pick a case, seeing what you'd get.
  sable.commands.register("convert", "Convert Case…", async () => {
    const selected = await selection();
    if (!selected) return;
    const sample = selected.split("\n")[0].slice(0, 60);
    const choice = await sable.window.showQuickPick(
      Object.entries(CASES).map(([id, [name]]) => ({ label: name, description: convertText(id, sample), id })),
      { placeholder: "Convert the selection to…" },
    );
    if (choice) await sable.editor.replaceSelection(convertText(choice.id, selected));
  });

  // And each case as its own command.
  for (const [id, [name]] of Object.entries(CASES)) {
    sable.commands.register(id, `Convert to ${name}`, async () => {
      const selected = await selection();
      if (selected) await sable.editor.replaceSelection(convertText(id, selected));
    });
  }
}
