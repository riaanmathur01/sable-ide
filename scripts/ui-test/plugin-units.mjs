// Unit tests of the Sable plugins in plugins/, each loaded from its main.js
// into the fake `sable` host (fake-plugin-host.mjs) — no browser, Vite or
// bridge. Exact outputs for realistic inputs and edge cases (empty
// selections, unicode, CRLF, invalid input and its error message…), going
// deeper than plugin-smoke.mjs:
//
//   case-converter, json-tools, csv-tools, encode-decode, hash-tools
//   (against node:crypto), text-transforms, sort-lines, sql-formatter,
//   quote-toggler, markdown-toc, markdown-table, markdown-lint,
//   color-tools, number-tools, timestamp-tools, insert-utilities, clock,
//   pomodoro, whitespace-linter, word-frequency, word-count,
//   selection-stats, file-info, find-regex, bookmarks, license-header,
//   gitignore-generator, web-search, todo-finder, emoji-completions,
//   python-snippets, react-snippets
//
// Time-dependent plugins run with Date frozen and TZ=UTC.
//
//   node scripts/ui-test/plugin-units.mjs
process.env.TZ = "UTC";

import path from "node:path";
import crypto from "node:crypto";
import { checker, PLUGINS } from "./helpers.mjs";
import { activatePlugin, freezeDate, flush } from "./fake-plugin-host.mjs";

const { check, known, finish } = checker();
const started = Date.now();
const show = (value) => JSON.stringify(value);

/** Activate a plugin on a document; fails loudly if activation throws. */
async function setup(id, doc, options = {}) {
  const { host, module, activateError } = await activatePlugin(path.join(PLUGINS, id), { doc, ...options });
  if (activateError) throw new Error(`${id} failed to activate: ${activateError.stack ?? activateError}`);
  host.module = module;
  return host;
}
/** Activate, run one command, return the host. */
async function after(id, command, doc, options = {}) {
  const host = await setup(id, doc, options);
  const result = await host.run(command);
  if (!result.ok) host.state.errors.push(`THREW: ${result.error?.message}`);
  return host;
}
const doc = (language, extension) => (text, extra = {}) => ({ path: `/work/file.${extension}`, language, text, ...extra });
const txt = doc("plaintext", "txt");
const md = doc("markdown", "md");
const js = doc("javascript", "js");
const css = doc("css", "css");
const py = doc("python", "py");
const sqlDoc = doc("sql", "sql");
const json = doc("json", "json");
/** A quick-pick answer choosing the item with this label. */
const pickLabel = (label) => (items) => items.findIndex((item) => (typeof item === "string" ? item : item.label) === label);
const lastError = (host) => host.state.errors.at(-1) ?? null;
const lastMessage = (host) => host.state.messages.at(-1) ?? null;

function section(name) {
  console.log(`\n${name}`);
}

// --- case-converter ------------------------------------------------------------------------
section("case-converter");
{
  let h = await after("case-converter", "camel", txt("⟦first name\n  last name\n\nage⟧"));
  check("case: identifier cases convert line by line, keeping indentation and blank lines", h.text === "firstName\n  lastName\n\nage", show(h.text));
  h = await after("case-converter", "snake", txt("⟦XMLHttpRequest⟧"));
  check("case: XMLHttpRequest → xml_http_request", h.text === "xml_http_request", h.text);
  h = await after("case-converter", "snake", txt("⟦version2Update⟧"));
  check("case: digits before a capital split words (version2_update)", h.text === "version2_update", h.text);
  h = await after("case-converter", "pascal", txt("⟦über straße⟧"));
  check("case: unicode letters (ÜberStraße)", h.text === "ÜberStraße", h.text);
  h = await after("case-converter", "constant", txt("⟦kebab-case_mixed.dot⟧"));
  check("case: any separators → CONSTANT_CASE", h.text === "KEBAB_CASE_MIXED_DOT", h.text);
  h = await after("case-converter", "title", txt("⟦it's a dog's LIFE⟧"));
  check("case: Title Case keeps apostrophes in words", h.text === "It's A Dog's Life", h.text);
  h = await after("case-converter", "sentence", txt("⟦hello WORLD. how are you? fine⟧"));
  check("case: Sentence case after . and ?", h.text === "Hello world. How are you? Fine", h.text);
  h = await after("case-converter", "kebab", txt("const x‸ = 1"));
  check("case: no selection → error, text unchanged", lastError(h) === "Select the text to convert first" && h.text === "const x = 1", lastError(h));
  h = await after("case-converter", "convert", txt("a ⟦userName⟧ b"), { pick: pickLabel("snake_case") });
  const items = h.state.picks[0]?.items ?? [];
  check("case: Convert Case… previews every case", items.length === 10 && items.find((i) => i.label === "PascalCase")?.description === "UserName", show(items.map((i) => [i.label, i.description])));
  check("case: Convert Case… replaces with the chosen case", h.text === "a user_name b", h.text);
  h = await setup("case-converter", js("x"));
  check("case: rename suggestions (F2) in JS", show(await h.renameSuggestions("userName", "javascript")) === show(["UserName", "user_name", "USER_NAME"]), show(await h.renameSuggestions("userName", "javascript")));
  check("case: rename suggestions add kebab-case in CSS", show(await h.renameSuggestions("mainColor", "css")) === show(["MainColor", "main_color", "MAIN_COLOR", "main-color"]), show(await h.renameSuggestions("mainColor", "css")));
}

// --- json-tools ----------------------------------------------------------------------------
section("json-tools");
{
  let h = await after("json-tools", "format", json('{"b":1,"a":[1,2]}\n'));
  check("json: format (2 spaces, keeps the final newline)", h.text === '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}\n', show(h.text));
  h = await after("json-tools", "minify", json('{\n  "emoji": "😀",\n  "esc": "\\u00e9"\n}'));
  check("json: minify (unicode, escapes decoded)", h.text === '{"emoji":"😀","esc":"é"}', show(h.text));
  h = await after("json-tools", "sort", json('{"b":1,"a":{"d":1,"c":[{"z":1,"y":2}]}}'));
  check("json: sort keys recursively, minified stays minified", h.text === '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}', show(h.text));
  h = await after("json-tools", "sort", json('{\n  "b": 1,\n  "a": 2\n}\n'));
  check("json: sort keys of formatted JSON stays formatted", h.text === '{\n  "a": 2,\n  "b": 1\n}\n', show(h.text));
  h = await after("json-tools", "format", json('{\n  "a": 1,\n}'));
  check("json: trailing comma → error with line/column", lastError(h) === "Invalid JSON (line 3, column 1): Trailing comma before '}'", lastError(h));
  const d = h.diagnostics();
  check("json: …and a diagnostic there", d?.length === 1 && d[0].line === 3 && d[0].column === 1 && d[0].message === "Invalid JSON: Trailing comma before '}'" && d[0].severity === "error", show(d));
  check("json: invalid JSON is left alone", h.text === '{\n  "a": 1,\n}');
  h = await after("json-tools", "validate", json("{'a': 1}"));
  check("json: single quotes", lastError(h) === "Invalid JSON (line 1, column 2): Expected a property name in double quotes", lastError(h));
  h = await after("json-tools", "validate", js('const x = ⟦{"a": tru}⟧;'));
  check("json: error in a selection is placed in the file", /^Invalid JSON \(line 1, column 17\): Unexpected character 't'$/.test(lastError(h) ?? ""), lastError(h));
  h = await after("json-tools", "validate", js('x = ⟦[1, 2]⟧'));
  check("json: valid selection", lastMessage(h) === "The selection is valid JSON" && !h.state.errors.length, show(h.state.messages));
  h = await after("json-tools", "format", json("   \n"));
  check("json: empty file", lastError(h) === "The file is empty", lastError(h));
  h = await after("json-tools", "format", json('\uFEFF{"a":1}'));
  check("json: a byte-order mark is ignored", h.text === '{\n  "a": 1\n}', show(h.text));
  h = await after("json-tools", "minify", json('{"a": "unterminated'));
  check("json: unterminated string", /^Invalid JSON \(line 1, column \d+\): Unterminated string$/.test(lastError(h) ?? ""), lastError(h));
  h = await setup("json-tools", json("{,}"));
  h.state.diagnostics.set("/work/file.json", [{ line: 1, message: "old" }]);
  h.setDoc(json("{}"));
  await h.run("validate");
  check("json: valid JSON clears the old diagnostic", h.diagnostics() === null && lastMessage(h) === "Valid JSON", show(h.diagnostics()));
}

