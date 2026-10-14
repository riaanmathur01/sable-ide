// End-to-end test of real VS Code extensions from Open VSX, converted by
// Sable (through the plugin store, install confirmations answered Yes) and
// run in its Node runtime — decorations, commands, tree views, code lenses,
// webview panels, diagnostics and child processes:
//
//   Better Comments  colours the "// ! Important" comment in app.js
//   Error Lens       shows a problem inline at the end of its line (TODO
//                    Finder's — a copy of plugins/todo-finder — diagnostic
//                    for "TODO: tidy this")
//   Bookmarks        Bookmarks: Toggle (palette) adds a bookmark, listed in
//                    its tree view under Plugin Views
//   REST Client      a "Send Request" code lens in api.http; clicking it
//                    calls a local test server (a free port) and shows the
//                    response ("from the test server") in a webview tab
//   Code Runner      Run Code runs app.js with node ("sum 5" in its output)
//
// Needs the network (Open VSX) and Node.js. Exits with 3 ("skipped: …")
// when Open VSX isn't reachable.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/vscode-real.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, copyFolder, PLUGINS, bridge, tauriStandins, waitFor, palette, realErrors } from "./helpers.mjs";

const EXTENSIONS = {
  "aaron-bond.better-comments": "vscode.aaron-bond.better-comments",
  "alefragnani.Bookmarks": "vscode.alefragnani.bookmarks",
  "humao.rest-client": "vscode.humao.rest-client",
  "usernamehw.errorlens": "vscode.usernamehw.errorlens",
  "formulahendry.code-runner": "vscode.formulahendry.code-runner",
};

// --- Open VSX reachable? --------------------------------------------------------------------
const unreachable = await fetch("https://open-vsx.org/api/aaron-bond/better-comments", { signal: AbortSignal.timeout(10000) })
  .then((response) => (response.ok ? null : `HTTP ${response.status}`))
  .catch((error) => String(error.cause ?? error));
if (unreachable) {
  console.log(`skipped: no network (Open VSX unreachable: ${unreachable})`);
  process.exit(3);
}

const { check, finish } = checker();
const shots = shotsDir("vscode-real");
const root = tempDir("vscode-real");

// The server REST Client calls.
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ hello: "from the test server", path: req.url }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverPort = server.address().port;

const workspace = writeTree(path.join(root, "ws"), {
  "app.js": [
    "// ! Important: keep the sum right",
    "// TODO: tidy this",
    "function sum(a, b) {",
    "  return a + b;",
    "}",
    'console.log("sum", sum(2, 3));',
    "",
  ].join("\n"),
  "api.http": `GET http://127.0.0.1:${serverPort}/hello\n`,
});
const todoFinder = copyFolder(path.join(PLUGINS, "todo-finder"), path.join(root, "todo-finder"));

let settings = {};
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 900,
  pollEvents: true,
  init: tauriStandins({ "plugin:dialog|ask": true, "plugin:dialog|confirm": true, "plugin:dialog|message": "Yes" }),
});
const store = (fn, ...args) =>
  page.evaluate(
    async (fn, args) => {
      const { usePluginStore } = await import("/src/store/pluginStore.ts");
      return new Function("store", "args", `return (${fn})(store, ...args)`)(usePluginStore.getState(), args);
    },
    fn.toString(),
    args,
  );
const pluginLog = (id) =>
  page.evaluate(async (id) => ((await import("/src/store/pluginStore.ts")).usePluginStore.getState().logs[id] ?? []).map((line) => line.text).join("\n"), id);
const decorations = () =>
  page.$$eval(".monaco-editor [class*='plugin-deco-']", (elements) =>
    elements.map((element) => `${element.className.match(/plugin-deco-[\w-]+/)?.[0]}:${element.textContent.replace(/\s/g, " ").slice(0, 60)}`),
  );
const showExplorer = async () => {
  const title = await page.$eval(".sidebar-title", (element) => element.textContent.trim()).catch(() => null);
  if (!title || /plugin views/i.test(title)) await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
};

