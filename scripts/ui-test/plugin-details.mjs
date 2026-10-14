// End-to-end test of plugin details pages, uninstalling, a plugin quick
// pick and the built-in Catppuccin themes, against a local stand-in
// marketplace (a catalogue + plugin .tar.gz archives + a README, served
// over HTTP on a free port, built from the repo's plugins/ folder):
//
//   - A marketplace card's Details opens a "Plugin: …" editor tab: header
//     (name, version), the README rendered in Sable (from the catalogue's
//     `readme` URL, its own title dropped), permissions explained.
//   - Install from the details page: Uninstall is then offered, state
//     Running, README now read from the installed folder.
//   - A plugin with no README says so; clicking a card's name opens its
//     details too.
//   - Case Converter's "Convert Case…" shows a quick pick with previews;
//     picking snake_case converts the selection.
//   - Uninstall: from an Installed row (shown without expanding; its
//     commands go away), from a marketplace card, and with the palette's
//     "Plugins: Uninstall Plugin…".
//   - The Catppuccin themes (built in: src/lib/themes.ts), chosen with
//     "Color Theme: …" in the palette: light/dark scheme and colors.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/plugin-details.mjs
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
  tarGz,
  tauriStandins,
  palette,
  openPalette,
  waitFor,
  editorText,
  realErrors,
  uninstallAllPlugins,
  PLUGINS,
  REPO,
} from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("plugin-details");
const root = tempDir("plugin-details");
const workspace = writeTree(path.join(root, "dws"), { "case.txt": "userProfileId\nsecond line\n" });

