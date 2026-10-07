/**
 * Which JetBrains color key each TextMate scope gets.
 *
 * Three layers, from least to most specific:
 *
 *   1. TEXTMATE_DEFAULTS — IntelliJ's own table for TextMate-highlighted
 *      files (TextMateDefaultColorsProvider + TextMateTheme in the
 *      TextMate plugin, extracted from the IDE). This is literally how a
 *      JetBrains IDE colors a language it has no native support for.
 *   2. Per language, the same table again but restricted to that
 *      language's files and with each "language default" swapped for the
 *      language's own key (DEFAULT_KEYWORD → PY.KEYWORD, …). JetBrains
 *      languages can override defaults (Ruby comments, Go calls, …).
 *   3. Per language, rules for the language's own constructs: `self`,
 *      decorators, builtins, struct fields, lifetimes, …
 *
 * Layer 3 selectors carry the grammar's language suffix (`.python`,
 * `.tsx`, …), so they're more specific than layers 1–2 and only touch
 * their language — and still apply where the language is embedded (CSS in
 * HTML, JS in Markdown).
 *
 * Semantic tokens from language servers refine this further (see
 * semantic.ts): TextMate can't tell a parameter from a local, or a
 * declaration from a call in every grammar.
 */

/** [TextMate selector (may include parent scopes), JetBrains key]. */
export type ScopeRule = readonly [selector: string, key: string];

export const TEXTMATE_DEFAULTS: ScopeRule[] = [
  // TextMateDefaultColorsProvider
  ["comment", "DEFAULT_LINE_COMMENT"],
  ["comment.line", "DEFAULT_LINE_COMMENT"],
  ["comment.block", "DEFAULT_BLOCK_COMMENT"],
  ["comment.documentation", "DEFAULT_DOC_COMMENT"],
  ["constant", "DEFAULT_CONSTANT"],
  ["constant.number", "DEFAULT_NUMBER"],
  ["constant.numeric", "DEFAULT_NUMBER"],
  ["constant.character.escape", "DEFAULT_VALID_STRING_ESCAPE"],
  ["constant.character.entity", "DEFAULT_MARKUP_ENTITY"],
  ["invalid", "BAD_CHARACTER"],
  ["invalid.deprecated", "DEPRECATED_ATTRIBUTES"],
  ["keyword", "DEFAULT_KEYWORD"],
  ["keyword.operator", "DEFAULT_OPERATION_SIGN"],
  ["storage", "DEFAULT_KEYWORD"],
  ["storage.type", "DEFAULT_KEYWORD"],
  ["string", "DEFAULT_STRING"],
  ["variable", "DEFAULT_LOCAL_VARIABLE"],
  ["variable.parameter", "DEFAULT_PARAMETER"],
  ["entity", "DEFAULT_IDENTIFIER"],
  ["entity.name", "DEFAULT_CLASS_NAME"],
  ["entity.name.class", "DEFAULT_CLASS_NAME"],
  ["entity.name.function", "DEFAULT_FUNCTION_DECLARATION"],
  ["entity.other.attribute-name", "DEFAULT_MARKUP_ATTRIBUTE"],
  ["punctuation", "DEFAULT_DOT"],
  ["punctuation.definition.tag", "DEFAULT_MARKUP_TAG"],
  ["support.function", "DEFAULT_FUNCTION_CALL"],
  ["support.type", "DEFAULT_PREDEFINED_SYMBOL"],
  ["meta.tag", "DEFAULT_METADATA"],
  // TextMateTheme (Java)
  ["comment.block.javadoc.java", "DEFAULT_DOC_COMMENT"],
  ["comment.block.java punctuation.definition.comment.java", "DEFAULT_BLOCK_COMMENT"],
  ["comment.block.javadoc.java punctuation.definition.comment.java", "DEFAULT_DOC_COMMENT"],
  ["keyword.other.documentation.javadoc.java", "DEFAULT_DOC_COMMENT_TAG"],
  ["meta.declaration.annotation.java punctuation.definition.annotation.java", "DEFAULT_METADATA"],
  ["storage.type.annotation.java", "DEFAULT_METADATA"],
  ["storage.type.java", "DEFAULT_CLASS_NAME"],
  ["storage.type.object.array.java", "DEFAULT_CLASS_NAME"],
  ["meta.method-call.java entity.name.function.java", "DEFAULT_FUNCTION_CALL"],
  ["meta.function-call.java entity.name.function.java", "DEFAULT_FUNCTION_CALL"],
  ["meta.class.body.java meta.definition.variable.java variable.other.definition.java", "DEFAULT_INSTANCE_FIELD"],
  ["meta.method.body.java meta.definition.variable.java variable.other.definition.java", "DEFAULT_LOCAL_VARIABLE"],
  ["meta.package.java storage.modifier.package.java", "DEFAULT_IDENTIFIER"],
  ["meta.import.java storage.modifier.import.java", "DEFAULT_IDENTIFIER"],
  ["punctuation.definition.string.begin.java", "DEFAULT_STRING"],
  ["punctuation.definition.string.end.java", "DEFAULT_STRING"],
  // TextMateTheme (named keys)
  ["entity.other.attribute-name.localname.xml", "XML_ATTRIBUTE_NAME"],
  ["entity.name.tag.xml", "XML_TAG_NAME"],
  ["comment.block.html", "HTML_COMMENT"],
  ["entity.name.tag", "HTML_TAG_NAME"],
  ["entity.other.attribute-name.html", "HTML_ATTRIBUTE_NAME"],
  ["entity.name.function.decorator", "PY.DECORATOR"],
  ["entity.other.attribute-name.class.css", "CSS.IDENT"],
  ["comment.block.css", "CSS.COMMENT"],
  ["support.type.property-name", "CSS.PROPERTY_NAME"],
  ["meta.property-value.css", "CSS.PROPERTY_VALUE"],
  ["entity.name.tag.css", "CSS.TAG_NAME"],
  ["constant.numeric.css", "CSS.NUMBER"],
  ["support.function.misc.css", "CSS.FUNCTION"],
  ["variable.parameter.misc.css", "CSS.URL"],
  ["variable.other.less", "LESS_VARIABLE"],
  ["variable.parameter.sass", "SASS_VARIABLE"],
  ["string.quoted.double.css", "SASS_STRING"],
  ["keyword.control.at-rule.css", "SASS_KEYWORD"],
  ["support.type.property-name.css", "SASS_PROPERTY_NAME"],
  ["meta.selector.css entity.name.tag", "SASS_TAG_NAME"],
  ["support.constant.property-value.css", "SASS_FUNCTION"],
  ["entity.other.attribute-name.tag", "SASS_MIXIN"],
  ["string.regexp", "JS.REGEXP"],
  ["comment.line.number-sign.yaml", "YAML_COMMENT"],
  ["entity.name.tag.yaml", "YAML_SCALAR_KEY"],
  ["string.unquoted.block.yaml", "YAML_SCALAR_VALUE"],
  ["string.quoted.single.yaml", "YAML_SCALAR_STRING"],
  ["string.quoted.double.yaml", "YAML_SCALAR_DSTRING"],
  ["string.unquoted.yaml", "YAML_TEXT"],
  ["punctuation.definition.string.begin.ruby", "RUBY_HEREDOC_ID"],
  ["string.unquoted.heredoc.ruby", "RUBY_HEREDOC_CONTENT"],
  ["string.quoted.single.ruby", "RUBY_STRING"],
  ["string.quoted.double.ruby", "RUBY_INTERPOLATED_STRING"],
  ["string.quoted.other.literal.upper.ruby", "RUBY_WORDS"],
  ["entity.name.type.class.ruby", "RUBY_CONSTANT_DECLARATION"],
  ["variable.other.readwrite.global", "RUBY_GVAR"],
  ["variable.other.readwrite.class", "RUBY_CVAR"],
  ["variable.other.readwrite.instance", "RUBY_IVAR"],
  ["punctuation.separator.object", "RUBY_COMMA"],
  ["punctuation.separator.method", "RUBY_DOT"],
  ["punctuation.separator.statement", "RUBY_SEMICOLON"],
  ["punctuation.separator.key-value", "RUBY_HASH_ASSOC"],
  ["constant.other.symbol", "RUBY_SYMBOL"],
  ["keyword.other.directive", "OC.DIRECTIVE"],
  ["variable.language.objc", "OC.SELFSUPERTHIS"],
  ["variable.parameter.function.objc", "OC.PARAMETER"],
];

