/**
 * Semantic tokens → what Sable highlights.
 *
 * Language servers classify names (parameter, `self`, field, builtin, …)
 * in their own vocabularies. Each token is mapped to:
 *   - a generic category (`sem-*`), which every theme styles, and
 *   - for the JetBrains themes, the exact JetBrains color key the IDE
 *     uses for that element in that language ("PY.SELF_PARAMETER",
 *     "org.rust.MUT_BINDING", "INSTANCE_FIELD_ATTRIBUTES", …).
 * Tokens that map to neither are dropped, so the TextMate grammar's
 * colors stay in charge of keywords, strings, operators and the rest —
 * Monaco would otherwise paint unmatched semantic tokens with the default
 * color.
 *
 * Pure (no Monaco), so it can be unit-tested with real server output.
 */

/** Sable's generic categories. Every theme styles each (themes.ts). */
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

/** One token's highlight: a generic category and/or a JetBrains key. */
export interface Classified {
  category: SemanticCategory | null;
  /** JetBrains key; "TEXT" means the default text color. */
  key: string | null;
}

interface Token {
  type: string;
  has: (modifier: string) => boolean;
  /** The token's text. */
  text: string;
  /** The whole line, for context (`def` before a property name, …). */
  line: string;
}

const result = (category: SemanticCategory | null, key: string | null): Classified | null =>
  category || key ? { category, key } : null;

const declared = (token: Token) => token.has("declaration") || token.has("definition");

// --- Python (basedpyright) — PyCharm keys --------------------------------------

function python(token: Token): Classified | null {
  const { type, has, text } = token;
  const builtin = has("builtin") || has("defaultLibrary");
  const dunder = /^__\w+__$/.test(text);
  switch (type) {
    case "selfParameter":
    case "clsParameter":
      return result("sem-self", "PY.SELF_PARAMETER");
    case "parameter":
      return result("sem-parameter", "PY.PARAMETER");
    case "class":
    case "enum":
    case "type":
    case "struct":
    case "interface":
      if (builtin) return result("sem-builtin", "PY.BUILTIN_NAME");
      return declared(token) ? result("sem-class-decl", "PY.CLASS_DEFINITION") : result("sem-class", "TEXT");
    case "typeParameter":
      return result("sem-type-param", "PY.TYPE_PARAMETER");
    case "function":
    case "method":
      if (builtin) return result("sem-builtin", "PY.BUILTIN_NAME");
      if (declared(token)) {
        return dunder
          ? result("sem-dunder-decl", "PY.PREDEFINED_DEFINITION")
          : result("sem-function-decl", "PY.FUNC_DEFINITION");
      }
      if (dunder) return result("sem-function-call", "PY.PREDEFINED_USAGE");
      return result("sem-function-call", type === "method" ? "PY.METHOD_CALL" : "PY.FUNCTION_CALL");
    case "decorator":
      return result("sem-decorator", "PY.DECORATOR");
    case "property":
      // `@property def size(self)` is a function definition to PyCharm.
      if (declared(token) && new RegExp(`\\bdef\\s+${text}\\b`).test(token.line)) {
        return result("sem-function-decl", "PY.FUNC_DEFINITION");
      }
      // PyCharm doesn't color attributes; class attributes are flagged
      // static but read like instance attributes.
      return result("sem-property", "TEXT");
    case "enumMember":
      return result("sem-enum-member", "TEXT");
    case "variable":
      return dunder ? result(null, "PY.PREDEFINED_USAGE") : null;
    default:
      return null;
  }
}

// --- TypeScript / JavaScript (typescript-language-server) — WebStorm keys -------

function script(token: Token, p: "TS" | "JS"): Classified | null {
  const { type, has } = token;
  const key = (name: string) => `${p}.${name}`;
  const ts = p === "TS";
  switch (type) {
    case "class":
      return result(declared(token) ? "sem-class-decl" : "sem-class", key("CLASS"));
    case "interface":
      return result("sem-class", key("INTERFACE"));
    case "enum":
      return result("sem-class", ts ? "TS.ENUM" : "JS.CLASS");
    case "type":
      return result("sem-class", ts ? "TS.TYPE.ALIAS" : "JS.TYPE_ALIAS");
    case "namespace":
      return result(null, key("MODULE_NAME"));
    case "typeParameter":
      return result("sem-type-param", ts ? "TS.TYPE_PARAMETER" : null);
    case "parameter":
      return result("sem-parameter", key("PARAMETER"));
    case "variable":
      return result(null, has("defaultLibrary") ? key("GLOBAL_VARIABLE") : key("LOCAL_VARIABLE"));
    case "enumMember":
      return result("sem-enum-member", ts ? "TS.ENUM_MEMBER" : key("STATIC_MEMBER_VARIABLE"));
    case "property":
      return has("static")
        ? result("sem-property-static", key("STATIC_MEMBER_VARIABLE"))
        : result("sem-property", key("INSTANCE_MEMBER_VARIABLE"));
    case "function":
      return result(
        declared(token) ? "sem-function-decl" : "sem-function-call",
        has("local") ? key("LOCAL_FUNCTION") : key("GLOBAL_FUNCTION"),
      );
    case "member":
    case "method":
      return result(
        declared(token) ? "sem-function-decl" : "sem-function-call",
        has("static") ? key("STATIC_MEMBER_FUNCTION") : key("INSTANCE_MEMBER_FUNCTION"),
      );
    default:
      return null;
  }
}

