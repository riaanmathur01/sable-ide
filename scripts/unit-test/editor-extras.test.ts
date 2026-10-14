// Unit tests for the spell checker and Emmet's pure parts. Bundled with
// esbuild and run in Node by editor-extras.mjs (run that, not this).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { INITIAL } from "@shikijs/vscode-textmate";
import { extractWords, matchCase, splitIdentifier } from "../../src/lib/spell/words";
import { expandDictionary, parseAffixFile } from "../../src/lib/spell/hunspell";
import { Dictionary } from "../../src/lib/spell/dictionary";
import { typoDistance } from "../../src/lib/spell/suggest";
import { PROGRAMMING_TERMS } from "../../src/lib/spell/programmingTerms";
import { fileDirectives, isCheckedToken } from "../../src/lib/spell/segments";
import { addWordToVscodeSettings, wordsFromVscodeSettings } from "../../src/lib/spell/cspellConfig";
import { emmetSyntaxAt, jsxExpressionStart } from "../../src/lib/emmet/context";
import { abbreviationBefore, expandToSnippet, snippetPreview } from "../../src/lib/emmet/expand";
import { nestByRange, siblingsAt, symbolPathAt, type SymbolNode } from "../../src/lib/breadcrumbs/symbols";
import { balanceInward, balanceOutward, elementAt, matchingPair, parseElements, removeTagEdits, updateTagEdits } from "../../src/lib/emmet/tags";