export interface LanguageColors {
  /** The grammar's root scope (layer 2 rules are restricted to it). */
  root: string;
  /** DEFAULT_* key (without the prefix) → the language's own key. */
  defaults: Record<string, string>;
  /** Language-specific rules (layer 3). */
  rules: ScopeRule[];
}

/** Expand `[[a, b], key]` shorthand into one rule per selector. */
function rules(entries: [string | string[], string][]): ScopeRule[] {
  return entries.flatMap(([selectors, key]) =>
    (Array.isArray(selectors) ? selectors : [selectors]).map((selector) => [selector, key] as const),
  );
}

/** Grammar root scope for each language suffix used below. */
const ROOTS: Record<string, string> = {
  python: "source.python",
  tsx: "source.tsx",
  // Also matches JS embedded in HTML/Markdown (`source.js`).
  js: "source.js",
  java: "source.java",
  kotlin: "source.kotlin",
  go: "source.go",
  rust: "source.rust",
  c: "source.c",
  cpp: "source.cpp",
  cs: "source.cs",
  php: "source.php",
  ruby: "source.ruby",
  // Also matches SCSS (`source.css.scss`) and CSS embedded in HTML.
  css: "source.css",
  scss: "source.css.scss",
  html: "text.html.basic",
  xml: "text.xml",
  json: "source.json",
  yaml: "source.yaml",
  markdown: "text.html.markdown",
  sql: "source.sql",
  shell: "source.shell",
};

/**
 * Each selector restricted to one language's files (`source.go keyword`).
 * Restricting by root rather than by the scope's language suffix copes
 * with grammars that insert segments (`constant.language.null.tsx`).
 */
function suffixed(language: string, selectors: string[]): string[] {
  return selectors.map((selector) => `${ROOTS[language]} ${selector}`);
}

// --- Python (PyCharm) -------------------------------------------------------

const PYTHON: LanguageColors = {
  root: "source.python",
  defaults: {
    KEYWORD: "PY.KEYWORD",
    STRING: "PY.STRING.U",
    NUMBER: "PY.NUMBER",
    LINE_COMMENT: "PY.LINE_COMMENT",
    BLOCK_COMMENT: "PY.LINE_COMMENT",
    DOC_COMMENT: "PY.DOC_COMMENT",
    VALID_STRING_ESCAPE: "PY.VALID_STRING_ESCAPE",
    OPERATION_SIGN: "PY.OPERATION_SIGN",
    DOT: "PY.DOT",
    FUNCTION_DECLARATION: "PY.FUNC_DEFINITION",
    FUNCTION_CALL: "PY.FUNCTION_CALL",
    PARAMETER: "PY.PARAMETER",
    LOCAL_VARIABLE: "PY.LOCAL_VARIABLE",
    CLASS_NAME: "PY.CLASS_DEFINITION",
    PREDEFINED_SYMBOL: "PY.BUILTIN_NAME",
    METADATA: "PY.DECORATOR",
    COMMA: "PY.COMMA",
    PARENTHS: "PY.PARENTHS",
    BRACKETS: "PY.BRACKETS",
    BRACES: "PY.BRACES",
  },
  rules: rules([
    [suffixed("python", ["constant.language", "keyword.operator.logical", "keyword.illegal.name"]), "PY.KEYWORD"],
    [
      [
        "source.python string.quoted.docstring",
        "source.python string.quoted.docstring punctuation.definition.string",
        "comment.block.documentation.python",
      ],
      "PY.DOC_COMMENT",
    ],
    // String prefixes (f, r, b) are part of the literal.
    [suffixed("python", ["storage.type.string", "string.quoted.raw"]), "PY.STRING.U"],
    [suffixed("python", ["string.quoted.binary"]), "PY.STRING.B"],
    [suffixed("python", ["storage.type.number"]), "PY.NUMBER"],
    [suffixed("python", ["constant.character.format.placeholder.other"]), "PY.FSTRING_FRAGMENT_BRACES"],
    [suffixed("python", ["storage.type.format"]), "PY.FSTRING_FRAGMENT_COLON"],
    [
      suffixed("python", [
        "entity.name.function.decorator",
        "punctuation.definition.decorator",
        "meta.function.decorator support.type",
        "meta.function.decorator support.function.builtin",
        "meta.function.decorator variable.language.special",
      ]),
      "PY.DECORATOR",
    ],
    [suffixed("python", ["support.function.builtin", "support.type", "support.type.exception"]), "PY.BUILTIN_NAME"],
    [suffixed("python", ["support.function.magic"]), "PY.PREDEFINED_DEFINITION"],
    [suffixed("python", ["support.variable.magic"]), "PY.PREDEFINED_USAGE"],
    [
      suffixed("python", [
        "variable.language.special.self",
        "variable.language.special.cls",
        "variable.parameter.function.language.special.self",
        "variable.parameter.function.language.special.cls",
      ]),
      "PY.SELF_PARAMETER",
    ],
    [suffixed("python", ["variable.parameter.function.language"]), "PY.PARAMETER"],
    [suffixed("python", ["variable.parameter.function-call"]), "PY.KEYWORD_ARGUMENT"],
    [suffixed("python", ["meta.function-call.generic"]), "PY.FUNCTION_CALL"],
    [suffixed("python", ["entity.name.type.class"]), "PY.CLASS_DEFINITION"],
    [suffixed("python", ["entity.other.inherited-class", "meta.attribute"]), "DEFAULT_IDENTIFIER"],
  ]),
};

// --- JavaScript / TypeScript (WebStorm) -------------------------------------