// --- Rust (rust-analyzer) — RustRover keys ---------------------------------------

function rust(token: Token): Classified | null {
  const { type, has } = token;
  const r = (name: string) => `org.rust.${name}`;
  const mutable = has("mutable");
  switch (type) {
    case "function":
      if (declared(token)) {
        return result(
          "sem-function-decl",
          has("associated") ? r(has("trait") ? "ASSOC_TRAIT_FUNCTION" : "ASSOC_FUNCTION") : r("FUNCTION"),
        );
      }
      return result(
        "sem-function-call",
        has("associated") ? r(has("trait") ? "ASSOC_TRAIT_FUNCTION_CALL" : "ASSOC_FUNCTION_CALL") : r("FUNCTION_CALL"),
      );
    case "method":
      if (declared(token)) return result("sem-function-decl", r(has("trait") ? "TRAIT_METHOD" : "METHOD"));
      return result("sem-function-call", r(has("trait") ? "TRAIT_METHOD_CALL" : "METHOD_CALL"));
    case "macro":
      return result(null, r("MACRO"));
    case "struct":
      return result(declared(token) ? "sem-class-decl" : "sem-class", r("STRUCT"));
    case "union":
      return result(declared(token) ? "sem-class-decl" : "sem-class", r("UNION"));
    case "enum":
      return result(declared(token) ? "sem-class-decl" : "sem-class", r("ENUM"));
    case "interface":
      return result(declared(token) ? "sem-class-decl" : "sem-class", r("TRAIT"));
    case "typeAlias":
      return result("sem-class", r("TYPE_ALIAS"));
    case "enumMember":
      return result("sem-enum-member", r("ENUM_VARIANT"));
    case "typeParameter":
      return result("sem-type-param", r("TYPE_PARAMETER"));
    case "constParameter":
      return result("sem-type-param", r("CONST_PARAMETER"));
    case "lifetime":
    case "label":
      return result(null, r("LIFETIME"));
    case "parameter":
      return result("sem-parameter", r(mutable ? "MUT_PARAMETER" : "PARAMETER"));
    case "selfKeyword":
      return result("sem-self", r(mutable ? "MUT_SELF_PARAMETER" : "SELF_PARAMETER"));
    case "selfTypeKeyword":
      return result(null, r("KEYWORD"));
    case "variable":
      return result(null, r(mutable ? "MUT_BINDING" : "VARIABLE"));
    case "property":
      return result("sem-property", r("FIELD"));
    case "const":
      return result(null, r("CONSTANT"));
    case "static":
      return result(null, r(mutable ? "MUT_STATIC" : "STATIC"));
    case "namespace":
      return result(null, r(has("crateRoot") ? "CRATE" : "MODULE"));
    case "builtinType":
      return result(null, r("PRIMITIVE_TYPE"));
    case "decorator":
    case "attribute":
    case "builtinAttribute":
    case "derive":
    case "attributeBracket":
      return result("sem-decorator", r("ATTRIBUTE"));
    case "formatSpecifier":
      return result(null, r("FORMAT_PARAMETER"));
    default:
      return null;
  }
}

// --- Go (gopls) — GoLand keys -------------------------------------------------