// --- csv-tools -----------------------------------------------------------------------------
section("csv-tools");
{
  let h = await after("csv-tools", "toJson", txt('name,age,active\nAda,36,true\n"Lovelace, A",007,false\n'));
  check(
    "csv: to JSON (typed values, quoted commas, 007 stays a string)",
    h.text === JSON.stringify([{ name: "Ada", age: 36, active: true }, { name: "Lovelace, A", age: "007", active: false }], null, 2) + "\n",
    h.text,
  );
  check("csv: …says how many rows and the separator", lastMessage(h) === "2 rows converted (comma-separated)", lastMessage(h));
  h = await after("csv-tools", "toJson", txt("a;b\n1;2"));
  check("csv: semicolons detected", h.text === '[\n  {\n    "a": 1,\n    "b": 2\n  }\n]' && lastMessage(h) === "1 row converted (semicolon-separated)", show([h.text, lastMessage(h)]));
  h = await after("csv-tools", "toJson", txt("a\tb\r\nx y\tz\r\n"));
  check("csv: tabs and CRLF", show(JSON.parse(h.text)) === show([{ a: "x y", b: "z" }]) && h.text.endsWith("\r\n") && lastMessage(h).includes("tab-separated"), show(h.text));
  h = await after("csv-tools", "toJson", txt("x,x,\n1,2,3"));
  check("csv: repeated and blank headers get numbered", show(JSON.parse(h.text)) === show([{ x: 1, x_2: 2, column3: 3 }]), h.text);
  h = await after("csv-tools", "toJson", txt('q\n"say ""hi""\nthere"'));
  check("csv: quoted newlines and doubled quotes", show(JSON.parse(h.text)) === show([{ q: 'say "hi"\nthere' }]), h.text);
  h = await after("csv-tools", "toJson", txt("a,b\n1"));
  check("csv: short rows get empty strings", show(JSON.parse(h.text)) === show([{ a: 1, b: "" }]), h.text);
  h = await after("csv-tools", "toJson", txt("only,a,header\n"));
  check("csv: header only → error", lastError(h) === "Need a header row and at least one row of CSV", lastError(h));
  h = await after("csv-tools", "fromJson", txt('[{"a":1,"b":"x,y"},{"a":2,"c":null}]'));
  check("csv: from JSON (union of columns, quoting, empty for missing/null)", h.text === 'a,b,c\n1,"x,y",\n2,,\n', show(h.text));
  h = await after("csv-tools", "fromJson", txt('[[1,2],["a b"," c"]]'));
  check("csv: array of arrays; padded values quoted", h.text === 'a b," c"\n'.replace(/^/, "1,2\n"), show(h.text));
  h = await after("csv-tools", "fromJson", txt('[{"a":{"x":1},"b":"say \\"hi\\""}]'));
  check("csv: nested objects as JSON, quotes doubled", h.text === 'a,b\n"{""x"":1}","say ""hi"""\n', show(h.text));
  h = await after("csv-tools", "fromJson", txt("[]"));
  check("csv: empty array → error", lastError(h) === "Expected an array of objects", lastError(h));
  h = await after("csv-tools", "fromJson", txt("{nope"));
  check("csv: invalid JSON → error", /^Not valid JSON: /.test(lastError(h) ?? "") && h.text === "{nope", lastError(h));
  h = await after("csv-tools", "align", txt("name,age\nAda,36\nAlan Turing,41\n"));
  check("csv: align columns", h.text === "name,        age\nAda,         36\nAlan Turing, 41\n", show(h.text));
  h.setDoc(txt(h.text));
  await h.run("shrink");
  check("csv: shrink undoes align", h.text === "name,age\nAda,36\nAlan Turing,41\n", show(h.text));
  h = await after("csv-tools", "align", txt('city,note\n"Zürich","a, b"\n日本,x'));
  check("csv: align counts code points; keeps needed quotes", h.text === 'city,   note\nZürich, "a, b"\n日本,     x', show(h.text));
}

// --- encode-decode -------------------------------------------------------------------------
section("encode-decode");
{
  const run = (command, text) => after("encode-decode", command, txt(text));
  let h = await run("base64Encode", "héllo 😀");
  check("encode: Base64 of UTF-8", h.text === Buffer.from("héllo 😀").toString("base64"), h.text);
  h = await run("base64Decode", Buffer.from("héllo 😀").toString("base64").replace(/(.{4})/g, "$1\n"));
  check("decode: Base64 with line breaks", h.text === "héllo 😀", h.text);
  h = await run("base64Decode", Buffer.from(">>>?").toString("base64url"));
  check("decode: URL-safe Base64 without padding", h.text === ">>>?", h.text);
  h = await run("base64Decode", "abc$");
  check("decode: invalid Base64 → error", lastError(h) === "Base64 Decode: That isn't valid Base64" && h.text === "abc$", lastError(h));
  h = await run("base64Decode", "abcde");
  check("decode: impossible Base64 length → error", lastError(h) === "Base64 Decode: That isn't valid Base64", lastError(h));
  h = await run("base64Decode", "//4=");
  check("decode: binary data → error", lastError(h) === "Base64 Decode: The decoded Base64 is binary data, not UTF-8 text", lastError(h));
  h = await run("urlEncode", "a b&c=d/é");
  check("encode: URL", h.text === "a%20b%26c%3Dd%2F%C3%A9", h.text);
  h = await run("urlDecode", "a%20b%26c%3Dd%2F%C3%A9");
  check("decode: URL", h.text === "a b&c=d/é", h.text);
  h = await run("urlDecode", "100%");
  check("decode: broken % → error", lastError(h) === "URL Decode: That isn't valid URL encoding (a stray or broken %)", lastError(h));
  h = await run("htmlEscape", `<a href="x">Tom & 'Jerry'</a>`);
  check("encode: HTML", h.text === "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;", h.text);
  h = await run("htmlUnescape", "&copy; &#169; &#xA9; &unknown; &#0; &hellip; &lt;b&gt;");
  check("decode: HTML (named, decimal, hex; unknown and impossible kept)", h.text === "© © © &unknown; &#0; … <b>", h.text);
  h = await run("jsonEscape", 'say "hi"\n\ttab\\');
  check("encode: JSON string", h.text === 'say \\"hi\\"\\n\\ttab\\\\', h.text);
  h = await run("jsonUnescape", '"line\\nnext \\u00e9 \\"q\\""');
  check("decode: JSON string (surrounding quotes dropped)", h.text === 'line\nnext é "q"', show(h.text));
  h = await run("jsonUnescape", "bad \\x");
  check("decode: invalid JSON escape → error", lastError(h) === "JSON String Unescape: Invalid escape \\x", lastError(h));
  h = await run("base64Encode", "");
  check("encode: empty file → error", lastError(h) === "Nothing to convert: the file is empty", lastError(h));
  h = await after("encode-decode", "base64Encode", txt("pre ⟦hi⟧ post"));
  check("encode: only the selection", h.text === "pre aGk= post", h.text);
}

// --- hash-tools ----------------------------------------------------------------------------
section("hash-tools");
{
  const digest = (algorithm, text) => crypto.createHash(algorithm).update(text, "utf8").digest("hex");
  for (const [command, algorithm] of [["sha1", "sha1"], ["sha256", "sha256"], ["sha384", "sha384"], ["sha512", "sha512"]]) {
    const h = await after("hash-tools", command, txt("x = ⟦héllo 😀⟧;"));
    check(`hash: ${command} of a unicode selection matches node:crypto`, h.text === `x = ${digest(algorithm, "héllo 😀")};`, h.text);
  }
  let h = await after("hash-tools", "sha256", txt("abc\n‸"));
  check("hash: no selection → the file's hash at the cursor", h.text === `abc\n${digest("sha256", "abc\n")}` && lastMessage(h) === "Inserted the file's SHA-256", show([h.text, lastMessage(h)]));
  h = await after("hash-tools", "sha1", txt("‸"));
  check("hash: empty file hashes the empty string", h.text === digest("sha1", ""), h.text);
  h = await after("hash-tools", "copy", txt("⟦secret⟧"), { pick: pickLabel("SHA-512") });
  check("hash: Copy Hash… lists every digest", show(h.state.picks[0].items.map((i) => i.label)) === show(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) && h.state.picks[0].items[1].description === digest("sha256", "secret"));
  check("hash: …copies the chosen one, text unchanged", h.state.clipboard === digest("sha512", "secret") && h.text === "secret" && lastMessage(h) === "Copied the SHA-512 hash", h.state.clipboard);
}

