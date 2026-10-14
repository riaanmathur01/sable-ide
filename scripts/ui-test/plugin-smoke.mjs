// Smoke test of every Sable plugin in plugins/ (each folder with a
// sable-plugin.json and a main.js for the worker runtime), in a fake host
// (fake-plugin-host.mjs) — no browser, Vite or bridge. For each plugin:
//   - it loads as a single ES module and activate(sable) doesn't throw;
//   - it uses no API its manifest's permissions don't allow;
//   - every command its manifest names (keybindings) is registered;
//   - its registry.json entry matches the manifest (version, permissions);
//   - every registered command runs without throwing, on a sensible
//     document for that plugin and again with no file open;
//   - its event listeners and completion/hover/rename/formatter providers
//     run without throwing; deactivate() (if any) doesn't throw.
// Plus the original specific checks: word-count's status, todo-finder's
// marks, sort-lines, case-converter, insert-utilities and emoji completions.
// Converted VS Code extensions (vscode.*: Node runtime or themes only) are
// skipped, saying why; theme-only ones get a cheap "theme files exist" check.
//
//   node scripts/ui-test/plugin-smoke.mjs [plugins-dir]     (default: the repo's plugins/)
import fs from "node:fs";
import path from "node:path";
import { checker, PLUGINS } from "./helpers.mjs";
import { activatePlugin, flush } from "./fake-plugin-host.mjs";

const { check, finish } = checker();
const dir = path.resolve(process.argv[2] ?? PLUGINS);
const started = Date.now();

// A document per plugin that its commands make sense on ("⟦…⟧" selects, "‸" is the cursor).
const MD = "# Title\n\n## Install\n\nSome text. TODO: write more\n\n## Usage\n\n| a | b |\n|---|---|\n| 1 | 22‸ |\n";
const DOCS = {
  "word-count": { path: "/work/notes.md", language: "markdown", text: "Hello world, it's a test.\nSecond line here" },
  "todo-finder": { path: "/work/a.js", language: "javascript", text: "let x = 1; // TODO: fix this\n# FIXME later\nfine\n/* HACK */" },
  "sort-lines": { path: "/work/list.txt", text: "item 10\nItem 2\nbanana\nitem 10\n" },
  "case-converter": { path: "/work/a.js", language: "javascript", text: "const ⟦user profile ID⟧ = 1;\n" },
  "insert-utilities": { path: "/work/a.txt", text: "Date: ‸\n" },
  "emoji-completions": { path: "/work/a.md", language: "markdown", text: "Ship it :roc‸" },
  bookmarks: { path: "/work/src/app.js", language: "javascript", text: "one\ntwo\nthr‸ee\nfour\n" },
  "color-tools": { path: "/work/a.css", language: "css", text: "a { color: #ff‸0000; background: rgb(0, 128, 255); }\n" },
  "csv-tools": { path: "/work/data.csv", text: "name,age\nAda,36\nAlan,41\n" },
  "encode-decode": { path: "/work/a.txt", text: "⟦aGVsbG8=⟧\n" },
  "file-info": { path: "/work/a.py", language: "python", text: "def f():\n    return 1\n" },
  "find-regex": { path: "/work/a.txt", text: "sable one\nsable two\n" },
  "gitignore-generator": { path: "/work/a.txt", text: "" },
  "hash-tools": { path: "/work/a.txt", text: "⟦abc⟧" },
  "json-tools": { path: "/work/a.json", language: "json", text: '{"b": 1, "a": [1, 2]}\n' },
  "license-header": { path: "/work/a.js", language: "javascript", text: "console.log(1);\n" },
  "markdown-lint": { path: "/work/a.md", language: "markdown", text: "# Title\n#### Skipped\nText  \n" },
  "markdown-table": { path: "/work/a.md", language: "markdown", text: MD },
  "markdown-toc": { path: "/work/a.md", language: "markdown", text: "# Title\n\n‸\n\n## One\n\n## Two\n" },
  "number-tools": { path: "/work/a.js", language: "javascript", text: "let x = 25‸5;\n" },
  pets: { path: "/work/a.js", language: "javascript", text: "x" },
  "python-snippets": { path: "/work/a.py", language: "python", text: "if‸" },
  "quote-toggler": { path: "/work/a.js", language: "javascript", text: "say('hel‸lo');\n" },
  "react-snippets": { path: "/work/src/user-card.jsx", language: "javascriptreact", text: "rf‸" },
  "selection-stats": { path: "/work/a.txt", text: "⟦two words⟧" },
  "sql-formatter": { path: "/work/a.sql", language: "sql", text: "select a, b from t where x = 1 and y = 2;\n" },
  "text-transforms": { path: "/work/a.txt", text: "Hello  World  \n\nsecond line\n" },
  "timestamp-tools": { path: "/work/a.txt", text: "t = 17000000‸00\n" },
  "web-search": { path: "/work/a.js", language: "javascript", text: "useSt‸ate()\n" },
  "whitespace-linter": { path: "/work/a.js", language: "javascript", text: "let a = 1;  \n\t  b();" },
  "word-frequency": { path: "/work/a.txt", text: "apple banana apple the cherry apple banana" },
};
const FILES = { "README.md": "# Readme\n", "src/app.js": "one\ntwo\nthree\nfour\n" };

