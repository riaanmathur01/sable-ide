// End-to-end test of the Marketplace's converted VS Code extensions (the
// twelve popular ones in plugins/vscode.*): installs them from plugins/,
// runs them in the Node runtime against the real backend, and checks each
// one's main feature in the editor:
//
//   Live Server          serves the folder (fetched, with its reload script)
//   Prettier             Format Document gives Prettier's output
//   ESLint               reports the project's ESLint problems
//   YAML                 reports a duplicate key, and drops it once fixed
//   Path Intellisense    completes a folder in an import path
//   Auto Close Tag       typing <section> adds </section>
//   Tailwind CSS         completes Tailwind classes in class=""
//   indent-rainbow       colours the indentation
//   Error Lens           shows ESLint's messages at the ends of the lines
//   Markdown All in One  creates a table of contents
//   Rainbow CSV          colours each column differently
//   Better Comments      colours ! alerts, ? questions, TODOs and * notes
//
// Needs Node.js and npm (ESLint and Tailwind are installed into the test
// project with npm, which needs the network the first time).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/popular-plugins.mjs
//
// with a freshly started Vite and the bridge (README → Testing), e.g.
//   npx vite --port 1588 --strictPort
//   (cd src-tauri && SABLE_UI_BRIDGE_PORT=1589 SABLE_UI_PLUGINS_DIR=$(mktemp -d) \
//      SABLE_UI_HISTORY_DIR=$(mktemp -d) cargo test --lib ui_bridge -- --ignored)
//   SABLE_UI_VITE_PORT=1588 SABLE_UI_BRIDGE_PORT=1589 node scripts/ui-test/popular-plugins.mjs
//
// SABLE_UI_PLUGINS_DIR matters: the test installs the plugins, replacing
// any with the same ids.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openSable, sleep } from "./driver.mjs";

const BRIDGE_PORT = process.env.SABLE_UI_BRIDGE_PORT ?? "1531";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shots = process.env.SHOTS ?? path.join(os.tmpdir(), "sable-popular-plugins-shots");
fs.mkdirSync(shots, { recursive: true });

const PLUGINS = [
  "vscode.ritwickdey.liveserver",
  "vscode.esbenp.prettier-vscode",
  "vscode.dbaeumer.vscode-eslint",
  "vscode.redhat.vscode-yaml",
  "vscode.christian-kohler.path-intellisense",
  "vscode.formulahendry.auto-close-tag",
  "vscode.bradlc.vscode-tailwindcss",
  "vscode.oderwat.indent-rainbow",
  "vscode.usernamehw.errorlens",
  "vscode.yzhang.markdown-all-in-one",
  "vscode.mechatroner.rainbow-csv",
  "vscode.aaron-bond.better-comments",
];

// --- The project ------------------------------------------------------------------------------
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sable-popular-")));
const write = (relative, text) => {
  fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
  fs.writeFileSync(path.join(workspace, relative), text);
};
write("package.json", JSON.stringify({ name: "popular-plugins-test", version: "1.0.0", type: "module", private: true }, null, 2) + "\n");
write("eslint.config.js", 'export default [{ rules: { "no-unused-vars": "error", "no-var": "error" } }];\n');
write("tailwind.config.cjs", 'module.exports = { content: ["./*.html"], theme: { extend: {} }, plugins: [] };\n');
write("format.js", "const  a = {b:1,c:2}\nfunction f( x ){return x+1}\n");
write("lint.js", "var x = 1;\nconst unused = 2;\nconsole.log(x);\n");
write("config.yaml", "name: demo\nname: again\nitems:\n  - one\n");
write("src/lib/util.js", "export const util = 1;\n");
write("paths.js", 'import { util } from "./src/";\n');
write("page.html", "<html>\n<body>\n\n</body>\n</html>\n");
write("tw.html", '<div class="p-4"></div>\n<div class="bg-red-"></div>\n');
write("indent.py", "def f(x):\n    if x:\n        for i in range(3):\n            print(i)\n    return x\n");
write("guide.md", "# Guide\n\n## Install\n\ntext\n\n## Usage\n\n### Advanced\n");
write("data.csv", "name,age,city,country\nAlice,30,Paris,France\nBob,25,Berlin,Germany\n");
write("comments.py", "x = 0\n# ! Deprecated: do not use\n# ? Why is this here\n# TODO: refactor this\n# * An important note\n");
console.log(`project: ${workspace}\n  npm install eslint@9 tailwindcss@3 …`);
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "eslint@9", "tailwindcss@3"], { cwd: workspace, stdio: "inherit" });