// --- The stand-in marketplace ------------------------------------------------------------------
const market = path.join(root, "market");
fs.mkdirSync(market, { recursive: true });
const official = JSON.parse(fs.readFileSync(path.join(PLUGINS, "registry.json"), "utf8")).plugins;
const server = await serveFolder(market);
function publish(id, { readme = false } = {}) {
  const folder = path.join(PLUGINS, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "sable-plugin.json"), "utf8"));
  const archive = `${id}-${manifest.version}.tar.gz`;
  tarGz(folder, path.join(market, archive));
  const entry = { ...official.find((candidate) => candidate.id === id), id, name: manifest.name, version: manifest.version, url: `${server.url}/${archive}` };
  delete entry.homepage;
  if (readme) {
    fs.copyFileSync(path.join(folder, "README.md"), path.join(market, `${id}-README.md`));
    entry.readme = `${server.url}/${id}-README.md`;
  }
  return entry;
}
const entries = [
  publish("case-converter", { readme: true }),
  publish("word-count"), // no `readme`, and not a GitHub url: no README to show
  publish("sort-lines"),
  publish("emoji-completions"),
];
fs.writeFileSync(path.join(market, "registry.json"), JSON.stringify({ name: "Test Marketplace", version: 1, plugins: entries }, null, 2));

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
  init: tauriStandins({ "plugin:dialog|message": "Yes", "plugin:app|version": appVersion, "plugin:window|set_theme": null }),
});
try {
  await sleep(1500);
  const activeTab = async () => (await texts(page, ".editor-tab.active .editor-tab-name"))[0];
  /** A marketplace card's element handle, by plugin name. */
  const card = async (name) =>
    (
      await page.evaluateHandle(
        (name) => [...document.querySelectorAll(".marketplace-card")].find((c) => c.querySelector(".marketplace-card-name").textContent === name) ?? null,
        name,
      )
    ).asElement();
  const installedIds = () => page.evaluate(async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().plugins.map((p) => p.manifest.id));
  const waitInstalled = (id, present = true) =>
    waitFor(
      page,
      async (id, present) => {
        const state = (await import("/src/store/pluginStore.ts")).usePluginStore.getState();
        return present ? state.states[id] === "running" : !state.plugins.some((p) => p.manifest.id === id) && !state.busy;
      },
      [id, present],
    );

  // --- Details from the marketplace ---------------------------------------------------------
  await page.click('.activity-bar-item[title="Plugins"]');
  await waitFor(page, () => document.querySelectorAll(".marketplace-card").length > 0);
  await (await (await card("Case Converter")).$("button.plugins-link-button")).click();
  await waitFor(page, () => document.querySelector(".plugin-page-readme .markdown-body")?.textContent.length > 200);
  check("Details opens a plugin editor tab", (await activeTab()) === "Plugin: Case Converter", await activeTab());
  const title = (await texts(page, ".plugin-page-title h1"))[0];
  const version = (await texts(page, ".plugin-page-title .plugin-version"))[0];
  check("details page header: name and version", title === "Case Converter" && version === "v1.1.0", `${title} ${version}`);
  const readme = await page.$eval(".plugin-page-readme .markdown-body", (element) => element.textContent).catch(() => "");
  check("README (from the catalogue's readme URL) rendered in Sable", /Convert Case/.test(readme) && readme.length > 200, readme.slice(0, 80));
  check("README's own title dropped (the header shows it)", !(await page.$(".plugin-page-readme .markdown-body > h1")));
  check("README tables rendered", (await page.$(".plugin-page-readme .markdown-body table")) !== null);
  const permissions = await texts(page, ".plugin-page-permissions li span");
  check("permissions explained", permissions[0]?.startsWith("Read and change the open file"), permissions.join(" | "));
  await page.screenshot({ path: `${shots}/details-marketplace.png` });

  await clickText(page, /Install$/, ".plugin-page-actions button");
  await waitInstalled("case-converter");
  await sleep(500);
  const actions = await texts(page, ".plugin-page-actions button");
  check("Install from the details page; then Uninstall offered", actions.some((t) => /Uninstall/.test(t)) && !actions.some((t) => t.trim() === "Install"), actions.join(" | "));
  check("its state is shown (Running)", (await texts(page, ".plugin-page-state"))[0] === "Running", (await texts(page, ".plugin-page-state")).join());
  check("the README is still rendered once installed", ((await page.$eval(".plugin-page-readme .markdown-body", (element) => element.textContent).catch(() => "")) || "").includes("Convert Case"));
  await page.screenshot({ path: `${shots}/details-installed.png` });

  // A plugin with no README; the card's name opens details too.
  await page.click('.activity-bar-item[title="Plugins"]');
  await sleep(800);
  await (await (await card("Word Count")).$(".marketplace-card-name")).click();
  await waitFor(page, () => document.querySelector(".plugin-page-readme .plugins-notice")?.textContent !== "Loading README…");
  check("a card's name opens its details too", (await activeTab()) === "Plugin: Word Count", await activeTab());
  check("a plugin without a README says so", (await texts(page, ".plugin-page-readme .plugins-notice"))[0] === "This plugin has no README.", (await texts(page, ".plugin-page-readme .plugins-notice")).join());

  // --- Quick pick via Case Converter ----------------------------------------------------------
  await page.evaluate(async (file) => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openFile(file), path.join(workspace, "case.txt"));
  await waitFor(page, () => document.querySelector(".editor-tab.active .editor-tab-name")?.textContent === "case.txt");
  await sleep(800);
  await page.evaluate(async () => {
    const editor = (await import("/src/lib/editorRegistry.ts")).getEditor();
    editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 14 });
  });
  await palette(page, "Case Converter: Convert Case");
  const picks = (await waitFor(page, () => {
    const items = [...document.querySelectorAll("[data-index]")].map((item) => item.innerText.trim());
    return items.some((t) => t.includes("snake_case")) ? items : null;
  })) ?? [];
  check("Convert Case… shows a picker with previews", picks.some((t) => t.includes("snake_case") && t.includes("user_profile_id")), picks.slice(0, 4).join(" | "));
  await page.screenshot({ path: `${shots}/convert-case.png` });
  await page.keyboard.type("snake");
  await sleep(300);
  await page.keyboard.press("Enter");
  await sleep(800);
  const converted = (await editorText(page)) ?? "";
  check("picking a case converts the selection", converted.startsWith("user_profile_id\nsecond line"), JSON.stringify(converted));

  // --- Uninstall ------------------------------------------------------------------------------
  await page.click('.activity-bar-item[title="Plugins"]');
  await sleep(500);
  await clickText(page, /^Installed/, ".plugins-tabs button");
  await sleep(500);
  const rowButtons = await texts(page, ".plugin-row .plugin-header-uninstall");
  check("Uninstall visible on the row without expanding it", rowButtons.length === 1 && /Uninstall/.test(rowButtons[0]), rowButtons.join());
  await page.click(".plugin-row .plugin-header-uninstall");
  await waitInstalled("case-converter", false);
  await sleep(300);
  check("Uninstall from the row removes it", (await page.$$(".plugin-row")).length === 0 && !(await installedIds()).includes("case-converter"), (await installedIds()).join());
  await openPalette(page);
  await page.keyboard.type("Case Converter: Convert");
  await sleep(400);
  const shown = await texts(page, "[data-index]");
  await page.keyboard.press("Escape");
  await sleep(300);
  check("its commands are gone from the palette", !shown.some((t) => t.includes("Case Converter:")), shown.join(" | "));

  // A card's Uninstall.
  await clickText(page, /^Marketplace/, ".plugins-tabs button");
  await waitFor(page, () => document.querySelectorAll(".marketplace-card").length > 0);
  await (await (await card("Sort Lines")).$("button.plugins-button.primary")).click();
  await waitInstalled("sort-lines");
  await sleep(500);
  const cardUninstall = await (await card("Sort Lines")).$("button.plugins-button.danger");
  check("an installed card offers Uninstall", Boolean(cardUninstall));
  await cardUninstall?.click();
  await waitInstalled("sort-lines", false);
  await sleep(300);
  check("the card's Uninstall works", !(await (await card("Sort Lines")).$(".marketplace-installed")) && !(await installedIds()).includes("sort-lines"));

  // The palette's Uninstall Plugin….
  await (await (await card("Emoji Completions")).$("button.plugins-button.primary")).click();
  await waitInstalled("emoji-completions");
  await sleep(500);
  await palette(page, "Plugins: Uninstall Plugin");
  await sleep(400);
  const choices = await texts(page, "[data-index]");
  check("Uninstall Plugin… lists the installed plugins", choices.length === 1 && choices[0].includes("Emoji Completions"), choices.join(" | "));
  await page.keyboard.press("Enter");
  await waitInstalled("emoji-completions", false);
  await sleep(300);
  check("the palette's Uninstall Plugin… works", (await page.$$eval(".marketplace-installed", (marks) => marks.length)) === 0 && (await installedIds()).length === 0, (await installedIds()).join());

  // --- Catppuccin (built-in themes) ---------------------------------------------------------
  const look = () =>
    page.evaluate(() => ({
      scheme: document.documentElement.style.colorScheme,
      bg: getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim(),
      editor: getComputedStyle(document.querySelector(".monaco-editor-background") ?? document.body).backgroundColor,
    }));
  await clickText(page, "case.txt", ".editor-tab-name");
  await sleep(800);
  const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  const expected = {
    "Catppuccin Latte": ["light", "#eff1f5", "catppuccin-latte"],
    "Catppuccin Frappé": ["dark", "#303446", "catppuccin-frappe"],
    "Catppuccin Macchiato": ["dark", "#24273a", "catppuccin-macchiato"],
    "Catppuccin Mocha": ["dark", "#1e1e2e", "catppuccin-mocha"],
  };
  for (const [label, [scheme, bg, id]] of Object.entries(expected)) {
    await palette(page, `Color Theme: ${label}`);
    await sleep(800);
    const now = await look();
    check(`${label}: ${scheme} scheme, its base color`, now.scheme === scheme && now.bg.toLowerCase() === bg, JSON.stringify(now));
    check(`${label}: the editor uses it`, now.editor === rgb(bg), now.editor);
    check(`${label}: saved as the color theme setting`, settings["workbench.colorTheme"] === id, settings["workbench.colorTheme"]);
    if (label === "Catppuccin Latte" || label === "Catppuccin Frappé") await page.screenshot({ path: `${shots}/${id}.png` });
  }

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