// --- text-transforms -----------------------------------------------------------------------
section("text-transforms");
{
  const run = (command, text) => after("text-transforms", command, txt(text));
  let h = await run("reverseText", "a👍🏽b");
  check("text: reverse keeps emoji with skin tones whole", h.text === "b👍🏽a", h.text);
  h = await run("rot13", "Hello, World!");
  check("text: ROT13", h.text === "Uryyb, Jbeyq!", h.text);
  h = await run("rot13", "123");
  check("text: nothing to change → message", lastMessage(h) === "ROT13: nothing to change", lastMessage(h));
  h = await run("slugify", "Héllo, Wörld!\n  Ça va?");
  check("text: slugify per line, accents dropped", h.text === "hello-world\nca-va", h.text);
  h = await run("trimTrailing", "a  \nb\t\r\nc\u00a0");
  check("text: trim trailing whitespace (keeps \\r, removes nbsp)", h.text === "a\nb\r\nc", show(h.text));
  h = await run("removeBlank", "a\n\n  \nb\n");
  check("text: remove blank lines, keep final newline", h.text === "a\nb\n", show(h.text));
  h = await run("joinLines", "  a\n b \n\nc\n");
  check("text: join lines", h.text === "a b c\n", show(h.text));
  h = await run("collapseSpaces", "  a   b\t\tc");
  check("text: collapse spaces, keep indentation", h.text === "  a b c", show(h.text));
  h = await run("numberLines", Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n"));
  check("text: number lines, padded", h.text.split("\n")[0] === " 1. l1" && h.text.split("\n")[9] === "10. l10", show(h.text));
  const words = Array.from({ length: 30 }, () => "abcd").join(" ");
  h = await run("wrap80", `  ${words}\nshort`);
  const fifteen = `  ${Array.from({ length: 15 }, () => "abcd").join(" ")}`;
  check("text: wrap at 80 keeps indentation", h.text === `${fifteen}\n${fifteen}\nshort`, show(h.text));
  h = await run("wrap80", `x ${"y".repeat(100)} z`);
  check("text: a word longer than 80 gets its own line", h.text === `x\n${"y".repeat(100)}\nz`, show(h.text));
  h = await run("reverseLines", "b\r\na");
  check("text: Reverse Lines in a CRLF file without a final newline keeps CRLF", h.text === "a\r\nb", show(h.text));
  h = await run("numberLines", "b\r\na\r\n");
  check("text: number lines in a CRLF file with a final newline", h.text === "1. b\r\n2. a\r\n", show(h.text));
  h = await after("text-transforms", "reverseLines", txt("keep\n⟦a\nb\nc⟧\nkeep"));
  check("text: only the selected lines", h.text === "keep\nc\nb\na\nkeep", show(h.text));
  h = await run("rot13", "");
  check("text: empty file → error", lastError(h) === "Nothing to transform: the file is empty", lastError(h));
}

// --- sort-lines ----------------------------------------------------------------------------
section("sort-lines");
{
  const run = (command, text) => after("sort-lines", command, txt(text));
  let h = await run("ascending", "file10\nfile2\nFile1\n");
  check("sort: natural, case-insensitive", h.text === "File1\nfile2\nfile10\n", show(h.text));
  h = await run("descending", "b\na\nc");
  check("sort: Z → A, no final newline added", h.text === "c\nb\na", show(h.text));
  h = await run("length", "ccc\na\nbb\nb");
  check("sort: by length, ties A → Z", h.text === "a\nb\nbb\nccc", show(h.text));
  h = await run("reverse", "1\n2\n3\n");
  check("sort: reverse", h.text === "3\n2\n1\n" && lastMessage(h) === "Reverse Lines: 3 lines", show([h.text, lastMessage(h)]));
  h = await run("shuffle", "1\n2\n3\n4\n5\n");
  check("sort: shuffle keeps the same lines", [...h.text.trim().split("\n")].sort().join() === "1,2,3,4,5" && h.text.endsWith("\n"), show(h.text));
  h = await after("sort-lines", "ascending", txt("z\n⟦c\nb\na⟧\ny"));
  check("sort: only the selection", h.text === "z\na\nb\nc\ny", show(h.text));
  h = await run("unique", "é\ne\u0301\né");
  check("sort: unique compares exact text", h.text === "é\ne\u0301", show(h.text));
  h = await run("ascending", "b\r\na\r\n");
  check("sort: CRLF file with a final newline", h.text === "a\r\nb\r\n", show(h.text));
  h = await run("unique", "a\r\nb\r\na");
  check("sort: Remove Duplicate Lines in a CRLF file without a final newline", h.text === "a\r\nb", show(h.text));
  h = await run("ascending", "b\r\na");
  check("sort: sorting a CRLF file without a final newline keeps CRLF", h.text === "a\r\nb", show(h.text));
}

// --- sql-formatter -------------------------------------------------------------------------
section("sql-formatter");
{
  const run = async (sql) => (await after("sql-formatter", "format", sqlDoc(sql))).text;
  check("sql: select list, WHERE with AND", (await run("select a, b from t where x = 1 and y = 2;\n")) === "SELECT\n  a,\n  b\nFROM t\nWHERE x = 1\n  AND y = 2;\n", show(await run("select a, b from t where x = 1 and y = 2;\n")));
  check("sql: strings untouched", (await run("select 'from where' as x from t")) === "SELECT\n  'from where' AS x\nFROM t", show(await run("select 'from where' as x from t")));
  check("sql: BETWEEN … AND stays on its line", (await run("select a from t where x between 1 and 5 and y = 2")) === "SELECT\n  a\nFROM t\nWHERE x BETWEEN 1 AND 5\n  AND y = 2", show(await run("select a from t where x between 1 and 5 and y = 2")));
  const joined = await run("select * from a left join b on a.id = b.id where a.x in (select y from c)");
  check("sql: joins and subqueries", joined === "SELECT\n  *\nFROM a\nLEFT JOIN b ON a.id = b.id\nWHERE a.x IN (\n  SELECT\n    y\n  FROM c\n)", show(joined));
  check("sql: other statements only get uppercase keywords", (await run("create table t (id int primary key, name text);")) === "CREATE TABLE t (id INT PRIMARY KEY, name text);", show(await run("create table t (id int primary key, name text);")));
  check("sql: statements separated by a blank line", (await run("select 1; select 2;")) === "SELECT\n  1;\n\nSELECT\n  2;", show(await run("select 1; select 2;")));
  const commented = await run("-- the users\nselect id -- key\nfrom users");
  check("sql: comments kept", commented === "-- the users\nSELECT\n  id -- key\nFROM users", show(commented));
  const h = await after("sql-formatter", "format", sqlDoc("keep this;\n⟦select a from b⟧\n"));
  check("sql: only the selection", h.text === "keep this;\nSELECT\n  a\nFROM b\n", show(h.text));
  const fh = await setup("sql-formatter", sqlDoc("select x from y"));
  check("sql: Format Document formatter for sql", (await fh.format()) === "SELECT\n  x\nFROM y", show(await fh.format()));
  check("sql: names that are often columns stay as written", (await run("select name, date, value from t")) === "SELECT\n  name,\n  date,\n  value\nFROM t", show(await run("select name, date, value from t")));
}

// --- quote-toggler -------------------------------------------------------------------------
section("quote-toggler");
{
  let h = await after("quote-toggler", "toggle", js("say('hel‸lo');"));
  check("quotes: ' → \" (cursor kept)", h.text === 'say("hello");' && h.state.doc.selection[0] === 8, show([h.text, h.state.doc.selection]));
  await h.run("toggle");
  check("quotes: \" → `", h.text === "say(`hello`);", h.text);
  await h.run("toggle");
  check("quotes: ` → '", h.text === "say('hello');", h.text);
  h = await after("quote-toggler", "toggle", js(`x = 'it\\'s "x‸"';`));
  check("quotes: escapes rewritten", h.text === `x = "it's \\"x\\"";`, h.text);
  h = await after("quote-toggler", "toggle", js("x = 'it\\'s ‸a';"));
  check("quotes: an escape dropped", h.text === `x = "it's a";`, h.text);
  check("quotes: the cursor stays before the same character when an escape is dropped", h.text.slice(h.state.doc.selection[0]).startsWith('a"'), show(h.text.slice(h.state.doc.selection[0])));
  h = await after("quote-toggler", "toggle", js('x = "cost ${‸x}";'));
  check("quotes: ${ escaped in a template literal", h.text === "x = `cost \\${x}`;", h.text);
  h = await after("quote-toggler", "toggle", js("x = `a${b‸}`;"));
  check("quotes: interpolated template → error", lastError(h) === "This template string has ${…}, so it can't use plain quotes" && h.text === "x = `a${b}`;", lastError(h));
  h = await after("quote-toggler", "toggle", js("x = ⟦`a\nb`⟧;"));
  check("quotes: selected multi-line template → error", lastError(h) === "This template string has ${…} or line breaks, so it can't use plain quotes", lastError(h));
  h = await after("quote-toggler", "toggle", js("x = ⟦'a'⟧ + 'b';"));
  check("quotes: a selected string", h.text === "x = \"a\" + 'b';", h.text);
  h = await after("quote-toggler", "toggle", js("let x‸ = 1;"));
  check("quotes: not in a string → error", lastError(h) === "Put the cursor in a quoted string first", lastError(h));
  h = await after("quote-toggler", "wrap", js("x = ⟦word⟧;"), { pick: pickLabel("**bold**") });
  check("quotes: wrap in **…**, wrapped text selected", h.text === "x = **word**;" && h.selection === "word", show([h.text, h.selection]));
  h = await after("quote-toggler", "wrap", js("x = ‸;"));
  check("quotes: wrap with no selection inserts a pair, cursor inside", h.text === "x = ();" && h.state.doc.selection.join() === "5,5", show([h.text, h.state.doc.selection]));
}

// --- markdown-toc --------------------------------------------------------------------------
section("markdown-toc");
{
  let h = await after("markdown-toc", "update", md("# Title\n\n‸\n\n## Install\n\n### From source\n\n## Usage `api`\n\n## Usage `api`\n"));
  const block = "<!-- toc -->\n\n- [Install](#install)\n  - [From source](#from-source)\n- [Usage api](#usage-api)\n- [Usage api](#usage-api-1)\n\n<!-- tocstop -->";
  check("toc: inserted at the cursor, nested, duplicate slugs numbered", h.text === `# Title\n\n${block}\n\n## Install\n\n### From source\n\n## Usage \`api\`\n\n## Usage \`api\`\n`, show(h.text));
  h = await after(
    "markdown-toc",
    "update",
    md("---\ntitle: x\n---\n# Doc\n\n```\n# not a heading\n```\n\nSetext Two\n----------\n\n#### Deep\n\n## What's **New**?\n‸"),
  );
  check(
    "toc: front matter, code fences, setext, skipped levels, formatting, punctuation",
    h.text.endsWith("<!-- toc -->\n\n- [Setext Two](#setext-two)\n  - [Deep](#deep)\n- [What's New?](#whats-new)\n\n<!-- tocstop -->"),
    show(h.text),
  );
  const stale = "# T\n\n<!-- toc -->\n- [Old](#old)\n<!-- tocstop -->\n\n## New\n";
  h = await after("markdown-toc", "update", md(stale));
  check("toc: updates between the markers", h.text === "# T\n\n<!-- toc -->\n\n- [New](#new)\n\n<!-- tocstop -->\n\n## New\n" && lastMessage(h) === "Table of contents updated", show(h.text));
  await h.run("update");
  check("toc: up to date the second time", lastMessage(h) === "Table of contents is up to date", lastMessage(h));
  h = await after("markdown-toc", "update", md("# T\r\n\r\n<!-- toc -->\r\n<!-- tocstop -->\r\n\r\n## A\r\n"));
  check("toc: CRLF files get CRLF lines", h.text === "# T\r\n\r\n<!-- toc -->\r\n\r\n- [A](#a)\r\n\r\n<!-- tocstop -->\r\n\r\n## A\r\n", show(h.text));
  h = await after("markdown-toc", "update", md("# T\n\n## C# & C++\n\n## 日本語 heading\n‸"));
  check("toc: GitHub slugs for punctuation and unicode", h.text.includes("- [C# & C++](#c--c)\n- [日本語 heading](#日本語-heading)"), show(h.text));
  h = await after("markdown-toc", "update", md("# Only a title\n"));
  check("toc: no headings → error", lastError(h) === "No headings to list (the first H1 is the title)", lastError(h));
  h = await after("markdown-toc", "update", txt("# x\n## y"));
  check("toc: not Markdown → error", lastError(h) === "Open a Markdown file first", lastError(h));
  h = await setup("markdown-toc", md(stale));
  await h.fire("didSave", { path: "/work/file.md" });
  check("toc: updated on save", h.text.includes("- [New](#new)") && lastMessage(h) === "Table of contents updated — save again to keep it", show(h.text));
  h = await setup("markdown-toc", md(stale));
  await h.fire("didSave", { path: "/work/other.md" });
  check("toc: saving another file leaves this one", h.text === stale);
}

// --- markdown-table ------------------------------------------------------------------------
section("markdown-table");
{
  let h = await after("markdown-table", "format", md("Intro\n\n| Name | Qty |\n|:--|--:|\n| apple | 3 |\n| kiwi fruit | 1‸2 |\n\nOutro"));
  check(
    "table: format with alignments",
    h.text === "Intro\n\n| Name       | Qty |\n| :--------- | --: |\n| apple      |   3 |\n| kiwi fruit |  12 |\n\nOutro" && lastMessage(h) === "Formatted 1 table",
    show(h.text),
  );
  await h.run("format");
  check("table: already formatted", lastMessage(h) === "Table is already formatted" && !h.state.errors.length, show([lastMessage(h), lastError(h)]));
  h = await after("markdown-table", "format", md("a|b|c‸\n1|2"));
  check("table: adds the delimiter row and fills short rows", h.text === "| a   | b   | c   |\n| --- | --- | --- |\n| 1   | 2   |     |", show(h.text));
  h = await after("markdown-table", "format", md("| x | y ‸|\n|---|:-:|\n| a \\| b | 日本 |"));
  check("table: escaped pipes, wide characters, centre alignment", h.text === "| x      |  y  |\n| ------ | :-: |\n| a \\| b | 日本  |", show(h.text));
  h = await after("markdown-table", "format", md("```\n| a | b ‸|\n```"));
  check("table: tables in code fences aren't tables", lastError(h) === "Put the cursor in a table (or select one) first", lastError(h));
  h = await after("markdown-table", "format", md("⟦| a | b |\n|-|-|\n| 1 | 2 |\n\ntext\n\n| c |\n|-|\n| 3 |⟧"));
  check("table: every table in the selection", lastMessage(h) === "Formatted 2 tables" && h.text.includes("| c   |\n| --- |"), show(h.text));
  h = await after("markdown-table", "fromCsv", md('⟦name,qty\n"a|b",2\n⟧'));
  check("table: CSV to table (pipes escaped)", h.text === "| name | qty |\n| ---- | --- |\n| a\\|b | 2   |\n", show(h.text));
  h = await after("markdown-table", "fromCsv", md("x‸"));
  check("table: CSV with no selection → error", lastError(h) === "Select the CSV to convert first", lastError(h));
  h = await after("markdown-table", "addRow", md("| a‸ | b |\n|---|---|\n| 1 | 2 |"));
  check("table: add row below the header goes under |---|", h.text === "| a   | b   |\n| --- | --- |\n|     |     |\n| 1   | 2   |", show(h.text));
  check("table: …cursor in the new row", show(h.snapshot().selection.start) === show({ line: 3, column: 3 }), show(h.snapshot().selection));
  h = await after("markdown-table", "addColumn", md("| a | b |\n|---|---|\n| 1 | ‸2 |"));
  check("table: add column after the cursor's", h.text === "| a   | b   |     |\n| --- | --- | --- |\n| 1   | 2   |     |", show(h.text));
  check("table: …cursor in the new cell", show(h.snapshot().selection.start) === show({ line: 3, column: 15 }), show(h.snapshot().selection));
  h = await after("markdown-table", "addRow", md("no table‸"));
  check("table: add row outside a table → error", lastError(h) === "Put the cursor in a table first", lastError(h));
}

// --- markdown-lint -------------------------------------------------------------------------
section("markdown-lint");
{
  const text = "# Title\n#### Skipped\nText  \ntrailing \n\n\n- a\n* b\n![](x.png) `![](ok)`\n```\ncode   \n```\nafter\n";
  let h = await setup("markdown-lint", md(text));
  const found = (h.diagnostics() ?? []).map((d) => [d.line, d.message]);
  const expected = [
    [1, "Add a blank line after this heading"],
    [2, "Heading level skips from h1 to h4 (expected h2)"],
    [2, "Add a blank line before this heading"],
    [2, "Add a blank line after this heading"],
    [4, "Trailing spaces"],
    [6, "Multiple consecutive blank lines"],
    [8, 'List marker "*" differs from "-" used earlier in this list'],
    [9, "Image has no alt text"],
    [10, "Add a blank line before this code block"],
    [12, "Add a blank line after this code block"],
  ];
  check("lint: the problems on activation", show(found) === show(expected), show(found));
  const d = h.diagnostics() ?? [];
  check("lint: warnings from Markdown Lint, precise columns", d.every((x) => x.severity === "warning" && x.source === "Markdown Lint") && d[4].column === 9 && d[4].endColumn === 10 && d[7].column === 1 && d[7].endColumn === 5, show(d[4]));
  await h.run("lint");
  check("lint: command reports the count", lastMessage(h) === "10 Markdown problems — see Problems", lastMessage(h));
  h = await after("markdown-lint", "lint", md("---\ntitle: a  \n---\n# T\n\nText\n"));
  check("lint: clean file (front matter ignored)", h.diagnostics() === null && lastMessage(h) === "No Markdown problems", show(h.diagnostics()));
  h = await setup("markdown-lint", md("Title\n=====\n\n### Deep\n"));
  check("lint: setext headings count for levels", show((h.diagnostics() ?? []).map((x) => x.message)) === show(["Heading level skips from h1 to h3 (expected h2)"]), show(h.diagnostics()));
  h = await setup("markdown-lint", md("- a\n  * nested\n- b\n\ntext\n\n* new list\n"));
  check("lint: nested lists and new lists may use other bullets", h.diagnostics() === null, show(h.diagnostics()));
  h = await after("markdown-lint", "lint", js("x  "));
  check("lint: not Markdown → error, nothing marked", lastError(h) === "Open a Markdown file first" && h.state.diagnostics.size === 0, lastError(h));
  h = await setup("markdown-lint", md("# T\n\nok\n"));
  h.setDoc(md("# T\ntext\n"));
  await h.fire("didChange", { path: "/work/file.md" });
  check("lint: re-lints as you type", (h.diagnostics() ?? []).length === 1, show(h.diagnostics()));
}

// --- color-tools ---------------------------------------------------------------------------
section("color-tools");
{
  let h = await setup("color-tools", css("a { color: #3366cc; } b { x: &#123; }"));
  const hover = await h.hover(1, 13);
  check(
    "color: hover shows hex, rgb and hsl",
    hover?.contents === "**Color** `#3366cc`\n\n- Hex: `#3366cc`\n- RGB: `rgb(51, 102, 204)`\n- HSL: `hsl(220, 60%, 50%)`" && show(hover.range) === show({ start: { line: 1, column: 12 }, end: { line: 1, column: 19 } }),
    show(hover),
  );
  check("color: no hover off a color, or on &#123;", (await h.hover(1, 3)) === null && (await h.hover(1, 33)) === null);
  const convert = async (text, label) => (await after("color-tools", "convert", css(text), { pick: pickLabel(label) })).text;
  check("color: hex → rgb at the cursor", (await convert("color: #ff‸0000;", "RGB")) === "color: rgb(255, 0, 0);");
  check("color: hsl → hex", (await convert("hsl(120, 100%, 2‸5%)", "Hex")) === "#008000", await convert("hsl(120, 100%, 2‸5%)", "Hex"));
  check("color: transparency kept (README's example)", (await convert("#ff0000‸80", "RGB")) === "rgba(255, 0, 0, 0.502)" && (await convert("#ff0000‸80", "HSL")) === "hsla(0, 100%, 50%, 0.502)", await convert("#ff0000‸80", "RGB"));
  check("color: modern space syntax", (await convert("rgb(255 0 0 / 5‸0%)", "Hex")) === "#ff000080", await convert("rgb(255 0 0 / 5‸0%)", "Hex"));
  h = await after("color-tools", "convert", css("⟦a: #fff; b: rgb(0, 0, 0);⟧"), { pick: pickLabel("HSL") });
  check("color: every color in the selection, still selected", h.text === "a: hsl(0, 0%, 100%); b: hsl(0, 0%, 0%);" && h.selection === h.text, show([h.text, h.selection]));
  h = await after("color-tools", "darken", css("rgb(255, 0, 0)‸"));
  check("color: darken keeps the format", h.text === "rgb(204, 0, 0)", h.text);
  h = await after("color-tools", "lighten", css("⟦#000 and #fff⟧"));
  check("color: lighten a selection (white stays white)", h.text === "#1a1a1a and #ffffff", h.text);
  h = await after("color-tools", "lighten", css("no color‸ here"));
  check("color: no color at the cursor → error", lastError(h) === "Put the cursor on a color (hex, rgb() or hsl()), or select some", lastError(h));
  h = await after("color-tools", "darken", css("⟦plain text⟧"));
  check("color: no color in the selection → error", lastError(h) === "No colors in the selection (hex, rgb() or hsl())", lastError(h));
}

// --- number-tools --------------------------------------------------------------------------
section("number-tools");
{
  const run = async (command, text, options) => (await after("number-tools", command, js(text), options)).text;
  check("number: increment at the cursor", (await run("increment", "let x = 25‸5;")) === "let x = 256;");
  check("number: decrement keeps leading zeros", (await run("decrement", "id = 00‸7")) === "id = 006", await run("decrement", "id = 00‸7"));
  check("number: a sign after a space", (await run("decrement", "x = -‸1")) === "x = -2", await run("decrement", "x = -‸1"));
  check("number: x-1 is subtraction", (await run("increment", "x-‸1")) === "x-2", await run("increment", "x-‸1"));
  check("number: the next number on the line", (await run("increment", "‸a = 9")) === "a = 10");
  check("number: every whole number in a selection (skips versions, decimals, hex)", (await run("increment", "⟦v1.2 has 3 items, 9 left, 0x10, 1.5⟧")) === "v1.2 has 4 items, 10 left, 0x10, 1.5", await run("increment", "⟦v1.2 has 3 items, 9 left, 0x10, 1.5⟧"));
  check("number: thousands separators", (await run("separators", "⟦1234567.891 and 999 and 12345⟧")) === "1,234,567.891 and 999 and 12,345", await run("separators", "⟦1234567.891 and 999 and 12345⟧"));
  let h = await after("number-tools", "separators", js("⟦12 and 345⟧"));
  check("number: nothing to separate → error", lastError(h) === "No numbers of 1,000 or more in the selection", lastError(h));
  check("number: convert 255 → hex", (await run("convert", "x = 2‸55;", { pick: pickLabel("Hex") })) === "x = 0xff;");
  check("number: convert 0b1010 → decimal", (await run("convert", "⟦0b1010⟧", { pick: pickLabel("Decimal") })) === "10");
  check("number: convert -0x1F → binary", (await run("convert", "⟦-0x1F⟧", { pick: pickLabel("Binary") })) === "-0b11111", await run("convert", "⟦-0x1F⟧", { pick: pickLabel("Binary") }));
  check("number: big numbers stay exact", (await run("convert", "⟦18446744073709551615⟧", { pick: pickLabel("Hex") })) === "0xffffffffffffffff");
  check("number: 1_000_000 → octal", (await run("convert", "⟦1_000_000⟧", { pick: pickLabel("Octal") })) === "0o3641100");
  h = await after("number-tools", "convert", js("⟦abc⟧"));
  check("number: convert non-number → error", lastError(h) === "Select a whole number, like 255, 0xff, 0b1010 or 0o17", lastError(h));
  h = await setup("number-tools", js("mask = 0xff; n = 7; big = 1024"));
  const hover = await h.hover(1, 9);
  check("number: hover shows every base", hover?.contents === "| Base | Value |\n| --- | --- |\n| Decimal | `255` |\n| Hex | `0xff` |\n| Binary | `0b11111111` |\n| Octal | `0o377` |", show(hover));
  check("number: no hover on a single digit", (await h.hover(1, 18)) === null);
  check("number: hover on 1024", (await h.hover(1, 29))?.contents.includes("`0x400`"), show(await h.hover(1, 29)));
}

// --- timestamp-tools -----------------------------------------------------------------------
section("timestamp-tools");
{
  const restore = freezeDate(Date.UTC(2023, 10, 17, 22, 13, 20, 456)); // 3 days after 1700000000
  try {
    const run = async (text) => {
      const h = await after("timestamp-tools", "convert", txt(text));
      return h.state.errors.length ? `ERROR ${lastError(h)}` : h.text;
    };
    check("time: seconds → ISO", (await run("⟦1700000000⟧")) === "2023-11-14T22:13:20Z");
    check("time: milliseconds → ISO", (await run("⟦1700000000123⟧")) === "2023-11-14T22:13:20.123Z");
    check("time: ISO → seconds, spaces kept", (await run("⟦ 2024-05-01T12:30:00Z ⟧")) === " 1714566600 ", await run("⟦ 2024-05-01T12:30:00Z ⟧"));
    check("time: date at the cursor (UTC midnight)", (await run("since 2024-05-‸01 end")) === "since 1714521600 end", await run("since 2024-05-‸01 end"));
    check("time: timestamp at the cursor", (await run("t=17000‸00000;")) === "t=2023-11-14T22:13:20Z;", await run("t=17000‸00000;"));
    check("time: offset date-time", (await run("⟦2024-05-01 14:30:00+02:00⟧")) === "1714566600", await run("⟦2024-05-01 14:30:00+02:00⟧"));
    check("time: not a date → error", (await run("⟦hello⟧")) === "ERROR Select a Unix timestamp or a date, like 1700000000 or 2024-05-01T12:30:00Z");
    check("time: out of range → error", (await run("⟦99999999999999999999⟧")) === "ERROR That timestamp is out of range");
    check("time: nothing at the cursor → error", (await run("‸ nothing")) === "ERROR Select a Unix timestamp or a date, or put the cursor on one");
    let h = await setup("timestamp-tools", txt("created 1700000000 and 17000000001"));
    const hover = await h.hover(1, 12);
    check(
      "time: hover (UTC, local, relative)",
      hover?.contents.startsWith("**Unix timestamp** (seconds)\n\n- UTC: `2023-11-14T22:13:20Z`\n- Local: ") && hover.contents.endsWith("- 3 days ago") && hover.range.start.column === 9,
      show(hover),
    );
    check("time: no hover inside an 11-digit number", (await h.hover(1, 28)) === null);
    h = await after("timestamp-tools", "insertUnix", txt("‸"));
    check("time: insert Unix timestamp", h.text === "1700259200", h.text);
    h = await after("timestamp-tools", "insertIso", txt("‸"));
    check("time: insert ISO (whole seconds)", h.text === "2023-11-17T22:13:20Z", h.text);
    h = await setup("timestamp-tools", txt("in 1800000000 s"));
    check("time: future timestamps (about N years)", (await h.hover(1, 5))?.contents.endsWith("- 1,154 days from now (about 3.2 years)"), show(await h.hover(1, 5)));
  } finally {
    restore();
  }
}

// --- insert-utilities, clock, pomodoro -----------------------------------------------------
section("insert-utilities, clock, pomodoro");
{
  const restore = freezeDate(Date.UTC(2026, 2, 1, 9, 5, 7));
  try {
    const run = async (command) => (await after("insert-utilities", command, txt("[‸]"))).text;
    check("insert: date", (await run("date")) === "[2026-03-01]");
    check("insert: time", (await run("time")) === "[09:05]");
    check("insert: ISO date-time", (await run("datetime")) === "[2026-03-01T09:05:07.000Z]");
    check("insert: Unix timestamp", (await run("timestamp")) === `[${Date.UTC(2026, 2, 1, 9, 5, 7) / 1000}]`);
    check("insert: lorem ipsum", /^\[Lorem ipsum dolor sit amet, .*consequat\.\]$/.test(await run("lorem")));
    const ids = new Set([await run("uuid"), await run("uuid")]);
    check("insert: UUIDs differ", ids.size === 2);
    const h = await after("insert-utilities", "date", null);
    check("insert: no file → error", lastError(h) === "Open a file first", lastError(h));

    let clock = await setup("clock", null, { storage: { hour12: false } });
    check("clock: 24-hour time in the status bar", clock.state.status?.text === "09:05" && clock.state.status.command === "toggle" && clock.state.status.tooltip.endsWith("click for 12-hour time"), show(clock.state.status));
    await clock.run("toggle");
    check("clock: toggle → 12-hour, remembered", /^9:05\s?AM$/i.test(clock.state.status?.text) && clock.state.storage.get("hour12") === true, show(clock.state.status));
    clock.module.deactivate();

    const pomodoro = await setup("pomodoro", null);
    check("pomodoro: idle status", pomodoro.state.status?.text === "🍅 0 today", show(pomodoro.state.status));
    await pomodoro.run("focus");
    check("pomodoro: focus started", pomodoro.state.status?.text === "🍅 25:00" && lastMessage(pomodoro) === "Focus started: 25 minutes", show([pomodoro.state.status, lastMessage(pomodoro)]));
    restore.set(Date.UTC(2026, 2, 1, 9, 30, 8));
    await new Promise((resolve) => setTimeout(resolve, 1100)); // its 1-second tick
    await flush();
    check(
      "pomodoro: a finished focus session counts",
      lastMessage(pomodoro) === "Focus session done (1 today) — time for a break" && show(pomodoro.state.storage.get("completed")) === show({ day: "2026-03-01", count: 1 }) && pomodoro.state.status?.text === "🍅 1 today",
      show([lastMessage(pomodoro), pomodoro.state.status]),
    );
    await pomodoro.run("toggle");
    await pomodoro.run("toggle");
    check("pomodoro: toggle starts then stops", lastMessage(pomodoro) === "Pomodoro stopped" && pomodoro.state.status?.text === "🍅 1 today", lastMessage(pomodoro));
    restore.set(Date.UTC(2026, 2, 2, 8, 0, 0));
    await pomodoro.run("break");
    check("pomodoro: a new day starts at 0", pomodoro.state.status?.text === "☕ 05:00" && pomodoro.state.status.tooltip.startsWith("Break · 0 focus sessions today"), show(pomodoro.state.status));
    pomodoro.module.deactivate();
  } finally {
    restore();
  }
}

// --- whitespace-linter ---------------------------------------------------------------------
section("whitespace-linter");
{
  let h = await setup("whitespace-linter", js("let a = 1;  \n\t  b();"));
  const d = h.diagnostics() ?? [];
  check(
    "ws: trailing whitespace, mixed indentation, missing final newline",
    show(d.map((x) => [x.line, x.column, x.endColumn, x.message, x.severity])) ===
      show([
        [1, 11, 13, "Trailing whitespace", "info"],
        [2, 1, 4, "Indentation mixes tabs and spaces", "info"],
        [2, 7, 8, "No newline at the end of the file", "hint"],
      ]),
    show(d),
  );
  h = await setup("whitespace-linter", md("text  \nmore \n"));
  check("ws: two trailing spaces are a Markdown line break", show((h.diagnostics() ?? []).map((x) => x.line)) === "[2]", show(h.diagnostics()));
  h = await setup("whitespace-linter", txt("a \r\nb\r\n"));
  check("ws: CRLF's \\r isn't trailing whitespace", show((h.diagnostics() ?? []).map((x) => [x.line, x.column, x.endColumn])) === "[[1,2,3]]", show(h.diagnostics()));
  h = await setup("whitespace-linter", js("/**\n\t * doc\n\t */\n"));
  check("ws: tab-indented block comments are fine", (h.diagnostics() ?? []).length === 0, show(h.diagnostics()));
  h = await after("whitespace-linter", "fix", js("a  \n\t  b \n"));
  check("ws: fix trailing whitespace (indentation left)", h.text === "a\n\t  b\n" && lastMessage(h) === "Fixed trailing whitespace and the final newline", show(h.text));
  check("ws: …and re-checks", show((h.diagnostics() ?? []).map((x) => x.message)) === show(["Indentation mixes tabs and spaces"]), show(h.diagnostics()));
  h = await after("whitespace-linter", "fix", txt("a \r\nb"));
  check("ws: fix adds a CRLF final newline in CRLF files", h.text === "a\r\nb\r\n", show(h.text));
  h = await after("whitespace-linter", "fix", md("line  \nend\n"));
  check("ws: fix keeps Markdown line breaks", lastMessage(h) === "No whitespace to fix" && h.text === "line  \nend\n", lastMessage(h));
  h = await after("whitespace-linter", "fix", txt("bin\u0000ary  "));
  check("ws: binary files are left alone", lastError(h) === "This looks like a binary file" && h.state.diagnostics.size === 0, lastError(h));
  h = await setup("whitespace-linter", txt("ok\n"));
  h.setDoc(txt("bad  \n"));
  await h.fire("didSave", { path: "/elsewhere.txt" });
  check("ws: an event for another file doesn't re-check this one", (h.diagnostics() ?? []).length === 0);
  await h.fire("didChange", { path: "/work/file.txt" });
  check("ws: re-checks on change", (h.diagnostics() ?? []).length === 1);
}

// --- word-frequency, word-count, selection-stats, file-info -------------------------------
section("word-frequency, word-count, selection-stats, file-info");
{
  let h = await after("word-frequency", "show", txt("The apple and the Apple; apple's banana, banana! cherry 42 x_y"), { pick: () => 1 });
  const pick = h.state.picks[0];
  check(
    "freq: counts, stop words and numbers left out, ties alphabetical",
    show(pick?.items.map((i) => [i.label, i.description])) === show([["apple", "2×"], ["banana", "2×"], ["apple's", "1×"], ["cherry", "1×"], ["x_y", "1×"]]),
    show(pick?.items.map((i) => [i.label, i.description])),
  );
  check("freq: placeholder", pick?.placeholder === "The 5 most frequent words in the file — choose one to copy it", pick?.placeholder);
  check("freq: chosen word copied", h.state.clipboard === "banana" && lastMessage(h) === "Copied “banana”", h.state.clipboard);
  h = await after("word-frequency", "show", txt("x ⟦Über über straße⟧"));
  check("freq: selection, unicode lowercased", show(h.state.picks[0]?.items.map((i) => i.label)) === show(["über", "straße"]) && h.state.picks[0].placeholder.includes("in the selection"), show(h.state.picks[0]?.items));
  h = await after("word-frequency", "show", txt("the and of 123"));
  check("freq: only stop words → message", lastMessage(h) === "No words in the file" && !h.state.picks.length, lastMessage(h));
  h = await after("word-frequency", "show", txt(Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ")));
  check("freq: at most 50 words", h.state.picks[0]?.items.length === 50);

  h = await setup("word-count", md("It’s a well-known fact: 3 cats_and 2 dogs. 😀"));
  check("count: words with apostrophes, hyphens and digits", h.state.status?.text === "8 words", h.state.status?.text);
  h = await setup("word-count", md(Array.from({ length: 1000 }, () => "word").join(" ")));
  check("count: thousands separator and reading time", h.state.status?.text === "1,000 words" && h.state.status.tooltip.startsWith("4,999 characters · about 4 min to read"), show(h.state.status));
  h = await setup("word-count", null);
  check("count: no file → status cleared", h.state.status === null);

  h = await setup("selection-stats", txt("x"));
  await h.fire("didChangeSelection", { path: "/work/file.txt", selection: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 }, text: "one two\nthree\n" } });
  check("sel: whole lines don't count the next line", h.state.status?.text === "14 chars · 3 words · 2 lines", h.state.status?.text);
  await h.fire("didChangeSelection", { path: "/work/file.txt", selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 }, text: "👍🏽 ok" } });
  check("sel: characters are code points (👍🏽 is 2), singular words", h.state.status?.text === "5 chars · 1 word · 1 line" && h.state.status.tooltip === "Selected: 5 characters, 1 word, 1 line", show(h.state.status));
  await h.fire("didChangeSelection", { path: "/work/file.txt", selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, text: "" } });
  check("sel: empty selection clears the status", h.state.status === null);

  h = await setup("file-info", py("a\r\nbb\r\n"));
  check("file: size, lines, CRLF", h.state.status?.text === "7 B · 3 lines · CRLF", h.state.status?.text);
  h = await setup("file-info", txt("é😀"));
  check("file: UTF-8 bytes, a single line", h.state.status?.text === "6 B · 1 line" && h.state.status.tooltip.includes("Line endings: none (a single line)"), show(h.state.status));
  h = await setup("file-info", txt("a\nb\r\n"));
  check("file: mixed line endings", h.state.status?.text.endsWith("Mixed"), h.state.status?.text);
  h = await setup("file-info", txt("x".repeat(2048)));
  check("file: KB", h.state.status?.text.startsWith("2.0 KB"), h.state.status?.text);
  h = await setup("file-info", txt("x".repeat(15000)));
  check("file: rounded KB", h.state.status?.text.startsWith("15 KB"), h.state.status?.text);
  h = await setup("file-info", py("def f():\n    if x:\n        y = 'longest line here'\n"));
  check(
    "file: tooltip (name, longest line, indentation)",
    show(h.state.status?.tooltip.split("\n")) ===
      show(["file.py", "Size: 51 bytes (UTF-8)", "Lines: 4", "Longest line: 31 characters (line 3)", "Line endings: LF", "Indentation: 4 spaces"]),
    show(h.state.status?.tooltip),
  );
  h = await setup("file-info", txt("a\n\tb\n\t\tc\n"));
  check("file: tabs", h.state.status?.tooltip.endsWith("Indentation: Tabs"), h.state.status?.tooltip);
  h = await setup("file-info", txt("a\n  b\n    c\n"));
  check("file: 2 spaces", h.state.status?.tooltip.endsWith("Indentation: 2 spaces"), h.state.status?.tooltip);
  h.setDoc(null);
  await h.fire("didChangeActiveEditor", { path: null });
  check("file: no file → status cleared", h.state.status === null);
}