// --- Install the plugins (from plugins/, as the Marketplace would) ----------------------------
const bridge = async (cmd, args) => {
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/invoke`, { method: "POST", body: JSON.stringify({ cmd, args }) });
  const result = await response.json();
  if (result.err) throw new Error(`${cmd}: ${result.err}`);
  return result.ok;
};
for (const id of PLUGINS) {
  const installed = await bridge("plugin_install", { path: path.join(repo, "plugins", id), link: false, source: null });
  if (installed.manifest.id !== id) throw new Error(`installed ${installed.manifest.id}, not ${id}`);
}

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

// Live Server: no browser, and any free port.
// YAML: don't ask about telemetry (its prompt would take the keyboard).
const storage = {
  "vscode.ritwickdey.liveserver": {
    "config:liveServer.settings.NoBrowser": true,
    "config:liveServer.settings.port": 0,
    // Its "Server is now offline" message has a button, so it would wait as a picker.
    "config:liveServer.settings.donotShowInfoMsg": true,
  },
  "vscode.redhat.vscode-yaml": { "config:redhat.telemetry.enabled": false },
};
const { browser, page, errors } = await openSable(workspace, {
  pollEvents: true,
  init: `(() => {
    if (window !== window.top) return;
    for (const [id, values] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem("sable.plugin." + id, JSON.stringify(values));
  })()`,
});

/** Poll fn in the page until it returns something truthy. */
async function waitFor(fn, args = [], { timeout = 30000, what = "condition" } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(fn, ...args).catch((error) => ({ error: String(error) }));
    if (last && !last.error) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

// The app's own modules (Vite serves them; the page already loaded them).
const open = (file) =>
  page.evaluate(async (file) => {
    const { useTabsStore } = await import("/src/store/tabsStore.ts");
    await useTabsStore.getState().openFile(file);
  }, path.join(workspace, file));
const setCursor = (line, column) =>
  page.evaluate(
    async (line, column) => {
      const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
      editor.focus();
      editor.setPosition({ lineNumber: line, column });
    },
    line,
    column,
  );
const runAction = (id) =>
  page.evaluate(async (id) => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    await editor.getAction(id).run();
  }, id);
const suggestions = () =>
  page.evaluate(() => [...document.querySelectorAll(".suggest-widget .monaco-list-row")].map((row) => row.getAttribute("aria-label") ?? row.innerText));
const runCommand = (title) =>
  page.evaluate(async (title) => {
    const { usePluginStore } = await import("/src/store/pluginStore.ts");
    const entry = usePluginStore.getState().commands.find((candidate) => candidate.command.title === title);
    if (!entry) throw new Error(`no command ${title}`);
    usePluginStore.getState().runCommand(entry.pluginId, entry.command.handler);
  }, title);
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

try {
  // --- Every plugin runs in Node -----------------------------------------------------------
  const states = await waitFor(
    async (ids) => {
      const { usePluginStore } = await import("/src/store/pluginStore.ts");
      const { states } = usePluginStore.getState();
      return ids.every((id) => states[id] === "running" || states[id] === "error") ? states : null;
    },
    [PLUGINS],
    { timeout: 60000, what: "the plugins to start" },
  );
  for (const id of PLUGINS) check(states[id] === "running", `${id} is running`);
  const logs = await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().logs);
  for (const id of PLUGINS) {
    const problems = (logs[id] ?? []).filter((line) => line.level === "error" && !/DeprecationWarning|DEP0\d+|trace-deprecation/.test(line.text));
    if (problems.length) console.log(`      ${id} logged: ${problems.map((line) => line.text.split("\n")[0]).join(" | ")}`);
  }

  // --- Prettier --------------------------------------------------------------------------------
  await open("format.js");
  await sleep(1500);
  await runAction("editor.action.formatDocument");
  const formatted = await waitFor(async () => {
    const value = (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.getValue();
    return value?.includes("return x + 1;") ? value : null;
  }, [], { what: "Prettier to format" }).catch(() => null);
  check(formatted === "const a = { b: 1, c: 2 };\nfunction f(x) {\n  return x + 1;\n}\n", "Prettier: Format Document gives Prettier's output");

  // --- ESLint + Error Lens -----------------------------------------------------------------
  await open("lint.js");
  const lintMarkers = await waitFor(
    async () => {
      const { getEditor, whenMonaco } = await import("/src/lib/editorRegistry.ts");
      const monaco = await whenMonaco();
      const list = monaco.editor.getModelMarkers({ resource: getEditor().getModel().uri }).filter((marker) => marker.source === "eslint");
      return list.length >= 2 ? list.map((marker) => `${marker.startLineNumber}: ${marker.message}`) : null;
    },
    [],
    { timeout: 45000, what: "ESLint's problems" },
  ).catch(() => []);
  check(lintMarkers.some((message) => message.startsWith("1:") && /Unexpected var/.test(message)), `ESLint: no-var reported on line 1 (${lintMarkers.join(" | ")})`);
  check(lintMarkers.some((message) => message.startsWith("2:") && /'unused' is assigned a value but never used/.test(message)), "ESLint: no-unused-vars reported on line 2");
  const lens = await waitFor(
    async () => {
      // (The editor renders spaces as no-break spaces.)
      const after = [...document.querySelectorAll(".view-lines [class*='plugin-deco-vscode-usernamehw-errorlens'][class*='-after']")].map((element) => element.textContent.replace(/\s/g, " "));
      return after.length >= 2 ? after : null;
    },
    [],
    { what: "Error Lens's messages" },
  ).catch(() => []);
  check(lens.some((message) => /Unexpected var/.test(message)), "Error Lens: the ESLint message shows in the line");
  const lensPlacement = await page.evaluate(() => {
    const message = [...document.querySelectorAll(".view-lines [class*='plugin-deco-vscode-usernamehw-errorlens'][class*='-after']")].find((element) => /Unexpected\svar/.test(element.textContent));
    const code = [...document.querySelectorAll(".view-line")].find((line) => line.textContent.replace(/\s/g, " ").startsWith("var x = 1;"));
    if (!message || !code) return null;
    const codeEnd = [...code.querySelectorAll("span span")].filter((span) => span.textContent.trim() && !span.className.includes("errorlens")).pop();
    return message.getBoundingClientRect().left >= (codeEnd?.getBoundingClientRect().right ?? 0) - 1;
  });
  check(lensPlacement === true, "Error Lens: …after the code, at the end of the line");
  await shot("eslint-errorlens");

  // --- YAML ------------------------------------------------------------------------------
  await open("config.yaml");
  const yamlMarkers = await waitFor(
    async () => {
      const { getEditor, whenMonaco } = await import("/src/lib/editorRegistry.ts");
      const monaco = await whenMonaco();
      const list = monaco.editor.getModelMarkers({ resource: getEditor().getModel().uri });
      return list.length ? list.map((marker) => `${marker.startLineNumber}: ${marker.message}`) : null;
    },
    [],
    { timeout: 45000, what: "YAML's problems" },
  ).catch(() => []);
  check(yamlMarkers.some((message) => message.startsWith("2:") && /Map keys must be unique/.test(message)), "YAML: the duplicate key is reported");
  // Fix it by typing: the language server follows the edit (incremental sync).
  await setCursor(2, 1);
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.keyboard.type("title: again", { delay: 20 });
  const cleared = await waitFor(
    async () => {
      const { getEditor, whenMonaco } = await import("/src/lib/editorRegistry.ts");
      const monaco = await whenMonaco();
      return monaco.editor.getModelMarkers({ resource: getEditor().getModel().uri }).length === 0;
    },
    [],
    { timeout: 20000, what: "YAML to clear the problem" },
  ).catch(() => false);
  check(cleared === true, "YAML: the problem goes away once the key is renamed (it sees the edits)");

  // --- Path Intellisense -------------------------------------------------------------------
  await open("paths.js");
  await sleep(500);
  await setCursor(1, 29); // after "./src/"
  await runAction("editor.action.triggerSuggest");
  const pathItems = await waitFor(
    () => {
      const rows = [...document.querySelectorAll(".suggest-widget .monaco-list-row")].map((row) => row.innerText.replace(/\n/g, " "));
      return rows.length ? rows : null;
    },
    [],
    { what: "path completions" },
  ).catch(() => []);
  check(pathItems.some((row) => /^lib\b/.test(row) && /Path Intellisense/.test(row)), `Path Intellisense: completes ./src/ with lib (${pathItems.slice(0, 3).join(" · ")})`);
  await shot("path-intellisense");
  await page.keyboard.press("Escape");

  // --- Auto Close Tag ----------------------------------------------------------------------
  await open("page.html");
  await sleep(500);
  await setCursor(3, 1);
  await page.keyboard.type("<section>", { delay: 40 });
  const closed = await waitFor(async () => {
    const value = (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.getValue();
    return value?.includes("</section>") ? value : null;
  }, [], { timeout: 10000, what: "the closing tag" }).catch(() => null);
  check(closed?.split("\n")[2] === "<section></section>", "Auto Close Tag: typing <section> adds </section>");
  // It puts the cursor back between the tags once its edit is in.
  const cursor = await waitFor(async () => {
    const position = (await import("/src/lib/editorRegistry.ts")).getEditor().getPosition();
    return position.column === 10 ? position : null;
  }, [], { timeout: 5000, what: "the cursor" }).catch(() => page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().getPosition()));
  check(cursor.lineNumber === 3 && cursor.column === 10, `Auto Close Tag: the cursor stays between the tags (${cursor.lineNumber}:${cursor.column})`);

  // --- Live Server -------------------------------------------------------------------------
  await runCommand("Open with Live Server");
  const port = await waitFor(
    async () => {
      const { usePluginStore } = await import("/src/store/pluginStore.ts");
      const match = /Port : (\d+)/.exec(usePluginStore.getState().statusItems["vscode.ritwickdey.liveserver"]?.text ?? "");
      return match ? Number(match[1]) : null;
    },
    [],
    { what: "Live Server to start" },
  ).catch(() => null);
  check(port !== null, `Live Server: started (status bar: Port : ${port})`);
  if (port) {
    const served = await fetch(`http://127.0.0.1:${port}/page.html`).then((response) => response.text()).catch((error) => String(error));
    check(served.includes("<section></section>") && /live reload|live-server/i.test(served), "Live Server: serves the folder's page, with its reload script");
    const missing = await fetch(`http://127.0.0.1:${port}/nope.html`).then((response) => response.status).catch(() => 0);
    check(missing === 404, "Live Server: a missing file is a 404");
    await runCommand("Stop Live Server");
  }

  // --- Tailwind CSS IntelliSense -----------------------------------------------------------
  await open("tw.html");
  await sleep(1000);
  await setCursor(2, 20); // after class="bg-red-
  let twItems = [];
  for (let attempt = 0; attempt < 10 && !twItems.some((row) => /bg-red-500/.test(row)); attempt++) {
    await runAction("editor.action.triggerSuggest");
    await sleep(1500);
    twItems = await suggestions();
    if (!twItems.length) await page.keyboard.press("Escape");
  }
  check(twItems.some((row) => /bg-red-500/.test(row)), `Tailwind CSS IntelliSense: completes bg-red-… (${twItems.slice(0, 3).join(" · ")})`);
  await shot("tailwind");
  await page.keyboard.press("Escape");

  // --- indent-rainbow -------------------------------------------------------------------------
  await open("indent.py");
  const rainbow = await waitFor(
    async (prefix) => {
      const model = (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel();
      const list = (model?.getAllDecorations() ?? []).filter((decoration) => `${decoration.options.className ?? ""} ${decoration.options.inlineClassName ?? ""}`.includes(prefix));
      return list.length >= 6 ? list.map((decoration) => `${decoration.range.startLineNumber}:${decoration.range.startColumn}-${decoration.range.endColumn}`) : null;
    },
    ["plugin-deco-vscode-oderwat-indent-rainbow"],
    { what: "indent-rainbow's colours" },
  ).catch(() => []);
  // Line 4 is indented three levels (12 spaces): each level has its colour.
  check(["4:1-5", "4:5-9", "4:9-13"].every((range) => rainbow.includes(range)), "indent-rainbow: each indentation level of a line is coloured");
  const bands = await page.evaluate(() =>
    new Set([...document.querySelectorAll(".monaco-editor [class*='plugin-deco-vscode-oderwat-indent-rainbow']")].map((element) => getComputedStyle(element).backgroundColor)).size,
  );
  check(bands >= 3, `indent-rainbow: in ${bands} different colours`);
  await shot("indent-rainbow");

  // --- Markdown All in One -------------------------------------------------------------------
  await open("guide.md");
  await sleep(1000);
  await setCursor(2, 1);
  await runCommand("Create Table of Contents");
  const toc = await waitFor(async () => {
    const value = (await import("/src/lib/editorRegistry.ts")).getEditor()?.getModel()?.getValue();
    return value?.includes("- [Install](#install)") ? value : null;
  }, [], { what: "the table of contents" }).catch(() => "");
  check(toc.includes("- [Guide](#guide)\n  - [Install](#install)\n  - [Usage](#usage)\n    - [Advanced](#advanced)"), "Markdown All in One: Create Table of Contents");

  // --- Rainbow CSV -----------------------------------------------------------------------------
  await open("data.csv");
  await sleep(2000);
  const columns = await page.evaluate(() => {
    const line = [...document.querySelectorAll(".view-line")].find((element) => element.textContent.startsWith("Alice"));
    if (!line) return null;
    const colourOf = (word) => {
      const span = [...line.querySelectorAll("span span")].find((element) => element.textContent.includes(word));
      return span ? getComputedStyle(span).color : null;
    };
    return ["Alice", "30", "Paris", "France"].map(colourOf);
  });
  check(columns && new Set(columns).size === 4, `Rainbow CSV: each column has its own colour (${columns?.join(" ")})`);
  const csvStatus = await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().statusItems["vscode.mechatroner.rainbow-csv"]?.text ?? "");
  check(/Col 1: name/.test(csvStatus), `Rainbow CSV: the status bar names the column (${csvStatus})`);
  await shot("rainbow-csv");

  // --- Better Comments ---------------------------------------------------------------------
  await open("comments.py");
  const tagged = await waitFor(
    async () => {
      const lines = [...document.querySelectorAll(".view-line")];
      const colourOf = (text) => {
        const line = lines.find((element) => element.textContent.includes(text));
        const span = line && [...line.querySelectorAll("[class*='plugin-deco-vscode-aaron-bond-better-comments']")][0];
        return span ? getComputedStyle(span).color : null;
      };
      const colours = ["Deprecated", "Why", "TODO", "important"].map(colourOf);
      return colours.every(Boolean) ? colours : null;
    },
    [],
    { what: "Better Comments' colours" },
  ).catch(() => null);
  check(tagged && tagged[0] === "rgb(255, 45, 0)" && new Set(tagged).size === 4, `Better Comments: !, ?, TODO and * comments in their colours (${tagged?.join(" ")})`);
  await shot("better-comments");

  const pageErrors = errors.filter((error) => !/Failed to load resource/.test(error));
  check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors.slice(0, 3).join(" | ")}` : ""}`);
} finally {
  await browser.close();
  // The Node hosts belong to the bridge, not the page: stop them.
  for (const id of PLUGINS) {
    await bridge("plugin_node_stop", { id }).catch(() => {});
    await bridge("plugin_uninstall", { id }).catch(() => {});
  }
}

console.log(`\nscreenshots: ${shots}`);
if (failures.length) {
  console.log(`${failures.length} failed`);
  process.exit(1);
}
console.log("all passed");
process.exit(0);
