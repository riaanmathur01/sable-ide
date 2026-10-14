// End-to-end test of the VS Code extension converter (Plugins → Create →
// "Convert a VS Code extension"), in the real frontend and the Node runtime:
//
//   - The Create tab has the converter.
//   - A local .vsix (offline): a tiny but real VS Code extension built here
//     (extension/package.json + extension/extension.js contributing a
//     "Mini Sort: Sort Lines Ascending" command, zipped as a .vsix) chosen
//     with "Choose .vsix…" (the file dialog answered with its path) is
//     converted, installed and runs in Node; its command is in the palette
//     and sorts veg.txt's lines.
//   - By id from Open VSX (network): typing Tyriar.sort-lines and pressing
//     Convert & Install converts and installs Sort Lines (remembering where
//     it came from), it runs, its "Sort lines (ascending, case sensitive)"
//     is in the palette and sorts fruit.txt. Skipped ("skip: no network")
//     when Open VSX isn't reachable.
//
// Needs Node.js (the converted extensions run in Sable's Node runtime).
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/vscode-convert.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, bridge, tauriStandins, waitFor, realErrors } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("vscode-convert");
const root = tempDir("vscode-convert");
const workspace = writeTree(path.join(root, "ws"), {
  // No trailing newline: an empty last line would sort first.
  "fruit.txt": "pear\nbanana\napple\ncherry",
  "veg.txt": "turnip\nleek\ncarrot\nonion",
});

// --- A tiny VS Code extension, packed as a .vsix ----------------------------------------------
const LOCAL_ID = "vscode.sabletest.mini-sort";
const OPEN_VSX_ID = "vscode.tyriar.sort-lines";
const extensionDir = writeTree(path.join(root, "vsix"), {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/></Types>\n',
  "extension/package.json": JSON.stringify(
    {
      name: "mini-sort",
      displayName: "Mini Sort",
      publisher: "sabletest",
      version: "0.1.0",
      description: "Sorts lines (a test extension).",
      engines: { vscode: "^1.70.0" },
      main: "./extension.js",
      activationEvents: ["onCommand:miniSort.ascending"],
      contributes: { commands: [{ command: "miniSort.ascending", title: "Sort Lines Ascending", category: "Mini Sort" }] },
    },
    null,
    2,
  ),
  "extension/extension.js": `const vscode = require("vscode");
exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("miniSort.ascending", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const document = editor.document;
      const selection = editor.selection;
      const first = selection.isEmpty ? 0 : selection.start.line;
      const last = selection.isEmpty ? document.lineCount - 1 : selection.end.line;
      const lines = [];
      for (let line = first; line <= last; line++) lines.push(document.lineAt(line).text);
      lines.sort();
      const range = new vscode.Range(first, 0, last, document.lineAt(last).text.length);
      return editor.edit((edit) => edit.replace(range, lines.join("\\n")));
    }),
  );
};
exports.deactivate = () => {};
`,
});
const vsix = path.join(root, "mini-sort-0.1.0.vsix");
execFileSync("zip", ["-q", "-r", vsix, "[Content_Types].xml", "extension"], { cwd: extensionDir });

let settings = {};
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

const openVsx = await fetch("https://open-vsx.org/api/Tyriar/sort-lines", { signal: AbortSignal.timeout(10000) })
  .then((response) => (response.ok ? null : `HTTP ${response.status}`))
  .catch((error) => String(error.cause ?? error));

const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 850,
  pollEvents: true,
  init: tauriStandins({
    "plugin:dialog|ask": true,
    "plugin:dialog|confirm": true,
    "plugin:dialog|message": "Yes",
    // "Choose .vsix…": the file dialog picks the test's .vsix.
    "plugin:dialog|open": vsix,
  }),
});

const plugins = () =>
  page.evaluate(async () => {
    const state = (await import("/src/store/pluginStore.ts")).usePluginStore.getState();
    return { list: state.plugins.map((p) => ({ id: p.manifest.id, version: p.manifest.version, runtime: p.manifest.runtime ?? "worker", source: p.source ?? null })), states: state.states, errors: state.errors };
  });
