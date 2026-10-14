// End-to-end test of the plugin system in the real frontend against the
// real backend, with a test plugin written here ("Test Plugin", permission
// "editor" only):
//
//   - Install from a folder (Plugins → Marketplace → From Folder…, the
//     folder picked through a dialog stand-in): listed, its status item
//     ("TP ready") in the status bar.
//   - The sandbox, from the plugin's log: no Tauri internals in its
//     worker, no fetch/WebSocket without "network", and reading the
//     workspace denied without "workspace:read".
//   - Its commands from the palette: Greet (a status message), Uppercase
//     (editor.replaceSelection on the selection).
//   - Diagnostics it sets when notes.txt opens show as warning squiggles.
//   - Turning it off removes its status item and diagnostics; turning it
//     back on restores them.
//   - Create (Plugins → Create): scaffolds "My Plugin" in a temp "home",
//     installs it linked, opens its main.js; its Say Hello command works.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/plugins.mjs
//
// with Vite and a fresh bridge running (README → Testing, or run-all.mjs):
// it installs plugins into the bridge's SABLE_UI_PLUGINS_DIR. ~30 seconds.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, texts } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, palette, waitFor, realErrors, tauriStandins } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("plugins");
const root = tempDir("plugins");
const workspace = writeTree(path.join(root, "ws"), { "notes.txt": "hello world\nsecond line\n" });
const home = path.join(root, "home");
fs.mkdirSync(home);

const pluginFolder = writeTree(path.join(root, "test-plugin"), {
  "sable-plugin.json": JSON.stringify(
    { id: "test-plugin", name: "Test Plugin", version: "1.0.0", description: "UI test plugin", main: "main.js", permissions: ["editor"] },
    null,
    2,
  ),
  "main.js": `
export async function activate(sable) {
  console.log("tauri internals: " + typeof self.__TAURI_INTERNALS__);
  console.log("fetch: " + typeof self.fetch);
  console.log("ws: " + typeof self.WebSocket);
  try {
    await sable.workspace.readFile("notes.txt");
    console.log("read allowed");
  } catch (error) {
    console.log("read denied: " + error.message);
  }
  await sable.statusBar.set("TP ready", { tooltip: "Test Plugin" });
  sable.commands.register("greet", "Greet", () => sable.window.showMessage("greetings from the test plugin"));
  sable.commands.register("upper", "Uppercase", async () => {
    const editor = await sable.editor.active();
    if (editor && editor.selection) await sable.editor.replaceSelection(editor.selection.text.toUpperCase());
  });
  const lint = async (path) => {
    if (!path || !path.endsWith("notes.txt")) return;
    await sable.languages.setDiagnostics(path, [{ line: 1, column: 1, endColumn: 6, message: "Say hi instead", severity: "warning" }]);
  };
  sable.events.onDidOpen(({ path }) => lint(path));
  const active = await sable.editor.active();
  if (active) await lint(active.path);
}
export function deactivate() {}
`,
});

