// End-to-end test of Case Converter's rename suggestions: with the plugin
// installed from a local stand-in marketplace (a catalogue + .tar.gz built
// from plugins/case-converter, served over HTTP on a free port), F2 on
// `userProfileId` in app.rb lists the name in the other cases under the
// rename box, and choosing one renames every use.
//
//   [SHOTS=/dir for screenshots] [SABLE_UI_VITE_PORT, SABLE_UI_BRIDGE_PORT]
//   node scripts/ui-test/rename.mjs
//
// with Vite and a freshly started bridge (README → Testing, or run-all.mjs):
// it installs a plugin into the bridge's SABLE_UI_PLUGINS_DIR. No network.
import fs from "node:fs";
import path from "node:path";
import { openSable, sleep, texts, extraStandins } from "./driver.mjs";
import { checker, tempDir, writeTree, shotsDir, serveFolder, tarGz, tauriStandins, waitFor, editorText, setCursor, realErrors, uninstallAllPlugins, PLUGINS, REPO } from "./helpers.mjs";

const { check, finish } = checker();
const shots = shotsDir("rename");
const root = tempDir("rename");
const workspace = writeTree(path.join(root, "rws"), { "app.rb": "userProfileId = 1\nputs userProfileId\n" });

// The stand-in marketplace: just Case Converter.
const market = path.join(root, "market");
fs.mkdirSync(market, { recursive: true });
const server = await serveFolder(market);
const folder = path.join(PLUGINS, "case-converter");
const manifest = JSON.parse(fs.readFileSync(path.join(folder, "sable-plugin.json"), "utf8"));
tarGz(folder, path.join(market, "case-converter.tar.gz"));
const entry = { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, author: manifest.author, permissions: manifest.permissions, tags: ["text"], url: `${server.url}/case-converter.tar.gz` };
fs.writeFileSync(path.join(market, "registry.json"), JSON.stringify({ name: "Test Marketplace", version: 1, plugins: [entry] }));

let settings = { "plugins.marketplaceUrl": `${server.url}/registry.json` };
extraStandins.load_settings = () => settings;
extraStandins.save_settings = (args) => {
  settings = args.settings;
  return null;
};

await uninstallAllPlugins();
const appVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const { browser, page, errors } = await openSable(workspace, {
  width: 1400,
  height: 800,
  init: tauriStandins({ "plugin:dialog|message": "Yes", "plugin:app|version": appVersion }),
});
try {
  await sleep(1500);
  // Install Case Converter from its marketplace card.
  await page.click('.activity-bar-item[title="Plugins"]');
  await waitFor(page, () => document.querySelector(".marketplace-card button.plugins-button.primary"));
  await page.click(".marketplace-card button.plugins-button.primary");
  const running = await waitFor(page, async () => (await import("/src/store/pluginStore.ts")).usePluginStore.getState().states["case-converter"] === "running");
  check("Case Converter installs from the marketplace and runs", Boolean(running));

  await page.evaluate(async (file) => (await import("/src/store/tabsStore.ts")).useTabsStore.getState().openFile(file), path.join(workspace, "app.rb"));
  await waitFor(page, () => document.querySelector(".editor-tab.active .editor-tab-name")?.textContent === "app.rb");
  await sleep(1000);
  await setCursor(page, 1, 2);
  await page.keyboard.press("F2");
  const candidates = (await waitFor(page, () => {
    const names = [...document.querySelectorAll(".rename-candidate")].map((element) => element.innerText.trim());
    return names.length ? names : null;
  })) ?? [];
  check("F2 lists the name in the other cases", JSON.stringify(candidates) === JSON.stringify(["UserProfileId", "user_profile_id", "USER_PROFILE_ID"]), JSON.stringify(candidates));
  await page.screenshot({ path: `${shots}/rename.png` });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  await page.keyboard.press("Enter");
  await waitFor(page, async () => !(await import("/src/lib/editorRegistry.ts")).getEditor().getValue().includes("userProfileId"), [], { timeout: 5000 });
  const text = (await editorText(page)) ?? "";
  check("choosing one renames every use", text.startsWith("user_profile_id = 1\nputs user_profile_id"), JSON.stringify(text));

  check("no page errors", realErrors(errors).length === 0, realErrors(errors).join(" | "));
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
finish();
