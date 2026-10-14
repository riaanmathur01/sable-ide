/**
 * Where Emmet applies: which kind of abbreviation (markup or stylesheet)
 * the text before the cursor can be, judged from the file type and the
 * TextMate scopes at the cursor. Pure, so it's tested on its own.
 *
 *   - HTML, XML, Vue, Svelte, PHP's HTML: markup in text content — not in
 *     comments, attribute values or inside a tag; CSS rules in <style>.
 *   - JSX/TSX: markup in JSX children, or where an expression starts
 *     (`return (` …) when the abbreviation begins with a tag name — never
 *     in ordinary JavaScript, strings or comments.
 *   - CSS, SCSS, Less: stylesheet abbreviations where a property goes.
 */

export type EmmetSyntax =
  | { type: "markup"; syntax: "html" | "xml" | "jsx" }
  | { type: "stylesheet"; syntax: "css" | "scss" | "less" | "sass" };

/** The host file, as far as Emmet cares. */
export type HostKind = "html" | "xml" | "jsx" | "css" | "scss" | "less" | "sass";

const extensionOf = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";

/** What kind of file this is for Emmet (null: Emmet doesn't apply). */
export function hostKind(languageId: string, path: string): HostKind | null {
  const extension = extensionOf(path);
  if (extension === "vue" || extension === "svelte") return "html";
  switch (languageId) {
    case "html":
    case "handlebars":
    case "razor":
    case "php":
    case "vue":
    case "svelte":
      return "html";
    case "xml":
    case "xsl":
      return "xml";
    case "css":
    case "scss":
    case "less":
    case "sass":
      return languageId;
    case "javascriptreact":
    case "typescriptreact":
      return "jsx";
    case "javascript":
    case "typescript":
      // Monaco opens .jsx/.tsx as javascript/typescript; plain .ts never has JSX.
      return extension === "tsx" || extension === "jsx" || extension === "js" || extension === "mjs" ? "jsx" : null;
    default:
      return null;
  }
}

const has = (scopes: string[], prefix: string) => scopes.some((scope) => scope.startsWith(prefix));
const STYLE_SOURCES = ["source.css", "source.scss", "source.less", "source.sass"];

/** CSS where a property goes: inside a rule's braces, not in a value. */
function stylesheetAt(scopes: string[], syntax: "css" | "scss" | "less" | "sass"): EmmetSyntax | null {
  if (has(scopes, "string") || has(scopes, "meta.property-value") || has(scopes, "comment")) return null;
  // Sass (indented) has no braces: any property position will do.
  if (syntax !== "sass" && !has(scopes, "meta.property-list")) return null;
  return { type: "stylesheet", syntax };
}

/** Inside JSX children, as opposed to a tag's attributes or an {expression}. */
function inJsxChildren(scopes: string[]): boolean {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index];
    if (scope.startsWith("meta.jsx.children")) return true;
    if (scope.startsWith("meta.tag") || scope.startsWith("meta.embedded.expression") || scope.startsWith("string")) {
      return false;
    }
  }
  return false;
}

/** HTML elements Emmet knows (a JSX abbreviation outside JSX must start with one). */
export const HTML_TAGS = new Set(
  `a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col
  colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3
  h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav
  noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section
  select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time
  title tr track u ul var video wbr svg path circle rect line polyline polygon g defs use symbol text`.split(/\s+/),
);

/**
 * JSX outside JSX: an abbreviation where a JSX expression would start
 * (`return (`, `=> `, `? `, `&& ` …) that begins with an HTML tag or a
 * Component. `prefix` is the text before the abbreviation (a few lines).
 */