const registry = JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).plugins ?? [];
const describe = (error) => (error instanceof Error ? error.stack?.split("\n").slice(0, 2).join(" ") : String(error));

const folders = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "sable-plugin.json")))
  .map((entry) => entry.name)
  .sort();

let covered = 0;
const themeOnly = [];
for (const folder of folders) {
  const pluginDir = path.join(dir, folder);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "sable-plugin.json"), "utf8"));
  const id = manifest.id ?? folder;
  const main = path.join(pluginDir, manifest.main ?? "main.js");
  if (manifest.runtime === "node") {
    console.log(`skip ${id}: a converted VS Code extension on the Node runtime (needs the real Node plugin host; popular-plugins.mjs covers it)`);
    continue;
  }
  if (!fs.existsSync(main)) {
    if (manifest.themes?.length) themeOnly.push({ id, pluginDir, manifest });
    console.log(`skip ${id}: ${manifest.themes?.length ? "themes only, no code to run" : "no main.js"}`);
    continue;
  }
  covered++;
  console.log(`\n${id}`);
  check(`${id}: folder name is its id`, folder === id, `${folder} vs ${id}`);

  const entry = registry.find((plugin) => plugin.id === id);
  check(
    `${id}: registry entry matches the manifest`,
    entry && entry.version === manifest.version && JSON.stringify([...entry.permissions].sort()) === JSON.stringify([...(manifest.permissions ?? [])].sort()),
    entry ? `registry ${entry.version} ${entry.permissions} vs ${manifest.version} ${manifest.permissions}` : "not in registry.json",
  );

  const options = { doc: DOCS[id] ?? { path: "/work/a.txt", text: "Some text\n" }, files: FILES };
  const { host, module, activateError } = await activatePlugin(pluginDir, options);
  if (!check(`${id}: activates`, !activateError, describe(activateError))) continue;

  const commands = [...host.state.commands.keys()];
  const declared = (manifest.keybindings ?? []).map((binding) => binding.command);
  check(`${id}: registers its manifest's commands`, declared.every((command) => commands.includes(command)), `declared ${declared}, registered ${commands}`);
  const providers = host.state.providers.map((p) => p.kind);
  check(`${id}: contributes something`, commands.length || providers.length || host.state.listeners.size, "no commands, providers or listeners");

  // Every command, on a fresh copy of the document (and the folder's files).
  for (const command of commands) {
    host.setDoc(options.doc);
    host.state.files = new Map(Object.entries(FILES));
    const errorsBefore = host.state.errors.length;
    const result = await host.run(command);
    check(
      `${id}: ${command} runs`,
      result.ok,
      result.ok ? "" : describe(result.error),
    );
    if (host.state.errors.length > errorsBefore) console.log(`        (said: ${host.state.errors.at(-1).replace(/\s+/g, " ")})`);
  }
  // …and with no file open.
  host.setDoc(null);
  const noFile = [];
  for (const command of commands) {
    const result = await host.run(command);
    if (!result.ok) noFile.push(`${command}: ${result.error?.message ?? result.error}`);
  }
  if (commands.length) check(`${id}: every command runs with no file open`, !noFile.length, noFile.join("; "));

  // Events and providers.
  host.setDoc(options.doc);
  const docPath = host.state.doc.path;
  const active = host.snapshot();
  const eventErrors = [];
  for (const [event, payload] of [
    ["didOpen", { path: docPath }],
    ["didSave", { path: docPath }],
    ["didChange", { path: docPath }],
    ["didChangeActiveEditor", { path: docPath }],
    ["didChangeSelection", { path: docPath, selection: active.selection }],
    ["didChangeActiveEditor", { path: null }],
  ]) {
    for (const error of await host.fire(event, payload)) eventErrors.push(`${event}: ${error.message}`);
  }
  if (host.state.listeners.size) check(`${id}: event listeners run`, !eventErrors.length, eventErrors.join("; "));

  const providerErrors = [];
  for (const provider of host.state.providers) {
    try {
      const doc = host.state.doc;
      if (provider.kind === "completions") {
        const items = await host.complete({ language: provider.language === "*" ? doc.language : provider.language });
        if (!Array.isArray(items) || items.some((item) => typeof item.label !== "string")) providerErrors.push("completions: bad items");
      } else if (provider.kind === "hover") await host.hover(1, 12);
      else if (provider.kind === "rename") await host.renameSuggestions("someName");
      else if (provider.kind === "formatter") {
        const formatted = await provider.fn({ path: doc.path, language: doc.language, text: doc.text });
        if (typeof formatted !== "string") providerErrors.push("formatter: not a string");
      }
    } catch (error) {
      providerErrors.push(`${provider.kind}: ${error.message}`);
    }
  }
  if (host.state.providers.length) check(`${id}: providers answer (${providers.join(", ")})`, !providerErrors.length, providerErrors.join("; "));

  check(`${id}: uses only APIs its permissions allow`, !host.state.permissionErrors.length, JSON.stringify(host.state.permissionErrors.slice(0, 3)));
  check(`${id}: edits stay inside the document`, !host.state.invalidRanges.length, JSON.stringify(host.state.invalidRanges.slice(0, 3)));

  if (typeof module.deactivate === "function") {
    let error = null;
    try {
      await module.deactivate();
    } catch (caught) {
      error = caught;
    }
    check(`${id}: deactivates`, !error, describe(error));
  }
}

