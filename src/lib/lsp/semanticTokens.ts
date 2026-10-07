/**
 * Semantic tokens → Sable's own small set of highlight categories.
 *
 * Language servers classify every name (parameter, `self`, class,
 * builtin, …) with their own legends and modifiers. Rather than styling
 * each server's vocabulary per theme, tokens are mapped into a fixed set
 * of categories mirroring JetBrains' color keys (parameter, self
 * parameter, class/function declaration vs. reference, builtin, …).
 * Anything that doesn't map is dropped, so the TextMate grammar's colors
 * stay in charge of keywords, strings, operators and the rest — Monaco
 * would otherwise paint unmatched semantic tokens with the default color.
 *
 * Pure (no Monaco), so it's unit-tested with real server output.
 */

/** Sable's semantic categories. Themes style each (themes.ts `semantic`). */
export const SEMANTIC_CATEGORIES = [
  "sem-parameter",
  "sem-self",
  "sem-class-decl",
  "sem-class",
  "sem-type-param",
  "sem-function-decl",
  "sem-function-call",
  "sem-dunder-decl",
  "sem-builtin",
  "sem-decorator",
  "sem-property",
  "sem-property-static",
  "sem-enum-member",
] as const;

export type SemanticCategory = (typeof SEMANTIC_CATEGORIES)[number];

export interface ServerLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** Decide a token's category from its server type + modifiers. */
export function categorize(
  type: string,
  modifiers: string[],
  languageId: string,
  text: string,
): SemanticCategory | null {
  const has = (modifier: string) => modifiers.includes(modifier);
  const declared = has("declaration") || has("definition");
  const python = languageId === "python";
  // PyCharm styles Python builtins (print, len, int, …) as their own
  // thing; elsewhere "default library" calls are just calls.
  const builtin = python && (has("builtin") || has("defaultLibrary"));

  switch (type) {
    case "selfParameter":
    case "clsParameter":
      return "sem-self";
    case "parameter":
      return "sem-parameter";
    case "class":
    case "struct":
    case "interface":
    case "enum":
    case "type":
      if (builtin) return "sem-builtin";
      return declared ? "sem-class-decl" : "sem-class";
    case "typeParameter":
      return "sem-type-param";
    case "function":
    case "method":
    case "member": // TypeScript's name for methods
      if (builtin) return "sem-builtin";
      if (declared) {
        return python && /^__\w+__$/.test(text) ? "sem-dunder-decl" : "sem-function-decl";
      }
      return "sem-function-call";
    case "decorator":
      return "sem-decorator";
    case "property":
      // Python class attributes are flagged static, but PyCharm colors
      // them like instance attributes.
      return has("static") && !python ? "sem-property-static" : "sem-property";
    case "enumMember":
      return "sem-enum-member";
    default:
      // namespace, variable, keyword, string, number, operator, macro, …
      return null;
  }
}

/**
 * Re-encode a server's semantic token data (LSP's relative 5-tuples)
 * using Sable's category legend, dropping unmapped tokens. `lineText`
 * gives a line's content (for name-based rules like dunder methods).
 */
export function translateTokens(
  data: number[],
  legend: ServerLegend,
  languageId: string,
  lineText: (line: number) => string,
): number[] {
  const output: number[] = [];
  let line = 0;
  let start = 0;
  let previousLine = 0;
  let previousStart = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index];
    line += deltaLine;
    start = deltaLine === 0 ? start + data[index + 1] : data[index + 1];
    const length = data[index + 2];
    const type = legend.tokenTypes[data[index + 3]] ?? "";
    const modifierBits = data[index + 4];
    const modifiers = legend.tokenModifiers.filter((_, bit) => modifierBits & (1 << bit));
    const text = lineText(line).slice(start, start + length);
    const category = categorize(type, modifiers, languageId, text);
    if (!category) continue;
    output.push(
      line - previousLine,
      line === previousLine ? start - previousStart : start,
      length,
      SEMANTIC_CATEGORIES.indexOf(category),
      0,
    );
    previousLine = line;
    previousStart = start;
  }
  return output;
}
