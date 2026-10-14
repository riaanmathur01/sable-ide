// End-to-end test of Settings → Plugins against a local stand-in
// marketplace (a catalogue + plugin .tar.gz archives served over HTTP on a
// free port, built from the repo's plugins/ folder):
//
//   - The activity bar's Plugins button opens Settings on the Plugins page.
//   - The Marketplace tab lists the catalogue; search filters it.
//   - Install from a card (Emoji Completions, Sort Lines): the cards are
//     marked Installed and the Installed tab counts them.
//   - The installed plugins work: Sort Lines (A → Z) sorts fruit.txt, and
//     Emoji Completions completes :roc → 🚀 in notes.md.
//   - Update: with a catalogue offering Sort Lines 1.1.0 (set through the
//     Marketplace URL setting), its card offers "Update to 1.1.0", which
//     installs it.
//   - The Create tab creates a plugin and opens its main.js.
//
// (The View Switcher styles are covered by view-switcher.mjs.)
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/marketplace.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs):
// it installs plugins into the bridge's SABLE_UI_PLUGINS_DIR. No network.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, clickText, texts, extraStandins } from "./driver.mjs";
import {
  checker,
  tempDir,
  writeTree,
  shotsDir,
  serveFolder,
  copyFolder,
  tarGz,
  tauriStandins,
  palette,
  waitFor,
  editorText,
  realErrors,
  uninstallAllPlugins,
  PLUGINS,
  REPO,
} from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("marketplace");
const root = tempDir("marketplace");
const workspace = writeTree(path.join(root, "mws"), {
  "fruit.txt": "pear\napple\nbanana\ncherry\n",
  "notes.md": "# Notes\n\nShipping today.\n",
});
// Where the Create tab puts new plugins (its default is ~/sable-plugins).
const home = fs.mkdirSync(path.join(root, "home"), { recursive: true }) && path.join(root, "home");

// --- The stand-in marketplace ------------------------------------------------------------------
const market = fs.mkdirSync(path.join(root, "market"), { recursive: true }) && path.join(root, "market");
const official = JSON.parse(fs.readFileSync(path.join(PLUGINS, "registry.json"), "utf8")).plugins;
const server = await serveFolder(market);
/** A catalogue entry for a plugin folder, installing from its archive here. */
function publish(folder) {
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "sable-plugin.json"), "utf8"));
  const archive = `${manifest.id}-${manifest.version}.tar.gz`;
  tarGz(folder, path.join(market, archive));
  const listed = official.find((entry) => entry.id === manifest.id) ?? {};
  return { ...listed, id: manifest.id, name: manifest.name, version: manifest.version, url: `${server.url}/${archive}`, homepage: undefined };
}
const CATALOGUE = ["word-count", "todo-finder", "sort-lines", "case-converter", "emoji-completions", "json-tools"];
const entries = CATALOGUE.map((id) => publish(path.join(PLUGINS, id)));
fs.writeFileSync(path.join(market, "registry.json"), JSON.stringify({ name: "Test Marketplace", version: 1, plugins: entries }, null, 2));
// registry2.json: the same, with Sort Lines 1.1.0.
const newer = copyFolder(path.join(PLUGINS, "sort-lines"), path.join(root, "sort-lines-1.1.0"));
const newerManifest = JSON.parse(fs.readFileSync(path.join(newer, "sable-plugin.json"), "utf8"));
fs.writeFileSync(path.join(newer, "sable-plugin.json"), JSON.stringify({ ...newerManifest, version: "1.1.0" }, null, 2));
const entries2 = entries.map((entry) => (entry.id === "sort-lines" ? publish(newer) : entry));
fs.writeFileSync(path.join(market, "registry2.json"), JSON.stringify({ name: "Test Marketplace", version: 1, plugins: entries2 }, null, 2));

let settings = { "plugins.marketplaceUrl": `${server.url}/registry.json` };
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