// --- find-regex ----------------------------------------------------------------------------
section("find-regex");
{
  const text = "getName()\nsetName\ngetAge()";
  let h = await after("find-regex", "find", txt(text), { input: () => "\\bget\\w+", pick: () => 1 });
  const pick = h.state.picks[0];
  check("regex: matches listed with line numbers", show(pick?.items.map((i) => i.label)) === show(["1: getName", "3: getAge"]) && pick.items[1].detail === "getAge()", show(pick?.items));
  check("regex: placeholder", pick?.placeholder === "2 matches of /\\bget\\w+/g — choose one to select it", pick?.placeholder);
  check("regex: the chosen match is selected", h.selection === "getAge" && show(h.snapshot().selection.start) === show({ line: 3, column: 1 }), h.selection);
  await h.run("find");
  check("regex: the last pattern is offered again", h.state.inputs[1]?.value === "\\bget\\w+", show(h.state.inputs[1]));
  h = await after("find-regex", "find", txt(text), { input: () => "/NAME/i" });
  check("regex: /…/flags literal", h.state.picks[0]?.items.length === 2 && h.state.picks[0].items[1].label === "2: Name", show(h.state.picks[0]?.items.map((i) => i.label)));
  h = await after("find-regex", "find", txt("xa\nby"), { input: () => "/a\\nb/" });
  check("regex: multi-line matches", h.state.picks[0]?.items[0].label === "1: a⏎b" && show(h.snapshot().selection) === show({ start: { line: 1, column: 2 }, end: { line: 2, column: 2 }, text: "a\nb" }), show(h.snapshot().selection));
  h = await after("find-regex", "find", txt(text), { input: () => "(" });
  check("regex: invalid pattern → error", /^Invalid regular expression: /.test(lastError(h) ?? ""), lastError(h));
  h = await after("find-regex", "find", txt(text), { input: () => "zzz" });
  check("regex: no matches → message", lastMessage(h) === "No matches for /zzz/g", lastMessage(h));
  h = await after("find-regex", "find", txt(text), { input: () => null });
  check("regex: dismissed → nothing", !h.state.picks.length && !h.state.messages.length && !h.state.errors.length);
  h = await after("find-regex", "find", txt("a\nb"), { input: () => "^" });
  check("regex: empty matches", show(h.state.picks[0]?.items.map((i) => i.label)) === show(["1: (empty match)"]), show(h.state.picks[0]?.items.map((i) => i.label)));
  h = await after("find-regex", "find", txt("a\nb"), { input: () => "/^/m" });
  check("regex: ^ with the m flag matches every line start", show(h.state.picks[0]?.items.map((i) => i.label)) === show(["1: (empty match)", "2: (empty match)"]), show(h.state.picks[0]?.items.map((i) => i.label)));
}