/** JS and TS share structure; TS keys fall back to JS ones. */
function scriptColors(root: string, suffix: string, p: "JS" | "TS"): LanguageColors {
  const key = (name: string) => `${p}.${name}`;
  const ts = p === "TS";
  return {
    root,
    defaults: {
      KEYWORD: key("KEYWORD"),
      STRING: key("STRING"),
      NUMBER: key("NUMBER"),
      LINE_COMMENT: key("LINE_COMMENT"),
      BLOCK_COMMENT: key("BLOCK_COMMENT"),
      DOC_COMMENT: key("DOC_COMMENT"),
      VALID_STRING_ESCAPE: key("VALID_STRING_ESCAPE"),
      OPERATION_SIGN: key("OPERATION_SIGN"),
      DOT: key("DOT"),
      FUNCTION_DECLARATION: key("GLOBAL_FUNCTION"),
      FUNCTION_CALL: key("GLOBAL_FUNCTION"),
      PARAMETER: key("PARAMETER"),
      LOCAL_VARIABLE: key("LOCAL_VARIABLE"),
      CLASS_NAME: key("CLASS"),
      CONSTANT: key("LOCAL_VARIABLE"),
      COMMA: key("COMMA"),
      SEMICOLON: key("SEMICOLON"),
      PARENTHS: key("PARENTHS"),
      BRACKETS: key("BRACKETS"),
      BRACES: key("BRACES"),
    },
    rules: rules([
      [
        suffixed(suffix, [
          "constant.language",
          "variable.language.this",
          "variable.language.super",
          "keyword.operator.new",
          "keyword.operator.expression",
          "storage.type.function",
        ]),
        key("KEYWORD"),
      ],
      [suffixed(suffix, ["storage.type.function.arrow"]), key("FUNCTION_ARROW")],
      [suffixed(suffix, ["support.type.primitive", "support.type.builtin"]), ts ? "TS.PRIMITIVE.TYPES" : "JS.PRIMITIVE.TYPE"],
      [suffixed(suffix, ["semicolon", "punctuation.terminator.statement"]), key("SEMICOLON")],
      [suffixed(suffix, ["punctuation.separator.comma", "punctuation.separator.parameter"]), key("COMMA")],
      [suffixed(suffix, ["meta.brace.round"]), key("PARENTHS")],
      [suffixed(suffix, ["meta.brace.square"]), key("BRACKETS")],
      [suffixed(suffix, ["punctuation.definition.block"]), key("BRACES")],
      [
        suffixed(suffix, ["string.regexp", "string.regexp punctuation.definition.string", "keyword.other"]),
        key("REGEXP"),
      ],
      [suffixed(suffix, ["comment.block.documentation"]), key("DOC_COMMENT")],
      [["storage.type.class.jsdoc", "punctuation.definition.block.tag.jsdoc"], key("DOC_TAG")],
      [["variable.other.jsdoc"], key("DOC_TAG_NAMEPATH")],
      [["entity.name.type.instance.jsdoc"], key("DOC_TYPE")],
      [
        suffixed(suffix, [
          "punctuation.definition.template-expression.begin",
          "punctuation.definition.template-expression.end",
        ]),
        key("TEMPLATE_LITERAL_PLACEHOLDER_DELIMITERS"),
      ],
      [suffixed(suffix, ["meta.template.expression"]), key("LOCAL_VARIABLE")],
      [suffixed(suffix, ["entity.name.function", "support.function"]), key("GLOBAL_FUNCTION")],
      [
        suffixed(suffix, ["meta.definition.method entity.name.function", "meta.method.declaration entity.name.function"]),
        key("INSTANCE_MEMBER_FUNCTION"),
      ],
      [
        suffixed(suffix, ["meta.decorator", "punctuation.decorator", "meta.decorator entity.name.function"]),
        key("DECORATOR"),
      ],
      [suffixed(suffix, ["entity.name.type.class", "entity.other.inherited-class", "entity.name.type"]), key("CLASS")],
      [suffixed(suffix, ["entity.name.type.interface"]), ts ? "TS.INTERFACE" : "JS.INTERFACE"],
      [suffixed(suffix, ["entity.name.type.enum"]), ts ? "TS.ENUM" : "JS.CLASS"],
      [suffixed(suffix, ["entity.name.type.alias"]), ts ? "TS.TYPE.ALIAS" : "JS.TYPE_ALIAS"],
      [
        suffixed(suffix, ["meta.type.parameters entity.name.type"]),
        ts ? "TS.TYPE_PARAMETER" : "JS.CLASS",
      ],
      [suffixed(suffix, ["entity.name.type.module", "entity.name.type.namespace"]), ts ? "TS.MODULE_NAME" : "JS.MODULE_NAME"],
      [suffixed(suffix, ["variable.other.enummember"]), ts ? "TS.ENUM_MEMBER" : "JS.STATIC_MEMBER_VARIABLE"],
      [
        suffixed(suffix, [
          "variable.other.property",
          "variable.object.property",
          "meta.object-literal.key",
          "support.variable.property",
        ]),
        key("INSTANCE_MEMBER_VARIABLE"),
      ],
      [suffixed(suffix, ["variable.other.constant.property"]), key("STATIC_MEMBER_VARIABLE")],
      [suffixed(suffix, ["variable.parameter"]), key("PARAMETER")],
      // JSX: tags as markup.
      [suffixed(suffix, ["support.class.component"]), "HTML_TAG_NAME"],
    ]),
  };
}

// --- Java (IntelliJ IDEA) ---------------------------------------------------

const JAVA: LanguageColors = {
  root: "source.java",
  defaults: {
    KEYWORD: "JAVA_KEYWORD",
    STRING: "JAVA_STRING",
    NUMBER: "JAVA_NUMBER",
    LINE_COMMENT: "JAVA_LINE_COMMENT",
    BLOCK_COMMENT: "JAVA_BLOCK_COMMENT",
    DOC_COMMENT: "JAVA_DOC_COMMENT",
    DOC_COMMENT_TAG: "JAVA_DOC_TAG",
    VALID_STRING_ESCAPE: "JAVA_VALID_STRING_ESCAPE",
    OPERATION_SIGN: "JAVA_OPERATION_SIGN",
    DOT: "JAVA_DOT",
    FUNCTION_DECLARATION: "METHOD_DECLARATION_ATTRIBUTES",
    FUNCTION_CALL: "METHOD_CALL_ATTRIBUTES",
    PARAMETER: "PARAMETER_ATTRIBUTES",
    LOCAL_VARIABLE: "LOCAL_VARIABLE_ATTRIBUTES",
    CLASS_NAME: "CLASS_NAME_ATTRIBUTES",
    INSTANCE_FIELD: "INSTANCE_FIELD_ATTRIBUTES",
    METADATA: "ANNOTATION_NAME_ATTRIBUTES",
    CONSTANT: "STATIC_FINAL_FIELD_ATTRIBUTES",
    COMMA: "JAVA_COMMA",
    SEMICOLON: "JAVA_SEMICOLON",
    PARENTHS: "JAVA_PARENTH",
    BRACKETS: "JAVA_BRACKETS",
    BRACES: "JAVA_BRACES",
  },
  rules: rules([
    [
      suffixed("java", [
        "storage.modifier",
        "storage.type.primitive",
        "constant.language",
        "variable.language",
        "variable.language.this",
      ]),
      "JAVA_KEYWORD",
    ],
    [suffixed("java", ["storage.modifier.package", "storage.modifier.import"]), "DEFAULT_IDENTIFIER"],
    [suffixed("java", ["storage.type.generic"]), "TYPE_PARAMETER_NAME_ATTRIBUTES"],
    [suffixed("java", ["constant.other.enum"]), "STATIC_FINAL_FIELD_ATTRIBUTES"],
    [suffixed("java", ["entity.name.type.enum"]), "ENUM_NAME_ATTRIBUTES"],
    [suffixed("java", ["entity.name.type.interface"]), "INTERFACE_NAME_ATTRIBUTES"],
    [suffixed("java", ["storage.type.annotation", "punctuation.definition.annotation"]), "ANNOTATION_NAME_ATTRIBUTES"],
    [suffixed("java", ["variable.other.object.property"]), "INSTANCE_FIELD_ATTRIBUTES"],
    [suffixed("java", ["variable.other.object"]), "LOCAL_VARIABLE_ATTRIBUTES"],
    [suffixed("java", ["comment.block.javadoc variable.parameter"]), "DEFAULT_DOC_COMMENT_TAG_VALUE"],
    [suffixed("java", ["punctuation.terminator", "punctuation.separator.delimiter"]), "JAVA_SEMICOLON"],
  ]),
};

// --- Kotlin (IntelliJ IDEA) -------------------------------------------------

const KOTLIN: LanguageColors = {
  root: "source.kotlin",
  defaults: {
    KEYWORD: "KOTLIN_KEYWORD",
    STRING: "KOTLIN_STRING",
    NUMBER: "KOTLIN_NUMBER",
    LINE_COMMENT: "KOTLIN_LINE_COMMENT",
    BLOCK_COMMENT: "KOTLIN_BLOCK_COMMENT",
    DOC_COMMENT: "KOTLIN_DOC_COMMENT",
    VALID_STRING_ESCAPE: "KOTLIN_STRING_ESCAPE",
    OPERATION_SIGN: "KOTLIN_OPERATION_SIGN",
    DOT: "KOTLIN_DOT",
    FUNCTION_DECLARATION: "KOTLIN_FUNCTION_DECLARATION",
    FUNCTION_CALL: "KOTLIN_FUNCTION_CALL",
    PARAMETER: "KOTLIN_PARAMETER",
    LOCAL_VARIABLE: "KOTLIN_LOCAL_VARIABLE",
    CLASS_NAME: "KOTLIN_CLASS",
    METADATA: "KOTLIN_ANNOTATION",
    COMMA: "KOTLIN_COMMA",
    SEMICOLON: "KOTLIN_SEMICOLON",
    PARENTHS: "KOTLIN_PARENTHESIS",
    BRACKETS: "KOTLIN_BRACKETS",
    BRACES: "KOTLIN_BRACES",
  },
  rules: rules([
    [suffixed("kotlin", ["keyword.hard", "keyword.soft", "constant.language"]), "KOTLIN_KEYWORD"],
    [suffixed("kotlin", ["entity.name.type.annotation"]), "KOTLIN_ANNOTATION"],
    [suffixed("kotlin", ["entity.name.function.declaration"]), "KOTLIN_FUNCTION_DECLARATION"],
    [suffixed("kotlin", ["entity.name.function.call"]), "KOTLIN_FUNCTION_CALL"],
    [suffixed("kotlin", ["entity.name.package"]), "DEFAULT_IDENTIFIER"],
    [suffixed("kotlin", ["comment.block.javadoc"]), "KOTLIN_DOC_COMMENT"],
    // String templates: `$`, `${` and `}` are escape-colored.
    [
      [
        "source.kotlin punctuation.definition.template-expression.begin",
        "source.kotlin punctuation.definition.template-expression.end",
      ],
      "KOTLIN_STRING_ESCAPE",
    ],
    [suffixed("kotlin", ["meta.template.expression", "variable.string-escape"]), "KOTLIN_LOCAL_VARIABLE"],
  ]),
};

