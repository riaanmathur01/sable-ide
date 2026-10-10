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

/** @param {Sable} sable */
export function activate(sable) {
  for (const [id, [name, convert]] of Object.entries(CASES)) {
    sable.commands.register(id, `Convert to ${name}`, async () => {
      const editor = await sable.editor.active();
      const selected = editor?.selection?.text;
      if (!selected) return sable.window.showError("Select the text to convert first");
      // Each line on its own, so a selected list converts item by item.
      const isIdentifierCase = !["title", "sentence", "upper", "lower"].includes(id);
      const result = isIdentifierCase ? selected.split("\n").map((line) => {
        const indent = line.match(/^\s*/)?.[0] ?? "";
        return line.trim() ? indent + convert(line.trim()) : line;
      }).join("\n") : convert(selected);
      await sable.editor.replaceSelection(result);
    });
  }
}