// --- bookmarks -----------------------------------------------------------------------------
section("bookmarks");
{
  const file = "/work/src/app.js";
  const four = (cursorLine) => ({ path: file, language: "javascript", text: ["one", "two", "three", "four"].map((l, i) => (i === cursorLine - 1 ? `‸${l}` : l)).join("\n") + "\n" });
  let h = await after("bookmarks", "toggle", four(3));
  check("bookmarks: toggle adds", show(h.state.storage.get(file)) === "[3]" && h.state.status?.text === "🔖 1" && lastMessage(h) === "Bookmarked line 3", show([h.state.storage.get(file), h.state.status]));
  await h.run("toggle");
  check("bookmarks: toggle again removes (and the key)", !h.state.storage.has(file) && h.state.status === null && lastMessage(h) === "Removed the bookmark on line 3", show([...h.state.storage]));
  h = await setup("bookmarks", four(3), { storage: { [file]: [2, 4] } });
  check("bookmarks: status on activation", h.state.status?.text === "🔖 2" && h.state.status.tooltip === "Bookmarks on lines 2, 4 — click for the next one", show(h.state.status));
  await h.run("next");
  check("bookmarks: next", h.snapshot().selection.start.line === 4 && lastMessage(h) === "Bookmark 2 of 2: line 4", lastMessage(h));
  await h.run("next");
  check("bookmarks: next wraps", h.snapshot().selection.start.line === 2 && lastMessage(h) === "Bookmark 1 of 2: line 2", lastMessage(h));
  await h.run("previous");
  check("bookmarks: previous wraps", h.snapshot().selection.start.line === 4, h.snapshot().selection.start.line);
  h = await after("bookmarks", "next", four(1), { storage: { [file]: [10] } });
  check("bookmarks: bookmarks past the end are skipped", lastMessage(h) === "No bookmarks in this file — Toggle Bookmark adds one", lastMessage(h));
  h = await after("bookmarks", "list", four(1), {
    storage: { [file]: [1, 3], "/work/README.md": [1, 9], "/elsewhere/x.txt": [2] },
    files: { "README.md": "# Readme\n" },
    pick: pickLabel("README.md:1"),
  });
  check(
    "bookmarks: list across files",
    show(h.state.picks[0]?.items.map((i) => [i.label, i.description])) ===
      show([["/elsewhere/x.txt:2", "(can't read the file)"], ["README.md:1", "# Readme"], ["README.md:9", "(past the end of the file)"], ["src/app.js:1", "one"], ["src/app.js:3", "three"]]),
    show(h.state.picks[0]?.items.map((i) => [i.label, i.description])),
  );
  check("bookmarks: choosing one opens it and selects the line", show(h.state.opened) === show([{ path: "README.md", line: 1 }]) && h.selection === "# Readme", show([h.state.opened, h.selection]));
  h = await after("bookmarks", "clear", four(1), { storage: { [file]: [1, 2] } });
  check("bookmarks: clear", !h.state.storage.has(file) && lastMessage(h) === "Cleared 2 bookmarks", lastMessage(h));
  h = await after("bookmarks", "list", four(1));
  check("bookmarks: list with none → message", lastMessage(h) === "No bookmarks yet — Toggle Bookmark adds one", lastMessage(h));
}