function go(token: Token): Classified | null {
  const { type, has, text } = token;
  const g = (name: string) => `GO_${name}`;
  // GoLand colors exported (capitalized) and package-local names apart.
  const exported = /^\p{Lu}/u.test(text);
  switch (type) {
    case "namespace":
      return result(null, g("PACKAGE"));
    case "type": {
      if (has("defaultLibrary")) return result(null, g("BUILTIN_TYPE_REFERENCE"));
      const kind = has("interface") ? "INTERFACE" : has("struct") ? "STRUCT" : null;
      if (declared(token)) {
        return result(
          "sem-class-decl",
          kind ? g(`PACKAGE_${exported ? "EXPORTED" : "LOCAL"}_${kind}`) : g("TYPE_SPECIFICATION"),
        );
      }
      return result("sem-class", kind ? g(`${exported ? "EXPORTED" : "LOCAL"}_${kind}_REFERENCE`) : g("TYPE_REFERENCE"));
    }
    case "typeParameter":
      return result("sem-type-param", null);
    case "parameter":
      return result("sem-parameter", g("FUNCTION_PARAMETER"));
    case "variable":
      if (has("defaultLibrary")) return result(null, g("BUILTIN_CONSTANT"));
      if (has("readonly")) return result(null, g(exported ? "PACKAGE_EXPORTED_CONSTANT" : "LOCAL_CONSTANT"));
      return result(null, g("LOCAL_VARIABLE"));
    case "function":
    case "method":
      if (has("defaultLibrary") && type === "function") return result("sem-function-call", g("BUILTIN_FUNCTION_CALL"));
      if (declared(token)) return result("sem-function-decl", g(exported ? "EXPORTED_FUNCTION" : "LOCAL_FUNCTION"));
      return result("sem-function-call", g(exported ? "EXPORTED_FUNCTION_CALL" : "LOCAL_FUNCTION_CALL"));
    case "property":
      return result("sem-property", g(exported ? "STRUCT_EXPORTED_MEMBER" : "STRUCT_LOCAL_MEMBER"));
    case "label":
      return result(null, g("LABEL"));
    default:
      return null;
  }
}

// --- C / C++ (clangd) — CLion keys ----------------------------------------------

function native(token: Token): Classified | null {
  const { type, has } = token;
  switch (type) {
    case "variable":
      if (has("classScope")) return result("sem-property", "OC.STRUCT_FIELD");
      if ((has("globalScope") || has("fileScope")) && !has("functionScope")) return result(null, "OC.GLOBAL_VARIABLE");
      return result(null, "OC.LOCAL_VARIABLE");
    case "parameter":
      return result("sem-parameter", "OC.PARAMETER");
    case "function":
    case "method":
      return declared(token)
        ? result("sem-function-decl", "OC.FUNCTION_DECLARATION")
        : result("sem-function-call", "OC.FUNCTION");
    case "property":
      return result("sem-property", "OC.STRUCT_FIELD");
    case "class":
    case "interface":
    case "enum":
      if (has("deduced")) return result(null, "OC.KEYWORD"); // `auto`
      if (has("constructorOrDestructor") && declared(token)) {
        return result("sem-function-decl", "OC.FUNCTION_DECLARATION");
      }
      return result(declared(token) ? "sem-class-decl" : "sem-class", "OC.STRUCT_LIKE");
    case "type":
      if (has("deduced")) return result(null, "OC.KEYWORD");
      return result("sem-class", "OC.TYPEDEF");
    case "enumMember":
      return result("sem-enum-member", "OC.ENUM_CONST");
    case "typeParameter":
      return result("sem-type-param", "OC.TEMPLATE_TYPE");
    case "concept":
      return result(null, "OC.CONCEPT");
    case "namespace":
      return result(null, "OC.NAMESPACE_LIKE");
    case "macro":
      return result(null, "OC.MACRONAME");
    case "operator":
      return has("userDefined") ? result(null, "OC.OVERLOADED_OPERATOR") : null;
    default:
      return null;
  }
}

// --- Java (jdtls) — IntelliJ IDEA keys ----------------------------------------