await uninstallAllPlugins();
const appVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const { browser, page, errors } = await openSable(workspace, {
  width: 1500,
  height: 950,
  init: tauriStandins({ "plugin:dialog|message": "Yes", "plugin:path|resolve_directory": home, "plugin:app|version": appVersion }),
});
try {
  await sleep(1500);
  const search = async (text) => {
    await page.$eval(".marketplace-search input", (input) => {
      input.focus();
      input.select();
    });
    await page.keyboard.press("Backspace");
    if (text) await page.type(".marketplace-search input", text);
    await sleep(300);
  };
  const installedCount = () => page.$$eval(".marketplace-installed", (marks) => marks.length);
  const installIn = async (name) => {
    await search(name);
    await clickText(page, /Install$/, ".marketplace-card button");
    await waitFor(page, () => document.querySelectorAll(".marketplace-installed").length >= 1, []);
    await sleep(500);
  };
  const lines = () => page.$$eval(".view-line", (all) => all.map((line) => line.textContent.replace(/ /g, " ")).join("|"));

  // --- Settings → Plugins → Marketplace ---------------------------------------------------------
  await page.click('.activity-bar-item[title="Plugins"]');
  await waitFor(page, () => document.querySelectorAll(".marketplace-card").length > 0);
  check("Plugins (activity bar) opens Settings on the Plugins page", (await texts(page, ".plugins-page-header h2"))[0] === "Plugins");
  check("Plugins is selected in the Settings nav", (await texts(page, ".settings-nav button.active"))[0] === "Plugins", (await texts(page, ".settings-nav button.active")).join());
  const cards = await texts(page, ".marketplace-card-name");
  check("the marketplace lists the catalogue", cards.length === CATALOGUE.length && cards.includes("Sort Lines"), cards.join(", "));
  await search("emoji");
  const found = await texts(page, ".marketplace-card-name");
  check("marketplace search filters the cards", found.join() === "Emoji Completions", found.join());

  await installIn("Emoji");
  await search("");
  check("install from the marketplace (Emoji Completions) marks its card", (await installedCount()) === 1);
  await installIn("Sort Lines");
  await search("");
  check("installed cards marked (both)", (await installedCount()) === 2, `${await installedCount()} marked`);
  check("the Installed tab counts them", (await texts(page, ".plugins-tab-count"))[0] === "2", (await texts(page, ".plugins-tab-count")).join());
  const installed = await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().plugins.map((p) => p.manifest.id).sort());
  check("the backend has both installed", installed.join() === "emoji-completions,sort-lines", installed.join());
  await page.screenshot({ path: `${shots}/marketplace.png` });

  // --- Using the installed plugins ------------------------------------------------------------
  await waitFor(page, async () => {
    const { usePluginStore } = await import("/src/store/pluginStore.ts");
    const states = usePluginStore.getState().states;
    return states["sort-lines"] === "running" && states["emoji-completions"] === "running";
  });
  // The Plugins page is an editor tab: the Explorer may still be showing (clicking it would hide it).
  if ((await page.$eval(".sidebar-title", (title) => title.textContent.trim()).catch(() => null)) !== "mws") {
    await page.click('.activity-bar-item[title^="Explorer"]');
    await sleep(300);
  }
  await clickText(page, "fruit.txt");
  await waitFor(page, () => document.querySelector(".editor-tab.active .editor-tab-name")?.textContent === "fruit.txt");
  await sleep(1000);
  await palette(page, "Sort Lines: Sort Lines (A");
  const fruit = await lines();
  check("a marketplace plugin's command works (Sort Lines A → Z)", fruit.startsWith("apple|banana|cherry|pear"), fruit);

  await clickText(page, "notes.md");
  await waitFor(page, () => document.querySelector(".editor-tab.active .editor-tab-name")?.textContent === "notes.md");
  await sleep(1000);
  await page.click(".view-lines");
  await page.keyboard.down("Meta");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Meta");
  await page.keyboard.type("Ship it :roc");
  const suggestions = (await waitFor(page, () => {
    const labels = [...document.querySelectorAll(".suggest-widget .monaco-list-row .label-name")].map((label) => label.textContent.trim());
    return labels.length ? labels : null;
  })) ?? [];
  check("emoji completions suggest :rocket: in a .md file", suggestions.includes(":rocket:"), suggestions.slice(0, 5).join(", "));
  await page.keyboard.press("Enter");
  await sleep(500);
  const notes = (await editorText(page)) ?? "";
  const last = notes.split("\n").filter(Boolean).pop();
  check("accepting inserts the emoji", last === "Ship it 🚀", JSON.stringify(last));

  // --- Update ---------------------------------------------------------------------------------
  await page.click('.activity-bar-item[title="Plugins"]');
  await waitFor(page, () => document.querySelector(".plugins-section .settings-input"));
  // The URL setting, set through the UI (Settings → Plugins → Marketplace URL).
  const urlInput = await page.$(".plugins-section .settings-input");
  await urlInput.evaluate((input) => {
    input.focus();
    input.select();
  });
  await page.keyboard.type(`${server.url}/registry2.json`);
  await page.keyboard.press("Enter");
  // Settings are written 300 ms after the last change: wait for it.
  for (let waited = 0; waited < 3000 && settings["plugins.marketplaceUrl"] !== `${server.url}/registry2.json`; waited += 100) await sleep(100);
  check("the Marketplace URL setting is saved", settings["plugins.marketplaceUrl"] === `${server.url}/registry2.json`, settings["plugins.marketplaceUrl"]);
  await page.click('button[title="Reload the marketplace"]');
  await waitFor(page, () => [...document.querySelectorAll(".marketplace-card button")].some((button) => /Update to 1\.1\.0/.test(button.textContent)));
  const updateButton = await clickText(page, /Update to 1\.1\.0/, ".marketplace-card button").catch(() => null);
  check("Update offered when the catalogue has a newer version", Boolean(updateButton));
  await waitFor(page, async () => {
    const { usePluginStore } = await import("/src/store/pluginStore.ts");
    return usePluginStore.getState().plugins.find((p) => p.manifest.id === "sort-lines")?.manifest.version === "1.1.0";
  });
  await sleep(500);
  await clickText(page, /^Installed/, ".plugins-tabs button");
  await sleep(500);
  const versions = await page.$$eval(".plugin-row", (rows) => rows.map((row) => `${row.querySelector(".plugin-name").textContent} ${row.querySelector(".plugin-version").textContent}`));
  check("the update installs the new version", versions.includes("Sort Lines 1.1.0") && versions.length === 2, versions.join(", "));

  // --- Create tab -----------------------------------------------------------------------------
  await clickText(page, /^Create/, ".plugins-tabs button");
  await sleep(500);
  await clickText(page, /Create Plugin$/, "button");
  await waitFor(page, () => [...document.querySelectorAll(".editor-tab-name")].some((tab) => tab.textContent === "main.js"));
  const tabs = await texts(page, ".editor-tab-name");
  check("the Create tab makes a plugin and opens its main.js", tabs.includes("main.js"), tabs.join(", "));
  check("…in the chosen location", fs.existsSync(path.join(home, "sable-plugins", "my-plugin", "main.js")) && fs.existsSync(path.join(home, "sable-plugins", "my-plugin", "sable-plugin.json")));
  const created = await page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().plugins.find((p) => p.manifest.id === "my-plugin"));
  check("…loaded in development mode", created?.linked === true, JSON.stringify(created?.linked));
  await page.screenshot({ path: `${shots}/create.png` });

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