// Theme-only plugins: cheap to check that their theme files are there.
{
  const missing = [];
  let themes = 0;
  for (const { id, pluginDir, manifest } of themeOnly) {
    for (const theme of manifest.themes) {
      themes++;
      if (!theme.path || !fs.existsSync(path.join(pluginDir, theme.path))) missing.push(`${id}: ${theme.path}`);
    }
  }
  console.log("");
  check(`theme-only plugins: all ${themes} theme files of ${themeOnly.length} plugins exist`, !missing.length, missing.slice(0, 5).join("; "));
}

// --- The original specific checks -----------------------------------------------------------
console.log("\nspecific checks");
const plugin = (id) => path.join(dir, id);
const editor = (text, extra = {}) => ({ path: "/p/f.md", language: "markdown", text, ...extra });

{
  const { host } = await activatePlugin(plugin("word-count"), { doc: editor("Hello world, it's a test.\nSecond line here") });
  check("word-count: status", host.state.status?.text === "8 words", JSON.stringify(host.state.status));
  check("word-count: tooltip, click recounts", /^42 characters · about 1 min to read/.test(host.state.status?.tooltip) && host.state.status?.command === "count", host.state.status?.tooltip);
  host.setDoc(editor("one ⟦two three⟧ four"));
  await host.run("count");
  check("word-count: selection", host.state.status?.text === "2 words selected", host.state.status?.text);
}