const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 900,
  // Native dialogs: "Yes" to the install prompt, the test plugin's folder
  // from the folder picker, and a temp home (Create puts plugins in ~/sable-plugins).
  init: tauriStandins({
    "plugin:dialog|message": "Yes",
    "plugin:dialog|ask": true,
    "plugin:dialog|open": pluginFolder,
    "plugin:path|resolve_directory": home,
    "plugin:app|version": "0.3.6",
  }),
});
try {
  await sleep(1500);
  const statusText = () => page.$eval(".status-bar", (element) => element.innerText).catch(() => "");
  const pluginRow = (name) =>
    page.evaluateHandle((name) => [...document.querySelectorAll(".plugin-row")].find((row) => row.querySelector(".plugin-name")?.textContent.trim() === name) ?? null, name);
  const showPluginsTab = async (tab) => {
    if (!(await page.$(".plugins-page"))) await page.click('.activity-bar-item[title="Plugins"]');
    await sleep(300);
    await clickText(page, new RegExp(`^${tab}`), ".plugins-tabs button"); // "Installed" has a count after it
    await sleep(400);
  };

  // --- Install from folder ---------------------------------------------------------------------------
  await showPluginsTab("Marketplace");
  await clickText(page, "From Folder…", "button");
  await waitFor(page, () => [...document.querySelectorAll(".status-bar-plugin")].some((item) => item.textContent.includes("TP ready")));
  await showPluginsTab("Installed");
  const names = await texts(page, ".plugin-name");
  check("installed from folder", names.includes("Test Plugin"), names.join(", "));
  check("status-bar item from the plugin", (await statusText()).includes("TP ready"), await statusText());

  // The log shows the sandbox and the permission check.
  const row = await pluginRow("Test Plugin");
  await (await row.asElement().$(".plugin-chevron")).click();
  await sleep(400);
  const log = (await texts(page, ".plugin-log-line")).join("\n");
  check("no Tauri internals in the worker", log.includes("tauri internals: undefined"), log);
  check("no network without the permission (fetch, WebSocket)", log.includes("fetch: undefined") && log.includes("ws: undefined"), log);
  check("workspace:read enforced", log.includes('read denied: Test Plugin doesn\'t have the "workspace:read" permission'), log);

  // --- Commands from the palette -------------------------------------------------------------------
  await palette(page, "Test Plugin: Greet", 600);
  check("palette runs a plugin command", (await statusText()).includes("greetings from the test plugin"), await statusText());

  // --- Diagnostics on open, editor edits -----------------------------------------------------------
  if (!(await page.$(".sidebar"))) await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
  await clickText(page, "notes.txt");
  const squiggle = await waitFor(page, () => !!document.querySelector(".squiggly-warning"), [], { timeout: 6000 });
  check("plugin diagnostics show as warning squiggles", Boolean(squiggle));
  // Select "hello" and uppercase it through the plugin.
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 });
  });
  await sleep(300);
  await palette(page, "Test Plugin: Uppercase", 800);
  const firstLine = await page.evaluate(async () => (await import("/src/lib/editorRegistry.ts")).getEditor().getModel().getLineContent(1));
  check("editor.replaceSelection edits the file", firstLine.startsWith("HELLO world"), JSON.stringify(firstLine));
  await page.screenshot({ path: `${shots}/plugins-1.png` });

  // --- Disable removes its contributions -------------------------------------------------------------
  await showPluginsTab("Installed");
  const toggle = async () => {
    const row = await pluginRow("Test Plugin");
    await (await row.asElement().$(".plugin-toggle")).click();
    await sleep(1500);
  };
  await toggle();
  check("disabling removes its status item", !(await statusText()).includes("TP ready"), await statusText());
  const markers = () =>
    page.evaluate(async () => {
      const monaco = await (await import("/src/lib/editorRegistry.ts")).whenMonaco();
      return monaco.editor.getModelMarkers({}).filter((marker) => marker.message === "Say hi instead").length;
    });
  check("disabling removes its diagnostics", (await markers()) === 0, `${await markers()} markers`);
  await toggle();
  check("re-enabling restores its status item", (await statusText()).includes("TP ready"), await statusText());
  check("re-enabling restores its commands", (await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().commands.filter((c) => c.pluginId === "test-plugin").length)) === 2);

  // --- Create a plugin ---------------------------------------------------------------------------
  await showPluginsTab("Create");
  await clickText(page, /Create Plugin/, "button");
  const opened = await waitFor(page, () => [...document.querySelectorAll(".editor-tab-name")].some((tab) => tab.textContent.trim() === "main.js"), [], { timeout: 8000 });
  const tabs = await texts(page, ".editor-tab-name");
  check("created plugin opens main.js", Boolean(opened), tabs.join(", "));
  check("created plugin is scaffolded in ~/sable-plugins", fs.existsSync(path.join(home, "sable-plugins/my-plugin/sable-plugin.json")) && fs.existsSync(path.join(home, "sable-plugins/my-plugin/main.js")));
  await showPluginsTab("Installed");
  const created = await texts(page, ".plugin-name");
  check("created plugin is installed and listed", created.includes("My Plugin"), created.join(", "));
  await waitFor(page, async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states["my-plugin"] === "running");
  // Opening main.js reports "No language server running" (the test has no
  // language servers), and an error hides status messages: dismiss it.
  if (await page.$(".status-bar-error")) await page.click(".status-bar-error");
  await palette(page, "My Plugin: Say Hello", 700);
  check("scaffolded plugin works", (await statusText()).includes("Hello from My Plugin!"), await statusText());
  await page.screenshot({ path: `${shots}/plugins-2.png` });

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