try {
  await sleep(1500);
  // --- Install from Open VSX, and TODO Finder ------------------------------------------------
  for (const ref of Object.keys(EXTENSIONS)) {
    const started = Date.now();
    const ok = await store((s, ref) => s.installFromUrl(ref), ref);
    console.log(`      install ${ref}: ${ok} in ${Math.round((Date.now() - started) / 1000)}s`);
  }
  check("TODO Finder installs", (await store((s, folder) => s.installFromFolder(folder), todoFinder)) === true);
  const ids = [...Object.values(EXTENSIONS), "todo-finder"];
  const info = await waitFor(
    page,
    async (ids) => {
      const s = (await import("/src/store/pluginStore.ts")).usePluginStore.getState();
      if (!ids.every((id) => s.states[id] === "running" || s.states[id] === "error")) return null;
      return { list: s.plugins.map((p) => `${p.manifest.id}:${p.manifest.runtime ?? "worker"}`), states: s.states, errors: s.errors };
    },
    [ids],
    { timeout: 60000 },
  );
  for (const id of Object.values(EXTENSIONS)) {
    check(`${id} runs (Node)`, info?.states[id] === "running" && info.list.includes(`${id}:node`), info?.errors[id]?.split("\n")[0] ?? info?.states[id] ?? "timed out");
  }

  // --- Better Comments + Error Lens (+ TODO Finder's diagnostics): app.js ---------------------
  await showExplorer();
  await clickText(page, "app.js");
  const decos = await waitFor(page, () => {
    const list = [...document.querySelectorAll(".monaco-editor [class*='plugin-deco-']")].map((element) => `${element.className}:${element.textContent.replace(/\s/g, " ")}`);
    return list.some((d) => d.includes("better-comments") && d.includes("Important")) && list.some((d) => d.includes("errorlens") && /tidy this/i.test(d)) ? list : null;
  }, [], { timeout: 20000 });
  const found = decos ? await decorations() : await decorations();
  check("Better Comments colours comments (decorations)", found.some((d) => d.includes("better-comments") && d.includes("Important")), found.slice(0, 6).join(" | "));
  check("Error Lens shows problems inline (diagnostics → decorations)", found.some((d) => d.includes("errorlens") && /tidy this/i.test(d)), found.filter((d) => d.includes("errorlens")).slice(0, 3).join(" | "));
  await page.screenshot({ path: `${shots}/real-1.png` });

  // --- Bookmarks: toggle via its command, see it in its tree view -------------------------
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.down("Meta");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.up("Meta");
  await page.mouse.move(5, 880);
  const toggled = await palette(page, "Bookmarks: Toggle", 1200);
  check("Bookmarks: Toggle is in the palette", /Bookmarks: Toggle/.test(toggled ?? ""), toggled);
  await waitFor(page, () => Boolean(document.querySelector('.activity-bar-item[title^="Plugin Views"]')));
  await page.click('.activity-bar-item[title^="Plugin Views"]').catch(() => {});
  const viewText =
    (await waitFor(page, () => {
      const text = document.querySelector(".plugin-views")?.textContent ?? "";
      return /app\.js/.test(text) ? text : null;
    })) ?? (await page.$eval(".plugin-views", (element) => element.textContent).catch(() => ""));
  check("Bookmarks' tree view lists the bookmark", /app\.js/.test(viewText), viewText.slice(0, 160));
  await page.screenshot({ path: `${shots}/real-2.png` });

  // --- REST Client: code lens → request → webview panel with the response --------------------
  await showExplorer();
  await clickText(page, "api.http");
  const lenses =
    (await waitFor(page, () => {
      const list = [...document.querySelectorAll(".monaco-editor .codelens-decoration")].map((element) => element.textContent);
      return list.some((lens) => /Send Request/i.test(lens)) ? list : null;
    }, [], { timeout: 20000 })) ?? (await texts(page, ".monaco-editor .codelens-decoration"));
  check("REST Client adds a code lens", lenses.some((lens) => /Send Request/i.test(lens)), lenses.join(" | "));
  // A real click: Monaco handles the lens's mouse events itself (a DOM click() does nothing).
  const lens = await page.evaluateHandle(() => [...document.querySelectorAll(".monaco-editor .codelens-decoration a")].find((a) => /Send Request/i.test(a.textContent)) ?? null);
  if (lens.asElement()) await lens.asElement().click();
  let tabs = [];
  let frameText = "";
  for (let i = 0; i < 50 && !(tabs.some((tab) => /Response/i.test(tab)) && /from the test server/.test(frameText)); i++) {
    await sleep(200);
    tabs = await texts(page, ".editor-tab-name");
    for (const frame of page.frames().filter((frame) => frame !== page.mainFrame())) {
      const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (/from the test server/.test(text)) frameText = text;
    }
  }
  check("…and shows the response in a webview panel", tabs.some((tab) => /Response/i.test(tab)) && /from the test server/.test(frameText), `${tabs.join(", ")} / ${frameText.slice(0, 120)}`);
  await page.screenshot({ path: `${shots}/real-3.png` });

  // --- Code Runner: runs `node` on the file (a child process inside the extension) ------------
  await clickText(page, "app.js", ".editor-tab-name");
  await sleep(800);
  const run = await palette(page, "Run Code", 500);
  check("Run Code is in the palette", /Run Code/.test(run ?? ""), run);
  const log = await (async () => {
    for (let i = 0; i < 50; i++) {
      const text = await pluginLog("vscode.formulahendry.code-runner");
      if (/sum 5/.test(text)) return text;
      await sleep(200);
    }
    return pluginLog("vscode.formulahendry.code-runner");
  })();
  check("Code Runner runs the file with Node (output channel → plugin log)", /sum 5/.test(log), log.slice(-200));

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).slice(0, 3).join(" | "));
  for (const id of ["vscode.alefragnani.bookmarks", "vscode.humao.rest-client"]) {
    const lines = await page.evaluate(
      async (id) => ((await import("/src/store/pluginStore.ts")).usePluginStore.getState().logs[id] ?? []).filter((line) => line.level !== "log").map((line) => line.text).slice(-6),
      id,
    );
    if (lines.length) console.log(`      ${id} log: ${lines.join(" || ").slice(0, 600)}`);
  }
} finally {
  await browser.close();
  // The Node hosts belong to the bridge, not the page: stop them.
  for (const id of [...Object.values(EXTENSIONS), "todo-finder"]) {
    await bridge("plugin_node_stop", { id }).catch(() => {});
    await bridge("plugin_uninstall", { id }).catch(() => {});
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