// --- Go (GoLand) ----------------------------------------------------------

const GO: LanguageColors = {
  root: "source.go",
  defaults: {
    KEYWORD: "GO_KEYWORD",
    STRING: "GO_STRING",
    NUMBER: "GO_NUMBER",
    LINE_COMMENT: "GO_LINE_COMMENT",
    BLOCK_COMMENT: "GO_BLOCK_COMMENT",
    VALID_STRING_ESCAPE: "GO_VALID_STRING_ESCAPE",
    OPERATION_SIGN: "GO_OPERATOR",
    DOT: "GO_DOT",
    FUNCTION_DECLARATION: "GO_EXPORTED_FUNCTION",
    FUNCTION_CALL: "GO_EXPORTED_FUNCTION_CALL",
    PARAMETER: "GO_FUNCTION_PARAMETER",
    LOCAL_VARIABLE: "GO_LOCAL_VARIABLE",
    CLASS_NAME: "GO_TYPE_REFERENCE",
    CONSTANT: "GO_PACKAGE_EXPORTED_CONSTANT",
    COMMA: "GO_COMMA",
    SEMICOLON: "GO_SEMICOLON",
    PARENTHS: "GO_PARENTHESES",
    BRACKETS: "GO_BRACKET",
    BRACES: "GO_BRACES",
  },
  rules: rules([
    [suffixed("go", ["entity.name.function.support.builtin"]), "GO_BUILTIN_FUNCTION_CALL"],
    [suffixed("go", ["entity.name.function.support"]), "GO_EXPORTED_FUNCTION_CALL"],
    [suffixed("go", ["entity.name.function"]), "GO_EXPORTED_FUNCTION"],
    [suffixed("go", ["entity.name.import", "entity.name.type.package", "entity.name.package"]), "GO_PACKAGE"],
    // Builtin types (int, string, error, …) are storage.type.* here.
    [["source.go storage.type"], "GO_BUILTIN_TYPE_REFERENCE"],
    [suffixed("go", ["entity.name.type"]), "GO_TYPE_REFERENCE"],
    [suffixed("go", ["constant.language", "constant.language.null", "constant.language.boolean", "constant.language.iota"]), "GO_BUILTIN_CONSTANT"],
    [suffixed("go", ["variable.other.constant"]), "GO_PACKAGE_EXPORTED_CONSTANT"],
    [suffixed("go", ["variable.other.property"]), "GO_STRUCT_EXPORTED_MEMBER"],
    [suffixed("go", ["variable.parameter"]), "GO_FUNCTION_PARAMETER"],
    [suffixed("go", ["variable.other", "variable.other.assignment"]), "GO_LOCAL_VARIABLE"],
    [suffixed("go", ["punctuation.other.comma"]), "GO_COMMA"],
    [suffixed("go", ["punctuation.other.colon"]), "GO_COLON"],
    [suffixed("go", ["punctuation.other.period"]), "GO_DOT"],
  ]),
};

// --- Rust (RustRover) ---------------------------------------------------------

const RUST: LanguageColors = {
  root: "source.rust",
  defaults: {
    KEYWORD: "org.rust.KEYWORD",
    STRING: "org.rust.STRING",
    NUMBER: "org.rust.NUMBER",
    LINE_COMMENT: "org.rust.EOL_COMMENT",
    BLOCK_COMMENT: "org.rust.BLOCK_COMMENT",
    DOC_COMMENT: "org.rust.DOC_COMMENT",
    VALID_STRING_ESCAPE: "org.rust.VALID_STRING_ESCAPE",
    OPERATION_SIGN: "org.rust.OPERATORS",
    DOT: "org.rust.DOT",
    FUNCTION_DECLARATION: "org.rust.FUNCTION",
    FUNCTION_CALL: "org.rust.FUNCTION_CALL",
    PARAMETER: "org.rust.PARAMETER",
    LOCAL_VARIABLE: "org.rust.VARIABLE",
    CLASS_NAME: "org.rust.STRUCT",
    CONSTANT: "org.rust.CONSTANT",
    METADATA: "org.rust.ATTRIBUTE",
    COMMA: "org.rust.COMMA",
    SEMICOLON: "org.rust.SEMICOLON",
    PARENTHS: "org.rust.PARENTHESES",
    BRACKETS: "org.rust.BRACKETS",
    BRACES: "org.rust.BRACES",
  },
  rules: rules([
    [suffixed("rust", ["meta.function.definition entity.name.function"]), "org.rust.FUNCTION"],
    [suffixed("rust", ["meta.function.call entity.name.function", "entity.name.function"]), "org.rust.FUNCTION_CALL"],
    [suffixed("rust", ["entity.name.function.macro", "support.macro"]), "org.rust.MACRO"],
    [suffixed("rust", ["entity.name.type.struct", "entity.name.type"]), "org.rust.STRUCT"],
    [suffixed("rust", ["entity.name.type.enum"]), "org.rust.ENUM"],
    [suffixed("rust", ["entity.name.type.trait"]), "org.rust.TRAIT"],
    [suffixed("rust", ["entity.name.type.numeric", "entity.name.type.primitive"]), "org.rust.PRIMITIVE_TYPE"],
    [suffixed("rust", ["entity.name.type.lifetime", "punctuation.definition.lifetime"]), "org.rust.LIFETIME"],
    [suffixed("rust", ["entity.name.namespace"]), "org.rust.MODULE"],
    [suffixed("rust", ["variable.language.self"]), "org.rust.SELF_PARAMETER"],
    [
      suffixed("rust", ["meta.attribute", "punctuation.definition.attribute", "punctuation.brackets.attribute"]),
      "org.rust.ATTRIBUTE",
    ],
    [suffixed("rust", ["constant.other.caps"]), "org.rust.CONSTANT"],
    [
      suffixed("rust", [
        "comment.line.documentation",
        "comment.block.documentation",
        "comment.line.documentation punctuation.definition.comment",
        "comment.block.documentation punctuation.definition.comment",
      ]),
      "org.rust.DOC_COMMENT",
    ],
    [suffixed("rust", ["string.quoted.single.char", "punctuation.definition.char"]), "org.rust.CHAR"],
    [suffixed("rust", ["punctuation.definition.interpolation", "meta.interpolation"]), "org.rust.FORMAT_PARAMETER"],
    [suffixed("rust", ["constant.character.escape.backslash"]), "org.rust.VALID_STRING_ESCAPE"],
    [suffixed("rust", ["punctuation.semi"]), "org.rust.SEMICOLON"],
    [suffixed("rust", ["punctuation.comma"]), "org.rust.COMMA"],
    [suffixed("rust", ["punctuation.brackets.curly"]), "org.rust.BRACES"],
    [suffixed("rust", ["punctuation.brackets.square"]), "org.rust.BRACKETS"],
    [suffixed("rust", ["punctuation.brackets.round"]), "org.rust.PARENTHESES"],
  ]),
};