// --- license-header, gitignore-generator ---------------------------------------------------
section("license-header, gitignore-generator");
{
  const restore = freezeDate(Date.UTC(2026, 2, 1));
  try {
    const author = { author: "Jane Doe" };
    const header = async (document, options = {}) => (await after("license-header", "insert", document, { storage: author, ...options })).text;
    check("license: JS header", (await header(js("console.log(1);\n"))) === "// Copyright (c) 2026 Jane Doe\n// SPDX-License-Identifier: MIT\n\nconsole.log(1);\n");
    check(
      "license: after a shebang and coding line",
      (await header(py("#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nprint(1)\n"), { pick: pickLabel("Apache-2.0") })) ===
        "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n# Copyright (c) 2026 Jane Doe\n# SPDX-License-Identifier: Apache-2.0\n\nprint(1)\n",
      await header(py("#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nprint(1)\n")),
    );
    check("license: CSS block comment", (await header(css("a {}\n"))) === "/*\n * Copyright (c) 2026 Jane Doe\n * SPDX-License-Identifier: MIT\n */\n\na {}\n", await header(css("a {}\n")));
    check(
      "license: HTML after the doctype",
      (await header({ path: "/work/i.html", language: "html", text: "<!DOCTYPE html>\n<html></html>\n" })) ===
        "<!DOCTYPE html>\n<!--\n  Copyright (c) 2026 Jane Doe\n  SPDX-License-Identifier: MIT\n-->\n\n<html></html>\n",
    );
    check("license: empty file", (await header(js(""))) === "// Copyright (c) 2026 Jane Doe\n// SPDX-License-Identifier: MIT\n", show(await header(js(""))));
    check(
      "license: a file that's only a shebang",
      (await header({ path: "/work/run.sh", language: "shell", text: "#!/bin/sh" })) === "#!/bin/sh\n# Copyright (c) 2026 Jane Doe\n# SPDX-License-Identifier: MIT\n",
      show(await header({ path: "/work/run.sh", language: "shell", text: "#!/bin/sh" })),
    );
    check("license: CRLF files", (await header(js("x;\r\n"))) === "// Copyright (c) 2026 Jane Doe\r\n// SPDX-License-Identifier: MIT\r\n\r\nx;\r\n", show(await header(js("x;\r\n"))));
    let h = await after("license-header", "insert", js("// SPDX-License-Identifier: MIT\nx\n"), { storage: author });
    check("license: already has one → warning", h.state.warnings.at(-1) === "This file already has a license header" && !h.state.picks.length);
    h = await after("license-header", "insert", txt("x"), { storage: author });
    check("license: unknown comment style → error", lastError(h) === "License Header doesn't know how to write a comment in plaintext", lastError(h));
    h = await after("license-header", "insert", js("x\n"), { input: () => "  Acme Corp " });
    check("license: asks for the holder once, trimmed and remembered", h.text.startsWith("// Copyright (c) 2026 Acme Corp\n") && h.state.storage.get("author") === "Acme Corp", show([h.text, h.state.storage.get("author")]));
    h = await after("license-header", "insert", js("x\n"), { input: () => null });
    check("license: dismissing the holder does nothing", h.text === "x\n");
    h = await after("license-header", "insert", js("x\n"), { storage: { ...author, license: "MPL-2.0" } });
    check("license: the last license used is offered first", h.state.picks[0]?.items[0].label === "MPL-2.0" && h.text.includes("SPDX-License-Identifier: MPL-2.0"), h.state.picks[0]?.items[0].label);
    h = await after("license-header", "createFile", null, { storage: author });
    const mit = h.state.files.get("LICENSE") ?? "";
    check("license: LICENSE file (MIT, full text)", mit.startsWith("MIT License\n\nCopyright (c) 2026 Jane Doe\n\nPermission is hereby granted") && mit.endsWith("SOFTWARE.\n") && lastMessage(h) === "Wrote LICENSE (MIT)", mit.slice(0, 80));
    check("license: …and opens it", show(h.state.opened) === show([{ path: "LICENSE", line: 0 }]));
    h = await after("license-header", "createFile", null, { storage: author, pick: pickLabel("Apache-2.0") });
    const apache = h.state.files.get("LICENSE") ?? "";
    check("license: Apache notice with a link", apache.startsWith("Apache License 2.0 (Apache-2.0)\n\nCopyright (c) 2026 Jane Doe\n\nLicensed under the Apache License") && apache.endsWith("The full license text: https://www.apache.org/licenses/LICENSE-2.0\n"), apache);
    h = await after("license-header", "createFile", null, { storage: author, files: { LICENSE: "old" }, pick: (items) => (items[0] === "Replace LICENSE" ? 1 : 0) });
    check("license: an existing LICENSE is kept on Cancel", h.state.files.get("LICENSE") === "old" && h.state.picks[1]?.placeholder === "LICENSE already exists", show(h.state.picks[1]));
    h = await after("license-header", "createFile", null, { storage: author, files: { LICENSE: "old" } });
    check("license: …and replaced on Replace", h.state.files.get("LICENSE")?.startsWith("MIT License"));
    h = await after("license-header", "createFile", null, { storage: author, root: null });
    check("license: no folder → error", lastError(h) === "Open a folder first", lastError(h));
    h = await after("license-header", "author", null, { storage: author, input: (o) => (o.value === "Jane Doe" ? "John Roe" : null) });
    check("license: change holder offers the current one", h.state.storage.get("author") === "John Roe" && lastMessage(h) === "License headers will name John Roe", lastMessage(h));
  } finally {
    restore();
  }

  let h = await after("gitignore-generator", "add", null);
  const node = h.state.files.get(".gitignore") ?? "";
  check("gitignore: new file from a template", node.startsWith("# Node\nnode_modules/\ndist/\n") && node.endsWith("*.tsbuildinfo\n") && lastMessage(h) === "Added the Node template to .gitignore", node);
  check("gitignore: …opened", h.state.opened.at(-1)?.path === ".gitignore");
  h = await after("gitignore-generator", "add", null, { files: { ".gitignore": "node_modules\n.env" } });
  const added = h.state.files.get(".gitignore") ?? "";
  check("gitignore: only missing lines, under a heading", added.startsWith("node_modules\n.env\n\n# Node\ndist/\n") && !added.includes("node_modules/") && !added.includes("\n.env\n.env"), show(added));
  h = await after("gitignore-generator", "add", null, { files: { ".gitignore": "target\n**/*.rs.bk\n*.pdb\n" }, pick: pickLabel("Rust") });
  check("gitignore: nothing missing → message, file unchanged", lastMessage(h) === ".gitignore already has everything in the Rust template" && h.state.files.get(".gitignore") === "target\n**/*.rs.bk\n*.pdb\n", lastMessage(h));
  h = await after("gitignore-generator", "add", null, { pick: pickLabel("macOS") });
  check("gitignore: macOS", h.state.files.get(".gitignore") === "# macOS\n.DS_Store\n.AppleDouble\n.LSOverride\n._*\n.Spotlight-V100\n.Trashes\n", show(h.state.files.get(".gitignore")));
  h = await after("gitignore-generator", "add", null, { root: null });
  check("gitignore: no folder → error", lastError(h) === "Open a folder first", lastError(h));
  h = await after("gitignore-generator", "add", null, { pick: () => null });
  check("gitignore: dismissed → nothing written", !h.state.files.has(".gitignore"));
}