{
  const { host } = await activatePlugin(plugin("todo-finder"), { doc: editor("let x = 1; // TODO: fix this\n# FIXME later\nfine\n/* HACK */") });
  const d = host.diagnostics();
  check("todo-finder: 3 marks", d?.length === 3, JSON.stringify(d?.map((x) => [x.line, x.severity, x.message])));
  check(
    "todo-finder: message/severity",
    d?.[0].message === "TODO: fix this" && d[0].severity === "info" && d[0].line === 1 && d[0].column === 15 &&
      d[1].message === "FIXME: later" && d[1].severity === "warning" && d[2].message === "HACK: (no description)" && d[2].severity === "warning",
    JSON.stringify(d),
  );
}

{
  const { host } = await activatePlugin(plugin("sort-lines"), { doc: editor("item 10\nItem 2\nbanana\nitem 10\n") });
  await host.run("ascending");
  check("sort-lines: natural A→Z, keeps final newline", host.text === "banana\nItem 2\nitem 10\nitem 10\n", JSON.stringify(host.text));
  host.setDoc(editor("item 10\nItem 2\nbanana\nitem 10\n"));
  await host.run("unique");
  check("sort-lines: unique", host.text === "item 10\nItem 2\nbanana\n", JSON.stringify(host.text));
}

{
  const cases = { camel: "userProfileId", pascal: "UserProfileId", snake: "user_profile_id", kebab: "user-profile-id", constant: "USER_PROFILE_ID", dot: "user.profile.id", title: "User Profile Id", sentence: "User profile id", upper: "USER PROFILE ID", lower: "user profile id" };
  for (const [id, expected] of Object.entries(cases)) {
    const { host } = await activatePlugin(plugin("case-converter"), { doc: editor("⟦user profile ID⟧") });
    await host.run(id);
    check(`case-converter: ${id}`, host.text === expected, host.text);
  }
  const { host } = await activatePlugin(plugin("case-converter"), { doc: editor("⟦parseHTTPResponse⟧") });
  await host.run("snake");
  check("case-converter: acronyms", host.text === "parse_http_response", host.text);
}

{
  const { host } = await activatePlugin(plugin("insert-utilities"), { doc: editor("x‸") });
  await host.run("uuid");
  check("insert-utilities: uuid", /^x[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(host.text), host.text);
  host.setDoc(editor("‸"));
  await host.run("date");
  check("insert-utilities: date", /^\d{4}-\d\d-\d\d$/.test(host.text), host.text);
}

{
  const { host } = await activatePlugin(plugin("emoji-completions"), { doc: editor("x") });
  const items = await host.complete({ linePrefix: "Ship it :roc" });
  check("emoji: :roc → rocket first", items[0]?.label === ":rocket:" && items[0].insertText === "🚀" && items[0].replace === 4, JSON.stringify(items[0]));
  check("emoji: no trigger in 12:30", (await host.complete({ linePrefix: "at 12:30" })).length === 0);
  const registered = host.state.providers.filter((p) => p.kind === "completions");
  check(
    "emoji: registered for markdown + plaintext with ':'",
    registered.map((p) => p.language).join() === "markdown,plaintext" && registered[0].triggerCharacters[0] === ":",
    JSON.stringify(registered.map((p) => [p.language, p.triggerCharacters])),
  );
}

await flush();
console.log(`\n${covered} plugins smoke-tested in ${Date.now() - started} ms`);
finish();