// --- C / C++ (CLion) ----------------------------------------------------------

function nativeColors(root: string, suffix: string): LanguageColors {
  return {
    root,
    defaults: {
      KEYWORD: "OC.KEYWORD",
      STRING: "OC.STRING",
      NUMBER: "OC.NUMBER",
      LINE_COMMENT: "OC.LINE_COMMENT",
      BLOCK_COMMENT: "OC.BLOCK_COMMENT",
      DOC_COMMENT: "OC.BLOCK_COMMENT",
      VALID_STRING_ESCAPE: "OC.VALID_STRING_ESCAPE",
      OPERATION_SIGN: "OC.OPERATION_SIGN",
      DOT: "OC.DOT",
      FUNCTION_DECLARATION: "OC.FUNCTION_DECLARATION",
      FUNCTION_CALL: "OC.FUNCTION",
      PARAMETER: "OC.PARAMETER",
      LOCAL_VARIABLE: "OC.LOCAL_VARIABLE",
      CLASS_NAME: "OC.STRUCT_LIKE",
      CONSTANT: "OC.CONSTANT",
      METADATA: "OC.DIRECTIVE",
      COMMA: "OC.COMMA",
      SEMICOLON: "OC.SEMICOLON",
      PARENTHS: "OC.PARENTHS",
      BRACKETS: "OC.BRACKETS",
      BRACES: "OC.BRACES",
    },
    rules: rules([
      [suffixed(suffix, ["keyword.control"]), "OC.CONTROL_FLOW_KEYWORD"],
      [suffixed(suffix, ["keyword.control.directive", "punctuation.definition.directive", "meta.preprocessor"]), "OC.DIRECTIVE"],
      [
        suffixed(suffix, [
          "string.quoted.other.lt-gt.include",
          "string.quoted.double.include",
          "meta.preprocessor.include string",
          "meta.preprocessor.include punctuation.definition.string",
        ]),
        "OC.HEADER_PATH",
      ],
      [suffixed(suffix, ["entity.name.function.preprocessor"]), "OC.MACRONAME"],
      [suffixed(suffix, ["storage.type.built-in", "storage.type.built-in.primitive"]), "OC.BUILTIN_TYPE_KEYWORD"],
      [suffixed(suffix, ["meta.function-call entity.name.function", "entity.name.function.call", "entity.name.function.member"]), "OC.FUNCTION"],
      [
        suffixed(suffix, ["meta.function entity.name.function", "entity.name.function.definition", "entity.name.function.constructor"]),
        "OC.FUNCTION_DECLARATION",
      ],
      [suffixed(suffix, ["variable.other.member", "variable.other.property"]), "OC.STRUCT_FIELD"],
      [suffixed(suffix, ["entity.name.type.template", "entity.name.type.parameter"]), "OC.TEMPLATE_TYPE"],
      [suffixed(suffix, ["entity.name.namespace", "entity.name.scope-resolution"]), "OC.NAMESPACE_LIKE"],
      [suffixed(suffix, ["variable.language.this"]), "OC.SELFSUPERTHIS"],
      [suffixed(suffix, ["constant.language"]), "OC.KEYWORD"],
      [suffixed(suffix, ["constant.other.placeholder"]), "OC.FORMAT_TOKEN"],
      [suffixed(suffix, ["variable.parameter", "variable.parameter.probably"]), "OC.PARAMETER"],
      [suffixed(suffix, ["punctuation.terminator.statement"]), "OC.SEMICOLON"],
      [suffixed(suffix, ["punctuation.separator.delimiter", "punctuation.separator.delimiter.comma"]), "OC.COMMA"],
    ]),
  };
}

// --- PHP (PhpStorm) ---------------------------------------------------------

const PHP: LanguageColors = {
  root: "source.php",
  defaults: {
    KEYWORD: "PHP_KEYWORD",
    STRING: "PHP_STRING",
    NUMBER: "PHP_NUMBER",
    LINE_COMMENT: "PHP_COMMENT",
    BLOCK_COMMENT: "PHP_COMMENT",
    DOC_COMMENT: "PHP_DOC_COMMENT_ID",
    VALID_STRING_ESCAPE: "PHP_ESCAPE_SEQUENCE",
    OPERATION_SIGN: "PHP_OPERATION_SIGN",
    FUNCTION_DECLARATION: "PHP_FUNCTION",
    FUNCTION_CALL: "PHP_FUNCTION_CALL",
    PARAMETER: "PHP_PARAMETER",
    LOCAL_VARIABLE: "PHP_VAR",
    CLASS_NAME: "PHP_CLASS",
    CONSTANT: "PHP_CONSTANT",
    METADATA: "PHP_ATTRIBUTE",
    COMMA: "PHP_COMMA",
    SEMICOLON: "PHP_SEMICOLON",
    PARENTHS: "PHP_PARENTHESES",
    BRACKETS: "PHP_BRACKETS",
    BRACES: "PHP_BRACES",
  },
  rules: rules([
    [suffixed("php", ["variable.other", "punctuation.definition.variable"]), "PHP_VAR"],
    [suffixed("php", ["variable.language.this", "variable.language.this punctuation.definition.variable"]), "PHP_THIS_VAR"],
    [suffixed("php", ["variable.other.property"]), "PHP_INSTANCE_FIELD"],
    [suffixed("php", ["variable.other.class"]), "PHP_STATIC_FIELD"],
    [suffixed("php", ["support.function", "meta.function-call entity.name.function"]), "PHP_FUNCTION_CALL"],
    [suffixed("php", ["meta.method-call entity.name.function"]), "PHP_INSTANCE_METHOD"],
    [suffixed("php", ["entity.name.function", "support.function.constructor"]), "PHP_FUNCTION"],
    [suffixed("php", ["support.function.construct", "keyword.other.new", "storage.type"]), "PHP_KEYWORD"],
    [suffixed("php", ["support.constant", "support.constant.core", "constant.other"]), "PHP_CONSTANT"],
    [
      suffixed("php", ["support.class", "entity.other.inherited-class", "entity.name.type.class", "entity.name.type.interface"]),
      "PHP_CLASS",
    ],
    [suffixed("php", ["support.other.namespace", "entity.name.type.namespace"]), "PHP_IDENTIFIER"],
    [suffixed("php", ["keyword.other.phpdoc"]), "PHP_DOC_TAG"],
    [suffixed("php", ["comment.block.documentation.phpdoc"]), "PHP_DOC_COMMENT_ID"],
    [suffixed("php", ["meta.attribute", "support.attribute.builtin"]), "PHP_ATTRIBUTE"],
    [suffixed("php", ["entity.name.variable.parameter"]), "PHP_NAMED_ARGUMENT"],
    [suffixed("php", ["keyword.other.type"]), "PHP_PRIMITIVE_TYPE_HINT"],
    [suffixed("php", ["punctuation.section.embedded.begin", "punctuation.section.embedded.end"]), "PHP_TAG"],
    [suffixed("php", ["punctuation.terminator.expression"]), "PHP_SEMICOLON"],
  ]),
};

// --- Ruby (RubyMine) --------------------------------------------------------