// --- web-search ----------------------------------------------------------------------------
section("web-search");
{
  let h = await after("web-search", "google", js("x ⟦how to  sort\n arrays⟧"));
  check("web: selection, whitespace collapsed", h.state.external.at(-1) === "https://www.google.com/search?q=how%20to%20sort%20arrays", h.state.external.at(-1));
  h = await after("web-search", "mdn", js("const s = useSt‸ate();"));
  check("web: the word at the cursor", h.state.external.at(-1) === "https://developer.mozilla.org/en-US/search?q=useState", h.state.external.at(-1));
  h = await after("web-search", "docsrs", js("   ‸   "), { input: () => "rust traits" });
  check("web: no word → asks", h.state.external.at(-1) === "https://docs.rs/releases/search?query=rust%20traits" && h.state.inputs[0]?.prompt === "Search for", h.state.external.at(-1));
  h = await after("web-search", "npm", js("‸"), { input: () => null });
  check("web: dismissed → nothing opened", !h.state.external.length);
  h = await after("web-search", "search", js("⟦C++ & you⟧"), { pick: pickLabel("PyPI") });
  check("web: Search the Web… picks a site", h.state.external.at(-1) === "https://pypi.org/search/?q=C%2B%2B%20%26%20you" && h.state.picks[0].items.length === 7, h.state.external.at(-1));
}