const waitRunning = (id) =>
  waitFor(
    page,
    async (id) => {
      const state = (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states[id];
      return state === "running" || state === "error" ? state : null;
    },
    [id],
    { timeout: 60000 },
  );
const pluginLog = (id) =>
  page.evaluate(async (id) => ((await import("/src/store/pluginStore.ts")).usePluginStore.getState().logs[id] ?? []).map((line) => line.text).join(" | "), id);
const showCreateTab = async () => {
  await page.click('.activity-bar-item[title="Plugins"]');
  await sleep(800);
  await clickText(page, /^Create/, ".plugins-tabs button");
  await sleep(500);
};
/** Open a file from the explorer, select all, and run a palette command; returns [first item offered, the lines]. */
const sortWith = async (file, command) => {
  if (!(await page.$(".sidebar")) || (await page.$eval(".sidebar-title", (e) => e.textContent.trim()).catch(() => "")) === "Plugin Views")
    await page.click('.activity-bar-item[title^="Explorer"]');
  await sleep(300);
  await clickText(page, file);
  // Its unsorted first line shows in the editor.
  await waitFor(page, (word) => document.querySelector(".view-lines")?.textContent.startsWith(word), [file === "fruit.txt" ? "pear" : "turnip"]);
  await sleep(1000);
  await page.click(".view-lines");
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.mouse.move(5, 840);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await sleep(300);
  await page.keyboard.type(command);
  await sleep(400);
  const offered = await texts(page, "[data-index]");
  await page.keyboard.press("Enter");
  const lines = await waitFor(page, (first) => {
    const text = [...document.querySelectorAll(".view-line")]
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map((line) => line.textContent.replace(/ /g, " "))
      .join("|");
    return text.startsWith(first) ? text : null;
  }, [file === "fruit.txt" ? "apple|" : "carrot|"], { timeout: 10000 });
  const fallback = await page.$$eval(".view-line", (lines) => lines.map((line) => line.textContent).join("|"));
  return [offered, lines ?? fallback];
};

try {
  await sleep(1500);
  await showCreateTab();
  check("Create tab has the VS Code converter", (await texts(page, ".convert-vscode h3"))[0] === "Convert a VS Code extension", (await texts(page, ".convert-vscode h3")).join());
  await page.screenshot({ path: `${shots}/vscode-1.png` });

  // --- A local .vsix (offline) --------------------------------------------------------------------
  await clickText(page, /Choose \.vsix/, ".convert-vscode-row button");
  const localState = await waitRunning(LOCAL_ID);
  const afterLocal = await plugins();
  const local = afterLocal.list.find((p) => p.id === LOCAL_ID);
  const dialog = await page.evaluate(() => window.__tauriCalls.find((call) => call.cmd === "plugin:dialog|open")?.args);
  check(".vsix: Choose .vsix… asks for a .vsix file", JSON.stringify(dialog ?? {}).includes("vsix"), JSON.stringify(dialog));
  check(".vsix: converted and installed", local?.version === "0.1.0", JSON.stringify(afterLocal.list));
  check(".vsix: runs in the Node runtime", localState === "running" && local?.runtime === "node", JSON.stringify({ state: localState, local, error: afterLocal.errors[LOCAL_ID] }));
  const [localOffered, vegLines] = await sortWith("veg.txt", "Mini Sort: Sort Lines Ascending");
  check(".vsix: its command is in the palette", localOffered[0]?.includes("Mini Sort: Sort Lines Ascending"), localOffered.slice(0, 3).join(" | "));
  check(".vsix: the extension sorted the lines", vegLines.startsWith("carrot|leek|onion|turnip"), `${vegLines} / log: ${await pluginLog(LOCAL_ID)}`);
  await page.screenshot({ path: `${shots}/vscode-vsix.png` });

  // --- By id, from Open VSX (network) --------------------------------------------------------
  if (openVsx) console.log(`  skip: no network (Open VSX unreachable: ${openVsx}) — the Open VSX checks`);
  else {
    await showCreateTab();
    await page.click(".convert-vscode-row input");
    await page.keyboard.type("Tyriar.sort-lines");
    await sleep(200);
    await page.screenshot({ path: `${shots}/vscode-2.png` });
    await clickText(page, /Convert & Install/, ".convert-vscode-row button");
    const state = await waitRunning(OPEN_VSX_ID);
    const info = await plugins();
    const sortLines = info.list.find((p) => p.id === OPEN_VSX_ID);
    check("Open VSX: converted and installed", Boolean(sortLines), JSON.stringify(info.list));
    check("Open VSX: it remembers where it came from (for updates)", sortLines?.source === "Tyriar.sort-lines", JSON.stringify(sortLines));
    check("Open VSX: the input is cleared", (await page.$eval(".convert-vscode-row input", (input) => input.value).catch(() => null)) === "");
    check("Open VSX: running", state === "running", JSON.stringify({ state, error: info.errors[OPEN_VSX_ID] }));
    const [offered, lines] = await sortWith("fruit.txt", "Sort lines (ascending, case sensitive)");
    check("Open VSX: its commands are in the palette", offered[0]?.includes("Sort lines (ascending, case sensitive)"), offered.slice(0, 3).join(" | "));
    check("Open VSX: the VS Code extension sorted the lines", lines.startsWith("apple|banana|cherry|pear"), `${lines} / log: ${await pluginLog(OPEN_VSX_ID)}`);
    await page.screenshot({ path: `${shots}/vscode-3.png` });
  }
  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  // The Node hosts belong to the bridge, not the page: stop them.
  for (const id of [LOCAL_ID, OPEN_VSX_ID]) {
    await bridge("plugin_node_stop", { id }).catch(() => {});
    await bridge("plugin_uninstall", { id }).catch(() => {});
  }
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