const RUBY: LanguageColors = {
  root: "source.ruby",
  defaults: {
    KEYWORD: "RUBY_KEYWORD",
    STRING: "RUBY_STRING",
    NUMBER: "RUBY_NUMBER",
    LINE_COMMENT: "RUBY_COMMENT",
    BLOCK_COMMENT: "RUBY_COMMENT",
    DOC_COMMENT: "RUBY_COMMENT",
    VALID_STRING_ESCAPE: "RUBY_ESCAPE_SEQUENCE",
    OPERATION_SIGN: "RUBY_OPERATION_SIGN",
    DOT: "RUBY_DOT",
    FUNCTION_DECLARATION: "RUBY_METHOD_NAME",
    PARAMETER: "RUBY_PARAMETER_ID",
    CLASS_NAME: "RUBY_CONSTANT_DECLARATION",
    CONSTANT: "RUBY_CONSTANT",
    COMMA: "RUBY_COMMA",
    SEMICOLON: "RUBY_SEMICOLON",
    PARENTHS: "RUBY_PARENTHESES",
    BRACKETS: "RUBY_BRACKETS",
    BRACES: "RUBY_BRACES",
  },
  rules: rules([
    [suffixed("ruby", ["constant.language.symbol", "constant.other.symbol", "constant.language.symbol punctuation.definition.constant"]), "RUBY_SYMBOL"],
    [
      suffixed("ruby", ["variable.other.readwrite.instance", "variable.other.readwrite.instance punctuation.definition.variable"]),
      "RUBY_IVAR",
    ],
    [
      suffixed("ruby", ["variable.other.readwrite.class", "variable.other.readwrite.class punctuation.definition.variable"]),
      "RUBY_CVAR",
    ],
    [
      suffixed("ruby", ["variable.other.readwrite.global", "variable.other.readwrite.global punctuation.definition.variable"]),
      "RUBY_GVAR",
    ],
    [suffixed("ruby", ["variable.other.constant", "support.class"]), "RUBY_CONSTANT"],
    [suffixed("ruby", ["entity.name.type.class", "entity.name.type.module"]), "RUBY_CONSTANT_DECLARATION"],
    [suffixed("ruby", ["entity.name.function"]), "RUBY_METHOD_NAME"],
    [suffixed("ruby", ["variable.parameter.function"]), "RUBY_PARAMETER_ID"],
    [suffixed("ruby", ["keyword.other.special-method"]), "RUBY_SPECIFIC_CALL"],
    [suffixed("ruby", ["support.function.kernel"]), "RUBY_IDENTIFIER"],
    [suffixed("ruby", ["string.regexp.interpolated", "string.regexp", "punctuation.section.regexp"]), "RUBY_REGEXP"],
    [suffixed("ruby", ["string.quoted.double.interpolated"]), "RUBY_INTERPOLATED_STRING"],
    [suffixed("ruby", ["punctuation.section.embedded.begin", "punctuation.section.embedded.end"]), "RUBY_EXPR_IN_STRING"],
    [
      suffixed("ruby", ["constant.language.nil", "constant.language.boolean", "constant.language", "variable.language.self"]),
      "RUBY_KEYWORD",
    ],
    [suffixed("ruby", ["punctuation.separator.namespace"]), "RUBY_COLON"],
    [suffixed("ruby", ["punctuation.separator.object"]), "RUBY_COMMA"],
  ]),
};

// --- CSS / SCSS (WebStorm) --------------------------------------------------

const CSS_RULES: ScopeRule[] = rules([
  [suffixed("css", ["entity.other.attribute-name.class", "entity.other.attribute-name.class punctuation.definition.entity"]), "CSS.CLASS_NAME"],
  [suffixed("css", ["entity.other.attribute-name.id", "entity.other.attribute-name.id punctuation.definition.entity"]), "CSS.HASH"],
  [
    suffixed("css", [
      "entity.other.attribute-name.pseudo-class",
      "entity.other.attribute-name.pseudo-element",
      "entity.other.attribute-name.pseudo-class punctuation.definition.entity",
      "entity.other.attribute-name.pseudo-element punctuation.definition.entity",
    ]),
    "CSS.PSEUDO",
  ],
  [suffixed("css", ["entity.other.attribute-name"]), "CSS.ATTRIBUTE_NAME"],
  [suffixed("css", ["entity.name.tag", "entity.name.tag.wildcard"]), "CSS.TAG_NAME"],
  [suffixed("css", ["support.type.property-name", "support.type.property-name.media", "variable"]), "CSS.PROPERTY_NAME"],
  [suffixed("css", ["support.constant.property-value", "support.constant.font-name", "support.constant.media"]), "CSS.PROPERTY_VALUE"],
  [
    suffixed("css", ["constant.other.color.rgb-value", "support.constant.color", "constant.other.color.rgb-value punctuation.definition.constant"]),
    "CSS.COLOR",
  ],
  [suffixed("css", ["constant.numeric"]), "CSS.NUMBER"],
  [suffixed("css", ["keyword.other.unit"]), "CSS.UNIT"],
  [suffixed("css", ["keyword.other.important"]), "CSS.IMPORTANT"],
  [suffixed("css", ["keyword.control.at-rule", "punctuation.definition.keyword"]), "CSS.KEYWORD"],
  [suffixed("css", ["support.function", "support.function.misc", "support.function.calc", "support.function.url"]), "CSS.FUNCTION"],
  [suffixed("css", ["variable.parameter.url"]), "CSS.URL"],
  [suffixed("css", ["string"]), "CSS.STRING"],
  [suffixed("css", ["comment.block", "punctuation.definition.comment"]), "CSS.COMMENT"],
  [suffixed("css", ["punctuation.terminator.rule"]), "CSS.SEMICOLON"],
  [suffixed("css", ["punctuation.separator.list.comma"]), "CSS.COMMA"],
  [suffixed("css", ["punctuation.separator.key-value"]), "CSS.COLON"],
  [suffixed("css", ["keyword.operator", "keyword.operator.combinator"]), "CSS.OPERATORS"],
]);

const CSS: LanguageColors = {
  root: "source.css",
  defaults: {
    KEYWORD: "CSS.KEYWORD",
    STRING: "CSS.STRING",
    NUMBER: "CSS.NUMBER",
    LINE_COMMENT: "CSS.COMMENT",
    BLOCK_COMMENT: "CSS.COMMENT",
    DOT: "CSS.DOT",
    FUNCTION_CALL: "CSS.FUNCTION",
    COMMA: "CSS.COMMA",
    SEMICOLON: "CSS.SEMICOLON",
    PARENTHS: "CSS.PARENTHESES",
    BRACKETS: "CSS.BRACKETS",
    BRACES: "CSS.BRACES",
  },
  rules: CSS_RULES,
};

const SCSS: LanguageColors = {
  root: "source.css.scss",
  defaults: CSS.defaults,
  rules: rules([
    [suffixed("scss", ["variable", "variable.interpolation"]), "SASS_VARIABLE"],
    [suffixed("scss", ["comment.block", "comment.line", "punctuation.definition.comment"]), "SASS_COMMENT"],
    [suffixed("scss", ["entity.name.function"]), "SASS_MIXIN"],
    [suffixed("scss", ["keyword.control.at-rule", "punctuation.definition.keyword"]), "CSS.KEYWORD"],
    [suffixed("scss", ["entity.name.tag.reference"]), "CSS.AMPERSAND"],
    [suffixed("scss", ["support.function.misc"]), "CSS.FUNCTION"],
    [suffixed("scss", ["string"]), "CSS.STRING"],
    [suffixed("scss", ["keyword.other.important"]), "CSS.IMPORTANT"],
    [suffixed("scss", ["punctuation.terminator.rule"]), "CSS.SEMICOLON"],
  ]),
};

// --- HTML / XML ---------------------------------------------------------------

const HTML: LanguageColors = {
  root: "text.html.basic",
  defaults: {},
  rules: rules([
    [suffixed("html", ["entity.name.tag", "punctuation.definition.tag.begin", "punctuation.definition.tag.end"]), "HTML_TAG_NAME"],
    [suffixed("html", ["entity.other.attribute-name"]), "HTML_ATTRIBUTE_NAME"],
    [
      suffixed("html", ["string.quoted.double", "string.quoted.single", "punctuation.definition.string.begin", "punctuation.definition.string.end"]),
      "HTML_ATTRIBUTE_VALUE",
    ],
    [suffixed("html", ["comment.block", "punctuation.definition.comment"]), "HTML_COMMENT"],
    [suffixed("html", ["constant.character.entity", "punctuation.definition.entity"]), "HTML_ENTITY_REFERENCE"],
    // IntelliJ colors the whole tag (`=`, spaces) as the tag.
    [suffixed("html", ["meta.tag", "meta.tag punctuation.separator.key-value"]), "HTML_TAG"],
  ]),
};