// --- todo-finder ---------------------------------------------------------------------------
section("todo-finder");
{
  const text = "x // BUG: crash\n  # FIXME: y\n<!-- TODO: docs -->\n// XXX\nTODOS here\n# todo lower\n/* HACK: fast */";
  let h = await setup("todo-finder", js(text));
  const d = h.diagnostics() ?? [];
  check(
    "todo: tags, severities, comment closers stripped, whole words only",
    show(d.map((x) => [x.line, x.column, x.message, x.severity])) ===
      show([
        [1, 6, "BUG: crash", "warning"],
        [2, 5, "FIXME: y", "warning"],
        [3, 6, "TODO: docs", "info"],
        [4, 4, "XXX: (no description)", "info"],
        [7, 4, "HACK: fast", "warning"],
      ]),
    show(d.map((x) => [x.line, x.column, x.message, x.severity])),
  );
  check("todo: marks run to the end of the line, from TODO Finder", d.every((x) => x.source === "TODO Finder") && d[0].endColumn === 16, show(d[0]));
  await h.run("scan");
  check("todo: scan reports the count", lastMessage(h) === "5 TODOs — see Problems", lastMessage(h));
  await h.run("clear");
  check("todo: clear", h.state.diagnostics.size === 0);
  h = await after("todo-finder", "scan", js("clean\n"));
  check("todo: none → message", lastMessage(h) === "No TODOs in this file" && show(h.diagnostics()) === "[]", lastMessage(h));
  h = await after("todo-finder", "scan", js("// TODO one"));
  check("todo: singular", lastMessage(h) === "1 TODO — see Problems", lastMessage(h));
}

// --- completions: emoji, python, react ------------------------------------------------------
section("completions");
{
  let h = await setup("emoji-completions", md("x"));
  const all = await h.complete({ linePrefix: "Hi :" });
  check("emoji: ':' alone offers all, alphabetically", all.length > 50 && all[0].label === ":angry:" && all.every((i) => i.replace === 1), show(all.slice(0, 2)));
  check("emoji: typed text is lowercased", (await h.complete({ linePrefix: ":ROC" }))[0]?.insertText === "🚀");
  check("emoji: no trigger inside a word (a:b)", (await h.complete({ linePrefix: "a:b" })).length === 0);
  const heart = (await h.complete({ linePrefix: "(:heart" })).map((i) => i.label);
  check("emoji: prefix matches before substring matches", heart[0] === ":heart:" && heart.indexOf(":heart_eyes:") < heart.indexOf(":broken_heart:"), show(heart));
  check("emoji: not in JavaScript", (await h.complete({ linePrefix: ":roc", language: "javascript" })).length === 0);

  h = await setup("python-snippets", py("x"));
  const statement = await h.complete({ linePrefix: "    if" });
  check("python: every snippet where a statement starts", statement.length === 13 && statement.every((i) => i.snippet === true && i.kind === "snippet" && i.detail.endsWith("(Python snippet)")), show(statement.map((i) => i.label)));
  check("python: documentation shows the defaults", statement.find((i) => i.label === "withopen")?.documentation === 'with open("file.txt", "r", encoding="utf-8") as f:\n    data = f.read()', show(statement.find((i) => i.label === "withopen")?.documentation));
  check("python: ifmain body", statement.find((i) => i.label === "ifmain")?.insertText === 'if __name__ == "__main__":\n    ${1:main()}$0');
  check("python: only comprehensions inside an expression", show((await h.complete({ linePrefix: "x = [l" })).map((i) => i.label)) === show(["lc", "dc"]));
  check("python: nothing after a dot", (await h.complete({ linePrefix: "obj.l" })).length === 0);
  check("python: only for Python", (await h.complete({ linePrefix: "if", language: "javascript" })).length === 0);

  h = await setup("react-snippets", { path: "/work/src/user-card.jsx", language: "javascriptreact", text: "x" });
  let items = await h.complete({ linePrefix: "rf" });
  check("react: component name from the file name", items.find((i) => i.label === "rfc")?.insertText.startsWith("export default function ${1:UserCard}(${2:props}) {"), items.find((i) => i.label === "rfc")?.insertText);
  check("react: useState documentation", items.find((i) => i.label === "useState")?.documentation === "const [value, setValue] = useState(initialValue);", items.find((i) => i.label === "useState")?.documentation);
  items = await h.complete({ linePrefix: "rafce", path: "/work/components/nav-bar/index.tsx", language: "typescriptreact" });
  check("react: index files use the folder's name", items.find((i) => i.label === "rafce")?.insertText.endsWith("export default ${1:NavBar};"), items.find((i) => i.label === "rafce")?.insertText);
  items = await h.complete({ linePrefix: "r", path: "/work/123.jsx" });
  check("react: a name that can't be an identifier → Component", items.find((i) => i.label === "rfc")?.insertText.includes("${1:Component}"));
  check("react: nothing mid-expression", (await h.complete({ linePrefix: "foo(rf" })).length === 0);
  check("react: JS, TS, JSX and TSX", show(h.state.providers.map((p) => p.language)) === show(["javascriptreact", "typescriptreact", "javascript", "typescript"]));
}

console.log(`\nplugin units done in ${Date.now() - started} ms`);
finish();