export function jsxExpressionStart(prefix: string, abbreviation: string): boolean {
  const name = /^[A-Za-z][\w-]*/.exec(abbreviation)?.[0] ?? "";
  if (!name || !(HTML_TAGS.has(name) || /^[A-Z]/.test(name))) return false;
  return /(?:\breturn|=>|[=?:]|&&|\|\|)\s*\(?\s*$/.test(prefix);
}

/** Without a grammar (Vue, Svelte, or before the grammar loads): judge from the text. */
function markupFromText(textBefore: string): EmmetSyntax | null {
  const lastIndex = (pattern: RegExp) => {
    let found = -1;
    for (const match of textBefore.matchAll(pattern)) found = match.index ?? found;
    return found;
  };
  if (lastIndex(/<!--/g) > lastIndex(/-->/g)) return null;
  if (lastIndex(/<script\b/gi) > lastIndex(/<\/script>/gi)) return null;
  if (lastIndex(/<style\b/gi) > lastIndex(/<\/style>/gi)) {
    const css = textBefore.slice(lastIndex(/<style\b/gi));
    if (lastIndex(/\/\*/g) > lastIndex(/\*\//g)) return null;
    const depth = (css.match(/{/g)?.length ?? 0) - (css.match(/}/g)?.length ?? 0);
    const line = css.slice(css.lastIndexOf("\n") + 1);
    return depth > 0 && !/[:]/.test(line.replace(/[^;{]*[;{]/g, "")) ? { type: "stylesheet", syntax: "css" } : null;
  }
  // Inside a tag (`<div cla|`).
  if (lastIndex(/</g) > lastIndex(/>/g)) return null;
  return { type: "markup", syntax: "html" };
}

function stylesheetFromText(textBefore: string, syntax: "css" | "scss" | "less" | "sass"): EmmetSyntax | null {
  if (textBefore.lastIndexOf("/*") > textBefore.lastIndexOf("*/")) return null;
  const line = textBefore.slice(textBefore.lastIndexOf("\n") + 1);
  if (/\/\//.test(line)) return null;
  const depth = (textBefore.match(/{/g)?.length ?? 0) - (textBefore.match(/}/g)?.length ?? 0);
  if (syntax !== "sass" && depth <= 0) return null;
  return { type: "stylesheet", syntax };
}

export interface ContextInput {
  languageId: string;
  path: string;
  /**
   * Scopes of the token just before the cursor, outermost first (root
   * included); null when the language has no grammar.
   */
  scopes: string[] | null;
  /** The document's text before the abbreviation (the last few KB will do). */
  textBefore: string;
  /** The abbreviation found before the cursor. */
  abbreviation: string;
}

/** The Emmet syntax to expand with here, or null if Emmet shouldn't. */
export function emmetSyntaxAt(input: ContextInput): EmmetSyntax | null {
  const host = hostKind(input.languageId, input.path);
  if (!host) return null;
  const { scopes, textBefore } = input;
  if (host === "css" || host === "scss" || host === "less" || host === "sass") {
    return scopes ? stylesheetAt(scopes.slice(1), host) : stylesheetFromText(textBefore, host);
  }
  if (!scopes) {
    if (host === "jsx") return null;
    return host === "xml" ? (markupFromText(textBefore) && { type: "markup", syntax: "xml" }) : markupFromText(textBefore);
  }
  const inner = scopes.slice(1);
  if (has(inner, "comment")) return null;
  // Embedded CSS (<style>, Vue/Svelte style blocks).
  const style = STYLE_SOURCES.find((source) => has(inner, source));
  if (style) return stylesheetAt(inner, style.slice("source.".length) as "css" | "scss" | "less" | "sass");
  if (host === "jsx") {
    if (has(inner, "string")) return null;
    if (inJsxChildren(inner)) return { type: "markup", syntax: "jsx" };
    if (has(inner, "meta.tag") || has(inner, "meta.embedded.expression") || has(inner, "entity.name.tag")) {
      // In a tag's attributes, or an {expression} inside JSX: only where an expression starts.
      return has(inner, "meta.embedded.expression") && jsxExpressionStart(textBefore, input.abbreviation)
        ? { type: "markup", syntax: "jsx" }
        : null;
    }
    return jsxExpressionStart(textBefore, input.abbreviation) ? { type: "markup", syntax: "jsx" } : null;
  }
  // HTML-like: not in scripts, attribute values or inside a tag.
  if (inner.some((scope) => scope.startsWith("source.") && !scope.startsWith("source.css"))) {
    // PHP and friends wrap HTML in their own source scope: only the code parts are out.
    if (!has(inner, "text.html")) return null;
    const lastSource = inner.map((scope) => scope.startsWith("source.")).lastIndexOf(true);
    const lastHtml = inner.map((scope) => scope.startsWith("text.html")).lastIndexOf(true);
    if (lastSource > lastHtml) return null;
  }
  if (has(inner, "string") || has(inner, "meta.tag") || has(inner, "entity.name.tag") || has(inner, "meta.attribute")) return null;
  return { type: "markup", syntax: host === "xml" ? "xml" : "html" };
}