const XML: LanguageColors = {
  root: "text.xml",
  defaults: {},
  rules: rules([
    [suffixed("xml", ["meta.tag"]), "XML_TAG"],
    [suffixed("xml", ["entity.name.tag", "entity.name.tag.localname", "punctuation.definition.tag"]), "XML_TAG_NAME"],
    [suffixed("xml", ["entity.name.tag.namespace", "entity.other.attribute-name.namespace"]), "XML_NS_PREFIX"],
    [suffixed("xml", ["entity.other.attribute-name", "entity.other.attribute-name.localname"]), "XML_ATTRIBUTE_NAME"],
    [
      suffixed("xml", ["string.quoted.double", "string.quoted.single", "punctuation.definition.string.begin", "punctuation.definition.string.end"]),
      "XML_ATTRIBUTE_VALUE",
    ],
    [suffixed("xml", ["string.unquoted.cdata", "meta.tag.sgml.cdata punctuation.definition.string.begin", "meta.tag.sgml.cdata punctuation.definition.string.end"]), "XML_TAG_DATA"],
    [suffixed("xml", ["comment.block", "punctuation.definition.comment"]), "XML_COMMENT"],
    [suffixed("xml", ["constant.character.entity", "punctuation.definition.constant"]), "XML_ENTITY_REFERENCE"],
    [suffixed("xml", ["meta.tag.preprocessor", "meta.tag.preprocessor entity.name.tag", "meta.tag.preprocessor punctuation.definition.tag"]), "XML_PROLOGUE"],
  ]),
};

// --- C# (Rider) ---------------------------------------------------------------

const CSHARP: LanguageColors = {
  root: "source.cs",
  defaults: {
    KEYWORD: "ReSharper.CSHARP_KEYWORD",
    STRING: "ReSharper.CSHARP_STRING",
    NUMBER: "ReSharper.CSHARP_NUMBER",
    LINE_COMMENT: "ReSharper.CSHARP_LINE_COMMENT",
    BLOCK_COMMENT: "ReSharper.CSHARP_BLOCK_COMMENT",
    OPERATION_SIGN: "ReSharper.CSHARP_OPERATOR_SIGN",
    DOT: "ReSharper.CSHARP_DOT",
    FUNCTION_DECLARATION: "ReSharper.CSHARP_METHOD_IDENTIFIER",
    FUNCTION_CALL: "ReSharper.CSHARP_METHOD_IDENTIFIER",
    PARAMETER: "ReSharper.CSHARP_PARAMETER_IDENTIFIER",
    LOCAL_VARIABLE: "ReSharper.CSHARP_LOCAL_VARIABLE_IDENTIFIER",
    CLASS_NAME: "ReSharper.CSHARP_CLASS_IDENTIFIER",
    CONSTANT: "ReSharper.CSHARP_CONSTANT_IDENTIFIER",
    COMMA: "ReSharper.CSHARP_COMMA",
    SEMICOLON: "ReSharper.CSHARP_SEMICOLON",
    PARENTHS: "ReSharper.CSHARP_PARENTHESES",
    BRACKETS: "ReSharper.CSHARP_BRACKETS",
    BRACES: "ReSharper.CSHARP_BRACES",
  },
  rules: rules([
    [suffixed("cs", ["keyword.control", "keyword.control.flow"]), "ReSharper.CSHARP_CONTROL_FLOW_KEYWORD"],
    [suffixed("cs", ["keyword.type", "storage.type.var"]), "ReSharper.CSHARP_BUILTIN_TYPE_KEYWORD"],
    [suffixed("cs", ["keyword.preprocessor", "punctuation.separator.hash"]), "ReSharper.CSHARP_PREPROCESSOR_KEYWORD"],
    [suffixed("cs", ["constant.language", "variable.language.this", "variable.language.base"]), "ReSharper.CSHARP_KEYWORD"],
    [suffixed("cs", ["keyword.other.directive.using"]), "ReSharper.CSHARP_KEYWORD"],
    [suffixed("cs", ["entity.name.type.namespace"]), "ReSharper.NAMESPACE_IDENTIFIER"],
    [suffixed("cs", ["entity.name.type", "entity.name.type.class"]), "ReSharper.CSHARP_CLASS_IDENTIFIER"],
    [suffixed("cs", ["entity.name.type.interface"]), "ReSharper.CSHARP_INTERFACE_IDENTIFIER"],
    [suffixed("cs", ["entity.name.type.struct"]), "ReSharper.CSHARP_STRUCT_IDENTIFIER"],
    [suffixed("cs", ["entity.name.type.enum"]), "ReSharper.CSHARP_ENUM_IDENTIFIER"],
    [suffixed("cs", ["entity.name.type.type-parameter"]), "ReSharper.CSHARP_TYPE_PARAMETER_IDENTIFIER"],
    [suffixed("cs", ["entity.name.function"]), "ReSharper.CSHARP_METHOD_IDENTIFIER"],
    [
      suffixed("cs", ["entity.name.variable.field", "variable.other.object.property", "entity.name.variable.property"]),
      "ReSharper.CSHARP_FIELD_IDENTIFIER",
    ],
    [suffixed("cs", ["entity.name.variable.event"]), "ReSharper.CSHARP_EVENT_IDENTIFIER"],
    [suffixed("cs", ["entity.name.variable.enum-member"]), "ReSharper.CSHARP_CONSTANT_IDENTIFIER"],
    [suffixed("cs", ["entity.name.variable.parameter"]), "ReSharper.CSHARP_PARAMETER_IDENTIFIER"],
    [
      suffixed("cs", ["entity.name.variable.local", "variable.other.readwrite", "variable.other.object"]),
      "ReSharper.CSHARP_LOCAL_VARIABLE_IDENTIFIER",
    ],
    [suffixed("cs", ["comment.block.documentation", "punctuation.definition.comment"]), "DEFAULT_DOC_COMMENT"],
    [
      suffixed("cs", ["comment.block.documentation entity.name.tag.localname", "comment.block.documentation punctuation.definition.tag"]),
      "DEFAULT_DOC_COMMENT_TAG",
    ],
    [suffixed("cs", ["punctuation.definition.interpolation.begin", "punctuation.definition.interpolation.end"]), "ReSharper.FORMAT_STRING_ITEM"],
    [suffixed("cs", ["punctuation.terminator.statement"]), "ReSharper.CSHARP_SEMICOLON"],
    [suffixed("cs", ["punctuation.separator.comma"]), "ReSharper.CSHARP_COMMA"],
    [suffixed("cs", ["punctuation.curlybrace.open", "punctuation.curlybrace.close"]), "ReSharper.CSHARP_BRACES"],
    [suffixed("cs", ["punctuation.squarebracket.open", "punctuation.squarebracket.close"]), "ReSharper.CSHARP_BRACKETS"],
    [suffixed("cs", ["punctuation.parenthesis.open", "punctuation.parenthesis.close"]), "ReSharper.CSHARP_PARENTHESES"],
  ]),
};

// --- JSON / YAML / Markdown / SQL / Shell -------------------------------------

const JSON_COLORS: LanguageColors = {
  root: "source.json",
  defaults: {
    KEYWORD: "JSON.KEYWORD",
    STRING: "JSON.STRING",
    NUMBER: "JSON.NUMBER",
    LINE_COMMENT: "JSON.LINE_COMMENT",
    BLOCK_COMMENT: "JSON.BLOCK_COMMENT",
    VALID_STRING_ESCAPE: "JSON.VALID_ESCAPE",
    DOT: "JSON.COMMA",
    COMMA: "JSON.COMMA",
    BRACKETS: "JSON.BRACKETS",
    BRACES: "JSON.BRACES",
  },
  rules: rules([
    [suffixed("json", ["support.type.property-name", "punctuation.support.type.property-name"]), "JSON.PROPERTY_KEY"],
    [suffixed("json", ["constant.language"]), "JSON.KEYWORD"],
    [suffixed("json", ["punctuation.definition.dictionary.begin", "punctuation.definition.dictionary.end"]), "JSON.BRACES"],
    [suffixed("json", ["punctuation.definition.array.begin", "punctuation.definition.array.end"]), "JSON.BRACKETS"],
    [suffixed("json", ["punctuation.separator.dictionary.key-value"]), "JSON.COLON"],
    [suffixed("json", ["punctuation.separator.dictionary.pair", "punctuation.separator.array"]), "JSON.COMMA"],
  ]),
};