const root = process.env.SABLE_ROOT!;
let passed = 0;
const failures: string[] = [];
async function test(name: string, body: () => void | Promise<void>) {
  try {
    await body();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message.split("\n").join("\n       ") : error}`);
  }
}

// --- Words ---------------------------------------------------------------------------

await test("identifiers split at camelCase, snake_case, kebab-case and acronyms", () => {
  assert.deepEqual(splitIdentifier("getUserProfileId").map((part) => part.part), ["get", "User", "Profile", "Id"]);
  assert.deepEqual(splitIdentifier("XMLHttpRequest").map((part) => part.part), ["XML", "Http", "Request"]);
  assert.deepEqual(splitIdentifier("HTTPServer").map((part) => part.part), ["HTTP", "Server"]);
  assert.deepEqual(extractWords("MAX_RETRY_COUNT").map((word) => word.word), ["RETRY", "COUNT"]);
  assert.deepEqual(extractWords("max-retry-count").map((word) => word.word), ["retry", "count"]);
  assert.deepEqual(extractWords("utf8Encoder").map((word) => word.word), ["Encoder"]);
});

await test("word offsets point at each part", () => {
  const words = extractWords("  const getUserProfileId = 1");
  const profile = words.find((word) => word.word === "Profile")!;
  assert.equal("  const getUserProfileId = 1".slice(profile.offset, profile.offset + 7), "Profile");
});

await test("short words, acronyms, URLs, emails, hex, UUIDs and escapes are skipped", () => {
  const text =
    "see https://exampel.com/pathh and mailto bobb@exampel.org, 0xdeadbeefcafe #ff00aa 123e4567-e89b-12d3-a456-426614174000 " +
    "commit 3fa9c2e1b7 HTML JSON \\tfoobaz the cat";
  assert.deepEqual(extractWords(text).map((word) => word.word), ["mailto", "commit", "foobaz"]);
});

await test("apostrophes stay inside words", () => {
  // ("don't" is under four letters before its apostrophe: not checked.)
  assert.deepEqual(extractWords("don't touch the user's data, it isnt ours").map((word) => word.word), ["touch", "user's", "data", "isnt", "ours"]);
});

await test("suggestions keep the misspelling's case", () => {
  assert.equal(matchCase("Recieve", "receive"), "Receive");
  assert.equal(matchCase("RECIEVE", "receive"), "RECEIVE");
  assert.equal(matchCase("recieve", "receive"), "receive");
  assert.equal(matchCase("javascrip", "JavaScript"), "JavaScript");
});

// --- Dictionary ------------------------------------------------------------------------

function loadDictionary(name: string): Dictionary {
  const directory = path.join(root, "node_modules", name);
  const english = expandDictionary(
    parseAffixFile(fs.readFileSync(path.join(directory, "index.aff"), "utf8")),
    fs.readFileSync(path.join(directory, "index.dic"), "utf8"),
  );
  const terms = fs
    .readFileSync(path.join(root, "node_modules/@cspell/dict-software-terms/dict/software-tools.txt"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  return new Dictionary(english, [...PROGRAMMING_TERMS.split(/\s+/).filter(Boolean), ...terms]);
}

const started = Date.now();
const us = loadDictionary("dictionary-en");
const loadMs = Date.now() - started;
const gb = loadDictionary("dictionary-en-gb");

await test(`the en-US dictionary expands affixes (${us.size} words in ${loadMs} ms)`, () => {
  assert.ok(us.size > 100_000, `only ${us.size} words`);
  for (const word of ["receive", "received", "receiving", "unhappy", "profiles", "happily", "running", "categories", "Monday", "user's", "don't"]) {
    assert.ok(us.has(word), `${word} should be known`);
  }
});

await test("misspellings are unknown, case-insensitively", () => {
  for (const word of ["recieve", "teh", "seperate", "Profle", "definately", "occurence"]) assert.ok(!us.has(word), `${word} should be unknown`);
  assert.ok(us.has("PROFILE") && us.has("Profile"));
});

await test("programming terms and keywords are known", () => {
  for (const word of ["async", "config", "kwargs", "stdout", "middleware", "localhost", "tooltip", "webpack", "readonly", "configs", "Kubernetes"]) {
    assert.ok(us.has(word), `${word} should be known`);
  }
});

await test("US and GB spellings differ", () => {
  assert.ok(us.has("color") && !us.has("colour"));
  assert.ok(gb.has("colour"));
});

await test("suggestions rank the likely word first", () => {
  assert.equal(us.suggest("recieve")[0], "receive");
  assert.equal(us.suggest("seperate")[0], "separate");
  assert.equal(us.suggest("occured")[0], "occurred");
  assert.equal(us.suggest("profle")[0], "profile");
  assert.equal(us.suggest("functon")[0], "function");
  assert.equal(us.suggest("teh")[0], "the");
  // Keyboard neighbours: "wprld" (p next to o).
  assert.equal(us.suggest("wprld")[0], "world");
  assert.ok(us.suggest("definately").includes("definitely"));
  assert.ok(us.suggest("recieve").length <= 5);
});

await test("typo distance: neighbouring keys and swaps cost less", () => {
  assert.ok(typoDistance("wprld", "world") < typoDistance("wzrld", "world"));
  assert.ok(typoDistance("teh", "the") < typoDistance("tah", "the"));
  assert.equal(typoDistance("same", "same"), 0);
  assert.equal(typoDistance("abcdef", "uvwxyz", 1.5), Infinity);
});

// --- What gets checked -------------------------------------------------------------------

const highlighter = await createHighlighterCore({
  themes: [],
  langs: [import("@shikijs/langs/tsx"), import("@shikijs/langs/css"), import("@shikijs/langs/html"), import("@shikijs/langs/markdown")],
  engine: createJavaScriptRegexEngine(),
});

/** Scopes for every token of `text`'s lines (root scope included). */
function tokenize(language: string, text: string) {
  const grammar = highlighter.getLanguage(language);
  let state = INITIAL;
  return text.split("\n").map((line) => {
    const result = grammar.tokenizeLine(line, state, 500);
    state = result.ruleStack;
    return result.tokens.map((token) => ({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes }));
  });
}

function checkedWords(language: string, text: string, prose = false): string[] {
  return tokenize(language, text)
    .flat()
    .filter((token) => isCheckedToken(token.scopes.slice(1), prose))
    .flatMap((token) => extractWords(token.text).map((word) => word.word));
}

await test("code: comments, strings and identifiers are checked; keywords, imports and builtins aren't", () => {
  const words = checkedWords(
    "tsx",
    'import { thing } from "lodashh-es";\n// a commment here\nconst getUserProfileId = fetchh("hello wrold");\nconsole.log(/abcdefg/);\nfunction doSomething() { return true; }',
  );
  assert.deepEqual(words, ["thing", "commment", "here", "User", "Profile", "fetchh", "hello", "wrold", "console", "Something"]);
});

await test("HTML: text is checked, tag and attribute names aren't", () => {
  assert.deepEqual(checkedWords("html", '<section class="wrapper">Hello wolrd</section>'), ["wrapper", "Hello", "wolrd"]);
});

await test("Markdown: prose is checked, code spans and links aren't", () => {
  assert.deepEqual(checkedWords("markdown", "Some txet with `codde` and [a link](https://exampel.com)\n```js\nlet varrr\n```", true), [
    "Some",
    "txet",
    "with",
    "link",
  ]);
});

await test("cspell directives in a file", () => {
  const directives = fileDirectives(["// cspell:ignore foobaz quxx", "a", "// cspell:disable-next-line", "b", "/* cspell:disable */", "c", "// cspell:enable", "d"]);
  assert.deepEqual([...directives.words], ["foobaz", "quxx"]);
  assert.deepEqual([...directives.disabledLines].sort(), [3, 4, 5, 6]);
});

// --- Workspace dictionary (.vscode/settings.json) ------------------------------------------

await test("workspace words: new file, existing array, other settings and comments kept", () => {
  assert.deepEqual(wordsFromVscodeSettings(addWordToVscodeSettings(null, "foobaz")), ["foobaz"]);
  const existing = '{\n  // editor\n  "editor.tabSize": 4,\n  "cSpell.words": ["zeta", "alpha"]\n}\n';
  const updated = addWordToVscodeSettings(existing, "mango");
  assert.deepEqual(wordsFromVscodeSettings(updated), ["alpha", "mango", "zeta"]);
  assert.ok(updated.includes("// editor") && updated.includes('"editor.tabSize": 4'));
  const without = '{\n  "editor.tabSize": 4 // four\n}\n';
  const added = addWordToVscodeSettings(without, "kiwi");
  assert.deepEqual(wordsFromVscodeSettings(added), ["kiwi"]);
  assert.ok(added.includes("// four"), added);
  assert.deepEqual(wordsFromVscodeSettings(addWordToVscodeSettings("{}", "fig")), ["fig"]);
});

// --- Emmet: where it applies -----------------------------------------------------------------

/** The Emmet syntax at the end of `text` (the cursor), with real TextMate scopes. */
function syntaxAtEnd(language: string, monacoLanguage: string, file: string, text: string) {
  const lines = tokenize(language, text);
  const last = lines[lines.length - 1];
  const lastLine = text.split("\n").pop()!;
  const found = abbreviationBefore(lastLine, lastLine.length, ["css", "scss", "less"].includes(language) ? "stylesheet" : "markup");
  if (!found) return null;
  const scopes = last.length ? last[last.length - 1].scopes : [];
  const before = text.slice(0, text.length - (lastLine.length - found.start));
  return emmetSyntaxAt({ languageId: monacoLanguage, path: file, scopes, textBefore: before, abbreviation: found.abbreviation });
}

await test("Emmet applies in HTML text, not in comments, attributes or scripts", () => {
  assert.deepEqual(syntaxAtEnd("html", "html", "/a/index.html", "<body>\n  ul>li*3"), { type: "markup", syntax: "html" });
  assert.equal(syntaxAtEnd("html", "html", "/a/index.html", "<!-- ul>li*3"), null);
  assert.equal(syntaxAtEnd("html", "html", "/a/index.html", '<div class="ul>li'), null);
  assert.equal(syntaxAtEnd("html", "html", "/a/index.html", "<script>\nlet a = b.c"), null);
  assert.deepEqual(syntaxAtEnd("html", "html", "/a/index.html", "<style>\n.a {\n  m10"), { type: "stylesheet", syntax: "css" });
});

await test("Emmet applies in JSX, not in plain JavaScript, strings or comments", () => {
  const component = "function App() {\n  return (\n    <div>\n      ul>li.item";
  assert.deepEqual(syntaxAtEnd("tsx", "typescript", "/a/App.tsx", component), { type: "markup", syntax: "jsx" });
  assert.deepEqual(syntaxAtEnd("tsx", "typescript", "/a/App.tsx", "function App() {\n  return (\n    div.card"), { type: "markup", syntax: "jsx" });
  assert.equal(syntaxAtEnd("tsx", "typescript", "/a/App.tsx", "const a = 1;\nfoo.bar"), null);
  assert.equal(syntaxAtEnd("tsx", "typescript", "/a/App.tsx", "// ul>li"), null);
  assert.equal(syntaxAtEnd("tsx", "typescript", "/a/App.tsx", 'const s = "ul>li'), null);
  // .ts files never have JSX.
  assert.equal(syntaxAtEnd("tsx", "typescript", "/a/app.ts", "function App() {\n  return (\n    <div>\n      ul>li"), null);
  assert.ok(jsxExpressionStart("  return (\n    ", "div.card"));
  assert.ok(!jsxExpressionStart("  foo(", "div.card"));
  assert.ok(!jsxExpressionStart("  return ", "items.map"));
});

await test("Emmet applies in CSS rule bodies only", () => {
  assert.deepEqual(syntaxAtEnd("css", "css", "/a/a.css", ".a {\n  m10"), { type: "stylesheet", syntax: "css" });
  assert.equal(syntaxAtEnd("css", "css", "/a/a.css", "/* .a { m10"), null);
  assert.equal(syntaxAtEnd("css", "css", "/a/a.css", "m10"), null);
  assert.equal(syntaxAtEnd("css", "css", "/a/a.css", ".a {\n  color: re"), null);
});

await test("Vue/Svelte without a grammar: markup outside <script>, CSS in <style>", () => {
  const at = (text: string) => {
    const line = text.split("\n").pop()!;
    const found = abbreviationBefore(line, line.length, "markup")!;
    return emmetSyntaxAt({ languageId: "plaintext", path: "/a/App.vue", scopes: null, textBefore: text.slice(0, text.length - line.length + found.start), abbreviation: found.abbreviation });
  };
  assert.deepEqual(at("<template>\n  ul>li"), { type: "markup", syntax: "html" });
  assert.equal(at("<script>\nfoo.bar"), null);
  assert.deepEqual(at("<style>\n.a {\n  df"), { type: "stylesheet", syntax: "css" });
});

// --- Emmet: expansion ---------------------------------------------------------------------------

const html = { type: "markup", syntax: "html" } as const;
const jsx = { type: "markup", syntax: "jsx" } as const;
const css = { type: "stylesheet", syntax: "css" } as const;

await test("markup expansions become snippets with tab stops", () => {
  assert.equal(expandToSnippet("ul>li*2", html), "<ul>\n\t<li>${1}</li>\n\t<li>${2}</li>\n</ul>");
  assert.equal(expandToSnippet("a", html), '<a href="${1}">${2}</a>');
  assert.equal(snippetPreview(expandToSnippet("ul>li*2", html)!), "<ul>\n  <li></li>\n  <li></li>\n</ul>");
  assert.equal(expandToSnippet("hello", html), null, "plain words aren't abbreviations");
  assert.equal(expandToSnippet("ul>>li", html), null, "invalid abbreviations aren't expanded");
});

await test("JSX: className, htmlFor and self-closing tags", () => {
  assert.equal(expandToSnippet("div.card>img", jsx), '<div className="card"><img src="${1}" alt="${2}" /></div>');
  assert.equal(expandToSnippet("label[for=x]", jsx), '<label htmlFor="x">${1}</label>');
  assert.equal(expandToSnippet("Button", jsx), "<Button>${1}</Button>");
});

await test("CSS abbreviations", () => {
  assert.equal(expandToSnippet("m10", css), "margin: 10px;");
  assert.equal(expandToSnippet("p10-20", css), "padding: 10px 20px;");
  assert.equal(expandToSnippet("bgc#fff", css), "background-color: #fff;");
  assert.equal(expandToSnippet("df", css), "display: flex;");
  assert.equal(expandToSnippet("jcsb", css), "justify-content: space-between;");
  assert.equal(expandToSnippet("xyz", css), null);
  assert.equal(expandToSnippet("foo", css), null);
});

await test("snippet text escapes $ and }", () => {
  assert.equal(expandToSnippet("p", html, ["costs $5 {x}"]), "<p>costs \\$5 {x\\}</p>");
});

await test("abbreviation extraction around the cursor", () => {
  assert.deepEqual(abbreviationBefore("  <div>ul>li*3", 14, "markup"), { abbreviation: "ul>li*3", start: 7, end: 14 });
  assert.equal(abbreviationBefore("  ul>li ", 8, "markup"), null);
});

// --- Emmet: tag structure -----------------------------------------------------------------------

await test("tags pair up, skipping comments, scripts, void tags and JSX expressions", () => {
  const text = '<div id="a"><!-- <p> --><img src="x"><p onClick={() => a > b}>hi</p><script>if (a<b) {}</script></div>';
  const elements = parseElements(text);
  assert.deepEqual(elements.map((element) => [element.name, !!element.close]), [["div", true], ["img", false], ["p", true], ["script", true]]);
});

await test("balance outward and inward", () => {
  const text = "<ul>\n  <li>one</li>\n</ul>";
  const elements = parseElements(text);
  const cursor = text.indexOf("one") + 1;
  const content = balanceOutward(elements, { start: cursor, end: cursor })!;
  assert.equal(text.slice(content.start, content.end), "one");
  const li = balanceOutward(elements, content)!;
  assert.equal(text.slice(li.start, li.end), "<li>one</li>");
  const ulContent = balanceOutward(elements, li)!;
  assert.equal(text.slice(ulContent.start, ulContent.end), "\n  <li>one</li>\n");
  const whole = { start: 0, end: text.length };
  const inner = balanceInward(elements, whole)!;
  assert.equal(text.slice(inner.start, inner.end), "\n  <li>one</li>\n");
  const child = balanceInward(elements, inner)!;
  assert.equal(text.slice(child.start, child.end), "<li>one</li>");
});

await test("matching pair, remove tag, update tag", () => {
  const text = "<div>\n  <span>text</span>\n</div>";
  const elements = parseElements(text);
  const to = matchingPair(elements, 2)!;
  assert.equal(text.slice(to - 1, to + 5), "</div>");
  assert.equal(matchingPair(elements, to), 1);
  const span = elementAt(elements, text.indexOf("text"))!;
  assert.equal(span.name, "span");
  const apply = (edits: { start: number; end: number; text: string }[]) =>
    [...edits].sort((a, b) => b.start - a.start).reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
  assert.equal(apply(removeTagEdits(text, elementAt(elements, 0)!)), "  <span>text</span>\n");
  assert.equal(apply(updateTagEdits(span, "strong")), "<div>\n  <strong>text</strong>\n</div>");
});

// --- Breadcrumbs: symbols at the cursor --------------------------------------------------------------

await test("breadcrumb symbols: flat outlines nest by range; the path follows the cursor", () => {
  const node = (name: string, startLine: number, endLine: number, children: SymbolNode[] = []): SymbolNode => ({
    name,
    detail: "",
    kind: 4,
    range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 2 },
    selectionRange: { startLineNumber: startLine, startColumn: 1, endLineNumber: startLine, endColumn: 2 },
    children,
  });
  // Monaco's HTML outline lists elements flat.
  const tree = nestByRange([node("div", 3, 5), node("html", 1, 10), node("p", 4, 4), node("body", 2, 9), node("footer", 7, 8)]);
  assert.deepEqual(tree.map((symbol) => symbol.name), ["html"]);
  assert.deepEqual(symbolPathAt(tree, { lineNumber: 4, column: 1 }).map((symbol) => symbol.name), ["html", "body", "div", "p"]);
  assert.deepEqual(symbolPathAt(tree, { lineNumber: 7, column: 1 }).map((symbol) => symbol.name), ["html", "body", "footer"]);
  const path = symbolPathAt(tree, { lineNumber: 4, column: 1 });
  assert.deepEqual(siblingsAt(tree, path, 3).map((symbol) => symbol.name), ["p"]);
  assert.deepEqual(siblingsAt(tree, path, 2).map((symbol) => symbol.name), ["div", "footer"]);
  assert.deepEqual(symbolPathAt(tree, { lineNumber: 12, column: 1 }), []);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