function java(token: Token): Classified | null {
  const { type, has } = token;
  switch (type) {
    case "class":
    case "record":
      // jdtls reports constructor names as the class.
      if (has("constructor")) {
        return declared(token)
          ? result("sem-function-decl", "CONSTRUCTOR_DECLARATION_ATTRIBUTES")
          : result("sem-function-call", "CONSTRUCTOR_CALL_ATTRIBUTES");
      }
      return result(
        declared(token) ? "sem-class-decl" : "sem-class",
        has("abstract") ? "ABSTRACT_CLASS_NAME_ATTRIBUTES" : "CLASS_NAME_ATTRIBUTES",
      );
    case "interface":
      return result("sem-class", "INTERFACE_NAME_ATTRIBUTES");
    case "enum":
      return result("sem-class", "ENUM_NAME_ATTRIBUTES");
    case "annotation":
      return result("sem-decorator", "ANNOTATION_NAME_ATTRIBUTES");
    case "annotationMember":
      return result(null, "ANNOTATION_ATTRIBUTE_NAME_ATTRIBUTES");
    case "typeParameter":
      return result("sem-type-param", "TYPE_PARAMETER_NAME_ATTRIBUTES");
    case "method":
      if (declared(token)) {
        return result(
          "sem-function-decl",
          has("constructor") ? "CONSTRUCTOR_DECLARATION_ATTRIBUTES" : "METHOD_DECLARATION_ATTRIBUTES",
        );
      }
      if (has("static")) return result("sem-function-call", "STATIC_METHOD_ATTRIBUTES");
      return result("sem-function-call", has("constructor") ? "CONSTRUCTOR_CALL_ATTRIBUTES" : "METHOD_CALL_ATTRIBUTES");
    case "property":
      if (has("static")) {
        return result(
          "sem-property-static",
          has("readonly") ? "STATIC_FINAL_FIELD_ATTRIBUTES" : "STATIC_FIELD_ATTRIBUTES",
        );
      }
      return result("sem-property", has("readonly") ? "INSTANCE_FINAL_FIELD_ATTRIBUTES" : "INSTANCE_FIELD_ATTRIBUTES");
    case "enumMember":
      return result("sem-enum-member", "STATIC_FINAL_FIELD_ATTRIBUTES");
    case "recordComponent":
      return result("sem-property", "RECORD_COMPONENT_ATTRIBUTES");
    case "parameter":
      return result("sem-parameter", "PARAMETER_ATTRIBUTES");
    case "variable":
      return result(null, "LOCAL_VARIABLE_ATTRIBUTES");
    case "namespace":
      return result(null, "TEXT");
    default:
      return null;
  }
}

/** Classify one token from its server type + modifiers. */
export function classify(
  type: string,
  modifiers: string[],
  languageId: string,
  text: string,
  line = "",
): Classified | null {
  const token: Token = { type, has: (modifier) => modifiers.includes(modifier), text, line };
  switch (languageId) {
    case "python":
      return python(token);
    case "typescript":
      return script(token, "TS");
    case "javascript":
      return script(token, "JS");
    case "rust":
      return rust(token);
    case "go":
      return go(token);
    case "c":
    case "cpp":
      return native(token);
    case "java":
      return java(token);
    default:
      return null;
  }
}

/** Monaco token type for a JetBrains key (keys contain dots/spaces). */
export function jetbrainsTokenType(key: string): string {
  return `jb.${key.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * Every token type the translator can emit: the categories plus one per
 * JetBrains key (pass the scheme's keys). Monaco needs the legend up
 * front; a classified key the schemes don't define is dropped.
 */
export function semanticTokenTypes(jetbrainsKeys: Iterable<string>): string[] {
  return [...SEMANTIC_CATEGORIES, ...[...new Set(jetbrainsKeys)].map(jetbrainsTokenType)];
}

/**
 * Re-encode a server's semantic token data (LSP's relative 5-tuples)
 * using Sable's legend (`tokenTypes`, from semanticTokenTypes), dropping
 * unmapped tokens. With `jetbrains`, tokens with a JetBrains key use it;
 * otherwise only categories are emitted. `lineText` gives a line's text.
 */
export function translateTokens(
  data: number[],
  legend: ServerLegend,
  languageId: string,
  lineText: (line: number) => string,
  tokenTypes: string[],
  jetbrains: boolean,
): number[] {
  const index = new Map(tokenTypes.map((type, position) => [type, position]));
  const output: number[] = [];
  let line = 0;
  let start = 0;
  let previousLine = 0;
  let previousStart = 0;
  for (let offset = 0; offset + 4 < data.length; offset += 5) {
    const deltaLine = data[offset];
    line += deltaLine;
    start = deltaLine === 0 ? start + data[offset + 1] : data[offset + 1];
    const length = data[offset + 2];
    const type = legend.tokenTypes[data[offset + 3]] ?? "";
    const modifierBits = data[offset + 4];
    const modifiers = legend.tokenModifiers.filter((_, bit) => modifierBits & (1 << bit));
    const content = lineText(line);
    const classified = classify(type, modifiers, languageId, content.slice(start, start + length), content);
    if (!classified) continue;
    const tokenType =
      jetbrains && classified.key ? jetbrainsTokenType(classified.key) : classified.category;
    const position = tokenType ? index.get(tokenType) : undefined;
    if (position === undefined) continue;
    output.push(
      line - previousLine,
      line === previousLine ? start - previousStart : start,
      length,
      position,
      0,
    );
    previousLine = line;
    previousStart = start;
  }
  return output;
}