const YAML: LanguageColors = {
  root: "source.yaml",
  defaults: { STRING: "YAML_SCALAR_DSTRING", LINE_COMMENT: "YAML_COMMENT", DOT: "YAML_SIGN" },
  rules: rules([
    [suffixed("yaml", ["entity.name.tag"]), "YAML_SCALAR_KEY"],
    [suffixed("yaml", ["comment.line.number-sign", "punctuation.definition.comment"]), "YAML_COMMENT"],
    [suffixed("yaml", ["string.unquoted.plain.out", "string.unquoted.plain.in", "constant.numeric", "constant.language"]), "YAML_TEXT"],
    [suffixed("yaml", ["string.unquoted.block"]), "YAML_SCALAR_VALUE"],
    [suffixed("yaml", ["string.quoted.double", "string.quoted.double punctuation.definition.string"]), "YAML_SCALAR_DSTRING"],
    [suffixed("yaml", ["string.quoted.single", "string.quoted.single punctuation.definition.string"]), "YAML_SCALAR_STRING"],
    [
      suffixed("yaml", ["punctuation.separator.key-value.mapping", "punctuation.definition.block.sequence.item", "punctuation.separator.key-value"]),
      "YAML_SIGN",
    ],
    [suffixed("yaml", ["entity.name.type.anchor", "punctuation.definition.anchor", "variable.other.alias", "punctuation.definition.alias"]), "YAML_ANCHOR"],
  ]),
};

const MARKDOWN: LanguageColors = {
  root: "text.html.markdown",
  defaults: {},
  rules: rules([
    [suffixed("markdown", ["markup.heading", "entity.name.section", "markup.heading entity.name.section"]), "MARKDOWN_HEADER_LEVEL_1"],
    [suffixed("markdown", ["punctuation.definition.heading"]), "MARKDOWN_HEADER_MARKER"],
    [suffixed("markdown", ["markup.bold"]), "MARKDOWN_BOLD"],
    [suffixed("markdown", ["punctuation.definition.bold"]), "MARKDOWN_BOLD_MARKER"],
    [suffixed("markdown", ["markup.italic"]), "MARKDOWN_ITALIC"],
    [suffixed("markdown", ["punctuation.definition.italic"]), "MARKDOWN_ITALIC_MARKER"],
    [suffixed("markdown", ["markup.strikethrough"]), "MARKDOWN_STRIKE_THROUGH"],
    [suffixed("markdown", ["markup.inline.raw", "markup.inline.raw.string"]), "MARKDOWN_CODE_SPAN"],
    [suffixed("markdown", ["punctuation.definition.raw"]), "MARKDOWN_CODE_SPAN_MARKER"],
    [suffixed("markdown", ["markup.fenced_code.block", "markup.raw.block"]), "MARKDOWN_CODE_FENCE"],
    [suffixed("markdown", ["punctuation.definition.markdown"]), "MARKDOWN_CODE_FENCE_MARKER"],
    [["fenced_code.block.language", "fenced_code.block.language.markdown"], "MARKDOWN_CODE_FENCE_LANGUAGE"],
    [suffixed("markdown", ["string.other.link.title", "string.other.link.description"]), "MARKDOWN_LINK_TEXT"],
    [suffixed("markdown", ["markup.underline.link", "markup.underline.link.image"]), "MARKDOWN_LINK_DESTINATION"],
    [suffixed("markdown", ["punctuation.definition.list.begin"]), "MARKDOWN_LIST_MARKER"],
    [suffixed("markdown", ["markup.quote"]), "MARKDOWN_BLOCK_QUOTE"],
    [suffixed("markdown", ["punctuation.definition.quote.begin"]), "MARKDOWN_BLOCK_QUOTE_MARKER"],
    [suffixed("markdown", ["meta.separator"]), "MARKDOWN_HRULE"],
    [suffixed("markdown", ["meta.paragraph"]), "MARKDOWN_TEXT"],
  ]),
};

const SQL: LanguageColors = {
  root: "source.sql",
  defaults: {
    KEYWORD: "SQL_KEYWORD",
    STRING: "SQL_STRING",
    NUMBER: "SQL_NUMBER",
    LINE_COMMENT: "SQL_COMMENT",
    BLOCK_COMMENT: "SQL_COMMENT",
    DOT: "SQL_DOT",
    CONSTANT: "SQL_IDENT",
    COMMA: "SQL_COMMA",
    SEMICOLON: "SQL_SEMICOLON",
    PARENTHS: "SQL_PARENS",
    BRACKETS: "SQL_BRACKETS",
    BRACES: "SQL_BRACES",
  },
  rules: rules([
    [suffixed("sql", ["storage.type"]), "SQL_TYPE"],
    [suffixed("sql", ["constant.other.database-name", "constant.other.table-name"]), "SQL_IDENT"],
    [suffixed("sql", ["punctuation.terminator.statement"]), "SQL_SEMICOLON"],
    [suffixed("sql", ["punctuation.separator.comma"]), "SQL_COMMA"],
  ]),
};

const SHELL: LanguageColors = {
  root: "source.shell",
  defaults: {
    KEYWORD: "BASH.KEYWORD",
    STRING: "BASH.STRING",
    NUMBER: "BASH.NUMBER",
    LINE_COMMENT: "BASH.LINE_COMMENT",
    BLOCK_COMMENT: "BASH.LINE_COMMENT",
    LOCAL_VARIABLE: "BASH.VAR_USE",
    FUNCTION_DECLARATION: "BASH.FUNCTION_DEF_NAME",
    PARENTHS: "BASH.PAREN",
    BRACKETS: "BASH.BRACKET",
    BRACES: "BASH.BRACE",
  },
  rules: rules([
    [suffixed("shell", ["entity.name.command", "support.function.builtin"]), "BASH.EXTERNAL_COMMAND"],
    [suffixed("shell", ["variable.other.normal", "variable.parameter.positional", "variable.other.special", "punctuation.definition.variable"]), "BASH.VAR_USE"],
    [suffixed("shell", ["variable.other.assignment", "variable.other.for"]), "BASH.VAR_DEF"],
    [suffixed("shell", ["meta.shebang", "punctuation.definition.comment.shebang"]), "BASH.SHEBANG"],
    [suffixed("shell", ["keyword.operator.pipe", "keyword.operator.redirect"]), "BASH.REDIRECTION"],
    [suffixed("shell", ["string.quoted.single"]), "BASH.RAW_STRING"],
    [suffixed("shell", ["string.unquoted", "string.unquoted.argument", "constant.other.option"]), "DEFAULT_IDENTIFIER"],
    [suffixed("shell", ["string.interpolated.backtick", "string.interpolated.dollar"]), "BASH.BACKQUOTE"],
    [suffixed("shell", ["punctuation.definition.logical-expression"]), "BASH.CONDITIONAL"],
  ]),
};

/** By Monaco language id. */
export const LANGUAGE_COLORS: Record<string, LanguageColors> = {
  python: PYTHON,
  typescript: scriptColors("source.tsx", "tsx", "TS"),
  javascript: scriptColors("source.js", "js", "JS"),
  java: JAVA,
  kotlin: KOTLIN,
  go: GO,
  rust: RUST,
  c: nativeColors("source.c", "c"),
  cpp: nativeColors("source.cpp", "cpp"),
  php: PHP,
  ruby: RUBY,
  csharp: CSHARP,
  css: CSS,
  scss: SCSS,
  html: HTML,
  xml: XML,
  json: JSON_COLORS,
  yaml: YAML,
  markdown: MARKDOWN,
  sql: SQL,
  shell: SHELL,
};
